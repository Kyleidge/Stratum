import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openMat } from '../lib/formats/mat';
import { BLOCK_ROWS } from '../lib/formats/recording';
import type { RecordingFile } from '../lib/formats/recording';

const fixture = (name: string) =>
  new Blob([
    readFileSync(new URL(`./fixtures/formats/${name}`, import.meta.url)),
  ]);

async function columns(file: RecordingFile, table: number) {
  const time: number[] = [];
  const values: number[][] = file.tables[table].channels.map(() => []);
  for await (const block of file.read(table)) {
    time.push(...block.time);
    block.values.forEach((column, c) => values[c].push(...column));
  }
  return { time, values };
}
const labels = (file: RecordingFile, table: number) =>
  file.tables[table].channels.map((c) => `${c.name} [${c.unit}]`);
const close = (actual: number[], expected: number[], tolerance = 1e-12) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) <= tolerance,
      `sample ${i}: ${value} ≠ ${expected[i]}`,
    ),
  );
};
const range = <T>(n: number, f: (i: number) => T) =>
  Array.from({ length: n }, (_, i) => f(i));

// ------------------------------------------------ Level 5 file builder

const MI = { INT8: 1, UINT8: 2, INT16: 3, INT32: 5, UINT32: 6, DOUBLE: 9 };
const MI_MATRIX = 14;
const MI_COMPRESSED = 15;
const MX = { CELL: 1, STRUCT: 2, CHAR: 4, DOUBLE: 6, INT16: 10, OPAQUE: 17 };

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
function numbers(
  values: number[],
  type: 'f64' | 'i32' | 'u32' | 'i16',
  little: boolean,
) {
  const size = type === 'f64' ? 8 : type === 'i16' ? 2 : 4;
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    if (type === 'f64') view.setFloat64(i * size, value, little);
    else if (type === 'i32') view.setInt32(i * size, value, little);
    else if (type === 'u32') view.setUint32(i * size, value, little);
    else view.setInt16(i * size, value, little);
  });
  return out;
}
const ascii = (text: string) => new TextEncoder().encode(text);

/** A data element; data of up to four bytes is packed into its tag. */
function element(type: number, data: Uint8Array, little: boolean) {
  if (data.length <= 4 && type !== MI_MATRIX) {
    const tag = numbers([(data.length << 16) | type], 'u32', little);
    return concat(tag, data, new Uint8Array(4 - data.length));
  }
  return concat(
    numbers([type, data.length], 'u32', little),
    data,
    new Uint8Array((8 - (data.length % 8)) % 8),
  );
}
function matrix(
  little: boolean,
  kind: number,
  dims: number[],
  name: string,
  body: Uint8Array[],
  flags = 0,
) {
  return element(
    MI_MATRIX,
    concat(
      element(MI.UINT32, numbers([kind | flags, 0], 'u32', little), little),
      element(MI.INT32, numbers(dims, 'i32', little), little),
      element(MI.INT8, ascii(name), little),
      ...body,
    ),
    little,
  );
}
const double = (
  name: string,
  dims: number[],
  values: number[],
  little = true,
) =>
  matrix(little, MX.DOUBLE, dims, name, [
    element(MI.DOUBLE, numbers(values, 'f64', little), little),
  ]);
const text = (name: string, value: string, little = true) =>
  matrix(little, MX.CHAR, [1, value.length], name, [
    element(MI.UINT8, ascii(value), little),
  ]);
/** A struct whose elements list their field matrices in field order. */
function struct(
  name: string,
  dims: number[],
  fields: string[],
  elements: Uint8Array[][],
  little = true,
) {
  const width = 32;
  const names = new Uint8Array(width * fields.length);
  fields.forEach((field, i) => names.set(ascii(field), i * width));
  return matrix(little, MX.STRUCT, dims, name, [
    element(MI.INT32, numbers([width], 'i32', little), little),
    element(MI.INT8, names, little),
    ...elements.flat(),
  ]);
}
async function compress(data: Uint8Array, little = true) {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  // Compressed elements are not padded.
  return concat(numbers([MI_COMPRESSED, packed.length], 'u32', little), packed);
}
function level5(parts: Uint8Array[], little = true, version = 0x0100) {
  const header = new Uint8Array(128).fill(32);
  header.set(ascii('MATLAB 5.0 MAT-file, Platform: test'));
  header.fill(0, 116, 124);
  new DataView(header.buffer).setUint16(124, version, little);
  header.set(ascii(little ? 'IM' : 'MI'), 126);
  return new Blob([concat(header, ...parts) as BlobPart]);
}
function level4(
  name: string,
  rows: number,
  cols: number,
  values: number[],
  little: boolean,
) {
  const header = numbers(
    [little ? 0 : 1000, rows, cols, 0, name.length + 1],
    'i32',
    little,
  );
  return concat(
    header,
    ascii(name),
    new Uint8Array(1),
    numbers(values, 'f64', little),
  );
}

