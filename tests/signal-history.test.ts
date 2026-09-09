import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { SignalGraph } from '../lib/signal-graph';
import { segmentationOperation } from '../lib/segmentation-operation';
import {
  buildExplorer,
  explorerRows,
  revealEntry,
} from '../lib/signal-explorer';
import type { SegmentationDefinition, SignalNode } from '../lib/signal-types';

async function fixture(
  csv = 't,a [V]\n0,0\n1,10\n2,2\n3,4\n4,0\n5,10\n6,2\n7,4\n8,0\n9,10\n10,2\n11,4',
) {
  const name = crypto.randomUUID();
  const engine = new SignalEngine(undefined, name);
  await engine.open();
  const source = await engine.importCsv(new File([csv], 'history.csv'));
  return { engine, source, name };
}
const ranges: SegmentationDefinition = {
  method: 'ranges',
  ranges: [
    [0, 3],
    [4, 7],
    [8, 11],
  ],
  boundary: 'clip',
};
async function collect(engine: SignalEngine, id: string) {
  const points: [number, number][] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      points.push([chunk.time[i], chunk.values[i]]);
  return points;
}

void test('collections show filter -> segmentation -> moving average -> min/max in order', async () => {
  const { engine: e, source: s } = await fixture();
  const filtered = await e.derive(s.channels[0], 'median', 3);
  const segments = await e.segment(s.id, ranges, [filtered.id]);
  const inputs = segments.map((segment) => segment.nodes[0]);
  const smoothed = await e.deriveMany(inputs, 'smooth', 2);
  const extrema = await e.deriveMany(
    smoothed.map((node) => node.id),
    'min-max',
    0,
  );
  assert.ok(
    segments.every((segment) => segment.batchId === segments[0].batchId),
  );
  assert.deepEqual(
    smoothed.map((node) => node.parents[0]),
    inputs,
  );
  const model = buildExplorer(e.project, s.id);
  const summary = explorerRows(model, revealEntry(model, filtered.id)).filter(
    (row) => row.entry.kind === 'signal' || row.entry.kind === 'collection',
  );
  assert.deepEqual(
    summary.map((row) => row.entry.label),
    ['a', 'Median filter', 'Segment', 'Moving average', 'Min / Max'],
  );
  assert.deepEqual(
    summary.map((row) => row.step),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    model.entries.get(`operation:${extrema[0].batchId}`)!.ids,
    extrema.map((node) => node.id),
  );
  assert.equal(new SignalGraph(e.project).chain(extrema[0].id).length, 5);
  assert.deepEqual(
    smoothed.map((node) => model.entries.get(node.id)!.label),
    segments.map((segment) => segment.name),
    'Expanded outputs retain their segment identities',
  );
  assert.deepEqual(
    explorerRows(model, revealEntry(model, `operation:${extrema[0].batchId}`))
      .filter(
        (row) => row.entry.kind === 'signal' || row.entry.kind === 'collection',
      )
      .map((row) => row.entry.label),
    ['a', 'Median filter', 'Segment', 'Moving average', 'Min / Max'],
    'Selecting a shared stage must not expand every historical segment member',
  );
  e.close();
});
void test('individual deviations stay under their member and separate segmentation revisions never merge', async () => {
  const { engine: e, source: s } = await fixture();
  const first = await e.segment(s.id, ranges, s.channels, false, 'signals');
  const second = await e.segment(s.id, ranges, s.channels, false, 'signals');
  const modified = await e.derive(first[0].nodes[0], 'offset', 7);
  const model = buildExplorer(e.project, s.id);
  const groups = [...model.entries.values()].filter(
    (entry) => entry.kind === 'collection',
  );
  assert.equal(groups.length, 2);
  assert.notEqual(first[0].batchId, second[0].batchId);
  assert.equal(model.entries.get(modified.id)!.parent, first[0].nodes[0]);
  const rows = explorerRows(model, revealEntry(model, modified.id));
  assert.ok(rows.some((row) => row.entry.id === modified.id));
  assert.ok(!rows.some((row) => row.entry.id === second[0].nodes[0]));
  e.close();
});
void test('re-segmenting a collection creates one shared next stage and independent new branches', async () => {
  const { engine: e, source: s } = await fixture();
  const first = await e.segment(s.id, ranges, s.channels, false, 'signals');
  const filtered = await e.deriveMany(
    first.map((segment) => segment.nodes[0]),
    'smooth',
    2,
  );
  const definition: SegmentationDefinition = {
    method: 'windows',
    start: 0,
    end: 11,
    duration: 2,
    step: 2,
    includePartial: true,
    boundary: 'clip',
  };
  const next = await e.segment(
    s.id,
    definition,
    filtered.map((node) => node.id),
    true,
  );
  assert.equal(next.length, 6);
  assert.ok(next.every((segment) => segment.nodes.length === 1));
  const model = buildExplorer(e.project, s.id);
  const group = [...model.entries.values()].find(
    (entry) =>
      entry.parent === `operation:${filtered[0].batchId}` &&
      entry.kind === 'collection',
  )!;
  assert.equal(group.ids.length, 6);
  assert.deepEqual(
    new Set(next.map((segment) => e.find(segment.nodes[0]).parents[0])),
    new Set(filtered.map((node) => node.id)),
  );
  e.close();
});
void test('batch derivation is atomic and uses exactly the selected member IDs', async () => {
  const { engine: e, source: s } = await fixture();
  const segments = await e.segment(s.id, ranges, s.channels);
  const before = e.project.nodes.length;
  await assert.rejects(
    e.deriveMany([segments[0].nodes[0], 'missing'], 'smooth', 2),
    /no longer exists/,
  );
  assert.equal(e.project.nodes.length, before);
  const output = await e.deriveMany(
    [segments[0].nodes[0], segments[2].nodes[0]],
    'scale',
    2,
  );
  assert.deepEqual(
    output.map((node) => node.parents[0]),
    [segments[0].nodes[0], segments[2].nodes[0]],
  );
  assert.equal(
    e.project.nodes.filter((node) => node.parents[0] === segments[1].nodes[0])
      .length,
    0,
  );
  e.close();
});
void test('min/max retains finite extrema timestamps, ties and immutable parent data', async () => {
  const { engine: e, source: s } = await fixture(
    't,a\n0,\n1,8\n2,-2\n3,8\n4,0',
  );
  const before = await collect(e, s.channels[0]);
  const node = await e.derive(s.channels[0], 'min-max', 0);
  assert.deepEqual(await collect(e, node.id), [
    [1, 8],
    [2, -2],
  ]);
  assert.deepEqual(await collect(e, s.channels[0]), before);
  assert.equal((await e.plot(node.id)).summary.min, -2);
  e.close();
});
void test('min/max sample grids cannot publish incompatible power calculations', async () => {
  const { engine: e, source: s } = await fixture(
    't,Speed [rpm],Torque [Nm]\n0,2000,100\n1,1000,200\n2,3000,300\n3,2000,200',
  );
  const events = await e.deriveMany(s.channels, 'min-max', 0);
  const segments = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 3]], boundary: 'clip' },
    events.map((node) => node.id),
  );
  const before = e.project.nodes.length;
  await assert.rejects(
    e.calculateSegmentMetrics(segments.map((segment) => segment.id)),
    /matching sample grids/,
  );
  assert.equal(e.project.nodes.length, before);
  e.close();
});
void test('5,000-stage chains evaluate, display and persist without recursion or a depth cap', async () => {
  const { engine: e, source: s, name } = await fixture('t,a\n0,1\n1,2\n2,3');
  const base = e.find(s.channels[0]);
  const added: SignalNode[] = [];
  let parent = base.id;
  for (let i = 0; i < 5000; i++) {
    const node: SignalNode = {
      ...base,
      id: `deep-${i}`,
      operation: i % 100 === 0 ? 'time-shift' : 'offset',
      parents: [parent],
      parameters: { value: 1 },
      name: 'a · derived',
    };
    added.push(node);
    parent = node.id;
  }
  e.project = { ...e.project, nodes: [...e.project.nodes, ...added] };
  const tail = await e.derive(parent, 'absolute', 0);
  assert.deepEqual(e.bounds(tail.id), [50, 52]);
  assert.deepEqual(await collect(e, tail.id), [
    [50, 4951],
    [51, 4952],
    [52, 4953],
  ]);
  const model = buildExplorer(e.project, s.id);
  const rows = explorerRows(model, revealEntry(model, tail.id));
  assert.equal(rows.length, 5004);
  assert.equal(rows.at(-1)!.step, 5001);
  assert.ok(
    rows.filter((row) => row.entry.node).every((row) => row.indent === 2),
  );
  assert.deepEqual(await collect(e, base.id), [
    [0, 1],
    [1, 2],
    [2, 3],
  ]);
  e.close();
  const reopened = new SignalEngine(undefined, name);
  await reopened.open();
  assert.equal(new SignalGraph(reopened.project).chain(tail.id).length, 5002);
  assert.deepEqual(await collect(reopened, tail.id), [
    [50, 4951],
    [51, 4952],
    [52, 4953],
  ]);
  reopened.close();
});
void test('graph validation rejects cycles and missing dependencies without recursion', async () => {
  const { engine: e, source: s } = await fixture();
  const raw = e.find(s.channels[0]);
  assert.throws(
    () =>
      new SignalGraph({
        ...e.project,
        nodes: [
          raw,
          { ...raw, id: 'cycle', parents: ['cycle'], operation: 'scale' },
        ],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      new SignalGraph({
        ...e.project,
        nodes: [
          raw,
          { ...raw, id: 'orphan', parents: ['absent'], operation: 'scale' },
        ],
      }),
    /missing/,
  );
  e.close();
});
void test('energy weighting is independent of binary output chunk boundaries', async () => {
  const lines = ['t,Speed [rpm],Torque [Nm],Fuel [kg/h]'];
  for (let i = 0; i < 18000; i++) lines.push(`${i},3000,100,${Math.PI * 2.5}`);
  const { engine: e, source: s } = await fixture(lines.join('\n'));
  const segments = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[100, 17000]], boundary: 'clip' },
    s.channels,
  );
  await e.calculateSegmentMetrics(segments.map((segment) => segment.id));
  const plot = await e.plot(e.project.nodes.at(-1)!.id);
  assert.equal(plot.summary.count, 16901);
  assert.ok(Math.abs(plot.summary.weightedMean! - 250) < 1e-8);
  e.close();
});

