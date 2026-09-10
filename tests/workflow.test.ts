import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { withWorkflowHistory, WorkflowIndex } from '../lib/workflow-history';
import { workflowRows } from '../lib/workflow-tree';
import type { Project, SignalNode } from '../lib/signal-types';
import { reportHtml, valuesCsv } from '../lib/workflow-delivery';

void test('trigger segments retain trigger provenance and mixed-input batches never absorb siblings', async () => {
  const { engine, source } = await fixture(
    't,Measured [V],Trigger [V]\n0,1,0\n1,2,2\n2,3,2\n3,4,0\n4,5,0',
  );
  try {
    const trigger = await engine.derive(source.channels[1], 'scale', 2);
    const parts = await engine.segment(
      source.id,
      {
        method: 'triggers',
        boundary: 'clip',
        minimumDuration: 0,
        start: {
          signalId: trigger.id,
          threshold: 2,
          edge: 'rising',
          offset: 0,
        },
        end: { signalId: trigger.id, threshold: 2, edge: 'falling', offset: 0 },
      },
      [source.channels[0]],
      false,
      'signals',
    );
    assert.equal(parts.length, 1);
    const segmentId = parts[0].nodes[0];
    const branch = await engine.deriveMany(
      [segmentId, source.channels[0]],
      'scale',
      3,
    );
    const index = new WorkflowIndex(engine.project);
    assert.deepEqual(
      new Set(index.lineage([segmentId]).originals.map((node) => node.id)),
      new Set(source.channels),
    );
    const step = index.owner.get(segmentId)!;
    assert.deepEqual(step.inputIds, [source.channels[0], trigger.id]);
    assert.deepEqual(
      index.owner.get(branch[0].id)?.outputIds,
      branch.map((node) => node.id),
    );
    assert.ok(index.label(branch[0].id).startsWith('Segment 01'));
    assert.ok(!index.label(branch[1].id).startsWith('Segment'));
    await engine.calculateValues([branch[1].id], 'maximum');
    const valueStep = engine.project.workflowSteps!.at(-1)!;
    assert.deepEqual(valueStep.inputIds, [branch[1].id]);
    const value = engine.project.values!.at(-1)!;
    assert.equal(value.value, 15);
    const valueLineage = new WorkflowIndex(engine.project).lineage([value.id]);
    assert.ok(!valueLineage.steps.some((item) => item.id === step.id));
  } finally {
    engine.close();
  }
});

void test('CSV exports keep formula-like raw names as text and unavailable summaries blank', async () => {
  const { engine, source } = await fixture(
    't,=1+1 [Nm],Missing [V]\n0,1,\n1,2,',
  );
  try {
    const raw = await (await engine.exportSamples([source.channels[0]])).text();
    assert.ok(raw.includes('"\'=1+1"'));
    const summary = await (await engine.exportSummary(source.channels)).text();
    assert.ok(summary.includes('"\'=1+1"'));
    assert.ok(!summary.includes('NaN'));
    assert.ok(!summary.includes('Infinity'));
  } finally {
    engine.close();
  }
});

async function fixture(
  csv = 't,Torque [Nm],Speed [rpm]\n0,0,1000\n1,10,2000\n4,10,3000\n5,,4000\n7,30,5000\n8,30,6000',
) {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([csv], 'workflow.csv'));
  return { engine, source, database };
}
async function samples(engine: SignalEngine, id: string) {
  const values: [number, number][] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      values.push([chunk.time[i], chunk.values[i]]);
  return values;
}

void test('sample exports contain evaluated nested and shifted samples, including missing values', async () => {
  const { engine, source } = await fixture();
  try {
    const [part] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[1, 8]] },
      [source.channels[0]],
      false,
      'signals',
    );
    const [nested] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[4, 7]] },
      [part.nodes[0]],
      false,
      'signals',
    );
    const shifted = await engine.derive(nested.nodes[0], 'time-shift', 10);
    const expected = await samples(engine, shifted.id);
    const blob = await engine.exportSamples([shifted.id]);
    const lines = (await blob.text()).trim().split('\r\n');
    assert.equal(lines[0], 'Signal,Signal ID,Recording,Unit,Time (s),Value');
    assert.equal(lines.length, expected.length + 1);
    assert.deepEqual(
      lines.slice(1).map((line) => line.split(',').slice(-2)),
      expected.map(([time, value]) => [
        String(time),
        Number.isFinite(value) ? String(value) : '',
      ]),
    );
    assert.ok(
      lines.some((line) => line.endsWith(',')),
      'missing sample remains blank',
    );
  } finally {
    engine.close();
  }
});

