import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { Envelope } from '../lib/signal-math';
import { measurePlot } from '../lib/plot-measurement';
import { chunkWindow } from '../lib/signal-range';
import type { Point, Summary } from '../lib/signal-types';

const rows = 300123;
const sample = (i: number, gaps = false): Point => [
  i / 100000 + (gaps && i >= 220000 ? 10 : 0),
  i === 262143
    ? -123
    : i === 262144
      ? 987
      : i % 97 === 0 || (i >= 16380 && i <= 16410)
        ? NaN
        : Number(Math.sin(i / 17).toFixed(6)),
];
async function fixture(t: TestContext, gaps = false) {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  t.after(() => engine.close());
  const parts = ['t,x [V]\n'];
  for (let start = 0; start < rows; start += 16384) {
    let csv = '';
    for (let i = start; i < Math.min(rows, start + 16384); i++) {
      const [time, value] = sample(i, gaps);
      csv += `${time},${Number.isFinite(value) ? value : ''}\n`;
    }
    parts.push(csv);
  }
  const source = await engine.importCsv(new File(parts, 'high-rate.csv'));
  return { engine, source, database, id: source.channels[0] };
}
function summaryEqual(actual: Summary, expected: Summary) {
  for (const key of ['count', 'min', 'max', 'start', 'end'] as const)
    assert.equal(actual[key], expected[key], key);
  for (const key of ['mean', 'integral'] as const) {
    if (!Number.isFinite(expected[key]))
      assert.equal(actual[key], expected[key]);
    else
      assert.ok(
        Math.abs(actual[key] - expected[key]) <
          1e-10 * Math.max(1, Math.abs(expected[key])),
        `${key}: ${actual[key]} vs ${expected[key]}`,
      );
  }
}
function expectedPlot(range: [number, number], gaps = false) {
  const envelope = new Envelope(...range);
  for (let i = 0; i < rows; i++) envelope.add(...sample(i, gaps));
  return envelope.finish();
}
async function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(
  db: IDBDatabase,
  edit: (store: IDBObjectStore) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    edit(tx.objectStore('chunks'));
  });
}

void test('100 kHz persisted overviews preserve extrema, gaps and exact sample summaries', async (t) => {
  const { engine, source, database, id } = await fixture(t, true);
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  await reopened.open();
  t.after(() => reopened.close());
  // Preserve the original method for restoration; invoke it with .call below.
  // oxlint-disable-next-line typescript/unbound-method
  const originalGet = IDBObjectStore.prototype.get;
  let rawReads = 0;
  IDBObjectStore.prototype.get = function (key) {
    if (
      this.name === 'chunks' &&
      Array.isArray(key) &&
      (key[2] === 'time' || typeof key[2] === 'number')
    )
      rawReads++;
    return originalGet.call(this, key);
  };
  try {
    const plot = await reopened.plot(id);
    summaryEqual(
      plot.summary,
      expectedPlot([source.start, source.end], true).summary,
    );
    assert.ok(rawReads <= 4, `Overview read ${rawReads} original columns`);
    assert.ok(plot.points.length <= 3500);
    assert.ok(
      plot.points.some(
        ([time, value]) => time === sample(262143, true)[0] && value === -123,
      ),
    );
    assert.ok(
      plot.points.some(
        ([time, value]) => time === sample(262144, true)[0] && value === 987,
      ),
    );
    assert.ok(plot.points.some(([, value]) => Number.isNaN(value)));
    for (const range of [
      [0.110123, 1.981234],
      [2.19, 12.21],
      [6, 7],
      [-2, 20],
    ] as [number, number][]) {
      const selected = await reopened.plot(id, range, true);
      summaryEqual(selected.summary, expectedPlot(range, true).summary);
      assert.ok(selected.points.length <= 3502);
      assert.ok(
        selected.points.every(
          (point, i) => !i || point[0] > selected.points[i - 1][0],
        ),
      );
    }
  } finally {
    IDBObjectStore.prototype.get = originalGet;
  }
});

void test('window reads and exact cursors cover chunk boundaries, missing samples and timestamp gaps', async (t) => {
  const { engine, source, id } = await fixture(t, true);
  for (const [a, b] of [
    [0.163835, 0.164105],
    [0.99, 1],
    [2.195, 12.205],
    [6, 7],
    [-1, 0.001],
    [20, 21],
    [1.234, 1.234],
  ] as [number, number][]) {
    const range: [number, number] = [Math.min(a, b), Math.max(a, b)];
    assert.deepEqual(
      await measurePlot(id, engine.evaluate(id, undefined, range), a, b),
      await measurePlot(id, engine.evaluate(id), a, b),
    );
    assert.deepEqual(
      await measurePlot(id, engine.evaluate(id, undefined, range), b, a),
      await measurePlot(id, engine.evaluate(id), b, a),
    );
  }
  let readSamples = 0;
  for await (const chunk of engine.evaluate(id, undefined, [0.999, 1.001]))
    readSamples += chunk.time.length;
  assert.ok(
    readSamples <= 3 * 16384,
    `Read ${readSamples} samples for a 2 ms window`,
  );
  assert.deepEqual(chunkWindow(source.chunkRanges, [6, 7]), [12, 15]);
});

