/**
 * ASAM MDF 4.x and 3.x measurement files. Each channel group with numeric
 * channels becomes one table timed by its master channel. Metadata is parsed
 * from small random-access reads; samples stream through bounded slices of the
 * data blocks, one compressed block at a time, so file size never limits
 * memory. Sorted and unsorted data groups share one record scanner.
 */
import {
  BLOCK_ROWS,
  BlobBytes,
  MAX_RECORDING_CHANNELS,
  decodeText,
  inflate,
  namedChannel,
  uint64,
  uniqueChannels,
} from './recording';
import type {
  RecordingBlock,
  RecordingFile,
  RecordingTable,
} from './recording';

/** Largest slice of raw data read at once. */
const SLICE = 8 << 20;
/** Metadata blocks larger than this are treated as damage. */
const MAX_META = 64 << 20;
/** Names listed in a note before “and N more”. */
const NOTE_NAMES = 8;

type Convert = (raw: number) => number;
/** Reads one raw value; `at` is the record's first data byte. */
type Decode = (view: DataView, at: number) => number;

type Field = {
  name: string;
  unit: string;
  /** Null for virtual channels, whose raw value is the record number. */
  decode: Decode | null;
  convert: Convert;
  /** Invalidation bit, relative to the record's first data byte. */
  invalidByte: number;
  invalidMask: number;
  allInvalid: boolean;
};

/** Stored bytes of one data block; `zip` blocks inflate to `original`. */
type Segment = {
  offset: number;
  length: number;
  zip?: { transposed: boolean; columns: number; original: number };
};

/** One data group's record stream. */
type Layout = {
  segments: Segment[];
  /** Logical (inflated) bytes in the stream. */
  total: number;
  idSize: number;
  /** MDF 3 can repeat the record ID after the record. */
  idAfter: boolean;
  /** Bytes after the ID per record ID; -1 marks variable-length records. */
  sizes: Map<number, number>;
};

type Group = {
  layout: Layout;
  recordId: number;
  time: Field | null;
  fields: Field[];
  /** Records of this group to read at most. */
  cap: number;
};

type Conversion =
  | { kind: 'value'; convert: Convert; unit: string }
  | { kind: 'text'; convert: Convert; unit: string }
  | { kind: 'unsupported'; formula: boolean };

const identity: Convert = (x) => x;

const damaged = (detail = '') =>
  new Error(
    `The MDF file is damaged${detail ? ` (${detail})` : ''} and cannot be read.`,
  );

/** Walks a linked list iteratively and refuses to revisit a block. */
function guard() {
  const seen = new Set<number>();
  return (link: number) => {
    if (seen.has(link)) throw damaged('its blocks link in a loop');
    seen.add(link);
  };
}

function listNames(names: string[]) {
  const shown = names.slice(0, NOTE_NAMES).join(', ');
  const more = names.length - NOTE_NAMES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export async function openMdf(file: Blob): Promise<RecordingFile> {
  const bytes = new BlobBytes(file);
  if (file.size < 64) throw new Error('The file is too short to be MDF.');
  const id = await bytes.bytes(0, 64);
  const signature = decodeText(id.subarray(0, 8), 'latin1');
  if (signature !== 'MDF     ' && signature !== 'UnFinMF ')
    throw new Error('The file does not start like an MDF file.');
  const view = new DataView(id.buffer, id.byteOffset, 64);
  const versionText = decodeText(id.subarray(8, 16), 'latin1').trim();
  const unfinalized = signature === 'UnFinMF ';
  const little3 = view.getUint16(24, true) === 0;
  // MDF 3 stores the version number in the file's own byte order.
  const number = little3 ? view.getUint16(28, true) : view.getUint16(28, false);
  const version4 = number >= 400 || versionText.startsWith('4');
  const format = `ASAM MDF ${versionText || (number / 100).toFixed(2)}`;
  const context: Context = {
    file,
    bytes,
    headers: new BlobBytes(file, 4096),
    unfinalized,
    unfinalizedFlags: view.getUint16(60, true),
    notes: [],
    skipped: [],
    formulas: [],
    groups: [],
    tables: [],
  };
  if (version4) await parse4(context);
  else await parse3(context, little3);
  return finish(context, format);
}

type Context = {
  file: Blob;
  bytes: BlobBytes;
  /** Small read-ahead for data block headers scattered through the file. */
  headers: BlobBytes;
  unfinalized: boolean;
  unfinalizedFlags: number;
  notes: string[];
  skipped: string[];
  formulas: string[];
  groups: Group[];
  tables: RecordingTable[];
};

/** Collects one channel group's fields into a table and its read plan. */
type Pending = {
  name: string;
  layout: Layout;
  recordId: number;
  recordLength: number;
  cycles: number;
  sorted: boolean;
  time: Field | null;
  axisNote?: string;
  fields: Field[];
  texts: string[];
};

function addGroup(context: Context, pending: Pending) {
  const { layout, fields } = pending;
  if (!fields.length) return;
  if (fields.length > MAX_RECORDING_CHANNELS)
    throw new Error(
      `The group “${pending.name}” has ${fields.length.toLocaleString()} channels; a recording can have at most ${MAX_RECORDING_CHANNELS.toLocaleString()}.`,
    );
  let rows: number | undefined;
  let cap = Infinity;
  if (pending.sorted) {
    const present =
      pending.recordLength > 0
        ? Math.floor(layout.total / pending.recordLength)
        : pending.cycles;
    rows = context.unfinalized ? present : Math.min(pending.cycles, present);
    cap = rows;
  } else if (!context.unfinalized) {
    // Unsorted counts are only exact after a scan; trust intact metadata.
    cap = pending.cycles;
    if (layout.total >= pending.cycles * pending.recordLength) rows = cap;
  }
  if (rows === 0) return;
  const notes: string[] = [];
  if (!pending.time) notes.push('No time channel: time is the sample number.');
  else if (pending.axisNote) notes.push(pending.axisNote);
  if (pending.texts.length)
    notes.push(
      `Text labels were not applied to ${listNames(pending.texts)}; raw values are shown.`,
    );
  context.tables.push({
    name: pending.name,
    channels: uniqueChannels(
      fields.map((field) => namedChannel(field.name, field.unit)),
    ),
    ...(rows === undefined ? {} : { rows }),
    ...(notes.length ? { notes } : {}),
  });
  context.groups.push({
    layout,
    recordId: pending.recordId,
    time: pending.time,
    fields,
    cap,
  });
}

function finish(context: Context, format: string): RecordingFile {
  const { tables, groups, file } = context;
  const notes = [...context.notes];
  if (context.unfinalized)
    notes.unshift(
      'The logger did not finalize this file; Stratum read the data that is present.',
    );
  if (context.skipped.length)
    notes.push(
      `Skipped ${plural(context.skipped.length, 'text or unsupported channel')}: ${listNames(context.skipped)}.`,
    );
  if (context.formulas.length)
    notes.push(
      `Skipped ${plural(context.formulas.length, 'channel')} whose conversion formula could not be evaluated: ${listNames(context.formulas)}.`,
    );
  if (!tables.length)
    throw new Error(
      context.skipped.length || context.formulas.length
        ? 'The MDF file has no numeric channels that Stratum can import.'
        : 'The MDF file has no measured data.',
    );
  // Table names are unique within the file.
  const seen = new Map<string, number>();
  for (const table of tables) {
    const key = table.name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) table.name = `${table.name} (${count})`;
  }
  return {
    format,
    tables,
    ...(notes.length ? { notes } : {}),
    read: (table: number) => {
      const group = groups[table];
      if (!group) throw new Error('The MDF file has no such group.');
      return readGroup(file, group);
    },
  };
}

