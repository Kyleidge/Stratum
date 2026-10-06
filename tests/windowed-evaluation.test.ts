import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { Envelope } from '../lib/signal-math';
import { SignalGraph } from '../lib/signal-graph';
import { recipeKey } from '../lib/signal-recipe';
import { WorkflowIndex } from '../lib/workflow-history';
import type { Summary } from '../lib/signal-types';

const rows = 300123;
// 100 kHz with missing samples, a 10 s timestamp gap and two channels.
function sample(i: number): [number, number, number] {
  return [
    i / 100000 + (i >= 220000 ? 10 : 0),
    i % 97 === 0 || (i >= 16380 && i <= 16410)
      ? NaN
      : Number((Math.sin(i / 17) + (i % 5000 === 0 ? 4 : 0)).toFixed(6)),
    i % 89 === 0 ? NaN : Number(Math.cos(i / 29).toFixed(6)),
  ];
}
async function fixture(t: TestContext) {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  t.after(() => engine.close());
  const parts = ['t,x [V],y [V]\n'];
  for (let start = 0; start < rows; start += 16384) {
    let csv = '';
    for (let i = start; i < Math.min(rows, start + 16384); i++) {
      const [time, x, y] = sample(i);
      csv += `${time},${Number.isFinite(x) ? x : ''},${Number.isFinite(y) ? y : ''}\n`;
    }
    parts.push(csv);
  }
  const source = await engine.importCsv(new File(parts, 'windowed.csv'));
  return { engine, source, database };
}
type Samples = { time: number[]; values: number[] };
async function collect(
  stream: AsyncGenerator<{ time: Float64Array; values: Float64Array }>,
): Promise<Samples> {
  const out: Samples = { time: [], values: [] };
  for await (const chunk of stream)
    for (let i = 0; i < chunk.time.length; i++) {
      out.time.push(chunk.time[i]);
      out.values.push(chunk.values[i]);
    }
  return out;
}
const same = (a: number, b: number) =>
  a === b || (Number.isNaN(a) && Number.isNaN(b));
/** A window is an exact contiguous run covering [a, b] and both neighbors. */
function assertWindow(
  full: Samples,
  run: Samples,
  [a, b]: [number, number],
  label: string,
) {
  const n = full.time.length;
  let first = full.time.findIndex((time) => time >= a);
  if (first < 0) first = n;
  let last = n - 1;
  while (last >= 0 && full.time[last] > b) last--;
  const from = Math.max(0, first - 1),
    to = Math.min(n - 1, last + 1);
  if (to < from) return;
  const start = full.time.indexOf(run.time[0]);
  assert.ok(start >= 0, `${label}: run starts at a sample of the signal`);
  assert.ok(start <= from, `${label}: run begins after the window`);
  assert.ok(
    start + run.time.length - 1 >= to,
    `${label}: run ends before the window`,
  );
  for (let k = 0; k < run.time.length; k++)
    if (
      run.time[k] !== full.time[start + k] ||
      !same(run.values[k], full.values[start + k])
    )
      assert.fail(
        `${label}: sample ${start + k} differs: ${run.time[k]}, ${run.values[k]} vs ${full.time[start + k]}, ${full.values[start + k]}`,
      );
}
function summaryEqual(actual: Summary, expected: Summary, label: string) {
  for (const key of ['count', 'min', 'max', 'start', 'end'] as const)
    assert.ok(same(actual[key], expected[key]), `${label} ${key}`);
  for (const key of ['mean', 'integral'] as const)
    assert.ok(
      same(actual[key], expected[key]) ||
        Math.abs(actual[key] - expected[key]) <
          1e-9 * Math.max(1, Math.abs(expected[key])),
      `${label} ${key}: ${actual[key]} vs ${expected[key]}`,
    );
}

const windows: [number, number][] = [
  [-1, 0.0001],
  [0.0001, 0.0002],
  [0.16383, 0.16385],
  [0.3, 0.30001],
  [0.5, 0.5],
  [1.23456, 1.3],
  [1.5, 1.6],
  [2.1999, 12.2001],
  [5, 6],
  [12.2, 12.3],
  [12.9, 30],
  [0.4, 12.5],
];
for (let k = 0; k < 8; k++) {
  const start = ((k * 7919) % 2900) / 1000;
  windows.push([start + (start > 2.2 ? 10 : 0), start + 0.003 * (k + 1)]);
}

