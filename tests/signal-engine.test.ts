import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { CsvParser, Envelope, bsfc, power } from '../lib/signal-math';

async function fixture(csv: string) {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  const s = await e.importCsv(new File([csv], 'test.csv'));
  return { e, s };
}
async function values(e: SignalEngine, id: string) {
  const output: number[] = [];
  for await (const c of e.evaluate(id)) output.push(...c.values);
  return output;
}

void test('CSV quoted records survive every possible character boundary', () => {
  const csv =
    '\uFEFFTime,"Signal, one","Signal ""two"""\r\n0,"3\n4",5\r\n1,6,7';
  const expected = new CsvParser().feed(csv, true);
  for (let split = 0; split <= csv.length; split++) {
    const p = new CsvParser();
    assert.deepEqual(
      [...p.feed(csv.slice(0, split)), ...p.feed(csv.slice(split), true)],
      expected,
    );
  }
  assert.throws(
    () => new CsvParser().feed('t,x\n0,"unclosed', true),
    /Unclosed/,
  );
});
void test('CSV rejects missing times and leaves no published source after failure', async () => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  await assert.rejects(
    e.importCsv(new File(['t,a,b\n0,1,2\n,,\n1,2,3'], 'invalid.csv')),
    /time must/,
  );
  assert.equal(e.project.sources.length, 0);
  e.close();
});
void test('power and BSFC use correct units and reject nonpositive power', () => {
  assert.ok(Math.abs(power(100, 3000) - Math.PI * 10) < 1e-10);
  assert.ok(Math.abs(bsfc(Math.PI * 2.5, Math.PI * 10) - 250) < 1e-10);
  assert.ok(Number.isNaN(bsfc(1, 0)));
  assert.ok(Number.isNaN(bsfc(-1, 10)));
});
void test('raw samples survive derivations and database reopening', async () => {
  const { e, s } = await fixture('t,a [Nm]\n0,1\n1,2\n2,3\n3,4');
  const raw = await values(e, s.channels[0]);
  const smooth = await e.derive(s.channels[0], 'smooth', 2);
  const scaled = await e.derive(smooth.id, 'scale', 10);
  assert.deepEqual(await values(e, scaled.id), [10, 15, 25, 35]);
  assert.deepEqual(await values(e, s.channels[0]), raw);
  assert.deepEqual(scaled.parents, [smooth.id]);
  e.close();
});
void test('integration uses timestamps and time shift preserves values', async () => {
  const { e, s } = await fixture('t,Fuel [kg/h]\n0,9\n30,9\n120,9');
  const p = await e.plot(s.channels[0]);
  assert.equal(p.summary.integral / 3600, 0.3);
  const shifted = await e.derive(s.channels[0], 'time-shift', -30);
  assert.deepEqual(e.bounds(shifted.id), [-30, 90]);
  assert.deepEqual(await values(e, shifted.id), [9, 9, 9]);
  e.close();
});
void test('energy-weighted BSFC excludes intervals with missing inputs', async () => {
  const { e, s } = await fixture(
    't,Speed [rpm],Torque [Nm],Fuel [kg/h]\n0,2000,100,2\n1,3000,100,\n2,4000,100,6\n3,5000,100,8',
  );
  const segments = await e.segment(s.channels[0], 1400, 1);
  const n = e.project.nodes.find(
    (n) => segments[0].nodes.includes(n.id) && n.operation === 'bsfc',
  )!;
  const p = await e.plot(n.id);
  assert.ok(
    Math.abs(
      p.summary.weightedMean! -
        7000 / ((power(100, 4000) + power(100, 5000)) / 2),
    ) < 1e-10,
  );
  e.close();
});
void test('resample interpolates and preserves exact endpoints beside missing samples', async () => {
  const { e, s } = await fixture('t,a\n0,0\n1,10');
  const n = await e.derive(s.channels[0], 'resample', 10);
  const output = await values(e, n.id);
  assert.equal(output.length, 11);
  output.forEach((v, i) => assert.ok(Math.abs(v - i) < 1e-10));
  e.close();
  const missing = await fixture('t,a\n0,1\n1,\n2,3\n3,4');
  const m = await missing.e.derive(missing.s.channels[0], 'resample', 1);
  assert.deepEqual(await values(missing.e, m.id), [1, NaN, 3, 4]);
  missing.e.close();
});
void test('non-advancing and excessive resample grids fail safely', async () => {
  const { e, s } = await fixture(
    't,a\n10000000000000000,1\n10000000000000002,2',
  );
  await assert.rejects(e.derive(s.channels[0], 'resample', 100), /Align/);
  e.close();
  const large = await fixture('t,a\n0,1\n1000000,2');
  await assert.rejects(
    large.e.derive(large.s.channels[0], 'resample', 1000),
    /100 million/,
  );
  large.e.close();
});
void test('three demo ramps create multi-input lineage and exclude idle tails', async () => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  const s = await e.demo();
  assert.equal(e.project.segments.length, 3);
  for (const seg of e.project.segments) {
    const speed = await values(e, seg.nodes[0]);
    assert.ok(speed.at(-1)! >= 1400);
    const f = e.project.nodes.find(
      (n) => seg.nodes.includes(n.id) && n.operation === 'bsfc',
    )!;
    const p = e.find(f.parents[1]);
    assert.equal(p.operation, 'power');
    assert.equal(p.parents.length, 2);
    const plot = await e.plot(f.id);
    assert.ok(plot.summary.mean > 200 && plot.summary.mean < 350);
  }
  assert.equal((await e.plot(s.channels[0])).summary.count, 18001);
  e.close();
});
void test('smoothing stays continuous across persisted chunk boundaries', async () => {
  const lines = ['t,a'];
  for (let i = 0; i < 16400; i++) lines.push(`${i},${i}`);
  const { e, s } = await fixture(lines.join('\n'));
  const smooth = await e.derive(s.channels[0], 'smooth', 3);
  const out = await values(e, smooth.id);
  assert.equal(out[16384], 16383);
  assert.equal(out.length, 16400);
  e.close();
});
void test('stale writers cannot overwrite another window’s imported source', async () => {
  const name = crypto.randomUUID();
  const a = new SignalEngine(undefined, name);
  await a.open();
  const source = await a.importCsv(new File(['t,a\n0,1\n1,2'], 'A.csv'));
  const b = new SignalEngine(undefined, name);
  await b.open();
  await a.importCsv(new File(['t,b\n0,3\n1,4'], 'B.csv'));
  await assert.rejects(
    b.derive(source.channels[0], 'scale', 2),
    /another window/,
  );
  a.close();
  b.close();
  const c = new SignalEngine(undefined, name);
  await c.open();
  assert.equal(c.project.sources.length, 2);
  c.close();
});
void test('cancellation never publishes a partial recording', async () => {
  const e = new SignalEngine(() => {
    e.cancelled = true;
  }, crypto.randomUUID());
  await e.open();
  await assert.rejects(
    e.importCsv(new File(['t,a\n0,1\n1,2'], 'cancel.csv')),
    /cancelled/,
  );
  assert.equal(e.project.sources.length, 0);
  e.close();
});
void test('envelope preserves narrow spikes, time order, and missing gaps', () => {
  const e = new Envelope(0, 100, 10);
  for (let i = 0; i <= 100; i++) e.add(i, i === 54 ? 999 : i === 30 ? NaN : 0);
  const result = e.finish();
  assert.ok(result.points.some((p) => p[1] === 999));
  assert.ok(result.points.some((p) => Number.isNaN(p[1])));
  for (let i = 1; i < result.points.length; i++)
    assert.ok(result.points[i][0] > result.points[i - 1][0]);
});
