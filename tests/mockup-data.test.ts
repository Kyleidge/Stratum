import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAMPLE,
  apply,
  compute,
  edit,
  eligibleSignals,
  formatExact,
  importCsv,
  remove,
  sampleAtDisplayTime,
  type MockSignal,
  type Workspace,
} from '../lib/mockup-data';

const empty = (): Workspace => ({ steps: [], outputs: new Map(), nextId: 1 });
const signal = (ws: Workspace, id: string): MockSignal => {
  const output = ws.outputs.get(id);
  assert.ok(output && output.kind !== 'value');
  return output;
};

void test('mockup editing rejects self, descendant and later input dependencies atomically', () => {
  const later = apply(EXAMPLE, { op: 'scale', factor: 2 }, ['speed'], 'Later');
  const before = structuredClone(later.ws);
  for (const by of ['product', 'run2', later.step.outputs[0]]) {
    assert.throws(
      () => edit(later.ws, 's3', { op: 'multiply', by }),
      /steps before this operation/,
    );
  }
  assert.deepEqual(later.ws, before);
  assert.deepEqual(
    eligibleSignals(later.ws, 's3').map((output) => output.id),
    ['speed', 'torque', 'smooth'],
  );
});

void test('mockup editing replays dependent operations with stable IDs and new revisions', () => {
  const before = structuredClone(EXAMPLE);
  const next = edit(EXAMPLE, 's2', { op: 'smooth', width: 7 });
  assert.deepEqual(EXAMPLE, before);
  assert.notDeepEqual(signal(next, 'smooth').v, signal(EXAMPLE, 'smooth').v);
  for (const oldStep of EXAMPLE.steps) {
    const rebuilt = next.steps.find((step) => step.id === oldStep.id)!;
    assert.deepEqual(rebuilt.outputs, oldStep.outputs);
    assert.equal(rebuilt.sequence, oldStep.sequence);
    assert.equal(
      rebuilt.revision,
      oldStep.revision + (oldStep.id === 's1' ? 0 : 1),
    );
  }
  assert.deepEqual(
    remove(next, 's2').steps.map((step) => step.id),
    ['s1'],
  );
});

void test('mockup cardinality changes remove obsolete dependants and retain independent steps', () => {
  const separate = apply(
    EXAMPLE,
    { op: 'offset', amount: 3 },
    ['speed'],
    'Independent',
  );
  const next = edit(separate.ws, 's4', { op: 'ranges', ranges: [[10, 50]] });
  assert.deepEqual(
    next.steps.map((step) => step.id),
    ['s1', 's2', 's3', 's4', 's5', separate.step.id],
  );
  assert.deepEqual(next.steps.at(-1), separate.step);
  for (const output of next.outputs.values())
    assert.ok(output.inputs.every((id) => next.outputs.has(id)));
  assert.deepEqual(next.steps.find((step) => step.id === 's5')?.inputs, [
    'run1',
  ]);
});

void test('mockup failed downstream replay leaves the original workspace intact', () => {
  const csv = [
    'Time,V',
    ...Array.from({ length: 1001 }, (_, i) => `${i / 100},${i}`),
  ].join('\n');
  const imported = importCsv(empty(), 'long.csv', csv);
  const ranges = apply(
    imported.ws,
    { op: 'ranges', ranges: [[0, 1]] },
    imported.step.outputs,
    'Range',
  );
  const windows = apply(
    ranges.ws,
    { op: 'windows', length: 0.02 },
    ranges.step.outputs,
    'Windows',
  );
  const before = structuredClone(windows.ws);
  assert.throws(
    () => edit(windows.ws, ranges.step.id, { op: 'ranges', ranges: [[0, 10]] }),
    /at most 200 windows/,
  );
  assert.deepEqual(windows.ws, before);
});

void test('mockup import handles quoted numbers, commas, escaped quotes and embedded newlines', () => {
  const csv =
    '\uFEFFTime,"Torque, ""measured"" [Nm]","Line\nname [V]"\r\n"0","1","2"\r\n"1","","3"';
  const imported = importCsv(empty(), 'quoted.csv', csv);
  assert.equal(imported.step.outputs.length, 2);
  const torque = signal(imported.ws, imported.step.outputs[0]);
  assert.equal(torque.label, 'Torque, "measured"');
  assert.equal(torque.unit, 'Nm');
  assert.deepEqual([...torque.t], [0, 1]);
  assert.deepEqual([...torque.v], [1, NaN]);
  assert.equal(
    signal(imported.ws, imported.step.outputs[1]).label,
    'Line\nname',
  );
});

