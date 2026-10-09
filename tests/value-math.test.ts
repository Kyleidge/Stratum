import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { stepName, WorkflowIndex } from '../lib/workflow-history';
import { affectedOperations, savedCommand } from '../lib/workflow-lifecycle';
import { validateWorkspace } from '../lib/workspace-archive';
import { extractWorkflow } from '../lib/workflow-extract';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { compileFormula } from '../lib/formula';

// 1 Hz for 40 s: torque equals time; speed is high from 5 s to 12 s and
// from 20 s to 30 s.
const CSV = [
  't,Torque [Nm],Speed [rpm]',
  ...Array.from({ length: 40 }, (_, t) => {
    const high = (t >= 5 && t < 12) || (t >= 20 && t < 30);
    return `${t},${t},${high ? 2000 : 800}`;
  }),
].join('\n');

const RUNS = {
  method: 'ranges' as const,
  boundary: 'clip' as const,
  ranges: [
    [5, 12],
    [20, 30],
  ] as [number, number][],
};

async function fixture(database = crypto.randomUUID()) {
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([CSV], 'rig.csv'));
  const [torque, speed] = source.channels;
  const set = await engine.segmentSet(source.id, RUNS);
  const durations = await engine.calculateValues(
    [speed],
    'duration',
    undefined,
    undefined,
    { setId: set.id },
  );
  return { engine, source, torque, speed, set, durations };
}
const stepOf = (engine: SignalEngine, id: string) =>
  new WorkflowIndex(engine.project).owner.get(id)!;
const results = (engine: SignalEngine, ids: string[]) => {
  const values = new Map(engine.project.values!.map((item) => [item.id, item]));
  return ids.map((id) => values.get(id)!.value);
};

void test('value formulas use a for the input value and never signals', () => {
  const formula = compileFormula('12 / a + b', 'values');
  assert.deepEqual(formula.signals, []);
  assert.deepEqual(formula.values, ['a', 'b']);
  assert.equal(formula.evaluate([], [4, 1]), 4);
  assert.throws(() => compileFormula('12 / b', 'values'), /Use a/);
  assert.throws(() => compileFormula('a * A', 'values'), /lowercase/);
  // Signal formulas are unchanged.
  assert.throws(() => compileFormula('a * 2'), /Use A/);
});

void test('a value divided by a constant gives one result per segment', async () => {
  const { engine, set, durations, speed } = await fixture();
  try {
    assert.deepEqual(
      durations.map((value) => value.value),
      [7, 10],
    );
    const speeds = await engine.calculateValues(
      durations.map((value) => value.id),
      'calculate',
      undefined,
      undefined,
      undefined,
      '100 / a',
      'm/s',
    );
    assert.equal(speeds.length, 2);
    assert.deepEqual(
      speeds.map((value) => value.value),
      [100 / 7, 10],
    );
    assert.deepEqual(
      speeds.map((value) => [value.unit, value.segmentId, value.inputId]),
      set.segments.map((segment) => ['m/s', segment.id, speed]),
    );
    assert.deepEqual(speeds[0].parameters, { a: 7 });
    assert.deepEqual(speeds[0].bindings, {
      a: { valueId: durations[0].id, factor: 1 },
    });
    const step = stepOf(engine, speeds[0].id);
    assert.equal(step.kind, 'value');
    assert.equal(step.operation, 'calculate');
    assert.equal(step.expression, '100 / a');
    assert.deepEqual(
      step.inputIds,
      durations.map((value) => value.id),
    );
    assert.equal(step.valueInputIds, undefined);
    assert.equal(stepName(step), 'Calculate 100 / a');
    const index = new WorkflowIndex(engine.project);
    // Lineage reads the value it was calculated from, not its signal.
    assert.deepEqual(index.inputs(speeds[0].id), [durations[0].id]);
    assert.match(index.label(speeds[0].id), /^Calculate 100 \/ a · Duration/);
    assert.ok(
      index
        .lineage([speeds[0].id])
        .steps.some((item) => item.id === stepOf(engine, durations[0].id).id),
    );
    assert.ok(index.consumers.get(durations[0].id)?.includes(step));
    assert.deepEqual(savedCommand(engine.project, step), {
      type: 'calculate-values',
      inputIds: durations.map((value) => value.id),
      operation: 'calculate',
      expression: '100 / a',
      unit: 'm/s',
    });
    validateWorkspace(structuredClone(engine.project));
  } finally {
    engine.close();
  }
});

