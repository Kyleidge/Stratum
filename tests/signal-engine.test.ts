import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { CsvParser, Envelope, bsfc, power } from '../lib/signal-math';
import type { SegmentationDefinition } from '../lib/signal-types';
import { segmentTraces } from '../lib/segment-traces';

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
    /invalid\.csv: Row 3: the time cell is empty\./,
  );
  assert.equal(e.project.sources.length, 0);
  e.close();
});
void test('CSV errors name the file, the row and the cause', async (t) => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  t.after(() => e.close());
  const failures: [string, RegExp][] = [
    [
      'Time [s];Speed [rpm]\n0;1\n1;2',
      /SN\.csv: Columns are separated by semicolons \(;\), not commas\..*Time \[s\],Speed \[rpm\]/,
    ],
    ['Time [s]\tSpeed\n0\t1\n1\t2', /separated by tabs/],
    [
      'Time,Speed\n2024-01-02 10:00:00,1\n2024-01-02 10:00:01,2',
      /SN\.csv: Row 2: time “2024-01-02 10:00:00” is a date or clock time\./,
    ],
    ['t,a\n0,1\n0,2', /SN\.csv: Row 3: time 0 s does not come after/],
    ['t,a\n0,1\n1,x', /SN\.csv: Row 3, column “a”: “x” is not a number\./],
    ['t,a,a\n0,1,2\n1,2,3', /SN\.csv: The header “a” appears more than once/],
    [
      't,a\n0,1\n1,2,3',
      /SN\.csv: Row 3 has 3 columns, but the header row has 2\./,
    ],
  ];
  for (const [text, message] of failures)
    await assert.rejects(e.importCsv(new File([text], 'SN.csv')), message);
  assert.equal(e.project.sources.length, 0);
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
void test('sample counts include missing values and track output grids without changing history', async (t) => {
  const { e, s } = await fixture('t,a [V]\n0,1\n1,\n2,3\n3,4\n4,5');
  t.after(() => e.close());
  const id = s.channels[0];
  const derivative = await e.derive(id, 'derivative', 0);
  const smoothed = await e.derive(derivative.id, 'smooth', 3);
  const evaluate = t.mock.method(e, 'evaluate', () => {
    throw new Error(
      'Sample-preserving counts must not evaluate signal values.',
    );
  });
  assert.equal(await e.sampleCount(id), 5);
  assert.equal(await e.sampleCount(smoothed.id), 5);
  evaluate.mock.restore();
  const extrema = await e.derive(id, 'min-max', 0);
  const resampled = await e.derive(id, 'resample', 2);
  const [segment] = await e.segment(
    s.id,
    {
      method: 'ranges',
      boundary: 'clip',
      ranges: [[1, 3]],
    },
    [id],
  );
  const cropped = segment.nodes[0];
  assert.equal(await e.sampleCount(extrema.id), 2);
  assert.equal(await e.sampleCount(resampled.id), 9);
  assert.equal(
    await e.sampleCount(cropped),
    3,
    'Legacy crops include both endpoints and the missing sample',
  );
  const [timeCrop] = await e.applyTimeOperation({
    kind: 'crop',
    inputIds: [id],
    start: 0.5,
    end: 2.5,
  });
  const before = structuredClone(e.project);
  assert.equal(await e.sampleCount(timeCrop.id), 2);
  assert.deepEqual(e.project, before);
  const step = e.project.workflowSteps!.at(-1)!;
  await e.editOperation(step.id, {
    type: 'time-operation',
    settings: { kind: 'crop', inputIds: [id], start: 0, end: 4 },
  });
  assert.equal(
    await e.sampleCount(timeCrop.id),
    5,
    'Edit must invalidate the cached count',
  );
  await e.travel('undo');
  assert.equal(await e.sampleCount(timeCrop.id), 2);
  const [aligned] = await e.applyTimeOperation({
    kind: 'align',
    reference: { id: 'count-clock', name: 'Aligned', kind: 'relative' },
    target: 10,
    groups: [{ inputIds: [id], anchor: { kind: 'start' } }],
  });
  assert.equal(await e.sampleCount(aligned.id), 5);
  const [uniform] = await e.applyTimeOperation({
    kind: 'resample',
    inputIds: [id],
    grid: { kind: 'uniform', start: -1, end: 5, rate: 2 },
    interpolation: 'linear',
    maxGap: 1,
  });
  assert.equal(
    await e.sampleCount(uniform.id),
    13,
    'Includes missing grid positions outside the input',
  );
  const [reference] = await e.applyTimeOperation({
    kind: 'resample',
    inputIds: [id],
    grid: { kind: 'reference', signalId: uniform.id, start: 0.5, end: 3.5 },
    interpolation: 'linear',
    maxGap: 1,
  });
  assert.equal(await e.sampleCount(reference.id), 7);
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
  const crops = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 3]], boundary: 'clip' },
    s.channels,
  );
  const segments = await e.calculateSegmentMetrics(
    crops.map((segment) => segment.id),
  );
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
    assert.ok(speed.at(-1)! > 900);
    assert.equal(seg.definition?.method, 'triggers');
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

