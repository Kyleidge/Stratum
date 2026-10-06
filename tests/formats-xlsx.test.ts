import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { XmlScanner, openXlsx, unescapeXml } from '../lib/formats/xlsx';
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
const close = (actual: number[], expected: number[], tolerance = 1e-9) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(
      Number.isNaN(expected[i])
        ? Number.isNaN(value)
        : Math.abs(value - expected[i]) <= tolerance,
      `sample ${i}: ${value} ≠ ${expected[i]}`,
    ),
  );
};
const range = <T>(n: number, f: (i: number) => T) =>
  Array.from({ length: n }, (_, i) => f(i));

// ------------------------------------------------ ZIP and workbook builder

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function bytes(...fields: [number, 2 | 4 | 8][]) {
  const out = new Uint8Array(fields.reduce((sum, [, size]) => sum + size, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [value, size] of fields) {
    if (size === 2) view.setUint16(at, value, true);
    else if (size === 4) view.setUint32(at, value, true);
    else view.setBigUint64(at, BigInt(value), true);
    at += size;
  }
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
async function deflateRaw(data: Uint8Array) {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP archive; `zip64` writes Zip64 directory records and sizes. */
async function zip(
  files: Record<string, string | Uint8Array>,
  { deflate = true, zip64 = false, flags = 0 } = {},
) {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data =
      typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const stored = deflate ? await deflateRaw(data) : data;
    const nameBytes = new TextEncoder().encode(name);
    const common = (size32: (n: number) => number): [number, 2 | 4 | 8][] => [
      [zip64 ? 45 : 20, 2],
      [0x800 | flags, 2],
      [deflate ? 8 : 0, 2],
      [0, 2],
      [0x21, 2],
      [crc32(data), 4],
      [size32(stored.length), 4],
      [size32(data.length), 4],
      [nameBytes.length, 2],
    ];
    const local = concat(
      bytes([0x04034b50, 4], ...common((n) => n), [0, 2]),
      nameBytes,
    );
    const extra = zip64
      ? bytes(
          [1, 2],
          [24, 2],
          [data.length, 8],
          [stored.length, 8],
          [offset, 8],
        )
      : new Uint8Array(0);
    central.push(
      concat(
        bytes(
          [0x02014b50, 4],
          [45, 2],
          ...common((n) => (zip64 ? 0xffffffff : n)),
          [extra.length, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [zip64 ? 0xffffffff : offset, 4],
        ),
        nameBytes,
        extra,
      ),
    );
    locals.push(local, stored);
    offset += local.length + stored.length;
  }
  const directory = concat(...central);
  const count = central.length;
  const tail = zip64
    ? concat(
        bytes(
          [0x06064b50, 4],
          [44, 8],
          [45, 2],
          [45, 2],
          [0, 4],
          [0, 4],
          [count, 8],
          [count, 8],
          [directory.length, 8],
          [offset, 8],
        ),
        bytes([0x07064b50, 4], [0, 4], [offset + directory.length, 8], [1, 4]),
        bytes(
          [0x06054b50, 4],
          [0, 2],
          [0, 2],
          [0xffff, 2],
          [0xffff, 2],
          [0xffffffff, 4],
          [0xffffffff, 4],
          [0, 2],
        ),
      )
    : bytes(
        [0x06054b50, 4],
        [0, 2],
        [0, 2],
        [count, 2],
        [count, 2],
        [directory.length, 4],
        [offset, 4],
        [0, 2],
      );
  return new Blob([concat(...locals, directory, tail) as BlobPart]);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** A workbook whose sheets are given as `<sheetData>` contents. */
function workbook(
  sheets: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const names = Object.keys(sheets);
  const parts: Record<string, string> = {
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${names
      .map(
        (name, i) =>
          `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        '',
      )}<Relationship Id="rS" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/><Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ...extra,
  };
  Object.values(sheets).forEach((data, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] =
      `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>${data}</sheetData></worksheet>`;
  });
  return parts;
}

// ------------------------------------------------ Fixtures

void test('XLSX fixture: sheets, headers, units, gaps, text and error cells', async () => {
  const file = await openXlsx(fixture('xlsx-basic.xlsx'));
  assert.ok(Object.hasOwn(file, 'read'));
  assert.equal(file.format, 'Excel workbook (.xlsx)');
  assert.deepEqual(
    file.tables.map((t) => t.name),
    ['Run 1', 'Logged & dated'],
  );
  // The blank sheet is skipped silently; the text sheet with a note.
  assert.deepEqual(file.notes, [
    'Skipped sheet “Notes”: column A holds no numbers below its first row.',
  ]);
  assert.deepEqual(labels(file, 0), [
    'Torque [Nm]',
    'Speed [—]',
    'Column D [—]',
    'Valid [—]',
  ]);
  assert.equal(file.tables[0].rows, 302);
  const { time, values } = await columns(file, 0);
  const t = range(300, (i) => i * 0.01);
  close(time, [...t, 3.5]);
  close(values[0], [
    ...t.map((x, i) => (i === 5 || i === 9 ? NaN : 10 + Math.sin(x))),
    1,
  ]);
  close(values[1], [...range(300, (i) => (i === 7 ? NaN : i * 2)), 2]);
  close(values[2], [...range(300, (i) => -i), NaN]);
  close(values[3], [...range(300, (i) => (i % 2 ? 0 : 1)), NaN]);
  // Counts are known once the sheet has been read.
  assert.deepEqual(file.tables[0].notes, [
    '2 cells hold text or an error instead of a number and are read as missing.',
    'Skipped 1 row without a number in column A.',
  ]);

  assert.deepEqual(labels(file, 1), ['Pressure [bar]']);
  assert.deepEqual(file.tables[1].notes, [
    'Column A holds dates or times; time is in seconds since the first row.',
  ]);
  const dated = await columns(file, 1);
  close(
    dated.time,
    range(50, (i) => i * 0.5),
    1e-6,
  );
  close(
    dated.values[0],
    range(50, (i) => 1 + i / 100),
  );
});

void test('XLSX fixture with shared strings, times of day and sparse cells', async () => {
  const file = await openXlsx(fixture('xlsx-shared.xlsx'));
  assert.deepEqual(
    file.tables.map((t) => t.name),
    ['Rig <A>'],
  );
  assert.deepEqual(labels(file, 0), ['Flow [l/min]', 'Flow (2) [l/min]']);
  assert.deepEqual(file.tables[0].notes, [
    'Column A holds dates or times; time is in seconds since the first row.',
    'Skipped column D (“Note”): it holds text, not numbers.',
  ]);
  const { time, values } = await columns(file, 0);
  close(
    time,
    range(40, (i) => i * 0.25),
    1e-6,
  );
  close(
    values[0],
    range(40, (i) => i * 1.5),
  );
  close(
    values[1],
    range(40, (i) => (i % 4 ? NaN : -i)),
  );
});

// ------------------------------------------------ Hand-built workbooks

const tricky = `
  <row r="1">
    <c r="A1" t="inlineStr"><is><t>Time</t></is></c>
    <c r="B1" t="s"><v>1</v></c>
    <c r="C1" t="inlineStr"><is><r><t>Fl&amp;ow</t></r><r><t xml:space="preserve"> [&#x6C;/&#109;in]</t></r><rPh><t>ignored</t></rPh></is></c>
    <c r="E1"><v>2024</v></c>
    <c r="F1" t="str"><v><![CDATA[a<b>]]></v></c>
  </row>
  <!-- a comment with <row> inside -->
  <row r="2"><c r="A2"><v>0</v></c><c><v>1.5</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="e"><v>#DIV/0!</v></c><c r="F2" t="str"><v>text</v></c></row>
  <row><c r="A3"><v>1E-1</v></c><c r="C3"><f>A3*2</f><v>0.2</v></c><c r="E3" s="0"/></row>
  <row r="5"><c r="B5"><v>9</v></c></row>
  <row r="6"><c r="A6" t="s"><v>0</v></c><c r="B6"><v>9</v></c></row>
  <row r="7"><c r="A7"><v>0.3</v></c><c r="F7"><v>-7</v></c><c r="H7"><v>8</v></c></row>
  <row r="8" spans="1:3"/>`;
const sharedStrings = `<?xml version="1.0"?><sst xmlns="${NS}"><si><t>label</t></si><si><r><t>Torque </t></r><r><t>[Nm]</t></r></si></sst>`;

void test('XLSX cell types, sparse references, entities and rich text', async () => {
  for (const options of [{ deflate: false }, { deflate: true, zip64: true }]) {
    const file = await openXlsx(
      await zip(
        workbook(
          { 'A & B': tricky },
          { 'xl/sharedStrings.xml': sharedStrings },
        ),
        options,
      ),
    );
    assert.equal(file.tables[0].name, 'A & B');
    // Column E holds only an error value below its header, so it is left out.
    assert.deepEqual(labels(file, 0), [
      'Torque [Nm]',
      'Fl&ow [l/min]',
      'Column D [—]',
      'a<b> [—]',
      'Column G [—]',
      'Column H [—]',
    ]);
    const { time, values } = await columns(file, 0);
    close(time, [0, 0.1, 0.3]);
    assert.deepEqual(values, [
      [1.5, NaN, NaN],
      [NaN, 0.2, NaN],
      [1, NaN, NaN],
      [NaN, NaN, -7],
      [NaN, NaN, NaN],
      [NaN, NaN, 8],
    ]);
    assert.deepEqual(file.tables[0].notes, [
      'Skipped column E (“2024”): it holds text, not numbers.',
      '1 cell holds text or an error instead of a number and is read as missing.',
      'Skipped 2 rows without a number in column A.',
    ]);
  }
});

void test('XML scanner gives the same events at every chunk boundary', () => {
  const xml = `<?xml version="1.0"?><a x='1>2' y="&lt;"><!-- c --><b/>t&amp;x<![CDATA[<raw>]]><c:d k="v">&#x41;&#66;</c:d></a>`;
  const record = (pieces: string[]) => {
    const events: string[] = [];
    let text = '';
    const flush = () => {
      if (text) events.push(`text:${text}`);
      text = '';
    };
    const scanner = new XmlScanner({
      open(name, attributes, empty) {
        flush();
        events.push(`open:${name}:${attributes.trim()}:${empty}`);
      },
      close(name) {
        flush();
        events.push(`close:${name}`);
      },
      text(raw, literal) {
        text += literal ? raw : unescapeXml(raw);
      },
    });
    for (const piece of pieces) scanner.feed(piece);
    flush();
    return events;
  };
  const whole = record([xml]);
  assert.deepEqual(whole, [
    `open:a:x='1>2' y="&lt;":false`,
    'open:b::true',
    'close:b',
    'text:t&x<raw>',
    'open:d:k="v":false',
    'text:AB',
    'close:d',
    'close:a',
  ]);
  for (let split = 0; split <= xml.length; split++)
    assert.deepEqual(record([xml.slice(0, split), xml.slice(split)]), whole);
  assert.deepEqual(record(xml.split('')), whole);
});

void test('XLSX large sheets stream in bounded blocks with progress', async () => {
  const n = 2 * BLOCK_ROWS + 4321;
  let rows =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>t</t></is></c><c r="B1" t="inlineStr"><is><t>x [V]</t></is></c></row>';
  for (let i = 0; i < n; i++)
    rows += `<row r="${i + 2}"><c r="A${i + 2}"><v>${i / 100}</v></c><c r="B${i + 2}"><v>${Math.sin(i)}</v></c></row>`;
  const file = await openXlsx(await zip(workbook({ Big: rows })));
  assert.equal(file.tables[0].rows, undefined);
  const sizes: number[] = [];
  const progress: number[] = [];
  const x: number[] = [];
  for await (const block of file.read(0)) {
    sizes.push(block.time.length);
    progress.push(block.progress ?? 0);
    x.push(...block.values[0]);
    assert.equal(block.time[0], (x.length - block.time.length) / 100);
  }
  assert.deepEqual(sizes, [BLOCK_ROWS, BLOCK_ROWS, 4321]);
  assert.ok(progress[0] > 0 && progress[0] < 0.8);
  assert.ok(progress.every((p, i) => !i || p >= progress[i - 1]));
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(
    x,
    range(n, (i) => Math.sin(i)),
  );
});

void test('XLSX date styles: built-in and custom formats in column A', async () => {
  const styles = `<?xml version="1.0"?><styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.00&quot;h&quot;"/><numFmt numFmtId="165" formatCode="[$-409]hh:mm:ss;@"/></numFmts><cellStyleXfs count="1"><xf numFmtId="22"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs></styleSheet>`;
  const sheet = (style: number) =>
    `<row r="1"><c r="B1" t="inlineStr"><is><t>y</t></is></c></row><row r="2"><c r="A2" s="${style}"><v>45000.5</v></c><c r="B2"><v>1</v></c></row><row r="3"><c r="A3" s="${style}"><v>45000.75</v></c><c r="B3"><v>2</v></c></row>`;
  const file = await openXlsx(
    await zip(
      workbook(
        { Plain: sheet(0), Hours: sheet(1), Clock: sheet(2), Stamp: sheet(3) },
        { 'xl/styles.xml': styles },
      ),
    ),
  );
  const times = await Promise.all(
    file.tables.map(async (_, i) => (await columns(file, i)).time),
  );
  assert.deepEqual(times, [
    [45000.5, 45000.75],
    [45000.5, 45000.75],
    [0, 21600],
    [0, 21600],
  ]);
});

void test('XLSX errors are plain-language', async () => {
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(openXlsx(new Blob([ole])), {
    message:
      'This looks like an old .xls workbook, or one protected with a password; save it as an unprotected .xlsx.',
  });
  await assert.rejects(
    openXlsx(new Blob(['time,value\n0,1\n'])),
    /not an Excel \.xlsx workbook/,
  );
  await assert.rejects(openXlsx(new Blob([])), /The file is empty/);
  await assert.rejects(
    openXlsx(
      await zip(
        workbook({
          Text: '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>b</t></is></c></row>',
          Empty: '',
        }),
      ),
    ),
    { message: 'The workbook has no sheet with numeric data.' },
  );
  await assert.rejects(
    openXlsx(await zip({ 'xl/workbook.bin': 'binary' })),
    /binary \.xlsb workbook/,
  );
  await assert.rejects(
    openXlsx(await zip(workbook({ S: tricky }), { flags: 1 })),
    /encrypted/,
  );
  const wide = `<row r="1"><c r="A1"><v>0</v></c></row><row r="2">${range(
    1100,
    (i) => `<c><v>${i}</v></c>`,
  ).join('')}</row>`;
  await assert.rejects(
    openXlsx(await zip(workbook({ Wide: wide }))),
    /1,099 columns; a recording can have at most 1,024/,
  );
});