// ---------------------------------------------------------------------------
// Record streaming

async function* readGroup(
  file: Blob,
  group: Group,
): AsyncGenerator<RecordingBlock> {
  const { layout, fields, time, recordId, cap } = group;
  const { idSize, idAfter, sizes, total } = layout;
  const width = fields.length;
  let times = new Float64Array(BLOCK_ROWS);
  let columns = fields.map(() => new Float64Array(BLOCK_ROWS));
  let filled = 0;
  let index = 0;
  let consumed = 0;
  let carry: Uint8Array | null = null;
  const fixed = idSize ? 0 : (sizes.get(recordId) ?? 0);
  if (cap <= 0) return;
  if (!idSize && !fixed) {
    // Groups of virtual channels only store no bytes per record.
    const empty = new DataView(new ArrayBuffer(0));
    while (index < cap) {
      const rows = Math.min(BLOCK_ROWS, cap - index);
      const t = new Float64Array(rows);
      const values = fields.map(() => new Float64Array(rows));
      for (let r = 0; r < rows; r++, index++) {
        t[r] = time ? sample(time, empty, 0, index) : index;
        for (let c = 0; c < width; c++)
          values[c][r] = sample(fields[c], empty, 0, index);
      }
      yield { time: t, values, progress: index / cap };
    }
    return;
  }
  for await (const chunk of stream(file, layout.segments)) {
    const data: Uint8Array = carry ? concat(carry, chunk) : chunk;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const end = data.length;
    let at = 0;
    while (true) {
      let id = recordId;
      let length = fixed;
      if (idSize) {
        if (at + idSize > end) break;
        id = readId(view, at, idSize);
        const size = sizes.get(id);
        if (size === undefined) throw damaged('a record has an unknown ID');
        if (size < 0) {
          if (at + idSize + 4 > end) break;
          length = idSize + 4 + view.getUint32(at + idSize, true);
        } else length = idSize + size + (idAfter ? idSize : 0);
      }
      if (length <= 0) throw damaged('a channel group has no record size');
      if (at + length > end) break;
      if (id === recordId) {
        const base = at + idSize;
        times[filled] = time ? sample(time, view, base, index) : index;
        for (let c = 0; c < width; c++)
          columns[c][filled] = sample(fields[c], view, base, index);
        filled++;
        index++;
        if (filled === BLOCK_ROWS || index >= cap) {
          const progress =
            index >= cap ? 1 : Math.min(1, (consumed + at + length) / total);
          yield block(times, columns, filled, progress);
          filled = 0;
          if (index >= cap) return;
          times = new Float64Array(BLOCK_ROWS);
          columns = fields.map(() => new Float64Array(BLOCK_ROWS));
        }
      }
      at += length;
    }
    // A record straddling two slices or blocks continues in the next one.
    consumed += at;
    carry = at < end ? data.slice(at) : null;
  }
  if (filled) yield block(times, columns, filled, 1);
}

function sample(field: Field, view: DataView, base: number, index: number) {
  if (field.allInvalid) return NaN;
  if (
    field.invalidMask &&
    view.getUint8(base + field.invalidByte) & field.invalidMask
  )
    return NaN;
  const raw = field.decode ? field.decode(view, base) : index;
  return field.convert(raw);
}

