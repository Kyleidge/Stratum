import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { regionHistory, regionContains } from '../lib/region-model';
import { REGION_EXAMPLES } from '../lib/region-types';
import type { RegionSettings, RegionSet } from '../lib/region-types';
import type { Point, Project } from '../lib/signal-types';

async function fixture() {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  const source = await engine.importCsv(
    new File(
      [
        't,Torque [Nm],Speed [rpm],Fuel [kg/h]\n' +
          Array.from(
            { length: 21 },
            (_, i) =>
              `${70 + i},${i},${i % 10 >= 2 && i % 10 < 7 ? 2000 : 500},10`,
          ).join('\n'),
      ],
      'regions.csv',
    ),
  );
  return { engine, source, database };
}
async function collect(engine: SignalEngine, id: string): Promise<Point[]> {
  const points: Point[] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      points.push([chunk.time[i], chunk.values[i]]);
  return points;
}
const rangeSettings = (
  sourceId: string,
  ranges: [number, number][],
): RegionSettings => ({
  sourceId,
  name: 'Regions',
  timeReference: 'recording',
  definition: { method: 'ranges', boundary: 'clip', ranges },
});

void test('region creation stores pointers only; revisions pin children and calculations to prior intervals', async () => {
  const { engine, source, database } = await fixture();
  try {
    const original = structuredClone(engine.project.nodes);
    const set = await engine.createRegions(
      rangeSettings(source.id, [
        [70, 80],
        [80, 90],
      ]),
    );
    assert.deepEqual(engine.project.nodes, original);
    assert.equal(engine.project.segments.length, 0);
    assert.deepEqual(
      set.regions.map((r) => r.endInclusive),
      [false, true],
    );
    const child = await engine.createRegions({
      ...rangeSettings(source.id, [[2, 4]]),
      parentSetId: set.id,
      timeReference: 'parent',
    });
    assert.deepEqual(
      child.regions.map((r) => [r.start, r.end]),
      [
        [72, 74],
        [82, 84],
      ],
    );
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 2,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    const revised = await engine.createRegions({
      ...rangeSettings(source.id, [[71, 79]]),
      name: 'Renamed',
      previousId: set.id,
    });
    assert.equal(revised.version, 2);
    assert.equal(child.parentSetId, set.id);
    assert.equal(run.regionSetId, set.id);
    assert.deepEqual(
      set.regions.map((r) => [r.start, r.end]),
      [
        [70, 80],
        [80, 90],
      ],
    );
    assert.equal(regionHistory(engine.project, source.id).length, 4);
    const snapshot = structuredClone(engine.project);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    await reopened.initializeRegions();
    assert.deepEqual(reopened.project, snapshot);
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('nested windows handle one/all parents, overlap, clipping, partial tails and parent-relative time', async () => {
  const { engine, source } = await fixture();
  try {
    const parent = await engine.createRegions(
      rangeSettings(source.id, [
        [70, 77],
        [80, 90],
      ]),
    );
    const settings: RegionSettings = {
      sourceId: source.id,
      name: 'Windows',
      parentSetId: parent.id,
      timeReference: 'parent',
      definition: {
        method: 'windows',
        boundary: 'clip',
        start: 0,
        end: 20,
        duration: 4,
        step: 4,
        includePartial: true,
      },
    };
    assert.deepEqual(
      (await engine.previewRegions(settings)).regions.map((r) => [
        r.start,
        r.end,
      ]),
      [
        [70, 74],
        [74, 77],
        [80, 84],
        [84, 88],
        [88, 90],
      ],
    );
    const noTail = structuredClone(settings);
    if (noTail.definition.method === 'windows')
      noTail.definition.includePartial = false;
    assert.deepEqual(
      (await engine.previewRegions(noTail)).regions.map((r) => [
        r.start,
        r.end,
      ]),
      [
        [70, 74],
        [80, 84],
        [84, 88],
      ],
    );
    const one = await engine.createRegions({
      ...settings,
      parentRegionIds: [parent.regions[1].id],
      definition: {
        method: 'windows',
        boundary: 'clip',
        start: 0,
        end: 10,
        duration: 4,
        step: 2,
        includePartial: true,
      },
    });
    assert.equal(one.regions.length, 5);
    assert.ok(
      one.regions.every((r) => r.parentRegionId === parent.regions[1].id),
    );
    const clipping = {
      ...rangeSettings(source.id, [[-2, 4]]),
      parentSetId: parent.id,
      timeReference: 'parent' as const,
    };
    assert.deepEqual(
      (await engine.previewRegions(clipping)).regions.map((r) => [
        r.start,
        r.end,
      ]),
      [
        [70, 74],
        [80, 84],
      ],
    );
    assert.equal(
      (
        await engine.previewRegions({
          ...clipping,
          definition: {
            method: 'ranges',
            boundary: 'discard',
            ranges: [[-2, 4]],
          },
        })
      ).regions.length,
      0,
    );
  } finally {
    engine.close();
  }
});

void test('trigger scans never pair across parents or synthesize a start already active at the parent boundary', async () => {
  const { engine, source } = await fixture();
  try {
    const settings: RegionSettings = {
      sourceId: source.id,
      name: 'Triggers',
      timeReference: 'recording',
      definition: {
        method: 'triggers',
        boundary: 'clip',
        minimumDuration: 0,
        start: {
          signalId: source.channels[1],
          edge: 'rising',
          threshold: 1250,
          offset: 0,
        },
        end: {
          signalId: source.channels[1],
          edge: 'falling',
          threshold: 1250,
          offset: 0,
        },
      },
    };
    const full = await engine.previewRegions(settings);
    assert.deepEqual(
      full.regions.map((r) => [r.start, r.end]),
      [
        [71.5, 76.5],
        [81.5, 86.5],
      ],
    );
    const parents = await engine.createRegions(
      rangeSettings(source.id, [
        [70, 75],
        [75, 80],
        [80, 90],
      ]),
    );
    const nested = await engine.previewRegions({
      ...settings,
      parentSetId: parents.id,
    });
    assert.deepEqual(
      nested.regions.map((r) => [r.start, r.end]),
      [[81.5, 86.5]],
    );
    assert.equal(nested.incomplete, 1);
    const offset = structuredClone(settings);
    if (offset.definition.method === 'triggers')
      offset.definition.start.offset = -20;
    const clipped = await engine.previewRegions({
      ...offset,
      parentSetId: parents.id,
    });
    assert.deepEqual(
      clipped.regions.map((r) => [r.start, r.end]),
      [[80, 86.5]],
    );
    assert.equal(clipped.regions[0].boundary?.clipped, true);
  } finally {
    engine.close();
  }
});

void test('adjacent regions do not duplicate boundary samples; new filters reset but filtered inputs preserve earlier history', async () => {
  const { engine, source } = await fixture();
  try {
    const set = await engine.createRegions(
      rangeSettings(source.id, [
        [70, 80],
        [80, 90],
      ]),
    );
    const smooth = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'smooth',
      parameter: 3,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    const a = await collect(engine, smooth.outputs[0].signalId),
      b = await collect(engine, smooth.outputs[1].signalId);
    assert.deepEqual(
      a.map((p) => p[0]),
      Array.from({ length: 10 }, (_, i) => 70 + i),
    );
    assert.deepEqual(
      b.map((p) => p[0]),
      Array.from({ length: 11 }, (_, i) => 80 + i),
    );
    assert.deepEqual(b[0], [80, 10]);
    const full = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'smooth',
      parameter: 3,
      inputIds: [source.channels[0]],
    });
    const view = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 1,
      inputIds: [full.outputs[0].signalId],
      regionSetId: set.id,
    });
    assert.deepEqual(
      (await collect(engine, view.outputs[1].signalId))[0],
      [80, 9],
    );
    const minmax = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'min-max',
      parameter: 0,
      inputIds: smooth.outputs.map((o) => o.signalId),
    });
    assert.equal(minmax.outputs.length, 2);
    assert.deepEqual(await collect(engine, minmax.outputs[1].signalId), [
      [80, 10],
      [90, 19],
    ]);
    assert.equal(regionHistory(engine.project, source.id).length, 5);
    assert.deepEqual(
      (await collect(engine, source.channels[0])).map((p) => p[1]),
      Array.from({ length: 21 }, (_, i) => i),
    );
  } finally {
    engine.close();
  }
});