void test('file segments own synchronized channels while signal-only segments stay under originals', async () => {
  const {
    engine: e,
    source: s,
    name,
  } = await fixture(
    't,Speed [rpm],Torque [Nm]\n0,800,10\n1,1200,20\n2,1800,30\n3,800,10\n4,1200,20\n5,1800,30\n6,800,10\n7,1200,20\n8,1800,30\n9,800,10',
  );
  const definition: SegmentationDefinition = {
    method: 'ranges',
    boundary: 'clip',
    ranges: [
      [0, 2],
      [3, 5],
      [6, 9],
    ],
  };
  const originals = await Promise.all(s.channels.map((id) => collect(e, id)));
  const files = await e.segment(s.id, definition, s.channels, false, 'file');
  const singles = await e.segment(
    s.id,
    definition,
    [s.channels[0]],
    false,
    'signals',
  );
  assert.ok(
    files.every(
      (segment) => segment.scope === 'file' && segment.nodes.length === 2,
    ),
  );
  assert.ok(
    singles.every(
      (segment) => segment.scope === 'signals' && segment.nodes.length === 1,
    ),
  );
  const model = buildExplorer(e.project, s.id);
  assert.deepEqual(model.roots, [`file:${s.id}`]);
  const fileAction = model.entries.get(`file-operation:${files[0].batchId}`)!;
  assert.equal(fileAction.parent, `file:${s.id}`);
  assert.equal(fileAction.members.length, 3);
  for (const segment of files) {
    const container = model.entries.get(`file-segment:${segment.id}`)!;
    assert.equal(container.parent, fileAction.id);
    assert.deepEqual(container.members, segment.nodes);
    for (const [index, id] of segment.nodes.entries()) {
      assert.equal(model.entries.get(id)!.parent, container.id);
      assert.equal(
        model.entries.get(id)!.label,
        e.find(s.channels[index]).name,
      );
      assert.deepEqual(e.bounds(id), [segment.start, segment.end]);
      assert.equal(e.find(id).parents[0], s.channels[index]);
    }
  }
  const signalAction = model.entries.get(
    `segments:${s.channels[0]}:${singles[0].batchId}`,
  )!;
  assert.equal(signalAction.parent, s.channels[0]);
  assert.equal(model.entries.get(s.channels[0])!.parent, `originals:${s.id}`);
  const allRows = explorerRows(model, new Set(model.entries.keys()));
  const signalIds = allRows.flatMap((row) =>
    row.entry.node ? [row.entry.node.id] : [],
  );
  assert.equal(new Set(signalIds).size, e.project.nodes.length);
  assert.equal(
    signalIds.length,
    e.project.nodes.length,
    'No duplicated signal branches',
  );
  assert.deepEqual(
    await Promise.all(s.channels.map((id) => collect(e, id))),
    originals,
  );
  const filtered = await e.deriveMany(files[0].nodes, 'smooth', 2);
  const filteredModel = buildExplorer(e.project, s.id);
  const stage = filteredModel.entries.get(`operation:${filtered[0].batchId}`)!;
  assert.equal(stage.parent, `file-segment:${files[0].id}`);
  assert.equal(stage.memberUnit, 'signals');
  assert.equal(
    new Set(filtered.map((node) => filteredModel.entries.get(node.id)!.label))
      .size,
    2,
  );
  const deviation = await e.derive(filtered[0].id, 'offset', 1);
  assert.equal(
    buildExplorer(e.project, s.id).entries.get(deviation.id)!.parent,
    filtered[0].id,
  );
  e.close();
  const reopened = new SignalEngine(undefined, name);
  await reopened.open();
  assert.equal(reopened.project.segments[0].scope, 'file');
  assert.equal(reopened.project.segments[3].scope, 'signals');
  assert.deepEqual(
    buildExplorer(reopened.project, s.id).entries.get(fileAction.id)!.members,
    fileAction.members,
  );
  reopened.close();
});