void test('delivery respects exact value scope, escapes labels and excludes sibling outputs from lineage', async () => {
  const { engine, source } = await fixture();
  try {
    const parts = await engine.segment(
      source.id,
      {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [0, 4],
          [7, 8],
        ],
      },
      [source.channels[0]],
      false,
      'signals',
    );
    const values = await engine.calculateValues(
      parts.map((part) => part.nodes[0]),
      'maximum',
    );
    const before = structuredClone(engine.project);
    const one = valuesCsv(engine.project, [values[0].id]);
    assert.equal(one.split('\r\n').length, 2);
    assert.equal(
      valuesCsv(
        engine.project,
        values.map((value) => value.id),
      ).split('\r\n').length,
      3,
    );
    const index = new WorkflowIndex(engine.project);
    const lineage = index.lineage([values[0].id]);
    const rows = workflowRows(
      lineage.steps,
      index,
      new Set(),
      '',
      values[0].id,
      lineage.outputIds,
    );
    assert.ok(rows.some((row) => row.outputId === parts[0].nodes[0]));
    assert.ok(!rows.some((row) => row.outputId === parts[1].nodes[0]));
    const report = reportHtml(
      engine.project,
      [values[0].id],
      [],
      new Date('2026-09-10T12:00:00Z'),
    );
    assert.ok(report.includes('Contributing operation history'));
    assert.ok(!report.includes(index.label(parts[1].nodes[0])));
    assert.deepEqual(
      engine.project,
      before,
      'delivery must never mutate history',
    );
    engine.project.sources[0].name = '<script>alert(1)</script>';
    engine.project.nodes.find((node) => node.id === parts[0].nodes[0])!.name =
      '=SUM(1)<img src=x>';
    const unsafe = reportHtml(engine.project, [values[0].id], []);
    assert.ok(!unsafe.includes('<script>'));
    assert.ok(unsafe.includes('&lt;script&gt;'));
    const signalCsv = await (
      await engine.exportSamples([parts[0].nodes[0]])
    ).text();
    assert.ok(!signalCsv.includes('\n"=SUM'));
    const plot = await engine.plot(parts[0].nodes[0]);
    const signalReport = reportHtml(
      engine.project,
      [parts[0].nodes[0]],
      [plot],
    );
    assert.ok(signalReport.includes('<svg'));
    assert.ok(signalReport.includes('min/max envelope'));
  } finally {
    engine.close();
  }
});

