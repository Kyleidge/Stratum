import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { WorkflowIndex } from '../lib/workflow-history';
import { affectedOperations, savedCommand } from '../lib/workflow-lifecycle';
import { extractWorkflow } from '../lib/workflow-extract';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { validateWorkspace } from '../lib/workspace-archive';
import { matchValue } from '../lib/value-bindings';
import type { Project } from '../lib/signal-types';

// Two runs: torque 1…9 then 2…10 Nm; speed rises to 500 rpm and falls.
const CSV = [
  't,Torque [Nm],Speed [rpm]',
  ...[1, 3, 5, 7, 9, 2, 4, 6, 8, 10].map(
    (torque, t) =>
      `${t},${torque},${[0, 100, 200, 300, 400, 500, 400, 300, 200, 100][t]}`,
  ),
].join('\n');

async function fixture(database = crypto.randomUUID()) {
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([CSV], 'runs.csv'));
  const [torque, speed] = source.channels;
  const runs = await engine.segment(
    source.id,
    {
      method: 'ranges',
      boundary: 'clip',
      ranges: [
        [0, 4.5],
        [5, 9],
      ],
    },
    [torque],
    false,
    'signals',
  );
  const segments = runs.map((run) => run.nodes[0]);
  return { engine, source, torque, speed, segments, database };
}
async function samples(engine: SignalEngine, id: string) {
  const values: number[] = [];
  for await (const chunk of engine.evaluate(id)) values.push(...chunk.values);
  return values;
}
const stepOf = (project: Project, id: string) =>
  new WorkflowIndex(project).owner.get(id)!;

void test('each input is offset by the value calculated from it', async () => {
  const { engine, segments, torque } = await fixture();
  try {
    const means = await engine.calculateValues(segments, 'sample-average');
    assert.deepEqual(
      means.map((value) => value.value),
      [5, 6],
    );
    const centred = await engine.deriveMany(segments, 'offset', 0, true, {
      value: { valueIds: means.map((value) => value.id), factor: -1 },
    });
    assert.deepEqual(await samples(engine, centred[0].id), [-4, -2, 0, 2, 4]);
    assert.deepEqual(await samples(engine, centred[1].id), [-4, -2, 0, 2, 4]);
    assert.deepEqual(centred[1].bindings, {
      value: { valueId: means[1].id, factor: -1 },
    });
    assert.equal(centred[1].parameters.value, -6);
    const index = new WorkflowIndex(engine.project);
    const step = index.owner.get(centred[0].id)!;
    assert.deepEqual(
      step.valueInputIds,
      means.map((value) => value.id),
    );
    assert.deepEqual(step.inputIds, segments);
    // Lineage and Used by include the value and its step.
    assert.deepEqual(index.inputs(centred[0].id), [segments[0], means[0].id]);
    assert.ok(index.consumers.get(means[0].id)?.some((item) => item === step));
    assert.ok(
      index
        .lineage([centred[0].id])
        .steps.some((item) => item.id === index.owner.get(means[0].id)!.id),
    );
    // Edit replays the same binding.
    assert.deepEqual(savedCommand(engine.project, step), {
      type: 'derive-many',
      parentIds: segments,
      operation: 'offset',
      parameter: -5,
      bindings: {
        value: { valueIds: means.map((value) => value.id), factor: -1 },
      },
    });
    // A value from a segment never matches the whole recording ambiguously.
    await assert.rejects(
      engine.deriveMany([torque], 'offset', 0, true, {
        value: { valueIds: means.map((value) => value.id), factor: -1 },
      }),
      /both match/,
    );
  } finally {
    engine.close();
  }
});

