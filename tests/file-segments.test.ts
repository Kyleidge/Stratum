import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { stepName, WorkflowIndex } from '../lib/workflow-history';
import { isSegmentCrop } from '../lib/file-segments';
import { validateWorkspace } from '../lib/workspace-archive';
import { workflowRows } from '../lib/workflow-tree';

// 1 Hz for 40 s: torque equals time; speed is high from 5 s to 12 s and
// from 20 s to 30 s.
const CSV = [
  't,Torque [Nm],Speed [rpm]',
  ...Array.from({ length: 40 }, (_, t) => {
    const high = (t >= 5 && t < 12) || (t >= 20 && t < 30);
    return `${t},${t},${high ? 2000 : 800}`;
  }),
].join('\n');

async function fixture() {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([CSV], 'rig.csv'));
  const [torque, speed] = source.channels;
  return { engine, source, torque, speed };
}
async function samples(engine: SignalEngine, id: string) {
  const points: [number, number][] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      points.push([chunk.time[i], chunk.values[i]]);
  return points;
}
const stepOf = (engine: SignalEngine, id: string) =>
  new WorkflowIndex(engine.project).owner.get(id)!;

void test('segments are time intervals of the whole recording, not signals', async () => {
  const { engine, source, speed } = await fixture();
  const nodes = engine.project.nodes.length;
  const set = await engine.segmentSet(source.id, {
    method: 'triggers',
    boundary: 'clip',
    minimumDuration: 0,
    start: { signalId: speed, edge: 'rising', threshold: 1500, offset: 0 },
    end: { signalId: speed, edge: 'falling', threshold: 1500, offset: 0 },
  });
  assert.equal(engine.project.nodes.length, nodes, 'no signals are created');
  assert.equal(set.segments.length, 2);
  assert.deepEqual(
    set.segments.map((segment) => segment.name),
    ['Segment 01', 'Segment 02'],
  );
  const step = stepOf(engine, set.segments[0].id);
  assert.equal(step.kind, 'segment');
  assert.equal(step.segmentSetId, set.id);
  assert.deepEqual(step.inputIds, [speed]);
  assert.equal(stepName(step), 'Trigger segments');
  const index = new WorkflowIndex(engine.project);
  assert.equal(index.kind(set.segments[0].id), 'Segment');
  assert.deepEqual(index.inputs(set.segments[0].id), [speed]);
  engine.close();
});

void test('values and derived signals run within one, several or all segments', async () => {
  const { engine, source, torque } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
      [30, 39],
    ],
  });
  const [first, second, last] = set.segments;
  assert.equal(first.endInclusive, false);
  assert.equal(last.endInclusive, true, 'the recording end is included');
  const maxima = await engine.calculateValues(
    [torque],
    'maximum',
    undefined,
    undefined,
    { setId: set.id },
  );
  assert.deepEqual(
    maxima.map((value) => [value.segmentId, value.value]),
    [
      [first.id, 5],
      [second.id, 19],
      [last.id, 39],
    ],
  );
  const valueStep = stepOf(engine, maxima[0].id);
  assert.deepEqual(valueStep.inputIds, [torque]);
  assert.deepEqual(valueStep.segmentInputIds, [first.id, second.id, last.id]);
  const index = new WorkflowIndex(engine.project);
  assert.match(index.label(maxima[1].id), /Segment 02 · Torque/);
  assert.deepEqual(index.inputs(maxima[1].id), [torque, second.id]);

  // One segment only.
  const [only] = await engine.calculateValues(
    [torque],
    'minimum',
    undefined,
    undefined,
    { setId: set.id, segmentIds: [second.id] },
  );
  assert.equal(only.value, 10);

  // Derived within segments: stateful functions restart in each segment.
  const integrals = await engine.deriveMany(
    [torque],
    'integral',
    0,
    true,
    undefined,
    { within: { setId: set.id } },
  );
  assert.equal(integrals.length, 3);
  const firstIntegral = await samples(engine, integrals[0].id);
  assert.deepEqual(firstIntegral[0], [2, 0]);
  assert.equal(firstIntegral.at(-1)![0], 5, 'the end is excluded');
  const secondIntegral = await samples(engine, integrals[1].id);
  assert.deepEqual(secondIntegral[0], [10, 0]);
  const deriveStep = stepOf(engine, integrals[0].id);
  assert.deepEqual(deriveStep.inputIds, [torque]);
  assert.ok(
    engine.project.nodes.some(
      (node) => isSegmentCrop(node) && node.segmentId === second.id,
    ),
  );
  // A value of a signal within a segment belongs to that segment.
  const [area] = await engine.calculateValues([integrals[1].id], 'maximum');
  assert.equal(area.segmentId, second.id);
  assert.match(
    new WorkflowIndex(engine.project).label(integrals[1].id),
    /^Segment 02 · Torque/,
  );
  // History never lists the hidden crops.
  const outputs = new Set(
    engine.project.workflowSteps!.flatMap((step) => step.outputIds),
  );
  assert.ok(
    engine.project.nodes
      .filter((node) => !outputs.has(node.id))
      .every((node) => isSegmentCrop(node)),
  );
  validateWorkspace(structuredClone(engine.project));
  engine.close();
});