function block(
  times: Float64Array,
  columns: Float64Array[],
  rows: number,
  progress: number,
): RecordingBlock {
  if (rows === times.length) return { time: times, values: columns, progress };
  return {
    time: times.slice(0, rows),
    values: columns.map((column) => column.slice(0, rows)),
    progress,
  };
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function readId(view: DataView, at: number, size: number) {
  if (size === 1) return view.getUint8(at);
  if (size === 2) return view.getUint16(at, true);
  if (size === 4) return view.getUint32(at, true);
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
}

/** Yields a data group's logical bytes in bounded pieces. */
async function* stream(
  file: Blob,
  segments: Segment[],
): AsyncGenerator<Uint8Array> {
  const read = async (start: number, end: number) =>
    new Uint8Array(await file.slice(start, end).arrayBuffer());
  for (let i = 0; i < segments.length;) {
    const segment = segments[i];
    if (segment.zip) {
      i++;
      const packed = await read(
        segment.offset,
        segment.offset + segment.length,
      );
      let data = await inflate(packed, 'deflate');
      if (data.length < segment.zip.original)
        throw new Error(
          'A compressed data block is damaged and cannot be read.',
        );
      data = data.subarray(0, segment.zip.original);
      if (segment.zip.transposed) data = untranspose(data, segment.zip.columns);
      if (data.length) yield data;
      continue;
    }
    if (segment.length > SLICE) {
      i++;
      for (let at = 0; at < segment.length; at += SLICE)
        yield await read(
          segment.offset + at,
          segment.offset + Math.min(segment.length, at + SLICE),
        );
      continue;
    }
    // Neighbouring small blocks share one read.
    let last = i;
    let length = segment.length;
    while (
      last + 1 < segments.length &&
      !segments[last + 1].zip &&
      segments[last + 1].offset >= segment.offset &&
      segments[last + 1].offset + segments[last + 1].length - segment.offset <=
        SLICE
    ) {
      last++;
      length += segments[last].length;
    }
    const span = segments[last].offset + segments[last].length - segment.offset;
    const window = await read(segment.offset, segment.offset + span);
    if (last === i) yield window;
    else {
      const out = new Uint8Array(length);
      let at = 0;
      for (let j = i; j <= last; j++) {
        const start = segments[j].offset - segment.offset;
        out.set(window.subarray(start, start + segments[j].length), at);
        at += segments[j].length;
      }
      yield out;
    }
    i = last + 1;
  }
}

/** Undoes DZ transposition: bytes were stored column by column. */
function untranspose(data: Uint8Array, columns: number) {
  if (columns <= 1) return data;
  const rows = Math.floor(data.length / columns);
  if (rows <= 1) return data;
  const out = new Uint8Array(data.length);
  for (let c = 0; c < columns; c++) {
    const from = c * rows;
    for (let r = 0; r < rows; r++) out[r * columns + c] = data[from + r];
  }
  out.set(data.subarray(rows * columns), rows * columns);
  return out;
}

// ---------------------------------------------------------------------------
// Raw value decoding

type NumberKind = 'uint' | 'int' | 'float';

function half(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * Builds a reader for a value of `bitCount` bits starting `bitOffset` bits
 * into the byte at `byteOffset`; null when the layout is not numeric or does
 * not fit the record.
 */
function decoder(
  kind: NumberKind,
  little: boolean,
  byteOffset: number,
  bitOffset: number,
  bitCount: number,
  recordBytes: number,
): Decode | null {
  const span = Math.ceil((bitOffset + bitCount) / 8);
  if (bitCount < 1 || bitCount > 64 || byteOffset + span > recordBytes)
    return null;
  const o = byteOffset;
  if (kind === 'float') {
    if (bitOffset) return null;
    if (bitCount === 64) return (v, at) => v.getFloat64(at + o, little);
    if (bitCount === 32) return (v, at) => v.getFloat32(at + o, little);
    if (bitCount === 16) return (v, at) => half(v.getUint16(at + o, little));
    return null;
  }
  const signed = kind === 'int';
  if (!bitOffset) {
    if (bitCount === 8)
      return signed
        ? (v, at) => v.getInt8(at + o)
        : (v, at) => v.getUint8(at + o);
    if (bitCount === 16)
      return signed
        ? (v, at) => v.getInt16(at + o, little)
        : (v, at) => v.getUint16(at + o, little);
    if (bitCount === 32)
      return signed
        ? (v, at) => v.getInt32(at + o, little)
        : (v, at) => v.getUint32(at + o, little);
    if (bitCount === 64)
      return signed
        ? (v, at) => Number(v.getBigInt64(at + o, little))
        : (v, at) => Number(v.getBigUint64(at + o, little));
  }
  // Bit fields: gather the bytes in order, shift and mask.
  if (span <= 6) {
    const scale = 2 ** bitOffset;
    const range = 2 ** bitCount;
    const top = 2 ** (bitCount - 1);
    return (v, at) => {
      let value = 0;
      if (little)
        for (let i = span - 1; i >= 0; i--)
          value = value * 256 + v.getUint8(at + o + i);
      else
        for (let i = 0; i < span; i++)
          value = value * 256 + v.getUint8(at + o + i);
      value = Math.floor(value / scale) % range;
      return signed && value >= top ? value - range : value;
    };
  }
  const shift = BigInt(bitOffset);
  const mask = (BigInt(1) << BigInt(bitCount)) - BigInt(1);
  const top = BigInt(1) << BigInt(bitCount - 1);
  const eight = BigInt(8);
  return (v, at) => {
    let value = BigInt(0);
    for (let i = 0; i < span; i++) {
      const byte = BigInt(v.getUint8(at + o + (little ? span - 1 - i : i)));
      value = (value << eight) | byte;
    }
    value = (value >> shift) & mask;
    return Number(signed && value >= top ? value - (mask + BigInt(1)) : value);
  };
}

// ---------------------------------------------------------------------------
// Conversions shared by both versions

function linear(factor: number, offset: number): Convert {
  if (factor === 1 && offset === 0) return identity;
  return (x) => x * factor + offset;
}

function rational(p: number[]): Convert {
  const [p1, p2, p3, p4, p5, p6] = p;
  if (!p1 && !p3 && !p4 && !p5 && p6) return linear(p2 / p6, 0);
  return (x) => (p1 * x * x + p2 * x + p3) / (p4 * x * x + p5 * x + p6);
}

/** Value-to-value tables with sorted keys. */
function table(keys: number[], values: number[], interpolate: boolean) {
  const n = keys.length;
  if (!n) return null;
  return (x: number) => {
    if (Number.isNaN(x)) return NaN;
    if (x <= keys[0]) return values[0];
    if (x >= keys[n - 1]) return values[n - 1];
    let low = 0;
    let high = n - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (keys[mid] <= x) low = mid;
      else high = mid;
    }
    const k0 = keys[low];
    const k1 = keys[high];
    if (interpolate)
      return k1 === k0
        ? values[low]
        : values[low] + ((values[high] - values[low]) * (x - k0)) / (k1 - k0);
    // The nearer key wins; a tie takes the lower one.
    return x - k0 <= k1 - x ? values[low] : values[high];
  };
}

/** Value-range tables: integer ranges include their upper end. */
function ranges(
  lower: number[],
  upper: number[],
  values: number[],
  fallback: number,
  float: boolean,
): Convert {
  return (x) => {
    for (let i = 0; i < lower.length; i++)
      if (x >= lower[i] && (float ? x < upper[i] : x <= upper[i]))
        return values[i];
    return fallback;
  };
}

const FUNCTIONS = new Map<string, (x: number) => number>(
  Object.entries({
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    exp: Math.exp,
    log: Math.log,
    ln: Math.log,
    log10: Math.log10,
    sqrt: Math.sqrt,
    abs: Math.abs,
  }),
);

type Instruction =
  | { op: 'number'; value: number }
  | { op: 'x' }
  | { op: 'negate' }
  | { op: '+' | '-' | '*' | '/' | '^' }
  | { op: 'call'; fn: (x: number) => number };

const PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  negate: 3,
  '^': 4,
};