function triggers(
  id: string,
): Extract<SegmentationDefinition, { method: 'triggers' }> {
  return {
    method: 'triggers',
    start: { signalId: id, edge: 'rising', threshold: 1, offset: 0 },
    end: { signalId: id, edge: 'falling', threshold: 1, offset: 0 },
    minimumDuration: 0,
    boundary: 'clip',
  };
}
const binaryCsv =
  't,Switch [V]\n0,0\n1,0\n2,2\n3,2\n4,0\n5,0\n6,2\n7,2\n8,0\n9,0';

void test('new segments are numbered per step and named after display labels', async () => {
  const { e, s } = await fixture(binaryCsv);
  await e.rename(s.channels[0], 'Door switch');
  const config = triggers(s.channels[0]);
  const first = await e.segment(s.id, config, [s.channels[0]]);
  const second = await e.segment(s.id, config, [s.channels[0]]);
  assert.deepEqual(
    first.map((segment) => segment.name),
    ['Segment 01', 'Segment 02'],
  );
  assert.deepEqual(
    second.map((segment) => segment.name),
    ['Segment 01', 'Segment 02'],
  );
  assert.equal(e.find(second[0].nodes[0]).name, 'Door switch');
  e.close();
});
void test('generic triggers interpolate crossings, preserve provenance, and only create crops', async () => {
  const { e, s } = await fixture(binaryCsv);
  const before = await values(e, s.channels[0]);
  const config = triggers(s.channels[0]);
  const preview = await e.previewSegments(s.id, config, s.channels);
  assert.equal(e.project.segments.length, 0);
  assert.deepEqual(
    preview.ranges.map((range) => [range.start, range.end]),
    [
      [1.5, 3.5],
      [5.5, 7.5],
    ],
  );
  const segments = await e.segment(s.id, config, s.channels);
  assert.equal(segments[0].name, 'Segment 01');
  assert.deepEqual(segments[0].definition, config);
  assert.equal(segments[0].boundary?.startTrigger, 1.5);
  assert.deepEqual(await values(e, segments[0].nodes[0]), [2, 2]);
  assert.ok(
    e.project.nodes.slice(1).every((node) => node.operation === 'crop'),
  );
  assert.deepEqual(await values(e, s.channels[0]), before);
  e.close();
});
void test('signed offsets apply after pairing and may produce overlapping, clipped segments', async () => {
  const { e, s } = await fixture(binaryCsv);
  const config = triggers(s.channels[0]);
  config.start.offset = -20;
  config.end.offset = 1;
  const preview = await e.previewSegments(s.id, config, s.channels);
  assert.deepEqual(
    preview.ranges.map((range) => [range.start, range.end]),
    [
      [0, 4.5],
      [0, 8.5],
    ],
  );
  assert.equal(preview.ranges[0].requestedStart, -18.5);
  assert.ok(preview.ranges.every((range) => range.clipped));
  const discard = await e.previewSegments(
    s.id,
    { ...config, boundary: 'discard' },
    s.channels,
  );
  assert.equal(discard.ranges.length, 0);
  assert.equal(discard.skipped, 2);
  config.start.offset = 3;
  config.end.offset = 0;
  assert.equal((await e.previewSegments(s.id, config, s.channels)).skipped, 2);
  config.start.offset = 0;
  config.minimumDuration = 3;
  assert.equal((await e.previewSegments(s.id, config, s.channels)).skipped, 2);
  e.close();
});
void test('independent signals ignore repeated starts and ends before a start', async () => {
  const { e, s } = await fixture(
    't,Start,End\n0,0,2\n1,0,0\n2,2,0\n3,0,2\n4,2,2\n5,2,0\n6,0,0\n7,2,0\n8,2,0',
  );
  const config = triggers(s.channels[0]);
  config.end.signalId = s.channels[1];
  const plan = await e.previewSegments(s.id, config, s.channels);
  assert.deepEqual(
    plan.ranges.map((range) => [range.start, range.end]),
    [[1.5, 4.5]],
  );
  assert.equal(plan.incomplete, 1);
  const segments = await e.segment(s.id, config, s.channels);
  assert.deepEqual(e.find(segments[0].nodes[0]).parents, s.channels);
  e.close();
});
void test('falling starts, rising ends, equality and initially active signals have explicit edge semantics', async () => {
  const { e, s } = await fixture('t,Switch\n0,2\n1,1\n2,0\n3,1\n4,2\n5,1\n6,0');
  const config = triggers(s.channels[0]);
  config.start.edge = 'falling';
  config.end.edge = 'rising';
  const plan = await e.previewSegments(s.id, config, s.channels);
  assert.deepEqual(
    plan.ranges.map((range) => [range.start, range.end]),
    [[1, 3]],
  );
  assert.equal(plan.incomplete, 1);
  const initial = await e.previewSegments(
    s.id,
    triggers(s.channels[0]),
    s.channels,
  );
  assert.deepEqual(
    initial.ranges.map((range) => [range.start, range.end]),
    [[3, 5]],
  );
  e.close();
});
void test('missing trigger samples break pairs without fabricated crossings', async () => {
  const { e, s } = await fixture(
    't,a\n0,0\n1,0\n2,2\n3,\n4,0\n5,0\n6,2\n7,2\n8,0\n9,0',
  );
  const plan = await e.previewSegments(
    s.id,
    triggers(s.channels[0]),
    s.channels,
  );
  assert.deepEqual(
    plan.ranges.map((range) => [range.start, range.end]),
    [[5.5, 7.5]],
  );
  assert.equal(plan.incomplete, 1);
  e.close();
});
void test('trigger state crosses persisted chunk boundaries', async () => {
  const lines = ['t,a'];
  for (let i = 0; i < 16400; i++)
    lines.push(`${i},${i >= 16384 && i <= 16388 ? 2 : 0}`);
  const { e, s } = await fixture(lines.join('\n'));
  const plan = await e.previewSegments(
    s.id,
    triggers(s.channels[0]),
    s.channels,
  );
  assert.deepEqual(
    plan.ranges.map((range) => [range.start, range.end]),
    [[16383.5, 16388.5]],
  );
  e.close();
});
void test('derived triggers and targets map through zeroed and shifted time axes', async () => {
  const { e, s } = await fixture(
    binaryCsv
      .split('\n')
      .map((line, index) =>
        index
          ? `${Number(line.split(',')[0]) + 10},${line.split(',')[1]}`
          : line,
      )
      .join('\n'),
  );
  const zero = await e.derive(s.channels[0], 'zero-time', 0);
  const filtered = await e.derive(zero.id, 'smooth', 1);
  const shifted = await e.derive(filtered.id, 'time-shift', -5);
  const target = await e.derive(s.channels[0], 'time-shift', 50);
  const segments = await e.segment(s.id, triggers(shifted.id), [target.id]);
  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [
      [11.5, 13.5],
      [15.5, 17.5],
    ],
  );
  assert.deepEqual((await e.rows(segments[0].nodes[0], 0)).rows, [
    [62, 2],
    [63, 2],
  ]);
  assert.deepEqual(e.find(segments[0].nodes[0]).parents, [
    target.id,
    shifted.id,
  ]);
  assert.equal((await e.rows(s.channels[0], 0)).rows[0][0], 10);
  e.close();
});
void test('manual ranges and windows support overlap, partial tails and exclude empty crops', async () => {
  const { e, s } = await fixture(binaryCsv);
  const manual = await e.previewSegments(
    s.id,
    {
      method: 'ranges',
      ranges: [
        [0.1, 0.2],
        [-1, 2],
        [3, 5],
        [20, 30],
      ],
      boundary: 'clip',
    },
    s.channels,
  );
  assert.deepEqual(
    manual.ranges.map((range) => [range.start, range.end]),
    [
      [0, 2],
      [3, 5],
    ],
  );
  assert.equal(manual.skipped, 2);
  const windows: SegmentationDefinition = {
    method: 'windows',
    start: 0,
    end: 9,
    duration: 4,
    step: 3,
    includePartial: true,
    boundary: 'clip',
  };
  const plan = await e.previewSegments(s.id, windows, s.channels);
  assert.deepEqual(
    plan.ranges.map((range) => [range.start, range.end]),
    [
      [0, 4],
      [3, 7],
      [6, 9],
    ],
  );
  const full = await e.previewSegments(
    s.id,
    { ...windows, includePartial: false },
    s.channels,
  );
  assert.equal(full.ranges.length, 2);
  assert.equal(full.skipped, 1);
  e.close();
});
void test('segmentation validates inputs before publishing any new nodes', async () => {
  const { e, s } = await fixture(binaryCsv);
  const config = triggers(s.channels[0]);
  await assert.rejects(
    e.segment(
      s.id,
      { ...config, start: { ...config.start, threshold: NaN } },
      s.channels,
    ),
    /finite/,
  );
  await assert.rejects(
    e.segment(
      s.id,
      { method: 'ranges', ranges: [[4, 3]], boundary: 'clip' },
      s.channels,
    ),
    /later end/,
  );
  await assert.rejects(
    e.segment(
      s.id,
      {
        method: 'windows',
        start: 0,
        end: 9,
        duration: 1,
        step: 0.001,
        includePartial: true,
        boundary: 'clip',
      },
      s.channels,
    ),
    /1,000/,
  );
  await assert.rejects(e.segment(s.id, config, []), /output signal/);
  const other = await e.importCsv(new File(['t,a\n0,0\n1,1'], 'other.csv'));
  await assert.rejects(
    e.segment(s.id, config, other.channels),
    /same recording/,
  );
  assert.equal(e.project.segments.length, 0);
  assert.equal(e.project.nodes.length, 2);
  e.close();
});
void test('incompatible metric grids fail without publishing broken calculations', async () => {
  const { e, s } = await fixture(
    't,Speed [rpm],Torque [Nm]\n0,1000,100\n1,2000,100\n2,3000,100\n3,4000,100',
  );
  const shifted = await e.derive(s.channels[0], 'time-shift', 10);
  const segments = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 3]], boundary: 'clip' },
    [shifted.id, s.channels[1]],
  );
  const count = e.project.nodes.length;
  await assert.rejects(
    e.calculateSegmentMetrics(segments.map((segment) => segment.id)),
    /matching sample grids/,
  );
  assert.equal(e.project.nodes.length, count);
  e.close();
});
void test('segmentation cancellation leaves the existing graph intact', async () => {
  const e = new SignalEngine((message) => {
    if (message.includes('Scanning')) e.cancelled = true;
  }, crypto.randomUUID());
  await e.open();
  const source = await e.importCsv(new File([binaryCsv], 'cancel.csv'));
  await assert.rejects(
    e.segment(source.id, triggers(source.channels[0]), source.channels),
    /cancelled/,
  );
  assert.equal(e.project.segments.length, 0);
  assert.equal(e.project.nodes.length, 1);
  e.close();
});
void test('saved segmentation definitions and earlier revisions survive reopening', async () => {
  const name = crypto.randomUUID();
  const e = new SignalEngine(undefined, name);
  await e.open();
  const s = await e.importCsv(new File([binaryCsv], 'saved.csv'));
  const first = await e.segment(s.id, triggers(s.channels[0]), s.channels);
  const before = structuredClone(first);
  await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 9]], boundary: 'clip' },
    s.channels,
  );
  assert.deepEqual(e.project.segments.slice(0, 2), before);
  e.close();
  const reopened = new SignalEngine(undefined, name);
  await reopened.open();
  assert.deepEqual(reopened.project.segments.slice(0, 2), before);
  assert.deepEqual(await values(reopened, first[0].nodes[0]), [2, 2]);
  reopened.close();
});

