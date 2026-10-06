/**
 * MATLAB MAT-files: Level 5 (v6, and v7 with zlib-compressed variables) and
 * Level 4. Real numeric vectors and the columns of real matrices become
 * channels. Vectors of one length share a table whose time is a time-named
 * vector, else a matrix's increasing first column, else the sample number.
 * Struct fields flatten to dotted names, and Simulink “Structure with time”
 * logs are named by their signal labels. Compressed variables are inflated
 * as streams; only the bytes a table needs are kept while it is read.
 */
import {
  BLOCK_ROWS,
  BlobBytes,
  MAX_RECORDING_CHANNELS,
  decodeText,
  headerChannel,
  namedChannel,
  uniqueChannels,
} from './recording';
import type {
  RecordingBlock,
  RecordingChannel,
  RecordingFile,
  RecordingTable,
} from './recording';

// Level 5 data types (mi*) and array classes (mx*).
const MI_INT8 = 1;
const MI_UINT8 = 2;
const MI_INT16 = 3;
const MI_UINT16 = 4;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_SINGLE = 7;
const MI_DOUBLE = 9;
const MI_INT64 = 12;
const MI_UINT64 = 13;
const MI_MATRIX = 14;
const MI_COMPRESSED = 15;
const MI_UTF8 = 16;
const MI_UTF16 = 17;
const MX_CELL = 1;
const MX_STRUCT = 2;
const MX_OBJECT = 3;
const MX_CHAR = 4;
const MX_SPARSE = 5;
const MX_DOUBLE = 6;
const MX_UINT64 = 15;
const MX_FUNCTION = 16;
const MX_OPAQUE = 17;
const COMPLEX = 0x800;