// ------------------------------------------------ Fixtures

void test('MAT Level 5 fixture: tables, struct fields, Simulink logs and notes', async () => {
  const file = await openMat(fixture('mat-v5.mat'));
  assert.equal(file.format, 'MATLAB MAT Level 5');
  assert.ok(Object.hasOwn(file, 'read'));
  assert.deepEqual(
    file.tables.map((t) => [t.name, t.rows, t.start, t.end]),
    [
      ['t', 200, 0, 0.199],
      ['logsout.time', 50, 0, 0.49],
      ['slog.time', 30, 0, 29 * 0.1],
    ],
  );
  assert.deepEqual(labels(file, 0), [
    'speed [—]',
    'torque [—]',
    'counts [—]',
    'valid [—]',
    'ticks [—]',
    'accel(:,1) [—]',
    'accel(:,2) [—]',
    'accel(:,3) [—]',
    'cfg.offsets [—]',
    'cfg.inner.deep [—]',
  ]);
  // Unlabelled Simulink signals fall back to their block name.
  assert.deepEqual(labels(file, 1), [
    'Pressure [bar]',
    'model/Flow(:,1) [—]',
    'model/Flow(:,2) [—]',
  ]);
  assert.deepEqual(labels(file, 2), ['Temp [degC]']);
  assert.deepEqual(file.notes, [
    'Skipped 3 variables that are not a real numeric array: description (text), parts (cell array), z (complex).',
  ]);
  assert.deepEqual(file.tables[0].notes, []);

  const main = await columns(file, 0);
  const t = range(200, (i) => i * 0.001);
  close(main.time, t);
  close(
    main.values[0],
    t.map((x) => Math.sin(2 * Math.PI * 5 * x)),
  );
  close(
    main.values[1],
    t.map((x) => Math.fround(10 + x)),
    0,
  );
  close(
    main.values[2],
    range(200, (i) => i - 100),
    0,
  );
  close(
    main.values[3],
    range(200, (i) => (i % 2 ? 0 : 1)),
    0,
  );
  close(
    main.values[4],
    range(200, (i) => i * 1000),
    0,
  );
  close(
    main.values[6],
    t.map((x) => 2 * x),
  );
  close(
    main.values[8],
    range(200, () => 0.5),
    0,
  );
  close(
    main.values[9],
    range(200, (i) => -1 + (2 * i) / 199),
  );
  const log = await columns(file, 1);
  close(
    log.values[0],
    range(50, (i) => 1 + i / 49),
  );
  close(
    log.values[1],
    range(50, () => 1),
    0,
  );
  close(
    log.values[2],
    range(50, () => 0),
    0,
  );
});

void test('MAT v7 compressed fixture reads the same samples as Level 5', async () => {
  const plain = await openMat(fixture('mat-v5.mat'));
  const packed = await openMat(fixture('mat-v7.mat'));
  assert.equal(packed.format, 'MATLAB MAT Level 5, compressed');
  assert.deepEqual(
    packed.tables.map(({ name, channels, rows }) => ({ name, channels, rows })),
    plain.tables.map(({ name, channels, rows }) => ({ name, channels, rows })),
  );
  assert.deepEqual(packed.notes, plain.notes);
  for (let table = 0; table < plain.tables.length; table++)
    assert.deepEqual(await columns(packed, table), await columns(plain, table));
});

void test('MAT Level 4 fixture uses its time vector and notes text', async () => {
  const file = await openMat(fixture('mat-v4.mat'));
  assert.equal(file.format, 'MATLAB MAT Level 4');
  assert.equal(file.tables.length, 1);
  assert.equal(file.tables[0].name, '');
  assert.deepEqual(labels(file, 0), ['x [—]', 'm(:,1) [—]', 'm(:,2) [—]']);
  assert.deepEqual(file.notes, [
    'Skipped a variable that is not a real numeric array: label (text).',
  ]);
  const { time, values } = await columns(file, 0);
  close(
    time,
    range(100, (i) => i * 0.5),
  );
  close(
    values[0],
    range(100, (i) => Math.cos(i / 10)),
  );
  close(
    values[2],
    range(100, (i) => -i),
    0,
  );
});

// ------------------------------------------------ Hand-built edge cases