void test('nested segments search each parent; ranges are relative to it', async () => {
  const { engine, source, torque } = await fixture();
  const parents = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 8],
      [20, 30],
    ],
  });
  const nested = await engine.segmentSet(
    source.id,
    { method: 'ranges', boundary: 'clip', ranges: [[1, 3]] },
    undefined,
    { setId: parents.id },
  );
  assert.deepEqual(
    nested.segments.map((segment) => [
      segment.name,
      segment.start,
      segment.end,
    ]),
    [
      ['Segment 01.01', 3, 5],
      ['Segment 02.01', 21, 23],
    ],
  );
  assert.equal(nested.segments[1].parentId, parents.segments[1].id);
  const step = stepOf(engine, nested.segments[0].id);
  assert.equal(stepName(step), 'Nested time range segments');
  assert.deepEqual(
    step.segmentInputIds,
    parents.segments.map((segment) => segment.id),
  );
  // A signal within a parent segment can be processed within its children.
  const [cropped] = await engine.deriveMany(
    [torque],
    'scale',
    2,
    true,
    undefined,
    { within: { setId: parents.id, segmentIds: [parents.segments[0].id] } },
  );
  const values = await engine.calculateValues(
    [cropped.id],
    'maximum',
    undefined,
    undefined,
    { setId: nested.id },
  );
  assert.deepEqual(
    values.map((value) => [value.segmentId, value.value]),
    [[nested.segments[0].id, 8]],
    'children of other parents are skipped',
  );
  validateWorkspace(structuredClone(engine.project));
  engine.close();
});

void test('editing segments keeps matching outputs and follows a new count', async () => {
  const { engine, source, torque } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
    ],
  });
  const segmentStep = stepOf(engine, set.segments[0].id);
  const maxima = await engine.calculateValues(
    [torque],
    'maximum',
    undefined,
    undefined,
    { setId: set.id },
  );
  const smooth = await engine.deriveMany(
    [torque],
    'smooth',
    2,
    true,
    undefined,
    { within: { setId: set.id } },
  );
  // A later step that uses every output follows the batch.
  const averages = await engine.calculateValues(
    smooth.map((node) => node.id),
    'sample-average',
  );
  await engine.editOperation(segmentStep.id, {
    type: 'segment-set',
    sourceId: source.id,
    definition: {
      method: 'ranges',
      boundary: 'clip',
      ranges: [
        [2, 6],
        [10, 20],
        [25, 30],
      ],
    },
  });
  const edited = engine.project.segmentSets!.find(
    (item) => item.id === set.id,
  )!;
  assert.equal(edited.segments.length, 3);
  assert.equal(edited.segments[0].id, set.segments[0].id, 'IDs are kept');
  const valueStep = engine.project.workflowSteps!.find(
    (step) => step.id === stepOf(engine, maxima[0].id).id,
  )!;
  assert.equal(valueStep.outputIds.length, 3);
  assert.deepEqual(
    valueStep.outputIds.slice(0, 2),
    maxima.map((v) => v.id),
  );
  const values = new Map(engine.project.values!.map((v) => [v.id, v]));
  assert.deepEqual(
    valueStep.outputIds.map((id) => values.get(id)!.value),
    [5, 19, 29],
  );
  const averageStep = engine.project.workflowSteps!.find(
    (step) => step.id === stepOf(engine, averages[0].id).id,
  )!;
  assert.equal(averageStep.outputIds.length, 3);
  validateWorkspace(structuredClone(engine.project));

  // Undo restores the earlier segments and results.
  await engine.travel('undo');
  assert.equal(
    engine.project.segmentSets!.find((item) => item.id === set.id)!.segments
      .length,
    2,
  );
  // Deleting the segments removes every step within them and their crops.
  await engine.deleteOperation(segmentStep.id);
  assert.equal(engine.project.segmentSets!.length, 0);
  assert.ok(!engine.project.nodes.some((node) => isSegmentCrop(node)));
  assert.equal(engine.project.values!.length, 0);
  validateWorkspace(structuredClone(engine.project));
  engine.close();
});