/**
 * Compiles an algebraic conversion of X (numbers, + - * / ^ **, unary minus,
 * parentheses, pi and common functions) with the shunting-yard method; never
 * uses eval. Returns null for anything else.
 */
export function compileFormula(formula: string): Convert | null {
  if (formula.length > 4096) return null;
  const token =
    /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^()]))/y;
  type Waiting =
    | { kind: 'op'; op: string }
    | { kind: 'paren' }
    | {
        kind: 'call';
        fn: (x: number) => number;
      };
  const output: Instruction[] = [];
  const stack: Waiting[] = [];
  let operand = true;
  let at = 0;
  const source = formula.trim();
  const emit = (item: Waiting) => {
    if (item.kind === 'call') output.push({ op: 'call', fn: item.fn });
    else if (item.kind === 'op')
      output.push(
        item.op === 'negate'
          ? { op: 'negate' }
          : { op: item.op as '+' | '-' | '*' | '/' | '^' },
      );
  };
  while (at < source.length) {
    token.lastIndex = at;
    const match = token.exec(source);
    if (!match) return null;
    at = token.lastIndex;
    const [, num, name, symbolRaw] = match;
    const symbol = symbolRaw === '**' ? '^' : symbolRaw;
    if (operand) {
      if (num !== undefined) {
        output.push({ op: 'number', value: Number(num) });
        operand = false;
      } else if (name !== undefined) {
        const lower = name.toLowerCase();
        if (lower === 'x' || lower === 'x1') {
          output.push({ op: 'x' });
          operand = false;
        } else if (lower === 'pi') {
          output.push({ op: 'number', value: Math.PI });
          operand = false;
        } else if (FUNCTIONS.has(lower)) {
          stack.push({ kind: 'call', fn: FUNCTIONS.get(lower)! });
          token.lastIndex = at;
          const open = token.exec(source);
          if (!open || open[3] !== '(') return null;
          at = token.lastIndex;
          stack.push({ kind: 'paren' });
        } else return null;
      } else if (symbol === '(') stack.push({ kind: 'paren' });
      else if (symbol === '-') stack.push({ kind: 'op', op: 'negate' });
      else if (symbol !== '+') return null;
    } else if (symbol === ')') {
      let top = stack.pop();
      while (top && top.kind !== 'paren') {
        emit(top);
        top = stack.pop();
      }
      if (!top) return null;
      const call = stack[stack.length - 1];
      if (call?.kind === 'call') emit(stack.pop()!);
    } else if (symbol && symbol in PRECEDENCE) {
      const precedence = PRECEDENCE[symbol];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.kind !== 'op') break;
        const other = PRECEDENCE[top.op];
        // ^ is right-associative; prefix minus is never popped by ^.
        if (other > precedence || (other === precedence && symbol !== '^'))
          emit(stack.pop()!);
        else break;
      }
      stack.push({ kind: 'op', op: symbol });
      operand = true;
    } else return null;
  }
  if (operand) return null;
  while (stack.length) {
    const top = stack.pop()!;
    if (top.kind !== 'op') return null;
    emit(top);
  }
  // Check the stack balance once so evaluation never underflows.
  let depth = 0;
  let deepest = 0;
  for (const item of output) {
    if (item.op === 'number' || item.op === 'x') depth++;
    else if (item.op !== 'negate' && item.op !== 'call') depth--;
    if (depth < 1) return null;
    deepest = Math.max(deepest, depth);
  }
  if (depth !== 1) return null;
  const values = new Float64Array(deepest);
  return (x) => {
    let top = -1;
    for (const item of output) {
      switch (item.op) {
        case 'number':
          values[++top] = item.value;
          break;
        case 'x':
          values[++top] = x;
          break;
        case 'negate':
          values[top] = -values[top];
          break;
        case 'call':
          values[top] = item.fn(values[top]);
          break;
        default: {
          const b = values[top--];
          const a = values[top];
          values[top] =
            item.op === '+'
              ? a + b
              : item.op === '-'
                ? a - b
                : item.op === '*'
                  ? a * b
                  : item.op === '/'
                    ? a / b
                    : a ** b;
        }
      }
    }
    return values[0];
  };
}

