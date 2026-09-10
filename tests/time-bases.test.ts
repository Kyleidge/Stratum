import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { SignalGraph } from '../lib/signal-graph';
import { WorkflowIndex } from '../lib/workflow-history';
import { affectedOperations, savedCommand } from '../lib/workflow-lifecycle';
import { validateWorkspace } from '../lib/workspace-archive';
import type { TimeSettings } from '../lib/time-types';

async function fixture(t: TestContext) {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  t.after(() => engine.close());
  const a = await engine.importCsv(
    new File(
      ['t,x [V],state\n10,0,0\n11,2,0\n12,4,1\n13,6,1\n14,8,0'],
      'A.csv',
    ),
  );
  const b = await engine.importCsv(
    new File(['t,y [V]\n100,1\n100.5,2\n101,3\n102,5\n103,7\n104,9'], 'B.csv'),
  );
  await engine.initializeWorkflow();
  return { engine, a, b };
}
async function samples(engine: SignalEngine, id: string) {
  const rows: number[][] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      rows.push([chunk.time[i], chunk.values[i]]);
  return rows;
}
function alignment(groups: string[][]): TimeSettings {
  return {
    kind: 'align',
    reference: { id: 'comparison', name: 'Event time', kind: 'relative' },
    target: 0,
    groups: groups.map((inputIds) => ({ inputIds, anchor: { kind: 'start' } })),
  };
}
function resampling(
  inputIds: string[],
): Extract<TimeSettings, { kind: 'resample' }> {
  return {
    kind: 'resample',
    inputIds,
    grid: { kind: 'uniform', start: 0, end: 4, rate: 2 },
    interpolation: 'linear',
    maxGap: 2,
  };
}

void test('files retain independent clocks; explicit alignment and a common grid enable arithmetic', async (t) => {
  const { engine, a, b } = await fixture(t);
  const original = await samples(engine, a.channels[0]);
  await assert.rejects(
    engine.applyTimeOperation(resampling([a.channels[0], b.channels[0]])),
    /different time references/,
  );
  const aligned = await engine.applyTimeOperation(
    alignment([[a.channels[0]], [b.channels[0]]]),
  );
  assert.deepEqual(
    aligned.map((node) => node.sourceId),
    ['', ''],
  );
  assert.deepEqual(
    (await samples(engine, aligned[0].id)).map((p) => p[0]),
    [0, 1, 2, 3, 4],
  );
  await assert.rejects(
    engine.applyTimeOperation({
      kind: 'combine',
      inputIds: [aligned[0].id, aligned[1].id],
      operator: 'difference',
    }),
    /identical timestamps/,
  );
  const shared = await engine.applyTimeOperation(
    resampling(aligned.map((n) => n.id)),
  );
  const [difference] = await engine.applyTimeOperation({
    kind: 'combine',
    inputIds: [shared[0].id, shared[1].id],
    operator: 'difference',
  });
  assert.deepEqual(
    (await samples(engine, difference.id)).map((p) => p[1]),
    Array(9).fill(-1),
  );
  const derivative = await engine.derive(difference.id, 'derivative', 0);
  assert.equal(
    (await engine.calculateValues([derivative.id], 'maximum'))[0].value,
    0,
  );
  const index = new WorkflowIndex(engine.project);
  assert.deepEqual(
    new Set(index.lineage([difference.id]).originals.map((n) => n.id)),
    new Set([a.channels[0], b.channels[0]]),
  );
  assert.deepEqual(await samples(engine, a.channels[0]), original);
  validateWorkspace(engine.project);
});

void test('resampling exposes gap and interpolation rules without extrapolation', async (t) => {
  const { engine } = await fixture(t);
  const source = await engine.importCsv(
    new File(['t,x\n0,0\n1,10\n5,50\n6,'], 'gaps.csv'),
  );
  for (const [interpolation, expected] of [
    ['linear', 5],
    ['previous', 0],
    ['nearest', 0],
  ] as const) {
    const [node] = await engine.applyTimeOperation({
      ...resampling(source.channels),
      interpolation,
      maxGap: 1.1,
      grid: { kind: 'uniform', start: -1, end: 7, rate: 2 },
    });
    const rows = await samples(engine, node.id);
    assert.ok(Number.isNaN(rows[0][1]));
    assert.equal(rows.find((p) => p[0] === 0.5)![1], expected);
    assert.ok(Number.isNaN(rows.find((p) => p[0] === 3)![1]));
    assert.equal(rows.find((p) => p[0] === 5)![1], 50);
    assert.ok(Number.isNaN(rows.at(-1)![1]));
  }
});