void test('backups keep segments and steps within them', async () => {
  const { engine, source, torque, speed } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [[2, 6]],
  });
  await engine.calculateValues(
    [torque, speed],
    'maximum',
    undefined,
    undefined,
    {
      setId: set.id,
    },
  );
  await engine
    .deriveMany([torque], 'subtract', 0, true, undefined, {})
    .catch(() => undefined);
  await engine.applyRegionFunction({
    sourceId: source.id,
    operation: 'multiply',
    parameter: 0,
    inputIds: [torque],
    secondaryIds: [speed],
    within: { setId: set.id },
  });
  const backup = await engine.backupWorkspace();
  const target = new SignalEngine(undefined, crypto.randomUUID());
  await target.open();
  await target.initializeWorkflow();
  await target.restoreWorkspace(new File([backup], 'segments.stratum'));
  assert.equal(target.project.segmentSets!.length, 1);
  const product = target.project.nodes.find(
    (node) => node.operation === 'multiply',
  )!;
  assert.equal(product.segmentId, set.segments[0].id);
  const points = await samples(target, product.id);
  assert.deepEqual(points[0], [2, 2 * 800]);
  engine.close();
  target.close();
});

void test('settings taken from values use the value of the same segment', async () => {
  const { engine, source, torque } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
    ],
  });
  const starts = await engine.calculateValues(
    [torque],
    'start-value',
    undefined,
    undefined,
    { setId: set.id },
  );
  // Each segment is offset by minus its own start value.
  const offsets = await engine.deriveMany(
    [torque],
    'offset',
    0,
    true,
    { value: { valueIds: starts.map((value) => value.id), factor: -1 } },
    { within: { setId: set.id } },
  );
  assert.deepEqual(
    offsets.map((node) => node.bindings?.value.valueId),
    starts.map((value) => value.id),
  );
  assert.deepEqual((await samples(engine, offsets[1].id))[0], [10, 0]);
  // An entire signal cannot use values of segments.
  await assert.rejects(
    engine.deriveMany([torque], 'offset', 0, true, {
      value: { valueIds: starts.map((value) => value.id), factor: -1 },
    }),
    /within the segment/,
  );
  engine.close();
});

void test('workspace outputs are segmented on their own time axis', async () => {
  const { engine, torque, speed } = await fixture();
  const shared = await engine.applyTimeOperation({
    kind: 'resample',
    inputIds: [torque, speed],
    grid: { kind: 'uniform', start: 0, end: 39, rate: 1 },
    interpolation: 'linear',
    maxGap: 2,
  });
  assert.ok(shared.every((node) => node.sourceId === ''));
  const set = await engine.segmentSet(
    '',
    { method: 'ranges', boundary: 'clip', ranges: [[20, 25]] },
    shared[0].id,
  );
  assert.ok(set.timeReferenceId);
  assert.equal(set.referenceId, shared[0].id);
  const [peak] = await engine.calculateValues(
    [shared[0].id],
    'maximum',
    undefined,
    undefined,
    { setId: set.id },
  );
  assert.equal(peak.value, 24);
  // A recording's own signals are not on this axis.
  await assert.rejects(
    engine.calculateValues([torque], 'maximum', undefined, undefined, {
      setId: set.id,
    }),
    /not on the time axis/,
  );
  validateWorkspace(structuredClone(engine.project));
  engine.close();
});

