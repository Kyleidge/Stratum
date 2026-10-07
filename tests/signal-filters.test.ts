import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import {
  ButterworthFilter,
  belowNyquist,
  butterworth,
  ExponentialSmoother,
  RcFilter,
  RollingMedian,
} from '../lib/signal-filters';
import type { Operation, Point, SignalNode } from '../lib/signal-types';

const cutoff = 1 / (2 * Math.PI); // RC time constant of one second.
const filters = [
  ['median', 3],
  ['exponential', 0.5],
  ['low-pass', cutoff],
  ['high-pass', cutoff],
] as const;

async function fixture(csv: string) {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  const source = await engine.importCsv(new File([csv], 'filters.csv'));
  return { engine, source, database };
}

async function samples(engine: SignalEngine, id: string): Promise<Point[]> {
  const output: Point[] = [];
  for await (const chunk of engine.evaluate(id)) {
    for (let i = 0; i < chunk.time.length; i++)
      output.push([chunk.time[i], chunk.values[i]]);
  }
  return output;
}

function closeTo(actual: number, expected: number) {
  if (Number.isNaN(expected)) assert.ok(Number.isNaN(actual));
  else
    assert.ok(
      Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
      `Expected ${expected}, received ${actual}`,
    );
}

void test('median rejects isolated spikes and handles partial and empty windows', () => {
  const median = new RollingMedian(3);
  assert.deepEqual(
    [1, 1, 100, 1, NaN, NaN, NaN, 9].map((value) => median.next(value)),
    [1, 1, 1, 1, 50.5, 1, NaN, 9],
  );
  const identity = new RollingMedian(1);
  assert.deepEqual(
    [NaN, 3, NaN, -4].map((value) => identity.next(value)),
    [NaN, 3, NaN, -4],
  );
  const large = new RollingMedian(2);
  large.next(Number.MAX_VALUE);
  assert.equal(large.next(Number.MAX_VALUE), Number.MAX_VALUE);
  const tiny = new RollingMedian(2);
  tiny.next(Number.MIN_VALUE);
  assert.equal(tiny.next(Number.MIN_VALUE), Number.MIN_VALUE);
  assert.equal(tiny.next(2 * Number.MIN_VALUE), 2 * Number.MIN_VALUE);
});

void test('median evicts duplicates and missing positions from odd and even windows', () => {
  const input = Array.from({ length: 1100 }, (_, i) =>
    i % 7 === 0 ? NaN : ((i * 19) % 11) - 5,
  );
  for (const size of [2, 5, 1001]) {
    const median = new RollingMedian(size);
    input.forEach((value, i) => {
      const window = input
        .slice(Math.max(0, i + 1 - size), i + 1)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const middle = Math.floor(window.length / 2);
      const expected = !window.length
        ? NaN
        : window.length % 2
          ? window[middle]
          : (window[middle - 1] + window[middle]) / 2;
      closeTo(median.next(value), expected);
    });
  }
});

void test('exponential smoothing uses alpha and restarts at explicit gaps', () => {
  const smoother = new ExponentialSmoother(0.5);
  assert.deepEqual(
    [0, 10, 10, NaN, 8, 0].map((value) => smoother.next(value)),
    [0, 5, 7.5, NaN, 8, 4],
  );
  const identity = new ExponentialSmoother(1);
  assert.deepEqual(
    [1, -3, NaN, 5].map((value) => identity.next(value)),
    [1, -3, NaN, 5],
  );
});

void test('RC filters use actual intervals and restart after gaps', () => {
  const time = [0, 1, 3, 4, 5, 6];
  const input = [0, 10, 10, NaN, 7, 7];
  for (const [mode, expected] of [
    ['low-pass', [0, 5, 25 / 3, NaN, 7, 7]],
    ['high-pass', [0, 5, 5 / 3, NaN, 0, 0]],
  ] as const) {
    const filter = new RcFilter(cutoff, mode);
    input.forEach((value, i) =>
      closeTo(filter.next(time[i], value), expected[i]),
    );
    const constant = new RcFilter(cutoff, mode);
    [0, 0.1, 2, 20].forEach((t) =>
      closeTo(constant.next(t, 42), mode === 'low-pass' ? 42 : 0),
    );
  }
});

void test('high-pass retains decaying AC state on a large DC offset', () => {
  const filter = new RcFilter(cutoff, 'high-pass');
  assert.deepEqual(
    [1e16, 1e16 + 2, 1e16 + 2, 1e16 + 2].map((value, i) =>
      filter.next(i, value),
    ),
    [0, 1, 0.5, 0.25],
  );
  const large = new RcFilter(1 / (6 * Math.PI), 'high-pass');
  const expected = [0, 1.5e308, 1.125e308];
  [-1e308, 1e308, 1e308].forEach((value, i) =>
    closeTo(large.next(i, value), expected[i]),
  );
  const alternating = new RcFilter(1 / (198 * Math.PI), 'high-pass');
  const alternatingExpected = [0, -1.6929e308, 1.25829e307];
  [8e307, -9.1e307, 9.1e307].forEach((value, i) =>
    closeTo(alternating.next(i, value), alternatingExpected[i]),
  );
});