// ---------------------------------------------------------------------------
// MDF 4

type Block4 = {
  id: string;
  links: number[];
  data: DataView;
  /** Data section bytes, for text. */
  raw: Uint8Array;
};

async function block4(
  bytes: BlobBytes,
  offset: number,
  expected: readonly string[],
): Promise<Block4> {
  const head = await bytes.view(offset, 24);
  const id = String.fromCharCode(
    head.getUint8(0),
    head.getUint8(1),
    head.getUint8(2),
    head.getUint8(3),
  );
  const length = uint64(head, 8);
  const count = uint64(head, 16);
  if (!expected.includes(id) || length < 24 + count * 8 || length > MAX_META)
    throw damaged(`a block at byte ${offset} is not the expected kind`);
  const body = await bytes.bytes(offset + 24, length - 24);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const links: number[] = [];
  for (let i = 0; i < count; i++) links.push(uint64(view, i * 8));
  const raw = body.subarray(count * 8);
  return {
    id,
    links,
    data: new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    raw,
  };
}

const unescapeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    const lower = String(code).toLowerCase();
    if (lower[0] === '#') {
      const point =
        lower[1] === 'x'
          ? parseInt(lower.slice(2), 16)
          : parseInt(lower.slice(1), 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? '';
  });

/** Text of a TX block, or the <TX> element of an MD block. */
async function text4(bytes: BlobBytes, link: number) {
  if (!link) return '';
  const block = await block4(bytes, link, ['##TX', '##MD']);
  const text = decodeText(block.raw, 'utf-8');
  if (block.id === '##TX') return text;
  const match = text.match(/<TX(?:\s[^>]*)?>([\s\S]*?)<\/TX>/);
  return match ? unescapeXml(match[1]).trim() : '';
}

async function conversion4(
  bytes: BlobBytes,
  link: number,
  float: boolean,
): Promise<Conversion> {
  if (!link) return { kind: 'value', convert: identity, unit: '' };
  const cc = await block4(bytes, link, ['##CC']);
  const d = cc.data;
  if (d.byteLength < 24) throw damaged('a conversion block is too short');
  const type = d.getUint8(0);
  const count = d.getUint16(6, true);
  if (24 + count * 8 > d.byteLength)
    throw damaged('a conversion block is too short');
  const vals: number[] = [];
  for (let i = 0; i < count; i++) vals.push(d.getFloat64(24 + i * 8, true));
  const unit = await text4(bytes, cc.links[1] ?? 0);
  const value = (convert: Convert | null): Conversion =>
    convert
      ? { kind: 'value', convert, unit }
      : { kind: 'unsupported', formula: false };
  switch (type) {
    case 0:
      return value(identity);
    case 1:
      return value(count >= 2 ? linear(vals[1], vals[0]) : null);
    case 2:
      return value(count >= 6 ? rational(vals) : null);
    case 3: {
      const formula = compileFormula(await text4(bytes, cc.links[4] ?? 0));
      return formula
        ? { kind: 'value', convert: formula, unit }
        : { kind: 'unsupported', formula: true };
    }
    case 4:
    case 5: {
      const n = count >> 1;
      const keys = vals.filter((_, i) => i % 2 === 0).slice(0, n);
      const phys = vals.filter((_, i) => i % 2 === 1).slice(0, n);
      return value(table(keys, phys, type === 4));
    }
    case 6: {
      const n = Math.floor((count - 1) / 3);
      if (n < 0 || count < 1) return value(null);
      const lower: number[] = [];
      const upper: number[] = [];
      const phys: number[] = [];
      for (let i = 0; i < n; i++) {
        lower.push(vals[i * 3]);
        upper.push(vals[i * 3 + 1]);
        phys.push(vals[i * 3 + 2]);
      }
      return value(ranges(lower, upper, phys, vals[n * 3], float));
    }
    case 7:
    case 8:
    case 11:
      return { kind: 'text', convert: identity, unit };
    default:
      return value(null);
  }
}

/** Data types 0–5: unsigned, signed and float, little then big endian. */
const KIND4: readonly NumberKind[] = [
  'uint',
  'uint',
  'int',
  'int',
  'float',
  'float',
];
const SYNC_AXIS = ['', '', 'an angle', 'a distance', 'a sample index'];