async function derivedSet(engine: SignalEngine, x: string, y: string) {
  const derive = async (
    id: string,
    op: Parameters<SignalEngine['derive']>[1],
    value: number,
  ) => (await engine.derive(id, op, value)).id;
  const ids: Record<string, string> = {
    'smooth 101': await derive(x, 'smooth', 101),
    'smooth 20000': await derive(x, 'smooth', 20000),
    'median 11': await derive(x, 'median', 11),
    'median 1001': await derive(x, 'median', 1001),
    exponential: await derive(x, 'exponential', 0.05),
    'low-pass': await derive(x, 'low-pass', 200),
    'high-pass': await derive(x, 'high-pass', 50),
    derivative: await derive(x, 'derivative', 0),
    integral: await derive(x, 'integral', 0),
    'resample 9 kHz': await derive(x, 'resample', 9000),
    'resample 7 Hz': await derive(x, 'resample', 7),
  };
  ids['low-pass of smooth'] = await derive(ids['smooth 101'], 'low-pass', 500);
  ids['derivative of median'] = await derive(ids['median 11'], 'derivative', 0);
  ids['integral of shift'] = await derive(
    await derive(x, 'time-shift', 0.5),
    'integral',
    0,
  );
  ids['scaled exponential'] = await derive(ids.exponential, 'scale', -3);
  const product = await engine.applyRegionFunction({
    sourceId: engine.find(x).sourceId,
    operation: 'multiply',
    parameter: 0,
    inputIds: [ids['smooth 101']],
    secondaryIds: [y],
  });
  ids['smooth × y'] = product.outputs[0].signalId;
  const [combined] = await engine.applyTimeOperation({
    kind: 'combine',
    inputIds: [ids['high-pass'], ids['median 11']],
    operator: 'difference',
  });
  ids['high-pass − median'] = combined.id;
  const [grid] = await engine.applyTimeOperation({
    kind: 'resample',
    inputIds: [ids['low-pass']],
    grid: { kind: 'uniform', start: 0, end: 13, rate: 7000 },
    interpolation: 'linear',
    maxGap: 0.001,
  });
  ids['uniform grid'] = grid.id;
  return ids;
}

void test('windowed derived evaluation matches a complete pass sample for sample', async (t) => {
  const { engine, source, database } = await fixture(t);
  const [x, y] = source.channels;
  const ids = await derivedSet(engine, x, y);
  // Before any complete pass: look-back windows, and checkpointed filters
  // evaluated from the first sample but stopping after the window.
  const early = new Map<string, Samples[]>();
  for (const [label, id] of Object.entries(ids))
    early.set(
      label,
      await Promise.all(
        windows.map((range) => collect(engine.evaluate(id, undefined, range))),
      ),
    );
  const fulls = new Map<string, Samples>();
  for (const [label, id] of Object.entries(ids)) {
    const full = await collect(engine.evaluate(id));
    assert.ok(full.time.length > 0, label);
    fulls.set(label, full);
    early
      .get(label)!
      .forEach((run, k) =>
        assertWindow(
          full,
          run,
          windows[k],
          `${label} ${windows[k].join('–')} first`,
        ),
      );
  }
  // The complete passes recorded checkpoints: windows now resume from them,
  // including in a reopened engine that loads them from storage.
  const reopened = new SignalEngine(undefined, database);
  await reopened.open();
  t.after(() => reopened.close());
  for (const instance of [engine, reopened])
    for (const [label, id] of Object.entries(ids))
      for (const range of windows)
        assertWindow(
          fulls.get(label)!,
          await collect(instance.evaluate(id, undefined, range)),
          range,
          `${label} ${range.join('–')} resumed`,
        );
});

void test('resumed windows read only nearby samples', async (t) => {
  const { engine, source } = await fixture(t);
  const [x] = source.channels;
  const low = (await engine.derive(x, 'low-pass', 200)).id;
  const smooth = (await engine.derive(low, 'smooth', 101)).id;
  await collect(engine.evaluate(smooth));
  let read = 0;
  for await (const chunk of engine.evaluate(smooth, undefined, [2.9, 2.901]))
    read += chunk.time.length;
  assert.ok(read <= 4 * 16384, `Read ${read} samples for a 1 ms window`);
});