const SIZES: Record<number, number> = {
  [MI_INT8]: 1,
  [MI_UINT8]: 1,
  [MI_INT16]: 2,
  [MI_UINT16]: 2,
  [MI_INT32]: 4,
  [MI_UINT32]: 4,
  [MI_SINGLE]: 4,
  [MI_DOUBLE]: 8,
  [MI_INT64]: 8,
  [MI_UINT64]: 8,
};
/** Level 4 precision digit → the equivalent Level 5 storage type. */
const V4_TYPES = [
  MI_DOUBLE,
  MI_SINGLE,
  MI_INT32,
  MI_INT16,
  MI_UINT16,
  MI_UINT8,
];
const MAX_VARIABLE = 512 * 2 ** 20;
const MAX_DEPTH = 4;
const SCAN_ROWS = 1 << 16;
const TIME_NAMES = new Set([
  't',
  'time',
  'times',
  'tout',
  'timestamp',
  'timestamps',
  'zeit',
]);
const LITTLE_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const MIB = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`;

/** A compressed element in the file; absent for data stored as it is. */
type Store = { offset: number; length: number };
type Span = { first: number; last: number };
/** A real numeric 2-D array whose samples can be read later. */
type Leaf = {
  name: string;
  rows: number;
  cols: number;
  /** Storage type of the samples (mi*). */
  type: number;
  little: boolean;
  /** Position of the first sample in the file or in the inflated element. */
  offset: number;
  store?: Store;
  /** Samples packed into their tag (at most four bytes). */
  inline?: Float64Array;
  /** Range of the first column when it strictly increases. */
  increasing?: Span;
  label?: string;
};
type Skip = { name: string; why: string };

/** Sequential reads from the file or from an inflating stream. */
type Reader = {
  pos: number;
  /** The next `length` bytes; the result may share a buffer. */
  take(length: number): Promise<Uint8Array>;
  skipTo(position: number): Promise<void>;
  close(): void;
};

class FileReader implements Reader {
  constructor(
    private bytes: BlobBytes,
    public pos: number,
  ) {}
  async take(length: number) {
    const data = await this.bytes.bytes(this.pos, length);
    this.pos += length;
    return data;
  }
  async skipTo(position: number) {
    this.pos = position;
  }
  close() {}
}

const DAMAGED = 'A compressed variable is damaged and cannot be read.';

class InflateReader implements Reader {
  pos = 0;
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(file: Blob, store: Store) {
    this.reader = file
      .slice(store.offset, store.offset + store.length)
      .stream()
      .pipeThrough(new DecompressionStream('deflate'))
      .getReader();
  }
  private async next() {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await this.reader.read();
    } catch {
      throw new Error(DAMAGED);
    }
    if (result.done) throw new Error(DAMAGED);
    this.chunk = result.value;
    this.at = 0;
  }
  async take(length: number) {
    if (this.at === this.chunk.length && length) await this.next();
    if (this.chunk.length - this.at >= length) {
      this.at += length;
      this.pos += length;
      return this.chunk.subarray(this.at - length, this.at);
    }
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length;) {
      if (this.at === this.chunk.length) await this.next();
      const count = Math.min(length - filled, this.chunk.length - this.at);
      out.set(this.chunk.subarray(this.at, this.at + count), filled);
      this.at += count;
      filled += count;
    }
    this.pos += length;
    return out;
  }
  async skipTo(position: number) {
    for (let left = position - this.pos; left > 0;) {
      if (this.at === this.chunk.length) await this.next();
      const count = Math.min(left, this.chunk.length - this.at);
      this.at += count;
      left -= count;
    }
    this.pos = Math.max(this.pos, position);
  }
  close() {
    this.reader.cancel().catch(() => {});
  }
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const pad8 = (size: number) => (size + 7) & ~7;

/** Converts stored samples of any numeric type to doubles. */
function decode(bytes: Uint8Array, type: number, little: boolean) {
  const size = SIZES[type];
  const count = Math.floor(bytes.length / size);
  if (little === LITTLE_HOST) {
    const copy = bytes.slice(0, count * size).buffer;
    switch (type) {
      case MI_DOUBLE:
        return new Float64Array(copy);
      case MI_SINGLE:
        return Float64Array.from(new Float32Array(copy));
      case MI_INT8:
        return Float64Array.from(new Int8Array(copy));
      case MI_UINT8:
        return Float64Array.from(new Uint8Array(copy));
      case MI_INT16:
        return Float64Array.from(new Int16Array(copy));
      case MI_UINT16:
        return Float64Array.from(new Uint16Array(copy));
      case MI_INT32:
        return Float64Array.from(new Int32Array(copy));
      case MI_UINT32:
        return Float64Array.from(new Uint32Array(copy));
    }
  }
  const data = view(bytes);
  const out = new Float64Array(count);
  const getters: Record<number, (at: number) => number> = {
    [MI_DOUBLE]: (at: number) => data.getFloat64(at, little),
    [MI_SINGLE]: (at: number) => data.getFloat32(at, little),
    [MI_INT8]: (at: number) => data.getInt8(at),
    [MI_UINT8]: (at: number) => data.getUint8(at),
    [MI_INT16]: (at: number) => data.getInt16(at, little),
    [MI_UINT16]: (at: number) => data.getUint16(at, little),
    [MI_INT32]: (at: number) => data.getInt32(at, little),
    [MI_UINT32]: (at: number) => data.getUint32(at, little),
    [MI_INT64]: (at: number) => Number(data.getBigInt64(at, little)),
    [MI_UINT64]: (at: number) => Number(data.getBigUint64(at, little)),
  };
  const get = getters[type];
  for (let i = 0; i < count; i++) out[i] = get(i * size);
  return out;
}

/** The first and last value when every value is finite and increasing. */
function increasing(values: Float64Array, previous = -Infinity): Span | null {
  for (const value of values) {
    if (!(value > previous) || value === Infinity) return null;
    previous = value;
  }
  return values.length ? { first: values[0], last: previous } : null;
}

/** Checks `count` samples at the reader's position, a block at a time. */
async function scan(
  reader: Reader,
  type: number,
  little: boolean,
  count: number,
): Promise<Span | undefined> {
  const size = SIZES[type];
  let span: Span | undefined;
  for (let done = 0; done < count;) {
    const take = Math.min(count - done, SCAN_ROWS);
    const next = increasing(
      decode(await reader.take(take * size), type, little),
      span?.last,
    );
    if (!next) return undefined;
    span = { first: span?.first ?? next.first, last: next.last };
    done += take;
  }
  return span;
}

const lastName = (path: string) => path.slice(path.lastIndexOf('.') + 1);
const timeNamed = (path: string) =>
  TIME_NAMES.has(lastName(path).toLowerCase());

/** Records a numeric array, checking its first column if it may be time. */
async function numericLeaf(
  reader: Reader,
  leaf: Omit<Leaf, 'increasing'>,
): Promise<Leaf> {
  const vector = leaf.rows === 1 || leaf.cols === 1;
  const length = vector ? leaf.rows * leaf.cols : leaf.rows;
  const candidate =
    length > 1 && (vector ? timeNamed(leaf.name) : leaf.cols > 1);
  if (!candidate) return leaf;
  const span = leaf.inline
    ? increasing(leaf.inline.subarray(0, length))
    : await scan(reader, leaf.type, leaf.little, length);
  return span ? { ...leaf, increasing: span } : leaf;
}

// ---------------------------------------------------------------- Level 5

type Tag = { type: number; size: number; data: number; next: number };

async function readTag(
  reader: Reader,
  little: boolean,
): Promise<Tag & { small?: Uint8Array }> {
  const start = reader.pos;
  const head = await reader.take(8);
  const word = view(head).getUint32(0, little);
  // Small elements pack their size into the type word and data into the tag.
  if (word >>> 16)
    return {
      type: word & 0xffff,
      size: word >>> 16,
      data: start + 4,
      next: start + 8,
      small: head.slice(4, 4 + Math.min(4, word >>> 16)),
    };
  const size = view(head).getUint32(4, little);
  return { type: word, size, data: start + 8, next: start + 8 + pad8(size) };
}

async function payload(reader: Reader, little: boolean) {
  const tag = await readTag(reader, little);
  const data = tag.small ?? (await reader.take(tag.size)).slice();
  await reader.skipTo(tag.next);
  return { type: tag.type, data };
}

function charText(data: Uint8Array, type: number, little: boolean) {
  if (type === MI_UTF16 || type === MI_UINT16) {
    const units = view(data);
    let text = '';
    for (let at = 0; at + 1 < data.length; at += 2)
      text += String.fromCharCode(units.getUint16(at, little));
    const end = text.indexOf('\0');
    return end < 0 ? text : text.slice(0, end);
  }
  return decodeText(data, type === MI_UTF8 ? 'utf-8' : 'latin1');
}

type Job = { path: string; end: number; size: number; depth: number };
type Frame = {
  path: string;
  fields: string[];
  elements: number;
  index: number;
  end: number;
  depth: number;
};
type Context = {
  little: boolean;
  leaves: Leaf[];
  texts: Map<string, string>;
  skipped: Skip[];
  store?: Store;
};

const KINDS: Record<number, string> = {
  [MX_CELL]: 'cell array',
  [MX_OBJECT]: 'object',
  [MX_CHAR]: 'text',
  [MX_SPARSE]: 'sparse',
  [MX_FUNCTION]: 'function handle',
  [MX_OPAQUE]: 'object',
};

/**
 * Reads one miMATRIX body at the reader's position. Returns a frame when it
 * is a struct whose fields follow; anything else is recorded or skipped.
 */
async function matrix(
  reader: Reader,
  job: Job,
  context: Context,
): Promise<Frame | undefined> {
  const { little } = context;
  const top = !job.path;
  const flags = await payload(reader, little);
  if (flags.data.length < 4) return;
  const word = view(flags.data).getUint32(0, little);
  const kind = word & 0xff;
  if (kind === MX_OPAQUE) {
    const name = top
      ? decodeText((await payload(reader, little)).data, 'utf-8')
      : job.path;
    if (name) context.skipped.push({ name, why: 'object' });
    return;
  }
  const dimensions = await payload(reader, little);
  const dims = Array.from(
    { length: Math.floor(dimensions.data.length / 4) },
    (_, i) => view(dimensions.data).getInt32(i * 4, little),
  );
  const ownName = decodeText((await payload(reader, little)).data, 'utf-8');
  const name = top ? ownName : job.path;
  // An unnamed top-level matrix is MATLAB's hidden object workspace.
  if (!name) return;
  if (top && job.size > MAX_VARIABLE)
    throw new Error(
      `The variable “${name}” is ${MIB(job.size)}; variables larger than ${MIB(MAX_VARIABLE)} cannot be imported. Save it in smaller parts.`,
    );
  const elements = dims.reduce((product, size) => product * size, 1);
  if (kind === MX_STRUCT) {
    if (elements === 0) return;
    if (job.depth >= MAX_DEPTH) {
      context.skipped.push({ name, why: 'nested too deeply' });
      return;
    }
    if (elements > 1 && lastName(name) !== 'signals') {
      context.skipped.push({ name, why: 'struct array' });
      return;
    }
    const width = await payload(reader, little);
    const length =
      width.data.length >= 4 ? view(width.data).getInt32(0, little) : 0;
    const names = (await payload(reader, little)).data;
    if (length <= 0) return;
    const fields = Array.from(
      { length: Math.floor(names.length / length) },
      (_, i) =>
        decodeText(names.subarray(i * length, (i + 1) * length), 'utf-8'),
    );
    if (!fields.length) return;
    return {
      path: name,
      fields,
      elements: elements * fields.length,
      index: 0,
      end: job.end,
      depth: job.depth + 1,
    };
  }
  if (kind === MX_CHAR) {
    const field = lastName(name);
    if (!top && (field === 'label' || field === 'blockName')) {
      const tag = await readTag(reader, little);
      if (tag.size <= 4096) {
        const data = tag.small ?? (await reader.take(tag.size));
        context.texts.set(name, charText(data, tag.type, little).trim());
      }
    } else if (top) context.skipped.push({ name, why: 'text' });
    return;
  }
  if (kind < MX_DOUBLE || kind > MX_UINT64) {
    context.skipped.push({ name, why: KINDS[kind] ?? 'unsupported type' });
    return;
  }
  if (word & COMPLEX) {
    context.skipped.push({ name, why: 'complex' });
    return;
  }
  if (dims.length !== 2) {
    if (elements > 1)
      context.skipped.push({ name, why: `${dims.length}-D array` });
    return;
  }
  const [rows, cols] = dims;
  if (rows * cols < 2) return;
  const tag = await readTag(reader, little);
  const size = SIZES[tag.type];
  if (!size || tag.size !== rows * cols * size) {
    context.skipped.push({ name, why: 'damaged' });
    return;
  }
  const leaf: Omit<Leaf, 'increasing'> = {
    name,
    rows,
    cols,
    type: tag.type,
    little,
    offset: tag.data,
    store: context.store,
    inline: tag.small ? decode(tag.small, tag.type, little) : undefined,
  };
  context.leaves.push(await numericLeaf(reader, leaf));
}

/** Walks one top-level variable and its struct fields with an explicit stack. */
async function variable(reader: Reader, first: Job, context: Context) {
  const stack: Frame[] = [];
  for (let job: Job | undefined = first; job;) {
    const frame = await matrix(reader, job, context);
    if (frame) stack.push(frame);
    else await reader.skipTo(job.end);
    job = undefined;
    while (stack.length && !job) {
      const parent = stack[stack.length - 1];
      if (parent.index === parent.elements) {
        stack.pop();
        await reader.skipTo(parent.end);
        continue;
      }
      const element = Math.floor(parent.index / parent.fields.length);
      const field = parent.fields[parent.index % parent.fields.length];
      const many = parent.elements > parent.fields.length;
      parent.index++;
      const tag = await readTag(reader, context.little);
      if (tag.type !== MI_MATRIX || !tag.size || !field) {
        await reader.skipTo(tag.next);
        continue;
      }
      job = {
        path: `${parent.path}${many ? `(${element + 1})` : ''}.${field}`,
        end: tag.next,
        size: tag.size,
        depth: parent.depth,
      };
    }
  }
}

async function parseLevel5(file: Blob, bytes: BlobBytes) {
  const header = await bytes.bytes(0, 128);
  const little = header[126] === 0x49 && header[127] === 0x4d;
  const context: Context = {
    little,
    leaves: [],
    texts: new Map(),
    skipped: [],
  };
  let compressed = false;
  for (let offset = 128; offset + 8 <= bytes.size;) {
    const reader = new FileReader(bytes, offset);
    const tag = await readTag(reader, little);
    if (tag.type === MI_COMPRESSED) {
      if (tag.data + tag.size > bytes.size)
        throw new Error(
          'The file is shorter than its own metadata says. It may be truncated or damaged.',
        );
      compressed = true;
      const store = { offset: tag.data, length: tag.size };
      const inflated = new InflateReader(file, store);
      try {
        const inner = await readTag(inflated, little);
        if (inner.type === MI_MATRIX && inner.size)
          await variable(
            inflated,
            { path: '', end: inner.next, size: inner.size, depth: 0 },
            { ...context, store },
          );
      } finally {
        inflated.close();
      }
      offset = tag.data + tag.size;
      continue;
    }
    if (tag.type === MI_MATRIX && tag.size) {
      if (tag.data + tag.size > bytes.size)
        throw new Error(
          'The file is shorter than its own metadata says. It may be truncated or damaged.',
        );
      await variable(
        reader,
        { path: '', end: tag.next, size: tag.size, depth: 0 },
        context,
      );
    }
    offset = tag.next;
  }
  return {
    format: `MATLAB MAT Level 5${compressed ? ', compressed' : ''}`,
    leaves: context.leaves,
    texts: context.texts,
    skipped: context.skipped,
  };
}

// ---------------------------------------------------------------- Level 4

async function parseLevel4(bytes: BlobBytes) {
  const leaves: Leaf[] = [];
  const skipped: Skip[] = [];
  if (bytes.size < 20)
    throw new Error(
      'This is not a MATLAB MAT-file the reader recognises (Level 4 or Level 5).',
    );
  // Trailing bytes too short for a header are padding.
  for (let offset = 0; offset + 20 <= bytes.size;) {
    const head = await bytes.view(offset, 20);
    const le = head.getInt32(0, true);
    const be = head.getInt32(0, false);
    // Little-endian headers read as small numbers; machine digit 1 is big-endian.
    const little = le >= 0 && le < 5000 && Math.floor(le / 1000) !== 1;
    const type = little ? le : be;
    if (!little && !(be >= 1000 && be < 5000)) {
      if (!offset)
        throw new Error(
          'This is not a MATLAB MAT-file the reader recognises (Level 4 or Level 5).',
        );
      throw new Error(
        'The MAT-file is damaged after its first variables and cannot be read.',
      );
    }
    const machine = Math.floor(type / 1000);
    const precision = Math.floor(type / 10) % 10;
    const form = type % 10;
    const rows = head.getInt32(4, little);
    const cols = head.getInt32(8, little);
    const imaginary = head.getInt32(12, little);
    const nameLength = head.getInt32(16, little);
    const storage = V4_TYPES[precision];
    if (
      !storage ||
      Math.floor(type / 100) % 10 !== 0 ||
      rows < 0 ||
      cols < 0 ||
      nameLength < 1 ||
      nameLength > 4096
    )
      throw new Error(
        offset
          ? 'The MAT-file is damaged after its first variables and cannot be read.'
          : 'This is not a MATLAB MAT-file the reader recognises (Level 4 or Level 5).',
      );
    const name = decodeText(
      await bytes.bytes(offset + 20, nameLength),
      'latin1',
    );
    const start = offset + 20 + nameLength;
    const real = rows * cols * SIZES[storage];
    const size = real * (imaginary ? 2 : 1);
    if (start + size > bytes.size)
      throw new Error(
        'The file is shorter than its own metadata says. It may be truncated or damaged.',
      );
    offset = start + size;
    if (size > MAX_VARIABLE)
      throw new Error(
        `The variable “${name}” is ${MIB(size)}; variables larger than ${MIB(MAX_VARIABLE)} cannot be imported. Save it in smaller parts.`,
      );
    if (form !== 0) {
      skipped.push({ name, why: form === 1 ? 'text' : 'sparse' });
      continue;
    }
    if (machine > 1) {
      skipped.push({ name, why: 'VAX or Cray number format' });
      continue;
    }
    if (imaginary) {
      skipped.push({ name, why: 'complex' });
      continue;
    }
    if (rows * cols < 2) continue;
    leaves.push(
      await numericLeaf(new FileReader(bytes, start), {
        name,
        rows,
        cols,
        type: storage,
        little: machine === 0,
        offset: start,
      }),
    );
  }
  return {
    format: 'MATLAB MAT Level 4',
    leaves,
    texts: new Map<string, string>(),
    skipped,
  };
}

// ---------------------------------------------------------------- Tables

/** One column of a leaf: a vector, or column `column` of a matrix. */
type Part = { leaf: Leaf; column: number };
type Plan = { time?: Part; length: number; columns: Part[] };

const listNames = (items: string[]) =>
  items.length > 6
    ? `${items.slice(0, 6).join(', ')} and ${items.length - 6} more`
    : items.join(', ');

/** Groups leaves by length into tables and names their channels. */
function tablesOf(
  leaves: Leaf[],
  texts: Map<string, string>,
  notes: string[],
): { tables: RecordingTable[]; plans: Plan[] } {
  // Simulink logs: x.signals(k).values is named by its label or block name.
  for (const leaf of leaves) {
    const match = leaf.name.match(/^(.*\.signals(?:\(\d+\))?)\.values$/);
    if (match)
      leaf.label =
        texts.get(`${match[1]}.label`) ||
        texts.get(`${match[1]}.blockName`) ||
        undefined;
  }
  const groups = new Map<number, Leaf[]>();
  for (const leaf of leaves) {
    const vector = leaf.rows === 1 || leaf.cols === 1;
    const length = vector ? leaf.rows * leaf.cols : leaf.rows;
    groups.set(length, [...(groups.get(length) ?? []), leaf]);
  }
  const tables: RecordingTable[] = [];
  const plans: Plan[] = [];
  const lonely: string[] = [];
  for (const [length, group] of groups) {
    const isVector = (leaf: Leaf) => leaf.rows === 1 || leaf.cols === 1;
    const tableNotes: string[] = [];
    let time: Part | undefined;
    let tableName = `${length} samples`;
    const clock = group.find(
      (leaf) => isVector(leaf) && leaf.increasing && timeNamed(leaf.name),
    );
    const firstColumn = group.find(
      (leaf) => !isVector(leaf) && leaf.increasing,
    );
    if (clock) {
      time = { leaf: clock, column: 0 };
      tableName = clock.name;
    } else if (firstColumn) {
      time = { leaf: firstColumn, column: 0 };
      tableName = `${firstColumn.name}(:,1)`;
      tableNotes.push(`Time is the first column of “${firstColumn.name}”.`);
    } else tableNotes.push('No time variable: time is the sample number.');
    const columns: Part[] = [];
    const channels: RecordingChannel[] = [];
    for (const leaf of group) {
      const base = headerChannel(leaf.label ?? leaf.name);
      const count = isVector(leaf) ? 1 : leaf.cols;
      for (let column = 0; column < count; column++) {
        if (time?.leaf === leaf && column === 0) continue;
        columns.push({ leaf, column });
        channels.push(
          namedChannel(
            count > 1 ? `${base.name}(:,${column + 1})` : base.name,
            base.unit === '—' ? undefined : base.unit,
          ),
        );
      }
    }
    if (!columns.length) {
      lonely.push(group[0].name);
      continue;
    }
    if (channels.length > MAX_RECORDING_CHANNELS)
      throw new Error(
        `The variables with ${length} samples hold ${channels.length.toLocaleString()} signals; a recording can have at most ${MAX_RECORDING_CHANNELS.toLocaleString()}.`,
      );
    const span = time?.leaf.increasing ?? { first: 0, last: length - 1 };
    tables.push({
      name: tableName,
      channels: uniqueChannels(channels),
      rows: length,
      start: span.first,
      end: span.last,
      notes: tableNotes,
    });
    plans.push({ time, length, columns });
  }
  if (lonely.length)
    notes.push(
      `Skipped ${listNames(lonely.map((name) => `“${name}”`))}: no other variable has the same number of samples.`,
    );
  if (tables.length === 1) tables[0].name = '';
  return { tables, plans };
}

function skippedNotes(skipped: Skip[]) {
  const notes: string[] = [];
  if (skipped.length)
    notes.push(
      `Skipped ${skipped.length === 1 ? 'a variable that is' : `${skipped.length} variables that are`} not a real numeric array: ${listNames(skipped.map((skip) => `${skip.name} (${skip.why})`))}.`,
    );
  if (skipped.some((skip) => skip.why === 'object'))
    notes.push(
      'MATLAB objects such as timeseries and timetable cannot be read; save their times and data as numeric arrays.',
    );
  return notes;
}

/** Opens a Level 5 or Level 4 MAT-file and lists its tables. */
export async function openMat(file: Blob): Promise<RecordingFile> {
  if (!file.size) throw new Error('The file is empty.');
  const bytes = new BlobBytes(file);
  const head = await bytes.bytes(0, Math.min(128, file.size));
  const text = new TextDecoder('latin1').decode(head.subarray(0, 20));
  const marker =
    head.length === 128 ? String.fromCharCode(head[126], head[127]) : '';
  const level5 = marker === 'IM' || marker === 'MI';
  // v7.3 files are HDF5 behind a MAT header with version 0x0200.
  const version = level5 ? view(head).getUint16(124, marker === 'IM') : 0;
  if (text.startsWith('MATLAB 7.3') || version === 0x0200)
    throw new Error(
      'This is a MATLAB v7.3 (HDF5) file. Save it in MATLAB with save(…, "-v7") and import it again.',
    );
  const parsed = level5
    ? await parseLevel5(file, bytes)
    : await parseLevel4(bytes);
  const notes = skippedNotes(parsed.skipped);
  const { tables, plans } = tablesOf(parsed.leaves, parsed.texts, notes);
  if (!tables.length)
    throw new Error(
      [
        'The MAT-file holds no numeric vectors or matrices with more than one sample.',
        ...notes,
      ].join(' '),
    );

  const samples = new BlobBytes(file, 65536);
  /** Inflates compressed variables once, keeping only the needed columns. */
  async function extract(parts: Part[]) {
    const kept = new Map<Part, Uint8Array>();
    const byStore = new Map<number, Part[]>();
    for (const part of parts)
      if (part.leaf.store && !part.leaf.inline)
        byStore.set(part.leaf.store.offset, [
          ...(byStore.get(part.leaf.store.offset) ?? []),
          part,
        ]);
    for (const group of byStore.values()) {
      const reader = new InflateReader(file, group[0].leaf.store!);
      try {
        const ordered = group
          .map((part) => ({ part, ...range(part) }))
          .sort((a, b) => a.start - b.start);
        for (const { part, start, length } of ordered) {
          await reader.skipTo(start);
          kept.set(part, (await reader.take(length)).slice());
        }
      } finally {
        reader.close();
      }
    }
    return kept;
  }
  function range(part: Part) {
    const { leaf } = part;
    const vector = leaf.rows === 1 || leaf.cols === 1;
    const length =
      (vector ? leaf.rows * leaf.cols : leaf.rows) * SIZES[leaf.type];
    return { start: leaf.offset + part.column * length, length };
  }

  async function* read(index: number): AsyncGenerator<RecordingBlock> {
    const plan = plans[index];
    if (!plan) throw new Error('The MAT-file has no such table.');
    const parts = plan.time ? [plan.time, ...plan.columns] : plan.columns;
    const kept = await extract(parts);
    const samplesOf = async (part: Part, first: number, count: number) => {
      const { leaf } = part;
      const size = SIZES[leaf.type];
      if (leaf.inline)
        return leaf.inline.slice(
          part.column * plan.length + first,
          part.column * plan.length + first + count,
        );
      const stored = kept.get(part);
      const data = stored
        ? stored.subarray(first * size, (first + count) * size)
        : await samples.bytes(range(part).start + first * size, count * size);
      return decode(data, leaf.type, leaf.little);
    };
    for (let first = 0; first < plan.length; first += BLOCK_ROWS) {
      const count = Math.min(BLOCK_ROWS, plan.length - first);
      const time = plan.time
        ? await samplesOf(plan.time, first, count)
        : Float64Array.from({ length: count }, (_, r) => first + r);
      const values: Float64Array[] = [];
      for (const part of plan.columns)
        values.push(await samplesOf(part, first, count));
      yield { time, values, progress: (first + count) / plan.length };
    }
  }

  return { format: parsed.format, tables, notes, read };
}