void test('new filters preserve raw samples, axes, units and saved provenance', async (t) => {
  const { engine, source, database } = await fixture(
    't,Torque [Nm]\n100,0\n101,10\n103,10\n104,\n105,7',
  );
  t.after(() => engine.close());
  const raw = await samples(engine, source.channels[0]);
  const results: { node: SignalNode; points: Point[] }[] = [];
  for (const [operation, parameter] of filters) {
    const node = await engine.derive(source.channels[0], operation, parameter);
    const points = await samples(engine, node.id);
    assert.equal(node.unit, 'Nm');
    assert.equal(node.operation, operation);
    assert.equal(node.version, 1);
    assert.deepEqual(node.parents, [source.channels[0]]);
    assert.deepEqual(node.parameters, { value: parameter });
    assert.deepEqual(
      points.map(([time]) => time),
      raw.map(([time]) => time),
    );
    results.push({ node, points });
  }
  assert.deepEqual(await samples(engine, source.channels[0]), raw);
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  t.after(() => reopened.close());
  await reopened.open();
  for (const { node, points } of results) {
    assert.deepEqual(
      reopened.project.nodes.find((n) => n.id === node.id),
      node,
    );
    assert.deepEqual(await samples(reopened, node.id), points);
  }
});

void test('filters compose with derived signals and translated time axes', async (t) => {
  const { engine, source } = await fixture('t,a\n100,0\n101,10\n103,10');
  t.after(() => engine.close());
  const zeroed = await engine.derive(source.channels[0], 'zero-time', 0);
  const shifted = await engine.derive(zeroed.id, 'time-shift', -5);
  for (const [operation, parameter] of filters) {
    const original = await engine.derive(
      source.channels[0],
      operation,
      parameter,
    );
    const translated = await engine.derive(shifted.id, operation, parameter);
    assert.deepEqual(
      await samples(engine, translated.id),
      (await samples(engine, original.id)).map(([time, value]) => [
        time - 105,
        value,
      ]),
    );
  }
  const median = await engine.derive(source.channels[0], 'median', 3);
  const smoothed = await engine.derive(median.id, 'exponential', 0.5);
  assert.deepEqual(
    (await samples(engine, smoothed.id)).map(([, value]) => value),
    [0, 2.5, 6.25],
  );
});

void test('invalid filter parameters never publish a derived node', async (t) => {
  const { engine, source } = await fixture('t,a\n0,1\n1,2');
  t.after(() => engine.close());
  const initialCount = engine.project.nodes.length;
  const invalid: [Operation, number[]][] = [
    ['median', [0, -1, 1.5, 1002, NaN, Infinity]],
    ['exponential', [0, -0.1, 1.01, NaN, Infinity]],
    ['low-pass', [0, -1, NaN, Infinity]],
    ['high-pass', [0, -1, NaN, Infinity]],
  ];
  for (const [operation, parameters] of invalid) {
    for (const parameter of parameters) {
      await assert.rejects(
        engine.derive(source.channels[0], operation, parameter),
      );
      assert.equal(engine.project.nodes.length, initialCount);
    }
  }
});

void test('all added filters continue across persisted chunk boundaries', async (t) => {
  const input = Array.from({ length: 16400 }, (_, i) =>
    i === 16382 || i === 16387 ? NaN : i % 13,
  );
  const { engine, source } = await fixture(
    `t,a\n${input.map((value, i) => `${i},${Number.isNaN(value) ? '' : value}`).join('\n')}`,
  );
  t.after(() => engine.close());
  assert.equal(source.chunks, 2);
  for (const [operation, parameter] of filters) {
    const node = await engine.derive(source.channels[0], operation, parameter);
    const output = await samples(engine, node.id);
    assert.equal(output.length, input.length);
    let previous = NaN;
    let state = NaN;
    input.forEach((value, i) => {
      if (operation === 'median') {
        const window = input
          .slice(Math.max(0, i - 2), i + 1)
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        state =
          window.length === 3
            ? window[1]
            : window.length === 2
              ? (window[0] + window[1]) / 2
              : window.length === 1
                ? window[0]
                : NaN;
      } else if (!Number.isFinite(value)) state = NaN;
      else if (!Number.isFinite(previous))
        state = operation === 'high-pass' ? 0 : value;
      else if (operation === 'high-pass')
        state = (state + value - previous) / 2;
      else state = (state + value) / 2;
      closeTo(output[i][1], state);
      assert.equal(output[i][0], i);
      previous = value;
    });
  }
});