void test('other values are matched to each input by segment', async () => {
  const { engine, set, durations, torque } = await fixture();
  try {
    const maxima = await engine.calculateValues(
      [torque],
      'maximum',
      undefined,
      undefined,
      { setId: set.id },
    );
    const [mean] = await engine.calculateValues([torque], 'sample-average');
    const rates = await engine.calculateValues(
      durations.map((value) => value.id),
      'calculate',
      undefined,
      {
        b: { valueIds: maxima.map((value) => value.id), factor: 1 },
        total: { valueIds: [mean.id], factor: 1 },
      },
      undefined,
      '(b - total) / a',
      'Nm/s',
    );
    // Segment 1: max 11 over 7 s; segment 2: max 29 over 10 s; mean 19.5.
    assert.deepEqual(
      rates.map((value) => value.value),
      [(11 - mean.value!) / 7, (29 - mean.value!) / 10],
    );
    assert.deepEqual(rates[1].bindings, {
      a: { valueId: durations[1].id, factor: 1 },
      b: { valueId: maxima[1].id, factor: 1 },
      total: { valueId: mean.id, factor: 1 },
    });
    const step = stepOf(engine, rates[0].id);
    assert.deepEqual(step.valueInputIds, [maxima[0].id, mean.id, maxima[1].id]);
    // Deleting a value used by the formula removes the calculation.
    assert.ok(
      affectedOperations(engine.project, stepOf(engine, mean.id).id).some(
        (item) => item.id === step.id,
      ),
    );
    validateWorkspace(structuredClone(engine.project));
    // A missing variable or an unused one is refused.
    await assert.rejects(
      engine.calculateValues(
        [durations[0].id],
        'calculate',
        undefined,
        undefined,
        undefined,
        'a * b',
        '',
      ),
      /Choose a value for "b"/,
    );
    await assert.rejects(
      engine.calculateValues(
        [durations[0].id],
        'calculate',
        undefined,
        { b: { valueIds: [mean.id], factor: 1 } },
        undefined,
        'a * 2',
        '',
      ),
      /does not use "b"/,
    );
  } finally {
    engine.close();
  }
});

void test('unavailable inputs and non-finite results give unavailable values', async () => {
  const { engine, durations } = await fixture();
  try {
    const [zero] = await engine.calculateValues(
      [durations[0].id],
      'calculate',
      undefined,
      undefined,
      undefined,
      'a - 7',
      's',
    );
    assert.equal(zero.value, 0);
    const divided = await engine.calculateValues(
      [zero.id, durations[1].id],
      'calculate',
      undefined,
      undefined,
      undefined,
      '1 / a',
      '1/s',
    );
    assert.deepEqual(
      divided.map((value) => value.value),
      [null, 0.1],
    );
    validateWorkspace(structuredClone(engine.project));
  } finally {
    engine.close();
  }
});

void test('editing follows the values it was calculated from', async () => {
  const { engine, source, set, durations } = await fixture();
  try {
    const speeds = await engine.calculateValues(
      durations.map((value) => value.id),
      'calculate',
      undefined,
      undefined,
      undefined,
      '100 / a',
      'm/s',
    );
    const calculation = stepOf(engine, speeds[0].id);
    // Edit the formula: the outputs keep their IDs.
    await engine.editOperation(calculation.id, {
      type: 'calculate-values',
      inputIds: durations.map((value) => value.id),
      operation: 'calculate',
      expression: '200 / a',
      unit: 'm/s',
    });
    let step = engine.project.workflowSteps!.find(
      (item) => item.id === calculation.id,
    )!;
    assert.deepEqual(
      step.outputIds,
      speeds.map((value) => value.id),
    );
    assert.equal(step.expression, '200 / a');
    assert.equal(step.revision, 2);
    assert.deepEqual(results(engine, step.outputIds), [200 / 7, 20]);
    // A third segment adds a duration, and the calculation follows it.
    const segmentStep = stepOf(engine, set.segments[0].id);
    await engine.editOperation(segmentStep.id, {
      type: 'segment-set',
      sourceId: source.id,
      definition: { ...RUNS, ranges: [...RUNS.ranges, [32, 36]] },
    });
    step = engine.project.workflowSteps!.find(
      (item) => item.id === calculation.id,
    )!;
    assert.equal(step.outputIds.length, 3);
    assert.deepEqual(
      step.outputIds.slice(0, 2),
      speeds.map((value) => value.id),
    );
    assert.deepEqual(results(engine, step.outputIds), [200 / 7, 20, 50]);
    validateWorkspace(structuredClone(engine.project));
    // Deleting the durations removes the calculation.
    await engine.deleteOperation(stepOf(engine, step.inputIds[0]).id);
    assert.ok(
      !engine.project.workflowSteps!.some((item) => item.id === calculation.id),
    );
    validateWorkspace(structuredClone(engine.project));
  } finally {
    engine.close();
  }
});

