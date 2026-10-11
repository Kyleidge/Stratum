import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLOCK_ROWS, type RecordingFile } from '../lib/formats/recording';
import { openTdms } from '../lib/formats/tdms';

// Clock times show in this device's zone: pin one with daylight saving.
process.env.TZ = 'Europe/Berlin';

const FIXTURES = new URL('./fixtures/formats/', import.meta.url);
const fixture = (name: string) =>
  new Blob([readFileSync(new URL(name, FIXTURES))]);
type Expected = Record<string, Record<string, Record<string, number[] | null>>>;
const expected = JSON.parse(
  readFileSync(new URL('tdms-expected.json', FIXTURES), 'utf8'),
) as Expected;

// ToC flags and data type codes.
const META = 1 << 1;
const NEW_LIST = 1 << 2;
const RAW = 1 << 3;
const INTERLEAVED = 1 << 5;
const BIG = 1 << 6;
const DAQMX = 1 << 7;
const I16 = 2;
const I32 = 3;
const I64 = 4;
const U8 = 5;
const U16 = 6;
const U32 = 7;
const SGL = 9;
const DBL = 10;
const STRING = 0x20;
const TIMESTAMP = 0x44;
const SIZE: Record<number, number> = {
  [I16]: 2,
  [I32]: 4,
  [I64]: 8,
  [U8]: 1,
  [U16]: 2,
  [U32]: 4,
  [SGL]: 4,
  [DBL]: 8,
};

/** Little byte writer for building TDMS segments in tests. */
class Bytes {
  private parts: number[] = [];
  constructor(private little: boolean) {}
  private put(size: number, write: (v: DataView) => void) {
    const view = new DataView(new ArrayBuffer(size));
    write(view);
    this.parts.push(...new Uint8Array(view.buffer));
    return this;
  }
  u8(v: number) {
    return this.put(1, (d) => d.setUint8(0, v));
  }
  u32(v: number) {
    return this.put(4, (d) => d.setUint32(0, v, this.little));
  }
  u64(v: bigint | number) {
    return this.put(8, (d) => d.setBigUint64(0, BigInt(v), this.little));
  }
  f64(v: number) {
    return this.put(8, (d) => d.setFloat64(0, v, this.little));
  }
  text(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.u32(bytes.length);
    this.parts.push(...bytes);
    return this;
  }
  /** A TDMS timestamp: whole seconds since 1904 and a 2^-64 fraction. */
  stamp(seconds: number, fraction: bigint) {
    return this.put(16, (d) => {
      const [s, f] = this.little ? [8, 0] : [0, 8];
      d.setBigInt64(s, BigInt(seconds), this.little);
      d.setBigUint64(f, fraction, this.little);
    });
  }
  raw(bytes: Uint8Array) {
    for (const b of bytes) this.parts.push(b);
    return this;
  }
  value(type: number, v: number) {
    return this.put(SIZE[type], (d) => {
      const l = this.little;
      if (type === I16) d.setInt16(0, v, l);
      else if (type === I32) d.setInt32(0, v, l);
      else if (type === I64) d.setBigInt64(0, BigInt(v), l);
      else if (type === U8) d.setUint8(0, v);
      else if (type === U16) d.setUint16(0, v, l);
      else if (type === U32) d.setUint32(0, v, l);
      else if (type === SGL) d.setFloat32(0, v, l);
      else d.setFloat64(0, v, l);
    });
  }
  get length() {
    return this.parts.length;
  }
  done() {
    return new Uint8Array(this.parts);
  }
}

type Property =
  | [string, 'text' | 'u32' | 'f64', string | number]
  /** A timestamp: seconds since 1904 and a 2^-64 fraction. */
  | [string, 'stamp', [number, bigint]];
type Daqmx = {
  type: number;
  count: number;
  /** [DAQmx type, buffer, byte or bit offset, scale ID]. */
  scalers: [number, number, number, number][];
  widths: number[];
  digital?: boolean;
};
type Obj = {
  path: string;
  index?:
    | 'none'
    | 'same'
    | { type: number; count: number; bytes?: number }
    | { daqmx: Daqmx };
  props?: Property[];
};