void test('child scope maps each result family member to its own descendants and retains transformed clocks', async () => {
  const { engine, source } = await fixture();
  try {
    const set = await engine.createRegions(
      rangeSettings(source.id, [
        [70, 80],
        [80, 90],
      ]),
    );
    const parent = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'zero-time',
      parameter: 0,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    const children = await engine.createRegions({
      ...rangeSettings(source.id, [
        [2, 5],
        [5, 7],
      ]),
      parentSetId: set.id,
      timeReference: 'parent',
    });
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'offset',
      parameter: 100,
      inputIds: parent.outputs.map((o) => o.signalId),
      regionSetId: children.id,
    });
    assert.equal(
      run.outputs.length,
      4,
      'Do not multiply every child by every parent signal',
    );
    assert.deepEqual(await collect(engine, run.outputs[2].signalId), [
      [2, 112],
      [3, 113],
      [4, 114],
    ]);
    assert.ok(
      run.outputs.every((o) =>
        regionContains(
          engine.project,
          parent.outputs.find((p) => p.signalId === o.inputId)!.regionId!,
          o.regionId!,
        ),
      ),
    );
    const inherited = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'absolute',
      parameter: 0,
      inputIds: run.outputs.map((o) => o.signalId),
    });
    assert.deepEqual(
      inherited.outputs.map((o) => o.regionId),
      run.outputs.map((o) => o.regionId),
    );
  } finally {
    engine.close();
  }
});