void test('reference grids preserve irregular timestamps, missing reference values and chunk boundaries', async (t) => {
  const { engine } = await fixture(t);
  const csv = [
    't,x,y',
    ...Array.from(
      { length: 16402 },
      (_, i) => `${i + (i % 3) * 0.01},${i},${i % 10 ? i * 2 : ''}`,
    ),
  ].join('\n');
  const source = await engine.importCsv(new File([csv], 'large.csv'));
  const outputs = await engine.applyTimeOperation({
    kind: 'resample',
    inputIds: source.channels,
    grid: {
      kind: 'reference',
      signalId: source.channels[0],
      start: 0,
      end: 20000,
    },
    interpolation: 'linear',
    maxGap: 2,
  });
  const a = await samples(engine, outputs[0].id),
    b = await samples(engine, outputs[1].id);
  assert.equal(a.length, 16402);
  assert.deepEqual(
    a.map((p) => p[0]),
    b.map((p) => p[0]),
  );
  assert.equal(a[16384][1], 16384);
  assert.ok(Number.isNaN(b[0][1]));
  validateWorkspace(engine.project);
});

void test('event anchors shift whole channel groups and preserve event provenance', async (t) => {
  const { engine, a } = await fixture(t);
  const outputs = await engine.applyTimeOperation({
    kind: 'align',
    reference: { id: 'event', name: 'State rising', kind: 'relative' },
    target: 0,
    groups: [
      {
        inputIds: [a.channels[0]],
        anchor: {
          kind: 'event',
          trigger: {
            signalId: a.channels[1],
            edge: 'rising',
            threshold: 0.5,
            offset: 0.25,
          },
          occurrence: 1,
        },
      },
    ],
  });
  assert.equal((await samples(engine, outputs[0].id))[0][0], -1.75);
  assert.deepEqual(outputs[0].parents, [a.channels[0], a.channels[1]]);
  const before = structuredClone(engine.project);
  const missing: TimeSettings = {
    kind: 'align',
    reference: { id: 'missing', name: 'Missing', kind: 'relative' },
    target: 0,
    groups: [
      {
        inputIds: a.channels,
        anchor: {
          kind: 'event',
          trigger: {
            signalId: a.channels[1],
            edge: 'rising',
            threshold: 5,
            offset: 0,
          },
          occurrence: 1,
        },
      },
    ],
  };
  await assert.rejects(engine.applyTimeOperation(missing), /not found/);
  assert.deepEqual(engine.project, before);
});

void test('two anchors correct clock rate and derivatives use corrected elapsed time', async (t) => {
  const { engine, a } = await fixture(t);
  const [node] = await engine.applyTimeOperation({
    kind: 'align',
    reference: { id: 'clock', name: 'Corrected clock', kind: 'relative' },
    target: 0,
    secondTarget: 2,
    groups: [
      {
        inputIds: [a.channels[0]],
        anchor: { kind: 'point', time: 10 },
        secondAnchor: { kind: 'point', time: 14 },
      },
    ],
  });
  assert.deepEqual(
    (await samples(engine, node.id)).map((p) => p[0]),
    [0, 0.5, 1, 1.5, 2],
  );
  const derivative = await engine.derive(node.id, 'derivative', 0);
  assert.equal(
    (await engine.calculateValues([derivative.id], 'maximum'))[0].value,
    4,
  );
});

void test('shared grids use a common origin, not merely a common sample rate', async (t) => {
  const { engine, a, b } = await fixture(t);
  const aligned = await engine.applyTimeOperation({
    kind: 'align',
    reference: { id: 'same', name: 'Same event', kind: 'relative' },
    target: 0,
    groups: [
      { inputIds: [a.channels[0]], anchor: { kind: 'point', time: 10 } },
      { inputIds: b.channels, anchor: { kind: 'point', time: 100.25 } },
    ],
  });
  const outputs = await engine.applyTimeOperation({
    ...resampling(aligned.map((n) => n.id)),
    grid: { kind: 'uniform', start: 0, end: 3, rate: 2 },
  });
  assert.deepEqual(
    (await samples(engine, outputs[0].id)).map((p) => p[0]),
    (await samples(engine, outputs[1].id)).map((p) => p[0]),
  );
});