void test('edits follow per-segment values used for settings, including nested ones', async () => {
  const { engine, source, torque } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
    ],
  });
  const starts = await engine.calculateValues(
    [torque],
    'start-value',
    undefined,
    undefined,
    { setId: set.id },
  );
  const binding = {
    value: { valueIds: starts.map((value) => value.id), factor: -1 },
  };
  await engine.deriveMany([torque], 'offset', 0, true, binding, {
    within: { setId: set.id },
  });
  // Nested segments use the value of the segment that contains them.
  const nested = await engine.segmentSet(
    source.id,
    { method: 'ranges', boundary: 'clip', ranges: [[1, 2]] },
    undefined,
    { setId: set.id },
  );
  const inner = await engine.deriveMany([torque], 'offset', 0, true, binding, {
    within: { setId: nested.id },
  });
  assert.deepEqual((await samples(engine, inner[1].id))[0], [11, 1]);
  const segmentStep = stepOf(engine, set.segments[0].id);
  for (const ranges of [
    [
      [2, 6],
      [10, 20],
      [25, 30],
    ],
    [[2, 6]],
  ] as [number, number][][]) {
    await engine.editOperation(segmentStep.id, {
      type: 'segment-set',
      sourceId: source.id,
      definition: { method: 'ranges', boundary: 'clip', ranges },
    });
    const offsets = engine.project.nodes.filter(
      (node) => node.operation === 'offset' && !node.internal,
    );
    assert.equal(offsets.length, ranges.length * 2);
    validateWorkspace(structuredClone(engine.project));
  }
  engine.close();
});

void test('a formula within segments skips segments where a signal has no samples', async () => {
  const { engine, source, torque, speed } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
    ],
  });
  const [onlyFirst] = await engine.deriveMany(
    [speed],
    'scale',
    1,
    true,
    undefined,
    { within: { setId: set.id, segmentIds: [set.segments[0].id] } },
  );
  const sums = await engine.deriveMany(
    [torque],
    'formula',
    0,
    true,
    undefined,
    {
      unit: 'x',
      formula: { expression: 'A + B', signals: { B: [onlyFirst.id] } },
      within: { setId: set.id },
    },
  );
  assert.equal(sums.length, 1);
  assert.equal(sums[0].segmentId, set.segments[0].id);
  engine.close();
});

void test('History shows a Segment step as one row, however many segments', async () => {
  const { engine, source } = await fixture();
  await engine.segmentSet(source.id, {
    method: 'windows',
    boundary: 'clip',
    start: 0,
    end: 39,
    duration: 1,
    step: 1,
    includePartial: false,
  });
  const index = new WorkflowIndex(engine.project);
  const step = engine.project.workflowSteps!.at(-1)!;
  assert.equal(step.outputIds.length, 39);
  const rows = workflowRows([step], index, new Set(), '', step.outputIds[4]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.key]),
    [['step', step.id]],
  );
  // Searching for a segment finds its step.
  assert.equal(workflowRows([step], index, new Set(), 'Segment 05').length, 1);
  engine.close();
});

void test('History shows steps within segments as one row when they have several outputs', async () => {
  const { engine, source, torque } = await fixture();
  const set = await engine.segmentSet(source.id, {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [2, 6],
      [10, 20],
    ],
  });
  await engine.calculateValues([torque], 'maximum', undefined, undefined, {
    setId: set.id,
  });
  await engine.deriveMany([torque], 'smooth', 2, true, undefined, {
    within: { setId: set.id, segmentIds: [set.segments[0].id] },
  });
  const index = new WorkflowIndex(engine.project);
  const [values, single] = engine.project.workflowSteps!.slice(-2);
  assert.deepEqual(
    workflowRows([values, single], index, new Set()).map((row) => row.kind),
    ['step', 'single'],
  );
  engine.close();
});