void test('empty scopes and invalid functions are atomic and leave no orphan internal views', async () => {
  const { engine, source } = await fixture();
  try {
    const set = await engine.createRegions(
      rangeSettings(source.id, [
        [70.1, 71],
        [72, 74],
      ]),
    );
    const count = engine.project.nodes.length;
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 1,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    assert.equal(run.skipped, 1);
    assert.equal(run.outputs.length, 1);
    assert.equal(engine.project.nodes.length, count + 2);
    const csv = await (
      await engine.exportSummary(run.outputs.map((output) => output.signalId))
    ).text();
    assert.match(csv, /Region set,Region version,Region,Start \(s\),End \(s\)/);
    assert.ok(csv.includes('"Regions",1,"Regions 02",72,74,false'));
    const snapshot = structuredClone(engine.project);
    await assert.rejects(
      engine.applyRegionFunction({
        sourceId: source.id,
        operation: 'smooth',
        parameter: -1,
        inputIds: [source.channels[0]],
        regionSetId: set.id,
      }),
    );
    await assert.rejects(
      engine.applyRegionFunction({
        sourceId: source.id,
        operation: 'power',
        parameter: 0,
        inputIds: [source.channels[2]],
        secondaryIds: [source.channels[1]],
        regionSetId: set.id,
      }),
      /torque/,
    );
    engine.cancelled = true;
    await assert.rejects(
      engine.createRegions(rangeSettings(source.id, [[70, 75]])),
      /cancelled/,
    );
    engine.cancelled = false;
    assert.deepEqual(engine.project, snapshot);
  } finally {
    engine.close();
  }
});

void test('every region example evaluates, reopens without duplicates, and preserves complete settings', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  try {
    for (const example of REGION_EXAMPLES) {
      const saved = await engine.regionExample(example.key);
      const set = engine.project.regionSets!.find(
        (s) => s.id === saved.regionSetId,
      )!;
      const run = engine.project.functionRuns!.find(
        (r) => r.id === saved.runId,
      )!;
      assert.ok(set.regions.length > 0);
      assert.equal(run.outputs.length, set.regions.length);
      for (const output of run.outputs) {
        const plot = await engine.plot(output.signalId);
        assert.ok(Number.isFinite(plot.summary.min), example.key);
        if (example.key === 'fuel')
          assert.ok(Number.isFinite(plot.summary.weightedMean));
      }
      const snapshot = structuredClone(engine.project);
      await engine.regionExample(example.key);
      await engine.initializeRegions();
      assert.deepEqual(engine.project, snapshot);
    }
  } finally {
    engine.close();
  }
});

void test('legacy migration retains numerical outputs and complete binary inputs', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  try {
    await engine.demo();
    const original = structuredClone(engine.project.nodes);
    await engine.initializeRegions();
    assert.deepEqual(engine.project.nodes, original);
    const run = engine.project.functionRuns!.find(
      (r) => r.operation === 'bsfc',
    )!;
    assert.ok(run.secondaryIds?.length);
    const recreated = await engine.applyRegionFunction(run);
    assert.deepEqual(
      (await engine.plot(recreated.outputs[0].signalId)).summary,
      (await engine.plot(run.outputs[0].signalId)).summary,
    );
  } finally {
    engine.close();
  }
});

void test('region ancestry remains iterative at 5000 levels', () => {
  const regionSets: RegionSet[] = Array.from({ length: 5000 }, (_, i) => ({
    ...rangeSettings('source', [[0, 1]]),
    id: `set${i}`,
    version: 1,
    sequence: i,
    createdAt: '',
    parentSetId: i ? `set${i - 1}` : undefined,
    regions: [
      {
        id: `r${i}`,
        name: `r${i}`,
        start: 0,
        end: 1,
        endInclusive: true,
        parentRegionId: i ? `r${i - 1}` : undefined,
      },
    ],
  }));
  const project: Project = { sources: [], nodes: [], segments: [], regionSets };
  assert.equal(regionContains(project, 'r0', 'r4999'), true);
  assert.equal(regionHistory(project, 'source').length, 5000);
});