void test('derived plot indexes match exact envelopes and follow recipe edits', async (t) => {
  const { engine, source, database } = await fixture(t);
  const [x, y] = source.channels;
  const ids = await derivedSet(engine, x, y);
  for (const [label, id] of Object.entries(ids)) {
    const full = await collect(engine.evaluate(id));
    const expected = (range: [number, number]) => {
      const envelope = new Envelope(...range);
      full.time.forEach((time, i) => envelope.add(time, full.values[i]));
      return envelope.finish();
    };
    const extent: [number, number] = [full.time[0], full.time.at(-1)!];
    summaryEqual(
      (await engine.plot(id)).summary,
      expected(extent).summary,
      label,
    );
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    // The stored index draws the overview: no full pass over the samples.
    // oxlint-disable-next-line typescript/unbound-method
    const originalGet = IDBObjectStore.prototype.get;
    let rawReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (
        Array.isArray(key) &&
        (key[2] === 'time' || typeof key[2] === 'number')
      )
        rawReads++;
      return originalGet.call(this, key);
    };
    try {
      summaryEqual(
        (await reopened.plot(id, extent, true)).summary,
        expected(extent).summary,
        `${label} indexed overview`,
      );
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }
    // Outputs shorter than 700 leaves are drawn exactly instead of indexed.
    if (full.time.length >= 256 * 700)
      assert.ok(rawReads <= 24, `${label}: overview read ${rawReads} columns`);
    for (const range of [
      [0.110123, 1.981234],
      [2.19, 12.21],
      [0.3, 0.31],
      [-2, 20],
      [12.5, 12.5004],
    ] as [number, number][]) {
      const plot = await reopened.plot(id, range, true);
      summaryEqual(
        plot.summary,
        expected(range).summary,
        `${label} ${range.join('–')}`,
      );
      assert.ok(plot.points.length <= 3502, label);
      assert.ok(
        plot.points.every((point, i) => !i || point[0] > plot.points[i - 1][0]),
        `${label}: plot points are ordered`,
      );
    }
    reopened.close();
  }
  // An edited recipe has a new key, so it never reads the old index.
  const graph = new SignalGraph(engine.project);
  const before = recipeKey(graph, ids['smooth 101']);
  const twin = (await engine.derive(x, 'smooth', 101)).id;
  const other = (await engine.derive(x, 'smooth', 103)).id;
  const otherLow = (await engine.derive(other, 'low-pass', 500)).id;
  const after = new SignalGraph(engine.project);
  assert.equal(recipeKey(after, twin), before, 'identical recipes share a key');
  assert.notEqual(recipeKey(after, other), before);
  assert.notEqual(
    recipeKey(after, ids['low-pass of smooth']),
    recipeKey(after, otherLow),
    'a changed input changes every dependent key',
  );
});

void test('stale derived indexes are pruned; live and Undo ones are kept', async (t) => {
  const { engine, source, database } = await fixture(t);
  await engine.initializeWorkflow();
  const [x] = source.channels;
  const kept = (await engine.derive(x, 'smooth', 101)).id;
  await engine.plot(kept);
  const removed = (await engine.derive(x, 'low-pass', 200)).id;
  await engine.plot(removed);
  const owners = async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db
        .transaction('chunks')
        .objectStore('chunks')
        .getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return new Set(
      keys
        .map((key) => String((key as unknown[])[0]))
        .filter((owner) => owner.startsWith('derived-v1:')),
    );
  };
  assert.equal((await owners()).size, 2);
  // Deleting the step keeps its artifacts while Undo can restore it.
  const step = new WorkflowIndex(engine.project).owner.get(removed)!;
  await engine.deleteOperation(step.id);
  await engine.pruneDerivedIndexes();
  assert.equal((await owners()).size, 2);
  const archive = await (await engine.backupWorkspace()).text();
  assert.ok(
    !archive.includes('derived-v1:'),
    'derived indexes stay out of backups',
  );
  // A restored project without those Undo entries prunes them.
  const reopened = new SignalEngine(undefined, database);
  await reopened.open();
  t.after(() => reopened.close());
  (reopened as unknown as { undoStack: unknown[] }).undoStack = [];
  await reopened.pruneDerivedIndexes();
  const live = await owners();
  assert.equal(live.size, 1);
  assert.ok(
    live.has(
      `derived-v1:${recipeKey(new SignalGraph(reopened.project), kept)}`,
    ),
  );
  const plot = await reopened.plot(kept);
  assert.ok(plot.summary.count > 0);
});