function segment(options: {
  toc: number;
  objects?: Obj[];
  data?: Uint8Array;
  incomplete?: boolean;
}) {
  const little = !(options.toc & BIG);
  const meta = new Bytes(little);
  if (options.objects) {
    meta.u32(options.objects.length);
    for (const o of options.objects) {
      meta.text(o.path);
      const index = o.index ?? 'none';
      if (index === 'none') meta.u32(0xffffffff);
      else if (index === 'same') meta.u32(0);
      else if ('daqmx' in index) {
        const d = index.daqmx;
        meta
          .u32(d.digital ? 0x126a : 0x1269)
          .u32(d.type)
          .u32(1)
          .u64(d.count)
          .u32(d.scalers.length);
        for (const [type, buffer, offset, id] of d.scalers) {
          meta.u32(type).u32(buffer).u32(offset);
          if (d.digital) meta.u8(0);
          else meta.u32(0);
          meta.u32(id);
        }
        meta.u32(d.widths.length);
        for (const w of d.widths) meta.u32(w);
      } else {
        meta.u32(index.type === STRING ? 28 : 20);
        meta.u32(index.type).u32(1).u64(index.count);
        if (index.type === STRING) meta.u64(index.bytes ?? 0);
      }
      meta.u32(o.props?.length ?? 0);
      for (const [name, kind, value] of o.props ?? []) {
        meta.text(name);
        if (kind === 'text') meta.u32(0x20).text(String(value));
        else if (kind === 'stamp') meta.u32(TIMESTAMP).stamp(...value);
        else if (kind === 'u32') meta.u32(7).u32(Number(value));
        else meta.u32(10).f64(Number(value));
      }
    }
  }
  const data = options.data ?? new Uint8Array(0);
  const lead = new Bytes(little);
  lead.raw(new TextEncoder().encode('TDSm'));
  lead.raw(new Bytes(true).u32(options.toc).done());
  lead
    .u32(4713)
    .u64(options.incomplete ? NO_OFFSET : meta.length + data.length)
    .u64(meta.length);
  return new Uint8Array([...lead.done(), ...meta.done(), ...data]);
}

const NO_OFFSET = BigInt('0xFFFFFFFFFFFFFFFF');
const file = (...segments: Uint8Array[]) => new Blob(segments as BlobPart[]);

/** Packs channel runs `[type, values]` back to back. */
function pack(little: boolean, ...runs: [number, number[]][]) {
  const b = new Bytes(little);
  for (const [type, values] of runs) for (const v of values) b.value(type, v);
  return b.done();
}

async function readAll(recording: RecordingFile, index: number) {
  const time: number[] = [];
  const values: number[][] = recording.tables[index].channels.map(() => []);
  const sizes: number[] = [];
  const progress: number[] = [];
  for await (const block of recording.read(index)) {
    assert.equal(block.values.length, values.length);
    for (const v of block.values) assert.equal(v.length, block.time.length);
    time.push(...block.time);
    block.values.forEach((v, i) => values[i].push(...v));
    sizes.push(block.time.length);
    progress.push(block.progress ?? NaN);
  }
  return { time, values, sizes, progress };
}

function table(recording: RecordingFile, name: string) {
  const index = recording.tables.findIndex((t) => t.name === name);
  assert.ok(
    index >= 0,
    `no table ${name} in ${recording.tables.map((t) => t.name).join(', ')}`,
  );
  return index;
}

const close = (actual: number[], wanted: number[], tolerance = 1e-12) => {
  assert.equal(actual.length, wanted.length);
  actual.forEach((v, i) =>
    assert.ok(
      Math.abs(v - wanted[i]) <= tolerance * Math.max(1, Math.abs(wanted[i])),
      `sample ${i}: ${v} ≠ ${wanted[i]}`,
    ),
  );
};
function range(n: number): number[];
function range<T>(n: number, f: (i: number) => T): T[];
function range(n: number, f: (i: number) => unknown = (i) => i) {
  return Array.from({ length: n }, (_, i) => f(i));
}