void test('MAT big-endian files, plain and compressed, with packed small elements', async () => {
  for (const compressed of [false, true]) {
    const parts = [
      double('time', [5, 1], [0, 0.1, 0.2, 0.3, 0.4], false),
      matrix(false, MX.INT16, [1, 5], 'counts', [
        element(MI.INT16, numbers([1, -2, 3, -4, 5], 'i16', false), false),
      ]),
      // Two int16 samples fit in the tag itself.
      matrix(false, MX.INT16, [2, 1], 'pair', [
        element(MI.INT16, numbers([7, -8], 'i16', false), false),
      ]),
      double('other', [2, 1], [1.5, 2.5], false),
    ];
    const file = await openMat(
      level5(
        compressed
          ? await Promise.all(parts.map((part) => compress(part, false)))
          : parts,
        false,
      ),
    );
    assert.deepEqual(
      file.tables.map((t) => t.name),
      ['time', '2 samples'],
    );
    const first = await columns(file, 0);
    close(first.time, [0, 0.1, 0.2, 0.3, 0.4], 0);
    close(first.values[0], [1, -2, 3, -4, 5], 0);
    const second = await columns(file, 1);
    assert.deepEqual(labels(file, 1), ['pair [—]', 'other [—]']);
    assert.deepEqual(file.tables[1].notes, [
      'No time variable: time is the sample number.',
    ]);
    close(second.time, [0, 1], 0);
    close(second.values[0], [7, -8], 0);
    close(second.values[1], [1.5, 2.5], 0);
  }
});

void test('MAT time falls back to an increasing matrix column, then the sample number', async () => {
  const matrixTime = await openMat(
    level5([double('data', [4, 3], [0, 1, 2, 3, 5, 6, 7, 8, 9, 9, 9, 9])]),
  );
  assert.deepEqual(matrixTime.tables[0].notes, [
    'Time is the first column of “data”.',
  ]);
  assert.deepEqual(labels(matrixTime, 0), ['data(:,2) [—]', 'data(:,3) [—]']);
  const read = await columns(matrixTime, 0);
  close(read.time, [0, 1, 2, 3], 0);
  close(read.values[0], [5, 6, 7, 8], 0);

  // A time-named vector that does not increase is an ordinary signal.
  const unordered = await openMat(
    level5([double('t', [1, 3], [0, 2, 1]), double('x', [3, 1], [4, 5, 6])]),
  );
  assert.deepEqual(labels(unordered, 0), ['t [—]', 'x [—]']);
  assert.deepEqual(unordered.tables[0].notes, [
    'No time variable: time is the sample number.',
  ]);
  close((await columns(unordered, 0)).time, [0, 1, 2], 0);

  // Scalars are skipped silently; a lone time vector is noted.
  const lonely = await openMat(
    level5([
      double('gain', [1, 1], [2]),
      double('tout', [2, 1], [0, 1]),
      double('x', [3, 1], [1, 2, 3]),
    ]),
  );
  assert.equal(lonely.tables.length, 1);
  assert.deepEqual(lonely.notes, [
    'Skipped “tout”: no other variable has the same number of samples.',
  ]);
});

void test('MAT struct fields flatten to four levels; struct arrays need Simulink layout', async () => {
  const leaf = (values: number[]) => double('', [values.length, 1], values);
  const nest = (depth: number): Uint8Array =>
    depth ? struct('', [1, 1], ['n'], [[nest(depth - 1)]]) : leaf([1, 2, 3]);
  const signal = (label: string, values: number[]) => [
    leaf(values),
    text('', label),
  ];
  const file = await openMat(
    level5([
      double('time', [3, 1], [0, 1, 2]),
      struct('ok', [1, 1], ['n'], [[nest(3)]]),
      struct('deep', [1, 1], ['n'], [[nest(4)]]),
      struct('pairs', [1, 2], ['v'], [[leaf([1, 1, 1])], [leaf([2, 2, 2])]]),
      struct(
        'log',
        [1, 1],
        ['time', 'signals'],
        [
          [
            leaf([0, 0.5, 1]),
            struct(
              '',
              [1, 2],
              ['values', 'label'],
              [signal('Torque [Nm]', [4, 5, 6]), signal('', [7, 8, 9])],
            ),
          ],
        ],
      ),
    ]),
  );
  assert.deepEqual(
    file.tables.map((t) => t.name),
    [''],
  );
  assert.deepEqual(labels(file, 0), [
    'ok.n.n.n.n [—]',
    'log.time [—]',
    'Torque [Nm]',
    'log.signals(2).values [—]',
  ]);
  assert.deepEqual(file.notes, [
    'Skipped 2 variables that are not a real numeric array: deep.n.n.n.n (nested too deeply), pairs (struct array).',
  ]);
  close((await columns(file, 0)).values[2], [4, 5, 6], 0);
});