void test('time operations edit and replay dependents atomically, with Undo and archive restore', async (t) => {
  const { engine, a, b } = await fixture(t);
  const align = alignment([[a.channels[0]], b.channels]);
  const aligned = await engine.applyTimeOperation(align);
  const step = engine.project.workflowSteps!.at(-1)!;
  const shared = await engine.applyTimeOperation(
    resampling(aligned.map((n) => n.id)),
  );
  const [difference] = await engine.applyTimeOperation({
    kind: 'combine',
    inputIds: [shared[0].id, shared[1].id],
    operator: 'difference',
  });
  assert.equal(affectedOperations(engine.project, step.id).length, 3);
  assert.deepEqual(savedCommand(engine.project, step), {
    type: 'time-operation',
    settings: align,
  });
  const changed = structuredClone(align);
  if (changed.kind !== 'align') throw new Error('fixture');
  changed.groups[1].anchor = { kind: 'point', time: 101 };
  await engine.editOperation(step.id, {
    type: 'time-operation',
    settings: changed,
  });
  assert.equal((await samples(engine, difference.id))[0][1], -3);
  assert.equal(
    engine.project.workflowSteps!.find((s) => s.id === step.id)!.revision,
    2,
  );
  await engine.travel('undo');
  assert.equal((await samples(engine, difference.id))[0][1], -1);
  const backup = await engine.backupWorkspace();
  await engine.restoreWorkspace(new File([backup], 'workspace.ndjson'));
  validateWorkspace(engine.project);
  assert.equal((await samples(engine, difference.id))[0][1], -1);
  const importStep = engine.project.workflowSteps!.find(
    (s) => s.kind === 'import' && s.outputIds.includes(b.channels[0]),
  )!;
  await engine.deleteOperation(importStep.id);
  assert.ok(!engine.project.nodes.some((n) => n.id === difference.id));
  await engine.travel('undo');
  assert.ok(engine.project.nodes.some((n) => n.id === difference.id));
});

void test('mixed-source unary batches and scalar summaries do not invent a recording owner', async (t) => {
  const { engine, a, b } = await fixture(t);
  const outputs = await engine.deriveMany(
    [a.channels[0], b.channels[0]],
    'scale',
    2,
  );
  assert.ok(outputs.every((n) => n.sourceId === ''));
  assert.equal(engine.project.workflowSteps!.at(-1)!.outputIds.length, 2);
  const values = await engine.calculateValues(
    [a.channels[0], b.channels[0]],
    'maximum',
  );
  assert.deepEqual(
    values.map((v) => v.value),
    [8, 9],
  );
  assert.ok(values.every((v) => v.sourceId === ''));
  validateWorkspace(engine.project);
});

void test('filter suppresses above-Nyquist content without shifting the output clock', async (t) => {
  const { engine } = await fixture(t);
  const csv = [
    't,x',
    ...Array.from(
      { length: 2001 },
      (_, i) => `${i / 100},${2 + Math.sin((2 * Math.PI * 30 * i) / 100)}`,
    ),
  ].join('\n');
  const source = await engine.importCsv(new File([csv], 'sine.csv'));
  const [node] = await engine.applyTimeOperation({
    kind: 'resample',
    inputIds: source.channels,
    grid: { kind: 'uniform', start: 0, end: 20, rate: 20 },
    interpolation: 'linear',
    maxGap: 0.1,
    filter: { cutoff: 8, halfWidth: 64 },
  });
  const rows = await samples(engine, node.id),
    finite = rows.filter((p) => Number.isFinite(p[1]));
  assert.equal(rows[0][0], 0);
  assert.ok(Number.isNaN(rows[0][1]));
  assert.ok(finite.length > 350);
  assert.ok(finite.every((p) => Math.abs(p[1] - 2) < 0.001));
});