void test('TDMS fixture written by nptdms matches nptdms values, units and timing', async () => {
  const recording = await openTdms(fixture('tdms-basic.tdms'));
  assert.ok(Object.hasOwn(recording, 'read'));
  assert.equal(recording.format, 'NI TDMS 1.0');
  assert.deepEqual(
    recording.tables.map((t) => t.name),
    ['Engine · 1 kHz', 'Engine · 100 Hz', 'Bench', 'Plain', 'Log'],
  );
  assert.deepEqual(recording.notes, [
    'Skipped 2 text or timestamp channels: Engine/Label, Engine/Stamp.',
  ]);
  // wf_start_time 2024-03-01 12:00 UTC, shown in this device's zone (CET);
  // “Slow” has no start time, and a time channel or index has no clock.
  assert.deepEqual(
    recording.tables.map((t) => t.clock),
    [
      { start: 1_709_294_400, offset: 60 },
      undefined,
      undefined,
      undefined,
      { start: 1_709_294_400.123456, offset: 60 },
    ],
  );
  const want = expected['tdms-basic.tdms'];

  const engine = recording.tables[0];
  assert.deepEqual(engine.channels, [
    { name: 'Speed', unit: 'rpm' },
    { name: 'Torque', unit: 'Nm' },
    { name: 'Count', unit: '—' },
    { name: 'Running', unit: '—' },
    { name: 'Gear', unit: '—' },
  ]);
  assert.equal(engine.rows, 200);
  assert.equal(engine.start, 0.5);
  close([engine.end!], [0.5 + 199 * 0.001]);
  const e = await readAll(recording, 0);
  close(
    e.time,
    range(200, (i) => 0.5 + i * 0.001),
  );
  engine.channels.forEach((c, i) =>
    assert.deepEqual(e.values[i], want.Engine[c.name]),
  );

  const bench = recording.tables[2];
  assert.deepEqual(bench.channels, [
    { name: 'Pressure', unit: 'bar' },
    { name: "Valve 'A'", unit: '—' },
  ]);
  assert.deepEqual(bench.notes, [
    'Time comes from the “Time [ms]” channel, converted to seconds.',
  ]);
  const b = await readAll(recording, 2);
  close(
    b.time,
    want.Bench['Time [ms]']!.map((v) => v / 1000),
  );
  assert.deepEqual(b.values[0], want.Bench.Pressure);
  assert.deepEqual(b.values[1], want.Bench["Valve 'A'"]);

  const plain = recording.tables[3];
  assert.deepEqual(plain.notes, [
    'No time channel or waveform timing: time is the sample number.',
  ]);
  assert.deepEqual([plain.start, plain.end, plain.rows], [0, 39, 40]);
  const p = await readAll(recording, 3);
  assert.deepEqual(p.time, range(40));
  plain.channels.forEach((c, i) =>
    assert.deepEqual(p.values[i], want.Plain[c.name]),
  );

  const slow = await readAll(recording, 1);
  assert.deepEqual(slow.values[0], want.Engine.Slow);
  close(
    slow.time,
    range(30, (i) => i * 0.01),
  );

  // nptdms datetime64 values: the group's only timestamp channel is its axis.
  const log = recording.tables[4];
  assert.deepEqual(log.channels, [{ name: 'Level', unit: 'm' }]);
  assert.deepEqual(log.notes, [
    'Time is “Logged” in seconds since its first sample, 2024-03-01T12:00:00.123Z.',
  ]);
  assert.equal(log.start, 0);
  const l = await readAll(recording, 4);
  close(l.time, want.Log.Logged!);
  assert.deepEqual(l.values[0], want.Log.Level);
});

void test('TDMS DAQmx fixture applies chained scales and digital lines like nptdms', async () => {
  const recording = await openTdms(fixture('tdms-daqmx.tdms'));
  const want = expected['tdms-daqmx.tdms'].DAQ;
  assert.equal(want.Raw, null);
  assert.deepEqual(recording.notes, [
    'Skipped 1 channel whose NI scaling cannot be applied: Raw (no scale information).',
  ]);
  assert.equal(recording.tables.length, 1);
  const daq = recording.tables[0];
  assert.equal(daq.name, 'DAQ');
  assert.deepEqual(
    daq.channels.map((c) => `${c.name} [${c.unit}]`),
    ['Voltage [V]', 'Strain [ustrain]', 'Line [—]'],
  );
  assert.equal(daq.rows, 30);
  const data = await readAll(recording, 0);
  close(
    data.time,
    range(30, (i) => i * 0.0001),
  );
  close(data.values[0], want.Voltage!);
  close(data.values[1], want.Strain!);
  assert.deepEqual(data.values[2], want.Line);
});