void test('range propagation preserves stateless transforms, crop endpoints and full filter history', async (t) => {
  const { engine, source, id } = await fixture(t);
  const scale = await engine.derive(id, 'scale', -2);
  const shifted = await engine.derive(scale.id, 'time-shift', 10);
  const [crop] = await engine.segment(
    source.id,
    {
      method: 'ranges',
      boundary: 'clip',
      ranges: [[0.5, 2.5]],
    },
    [shifted.id],
  );
  const zero = await engine.derive(crop.nodes[0], 'zero-time', 0);
  const absolute = await engine.derive(zero.id, 'absolute', 0);
  for (const node of [scale, shifted, zero, absolute]) {
    const bounds = engine.bounds(node.id);
    const range: [number, number] = [
      (bounds[0] + bounds[1]) / 2,
      (bounds[0] + bounds[1]) / 2 + 0.01,
    ];
    const expected = await measurePlot(
      node.id,
      engine.evaluate(node.id),
      ...range,
    );
    let length = 0;
    for await (const chunk of engine.evaluate(node.id, undefined, range))
      length += chunk.time.length;
    assert.ok(length < 4 * 16384, node.operation);
    assert.deepEqual(
      await measurePlot(
        node.id,
        engine.evaluate(node.id, undefined, range),
        ...range,
      ),
      expected,
    );
  }
  for (const [operation, parameter] of [
    ['smooth', 101],
    ['median', 11],
    ['exponential', 0.1],
    ['low-pass', 100],
    ['high-pass', 100],
    ['derivative', 0],
    ['integral', 0],
  ] as const) {
    const derived = await engine.derive(id, operation, parameter);
    const range: [number, number] = [1.634, 1.65];
    assert.deepEqual(
      await measurePlot(
        derived.id,
        engine.evaluate(derived.id, undefined, range),
        ...range,
      ),
      await measurePlot(derived.id, engine.evaluate(derived.id), ...range),
      operation,
    );
    const full = new Envelope(...range);
    for await (const chunk of engine.evaluate(derived.id))
      for (let i = 0; i < chunk.time.length; i++)
        full.add(chunk.time[i], chunk.values[i]);
    summaryEqual(
      (await engine.plot(derived.id, range)).summary,
      full.finish().summary,
    );
  }
  const [aligned] = await engine.applyTimeOperation({
    kind: 'align',
    reference: { id: 'benchmark-clock', name: 'Aligned', kind: 'relative' },
    target: 10,
    secondTarget: 16,
    groups: [
      {
        inputIds: [id],
        anchor: { kind: 'point', time: 0 },
        secondAnchor: { kind: 'point', time: 3 },
      },
    ],
  });
  const range: [number, number] = [12, 12.01];
  assert.deepEqual(
    await measurePlot(
      aligned.id,
      engine.evaluate(aligned.id, undefined, range),
      ...range,
    ),
    await measurePlot(aligned.id, engine.evaluate(aligned.id), ...range),
  );
});

void test('missing indexes rebuild without journaling, survive Undo and stay out of backups', async (t) => {
  const { engine, source, id, database } = await fixture(t);
  const before = structuredClone(engine.project);
  const db = await openDatabase(database);
  t.after(() => db.close());
  await transaction(db, (store) => {
    store.delete([source.id, 0, 'plot-index-v1:0']);
    store.delete([source.id, 0, 'plot-leaves-v1:0']);
  });
  const expected = expectedPlot([source.start, source.end]);
  summaryEqual((await engine.plot(id)).summary, expected.summary);
  assert.deepEqual(engine.project, before);
  const archive = await (await engine.backupWorkspace()).text();
  assert.ok(
    !archive.includes('plot-index-v1:') && !archive.includes('plot-leaves-v1:'),
  );
  await engine.travel('undo');
  assert.equal(
    engine.project.sources.length,
    0,
    'Index rebuild must not add an undo step',
  );
  await engine.travel('redo');
  summaryEqual((await engine.plot(id)).summary, expected.summary);
  await transaction(db, (store) =>
    store.delete([source.id, 0, 'plot-leaves-v1:0']),
  );
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  await reopened.open();
  t.after(() => reopened.close());
  summaryEqual((await reopened.plot(id)).summary, expected.summary);
  summaryEqual(
    (await reopened.plot(id, [0.001, 2.5])).summary,
    expectedPlot([0.001, 2.5]).summary,
  );
});

void test('cancelled index recovery leaves samples and history intact', async (t) => {
  const { engine, source, id, database } = await fixture(t);
  const db = await openDatabase(database);
  t.after(() => db.close());
  await transaction(db, (store) =>
    store.delete([source.id, 0, 'plot-index-v1:0']),
  );
  const before = structuredClone(engine.project);
  const timer = setTimeout(() => {
    engine.cancelled = true;
  }, 2);
  try {
    await assert.rejects(engine.plot(id), /cancelled/);
  } finally {
    clearTimeout(timer);
    engine.cancelled = false;
  }
  assert.deepEqual(engine.project, before);
  summaryEqual(
    (await engine.plot(id)).summary,
    expectedPlot([source.start, source.end]).summary,
  );
});