void test('values match inputs through derived signals in either direction', async () => {
  const { engine, segments } = await fixture();
  try {
    const smoothed = await engine.deriveMany(segments, 'smooth', 2);
    const peaks = await engine.calculateValues(
      smoothed.map((node) => node.id),
      'maximum',
    );
    const context = {
      values: new Map(engine.project.values!.map((value) => [value.id, value])),
      nodes: new Map(engine.project.nodes.map((node) => [node.id, node])),
    };
    const binding = { valueIds: peaks.map((value) => value.id), factor: 1 };
    // A raw segment matches the peak of the smoothed signal made from it.
    assert.equal(matchValue(context, binding, segments[1]).id, peaks[1].id);
    const scaled = await engine.deriveMany(segments, 'scale', 2);
    // Two signals made from the same segment are cousins and never match.
    await assert.rejects(
      engine.deriveMany([scaled[0].id], 'offset', 0, true, { value: binding }),
      /None of the chosen values/,
    );
    assert.equal(matchValue(context, binding, smoothed[0].id).id, peaks[0].id);
  } finally {
    engine.close();
  }
});

void test('one shared value applies to every input; units are never converted', async () => {
  const { engine, segments, speed } = await fixture();
  try {
    const [count] = await engine.calculateValues([speed], 'crossing-count', {
      threshold: 250,
    });
    // Speed rises through 250 rpm once.
    assert.equal(count.value, 1);
    const scaled = await engine.deriveMany(segments, 'scale', 1, true, {
      value: { valueIds: [count.id], factor: 1 },
    });
    assert.deepEqual(await samples(engine, scaled[0].id), [1, 3, 5, 7, 9]);
    // A count has no unit, so the scaled unit is unchanged.
    assert.equal(scaled[0].unit, 'Nm');
    const [peak] = await engine.calculateValues([speed], 'maximum');
    const perSpeed = await engine.deriveMany(segments, 'scale', 1, true, {
      value: { valueIds: [peak.id], factor: 1 },
    });
    assert.equal(perSpeed[0].unit, 'Nm·rpm');
    await assert.rejects(
      engine.deriveMany(segments, 'offset', 0, true, {
        value: { valueIds: [peak.id], factor: 1 },
      }),
      /offset needs a value in Nm; .* is in rpm/,
    );
    await assert.rejects(
      engine.deriveMany(segments, 'time-shift', 0, true, {
        value: { valueIds: [peak.id], factor: 1 },
      }),
      /time shift needs a value in s/,
    );
    await assert.rejects(
      engine.deriveMany(segments, 'smooth', 3, true, {
        value: { valueIds: [peak.id], factor: 1 },
      }),
      /Only offsets, scale factors and time shifts/,
    );
    const [late] = await engine.calculateValues([speed], 'first-crossing', {
      threshold: 600,
    });
    assert.equal(late.value, null);
    await assert.rejects(
      engine.deriveMany(segments, 'time-shift', 0, true, {
        value: { valueIds: [late.id], factor: 1 },
      }),
      /is unavailable/,
    );
  } finally {
    engine.close();
  }
});

void test('value thresholds and segment triggers can come from other values', async () => {
  const { engine, source, speed, torque } = await fixture();
  try {
    const [peak] = await engine.calculateValues([speed], 'maximum');
    const [above] = await engine.calculateValues(
      [speed],
      'time-above',
      undefined,
      { threshold: { valueIds: [peak.id], factor: 0.5 } },
    );
    assert.deepEqual(above.parameters, { threshold: 250 });
    assert.deepEqual(above.bindings, {
      threshold: { valueId: peak.id, factor: 0.5 },
    });
    // 200→300 crosses 250 at 2.5 s and 300→200 at 7.5 s.
    assert.equal(above.value, 5);
    assert.deepEqual(stepOf(engine.project, above.id).valueInputIds, [peak.id]);
    const runs = await engine.segment(
      source.id,
      {
        method: 'triggers',
        boundary: 'discard',
        minimumDuration: 0,
        start: { signalId: speed, edge: 'rising', threshold: 0, offset: 0 },
        end: { signalId: speed, edge: 'falling', threshold: 0, offset: 0 },
        bindings: {
          'start.threshold': { valueIds: [peak.id], factor: 0.5 },
          'end.threshold': { valueIds: [peak.id], factor: 0.5 },
        },
      },
      [torque],
      false,
      'signals',
    );
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].start, runs[0].end], [2.5, 7.5]);
    const operation = engine.project.segmentationOperations!.at(-1)!;
    assert.equal(
      operation.definition?.method === 'triggers' &&
        operation.definition.start.threshold,
      250,
    );
    assert.deepEqual(stepOf(engine.project, runs[0].nodes[0]).valueInputIds, [
      peak.id,
    ]);
    await assert.rejects(
      engine.segment(
        source.id,
        {
          method: 'triggers',
          boundary: 'discard',
          minimumDuration: 0,
          start: { signalId: torque, edge: 'rising', threshold: 0, offset: 0 },
          end: { signalId: torque, edge: 'falling', threshold: 0, offset: 0 },
          bindings: { 'start.threshold': { valueIds: [peak.id], factor: 1 } },
        },
        [torque],
      ),
      /start threshold needs a value in Nm/,
    );
  } finally {
    engine.close();
  }
});