async function parse4(context: Context) {
  const { bytes } = context;
  const hd = await block4(bytes, 64, ['##HD']);
  const visitGroup = guard();
  let groupNumber = 0;
  const layouts: Layout[] = [];
  const all: Pending[] = [];
  for (let dgLink = hd.links[0] ?? 0; dgLink;) {
    visitGroup(dgLink);
    const dg = await block4(bytes, dgLink, ['##DG']);
    dgLink = dg.links[0] ?? 0;
    const idSize = dg.data.byteLength ? dg.data.getUint8(0) : 0;
    if (![0, 1, 2, 4, 8].includes(idSize))
      throw damaged('a data group has an invalid record ID size');
    const layout: Layout = {
      segments: [],
      total: 0,
      idSize,
      idAfter: false,
      sizes: new Map(),
    };
    const pendings: Pending[] = [];
    const visitChannelGroup = guard();
    for (let cgLink = dg.links[1] ?? 0; cgLink;) {
      visitChannelGroup(cgLink);
      const cg = await block4(bytes, cgLink, ['##CG']);
      cgLink = cg.links[0] ?? 0;
      if (cg.data.byteLength < 32)
        throw damaged('a channel group block is too short');
      const recordId = uint64(cg.data, 0);
      const cycles = uint64(cg.data, 8);
      const flags = cg.data.getUint16(16, true);
      const dataBytes = cg.data.getUint32(24, true);
      const invalidBytes = cg.data.getUint32(28, true);
      if (flags & 1) {
        // Variable-length signal data for string channels.
        layout.sizes.set(recordId, -1);
        continue;
      }
      if (layout.sizes.has(recordId))
        throw damaged('two channel groups share a record ID');
      layout.sizes.set(recordId, dataBytes + invalidBytes);
      groupNumber++;
      const name =
        (await text4(bytes, cg.links[2] ?? 0)).trim() ||
        (await sourceName4(bytes, cg.links[3] ?? 0)) ||
        `Group ${groupNumber}`;
      const pending: Pending = {
        name,
        layout,
        recordId,
        recordLength: idSize + dataBytes + invalidBytes,
        cycles,
        sorted: false,
        time: null,
        fields: [],
        texts: [],
      };
      await channels4(
        context,
        cg.links[1] ?? 0,
        dataBytes,
        invalidBytes,
        pending,
      );
      pendings.push(pending);
    }
    if (!pendings.length) continue;
    if (!idSize && layout.sizes.size > 1)
      throw damaged('an unsorted data group has no record IDs');
    if (pendings.length === 1 && layout.sizes.size === 1)
      pendings[0].sorted = true;
    layout.segments = await segments4(context, dg.links[2] ?? 0);
    layouts.push(layout);
    all.push(...pendings);
  }
  if (context.unfinalized && context.unfinalizedFlags & 4)
    extendLastBlock(context, layouts);
  for (const layout of layouts)
    layout.total = layout.segments.reduce(
      (sum, s) => sum + (s.zip ? s.zip.original : s.length),
      0,
    );
  for (const pending of all) addGroup(context, pending);
}

async function sourceName4(bytes: BlobBytes, link: number) {
  if (!link) return '';
  const si = await block4(bytes, link, ['##SI']);
  return (await text4(bytes, si.links[0] ?? 0)).trim();
}

async function channels4(
  context: Context,
  first: number,
  dataBytes: number,
  invalidBytes: number,
  pending: Pending,
) {
  const { bytes } = context;
  const visit = guard();
  for (let link = first; link;) {
    visit(link);
    const cn = await block4(bytes, link, ['##CN']);
    link = cn.links[0] ?? 0;
    const d = cn.data;
    if (d.byteLength < 24) throw damaged('a channel block is too short');
    const type = d.getUint8(0);
    const sync = d.getUint8(1);
    const dataType = d.getUint8(2);
    const flags = d.getUint32(12, true);
    const invalidBit = d.getUint32(16, true);
    const name = (await text4(bytes, cn.links[2] ?? 0)).trim() || 'Unnamed';
    const master = type === 2 || type === 3;
    const virtual = type === 3 || type === 6;
    // Structures and arrays (composition), VLSD, sync and text channels.
    const numeric =
      dataType <= 5 &&
      !cn.links[1] &&
      [0, 2, 3, 5, 6].includes(type) &&
      !(master && pending.time);
    if (!numeric) {
      context.skipped.push(name);
      continue;
    }
    const kind = KIND4[dataType];
    const decode = virtual
      ? null
      : decoder(
          kind,
          dataType % 2 === 0,
          d.getUint32(4, true),
          d.getUint8(3),
          d.getUint32(8, true),
          dataBytes,
        );
    if (!virtual && !decode) {
      context.skipped.push(name);
      continue;
    }
    const conversion = await conversion4(
      bytes,
      cn.links[4] ?? 0,
      kind === 'float',
    );
    if (conversion.kind === 'unsupported') {
      (conversion.formula ? context.formulas : context.skipped).push(name);
      continue;
    }
    const unit =
      (await text4(bytes, cn.links[6] ?? 0)).trim() || conversion.unit.trim();
    const field: Field = {
      name,
      unit,
      decode,
      convert: conversion.convert,
      invalidByte: 0,
      invalidMask: 0,
      allInvalid: (flags & 1) !== 0,
    };
    if (flags & 2 && invalidBit >> 3 < invalidBytes) {
      field.invalidByte = dataBytes + (invalidBit >> 3);
      field.invalidMask = 1 << (invalidBit & 7);
    }
    if (master) {
      pending.time = field;
      if (SYNC_AXIS[sync])
        pending.axisNote = `The axis is the master channel “${name}”, which is ${SYNC_AXIS[sync]}${unit ? ` in ${unit}` : ''}, not time.`;
      continue;
    }
    if (conversion.kind === 'text') pending.texts.push(name);
    pending.fields.push(field);
  }
}

async function blockId(bytes: BlobBytes, offset: number) {
  const head = await bytes.bytes(offset, 4);
  return String.fromCharCode(head[0], head[1], head[2], head[3]);
}

/** Lists a data group's data blocks in stream order. */
async function segments4(context: Context, link: number) {
  const out: Segment[] = [];
  if (!link) return out;
  const id = await blockId(context.headers, link);
  let list = 0;
  if (id === '##HL')
    list = (await block4(context.headers, link, ['##HL'])).links[0] ?? 0;
  else if (id === '##DL') list = link;
  else {
    const segment = await dataSegment(context, link);
    if (segment) out.push(segment);
    return out;
  }
  const visit = guard();
  while (list) {
    visit(list);
    const dl = await block4(context.headers, list, ['##DL']);
    list = dl.links[0] ?? 0;
    for (const item of dl.links.slice(1)) {
      const segment = item ? await dataSegment(context, item) : null;
      if (segment) out.push(segment);
    }
  }
  return out;
}