void test('backups validate and restore calculations from values', async () => {
  const { engine, durations } = await fixture();
  const target = new SignalEngine(undefined, crypto.randomUUID());
  try {
    await engine.calculateValues(
      durations.map((value) => value.id),
      'calculate',
      undefined,
      undefined,
      undefined,
      'a * 2',
      's',
    );
    const backup = await engine.backupWorkspace();
    await target.open();
    await target.initializeWorkflow();
    await target.restoreWorkspace(new File([backup], 'values.stratum'));
    const restored = target.project.values!.filter(
      (value) => value.operation === 'calculate',
    );
    assert.deepEqual(
      restored.map((value) => value.value),
      [14, 20],
    );
    // A tampered number is refused.
    const project = structuredClone(engine.project);
    const value = project.values!.find(
      (item) => item.operation === 'calculate',
    )!;
    value.parameters = { a: 8 };
    assert.throws(() => validateWorkspace(project), /calculation/);
  } finally {
    engine.close();
    target.close();
  }
});

void test('workflow files save and replay calculations from values', async () => {
  const { engine, source, durations, torque, set } = await fixture();
  try {
    const maxima = await engine.calculateValues(
      [torque],
      'maximum',
      undefined,
      undefined,
      { setId: set.id },
    );
    await engine.calculateValues(
      durations.map((value) => value.id),
      'calculate',
      undefined,
      { peak: { valueIds: maxima.map((value) => value.id), factor: 1 } },
      undefined,
      'peak / a',
      'Nm/s',
    );
    const extracted = extractWorkflow(engine.project, source.id, {
      name: 'Rates',
    });
    assert.deepEqual(extracted.skipped, []);
    const calculation = extracted.recipe.steps.at(-1)!;
    assert.deepEqual(calculation.operation, {
      kind: 'value',
      operation: 'calculate',
      inputs: ['duration'],
      expression: 'peak / a',
      unit: 'Nm/s',
      bindings: { peak: { valueIds: ['maximum'], factor: 1 } },
    });
    const text = serializeWorkflow(extracted.recipe);
    assert.match(text, /function: calculate/);
    assert.match(text, /peak: maximum/);
    assert.deepEqual(parseWorkflow(text), extracted.recipe);
    await engine.runWorkflow({
      recipe: text,
      batchId: crypto.randomUUID(),
      batchName: 'Replay',
      itemId: 'Copy',
      file: new File([CSV], 'copy.csv'),
    });
    const run = engine.project.workflowBatches![0].runs[0];
    assert.equal(run.status, 'none', JSON.stringify(run.flags));
    const replayed = engine.project.workflowSteps!.find(
      (step) => step.id === run.steps[calculation.id],
    )!;
    assert.deepEqual(results(engine, replayed.outputIds), [11 / 7, 29 / 10]);
    validateWorkspace(structuredClone(engine.project));
  } finally {
    engine.close();
  }
});

void test('workflow files refuse calculations that are not from values', () => {
  const file = (body: string) =>
    [
      'format: stratum-workflow',
      'version: 2',
      'name: Rates',
      'input:',
      '  channels:',
      '    speed: Speed',
      'steps:',
      '  - id: runs',
      '    segment:',
      '      triggers:',
      '        start: { signal: speed, edge: rising, threshold: 1500 }',
      '        end: { signal: speed, edge: falling, threshold: 1500 }',
      '  - id: duration',
      '    value: { function: duration, input: speed, within: runs }',
      '  - id: rate',
      `    value: ${body}`,
    ].join('\n');
  assert.equal(
    parseWorkflow(
      file('{ function: calculate, input: duration, expression: 100 / a }'),
    ).steps.length,
    3,
  );
  assert.throws(
    () =>
      parseWorkflow(
        file('{ function: calculate, input: speed, expression: 100 / a }'),
      ),
    /calculates from "speed", which is not a value step/,
  );
  assert.throws(
    () =>
      parseWorkflow(
        file(
          '{ function: calculate, input: duration, expression: 100 / a, within: runs }',
        ),
      ),
    /remove within/,
  );
  assert.throws(
    () =>
      parseWorkflow(
        file('{ function: calculate, input: duration, expression: a * b }'),
      ),
    /list it under values/,
  );
});