void test('MAT objects, cells, sparse and complex arrays are skipped with notes', async () => {
  const opaque = element(
    MI_MATRIX,
    concat(
      element(MI.UINT32, numbers([MX.OPAQUE, 0], 'u32', true), true),
      element(MI.INT8, ascii('ts'), true),
      element(MI.INT8, ascii('MCOS'), true),
      element(MI.INT8, ascii('timeseries'), true),
      double('', [1, 1], [0]),
    ),
    true,
  );
  const parts = [
    opaque,
    matrix(true, MX.CELL, [1, 1], 'c', [double('', [2, 1], [1, 2])]),
    matrix(true, 5, [2, 2], 's', []),
    matrix(
      true,
      MX.DOUBLE,
      [2, 1],
      'z',
      [
        element(MI.DOUBLE, numbers([1, 2], 'f64', true), true),
        element(MI.DOUBLE, numbers([3, 4], 'f64', true), true),
      ],
      0x800,
    ),
    // MATLAB's unnamed object workspace is ignored.
    matrix(true, 9, [1, 4], '', [element(MI.UINT8, ascii('abcd'), true)]),
  ];
  await assert.rejects(openMat(level5(parts)), {
    message:
      'The MAT-file holds no numeric vectors or matrices with more than one sample. Skipped 4 variables that are not a real numeric array: ts (object), c (cell array), s (sparse), z (complex). MATLAB objects such as timeseries and timetable cannot be read; save their times and data as numeric arrays.',
  });
  const file = await openMat(
    level5([
      ...parts,
      double('t', [2, 1], [0, 1]),
      double('y', [2, 1], [3, 4]),
    ]),
  );
  assert.equal(file.notes?.length, 2);
  assert.deepEqual(labels(file, 0), ['y [—]']);
});

void test('MAT limits: channel count and variable size', async () => {
  await assert.rejects(
    openMat(
      level5([
        double(
          'wide',
          [2, 1100],
          range(2200, () => 1),
        ),
      ]),
    ),
    /1,100 signals; a recording can have at most 1,024/,
  );
  // A compressed variable whose header claims 600 MiB is refused unread.
  const huge = concat(
    numbers([MI_MATRIX, 600 * 2 ** 20], 'u32', true),
    element(MI.UINT32, numbers([MX.DOUBLE, 0], 'u32', true), true),
    element(MI.INT32, numbers([75 * 2 ** 20, 1], 'i32', true), true),
    element(MI.INT8, ascii('big'), true),
  );
  await assert.rejects(openMat(level5([await compress(huge)])), {
    message:
      'The variable “big” is 600 MiB; variables larger than 512 MiB cannot be imported. Save it in smaller parts.',
  });
});

void test('MAT headers: v7.3, unknown content, empty and truncated files', async () => {
  await assert.rejects(openMat(level5([], true, 0x0200)), /v7\.3 \(HDF5\)/);
  await assert.rejects(
    openMat(new Blob(['not a mat file at all, just text'])),
    /not a MATLAB MAT-file the reader recognises/,
  );
  await assert.rejects(openMat(new Blob([])), /The file is empty/);
  const whole = await level5([
    double(
      'x',
      [100, 1],
      range(100, (i) => i),
    ),
  ])
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer));
  await assert.rejects(
    openMat(new Blob([whole.subarray(0, 400) as BlobPart])),
    /truncated or damaged/,
  );
});

void test('MAT big-endian Level 4 matrices', async () => {
  const file = await openMat(
    new Blob([
      concat(
        level4('t', 3, 1, [0, 0.5, 1], false),
        level4('m', 3, 2, [1, 2, 3, 4, 5, 6], false),
      ) as BlobPart,
    ]),
  );
  assert.deepEqual(labels(file, 0), ['m(:,1) [—]', 'm(:,2) [—]']);
  const { time, values } = await columns(file, 0);
  close(time, [0, 0.5, 1], 0);
  close(values[1], [4, 5, 6], 0);
});

void test('MAT compressed variables stream in bounded blocks', async () => {
  const n = BLOCK_ROWS * 2 + 123;
  const t = range(n, (i) => i / 1000);
  const x = range(n, (i) => Math.sin(i / 50));
  const file = await openMat(
    level5([
      await compress(double('t', [n, 1], t)),
      await compress(double('x', [1, n], x)),
    ]),
  );
  assert.equal(file.tables[0].rows, n);
  const sizes: number[] = [];
  const progress: number[] = [];
  const read: number[] = [];
  for await (const block of file.read(0)) {
    sizes.push(block.time.length);
    progress.push(block.progress ?? 0);
    read.push(...block.values[0]);
  }
  assert.deepEqual(sizes, [BLOCK_ROWS, BLOCK_ROWS, 123]);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(read, x);
});