void test('trigger coverage ends break pairing and output coverage clips derived targets', async () => {
  const { e, s } = await fixture(binaryCsv);
  const [short] = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 3]], boundary: 'clip' },
    s.channels,
  );
  const config = triggers(s.channels[0]);
  config.end.signalId = short.nodes[0];
  const incomplete = await e.previewSegments(s.id, config, s.channels);
  assert.equal(incomplete.ranges.length, 0);
  assert.equal(incomplete.incomplete, 1);
  const target = await e.previewSegments(
    s.id,
    triggers(s.channels[0]),
    short.nodes,
  );
  assert.deepEqual(
    target.ranges.map((range) => [range.start, range.end]),
    [[1.5, 3]],
  );
  assert.ok(target.ranges[0].clipped);
  e.close();
});
void test('preview cache is isolated and manual batch definitions share one snapshot', async () => {
  const { e, s } = await fixture(binaryCsv);
  const config: SegmentationDefinition = {
    method: 'ranges',
    ranges: [
      [0, 2],
      [3, 5],
    ],
    boundary: 'clip',
  };
  const preview = await e.previewSegments(s.id, config, s.channels);
  preview.ranges[0].start = 999;
  const saved = await e.segment(s.id, config, s.channels);
  assert.equal(saved[0].start, 0);
  assert.equal(saved[0].definition, saved[1].definition);
  assert.notEqual(saved[0].definition, config);
  e.close();
});
void test('resampled crop tails without output timestamps are excluded', async () => {
  const { e, s } = await fixture(binaryCsv);
  const [segment] = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 3.5]], boundary: 'clip' },
    s.channels,
  );
  const resampled = await e.derive(segment.nodes[0], 'resample', 10);
  const plan = await e.previewSegments(
    s.id,
    { method: 'ranges', ranges: [[3.2, 3.4]], boundary: 'clip' },
    [resampled.id],
  );
  assert.equal(plan.ranges.length, 0);
  assert.equal(plan.skipped, 1);
  e.close();
});