void test('TDMS interleaved big-endian fixture keeps whole rows of a short final chunk', async () => {
  const recording = await openTdms(fixture('tdms-interleaved-be.tdms'));
  const want = expected['tdms-interleaved-be.tdms'].Rig;
  const rig = recording.tables[0];
  assert.equal(recording.format, 'NI TDMS 2.0');
  assert.deepEqual(
    rig.channels.map((c) => `${c.name} [${c.unit}]`),
    ['Pressure [bar]', 'Flow [l/min]', 'Valve [—]'],
  );
  assert.equal(rig.rows, 55);
  const data = await readAll(recording, 0);
  close(
    data.time,
    range(55, (i) => -0.01 + i * 0.002),
  );
  assert.deepEqual(data.values[0], want.Pressure);
  assert.deepEqual(data.values[1], want.Flow);
  assert.deepEqual(data.values[2], want.Valve);
});

void test('TDMS incremental metadata reuses, appends, disables and reorders objects', async () => {
  const g = (name: string) => `/'G'/'${name}'`;
  const counters: Record<string, number> = { A: 0, B: 0, C: 0 };
  const series: Record<string, number[]> = { A: [], B: [], C: [] };
  const types: Record<string, number> = { A: I32, B: DBL, C: U16 };
  /** Data for `chunks` repetitions of [channel, count] runs. */
  const data = (chunks: number, layout: [string, number][]) => {
    const runs: [number, number[]][] = [];
    for (let k = 0; k < chunks; k++)
      for (const [name, n] of layout) {
        const values = range(n, () => {
          const i = counters[name]++;
          return name === 'B' ? i + 0.5 : name === 'A' ? 0 - i : 7 * i;
        });
        series[name].push(...values);
        runs.push([types[name], values]);
      }
    return pack(true, ...runs);
  };
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          { path: '/' },
          { path: "/'G'" },
          { path: g('A'), index: { type: I32, count: 2 } },
          {
            path: g('B'),
            index: { type: DBL, count: 2 },
            props: [['unit_string', 'text', 'kPa']],
          },
        ],
        data: data(1, [
          ['A', 2],
          ['B', 2],
        ]),
      }),
      // Appends C to the previous list.
      segment({
        toc: META | RAW,
        objects: [{ path: g('C'), index: { type: U16, count: 2 } }],
        data: data(1, [
          ['A', 2],
          ['B', 2],
          ['C', 2],
        ]),
      }),
      // No metadata: the same layout, repeated as two chunks.
      segment({
        toc: RAW,
        data: data(2, [
          ['A', 2],
          ['B', 2],
          ['C', 2],
        ]),
      }),
      // A pauses; B changes its chunk size.
      segment({
        toc: META | RAW,
        objects: [
          { path: g('A'), index: 'none' },
          { path: g('B'), index: { type: DBL, count: 4 } },
        ],
        data: data(1, [
          ['B', 4],
          ['C', 2],
        ]),
      }),
      // A resumes with its previous index, in its old list position.
      segment({
        toc: META | RAW,
        objects: [{ path: g('A'), index: 'same' }],
        data: data(1, [
          ['A', 2],
          ['B', 4],
          ['C', 2],
        ]),
      }),
      // A new list in a new order, both reusing earlier indexes.
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          { path: g('C'), index: 'same' },
          { path: g('A'), index: 'same' },
        ],
        data: data(1, [
          ['C', 2],
          ['A', 2],
        ]),
      }),
    ),
  );
  assert.deepEqual(series.A.length, 12);
  assert.deepEqual(series.C.length, 12);
  assert.deepEqual(
    recording.tables.map((t) => [
      t.name,
      t.rows,
      t.channels.map((c) => c.name),
    ]),
    [
      ['G · 12 samples', 12, ['A', 'C']],
      ['G · 16 samples', 16, ['B']],
    ],
  );
  assert.equal(recording.tables[1].channels[0].unit, 'kPa');
  const ac = await readAll(recording, 0);
  assert.deepEqual(ac.values, [series.A, series.C]);
  assert.deepEqual(ac.time, range(12));
  assert.deepEqual((await readAll(recording, 1)).values, [series.B]);
});