const TRUNCATED =
  'The file ends before its data does; Stratum read the records that are present.';

function truncated(context: Context) {
  if (!context.notes.includes(TRUNCATED)) context.notes.push(TRUNCATED);
}

async function dataSegment(
  context: Context,
  link: number,
): Promise<Segment | null> {
  const { headers, unfinalized } = context;
  const size = headers.size;
  const head = await headers.view(link, 24);
  const id = String.fromCharCode(
    head.getUint8(0),
    head.getUint8(1),
    head.getUint8(2),
    head.getUint8(3),
  );
  const length = uint64(head, 8);
  if (id === '##DT') {
    if (length < 24 && !unfinalized) throw damaged('a data block is too short');
    const offset = link + 24;
    let stored = Math.max(0, length - 24);
    if (offset + stored > size) {
      stored = Math.max(0, size - offset);
      truncated(context);
    }
    return { offset, length: stored };
  }
  if (id === '##DZ') {
    const dz = await headers.view(link, 48);
    const original = String.fromCharCode(dz.getUint8(24), dz.getUint8(25));
    const zip = dz.getUint8(26);
    if (original !== 'DT')
      throw new Error(
        'The MDF file stores compressed data in a layout Stratum cannot read yet.',
      );
    if (zip > 1)
      throw new Error(
        'The MDF file uses ZSTD or LZ4 compression, which Stratum cannot read yet. Save it with deflate compression or none.',
      );
    const packed = uint64(dz, 40);
    if (link + 48 + packed > size) {
      truncated(context);
      return null;
    }
    return {
      offset: link + 48,
      length: packed,
      zip: {
        transposed: zip === 1,
        columns: dz.getUint32(28, true),
        original: uint64(dz, 32),
      },
    };
  }
  if (id === '##DV' || id === '##DI')
    throw new Error(
      'The MDF file stores channels column by column (MDF 4.2), which Stratum cannot read yet.',
    );
  throw damaged('a data link points to an unknown block');
}

/** Unfinalized files may not record the length of the last data block. */
function extendLastBlock(context: Context, layouts: Layout[]) {
  let last: Segment | undefined;
  for (const layout of layouts)
    for (const segment of layout.segments)
      if (!segment.zip && (!last || segment.offset > last.offset))
        last = segment;
  if (last) last.length = context.file.size - last.offset;
}

// ---------------------------------------------------------------------------
// MDF 3

const latin1 = (bytes: Uint8Array) => decodeText(bytes, 'latin1');

async function block3(
  bytes: BlobBytes,
  offset: number,
  id: string,
  little: boolean,
  minimum: number,
) {
  const head = await bytes.view(offset, 4);
  const size = head.getUint16(2, little);
  if (
    head.getUint8(0) !== id.charCodeAt(0) ||
    head.getUint8(1) !== id.charCodeAt(1) ||
    size < minimum
  )
    throw damaged(`a block at byte ${offset} is not the expected kind`);
  return bytes.view(offset, size);
}

async function text3(bytes: BlobBytes, link: number, little: boolean) {
  if (!link) return '';
  const tx = await block3(bytes, link, 'TX', little, 4);
  return latin1(
    new Uint8Array(tx.buffer, tx.byteOffset + 4, tx.byteLength - 4),
  ).trim();
}

async function conversion3(
  bytes: BlobBytes,
  link: number,
  little: boolean,
): Promise<Conversion> {
  if (!link) return { kind: 'value', convert: identity, unit: '' };
  const cc = await block3(bytes, link, 'CC', little, 46);
  const unit = latin1(new Uint8Array(cc.buffer, cc.byteOffset + 22, 20)).trim();
  const type = cc.getUint16(42, little);
  const count = cc.getUint16(44, little);
  const param = (i: number, stride = 8, start = 0) => {
    const at = 46 + i * stride + start;
    if (at + 8 > cc.byteLength)
      throw damaged('a conversion block is too short');
    return cc.getFloat64(at, little);
  };
  const p = (n: number) => Array.from({ length: n }, (_, i) => param(i));
  const value = (convert: Convert | null): Conversion =>
    convert
      ? { kind: 'value', convert, unit }
      : { kind: 'unsupported', formula: false };
  switch (type) {
    case 0: {
      const [offset, factor] = p(2);
      return value(linear(factor, offset));
    }
    case 1:
    case 2: {
      const keys: number[] = [];
      const phys: number[] = [];
      for (let i = 0; i < count; i++) {
        keys.push(param(i, 16));
        phys.push(param(i, 16, 8));
      }
      return value(table(keys, phys, type === 1));
    }
    case 6: {
      const [p1, p2, p3, p4, p5, p6] = p(6);
      return value(
        (x) => (p2 - p4 * (x - p5 - p6)) / (p3 * (x - p5 - p6) - p1),
      );
    }
    case 7:
    case 8: {
      // Exponential and logarithmic: the inverse function of the stored one.
      const [p1, p2, p3, p4, p5, p6, p7] = p(7);
      const fn = type === 7 ? Math.log : Math.exp;
      if (p4 === 0) return value((x) => fn(((x - p7) * p6 - p3) / p1) / p2);
      if (p1 === 0) return value((x) => fn((p3 / (x - p7) - p6) / p4) / p5);
      return value(null);
    }
    case 9:
      return value(rational(p(6)));
    case 10: {
      const end = Math.min(cc.byteLength, 46 + 256);
      const formula = compileFormula(
        latin1(new Uint8Array(cc.buffer, cc.byteOffset + 46, end - 46)),
      );
      return formula
        ? { kind: 'value', convert: formula, unit }
        : { kind: 'unsupported', formula: true };
    }
    case 11:
    case 12:
      return { kind: 'text', convert: identity, unit };
    case 65535:
      return value(identity);
    default:
      return value(null);
  }
}