void test('file scope requires every original channel and shared boundaries before publishing', async () => {
  const { engine: e, source: s } = await fixture('t,a,b\n0,1,2\n1,2,3\n2,3,4');
  const definition: SegmentationDefinition = {
    method: 'ranges',
    boundary: 'clip',
    ranges: [[0, 2]],
  };
  const before = e.project.nodes.length;
  await assert.rejects(
    e.segment(s.id, definition, [s.channels[0]], false, 'file'),
    /every original channel/,
  );
  await assert.rejects(
    e.previewSegments(s.id, definition, s.channels, true, 'file'),
    /shared boundaries/,
  );
  assert.equal(e.project.nodes.length, before);
  assert.equal(e.project.segments.length, 0);
  e.close();
});

void test('one-channel recordings retain explicit file versus signal scope and legacy file history', async () => {
  const { engine: e, source: s } = await fixture();
  const file = await e.segment(s.id, ranges, s.channels, false, 'file');
  const signal = await e.segment(s.id, ranges, s.channels, false, 'signals');
  let model = buildExplorer(e.project, s.id);
  assert.equal(
    model.entries.get(`file-operation:${file[0].batchId}`)!.members.length,
    3,
  );
  assert.equal(
    model.entries.get(`segments:${s.channels[0]}:${signal[0].batchId}`)!.members
      .length,
    3,
  );
  const legacy = structuredClone(e.project);
  legacy.segments.slice(0, 3).forEach((segment) => {
    delete segment.scope;
  });
  model = buildExplorer(legacy, s.id);
  assert.equal(
    model.entries.get(`file-operation:${file[0].batchId}`)!.members.length,
    3,
  );
  assert.ok(
    legacy.segments.slice(0, 3).every((segment) => !segment.scope),
    'Explorer must not rewrite saved recipes',
  );
  e.close();
});