void test('TDMS mixes big-endian contiguous and interleaved segments with text channels', async () => {
  const objects = (count: number): Obj[] => [
    {
      path: "/'It''s'/'Time'",
      index: { type: DBL, count },
      props: [['unit_string', 'text', 'ms']],
    },
    { path: "/'It''s'/'a ''b'''", index: { type: I64, count } },
    { path: "/'It''s'/'Gain'", index: { type: SGL, count } },
  ];
  const t = range(15, (i) => i * 10);
  const x = range(15, (i) => (i - 7) * 1e12);
  const y = range(15, (i) => i / 4);
  // Strings are skipped, but their bytes still sit between channels.
  const words = ['one', 'three'];
  const text = new Bytes(true).u32(3).u32(8).done();
  const stringIndex = { type: STRING, count: 2, bytes: 8 + 8 };
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW | BIG,
        objects: [
          ...objects(3),
          { path: "/'It''s'/'Words'", index: stringIndex },
        ],
        data: new Uint8Array([
          ...pack(false, [DBL, t.slice(0, 3)], [I64, x.slice(0, 3)]),
          ...pack(false, [SGL, y.slice(0, 3)]),
          ...text,
          ...new TextEncoder().encode(words.join('')),
        ]),
      }),
      segment({
        toc: META | NEW_LIST | RAW | INTERLEAVED,
        objects: objects(4),
        data: new Uint8Array(
          range(12).flatMap((r) => [
            ...pack(
              true,
              [DBL, [t[3 + r]]],
              [I64, [x[3 + r]]],
              [SGL, [y[3 + r]]],
            ),
          ]),
        ),
      }),
    ),
  );
  assert.deepEqual(recording.notes, [
    'Skipped 1 text or timestamp channel: Words.',
  ]);
  const only = recording.tables[0];
  assert.equal(only.name, "It's");
  assert.deepEqual(
    only.channels.map((c) => c.name),
    ["a 'b'", 'Gain'],
  );
  assert.equal(only.start, undefined);
  const data = await readAll(recording, 0);
  close(
    data.time,
    t.map((v) => v / 1000),
  );
  assert.deepEqual(data.values, [x, y]);
});

void test('TDMS short final chunks and an incomplete last segment follow nptdms', async () => {
  const objects: Obj[] = [
    { path: "/'G'/'X'", index: { type: DBL, count: 4 } },
    { path: "/'G'/'Y'", index: { type: I16, count: 4 } },
  ];
  // A complete segment whose last chunk is half size: each channel keeps
  // half its values, like nptdms.
  const short = segment({
    toc: META | NEW_LIST | RAW,
    objects,
    data: pack(
      true,
      [DBL, [1, 2, 3, 4]],
      [I16, [10, 20, 30, 40]],
      [DBL, [5, 6]],
      [I16, [50, 60]],
    ),
  });
  const proportional = await openTdms(file(short));
  assert.deepEqual((await readAll(proportional, 0)).values, [
    [1, 2, 3, 4, 5, 6],
    [10, 20, 30, 40, 50, 60],
  ]);
  // An unfinished segment fills channels in order until the data runs out.
  const unfinished = segment({
    toc: RAW,
    incomplete: true,
    data: pack(
      true,
      [DBL, [7, 8, 9, 10]],
      [I16, [70, 80, 90, 100]],
      [DBL, [11, 12, 13, 14]],
      [I16, [110]],
    ),
  });
  const truncated = await openTdms(file(short, unfinished));
  assert.match(
    truncated.notes!.join(' '),
    /last segment of the file is incomplete/,
  );
  const x = truncated.tables[table(truncated, 'G · 14 samples')];
  const y = truncated.tables[table(truncated, 'G · 11 samples')];
  assert.deepEqual(x.channels[0].name, 'X');
  assert.deepEqual(y.channels[0].name, 'Y');
  assert.deepEqual(
    (await readAll(truncated, truncated.tables.indexOf(x))).values[0],
    range(14, (i) => i + 1),
  );
  assert.deepEqual(
    (await readAll(truncated, truncated.tables.indexOf(y))).values[0],
    range(11, (i) => (i + 1) * 10),
  );
  // Metadata cut off by the end of the file ignores that segment.
  const cut = segment({
    toc: META | NEW_LIST | RAW,
    objects,
    incomplete: true,
  });
  const ignored = await openTdms(file(short, cut.subarray(0, 40)));
  assert.equal(ignored.tables[0].rows, 6);
  assert.match(ignored.notes!.join(' '), /ends inside a segment’s metadata/);
});