void test('time averages weight valid elapsed time; extrema and sample averages are separate scalar records', async () => {
  const { engine, source, database } = await fixture();
  try {
    const before = structuredClone(engine.project.nodes);
    const [time] = await engine.calculateValues(
      [source.channels[0]],
      'time-average',
    );
    const [mean] = await engine.calculateValues(
      [source.channels[0]],
      'sample-average',
    );
    const [minimum] = await engine.calculateValues(
      [source.channels[0]],
      'minimum',
    );
    const [maximum] = await engine.calculateValues(
      [source.channels[0]],
      'maximum',
    );
    // Integral = 5 + 30 + 30; valid duration = 1 + 3 + 1. No bridge across NaN.
    assert.equal(time.value, 13);
    assert.equal(time.validDuration, 5);
    assert.equal(time.sampleCount, 5);
    assert.equal(mean.value, 16);
    assert.equal(minimum.value, 0);
    assert.equal(minimum.timestamp, 0);
    assert.equal(maximum.value, 30);
    assert.equal(maximum.timestamp, 7);
    assert.deepEqual(engine.project.nodes, before);
    assert.equal(engine.project.workflowSteps?.length, 5);
    await assert.rejects(
      engine.derive(time.id, 'scale', 2),
      /Signal no longer exists/,
    );
    const saved = structuredClone(engine.project);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    await reopened.initializeWorkflow();
    assert.deepEqual(reopened.project, saved);
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('empty and single-sample value domains are explicit; invalid batches append nothing', async () => {
  const { engine, source } = await fixture(
    't,Empty [V],Single [V]\n0,,3\n1,,\n2,,',
  );
  try {
    const values = await engine.calculateValues(
      source.channels,
      'time-average',
    );
    assert.deepEqual(
      values.map((value) => value.value),
      [null, null],
    );
    const min = await engine.calculateValues(source.channels, 'minimum');
    assert.deepEqual(
      min.map((value) => value.value),
      [null, 3],
    );
    const saved = structuredClone(engine.project);
    await assert.rejects(
      engine.calculateValues([source.channels[0], 'missing'], 'maximum'),
    );
    await assert.rejects(
      engine.calculateValues(
        [source.channels[0], source.channels[0]],
        'minimum',
      ),
      /unique/,
    );
    engine.cancelled = true;
    await assert.rejects(
      engine.calculateValues(source.channels, 'maximum'),
      /cancelled/,
    );
    engine.cancelled = false;
    assert.deepEqual(engine.project, saved);
  } finally {
    engine.close();
  }
});

void test('original → derive → segment → derive → nested segment → value preserves inputs and chronology', async () => {
  const { engine, source } = await fixture(
    't,A [V]\n0,1\n1,2\n2,3\n3,4\n4,5\n5,6',
  );
  try {
    const original = await samples(engine, source.channels[0]);
    const originalNodes = structuredClone(engine.project.nodes);
    const derived = await engine.derive(source.channels[0], 'scale', 2);
    const parts = await engine.segment(
      source.id,
      {
        method: 'ranges',
        ranges: [
          [0, 2],
          [3, 5],
        ],
        boundary: 'clip',
      },
      [derived.id],
      false,
      'signals',
    );
    const filtered = await engine.deriveMany(
      parts.map((part) => part.nodes[0]),
      'smooth',
      2,
    );
    const nested = await engine.segment(
      source.id,
      { method: 'ranges', ranges: [[0.5, 1.5]], boundary: 'clip' },
      [filtered[0].id],
      false,
      'signals',
    );
    const [value] = await engine.calculateValues(
      [nested[0].nodes[0]],
      'maximum',
    );
    assert.equal(value.value, 3);
    assert.deepEqual(await samples(engine, source.channels[0]), original);
    assert.deepEqual(
      engine.project.nodes.slice(0, originalNodes.length),
      originalNodes,
    );
    assert.deepEqual(await samples(engine, nested[0].nodes[0]), [[1, 3]]);
    const index = new WorkflowIndex(engine.project);
    const steps = engine.project.workflowSteps!;
    assert.deepEqual(
      steps.map((step) => step.kind),
      ['import', 'derive', 'segment', 'derive', 'segment', 'value'],
    );
    assert.equal(steps[2].outputIds.length, 2);
    assert.equal(steps[3].outputIds.length, 2);
    assert.equal(steps[4].inputIds[0], filtered[0].id);
    assert.equal(index.owner.get(value.id)?.id, steps[5].id);
    assert.deepEqual(
      index.lineage([value.id]).steps.map((step) => step.id),
      steps.map((step) => step.id),
    );
    assert.deepEqual(
      index.lineage([value.id]).originals.map((node) => node.id),
      [source.channels[0]],
    );
    assert.equal(index.consumers.get(filtered[0].id)?.[0].id, steps[4].id);
    const snapshot = structuredClone(steps);
    await engine.segment(
      source.id,
      { method: 'ranges', ranges: [[0, 1]], boundary: 'clip' },
      [derived.id],
    );
    assert.deepEqual(engine.project.workflowSteps!.slice(0, -1), snapshot);
    assert.deepEqual(await samples(engine, nested[0].nodes[0]), [[1, 3]]);
  } finally {
    engine.close();
  }
});

void test('scalar batches commit atomically and reject concurrent writers', async () => {
  const { engine, source, database } = await fixture();
  const other = new SignalEngine(undefined, database);
  try {
    await other.open();
    const values = await engine.calculateValues(source.channels, 'maximum');
    const step = engine.project.workflowSteps!.at(-1)!;
    assert.equal(step.outputIds.length, 2);
    assert.deepEqual(
      step.outputIds,
      values.map((value) => value.id),
    );
    await assert.rejects(
      other.calculateValues(source.channels, 'minimum'),
      /another window/,
    );
    assert.equal(other.project.values, undefined);
    assert.equal(other.project.workflowSteps?.length, 1);
  } finally {
    engine.close();
    other.close();
  }
});

void test('time integration stays continuous across storage chunks', async () => {
  const { engine, source } = await fixture(
    't,A [V]\n' +
      Array.from({ length: 16400 }, (_, i) => `${i},${i}`).join('\n'),
  );
  try {
    const [value] = await engine.calculateValues(
      source.channels,
      'time-average',
    );
    assert.equal(value.value, 8199.5);
    assert.equal(value.validDuration, 16399);
  } finally {
    engine.close();
  }
});

void test('legacy region crops become usable derived outputs without changing recipes or duplicating migration', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  try {
    await engine.open();
    const source = await engine.demo(false);
    const set = await engine.createRegions({
      sourceId: source.id,
      name: 'Saved ranges',
      timeReference: 'recording',
      definition: {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [15, 20],
          [25, 30],
        ],
      },
    });
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 2,
      inputIds: [source.channels[1]],
      regionSetId: set.id,
    });
    const before = structuredClone(engine.project);
    await engine.initializeWorkflow();
    assert.deepEqual(engine.project.nodes, before.nodes);
    assert.deepEqual(engine.project.regionSets, before.regionSets);
    assert.deepEqual(engine.project.functionRuns, before.functionRuns);
    const index = new WorkflowIndex(engine.project);
    for (const node of engine.project.nodes)
      assert.ok(index.owner.has(node.id));
    assert.equal(
      engine.project.workflowSteps!.filter((step) => step.kind === 'segment')
        .length,
      1,
    );
    const parent = engine.project.nodes.find(
      (node) => node.id === run.outputs[0].signalId,
    )!.parents[0];
    assert.equal(index.kind(parent), 'Derived signal');
    const history = structuredClone(engine.project.workflowSteps);
    await engine.initializeWorkflow();
    assert.deepEqual(engine.project.workflowSteps, history);
    const [value] = await engine.calculateValues([parent], 'maximum');
    assert.ok(value.value !== null && value.value > 0);
  } finally {
    engine.close();
  }
});