void test('editing or deleting a value rebuilds or removes the steps that use it', async () => {
  const { engine, segments } = await fixture();
  try {
    const means = await engine.calculateValues(segments, 'sample-average');
    const valueStep = stepOf(engine.project, means[0].id);
    const [centred] = await engine.deriveMany(segments, 'offset', 0, true, {
      value: { valueIds: means.map((value) => value.id), factor: -1 },
    });
    const deriveStep = stepOf(engine.project, centred.id);
    assert.deepEqual(
      affectedOperations(engine.project, valueStep.id).map((step) => step.id),
      [valueStep.id, deriveStep.id],
    );
    await engine.editOperation(valueStep.id, {
      type: 'calculate-values',
      inputIds: segments,
      operation: 'maximum',
    });
    const rebuilt = engine.project.nodes.find(
      (node) => node.id === centred.id,
    )!;
    // Output identities stay; the dependent now subtracts each maximum.
    assert.equal(rebuilt.parameters.value, -9);
    assert.deepEqual(await samples(engine, centred.id), [-8, -6, -4, -2, 0]);
    assert.equal(
      engine.project.workflowSteps!.find((step) => step.id === deriveStep.id)!
        .revision,
      2,
    );
    await engine.travel('undo');
    assert.deepEqual(await samples(engine, centred.id), [-4, -2, 0, 2, 4]);
    await engine.deleteOperation(valueStep.id);
    assert.ok(!engine.project.nodes.some((node) => node.id === centred.id));
    await engine.travel('undo');
    assert.ok(engine.project.nodes.some((node) => node.id === centred.id));
  } finally {
    engine.close();
  }
});

void test('backups keep bound settings and reject inconsistent ones', async () => {
  const { engine, source, segments, speed, torque } = await fixture();
  const target = new SignalEngine(undefined, crypto.randomUUID());
  await target.open();
  await target.initializeWorkflow();
  try {
    const means = await engine.calculateValues(segments, 'sample-average');
    await engine.deriveMany(segments, 'offset', 0, true, {
      value: { valueIds: means.map((value) => value.id), factor: -1 },
    });
    const [peak] = await engine.calculateValues([speed], 'maximum');
    await engine.calculateValues([speed], 'time-above', undefined, {
      threshold: { valueIds: [peak.id], factor: 0.5 },
    });
    await engine.segment(
      source.id,
      {
        method: 'triggers',
        boundary: 'discard',
        minimumDuration: 0,
        start: { signalId: speed, edge: 'rising', threshold: 0, offset: 0 },
        end: { signalId: speed, edge: 'falling', threshold: 0, offset: 0 },
        bindings: {
          'start.threshold': { valueIds: [peak.id], factor: 0.5 },
          'end.threshold': { valueIds: [peak.id], factor: 0.5 },
        },
      },
      [torque],
    );
    const project = engine.project;
    assert.doesNotThrow(() => validateWorkspace(structuredClone(project)));
    const tampered = structuredClone(project);
    tampered.nodes.find((node) => node.bindings)!.parameters.value = 1;
    assert.throws(() => validateWorkspace(tampered), /taken from values/);
    const unlisted = structuredClone(project);
    delete unlisted.workflowSteps!.find((step) => step.valueInputIds)!
      .valueInputIds;
    assert.throws(() => validateWorkspace(unlisted), /value dependencies/);
    const backup = await engine.backupWorkspace();
    await target.restoreWorkspace(new File([backup], 'bound.stratum'));
    const bound = target.project.nodes.filter((node) => node.bindings);
    assert.equal(bound.length, 2);
    assert.deepEqual(await samples(target, bound[1].id), [-4, -2, 0, 2, 4]);
  } finally {
    engine.close();
    target.close();
  }
});