void test('TDMS DAQmx raw data selects scalers, chains scales and skips unsupported ones', async () => {
  const widths = [6];
  const daqmx = (scalers: Daqmx['scalers']): Obj['index'] => ({
    daqmx: { type: 0xffffffff, count: 3, scalers, widths },
  });
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW | DAQMX,
        objects: [
          {
            path: "/'D'/'Two'",
            // Two scalers; the chain reads scale 1 (U16 at byte 4).
            index: daqmx([
              [5, 0, 0, 0],
              [2, 0, 4, 1],
            ]),
            props: [
              ['NI_Number_Of_Scales', 'u32', 3],
              ['NI_Scale[2]_Scale_Type', 'text', 'Polynomial'],
              ['NI_Scale[2]_Polynomial_Coefficients[0]', 'f64', 1],
              ['NI_Scale[2]_Polynomial_Coefficients[1]', 'f64', 2],
              ['NI_Scale[2]_Polynomial_Coefficients[2]', 'f64', 0],
              ['NI_Scale[2]_Polynomial_Coefficients[3]', 'f64', 0.5],
              ['NI_Scale[2]_Polynomial_Input_Source', 'u32', 1],
            ],
          },
          {
            path: "/'D'/'Thermo'",
            index: daqmx([[3, 0, 0, 0]]),
            props: [
              ['NI_Number_Of_Scales', 'u32', 2],
              ['NI_Scale[1]_Scale_Type', 'text', 'Thermocouple'],
            ],
          },
          {
            path: "/'D'/'Typed'",
            index: {
              daqmx: { type: I16, count: 3, scalers: [[3, 0, 2, 0]], widths },
            },
          },
        ],
        // Six-byte rows (I16 r, I16 -r, U16 3r): a chunk of three rows and a
        // short chunk of two more.
        data: new Uint8Array(
          range(5).flatMap((r) => [
            ...pack(true, [I16, [r]], [I16, [-r]], [U16, [r * 3]]),
          ]),
        ),
      }),
    ),
  );
  assert.deepEqual(recording.notes, [
    'Skipped 1 channel whose NI scaling cannot be applied: Thermo (Thermocouple scale).',
  ]);
  const data = await readAll(recording, 0);
  assert.deepEqual(
    recording.tables[0].channels.map((c) => c.name),
    ['Two', 'Typed'],
  );
  assert.deepEqual(
    data.values[0],
    range(5, (r) => 1 + 2 * (3 * r) + 0.5 * (3 * r) ** 3),
  );
  assert.deepEqual(
    data.values[1],
    range(5, (r) => -r || 0),
  );
});

void test('TDMS streams long tables in bounded blocks with progress', async () => {
  const segments: Uint8Array[] = [];
  const n = 150_000;
  const per = 25_000;
  const a = range(n, (i) => Math.fround(Math.sin(i / 100)));
  const b = range(n, (i) => i % 65536);
  for (let s = 0; s < n / per; s++) {
    const objects: Obj[] = [
      {
        path: "/'Fast'/'A'",
        index: s % 2 ? 'same' : { type: SGL, count: per / 5 },
        props: s ? [] : [['wf_increment', 'f64', 1e-5]],
      },
      {
        path: "/'Fast'/'B'",
        index: s % 2 ? 'same' : { type: U16, count: per / 5 },
        props: s ? [] : [['wf_increment', 'f64', 1e-5]],
      },
    ];
    const runs: [number, number[]][] = [];
    for (let k = 0; k < 5; k++) {
      const at = s * per + (k * per) / 5;
      runs.push([SGL, a.slice(at, at + per / 5)]);
      runs.push([U16, b.slice(at, at + per / 5)]);
    }
    segments.push(
      segment({
        toc: META | RAW | (s ? 0 : NEW_LIST),
        objects,
        data: pack(true, ...runs),
      }),
    );
  }
  const recording = await openTdms(file(...segments));
  assert.equal(recording.tables[0].rows, n);
  const data = await readAll(recording, 0);
  assert.ok(data.sizes.every((size) => size <= BLOCK_ROWS));
  assert.ok(data.sizes.length >= Math.ceil(n / BLOCK_ROWS));
  assert.ok(data.progress.every((p, i) => i === 0 || p > data.progress[i - 1]));
  assert.equal(data.progress.at(-1), 1);
  assert.deepEqual(data.values, [a, b]);
  close([data.time[n - 1]], [(n - 1) * 1e-5]);
});