void test('mockup import rejects malformed rows instead of publishing incomplete recordings', () => {
  const ws = empty();
  for (const csv of [
    'Time,V\ninvalid,1\ninvalid,2',
    'Time,V\n0,1\n1junk,2',
    'Time,V\n0,1\n1,2junk',
    'Time,V\n0,1,2\n1,2',
    'Time,V\n0,1\n,2',
    'Time,V\n0,1\n0,2',
    'Time,V\n0,1\n"1,2',
    'Time,V\n0,1\n"1"junk,2',
    'Time,V\n0,1',
  ])
    assert.throws(() => importCsv(ws, 'invalid.csv', csv));
  assert.deepEqual(ws, empty());
});

void test('mockup import rejects files beyond the prototype row limit without truncation', () => {
  const csv = [
    'Time,V',
    ...Array.from({ length: 200_001 }, (_, i) => `${i},1`),
  ].join('\n');
  assert.throws(() => importCsv(empty(), 'large.csv', csv), /at most 200,000/);
});

void test('mockup windows report the output limit instead of silently discarding later data', () => {
  assert.throws(
    () => compute(EXAMPLE, { op: 'windows', length: 0.2 }, ['torque']),
    /at most 200 windows/,
  );
  const windows = compute(EXAMPLE, { op: 'windows', length: 0.9 }, ['torque']);
  assert.equal(windows.length, 200);
  const last = windows.at(-1);
  assert.ok(last && last.kind !== 'value');
  assert.equal(last.t.at(-1), 180);
});

void test('mockup crops and windows use exact boundaries at sub-nanosecond cadence', () => {
  const imported = importCsv(
    empty(),
    'fine.csv',
    'Time,V\n0,0\n1e-10,1\n2e-10,2\n3e-10,3\n4e-10,4',
  );
  const range = compute(
    imported.ws,
    { op: 'ranges', ranges: [[1e-10, 2e-10]] },
    imported.step.outputs,
  )[0];
  assert.ok(range.kind !== 'value');
  assert.deepEqual([...range.v], [1, 2]);
  const windows = compute(
    imported.ws,
    { op: 'windows', length: 2e-10 },
    imported.step.outputs,
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((window) => (window.kind === 'value' ? [] : [...window.v])),
    [
      [0, 1],
      [2, 3, 4],
    ],
  );
});

void test('mockup fractional windows include the recording endpoint exactly once', () => {
  const csv = [
    'Time,V',
    ...Array.from({ length: 601 }, (_, i) => `${i / 10},${i}`),
  ].join('\n');
  const imported = importCsv(empty(), 'fractional.csv', csv);
  const windows = compute(
    imported.ws,
    { op: 'windows', length: 0.3 },
    imported.step.outputs,
  );
  assert.equal(windows.length, 200);
  const samples = windows.flatMap((window) =>
    window.kind === 'value' ? [] : [...window.t],
  );
  assert.deepEqual(samples, [
    ...signal(imported.ws, imported.step.outputs[0]).t,
  ]);
});

void test('mockup numerical functions preserve missing samples and centred window sizes', () => {
  const imported = importCsv(empty(), 'missing.csv', 'Time,V\n0,0\n1,\n2,4');
  const derivative = compute(
    imported.ws,
    { op: 'derivative' },
    imported.step.outputs,
  )[0];
  assert.ok(derivative.kind !== 'value');
  assert.deepEqual([...derivative.v], [NaN, NaN, NaN]);
  assert.throws(
    () => compute(EXAMPLE, { op: 'smooth', width: 2 }, ['torque']),
    /odd whole number/,
  );
  assert.throws(
    () => compute(EXAMPLE, { op: 'windows', length: Infinity }, ['torque']),
    /finite, positive/,
  );
  const complete = importCsv(empty(), 'complete.csv', 'Time,V\n0,0\n1,3\n2,0');
  const average = compute(
    complete.ws,
    { op: 'smooth', width: 3 },
    complete.step.outputs,
  )[0];
  assert.ok(average.kind !== 'value');
  assert.deepEqual([...average.v], [1.5, 1, 1.5]);
});