void test('comparison handles heterogeneous targets and aligns shifted crops to their own starts', async () => {
  const { e, s } = await fixture(
    't,a [V],b [A]\n0,0,0\n1,1,10\n2,2,20\n3,3,30',
  );
  const shifted = await e.derive(s.channels[0], 'time-shift', 10);
  const config: SegmentationDefinition = {
    method: 'ranges',
    ranges: [[1, 3]],
    boundary: 'clip',
  };
  const first = await e.segment(s.id, config, [shifted.id]);
  const second = await e.segment(s.id, config, [s.channels[1]]);
  const plots = Object.fromEntries(
    await Promise.all(
      [...first, ...second]
        .flatMap((segment) => segment.nodes)
        .map(async (id) => [id, await e.plot(id)]),
    ),
  );
  const traces = segmentTraces(
    e.find(s.channels[0]),
    e.project.segments,
    e.project.nodes,
    plots,
    ['green'],
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0].offset, 11);
  assert.equal(traces[0].plot.points[0][0] - traces[0].offset, 0);
  assert.equal(
    segmentTraces(e.find(s.channels[1]), first, e.project.nodes, plots, [
      'green',
    ]).length,
    0,
  );
  e.close();
});

void test('metric grid validation stays bounded through deep time-transform chains', async () => {
  const { e, s } = await fixture(
    't,Speed [rpm],Torque [Nm]\n0,1000,100\n1,2000,100\n2,3000,100',
  );
  let speed = s.channels[0];
  let torque = s.channels[1];
  for (let i = 0; i < 30; i++) {
    speed = (await e.derive(speed, 'time-shift', 1)).id;
    torque = (await e.derive(torque, 'time-shift', 1)).id;
  }
  const segments = await e.segment(
    s.id,
    { method: 'ranges', ranges: [[0, 2]], boundary: 'clip' },
    [speed, torque],
  );
  await e.calculateSegmentMetrics(segments.map((segment) => segment.id));
  const node = e.project.nodes.at(-1)!;
  assert.equal(node.operation, 'power');
  assert.ok(Math.abs((await values(e, node.id))[0] - power(100, 1000)) < 1e-10);
  e.close();
});