void test('binary and trigger lineage retains all parents; ties and backwards clocks cannot reorder saved steps', async () => {
  const { engine, source } = await fixture();
  try {
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'power',
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [source.channels[1]],
    });
    const step = engine.project.workflowSteps!.at(-1)!;
    const old = structuredClone(engine.project.workflowSteps);
    assert.deepEqual(new Set(step.inputIds), new Set(source.channels));
    const [value] = await engine.calculateValues(
      [run.outputs[0].signalId],
      'minimum',
    );
    const lineage = new WorkflowIndex(engine.project).lineage([value.id]);
    assert.deepEqual(
      new Set(lineage.originals.map((node) => node.id)),
      new Set(source.channels),
    );
    assert.deepEqual(engine.project.workflowSteps!.slice(0, -1), old);
    const newNode: SignalNode = {
      ...engine.project.nodes[0],
      id: 'clock-reset',
      operation: 'scale',
      parents: [run.outputs[0].signalId],
      parameters: { value: 2 },
      createdAt: '1900-01-01',
    };
    const migrated = withWorkflowHistory({
      ...engine.project,
      nodes: [...engine.project.nodes, newNode],
    });
    assert.equal(migrated.workflowSteps!.at(-1)!.outputIds[0], newNode.id);
    assert.deepEqual(
      migrated.workflowSteps!.slice(0, -1),
      engine.project.workflowSteps,
    );
  } finally {
    engine.close();
  }
});

void test('5,000 deep operations stay two levels; large batches remain bounded and every member is findable', () => {
  const source = {
    id: 'source',
    name: 'Data',
    rows: 1,
    chunks: 1,
    bytes: 8,
    start: 0,
    end: 1,
    channels: ['raw'],
    synthetic: false,
    chunkRanges: [[0, 1] as [number, number]],
  };
  const raw: SignalNode = {
    id: 'raw',
    name: 'A',
    unit: 'V',
    sourceId: source.id,
    operation: 'raw',
    parents: [],
    parameters: {},
    channel: 0,
    color: '#fff',
    createdAt: '',
    version: 1,
  };
  const nodes = [raw];
  for (let i = 0; i < 5000; i++)
    nodes.push({
      ...raw,
      id: `derived-${i}`,
      operation: 'scale',
      parents: [nodes.at(-1)!.id],
      parameters: { value: 2 },
    });
  for (let i = 0; i < 1000; i++)
    nodes.push({
      ...raw,
      id: `batch-${i}`,
      name: `Window ${i}`,
      operation: 'crop',
      parents: ['raw'],
      parameters: { start: 0, end: 1 },
      batchId: 'batch',
    });
  const project: Project = withWorkflowHistory({
    sources: [source],
    nodes,
    segments: [],
  });
  const index = new WorkflowIndex(project),
    steps = project.workflowSteps!;
  assert.equal(steps.length, 5002);
  assert.equal(index.lineage(['derived-4999']).steps.length, 5001);
  const rows = workflowRows(steps, index, new Set());
  const referenceMatch = workflowRows(steps, index, new Set(), '#5002');
  assert.equal(referenceMatch.filter((row) => row.kind === 'step').length, 1);
  assert.equal(referenceMatch[0].step.sequence, 5001);
  assert.equal(rows.length, 10007); // 5,001 pairs + batch step + 3 outputs + more.
  const found = workflowRows(steps, index, new Set(), 'Window 999');
  assert.ok(found.some((row) => row.outputId === 'batch-999'));
  const reveal = workflowRows(steps, index, new Set(), '', 'batch-999');
  assert.ok(reveal.some((row) => row.outputId === 'batch-999'));
  assert.equal(
    reveal.filter((row) => row.step.outputIds.length === 1000).length,
    6,
  );
  assert.deepEqual(project.nodes, nodes);
});