/** Data types: default-order, big-endian and little-endian numbers. */
function kind3(
  dataType: number,
  little: boolean,
): { kind: NumberKind; little: boolean } | null {
  const kinds: NumberKind[] = ['uint', 'int', 'float', 'float'];
  if (dataType <= 3) return { kind: kinds[dataType], little };
  if (dataType >= 9 && dataType <= 12)
    return { kind: kinds[dataType - 9], little: false };
  if (dataType >= 13 && dataType <= 16)
    return { kind: kinds[dataType - 13], little: true };
  return null;
}

async function parse3(context: Context, dataLittle: boolean) {
  const { bytes } = context;
  // Block fields follow the file's byte order; a header size that only makes
  // sense the other way round settles a mislabelled file.
  const head = await bytes.view(64, 4);
  const sane = (size: number) => size >= 164 && size <= 4096;
  let little = dataLittle;
  if (!sane(head.getUint16(2, little)) && sane(head.getUint16(2, !little)))
    little = !little;
  const hd = await block3(bytes, 64, 'HD', little, 12);
  const visitGroup = guard();
  let groupNumber = 0;
  for (let dgLink = hd.getUint32(4, little); dgLink;) {
    visitGroup(dgLink);
    const dg = await block3(bytes, dgLink, 'DG', little, 24);
    dgLink = dg.getUint32(4, little);
    const ids = dg.getUint16(22, little);
    const data = dg.getUint32(16, little);
    const layout: Layout = {
      segments: [],
      total: 0,
      idSize: ids ? 1 : 0,
      idAfter: ids === 2,
      sizes: new Map(),
    };
    const pendings: Pending[] = [];
    let length = 0;
    const visitChannelGroup = guard();
    for (let cgLink = dg.getUint32(8, little); cgLink;) {
      visitChannelGroup(cgLink);
      const cg = await block3(bytes, cgLink, 'CG', little, 26);
      cgLink = cg.getUint32(4, little);
      const recordId = cg.getUint16(16, little);
      const recordSize = cg.getUint16(20, little);
      const cycles = cg.getUint32(22, little);
      if (layout.sizes.has(recordId))
        throw damaged('two channel groups share a record ID');
      layout.sizes.set(recordId, recordSize);
      length += cycles * (recordSize + Math.min(ids, 2));
      groupNumber++;
      const pending: Pending = {
        name: `Group ${groupNumber}`,
        layout,
        recordId,
        recordLength: recordSize + Math.min(ids, 2),
        cycles,
        sorted: false,
        time: null,
        fields: [],
        texts: [],
      };
      await channels3(
        context,
        cg.getUint32(8, little),
        recordSize,
        little,
        dataLittle,
        pending,
      );
      pendings.push(pending);
    }
    if (!pendings.length || !data) continue;
    if (!layout.idSize && pendings.length > 1)
      throw damaged('an unsorted data group has no record IDs');
    if (pendings.length === 1) pendings[0].sorted = true;
    let end = data + length;
    if (context.unfinalized) end = bytes.size;
    else if (end > bytes.size) {
      end = bytes.size;
      truncated(context);
    }
    layout.segments = [{ offset: data, length: Math.max(0, end - data) }];
    layout.total = layout.segments[0].length;
    for (const pending of pendings) addGroup(context, pending);
  }
}

async function channels3(
  context: Context,
  first: number,
  recordSize: number,
  little: boolean,
  dataLittle: boolean,
  pending: Pending,
) {
  const { bytes } = context;
  const visit = guard();
  for (let link = first; link;) {
    visit(link);
    const cn = await block3(bytes, link, 'CN', little, 218);
    link = cn.getUint32(4, little);
    const short = latin1(new Uint8Array(cn.buffer, cn.byteOffset + 26, 32));
    const long =
      cn.byteLength >= 222
        ? await text3(bytes, cn.getUint32(218, little), little)
        : '';
    const name = (long || short).trim() || 'Unnamed';
    const type = cn.getUint16(24, little);
    const start = cn.getUint16(186, little);
    const bitCount = cn.getUint16(188, little);
    const extra = cn.byteLength >= 228 ? cn.getUint16(226, little) : 0;
    const numeric = kind3(cn.getUint16(190, little), dataLittle);
    const master = type === 1;
    if (!numeric || (master && pending.time)) {
      context.skipped.push(name);
      continue;
    }
    const decode = decoder(
      numeric.kind,
      numeric.little,
      extra + (start >> 3),
      start & 7,
      bitCount,
      recordSize,
    );
    if (!decode) {
      context.skipped.push(name);
      continue;
    }
    const conversion = await conversion3(
      bytes,
      cn.getUint32(8, little),
      little,
    );
    if (conversion.kind === 'unsupported') {
      (conversion.formula ? context.formulas : context.skipped).push(name);
      continue;
    }
    const field: Field = {
      name,
      unit: conversion.unit,
      decode,
      convert: conversion.convert,
      invalidByte: 0,
      invalidMask: 0,
      allInvalid: false,
    };
    if (master) pending.time = field;
    else {
      if (conversion.kind === 'text') pending.texts.push(name);
      pending.fields.push(field);
    }
  }
}