void test('one Segment operation owns all generated file segments and reopens its exact settings', async () => {
  const { engine: e, source: s, name } = await fixture();
  const definition: SegmentationDefinition = {
    method: 'triggers',
    boundary: 'clip',
    minimumDuration: 0.25,
    start: {
      signalId: s.channels[0],
      edge: 'rising',
      threshold: 5,
      offset: -0.4,
    },
    end: {
      signalId: s.channels[0],
      edge: 'falling',
      threshold: 3,
      offset: 0.75,
    },
  };
  const segments = await e.segment(s.id, definition, s.channels, false, 'file');
  assert.equal(segments.length, 3);
  const model = buildExplorer(e.project, s.id);
  const operationRows = [...model.entries.values()].filter(
    (entry) => entry.segmentationId,
  );
  assert.equal(operationRows.length, 1);
  const entry = operationRows[0];
  assert.equal(entry.label, 'Segment');
  assert.equal(entry.members.length, 3);
  assert.ok(
    entry.members.every((id) => model.entries.get(id)!.kind === 'file-segment'),
  );
  assert.ok(
    !explorerRows(model, revealEntry(model, entry.id)).some(
      (row) => row.entry.kind === 'file-segment',
    ),
    'Selecting the operation does not toggle its outputs',
  );
  const expanded = revealEntry(model, entry.id).add(entry.id);
  assert.equal(
    explorerRows(model, expanded).filter(
      (row) => row.entry.kind === 'file-segment',
    ).length,
    3,
  );
  const saved = segmentationOperation(e.project, entry.segmentationId!);
  assert.deepEqual(saved.definition, definition);
  assert.deepEqual(saved.targetIds, s.channels);
  assert.deepEqual(
    saved.segmentIds,
    segments.map((segment) => segment.id),
  );
  const original = structuredClone(e.project);
  saved.definition!.boundary = 'discard';
  assert.deepEqual(
    e.project,
    original,
    'Opening and editing a settings snapshot must not mutate its operation',
  );
  await e.segment(
    s.id,
    saved.definition!,
    saved.targetIds,
    saved.independently,
    saved.scope,
  );
  assert.equal(e.project.segmentationOperations!.length, 2);
  assert.deepEqual(
    segmentationOperation(e.project, entry.segmentationId!).definition,
    definition,
  );
  e.close();
  const reopened = new SignalEngine(undefined, name);
  await reopened.open();
  assert.deepEqual(
    segmentationOperation(reopened.project, entry.segmentationId!).definition,
    definition,
  );
  reopened.close();
});

