/**
 * Excel .xlsx/.xlsm workbooks. Every worksheet with numbers in column A
 * becomes a table: row 1 names the channels (“Torque [Nm]” gives a unit),
 * column A is time in seconds, or seconds since the first row when it holds
 * dates. Parts are inflated and scanned as streams by a small XML tokenizer,
 * so a large sheet never sits in memory as a whole.
 */
import {
  BLOCK_ROWS,
  BlobBytes,
  MAX_RECORDING_CHANNELS,
  headerChannel,
  namedChannel,
  uint64,
  uniqueChannels,
} from './recording';
import type {
  RecordingBlock,
  RecordingFile,
  RecordingTable,
} from './recording';

/** Data rows read by open() to find column A's type and the used columns. */
const PREVIEW_ROWS = 100;
/** Compressed bytes read from the file at a time. */
const SLICE = 256 * 1024;
/** Shared strings kept for headers, in UTF-16 code units. */
const MAX_STRINGS = 16 * 2 ** 20;
const NOT_XLSX =
  'The file is not an Excel .xlsx workbook. It may be damaged, or saved in another format.';
const DAMAGED = 'The workbook is damaged: one of its parts cannot be read.';

// ---------------------------------------------------------------- ZIP

type Entry = {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  local: number;
};

/** Lists a ZIP archive's entries from its (Zip64) central directory. */
async function zipEntries(bytes: BlobBytes): Promise<Map<string, Entry>> {
  const tailLength = Math.min(bytes.size, 22 + 65535);
  const tail = await bytes.view(bytes.size - tailLength, tailLength);
  let end = -1;
  for (let at = tailLength - 22; at >= 0 && end < 0; at--)
    if (tail.getUint32(at, true) === 0x06054b50) end = at;
  if (end < 0) throw new Error(NOT_XLSX);
  let count = tail.getUint16(end + 10, true);
  let size = tail.getUint32(end + 12, true);
  let offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = bytes.size - tailLength + end - 20;
    if (locator < 0) throw new Error(NOT_XLSX);
    const locate = await bytes.view(locator, 20);
    if (locate.getUint32(0, true) !== 0x07064b50) throw new Error(NOT_XLSX);
    const record = await bytes.view(uint64(locate, 8), 56);
    if (record.getUint32(0, true) !== 0x06064b50) throw new Error(NOT_XLSX);
    count = uint64(record, 32);
    size = uint64(record, 40);
    offset = uint64(record, 48);
  }
  if (size > 64 * 2 ** 20) throw new Error(DAMAGED);
  const directory = await bytes.view(offset, size);
  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('latin1');
  const entries = new Map<string, Entry>();
  for (let at = 0, index = 0; index < count && at + 46 <= size; index++) {
    if (directory.getUint32(at, true) !== 0x02014b50) throw new Error(DAMAGED);
    const flags = directory.getUint16(at + 8, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const raw = new Uint8Array(
      directory.buffer,
      directory.byteOffset + at + 46,
      nameLength,
    );
    const entry: Entry = {
      name: (flags & 0x800 ? utf8 : latin1).decode(raw),
      method: directory.getUint16(at + 10, true),
      flags,
      compressed: directory.getUint32(at + 20, true),
      size: directory.getUint32(at + 24, true),
      local: directory.getUint32(at + 42, true),
    };
    // Zip64 extra fields replace the 32-bit values that overflowed.
    for (
      let extra = at + 46 + nameLength;
      extra + 4 <= at + 46 + nameLength + extraLength;
    ) {
      const id = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (id === 1) {
        let field = extra + 4;
        if (entry.size === 0xffffffff) {
          entry.size = uint64(directory, field);
          field += 8;
        }
        if (entry.compressed === 0xffffffff) {
          entry.compressed = uint64(directory, field);
          field += 8;
        }
        if (entry.local === 0xffffffff) entry.local = uint64(directory, field);
      }
      extra += 4 + length;
    }
    entries.set(entry.name.replace(/^\/+/, ''), entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Streams an entry's text, counting compressed bytes as they are read. */
async function* entryText(
  file: Blob,
  bytes: BlobBytes,
  entry: Entry,
  consumed?: { bytes: number },
): AsyncGenerator<string> {
  if (entry.flags & 1)
    throw new Error(
      'The workbook is encrypted. Save it without a password and import it again.',
    );
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(
      'The workbook uses a compression method that cannot be read. Save it again in Excel.',
    );
  const local = await bytes.view(entry.local, 30);
  if (local.getUint32(0, true) !== 0x04034b50) throw new Error(DAMAGED);
  const start =
    entry.local + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  if (start + entry.compressed > bytes.size) throw new Error(DAMAGED);
  // Bounded slices keep read-ahead small and make progress observable.
  let at = start;
  const end = start + entry.compressed;
  let stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        if (at >= end) return controller.close();
        const next = Math.min(end, at + SLICE);
        controller.enqueue(
          new Uint8Array(await file.slice(at, next).arrayBuffer()),
        );
        at = next;
        if (consumed) consumed.bytes = at - start;
      },
    },
    { highWaterMark: 0 },
  );
  if (entry.method === 8)
    stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  try {
    for (;;) {
      let result: ReadableStreamReadResult<string>;
      try {
        result = await reader.read();
      } catch {
        throw new Error(DAMAGED);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------- XML

export type XmlHandler = {
  /** `attributes` is the raw text after the element name. */
  open(name: string, attributes: string, empty: boolean): void;
  close(name: string): void;
  /** Raw character data; `literal` text (CDATA) has no entities. */
  text(raw: string, literal: boolean): void;
};

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;

export function unescapeXml(text: string) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, hex, decimal, name) => {
    if (name) return NAMED[name as string];
    const code = hex ? parseInt(hex as string, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Attribute values by name without namespace prefix, entities decoded. */
function attributes(raw: string) {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1];
    out[name.slice(name.indexOf(':') + 1)] = unescapeXml(match[2] ?? match[3]);
  }
  return out;
}

// A complete quoted value, the end of a tag, or a quote that is not yet closed.
const TAG_END = /"[^"]*"|'[^']*'|>|["']/g;

/** Incremental tokenizer: feed text in any pieces, events fire as tags close. */
export class XmlScanner {
  private rest = '';
  constructor(private handler: XmlHandler) {}
  feed(chunk: string) {
    const text = this.rest + chunk;
    const handler = this.handler;
    let at = 0;
    for (;;) {
      const lt = text.indexOf('<', at);
      if (lt < 0) break;
      if (lt > at) handler.text(text.slice(at, lt), false);
      at = lt;
      const next = text.charCodeAt(lt + 1);
      if (next === 33 || next === 63) {
        // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE …>, <? ?>
        let close: string;
        if (text.startsWith('<!--', lt)) close = '-->';
        else if (text.startsWith('<![CDATA[', lt)) close = ']]>';
        else if (next === 63) close = '?>';
        else if (lt + 9 > text.length) break;
        else close = '>';
        const end = text.indexOf(close, lt + 2);
        if (end < 0) break;
        if (close === ']]>') handler.text(text.slice(lt + 9, end), true);
        at = end + close.length;
        continue;
      }
      TAG_END.lastIndex = lt + 1;
      let end = -1;
      for (let match; (match = TAG_END.exec(text));)
        if (match[0].length === 1) {
          if (match[0] === '>') end = match.index;
          break;
        }
      if (end < 0) break;
      if (next === 47) {
        const name = text.slice(lt + 2, end).trim();
        handler.close(name.slice(name.indexOf(':') + 1));
      } else {
        const empty = text.charCodeAt(end - 1) === 47;
        const body = text.slice(lt + 1, empty ? end - 1 : end);
        const space = body.search(/\s/);
        const qualified = space < 0 ? body : body.slice(0, space);
        handler.open(
          qualified.slice(qualified.indexOf(':') + 1),
          space < 0 ? '' : body.slice(space),
          empty,
        );
        if (empty) handler.close(qualified.slice(qualified.indexOf(':') + 1));
      }
      at = end + 1;
    }
    this.rest = text.slice(at);
  }
}

/** Scans a whole part, stopping early once `done()` reports true. */
async function scanPart(
  file: Blob,
  bytes: BlobBytes,
  entry: Entry,
  handler: XmlHandler,
  done: () => boolean = () => false,
) {
  const scanner = new XmlScanner(handler);
  for await (const text of entryText(file, bytes, entry)) {
    scanner.feed(text);
    if (done()) return;
  }
}

// ---------------------------------------------------------------- Sheets

/** Zero-based column of a reference such as “AB12”, or -1. */
function columnOf(reference: string) {
  let column = 0;
  let i = 0;
  for (; i < reference.length; i++) {
    const code = reference.charCodeAt(i) & ~32;
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
  }
  return i ? column - 1 : -1;
}
function columnName(column: number) {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

type CellKind = 'number' | 'shared' | 'text' | 'error';
type Cell = { kind: CellKind; text: string; number: number; style: number };
type RowSink = {
  cell(row: number, column: number, cell: Cell): void;
  row(row: number): void;
};

/** Turns worksheet XML events into cells and row ends. */
function sheetHandler(sink: RowSink, onDimension?: (ref: string) => void) {
  let row = 0;
  let column = -1;
  let type = '';
  let style = 0;
  let value = '';
  let hasValue = false;
  let capture = false;
  let inline = false;
  let phonetic = false;
  let inCell = false;
  const handler: XmlHandler = {
    open(name, raw, empty) {
      if (name === 'c') {
        const attrs = attributes(raw);
        const ref = attrs.r ? columnOf(attrs.r) : -1;
        column = ref >= 0 ? ref : column + 1;
        type = attrs.t ?? 'n';
        style = attrs.s ? Number(attrs.s) || 0 : 0;
        value = '';
        hasValue = false;
        inCell = !empty;
      } else if (name === 'row') {
        const r = Number(attributes(raw).r);
        row = Number.isInteger(r) && r > 0 ? r : row + 1;
        column = -1;
      } else if (inCell && name === 'v') capture = !empty;
      else if (inCell && name === 'is') inline = true;
      else if (inline && name === 't') capture = !phonetic && !empty;
      else if (inline && name === 'rPh') phonetic = true;
      else if (name === 'dimension') onDimension?.(attributes(raw).ref ?? '');
    },
    close(name) {
      if (name === 'v' || name === 't') {
        if (capture) hasValue = true;
        capture = false;
      } else if (name === 'rPh') phonetic = false;
      else if (name === 'is') inline = false;
      else if (name === 'c' && inCell) {
        inCell = false;
        if (!hasValue || column < 0) return;
        const cell: Cell = { kind: 'text', text: value, number: NaN, style };
        if (type === 'n' || type === 'b') {
          const number = value.trim() ? Number(value) : NaN;
          if (Number.isFinite(number)) {
            cell.kind = 'number';
            cell.number = number;
          }
        } else if (type === 's') cell.kind = 'shared';
        else if (type === 'e') cell.kind = 'error';
        sink.cell(row, column, cell);
      } else if (name === 'row') sink.row(row);
    },
    text(raw, literal) {
      if (capture) value += literal ? raw : unescapeXml(raw);
    },
  };
  return handler;
}

/** Built-in date/time formats and custom codes with date or time tokens. */
function dateFormat(id: number, code?: string) {
  if (code === undefined)
    return (
      (id >= 14 && id <= 22) ||
      (id >= 27 && id <= 36) ||
      (id >= 45 && id <= 47) ||
      (id >= 50 && id <= 58)
    );
  const section = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\.|_.|\*./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    .split(';')[0];
  return /[dmyhs]/i.test(section);
}

type Sheet = {
  name: string;
  entry: Entry;
  headerRow: number;
  /** Sheet columns (1 = B) that become channels, in order. */
  columns: number[];
  /** Text-only columns left out, named once headers are known. */
  textColumns: number[];
  dates: boolean;
  table: RecordingTable;
  notes: string[];
};

/** Relationship targets resolve against the folder of their source part. */
function resolvePath(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/'))
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  return parts.join('/');
}
const relsPath = (part: string) => {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};

type Relationship = { id: string; type: string; target: string };

export async function openXlsx(file: Blob): Promise<RecordingFile> {
  if (!file.size) throw new Error('The file is empty.');
  const bytes = new BlobBytes(file);
  const magic = await bytes.bytes(0, Math.min(8, file.size));
  if (
    magic[0] === 0xd0 &&
    magic[1] === 0xcf &&
    magic[2] === 0x11 &&
    magic[3] === 0xe0
  )
    throw new Error(
      'This looks like an old .xls workbook, or one protected with a password; save it as an unprotected .xlsx.',
    );
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new Error(NOT_XLSX);
  const entries = await zipEntries(bytes);
  const lower = new Map(
    [...entries].map(([name, entry]) => [name.toLowerCase(), entry]),
  );
  const part = (path: string) =>
    entries.get(path) ?? lower.get(path.toLowerCase());

  const relationships = async (source: string) => {
    const entry = part(relsPath(source));
    const out: Relationship[] = [];
    if (entry)
      await scanPart(file, bytes, entry, {
        open(name, raw) {
          if (name !== 'Relationship') return;
          const attrs = attributes(raw);
          if (attrs.TargetMode === 'External') return;
          out.push({
            id: attrs.Id ?? '',
            type: attrs.Type ?? '',
            target: resolvePath(source, attrs.Target ?? ''),
          });
        },
        close() {},
        text() {},
      });
    return out;
  };
  const ofType = (list: Relationship[], type: string) =>
    list.find((rel) => rel.type.endsWith(`/${type}`));

  const root = await relationships('');
  const workbookPath =
    ofType(root, 'officeDocument')?.target ?? 'xl/workbook.xml';
  const workbook = part(workbookPath);
  if (!workbook) {
    if (part('xl/workbook.bin'))
      throw new Error(
        'This is a binary .xlsb workbook; save it as .xlsx and import it again.',
      );
    throw new Error(NOT_XLSX);
  }
  const sheetList: { name: string; id: string }[] = [];
  await scanPart(file, bytes, workbook, {
    open(name, raw) {
      if (name !== 'sheet') return;
      const attrs = attributes(raw);
      sheetList.push({ name: attrs.name ?? '', id: attrs.id ?? '' });
    },
    close() {},
    text() {},
  });
  const links = await relationships(workbookPath);

  // Styles: which cell formats show dates or times.
  const dateStyles: boolean[] = [];
  const stylesEntry = part(ofType(links, 'styles')?.target ?? 'xl/styles.xml');
  if (stylesEntry) {
    const codes = new Map<number, string>();
    let inXfs = false;
    await scanPart(file, bytes, stylesEntry, {
      open(name, raw) {
        if (name === 'numFmt') {
          const attrs = attributes(raw);
          codes.set(Number(attrs.numFmtId), attrs.formatCode ?? '');
        } else if (name === 'cellXfs') inXfs = true;
        else if (name === 'xf' && inXfs) {
          const id = Number(attributes(raw).numFmtId ?? 0);
          dateStyles.push(dateFormat(id, codes.get(id)));
        }
      },
      close(name) {
        if (name === 'cellXfs') inXfs = false;
      },
      text() {},
    });
  }

  const notes: string[] = [];
  const sheets: Sheet[] = [];
  const headers: { sheet: Sheet; cells: Map<number, Cell> }[] = [];
  for (const { name, id } of sheetList) {
    const link = links.find((rel) => rel.id === id);
    if (!link || !link.type.endsWith('/worksheet')) continue;
    const entry = part(link.target);
    if (!entry) continue;
    let headerRow = 0;
    const header = new Map<number, Cell>();
    let width = 0;
    let dataRows = 0;
    let rowCells = 0;
    let timeStyle: number | undefined;
    const numeric = new Set<number>();
    const textual = new Set<number>();
    let done = false;
    let dimensionEnd = 0;
    const handler = sheetHandler(
      {
        cell(row, column, cell) {
          headerRow ||= row;
          width = Math.max(width, column + 1);
          if (row === headerRow) header.set(column, cell);
          else {
            rowCells++;
            (cell.kind === 'number' ? numeric : textual).add(column);
            if (column === 0 && cell.kind === 'number')
              timeStyle ??= cell.style;
          }
        },
        row() {
          if (rowCells) dataRows++;
          rowCells = 0;
          done = dataRows >= PREVIEW_ROWS;
        },
      },
      (ref) => {
        const last = ref.split(':').pop() ?? '';
        dimensionEnd = Number(last.replace(/^[A-Za-z]+/, '')) || 0;
      },
    );
    try {
      await scanPart(file, bytes, entry, handler, () => done);
    } catch (error) {
      if (error instanceof Error && error.message === DAMAGED)
        throw new Error(`The sheet “${name}” is damaged and cannot be read.`);
      throw error;
    }
    if (!headerRow) continue;
    if (timeStyle === undefined) {
      notes.push(
        `Skipped sheet “${name}”: column A holds no numbers below its first row.`,
      );
      continue;
    }
    // Columns with only text below the header (comments) are left out.
    const columns: number[] = [];
    const textColumns: number[] = [];
    for (let column = 1; column < width; column++)
      (textual.has(column) && !numeric.has(column)
        ? textColumns
        : columns
      ).push(column);
    if (!columns.length) {
      notes.push(
        `Skipped sheet “${name}”: it has no numeric columns besides time.`,
      );
      continue;
    }
    if (columns.length > MAX_RECORDING_CHANNELS)
      throw new Error(
        `The sheet “${name}” has ${columns.length.toLocaleString()} columns; a recording can have at most ${MAX_RECORDING_CHANNELS.toLocaleString()} signals.`,
      );
    const dates = !!dateStyles[timeStyle];
    const sheetNotes = dates
      ? [
          'Column A holds dates or times; time is in seconds since the first row.',
        ]
      : [];
    const sheet: Sheet = {
      name,
      entry,
      headerRow,
      columns,
      textColumns,
      dates,
      notes: sheetNotes,
      table: {
        name,
        channels: [],
        rows: dimensionEnd > headerRow ? dimensionEnd - headerRow : undefined,
        notes: [...sheetNotes],
      },
    };
    sheets.push(sheet);
    headers.push({ sheet, cells: header });
  }
  if (!sheets.length)
    throw new Error('The workbook has no sheet with numeric data.');

  // Only the shared strings that headers use are kept.
  const wanted = new Map<number, string>();
  for (const { cells } of headers)
    for (const cell of cells.values())
      if (cell.kind === 'shared') wanted.set(Number(cell.text), '');
  const stringsEntry = part(
    ofType(links, 'sharedStrings')?.target ?? 'xl/sharedStrings.xml',
  );
  if (wanted.size && stringsEntry) {
    const last = Math.max(...wanted.keys());
    let index = 0;
    let text = '';
    let capture = false;
    let phonetic = false;
    let kept = 0;
    await scanPart(
      file,
      bytes,
      stringsEntry,
      {
        open(name, _raw, empty) {
          if (name === 'si') text = '';
          else if (name === 't') capture = !phonetic && !empty;
          else if (name === 'rPh') phonetic = true;
        },
        close(name) {
          if (name === 't') capture = false;
          else if (name === 'rPh') phonetic = false;
          else if (name === 'si') {
            if (wanted.has(index) && kept < MAX_STRINGS) {
              wanted.set(index, text);
              kept += text.length;
            }
            index++;
          }
        },
        text(raw, literal) {
          if (capture) text += literal ? raw : unescapeXml(raw);
        },
      },
      () => index > last,
    );
  }

  for (const { sheet, cells } of headers) {
    const label = (column: number) => {
      const cell = cells.get(column);
      if (cell?.kind === 'shared') return wanted.get(Number(cell.text)) ?? '';
      if (cell?.kind === 'number') return String(cell.number);
      return cell?.text.trim() ?? '';
    };
    sheet.table.channels = uniqueChannels(
      sheet.columns.map((column) => {
        const { name, unit } = label(column)
          ? headerChannel(label(column))
          : { name: `Column ${columnName(column)}`, unit: '—' };
        return namedChannel(name, unit === '—' ? undefined : unit);
      }),
    );
    if (sheet.textColumns.length) {
      const names = sheet.textColumns.map((column) =>
        label(column)
          ? `${columnName(column)} (“${label(column)}”)`
          : columnName(column),
      );
      sheet.notes.push(
        `Skipped ${names.length === 1 ? 'column' : 'columns'} ${names.join(', ')}: ${names.length === 1 ? 'it holds' : 'they hold'} text, not numbers.`,
      );
      sheet.table.notes = [...sheet.notes];
    }
  }

  async function* read(index: number): AsyncGenerator<RecordingBlock> {
    const sheet = sheets[index];
    if (!sheet) throw new Error('The workbook has no such sheet.');
    const width = sheet.columns.length;
    // Channel index of each sheet column, or -1 for columns left out.
    const slots = new Int32Array(sheet.columns[width - 1] + 1).fill(-1);
    sheet.columns.forEach((column, slot) => (slots[column] = slot));
    const consumed = { bytes: 0 };
    const ready: RecordingBlock[] = [];
    let time = new Float64Array(BLOCK_ROWS);
    let values = Array.from({ length: width }, () =>
      new Float64Array(BLOCK_ROWS).fill(NaN),
    );
    let fill = 0;
    const row = new Float64Array(width).fill(NaN);
    let rowTime = NaN;
    let rowCells = 0;
    let rowText = 0;
    let origin = NaN;
    let textCells = 0;
    let skippedRows = 0;
    const progress = () =>
      sheet.entry.compressed
        ? Math.min(1, consumed.bytes / sheet.entry.compressed)
        : 1;
    const handler = sheetHandler({
      cell(rowNumber, column, cell) {
        const slot = column ? (slots[column] ?? -1) : 0;
        if (rowNumber <= sheet.headerRow || slot < 0) return;
        rowCells++;
        if (column === 0) {
          if (cell.kind === 'number') rowTime = cell.number;
        } else if (cell.kind === 'number') row[slot] = cell.number;
        else rowText++;
      },
      row(rowNumber) {
        if (rowNumber <= sheet.headerRow || !rowCells) return;
        if (Number.isNaN(rowTime)) skippedRows++;
        else {
          if (sheet.dates) {
            if (Number.isNaN(origin)) origin = rowTime;
            // Serial days carry about 10 µs of precision; round to 0.1 ms.
            time[fill] = Math.round((rowTime - origin) * 864e6) / 1e4;
          } else time[fill] = rowTime;
          for (let c = 0; c < width; c++) values[c][fill] = row[c];
          textCells += rowText;
          if (++fill === BLOCK_ROWS) {
            ready.push({ time, values, progress: progress() });
            time = new Float64Array(BLOCK_ROWS);
            values = values.map(() => new Float64Array(BLOCK_ROWS).fill(NaN));
            fill = 0;
          }
        }
        row.fill(NaN);
        rowTime = NaN;
        rowCells = 0;
        rowText = 0;
      },
    });
    const scanner = new XmlScanner(handler);
    try {
      for await (const text of entryText(file, bytes, sheet.entry, consumed)) {
        scanner.feed(text);
        while (ready.length) yield ready.shift()!;
      }
    } catch (error) {
      if (error instanceof Error && error.message === DAMAGED)
        throw new Error(
          `The sheet “${sheet.name}” is damaged and cannot be read.`,
        );
      throw error;
    }
    if (fill)
      yield {
        time: time.slice(0, fill),
        values: values.map((column) => column.slice(0, fill)),
        progress: 1,
      };
    const counted: string[] = [];
    if (textCells)
      counted.push(
        `${textCells.toLocaleString('en-US')} ${textCells === 1 ? 'cell holds' : 'cells hold'} text or an error instead of a number and ${textCells === 1 ? 'is' : 'are'} read as missing.`,
      );
    if (skippedRows)
      counted.push(
        `Skipped ${skippedRows.toLocaleString('en-US')} ${skippedRows === 1 ? 'row' : 'rows'} without a number in column A.`,
      );
    sheet.table.notes = [...sheet.notes, ...counted];
  }

  return {
    format: 'Excel workbook (.xlsx)',
    tables: sheets.map((sheet) => sheet.table),
    notes,
    read,
  };
}
