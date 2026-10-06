import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { compileFormula, openMdf } from '../lib/formats/mdf';
import { BLOCK_ROWS, MAX_RECORDING_CHANNELS } from '../lib/formats/recording';
import type { RecordingFile } from '../lib/formats/recording';

const fixtures = new URL('./fixtures/formats/', import.meta.url);

type Expected = {
  tables: {
    name: string;
    channels: [string, string][];
    time: number[];
    values: (number | null)[][];
  }[];
};

async function readAll(file: RecordingFile, table: number) {
  const time: number[] = [];
  const values: number[][] = file.tables[table].channels.map(() => []);
  const progress: number[] = [];
  const sizes: number[] = [];
  for await (const block of file.read(table)) {
    assert.equal(block.values.length, values.length);
    for (const column of block.values)
      assert.equal(column.length, block.time.length);
    time.push(...block.time);
    block.values.forEach((column, i) => values[i].push(...column));
    progress.push(block.progress ?? NaN);
    sizes.push(block.time.length);
  }
  return { time, values, progress, sizes };
}

function close(actual: number, expected: number | null, label: string) {
  if (expected === null) return assert.ok(Number.isNaN(actual), label);
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= 1e-12 * scale,
    `${label}: ${actual} ≠ ${expected}`,
  );
}