void test('workflow files reference value steps for bound settings and replay them', async () => {
  const { engine, source, segments, speed, torque } = await fixture();
  try {
    const means = await engine.calculateValues(segments, 'sample-average');
    await engine.deriveMany(segments, 'offset', 0, true, {
      value: { valueIds: means.map((value) => value.id), factor: -1 },
    });
    const [peak] = await engine.calculateValues([speed], 'maximum');
    await engine.calculateValues([speed], 'time-above', undefined, {
      threshold: { valueIds: [peak.id], factor: 0.5 },
    });
    await engine.segment(
      source.id,
      {
        method: 'triggers',
        boundary: 'discard',
        minimumDuration: 0,
        start: { signalId: speed, edge: 'rising', threshold: 0, offset: 0 },
        end: { signalId: speed, edge: 'falling', threshold: 0, offset: 0 },
        bindings: {
          'start.threshold': { valueIds: [peak.id], factor: 0.5 },
          'end.threshold': { valueIds: [peak.id], factor: 0.5 },
        },
      },
      [torque],
    );
    const extracted = extractWorkflow(engine.project, source.id, {
      name: 'Bound',
      itemLabel: 'Run',
    });
    assert.deepEqual(extracted.skipped, []);
    const text = serializeWorkflow(extracted.recipe);
    assert.match(text, /parameter: \{ value: sample-average, factor: -1 \}/);
    assert.match(text, /threshold: \{ value: maximum, factor: 0.5 \}/);
    const recipe = parseWorkflow(text);
    assert.deepEqual(recipe, extracted.recipe);
    assert.throws(
      () =>
        parseWorkflow(
          text.replace(
            'parameter: { value: sample-average, factor: -1 }',
            'parameter: { value: torque }',
          ),
        ),
      /takes a setting from "torque", which is not a value step/,
    );
    const before = new Set(engine.project.nodes.map((node) => node.id));
    await engine.runWorkflow({
      recipe: text,
      batchId: crypto.randomUUID(),
      batchName: 'Replay',
      itemId: 'Copy',
      file: new File([CSV], 'copy.csv'),
    });
    const run = engine.project.workflowBatches![0].runs[0];
    assert.equal(run.flags.length, 0, JSON.stringify(run.flags));
    const replayed = engine.project.nodes.filter(
      (node) => !before.has(node.id) && node.bindings,
    );
    assert.equal(replayed.length, 2);
    for (const node of replayed)
      assert.deepEqual(await samples(engine, node.id), [-4, -2, 0, 2, 4]);
    const values = engine.project.values!.filter(
      (value) => value.bindings && value.sourceId === run.sourceId,
    );
    assert.deepEqual(
      values.map((value) => [value.operation, value.value]),
      [['time-above', 5]],
    );
    const crops = engine.project.segments.filter(
      (segment) =>
        segment.sourceId === run.sourceId &&
        segment.definition?.method === 'triggers',
    );
    assert.deepEqual(
      crops.map((segment) => [segment.start, segment.end]),
      [[2.5, 7.5]],
    );
  } finally {
    engine.close();
  }
});

void test('an edited step cannot use a value calculated after it', async () => {
  const { engine, torque } = await fixture();
  try {
    const [offset] = await engine.deriveMany([torque], 'offset', 1);
    const [mean] = await engine.calculateValues([torque], 'sample-average');
    const step = stepOf(engine.project, offset.id);
    const before = engine.project;
    await assert.rejects(
      engine.editOperation(step.id, {
        type: 'derive-many',
        parentIds: [torque],
        operation: 'offset',
        parameter: 0,
        bindings: { value: { valueIds: [mean.id], factor: -1 } },
      }),
      /only use values calculated before it/,
    );
    assert.equal(engine.project, before);
    assert.doesNotThrow(() => validateWorkspace(structuredClone(before)));
  } finally {
    engine.close();
  }
});