void test('mockup operations reject unavailable inputs and empty overlap', () => {
  assert.throws(
    () =>
      apply(EXAMPLE, { op: 'multiply', by: 'missing' }, ['speed'], 'Invalid'),
    /steps before/,
  );
  const shifted = apply(
    EXAMPLE,
    { op: 'shift', seconds: 1000 },
    ['speed'],
    'Later time',
  );
  assert.throws(
    () =>
      apply(
        shifted.ws,
        { op: 'multiply', by: shifted.step.outputs[0] },
        ['speed'],
        'Empty',
      ),
    /no outputs/,
  );
  assert.throws(
    () => edit(EXAMPLE, 's4', { op: 'ranges', ranges: [[1000, 2000]] }),
    /no outputs/,
  );
  assert.throws(
    () => edit(EXAMPLE, 's1', { op: 'scale', factor: 2 }),
    /immutable/,
  );
  const touching = apply(
    EXAMPLE,
    { op: 'shift', seconds: 180 },
    ['speed'],
    'One shared endpoint',
  );
  assert.throws(
    () =>
      apply(
        touching.ws,
        { op: 'multiply', by: touching.step.outputs[0] },
        ['speed'],
        'Singleton',
      ),
    /no outputs/,
  );
});

void test('mockup exact sample formatting preserves small values and numeric precision', () => {
  for (const value of [
    0.000001, -0.0000025, 12345.678901234, 1.2345678901234567, 1e-20,
  ])
    assert.equal(Number(formatExact(value)), value);
  assert.equal(formatExact(NaN), '—');
});

void test('mockup displayed sample lookup preserves tiny cadence and does not borrow neighboring values', () => {
  for (const cadence of [1e-6, 1e-9]) {
    const input = {
      t: Float64Array.from([cadence, 2 * cadence, 3 * cadence]),
      v: Float64Array.from([10, 20, NaN]),
    };
    assert.equal(sampleAtDisplayTime(input, cadence), 10);
    assert.equal(sampleAtDisplayTime(input, 2 * cadence), 20);
    assert.equal(sampleAtDisplayTime(input, 3 * cadence), undefined);
    assert.equal(sampleAtDisplayTime(input, 1.5 * cadence), undefined);
    assert.equal(sampleAtDisplayTime(input, 0), undefined);
    assert.equal(sampleAtDisplayTime(input, 4 * cadence), undefined);
    assert.equal(sampleAtDisplayTime(input, input.t[1] - cadence, cadence), 20);
  }
  const decimal = {
    t: Float64Array.from([0.1, 0.2, 0.3]),
    v: Float64Array.from([1, 2, 3]),
  };
  assert.equal(sampleAtDisplayTime(decimal, 0.3 - 0.1, 0.1), 3);
  assert.equal(sampleAtDisplayTime(decimal, 0.2, 0.1), undefined);
});

void test('mockup rolling smoothing agrees with centred reference windows and missing data', () => {
  let seed = 12345;
  const values = Array.from({ length: 101 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return i % 7 === 0 ? NaN : (seed / 2 ** 32 - 0.5) * 100;
  });
  const csv = [
    'Time,V',
    ...values.map((value, i) => `${i},${Number.isFinite(value) ? value : ''}`),
  ].join('\n');
  const imported = importCsv(empty(), 'random.csv', csv);
  for (const width of [1, 3, 11, 99, 1001]) {
    const result = compute(
      imported.ws,
      { op: 'smooth', width },
      imported.step.outputs,
    )[0];
    assert.ok(result.kind !== 'value');
    const half = Math.floor(width / 2);
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        assert.ok(Number.isNaN(result.v[index]));
        return;
      }
      const window = values
        .slice(Math.max(0, index - half), index + half + 1)
        .filter(Number.isFinite);
      const expected =
        window.reduce((sum, sample) => sum + sample, 0) / window.length;
      assert.ok(Math.abs(result.v[index] - expected) < 1e-11);
    });
  }
});

void test('mockup smoothing handles a full import and wide window in one pass', () => {
  const csv = [
    'Time,V',
    ...Array.from({ length: 200_000 }, (_, i) => `${i},${i}`),
  ].join('\n');
  const imported = importCsv(empty(), 'wide.csv', csv);
  const result = compute(
    imported.ws,
    { op: 'smooth', width: 100_001 },
    imported.step.outputs,
  )[0];
  assert.ok(result.kind !== 'value');
  assert.equal(result.v.length, 200_000);
  assert.equal(result.v[0], 25_000);
  assert.equal(result.v[100_000], 100_000);
  assert.equal(result.v[199_999], 174_999);
});