void test('cropping a filtered parent retains history while filtering a crop restarts', async (t) => {
  const { engine, source } = await fixture('t,a\n0,0\n1,10\n2,10\n3,10');
  t.after(() => engine.close());
  // Crop nodes exercise evaluation independently of the segmentation editor.
  const crop = (parent: SignalNode): SignalNode => {
    const node: SignalNode = {
      ...parent,
      id: crypto.randomUUID(),
      parents: [parent.id],
      operation: 'crop',
      parameters: { start: 2, end: 3 },
    };
    engine.project.nodes.push(node);
    return node;
  };
  const raw = engine.project.nodes.find((n) => n.id === source.channels[0])!;
  for (const [operation, parameter] of filters) {
    const filtered = await engine.derive(raw.id, operation, parameter);
    const cropped = crop(filtered);
    assert.deepEqual(
      await samples(engine, cropped.id),
      (await samples(engine, filtered.id)).slice(2),
    );
    const restarted = await engine.derive(crop(raw).id, operation, parameter);
    assert.equal(
      (await samples(engine, restarted.id))[0][1],
      operation === 'high-pass' ? 0 : 10,
    );
  }
});

/** |H(e^jw)| of a biquad at `frequency` for sample `rate`. */
function gain(
  { b, a }: ReturnType<typeof butterworth>,
  frequency: number,
  rate: number,
) {
  const w = (2 * Math.PI * frequency) / rate;
  const re = (k: number[]) =>
    k.reduce((sum, c, n) => sum + c * Math.cos(-w * n), 0);
  const im = (k: number[]) =>
    k.reduce((sum, c, n) => sum + c * Math.sin(-w * n), 0);
  const num = [re(b), im(b)];
  const den = [re([1, ...a]), im([1, ...a])];
  return Math.hypot(...num) / Math.hypot(...den);
}

void test('Butterworth filters are flat, −3 dB at the cutoff and 40 dB per decade', () => {
  const rate = 1000;
  const low = butterworth(10, rate, 'low-pass');
  const high = butterworth(10, rate, 'high-pass');
  assert.ok(Math.abs(gain(low, 0, rate) - 1) < 1e-12);
  assert.ok(gain(high, 0, rate) < 1e-12);
  assert.ok(Math.abs(gain(low, 10, rate) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(gain(high, 10, rate) - Math.SQRT1_2) < 1e-12);
  // A decade above the cutoff: close to −40 dB (bilinear warping adds a bit).
  const decade = 20 * Math.log10(gain(low, 100, rate));
  assert.ok(decade < -39 && decade > -41.5, `${decade} dB`);
  assert.ok(gain(low, 1, rate) > 0.9999);
  assert.throws(
    () => butterworth(500, rate, 'low-pass'),
    /half the sample rate/,
  );
  assert.throws(() => butterworth(0, rate, 'low-pass'), /above 0 Hz/);
  // A rounded rate estimate (10.000001 Hz) must not admit a 5 Hz cutoff.
  assert.equal(belowNyquist(5, 10.000001), false);
  assert.equal(belowNyquist(4.99, 10), true);
});

void test('Butterworth filters settle on constants and restart at gaps', () => {
  const low = new ButterworthFilter(5, 100, 'low-pass');
  const high = new ButterworthFilter(5, 100, 'high-pass');
  for (let i = 0; i < 50; i++) {
    assert.ok(Math.abs(low.next(i / 100, 3) - 3) < 1e-12);
    assert.ok(Math.abs(high.next(i / 100, 3)) < 1e-12);
  }
  // A missing sample breaks the recurrence; the next sample restarts it.
  assert.ok(Number.isNaN(low.next(0.5, NaN)));
  assert.equal(low.next(0.51, 7), 7);
  assert.notEqual(low.next(0.52, 0), 0);
  // An irregular interval (here 1 s instead of 10 ms) also restarts it.
  assert.equal(low.next(1.52, -4), -4);
  assert.equal(high.next(2, 9), 0);
  // A sine well above the cutoff is strongly attenuated once settled.
  const filter = new ButterworthFilter(5, 1000, 'low-pass');
  let peak = 0;
  for (let i = 0; i < 4000; i++) {
    const y = filter.next(i / 1000, Math.sin(2 * Math.PI * 100 * (i / 1000)));
    if (i > 2000) peak = Math.max(peak, Math.abs(y));
  }
  assert.ok(peak < 0.003 && peak > 0.002, `${peak}`);
});

void test('Butterworth derives record their rate and reject cutoffs at Nyquist', async () => {
  const csv = `t,x [V]\n${Array.from({ length: 200 }, (_, i) => `${i / 100},${Math.sin(i / 5)}`).join('\n')}`;
  const { engine, source } = await fixture(csv);
  try {
    const node = await engine.derive(source.channels[0], 'butterworth-low', 5);
    assert.equal(node.parameters.value, 5);
    assert.ok(Math.abs(node.parameters.rate - 100) < 1e-6);
    assert.equal(node.unit, 'V');
    await assert.rejects(
      engine.derive(source.channels[0], 'butterworth-high', 50),
      /below half the sample rate \(50 Hz\)/,
    );
  } finally {
    engine.close();
  }
});