void test('TDMS channels written apart read the same with bounded buffering', async () => {
  const runs = (name: string, from: number) =>
    segment({
      toc: META | NEW_LIST | RAW,
      objects: [{ path: `/'G'/'${name}'`, index: { type: I32, count: 100 } }],
      data: pack(true, [I32, range(300, (i) => from + i)]),
    });
  const blob = file(
    runs('A', 0),
    runs('A', 300),
    runs('B', 1000),
    runs('B', 1300),
  );
  const shared = await openTdms(blob);
  const separate = await openTdms(blob, { maxPending: 10 });
  const want = [range(600), range(600, (i) => 1000 + i)];
  assert.deepEqual((await readAll(shared, 0)).values, want);
  assert.deepEqual((await readAll(separate, 0)).values, want);
});

void test('TDMS reads a small channel out of large chunks without the rest', async () => {
  const chunks = 3;
  const x = range(chunks * 10 + 5, (i) => i * 3);
  const y = range(chunks * 40_000 + 20_000, (i) => i / 8);
  const runs: [number, number[]][] = [];
  for (let k = 0; k < chunks; k++)
    runs.push(
      [I32, x.slice(k * 10, k * 10 + 10)],
      [DBL, y.slice(k * 40_000, (k + 1) * 40_000)],
    );
  // Half a chunk more: both channels keep half their values.
  runs.push([I32, x.slice(chunks * 10)], [DBL, y.slice(chunks * 40_000)]);
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          { path: "/'Small'/'x'", index: { type: I32, count: 10 } },
          { path: "/'Large'/'y'", index: { type: DBL, count: 40_000 } },
        ],
        data: pack(true, ...runs),
      }),
    ),
  );
  assert.deepEqual(
    recording.tables.map((t) => [t.name, t.rows]),
    [
      ['Small', 35],
      ['Large', 140_000],
    ],
  );
  assert.deepEqual((await readAll(recording, 0)).values, [x]);
  assert.deepEqual((await readAll(recording, 1)).values, [y]);
});

void test('TDMS timestamp channels become seconds since their first sample', async () => {
  // Seconds near 2024 since 1904, with sub-nanosecond steps (2^-30 s).
  const base = 3_800_000_000;
  const stamp = (b: Bytes, i: number) =>
    b.stamp(base + i, BigInt((i + 1) * 2 ** 34));
  const value = (i: number) => i * 1.25 - 4;
  const log = (count: number): Obj[] => [
    { path: "/'Log'/'Stamp'", index: { type: TIMESTAMP, count } },
    { path: "/'Log'/'Value'", index: { type: DBL, count } },
  ];
  const contiguous = (little: boolean, from: number, n: number) => {
    const b = new Bytes(little);
    for (let i = from; i < from + n; i++) stamp(b, i);
    for (let i = from; i < from + n; i++) b.value(DBL, value(i));
    return b.done();
  };
  const rows = new Bytes(true);
  for (let i = 3; i < 11; i++) stamp(rows, i).value(DBL, value(i));
  const two = new Bytes(true);
  two.stamp(5, BigInt(0)).stamp(6, BigInt(0)); // Created
  two.stamp(100, BigInt(0)).stamp(101, BigInt(2 ** 63)); // Time: 0 and 1.5 s
  two.value(U8, 1).value(U8, 2);
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW | BIG,
        objects: log(3),
        data: contiguous(false, 0, 3),
      }),
      segment({
        toc: META | NEW_LIST | RAW | INTERLEAVED,
        objects: log(4),
        data: rows.done(),
      }),
      segment({
        toc: META | NEW_LIST | RAW,
        objects: log(2),
        data: contiguous(true, 11, 2),
      }),
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          { path: "/'Two'/'Created'", index: { type: TIMESTAMP, count: 2 } },
          { path: "/'Two'/'Time'", index: { type: TIMESTAMP, count: 2 } },
          { path: "/'Two'/'x'", index: { type: U8, count: 2 } },
        ],
        data: two.done(),
      }),
      // Two timestamps, neither named like time: the sample number instead.
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          { path: "/'Three'/'A'", index: { type: TIMESTAMP, count: 1 } },
          { path: "/'Three'/'B'", index: { type: TIMESTAMP, count: 1 } },
          { path: "/'Three'/'y'", index: { type: U8, count: 1 } },
        ],
        data: new Uint8Array([...two.done().subarray(0, 32), 9]),
      }),
    ),
  );
  assert.deepEqual(recording.notes, [
    'Skipped 3 text or timestamp channels: Two/Created, Three/A, Three/B.',
  ]);
  const [first, second, third] = recording.tables;
  assert.deepEqual(first.notes, [
    `Time is “Stamp” in seconds since its first sample, ${new Date((base - 2_082_844_800) * 1000).toISOString()}.`,
  ]);
  assert.deepEqual(first.channels, [{ name: 'Value', unit: '—' }]);
  // Time 0 is the first timestamp: late May 2024, CEST here.
  assert.deepEqual(first.clock, {
    start: base - 2_082_844_800 + 2 ** -30,
    offset: 120,
  });
  assert.deepEqual(second.clock, { start: 100 - 2_082_844_800, offset: 60 });
  assert.equal(third.clock, undefined);
  const data = await readAll(recording, 0);
  assert.deepEqual(
    data.time,
    range(13, (i) => i + i * 2 ** -30),
  );
  assert.deepEqual(data.values, [range(13, value)]);
  assert.deepEqual(second.notes, [
    'Time is “Time” in seconds since its first sample, 1904-01-01T00:01:40.000Z.',
  ]);
  assert.deepEqual((await readAll(recording, 1)).time, [0, 1.5]);
  assert.deepEqual(third.notes, [
    'No time channel or waveform timing: time is the sample number.',
  ]);
});