void test('bad recipes, irregular filtering, unmatched units and cancellation publish nothing', async (t) => {
  const { engine, a, b } = await fixture(t);
  const before = structuredClone(engine.project);
  await assert.rejects(
    engine.applyTimeOperation({
      ...resampling(b.channels),
      grid: { kind: 'uniform', start: 100, end: 104, rate: 1 },
      filter: { cutoff: 0.2, halfWidth: 4 },
    }),
    /regularly spaced/,
  );
  await assert.rejects(
    engine.applyTimeOperation({
      ...resampling(a.channels),
      grid: { kind: 'uniform', start: 0, end: 1, rate: 0 },
    }),
    /Hz/,
  );
  await assert.rejects(
    engine.applyTimeOperation({
      kind: 'combine',
      inputIds: [a.channels[0], a.channels[1]],
      operator: 'sum',
    }),
    /matching unit/,
  );
  assert.deepEqual(engine.project, before);
  engine.cancelled = true;
  await assert.rejects(
    engine.applyTimeOperation(alignment([a.channels])),
    /cancelled/,
  );
  engine.cancelled = false;
  assert.deepEqual(engine.project, before);
});

void test('archive rejects time recipes with dangling dependencies or invalid clocks', async (t) => {
  const { engine, a } = await fixture(t);
  const [node] = await engine.applyTimeOperation(alignment([a.channels]));
  const project = structuredClone(engine.project);
  const recipe = project.nodes.find((n) => n.id === node.id)!.timeRecipe!;
  if (recipe.kind !== 'align') throw new Error('fixture');
  recipe.scale = -1;
  assert.throws(() => validateWorkspace(project), /Clock scale/);
  const graph = new SignalGraph(engine.project);
  assert.equal(graph.timeReferences.get(node.id)!.name, 'Event time');
});

void test('aligned workspace signals support triggers, nested segments, existing functions and backup', async (t) => {
  const { engine, a } = await fixture(t);
  const aligned = await engine.applyTimeOperation(alignment([a.channels]));
  const segments = await engine.segment(
    '',
    {
      method: 'triggers',
      boundary: 'clip',
      start: {
        signalId: aligned[1].id,
        edge: 'rising',
        threshold: 0.5,
        offset: 0,
      },
      end: {
        signalId: aligned[1].id,
        edge: 'falling',
        threshold: 0.5,
        offset: 0,
      },
      minimumDuration: 0,
    },
    [aligned[0].id],
    false,
    'signals',
  );
  assert.deepEqual(
    (await samples(engine, segments[0].nodes[0])).map((p) => p[0]),
    [2, 3],
  );
  const nested = await engine.segment(
    '',
    { method: 'ranges', ranges: [[2, 2.5]], boundary: 'clip' },
    segments[0].nodes,
    false,
    'signals',
  );
  assert.equal((await samples(engine, nested[0].nodes[0])).length, 1);
  const scaled = await engine.derive(nested[0].nodes[0], 'scale', 3);
  assert.equal(
    (await engine.calculateValues([scaled.id], 'maximum'))[0].value,
    12,
  );
  validateWorkspace(engine.project);
  const backup = await engine.backupWorkspace();
  await engine.restoreWorkspace(new File([backup], 'segments.stratus'));
  assert.equal((await samples(engine, scaled.id))[0][1], 12);
});

void test('existing binary calculations accept explicit shared grids across source files', async (t) => {
  const { engine } = await fixture(t);
  const torque = await engine.importCsv(
    new File(['t,T [Nm]\n0,10\n1,20\n2,30'], 'torque.csv'),
  );
  const speed = await engine.importCsv(
    new File(['t,n [rpm]\n100,1000\n101,1000\n102,1000'], 'speed.csv'),
  );
  const aligned = await engine.applyTimeOperation(
    alignment([torque.channels, speed.channels]),
  );
  const shared = await engine.applyTimeOperation({
    ...resampling(aligned.map((n) => n.id)),
    grid: { kind: 'uniform', start: 0, end: 2, rate: 1 },
  });
  const run = await engine.applyRegionFunction({
    sourceId: '',
    inputIds: [shared[0].id],
    secondaryIds: [shared[1].id],
    operation: 'power',
    parameter: 0,
  });
  assert.ok(
    Math.abs(
      (await samples(engine, run.outputs[0].signalId))[0][1] - Math.PI / 3,
    ) < 1e-10,
  );
  validateWorkspace(engine.project);
});