void test('saved operation settings retain manual ranges, windows and inputs that generated no outputs', async () => {
  const { engine: e, source: s } = await fixture();
  const segments = await e.segment(s.id, ranges, s.channels, false, 'signals');
  const targetIds = segments.map((segment) => segment.nodes[0]);
  const definition: SegmentationDefinition = {
    method: 'windows',
    boundary: 'clip',
    start: 4,
    end: 11,
    duration: 2,
    step: 1.5,
    includePartial: true,
  };
  const outputs = await e.segment(s.id, definition, targetIds, true, 'signals');
  const saved = segmentationOperation(e.project, outputs[0].batchId!);
  assert.deepEqual(saved.definition, definition);
  assert.deepEqual(
    saved.targetIds,
    targetIds,
    'Retain the original input set even when its first member yields no intervals',
  );
  assert.equal(saved.independently, true);
  assert.deepEqual(
    segmentationOperation(e.project, segments[0].batchId!).definition,
    ranges,
  );
  const legacy = structuredClone(e.project);
  delete legacy.segmentationOperations;
  assert.deepEqual(
    segmentationOperation(legacy, segments[0].batchId!).definition,
    ranges,
  );
  assert.deepEqual(
    segmentationOperation(legacy, segments[0].batchId!).targetIds,
    s.channels,
  );
  assert.equal(legacy.segmentationOperations, undefined);
  e.close();
});