void test('TDMS wf_start_time is the clock of waveform tables', async () => {
  // Seconds since 1904 near mid 2024, plus half a second.
  const base = 3_800_000_000;
  const half = BigInt(2 ** 63);
  const wave = (start: [number, bigint]): Property[] => [
    ['wf_increment', 'f64', 0.1],
    ['wf_start_time', 'stamp', start],
  ];
  const recording = await openTdms(
    file(
      segment({
        toc: META | NEW_LIST | RAW,
        objects: [
          {
            path: "/'W'/'a'",
            index: { type: U8, count: 2 },
            props: wave([base, half]),
          },
          {
            path: "/'W'/'b'",
            index: { type: U8, count: 2 },
            props: wave([base + 1, half]),
          },
          {
            path: "/'P'/'c'",
            index: { type: U8, count: 2 },
            props: [['wf_start_time', 'stamp', [base, half]]],
          },
          // 1904-01-01 00:00 means “not set”.
          {
            path: "/'Z'/'d'",
            index: { type: U8, count: 2 },
            props: wave([0, BigInt(0)]),
          },
        ],
        data: new Uint8Array(8),
      }),
    ),
  );
  assert.deepEqual(recording.notes, [
    'Start times (wf_start_time) of channels without waveform timing are not applied.',
  ]);
  const [w, p, z] = recording.tables;
  assert.deepEqual(w.clock, { start: base - 2_082_844_800 + 0.5, offset: 120 });
  assert.deepEqual(w.notes, [
    'The channels start at different times (wf_start_time); clock time follows “a”.',
  ]);
  assert.equal(p.clock, undefined);
  assert.equal(z.clock, undefined);
  assert.deepEqual((await readAll(recording, 0)).time, [0, 0.1]);
});

void test('TDMS problems give plain-language errors', async () => {
  await assert.rejects(
    openTdms(new Blob(['not a tdms file at all, just text'])),
    /does not start like a TDMS file/,
  );
  await assert.rejects(
    openTdms(
      file(
        segment({
          toc: META | NEW_LIST | RAW,
          objects: [
            {
              path: "/'G'/'Words'",
              index: { type: STRING, count: 1, bytes: 6 },
            },
          ],
          data: new Uint8Array([2, 0, 0, 0, 104, 105]),
        }),
      ),
    ),
    { message: 'The TDMS file has no numeric channels.' },
  );
  const many = range(1025, (i) => ({
    path: `/'Wide'/'c${i}'`,
    index: { type: U8, count: 1 },
  }));
  await assert.rejects(
    openTdms(
      file(
        segment({
          toc: META | NEW_LIST | RAW,
          objects: many,
          data: new Uint8Array(1025),
        }),
      ),
    ),
    /“Wide” has 1025 channels .* at most 1024/,
  );
  const good = segment({
    toc: META | NEW_LIST | RAW,
    objects: [{ path: "/'G'/'A'", index: { type: U8, count: 2 } }],
    data: new Uint8Array([1, 2]),
  });
  // Metadata whose object count promises more than it holds.
  const broken = good.slice();
  new DataView(broken.buffer).setUint32(28, 9, true);
  await assert.rejects(openTdms(file(broken)), /metadata is damaged/);
  await assert.rejects(
    openTdms(file(good, new Uint8Array(40).fill(7))),
    /no segment starts at byte 70/,
  );
});