for (const name of [
  'mdf4-basic.mf4',
  'mdf4-deflate.mf4',
  'mdf4-transposed.mf4',
  'mdf3-basic.mdf',
]) {
  void test(`${name} matches the values asammdf wrote`, async () => {
    const bytes = readFileSync(new URL(name, fixtures));
    const expected = JSON.parse(
      readFileSync(new URL(`${name}.json`, fixtures), 'utf8'),
    ) as Expected;
    const file = await openMdf(new Blob([bytes]));
    assert.ok(Object.hasOwn(file, 'read'));
    const v4 = name.startsWith('mdf4');
    assert.equal(file.format, v4 ? 'ASAM MDF 4.10' : 'ASAM MDF 3.30');
    assert.deepEqual(
      file.tables.map((table) => table.name),
      expected.tables.map((table) => table.name),
    );
    assert.deepEqual(file.notes, [
      v4
        ? 'Skipped 2 text or unsupported channels: Label, Note.'
        : 'Skipped 1 text or unsupported channel: Label.',
    ]);
    assert.deepEqual(file.tables[0].notes, [
      'Text labels were not applied to Gear; raw values are shown.',
    ]);
    for (const [t, want] of expected.tables.entries()) {
      const table = file.tables[t];
      assert.deepEqual(
        table.channels.map((c) => [c.name, c.unit]),
        want.channels,
      );
      assert.equal(table.rows, want.time.length);
      const got = await readAll(file, t);
      assert.equal(got.time.length, want.time.length);
      got.time.forEach((x, i) => close(x, want.time[i], `${name} time ${i}`));
      want.values.forEach((column, c) =>
        column.forEach((x, i) =>
          close(got.values[c][i], x, `${name} ${want.channels[c][0]} ${i}`),
        ),
      );
      assert.equal(got.progress.at(-1), 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Hand-built MDF 4 files for layouts asammdf does not write.

class Bytes {
  private buffer = new Uint8Array(1 << 16);
  length = 0;
  reserve(size: number) {
    const at = this.length;
    this.ensure(at + size);
    this.length += size;
    return at;
  }
  ensure(size: number) {
    if (size <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(size, this.buffer.length * 2));
    next.set(this.buffer);
    this.buffer = next;
  }
  view(at: number, size: number) {
    return new DataView(this.buffer.buffer, at, size);
  }
  set(at: number, data: Uint8Array) {
    this.buffer.set(data, at);
  }
  bytes() {
    return this.buffer.slice(0, this.length);
  }
}

type Channel4 = {
  name: string;
  type?: number;
  sync?: number;
  dataType?: number;
  byteOffset?: number;
  bitOffset?: number;
  bitCount?: number;
  flags?: number;
  invalidBit?: number;
  conversion?: number;
  unit?: string;
  composition?: number;
};

class Mdf4 {
  out = new Bytes();
  constructor(
    signature = 'MDF     ',
    private unfinalized = 0,
  ) {
    this.out.reserve(64);
    this.ascii(0, signature);
    this.ascii(8, '4.10    ');
    this.ascii(16, 'test    ');
    this.out.view(28, 2).setUint16(0, 410, true);
    this.out.view(60, 2).setUint16(0, this.unfinalized, true);
    this.block('##HD', [0, 0, 0, 0, 0, 0], 32);
  }
  ascii(at: number, text: string) {
    this.out.set(at, new TextEncoder().encode(text));
  }
  /** Appends a block; returns its offset and a view of its data section. */
  block(id: string, links: number[], dataSize: number, length?: number) {
    while (this.out.length % 8) this.out.reserve(1);
    const at = this.out.reserve(24 + links.length * 8 + dataSize);
    this.ascii(at, id);
    const head = this.out.view(at, 24 + links.length * 8);
    head.setBigUint64(
      8,
      BigInt(length ?? 24 + links.length * 8 + dataSize),
      true,
    );
    head.setBigUint64(16, BigInt(links.length), true);
    links.forEach((link, i) =>
      head.setBigUint64(24 + i * 8, BigInt(link), true),
    );
    return {
      at,
      data: this.out.view(at + 24 + links.length * 8, dataSize),
      dataAt: at + 24 + links.length * 8,
    };
  }
  tx(text: string, id = '##TX') {
    const bytes = new TextEncoder().encode(`${text}\0`);
    const block = this.block(id, [], bytes.length);
    this.out.set(block.dataAt, bytes);
    return block.at;
  }
  cc(type: number, values: number[], refs: number[] = [], unit = '') {
    const block = this.block(
      '##CC',
      [0, unit ? this.tx(unit) : 0, 0, 0, ...refs],
      24 + values.length * 8,
    );
    block.data.setUint8(0, type);
    block.data.setUint16(4, refs.length, true);
    block.data.setUint16(6, values.length, true);
    values.forEach((v, i) => block.data.setFloat64(24 + i * 8, v, true));
    return block.at;
  }
  /** Channels are linked in the order given. */
  channels(list: Channel4[]) {
    let next = 0;
    for (const channel of [...list].reverse()) {
      const name = this.tx(channel.name);
      const unit = channel.unit ? this.tx(channel.unit) : 0;
      const block = this.block(
        '##CN',
        [
          next,
          channel.composition ?? 0,
          name,
          0,
          channel.conversion ?? 0,
          0,
          unit,
          0,
        ],
        72,
      );
      const d = block.data;
      d.setUint8(0, channel.type ?? 0);
      d.setUint8(1, channel.sync ?? 0);
      d.setUint8(2, channel.dataType ?? 0);
      d.setUint8(3, channel.bitOffset ?? 0);
      d.setUint32(4, channel.byteOffset ?? 0, true);
      d.setUint32(8, channel.bitCount ?? 8, true);
      d.setUint32(12, channel.flags ?? 0, true);
      d.setUint32(16, channel.invalidBit ?? 0, true);
      next = block.at;
    }
    return next;
  }
  /** Channel groups are linked in the order given. */
  groups(
    list: {
      name?: string;
      recordId?: number;
      cycles: number;
      dataBytes: number;
      invalidBytes?: number;
      flags?: number;
      channels: number;
    }[],
  ) {
    let next = 0;
    for (const group of [...list].reverse()) {
      const block = this.block(
        '##CG',
        [next, group.channels, group.name ? this.tx(group.name) : 0, 0, 0, 0],
        32,
      );
      const d = block.data;
      d.setBigUint64(0, BigInt(group.recordId ?? 0), true);
      d.setBigUint64(8, BigInt(group.cycles), true);
      d.setUint16(16, group.flags ?? 0, true);
      d.setUint32(24, group.dataBytes, true);
      d.setUint32(28, group.invalidBytes ?? 0, true);
      next = block.at;
    }
    return next;
  }
  dt(bytes: Uint8Array, length?: number) {
    const block = this.block('##DT', [], bytes.length, length);
    this.out.set(block.dataAt, bytes);
    return block.at;
  }
  dz(bytes: Uint8Array, columns = 0, zip = columns ? 1 : 0) {
    let source = bytes;
    if (columns) {
      const rows = Math.floor(bytes.length / columns);
      source = bytes.slice();
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < columns; c++)
          source[c * rows + r] = bytes[r * columns + c];
    }
    const packed = deflateSync(source);
    const block = this.block('##DZ', [], 24 + packed.length);
    this.ascii(block.dataAt, 'DT');
    block.data.setUint8(2, zip);
    block.data.setUint32(4, columns, true);
    block.data.setBigUint64(8, BigInt(bytes.length), true);
    block.data.setBigUint64(16, BigInt(packed.length), true);
    this.out.set(block.dataAt + 24, packed);
    return block.at;
  }
  dl(items: number[], next = 0) {
    const block = this.block('##DL', [next, ...items], 8 + items.length * 8);
    block.data.setUint32(4, items.length, true);
    return block.at;
  }
  hl(first: number) {
    return this.block('##HL', [first], 8).at;
  }
  /** Data groups are linked in the order given. */
  finish(list: { idSize?: number; groups: number; data: number }[]) {
    let next = 0;
    for (const group of [...list].reverse()) {
      const block = this.block('##DG', [next, group.groups, group.data, 0], 8);
      block.data.setUint8(0, group.idSize ?? 0);
      next = block.at;
    }
    this.out.view(64 + 24, 8).setBigUint64(0, BigInt(next), true);
    return new Blob([this.out.bytes()]);
  }
}

/** Packs records with a DataView writer per record. */
function records(
  count: number,
  size: number,
  write: (view: DataView, index: number) => void,
) {
  const bytes = new Uint8Array(count * size);
  for (let i = 0; i < count; i++)
    write(new DataView(bytes.buffer, i * size, size), i);
  return bytes;
}

/** A time channel (float64 at byte 0) plus the given channels. */
function timed(m: Mdf4, list: Channel4[]) {
  return m.channels([
    { name: 'time', type: 2, sync: 1, dataType: 4, bitCount: 64, unit: 's' },
    ...list,
  ]);
}

void test('bit fields, byte orders, float16, 64-bit integers and invalidation', async () => {
  const m = new Mdf4();
  const n = 50;
  const size = 8 + 2 + 2 + 2 + 8 + 3 + 1;
  const data = records(n, size, (v, i) => {
    v.setFloat64(0, i * 0.1, true);
    // 12-bit field at bit 4 of a little-endian word, with junk around it.
    v.setUint16(8, ((i * 37) << 4) | 0x000f | 0, true);
    // Signed 10-bit big-endian field at bit 3.
    const s10 = ((i * 13 - 300) & 0x3ff) << 3;
    v.setUint16(10, s10 | 0x7, false);
    // float16 big-endian: 1.5 * i in half precision (exact for small i).
    v.setUint16(12, half(1.5 * i), false);
    // 64-bit unsigned above 2^53 / 2^32 boundaries, little-endian.
    v.setBigUint64(14, BigInt(i) * BigInt(2 ** 40) + BigInt(7), true);
    // 24-bit signed little-endian.
    const s24 = (i * 99991 - 4_000_000) & 0xffffff;
    v.setUint8(22, s24 & 0xff);
    v.setUint8(23, (s24 >> 8) & 0xff);
    v.setUint8(24, s24 >> 16);
    // Invalidation byte: bit 2 marks Wide invalid on every fourth record.
    v.setUint8(25, i % 4 === 1 ? 0b100 : 0b011);
  });
  const cn = timed(m, [
    { name: 'Nibble', byteOffset: 8, bitOffset: 4, bitCount: 12 },
    { name: 'Signed', dataType: 3, byteOffset: 10, bitOffset: 3, bitCount: 10 },
    { name: 'Half', dataType: 5, byteOffset: 12, bitCount: 16 },
    {
      name: 'Wide',
      byteOffset: 14,
      bitCount: 64,
      flags: 2,
      invalidBit: 2,
    },
    { name: 'Odd', dataType: 2, byteOffset: 22, bitCount: 24 },
    { name: 'Gone', byteOffset: 8, bitCount: 8, flags: 1 },
  ]);
  const cg = m.groups([
    { cycles: n, dataBytes: size - 1, invalidBytes: 1, channels: cn },
  ]);
  const file = await openMdf(m.finish([{ groups: cg, data: m.dt(data) }]));
  assert.equal(file.tables[0].name, 'Group 1');
  assert.equal(file.tables[0].notes, undefined);
  const got = await readAll(file, 0);
  for (let i = 0; i < n; i++) {
    close(got.time[i], i * 0.1, 'time');
    assert.equal(got.values[0][i], (i * 37) & 0xfff);
    const s = (i * 13 - 300) & 0x3ff;
    assert.equal(got.values[1][i], s >= 512 ? s - 1024 : s);
    assert.equal(got.values[2][i], 1.5 * i);
    if (i % 4 === 1) assert.ok(Number.isNaN(got.values[3][i]));
    else assert.equal(got.values[3][i], i * 2 ** 40 + 7);
    assert.equal(got.values[4][i], i * 99991 - 4_000_000);
    assert.ok(Number.isNaN(got.values[5][i]));
  }
});

/** Rounds to IEEE half precision bits (normal numbers only). */
function half(value: number) {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log2(Math.abs(value)));
  const fraction = Math.round((Math.abs(value) / 2 ** exponent - 1) * 1024);
  return (value < 0 ? 0x8000 : 0) | ((exponent + 15) << 10) | fraction;
}

void test('unsorted groups with VLSD records straddle tiny linked blocks', async () => {
  const m = new Mdf4();
  // Group A: id 1, time f64 + int16 (10 bytes); group B: id 2, time f64 +
  // u8 + f32 (13 bytes); VLSD strings: id 3.
  const stream: number[] = [];
  const expectA: [number, number][] = [];
  const expectB: [number, number, number][] = [];
  const push = (bytes: Uint8Array) => stream.push(...bytes);
  for (let i = 0; i < 300; i++) {
    const a = new DataView(new ArrayBuffer(11));
    a.setUint8(0, 1);
    a.setFloat64(1, i * 0.01, true);
    a.setInt16(9, i * 7 - 1000, true);
    push(new Uint8Array(a.buffer));
    expectA.push([i * 0.01, i * 7 - 1000]);
    if (i % 3 === 0) {
      const b = new DataView(new ArrayBuffer(14));
      b.setUint8(0, 2);
      b.setFloat64(1, i * 0.01 + 0.005, true);
      b.setUint8(9, i % 256);
      b.setFloat32(10, i / 4, true);
      push(new Uint8Array(b.buffer));
      expectB.push([i * 0.01 + 0.005, i % 256, i / 4]);
    }
    if (i % 5 === 0) {
      const text = new TextEncoder().encode(`label ${i}`);
      const s = new DataView(new ArrayBuffer(5 + text.length));
      s.setUint8(0, 3);
      s.setUint32(1, text.length, true);
      new Uint8Array(s.buffer).set(text, 5);
      push(new Uint8Array(s.buffer));
    }
  }
  const bytes = Uint8Array.from(stream);
  // Odd block sizes split records, IDs and VLSD length prefixes.
  const blocks: number[] = [];
  for (let at = 0, k = 0; at < bytes.length; k++) {
    const size = [7, 1, 13, 64, 3, 200][k % 6];
    blocks.push(m.dt(bytes.subarray(at, at + size)));
    at += size;
  }
  let list = 0;
  for (let i = blocks.length; i > 0; i -= 40)
    list = m.dl(blocks.slice(Math.max(0, i - 40), i), list);
  const a = timed(m, [
    { name: 'Torque', dataType: 2, byteOffset: 8, bitCount: 16 },
  ]);
  const b = timed(m, [
    { name: 'Gear', byteOffset: 8, bitCount: 8 },
    { name: 'Level', dataType: 4, byteOffset: 9, bitCount: 32, unit: 'mm' },
  ]);
  const cg = m.groups([
    { name: 'Fast', recordId: 1, cycles: 300, dataBytes: 10, channels: a },
    { name: 'Slow', recordId: 2, cycles: 100, dataBytes: 13, channels: b },
    { recordId: 3, cycles: 60, dataBytes: 0, flags: 1, channels: 0 },
  ]);
  const file = await openMdf(
    m.finish([{ idSize: 1, groups: cg, data: m.hl(list) }]),
  );
  assert.deepEqual(
    file.tables.map((t) => [t.name, t.rows, t.channels.length]),
    [
      ['Fast', 300, 1],
      ['Slow', 100, 2],
    ],
  );
  assert.equal(file.tables[1].channels[1].unit, 'mm');
  const fast = await readAll(file, 0);
  assert.deepEqual(
    fast.time.map((t, i) => [t, fast.values[0][i]]),
    expectA,
  );
  const slow = await readAll(file, 1);
  assert.deepEqual(
    slow.time.map((t, i) => [t, slow.values[0][i], slow.values[1][i]]),
    expectB,
  );
});

void test('deflate and transposed DZ blocks, master conversions and virtual channels', async () => {
  const m = new Mdf4();
  const n = 1000;
  const size = 6;
  const data = records(n, size, (v, i) => {
    v.setUint32(0, i * 3, true);
    v.setInt16(4, i - 500, true);
  });
  // Time ticks of 1 ms with an offset, through a linear master conversion.
  const timeCc = m.cc(1, [2, 0.001]);
  const formula = m.cc(3, [], [m.tx('-X^2 / 1000 + 2**3 * sqrt(abs(X))')]);
  const cn = m.channels([
    { name: 't', type: 2, sync: 1, bitCount: 32, conversion: timeCc },
    {
      name: 'Shape',
      dataType: 2,
      byteOffset: 4,
      bitCount: 16,
      conversion: formula,
    },
    { name: 'Index', type: 6, conversion: m.cc(1, [10, 2]) },
  ]);
  const cg = m.groups([{ cycles: n, dataBytes: size, channels: cn }]);
  const chunks = [
    m.dz(data.subarray(0, 1201), 6),
    m.dz(data.subarray(1201, 3000)),
    m.dt(data.subarray(3000, 3001)),
    m.dz(data.subarray(3001), 6),
  ];
  const file = await openMdf(m.finish([{ groups: cg, data: m.dl(chunks) }]));
  assert.equal(file.tables[0].rows, n);
  const got = await readAll(file, 0);
  for (let i = 0; i < n; i++) {
    close(got.time[i], 2 + i * 3 * 0.001, `time ${i}`);
    const x = i - 500;
    close(
      got.values[0][i],
      (-x * x) / 1000 + 8 * Math.sqrt(Math.abs(x)),
      'shape',
    );
    assert.equal(got.values[1][i], 10 + 2 * i);
  }
});

void test('a virtual angle master, missing masters and nested conversions', async () => {
  const m = new Mdf4();
  const angle = m.channels([
    {
      name: 'Crank',
      type: 3,
      sync: 2,
      unit: 'rad',
      conversion: m.cc(1, [0, 0.5]),
    },
    { name: 'Pressure', bitCount: 8 },
  ]);
  const nomaster = m.channels([
    // Value-to-value without interpolation: ties take the lower key.
    { name: 'Step', bitCount: 8, conversion: m.cc(5, [0, 10, 2, 20, 4, 40]) },
    // Value ranges on floats exclude their upper end.
    {
      name: 'Band',
      dataType: 4,
      byteOffset: 1,
      bitCount: 32,
      conversion: m.cc(6, [0, 1, 100, 1, 2, 200, -1]),
    },
    {
      name: 'State',
      byteOffset: 5,
      bitCount: 8,
      conversion: m.cc(7, [0, 1], [m.tx('off'), m.tx('on'), 0]),
    },
    {
      name: 'Broken',
      byteOffset: 5,
      bitCount: 8,
      conversion: m.cc(3, [], [m.tx('X +* 2')]),
    },
    { name: 'Text', dataType: 7, byteOffset: 5, bitCount: 8 },
    { name: 'Array', byteOffset: 5, bitCount: 8, composition: 64 },
  ]);
  const cg1 = m.groups([{ cycles: 4, dataBytes: 1, channels: angle }]);
  const cg2 = m.groups([{ cycles: 5, dataBytes: 6, channels: nomaster }]);
  const step = [0, 1, 2, 3, 5];
  const band = [0, 0.5, 1, 1.5, 2];
  const file = await openMdf(
    m.finish([
      { groups: cg1, data: m.dt(Uint8Array.from([5, 6, 7, 8])) },
      {
        groups: cg2,
        data: m.dt(
          records(5, 6, (v, i) => {
            v.setUint8(0, step[i]);
            v.setFloat32(1, band[i], true);
            v.setUint8(5, i % 2);
          }),
        ),
      },
    ]),
  );
  assert.deepEqual(file.notes, [
    'Skipped 2 text or unsupported channels: Text, Array.',
    'Skipped 1 channel whose conversion formula could not be evaluated: Broken.',
  ]);
  assert.deepEqual(file.tables[0].notes, [
    'The axis is the master channel “Crank”, which is an angle in rad, not time.',
  ]);
  assert.deepEqual(file.tables[1].notes, [
    'No time channel: time is the sample number.',
    'Text labels were not applied to State; raw values are shown.',
  ]);
  const first = await readAll(file, 0);
  assert.deepEqual(first.time, [0, 0.5, 1, 1.5]);
  assert.deepEqual(first.values, [[5, 6, 7, 8]]);
  const second = await readAll(file, 1);
  assert.deepEqual(second.time, [0, 1, 2, 3, 4]);
  assert.deepEqual(second.values, [
    [10, 10, 20, 20, 40],
    [100, 100, 200, 200, -1],
    [0, 1, 0, 1, 0],
  ]);
});

void test('groups of only virtual channels need no data blocks', async () => {
  const m = new Mdf4();
  const cn = m.channels([
    { name: 't', type: 3, sync: 1, conversion: m.cc(1, [1, 0.25]) },
    { name: 'Sample', type: 6 },
  ]);
  const cg = m.groups([{ cycles: 3, dataBytes: 0, channels: cn }]);
  const file = await openMdf(m.finish([{ groups: cg, data: 0 }]));
  assert.equal(file.tables[0].rows, 3);
  const got = await readAll(file, 0);
  assert.deepEqual(got.time, [1, 1.25, 1.5]);
  assert.deepEqual(got.values, [[0, 1, 2]]);
});

void test('a long sorted group streams bounded blocks with rising progress', async () => {
  const m = new Mdf4();
  const n = BLOCK_ROWS * 2 + 1234;
  const data = records(n, 10, (v, i) => {
    v.setFloat64(0, i / 1000, true);
    v.setUint16(8, i & 0xffff, true);
  });
  const blocks: number[] = [];
  for (let at = 0; at < data.length; at += 100_003)
    blocks.push(m.dt(data.subarray(at, at + 100_003)));
  const cg = m.groups([
    {
      cycles: n,
      dataBytes: 10,
      channels: timed(m, [{ name: 'Count', byteOffset: 8, bitCount: 16 }]),
    },
  ]);
  const file = await openMdf(m.finish([{ groups: cg, data: m.dl(blocks) }]));
  const got = await readAll(file, 0);
  assert.deepEqual(got.sizes, [BLOCK_ROWS, BLOCK_ROWS, 1234]);
  assert.ok(got.progress.every((p, i) => i === 0 || p >= got.progress[i - 1]));
  assert.ok(got.progress[0] > 0.4 && got.progress[0] < 0.6);
  assert.equal(got.progress.at(-1), 1);
  assert.equal(got.values[0][n - 1], (n - 1) & 0xffff);
  assert.equal(got.time[n - 1], (n - 1) / 1000);
});

void test('unfinalized files read the records that are present', async () => {
  const m = new Mdf4('UnFinMF ', 1 | 4);
  const data = records(7, 9, (v, i) => {
    v.setFloat64(0, i, true);
    v.setUint8(8, i * 2);
  });
  const cg = m.groups([
    {
      cycles: 0,
      dataBytes: 9,
      channels: timed(m, [{ name: 'Level', byteOffset: 8 }]),
    },
  ]);
  const dg = m.finish([{ groups: cg, data: 0 }]);
  // The DT block comes last, with its length never updated, and the final
  // record cut short.
  const head = new Uint8Array(await dg.arrayBuffer());
  const out = new Bytes();
  out.set(out.reserve(head.length), head);
  while (out.length % 8) out.reserve(1);
  const dt = out.reserve(24);
  out.set(dt, new TextEncoder().encode('##DT'));
  out.view(dt + 8, 8).setBigUint64(0, BigInt(24), true);
  out.set(out.reserve(data.length - 4), data.subarray(0, data.length - 4));
  // Point the data group at it.
  const bytes = out.bytes();
  const view = new DataView(bytes.buffer);
  const dgAt = Number(view.getBigUint64(64 + 24, true));
  view.setBigUint64(dgAt + 24 + 16, BigInt(dt), true);
  const file = await openMdf(new Blob([bytes]));
  assert.equal(file.tables[0].rows, 6);
  assert.match(file.notes?.[0] ?? '', /did not finalize/);
  const got = await readAll(file, 0);
  assert.deepEqual(got.time, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(got.values, [[0, 2, 4, 6, 8, 10]]);
});

void test('names are unique and group size is limited', async () => {
  const m = new Mdf4();
  const cn = m.channels([{ name: 'A' }, { name: 'a' }, { name: 'B' }]);
  const one = m.groups([
    { name: 'Rig', cycles: 1, dataBytes: 1, channels: cn },
  ]);
  const two = m.groups([
    { name: 'rig', cycles: 1, dataBytes: 1, channels: cn },
  ]);
  const three = m.groups([{ cycles: 1, dataBytes: 1, channels: cn }]);
  const d = () => m.dt(Uint8Array.from([1]));
  const file = await openMdf(
    m.finish([
      { groups: one, data: d() },
      { groups: two, data: d() },
      { groups: three, data: d() },
    ]),
  );
  assert.deepEqual(
    file.tables.map((t) => t.name),
    ['Rig', 'rig (2)', 'Group 3'],
  );
  assert.deepEqual(
    file.tables[0].channels.map((c) => c.name),
    ['A', 'a (2)', 'B'],
  );

  const big = new Mdf4();
  const many = big.channels(
    Array.from({ length: MAX_RECORDING_CHANNELS + 1 }, (_, i) => ({
      name: `C${i}`,
    })),
  );
  const cg = big.groups([
    { name: 'Wide rig', cycles: 1, dataBytes: 1, channels: many },
  ]);
  await assert.rejects(
    openMdf(big.finish([{ groups: cg, data: big.dt(Uint8Array.from([0])) }])),
    /The group “Wide rig” has 1,025 channels/,
  );
});

void test('damaged and empty files give plain-language errors', async () => {
  const empty = new Mdf4();
  await assert.rejects(openMdf(empty.finish([])), /no measured data/);

  const text = new Mdf4();
  const cg = text.groups([
    {
      cycles: 1,
      dataBytes: 1,
      channels: text.channels([{ name: 'S', dataType: 6 }]),
    },
  ]);
  await assert.rejects(
    openMdf(
      text.finish([{ groups: cg, data: text.dt(Uint8Array.from([65])) }]),
    ),
    /no numeric channels/,
  );

  // A channel whose next link points back at itself.
  const loop = new Mdf4();
  const cn = loop.channels([{ name: 'A' }]);
  loop.out.view(cn + 24, 8).setBigUint64(0, BigInt(cn), true);
  const lg = loop.groups([{ cycles: 1, dataBytes: 1, channels: cn }]);
  await assert.rejects(
    openMdf(loop.finish([{ groups: lg, data: 0 }])),
    /damaged \(its blocks link in a loop\)/,
  );

  // A data list that links to itself.
  const dlLoop = new Mdf4();
  const dl = dlLoop.dl([dlLoop.dt(Uint8Array.from([1]))]);
  dlLoop.out.view(dl + 24, 8).setBigUint64(0, BigInt(dl), true);
  const dg = dlLoop.groups([
    { cycles: 1, dataBytes: 1, channels: dlLoop.channels([{ name: 'A' }]) },
  ]);
  await assert.rejects(
    openMdf(dlLoop.finish([{ groups: dg, data: dl }])),
    /link in a loop/,
  );

  // An unknown record ID in an unsorted group.
  const ids = new Mdf4();
  const ig = ids.groups([
    {
      recordId: 1,
      cycles: 2,
      dataBytes: 1,
      channels: ids.channels([{ name: 'A' }]),
    },
  ]);
  const file = await openMdf(
    ids.finish([
      { idSize: 1, groups: ig, data: ids.dt(Uint8Array.from([1, 5, 9, 5])) },
    ]),
  );
  await assert.rejects(readAll(file, 0), /unknown ID/);

  const zstd = new Mdf4();
  const zg = zstd.groups([
    { cycles: 1, dataBytes: 1, channels: zstd.channels([{ name: 'A' }]) },
  ]);
  await assert.rejects(
    openMdf(
      zstd.finish([{ groups: zg, data: zstd.dz(Uint8Array.from([1]), 0, 2) }]),
    ),
    /ZSTD or LZ4/,
  );

  await assert.rejects(
    openMdf(new Blob([new Uint8Array(100)])),
    /does not start like an MDF file/,
  );
  const truncated = new Uint8Array(
    await (
      await (async () => {
        const t = new Mdf4();
        const tg = t.groups([
          { cycles: 1, dataBytes: 1, channels: t.channels([{ name: 'A' }]) },
        ]);
        return t.finish([{ groups: tg, data: t.dt(Uint8Array.from([1])) }]);
      })()
    ).arrayBuffer(),
  );
  await assert.rejects(
    openMdf(new Blob([truncated.subarray(0, 200)])),
    /shorter than its own metadata/,
  );
});

// ---------------------------------------------------------------------------
// Hand-built MDF 3: big-endian, unsorted with IDs around records.

/** MDF 3 text is Latin-1: one byte per character. */
const latin1 = (text: string) =>
  Uint8Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

class Mdf3 {
  out = new Bytes();
  constructor(private little: boolean) {
    this.out.reserve(64);
    this.out.set(0, new TextEncoder().encode('MDF     3.30    test    '));
    this.out.view(24, 2).setUint16(0, little ? 0 : 1, true);
    this.u16(28, 330);
    const hd = this.block('HD', 164);
    assert.equal(hd, 64);
  }
  u16(at: number, value: number) {
    this.out.view(at, 2).setUint16(0, value, this.little);
  }
  u32(at: number, value: number) {
    this.out.view(at, 4).setUint32(0, value, this.little);
  }
  f64(at: number, value: number) {
    this.out.view(at, 8).setFloat64(0, value, this.little);
  }
  block(id: string, size: number) {
    const at = this.out.reserve(size);
    this.out.set(at, new TextEncoder().encode(id));
    this.u16(at + 2, size);
    return at;
  }
  tx(text: string) {
    const bytes = latin1(text);
    const at = this.block('TX', 5 + bytes.length);
    this.out.set(at + 4, bytes);
    return at;
  }
  cc(type: number, params: number[], unit = '', formula = '') {
    const size = formula ? 46 + 256 : 46 + params.length * 8;
    const at = this.block('CC', size);
    this.out.set(at + 22, latin1(unit));
    this.u16(at + 42, type);
    this.u16(
      at + 44,
      formula
        ? 0
        : type === 1 || type === 2
          ? params.length / 2
          : params.length,
    );
    if (formula) this.out.set(at + 46, new TextEncoder().encode(formula));
    else params.forEach((p, i) => this.f64(at + 46 + i * 8, p));
    return at;
  }
  channels(
    list: {
      name: string;
      long?: string;
      type?: number;
      start?: number;
      extra?: number;
      bits: number;
      dataType: number;
      cc?: number;
    }[],
  ) {
    let next = 0;
    for (const c of [...list].reverse()) {
      const long = c.long ? this.tx(c.long) : 0;
      const at = this.block('CN', 228);
      this.u32(at + 4, next);
      this.u32(at + 8, c.cc ?? 0);
      this.u16(at + 24, c.type ?? 0);
      this.out.set(at + 26, latin1(c.name));
      this.u16(at + 186, c.start ?? 0);
      this.u16(at + 188, c.bits);
      this.u16(at + 190, c.dataType);
      this.u32(at + 218, long);
      this.u16(at + 226, c.extra ?? 0);
      next = at;
    }
    return next;
  }
  group(
    cn: number,
    recordId: number,
    recordSize: number,
    cycles: number,
    next = 0,
  ) {
    const at = this.block('CG', 30);
    this.u32(at + 4, next);
    this.u32(at + 8, cn);
    this.u16(at + 16, recordId);
    this.u16(at + 20, recordSize);
    this.u32(at + 22, cycles);
    return at;
  }
  finish(cg: number, ids: number, data: Uint8Array) {
    const dataAt = this.out.reserve(data.length);
    this.out.set(dataAt, data);
    const dg = this.block('DG', 28);
    this.u32(dg + 8, cg);
    this.u32(dg + 16, dataAt);
    this.u16(dg + 22, ids);
    this.u32(64 + 4, dg);
    return new Blob([this.out.bytes()]);
  }
}

void test('MDF 3 big-endian unsorted records with every numeric conversion', async () => {
  const m = new Mdf3(false);
  const poly = [1.5, 2, 0.5, 3, 1, 1];
  const expo = [2, 0.5, 1, 0, 0, 1, 3];
  const loga = [4, 2, 1, 0, 0, 1, 0];
  // Group 1: time u16 (×0.01 s) + u8 polynomial + 12-bit at bit 4 of byte
  // 3 (via additional byte offset) + exponential + logarithmic.
  const g1 = m.channels([
    {
      name: 'time',
      type: 1,
      bits: 16,
      dataType: 0,
      cc: m.cc(0, [0, 0.01], 's'),
    },
    { name: 'Poly', start: 16, bits: 8, dataType: 0, cc: m.cc(6, poly) },
    {
      name: 'short',
      long: 'Drehzahl µ lang',
      start: 4,
      extra: 3,
      bits: 12,
      dataType: 0,
      cc: m.cc(65535, [], 'U/min'),
    },
    { name: 'Expo', start: 40, bits: 8, dataType: 13, cc: m.cc(7, expo) },
    { name: 'Log', start: 48, bits: 8, dataType: 0, cc: m.cc(8, loga) },
    {
      name: 'Formula',
      start: 56,
      bits: 16,
      dataType: 1,
      cc: m.cc(10, [], '', 'X1 * 2 - 1'),
    },
    {
      name: 'Table',
      start: 72,
      bits: 8,
      dataType: 0,
      cc: m.cc(1, [0, 0, 10, 100]),
    },
    { name: 'Text', start: 72, bits: 8, dataType: 0, cc: m.cc(11, []) },
    { name: 'Str', start: 72, bits: 8, dataType: 7 },
  ]);
  // Group 2: little-endian double (type 16) without a time channel.
  const g2 = m.channels([{ name: 'Level', bits: 64, dataType: 16 }]);
  const second = m.group(g2, 2, 8, 3);
  const first = m.group(g1, 1, 10, 4, second);
  const rows: number[] = [];
  const add = (id: number, body: DataView) => {
    rows.push(id, ...new Uint8Array(body.buffer), id);
  };
  const raw = [
    [0, 3, 0x123, 5, 3, 7, 4],
    [100, 7, 0xfff, 9, 5, -3, 5],
    [200, 11, 0x001, 12, 9, 100, 9],
    [300, 4, 0x800, 7, 2, 0, 10],
  ];
  raw.forEach(([t, p, w, e, l, f, tab], i) => {
    const v = new DataView(new ArrayBuffer(10));
    v.setUint16(0, t, false);
    v.setUint8(2, p);
    v.setUint16(3, (w << 4) | 0xf, false);
    v.setUint8(5, e);
    v.setUint8(6, l);
    v.setInt16(7, f, false);
    v.setUint8(9, tab);
    add(1, v);
    if (i < 3) {
      const d = new DataView(new ArrayBuffer(8));
      d.setFloat64(0, i + 0.25, true);
      add(2, d);
    }
  });
  const file = await openMdf(m.finish(first, 2, Uint8Array.from(rows)));
  assert.equal(file.format, 'ASAM MDF 3.30');
  assert.deepEqual(file.notes, ['Skipped 1 text or unsupported channel: Str.']);
  assert.deepEqual(
    file.tables.map((t) => [t.name, t.rows]),
    [
      ['Group 1', 4],
      ['Group 2', 3],
    ],
  );
  assert.deepEqual(
    file.tables[0].channels.map((c) => [c.name, c.unit]),
    [
      ['Poly', '—'],
      ['Drehzahl µ lang', 'U/min'],
      ['Expo', '—'],
      ['Log', '—'],
      ['Formula', '—'],
      ['Table', '—'],
      ['Text', '—'],
    ],
  );
  const got = await readAll(file, 0);
  raw.forEach(([t, p, w, e, l, f, tab], i) => {
    close(got.time[i], t * 0.01, 'time');
    const [p1, p2, p3, p4, p5, p6] = poly;
    close(
      got.values[0][i],
      (p2 - p4 * (p - p5 - p6)) / (p3 * (p - p5 - p6) - p1),
      'poly',
    );
    assert.equal(got.values[1][i], w);
    close(
      got.values[2][i],
      Math.log(((e - expo[6]) * expo[5] - expo[2]) / expo[0]) / expo[1],
      'expo',
    );
    close(
      got.values[3][i],
      Math.exp(((l - loga[6]) * loga[5] - loga[2]) / loga[0]) / loga[1],
      'log',
    );
    assert.equal(got.values[4][i], f * 2 - 1);
    assert.equal(got.values[5][i], Math.min(100, tab * 10));
    assert.equal(got.values[6][i], tab);
  });
  const level = await readAll(file, 1);
  assert.deepEqual(level.time, [0, 1, 2]);
  assert.deepEqual(level.values, [[0.25, 1.25, 2.25]]);
  assert.deepEqual(file.tables[1].notes, [
    'No time channel: time is the sample number.',
  ]);
});

void test('formulas compile without eval and reject anything else', () => {
  const cases: [string, number, number][] = [
    ['-2^2', 0, -4],
    ['2^3^2', 0, 512],
    ['2**-1', 0, 0.5],
    ['sin(pi/2) + cos(0)', 0, 2],
    ['(X + 1) * (X - 1)', 3, 8],
    ['-X', 5, -5],
    ['--X', 5, 5],
    ['+X * .5e1', 2, 10],
    ['ln(exp(X)) + log10(100)', 1.5, 3.5],
    ['10 - 4 - 3', 0, 3],
    ['8 / 4 / 2', 0, 1],
    ['abs(-X) * sqrt(16)', 2, 8],
  ];
  for (const [text, x, y] of cases) {
    const f = compileFormula(text);
    assert.ok(f, text);
    close(f(x), y, text);
  }
  for (const bad of [
    '',
    'X +',
    '(X',
    'X)',
    'foo(X)',
    'eval(1)',
    'X Y',
    '1,2',
    'sin X',
    'constructor',
    'X; alert(1)',
  ])
    assert.equal(compileFormula(bad), null, bad);
});
