/**
 * NI TDMS reader. Opening a file walks every segment's lead-in and metadata,
 * never its raw data, and keeps one shared layout per distinct object list, so
 * files with tens of thousands of segments stay small in memory. Reading a
 * table walks the segments again in bounded slices and decodes only that
 * table's channels. Each TDMS group becomes one table per distinct length and
 * time axis (waveform timing, a time channel, or the sample number).
 */
import {
  BLOCK_ROWS,
  BlobBytes,
  MAX_RECORDING_CHANNELS,
  decodeText,
  namedChannel,
  uint64,
  uniqueChannels,
  type RecordingBlock,
  type RecordingFile,
  type RecordingTable,
} from './recording';

const TOC_METADATA = 1 << 1;
const TOC_NEW_OBJECT_LIST = 1 << 2;
const TOC_RAW_DATA = 1 << 3;
const TOC_INTERLEAVED = 1 << 5;
const TOC_BIG_ENDIAN = 1 << 6;
const LEAD_IN = 28;
const NO_RAW_DATA = 0xffffffff;
const SAME_RAW_DATA = 0;
const DAQMX_FORMAT_SCALER = 0x1269;
// nptdms and real files use 0x126A; the NI format description says 0x1369.
const DAQMX_DIGITAL_SCALERS = new Set([0x126a, 0x1369]);
const RAW_SOURCE = 0xffffffff;
const NO_OFFSET = BigInt('0xFFFFFFFFFFFFFFFF');

// TDMS data type codes.
const I8 = 1;
const I16 = 2;
const I32 = 3;
const I64 = 4;
const U8 = 5;
const U16 = 6;
const U32 = 7;
const U64 = 8;
const SGL = 9;
const DBL = 10;
const SGL_UNIT = 0x19;
const DBL_UNIT = 0x1a;
const STRING = 0x20;
const BOOLEAN = 0x21;
const TIMESTAMP = 0x44;
const DAQMX_RAW = 0xffffffff;

/** Bytes per value; strings are variable and DAQmx data uses scalers. */
const SIZES = new Map<number, number>([
  [0, 0],
  [I8, 1],
  [I16, 2],
  [I32, 4],
  [I64, 8],
  [U8, 1],
  [U16, 2],
  [U32, 4],
  [U64, 8],
  [SGL, 4],
  [DBL, 8],
  [11, 16],
  [SGL_UNIT, 4],
  [DBL_UNIT, 8],
  [0x1b, 16],
  [BOOLEAN, 1],
  [TIMESTAMP, 16],
  [0x08000c, 8],
  [0x10000d, 16],
]);
const NUMERIC = new Set([
  I8,
  I16,
  I32,
  I64,
  U8,
  U16,
  U32,
  U64,
  SGL,
  DBL,
  SGL_UNIT,
  DBL_UNIT,
  BOOLEAN,
]);
/** DAQmx scaler type codes, which differ from TDMS codes. */
const DAQMX_TYPES = [U8, I8, U16, I16, U32, I32, U64, I64, SGL, DBL];

/** Largest raw-data slice read at once, and most values decoded per slice. */
const SLICE_BYTES = 8 << 20;
const SLICE_ROWS = 1 << 20;
/** Values a table may buffer while its channels are spread unevenly. */
const MAX_PENDING_VALUES = 8 << 20;
const NAME_LIMIT = 5;

type Property = number | string | boolean;
type Scaler = {
  type: number;
  buffer: number;
  /** Byte offset within the buffer row. */
  offset: number;
  /** Digital line bit within that byte, or -1. */
  bit: number;
  id: number;
};
type RawIndex = {
  type: number;
  /** Values per chunk. */
  count: number;
  /** Bytes per chunk (strings state their own total). */
  bytes: number;
  scalers?: Scaler[];
  widths?: number[];
};
type TdmsObject = {
  parts: string[] | null;
  properties: Map<string, Property>;
  /** Most recent raw data index, or -1. */
  last: number;
  length: number;
  indexes: Set<number>;
};
type Entry = { object: number; index: number; data: boolean };
type Geometry = {
  /** Values per entry in the chunk. */
  counts: number[];
  /** Byte offset of each entry's first value (interleaved: its column). */
  offsets: number[];
  /** DAQmx buffer rows and byte offsets in the chunk. */
  rows: number[];
  starts: number[];
};
type Layout = {
  objects: number[];
  indexes: RawIndex[];
  indexIds: number[];
  position: Map<number, number>;
  mode: 'contiguous' | 'interleaved' | 'daqmx';
  little: boolean;
  /** Bytes per full chunk. */
  chunk: number;
  /** Interleaved row width. */
  width: number;
  buffers: { rows: number; width: number }[];
  unsized: boolean;
  full: Geometry;
};
type Scale = { slope: number; intercept: number } | { coefficients: number[] };
type Target = {
  object: number;
  queue: Queue;
  /** DAQmx scale ID to read, or -1 for the first scaler. */
  scaler: number;
  scales: Scale[];
  factor: number;
  /** First timestamp (seconds, fraction) that a timestamp axis counts from. */
  origin?: [number, number];
};
type Column = {
  target: Target;
  type: number;
  size: number;
  bit: number;
  offset: number;
  stride: number;
  count: number;
};
type Plan = {
  columns: Column[];
  /** Every column tiles each chunk, so the segment reads as plain rows. */
  rows: boolean;
  dense: boolean;
  spanStart: number;
  spanEnd: number;
  maxCount: number;
};
type Scan = {
  file: Blob;
  layouts: Layout[];
  starts: number[];
  sizes: number[];
  ids: number[];
  /** Stored segment that runs to the end of a truncated file, or -1. */
  incomplete: number;
};
type ChannelInfo = {
  object: number;
  group: string;
  name: string;
  unit: string;
  scales: Scale[];
  scaler: number;
};
type TimeAxis =
  | { kind: 'wave'; offset: number; increment: number }
  | { kind: 'index' }
  | { kind: 'channel'; channel: ChannelInfo; factor: number }
  | { kind: 'stamp'; object: number; origin: [number, number] };
type TableInfo = { channels: ChannelInfo[]; time: TimeAxis; rows: number };

/** Seconds between the TDMS epoch (1904) and the Unix epoch. */
const EPOCH_1904 = 2_082_844_800;

/**
 * Splits a TDMS timestamp into whole seconds since 1904 (exact as a double)
 * and its 2^-64 fraction, so differences keep sub-nanosecond resolution.
 */
function stampParts(
  view: DataView,
  at: number,
  little: boolean,
): [number, number] {
  const [seconds, fraction] = little ? [at + 8, at] : [at, at + 8];
  const [high, low] = little ? [4, 0] : [0, 4];
  return [
    view.getInt32(seconds + high, little) * 2 ** 32 +
      view.getUint32(seconds + low, little),
    view.getUint32(fraction + high, little) * 2 ** -32 +
      view.getUint32(fraction + low, little) * 2 ** -64,
  ];
}

const HOST_LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const damaged = () =>
  new Error('The TDMS metadata is damaged and cannot be read.');

/** Growable FIFO of decoded values for one channel. */
class Queue {
  data = new Float64Array(4096);
  private head = 0;
  private tail = 0;
  get length() {
    return this.tail - this.head;
  }
  /** Makes room for `n` values and returns where they start. */
  reserve(n: number) {
    if (this.tail + n > this.data.length) {
      const live = this.tail - this.head;
      if (live + n <= this.data.length >> 1)
        this.data.copyWithin(0, this.head, this.tail);
      else {
        let size = this.data.length * 2;
        while (size < live + n) size *= 2;
        const data = new Float64Array(size);
        data.set(this.data.subarray(this.head, this.tail));
        this.data = data;
      }
      this.head = 0;
      this.tail = live;
    }
    return this.tail;
  }
  commit(n: number) {
    this.tail += n;
  }
  take(n: number) {
    const out = this.data.slice(this.head, this.head + n);
    this.head += n;
    if (this.head === this.tail) this.head = this.tail = 0;
    return out;
  }
}

/** Sequential reads from one metadata block. */
class MetadataReader {
  pos = 0;
  constructor(
    private view: DataView,
    private bytes: Uint8Array,
    private little: boolean,
  ) {}
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u32() {
    const value = this.view.getUint32(this.pos, this.little);
    this.pos += 4;
    return value;
  }
  u64() {
    const value = uint64(this.view, this.pos, this.little);
    this.pos += 8;
    return value;
  }
  skip(n: number) {
    if (this.pos + n > this.bytes.length) throw damaged();
    this.pos += n;
  }
  text() {
    const length = this.u32();
    const start = this.pos;
    this.skip(length);
    return decodeText(this.bytes.subarray(start, start + length), 'utf-8');
  }
  value(type: number): Property | undefined {
    const { view, little } = this;
    const at = this.pos;
    if (type === STRING) return this.text();
    const size = SIZES.get(type);
    if (size === undefined)
      throw new Error(
        `The TDMS file has a property of an unknown type (0x${type.toString(16)}).`,
      );
    this.skip(size);
    switch (type) {
      case I8:
        return view.getInt8(at);
      case I16:
        return view.getInt16(at, little);
      case I32:
        return view.getInt32(at, little);
      case I64:
        return Number(view.getBigInt64(at, little));
      case U8:
        return view.getUint8(at);
      case U16:
        return view.getUint16(at, little);
      case U32:
        return view.getUint32(at, little);
      case U64:
        return Number(view.getBigUint64(at, little));
      case SGL:
      case SGL_UNIT:
        return view.getFloat32(at, little);
      case DBL:
      case DBL_UNIT:
        return view.getFloat64(at, little);
      case BOOLEAN:
        return view.getUint8(at) !== 0;
      case TIMESTAMP: {
        // Seconds since 1904 plus a 2^-64 fraction; fraction first when little.
        const seconds = view.getBigInt64(little ? at + 8 : at, little);
        const fraction = view.getBigUint64(little ? at : at + 8, little);
        return Number(seconds) + Number(fraction) / 2 ** 64;
      }
      default:
        return undefined;
    }
  }
}

/** Splits `/'Group'/'Channel'` (with `''` escapes) into names. */
function splitPath(path: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  if (path === '/') return parts;
  while (i < path.length) {
    if (path[i] !== '/' || path[i + 1] !== "'") return null;
    i += 2;
    let name = '';
    for (;;) {
      const quote = path.indexOf("'", i);
      if (quote < 0) return null;
      name += path.slice(i, quote);
      if (path[quote + 1] === "'") {
        name += "'";
        i = quote + 2;
      } else {
        i = quote + 1;
        break;
      }
    }
    parts.push(name);
  }
  return parts;
}

function readIndex(reader: MetadataReader, header: number): RawIndex {
  const digital = DAQMX_DIGITAL_SCALERS.has(header);
  if (header === DAQMX_FORMAT_SCALER || digital) {
    const type = reader.u32();
    const dimension = reader.u32();
    const count = reader.u64();
    if (dimension !== 1) throw damaged();
    const scalers: Scaler[] = [];
    for (let n = reader.u32(), i = 0; i < n; i++) {
      const code = reader.u32();
      const buffer = reader.u32();
      const offset = reader.u32();
      if (digital) reader.u8();
      else reader.u32();
      const id = reader.u32();
      const scalerType =
        code === 0xffffffff ? TIMESTAMP : (DAQMX_TYPES[code] ?? -1);
      if (scalerType < 0)
        throw new Error(
          `The TDMS file has a DAQmx scaler of an unknown type (${code}).`,
        );
      scalers.push(
        digital
          ? {
              type: scalerType,
              buffer,
              offset: offset >>> 3,
              bit: offset & 7,
              id,
            }
          : { type: scalerType, buffer, offset, bit: -1, id },
      );
    }
    const widths: number[] = [];
    for (let n = reader.u32(), i = 0; i < n; i++) widths.push(reader.u32());
    for (const scaler of scalers)
      if (
        scaler.buffer >= widths.length ||
        scaler.offset + SIZES.get(scaler.type)! > widths[scaler.buffer]
      )
        throw damaged();
    if (type !== DAQMX_RAW && scalers.length !== 1) throw damaged();
    return { type, count, bytes: 0, scalers, widths };
  }
  // The header states the index length, which some writers get wrong.
  const type = reader.u32();
  const dimension = reader.u32();
  const count = reader.u64();
  if (dimension !== 1) throw damaged();
  if (type === STRING) return { type, count, bytes: reader.u64() };
  const size = SIZES.get(type);
  if (size === undefined)
    throw new Error(
      `The TDMS file uses a data type Stratum cannot read (0x${type.toString(16)}).`,
    );
  if (size === 0 && count > 0) throw damaged();
  return { type, count, bytes: count * size };
}

function geometry(layout: Layout, rem: number, incomplete: boolean) {
  const { indexes } = layout;
  const zeros = () => indexes.map(() => 0);
  if (layout.mode === 'daqmx') {
    let left = rem;
    let done = false;
    const rows = layout.buffers.map((buffer) => {
      if (rem < 0) return buffer.rows;
      if (done) return 0;
      const take = Math.min(buffer.rows, Math.floor(left / buffer.width));
      left -= take * buffer.width;
      if (take < buffer.rows) done = true;
      return take;
    });
    const starts: number[] = [];
    let at = 0;
    layout.buffers.forEach((buffer, i) => {
      starts.push(at);
      at += rows[i] * buffer.width;
    });
    const counts = indexes.map((index) => rows[index.scalers![0].buffer] ?? 0);
    return { counts, offsets: zeros(), rows, starts };
  }
  if (layout.mode === 'interleaved') {
    const offsets: number[] = [];
    let at = 0;
    for (const index of indexes) {
      offsets.push(at);
      at += SIZES.get(index.type)!;
    }
    const counts = indexes.map((index) =>
      rem < 0 ? index.count : Math.floor(rem / layout.width),
    );
    return { counts, offsets, rows: [], starts: [] };
  }
  let counts: number[];
  if (rem < 0) counts = indexes.map((index) => index.count);
  else if (layout.unsized) counts = zeros();
  else if (!incomplete)
    // Like nptdms: a short final chunk holds proportionally fewer values.
    counts = indexes.map((index) =>
      Number((BigInt(index.count) * BigInt(rem)) / BigInt(layout.chunk)),
    );
  else {
    let left = rem;
    let done = false;
    counts = indexes.map((index) => {
      if (done) return 0;
      const size = SIZES.get(index.type)!;
      const take = Math.min(index.count, Math.floor(left / size));
      left -= take * size;
      if (take < index.count) done = true;
      return take;
    });
  }
  const offsets: number[] = [];
  let at = 0;
  indexes.forEach((index, i) => {
    offsets.push(at);
    at += rem < 0 ? index.bytes : counts[i] * SIZES.get(index.type)!;
  });
  return { counts, offsets, rows: [], starts: [] };
}

function makeLayout(
  entries: Entry[],
  rawIndexes: RawIndex[],
  interleaved: boolean,
  little: boolean,
): Layout {
  const objects: number[] = [];
  const indexes: RawIndex[] = [];
  const indexIds: number[] = [];
  for (const entry of entries) {
    if (!entry.data) continue;
    const index = rawIndexes[entry.index];
    if (!index.scalers && index.count === 0) continue;
    objects.push(entry.object);
    indexes.push(index);
    indexIds.push(entry.index);
  }
  const position = new Map(objects.map((object, i) => [object, i]));
  const daqmx = indexes.filter((index) => index.scalers).length;
  const layout: Layout = {
    objects,
    indexes,
    indexIds,
    position,
    mode: 'contiguous',
    little,
    chunk: 0,
    width: 0,
    buffers: [],
    unsized: indexes.some((index) => index.type === STRING),
    full: { counts: [], offsets: [], rows: [], starts: [] },
  };
  if (daqmx > 0 && daqmx < indexes.length)
    throw new Error(
      'The TDMS file mixes DAQmx and ordinary raw data in one segment.',
    );
  if (daqmx > 0) {
    const widths = indexes[0].widths!;
    const buffers = widths.map((width) => ({ rows: 0, width }));
    for (const index of indexes) {
      if (
        index.widths!.length !== widths.length ||
        index.widths!.some((width, i) => width !== widths[i])
      )
        throw new Error(
          'The DAQmx channels of one TDMS segment disagree on their data layout.',
        );
      for (const scaler of index.scalers!)
        buffers[scaler.buffer].rows = Math.max(
          buffers[scaler.buffer].rows,
          index.count,
        );
    }
    layout.mode = 'daqmx';
    layout.buffers = buffers;
    layout.chunk = buffers.reduce((sum, b) => sum + b.rows * b.width, 0);
  } else if (interleaved && !(indexes.length === 1 && layout.unsized)) {
    if (layout.unsized)
      throw new Error(
        'The TDMS file interleaves text with other channels, which cannot be read.',
      );
    if (indexes.some((index) => index.count !== indexes[0].count))
      throw new Error(
        'The TDMS file interleaves channels of different lengths, which cannot be read.',
      );
    layout.mode = 'interleaved';
    layout.width = indexes.reduce((sum, i) => sum + SIZES.get(i.type)!, 0);
    layout.chunk = layout.width * (indexes[0]?.count ?? 0);
  } else layout.chunk = indexes.reduce((sum, index) => sum + index.bytes, 0);
  layout.full = geometry(layout, -1, false);
  return layout;
}

/** Reads every segment's lead-in and metadata. */
async function scanFile(file: Blob) {
  const meta = new BlobBytes(file, 64 << 10);
  const objects: TdmsObject[] = [];
  const objectIds = new Map<string, number>();
  const rawIndexes: RawIndex[] = [];
  const rawIndexIds = new Map<string, number>();
  const layouts: Layout[] = [];
  const layoutIds = new Map<string, number>();
  const scan: Scan = {
    file,
    layouts,
    starts: [],
    sizes: [],
    ids: [],
    incomplete: -1,
  };
  const notes: string[] = [];
  let entries: Entry[] | null = null;
  let entryKey = '';
  let version = 0;
  let pos = 0;
  while (pos + LEAD_IN <= file.size) {
    const lead = await meta.view(pos, LEAD_IN);
    if (lead.getUint32(0, false) !== 0x5444536d)
      throw new Error(
        pos === 0
          ? 'The file does not start like a TDMS file.'
          : `The TDMS file is damaged: no segment starts at byte ${pos}.`,
      );
    const toc = lead.getUint32(4, true);
    const little = !(toc & TOC_BIG_ENDIAN);
    if (!version) version = lead.getUint32(8, little);
    const next = lead.getBigUint64(12, little);
    const metaSize = lead.getBigUint64(20, little);
    const metaStart = pos + LEAD_IN;
    const left = file.size - metaStart;
    const incomplete = next === NO_OFFSET || next > BigInt(left);
    if (metaSize > BigInt(left) || (!incomplete && metaSize > next)) {
      if (!incomplete) throw damaged();
      notes.push(
        'The file ends inside a segment’s metadata; that segment was ignored.',
      );
      break;
    }
    const dataStart = metaStart + Number(metaSize);
    const end = incomplete ? file.size : metaStart + Number(next);
    if (toc & TOC_METADATA) {
      const bytes = await meta.bytes(metaStart, Number(metaSize));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const reader = new MetadataReader(view, bytes, little);
      const previous: Entry[] | null = entries;
      const list: Entry[] =
        toc & TOC_NEW_OBJECT_LIST || !previous ? [] : previous.slice();
      const listed = new Map(list.map((entry, i) => [entry.object, i]));
      try {
        for (let n = reader.u32(), i = 0; i < n; i++) {
          const path = reader.text();
          const header = reader.u32();
          let id = objectIds.get(path);
          if (id === undefined) {
            id = objects.length;
            objectIds.set(path, id);
            objects.push({
              parts: splitPath(path),
              properties: new Map(),
              last: -1,
              length: 0,
              indexes: new Set(),
            });
          }
          const object = objects[id];
          let data = true;
          if (header === NO_RAW_DATA) data = false;
          else if (header === SAME_RAW_DATA) {
            if (object.last < 0) throw damaged();
          } else {
            const index = readIndex(reader, header);
            const key = index.scalers
              ? JSON.stringify(index)
              : `${index.type},${index.count},${index.bytes}`;
            let indexId = rawIndexIds.get(key);
            if (indexId === undefined) {
              indexId = rawIndexes.length;
              rawIndexIds.set(key, indexId);
              rawIndexes.push(index);
            }
            object.last = indexId;
          }
          const entry = { object: id, index: object.last, data };
          const at = listed.get(id);
          if (at === undefined) {
            listed.set(id, list.length);
            list.push(entry);
          } else list[at] = entry;
          for (let p = reader.u32(), j = 0; j < p; j++) {
            const name = reader.text();
            const value = reader.value(reader.u32());
            if (value !== undefined) object.properties.set(name, value);
          }
        }
      } catch (error) {
        throw error instanceof RangeError ? damaged() : error;
      }
      entries = list;
      entryKey = list
        .filter((entry) => entry.data)
        .map((entry) => `${entry.object}.${entry.index}`)
        .join(',');
    } else if (!entries) throw damaged();
    const key = `${toc & TOC_INTERLEAVED ? 'i' : 'c'}${little ? 'l' : 'b'}:${entryKey}`;
    let layoutId = layoutIds.get(key);
    if (layoutId === undefined) {
      const layout = makeLayout(
        entries,
        rawIndexes,
        !!(toc & TOC_INTERLEAVED),
        little,
      );
      layoutId = layouts.length;
      layoutIds.set(key, layoutId);
      layouts.push(layout);
      layout.objects.forEach((object, i) =>
        objects[object].indexes.add(layout.indexIds[i]),
      );
    }
    const layout = layouts[layoutId];
    const size = toc & TOC_RAW_DATA ? end - dataStart : 0;
    if (size > 0 && layout.chunk > 0) {
      const full = Math.floor(size / layout.chunk);
      const rem = size - full * layout.chunk;
      const last = rem > 0 ? geometry(layout, rem, incomplete) : null;
      layout.objects.forEach((object, i) => {
        objects[object].length +=
          full * layout.full.counts[i] + (last?.counts[i] ?? 0);
      });
      if (incomplete) scan.incomplete = scan.starts.length;
      scan.starts.push(dataStart);
      scan.sizes.push(size);
      scan.ids.push(layoutId);
    }
    if (incomplete) {
      if (toc & TOC_RAW_DATA && end > dataStart)
        notes.push(
          'The last segment of the file is incomplete, as when a recording is interrupted; its complete samples were imported.',
        );
      break;
    }
    pos = end;
  }
  return { scan, objects, rawIndexes, version, notes };
}

const isTimeName = (name: string) =>
  /^(time|t|zeit|timestamp|time ?stamp|zeitstempel|relative ?time|rel\.? ?time|elapsed ?time|time ?offset|relative ?zeit)$/.test(
    name
      .toLowerCase()
      .replace(/\s*[[(][^\])]*[\])]\s*$/, '')
      .replace(/[_-]+/g, ' ')
      .trim(),
  );
const TIME_FACTORS: Record<string, number> = {
  s: 1,
  sec: 1,
  ms: 1e-3,
  us: 1e-6,
  µs: 1e-6,
  μs: 1e-6,
  ns: 1e-9,
  min: 60,
  h: 3600,
};

function numberOf(properties: Map<string, Property>, name: string) {
  const value = properties.get(name);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

type Scaling = { scales: Scale[]; scaler: number } | { error: string };

/** Resolves an NI scale chain from one object's properties, like nptdms. */
function objectScaling(p: Map<string, Property>): Scaling | null {
  let count = numberOf(p, 'NI_Number_Of_Scales');
  if (count === undefined) {
    count = 0;
    for (const name of p.keys()) {
      const match = name.match(/^NI_Scale\[(\d+)\]_Scale_Type$/);
      if (match) count = Math.max(count, Number(match[1]) + 1);
    }
  }
  if (!count || p.get('NI_Scaling_Status') === 'scaled') return null;
  const scales: Scale[] = [];
  const source = (index: number, kind: string) => {
    const value = numberOf(p, `NI_Scale[${index}]_${kind}_Input_Source`);
    return value === undefined ? RAW_SOURCE : value >>> 0;
  };
  let index = count - 1;
  for (let step = 0; step <= count; step++) {
    if (index === RAW_SOURCE) return { scales: scales.reverse(), scaler: -1 };
    if (index >= count) break;
    const type = p.get(`NI_Scale[${index}]_Scale_Type`);
    // Scales without a type are read directly from DAQmx scalers.
    if (type === undefined) return { scales: scales.reverse(), scaler: index };
    if (type === 'Linear') {
      const slope = numberOf(p, `NI_Scale[${index}]_Linear_Slope`);
      const intercept = numberOf(p, `NI_Scale[${index}]_Linear_Y_Intercept`);
      if (slope === undefined || intercept === undefined)
        return { error: 'incomplete linear scale' };
      scales.push({ slope, intercept });
      index = source(index, 'Linear');
    } else if (type === 'Polynomial') {
      const size =
        numberOf(p, `NI_Scale[${index}]_Polynomial_Coefficients_Size`) ?? 4;
      const coefficients: number[] = [];
      for (let i = 0; i < size; i++) {
        const c = numberOf(
          p,
          `NI_Scale[${index}]_Polynomial_Coefficients[${i}]`,
        );
        if (c === undefined) return { error: 'incomplete polynomial scale' };
        coefficients.push(c);
      }
      scales.push({ coefficients });
      index = source(index, 'Polynomial');
    } else if (type === 'AdvancedAPI') index = source(index, 'AdvancedAPI');
    else return { error: `${String(type)} scale` };
  }
  return { error: 'circular scale chain' };
}

const rateLabel = (increment: number) => {
  const rate = 1 / increment;
  const [value, unit] =
    rate >= 1e6
      ? [rate / 1e6, 'MHz']
      : rate >= 1e3
        ? [rate / 1e3, 'kHz']
        : [rate, 'Hz'];
  return `${Number(value.toPrecision(4))} ${unit}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const listNames = (names: string[]) =>
  names.length > NAME_LIMIT
    ? `${names.slice(0, NAME_LIMIT).join(', ')} and ${names.length - NAME_LIMIT} more`
    : names.join(', ');

/** Groups numeric channels into tables and records skipped ones. */
/** The first timestamp of a channel, read from its first segment. */
async function firstStamp(scan: Scan, object: number) {
  const probe: Target = {
    object,
    queue: new Queue(),
    scaler: -1,
    scales: [],
    factor: 1,
  };
  const targets = new Map([[object, probe]]);
  for (let s = 0; s < scan.starts.length; s++) {
    const layout = scan.layouts[scan.ids[s]];
    if (!layout.position.has(object)) continue;
    const full = Math.floor(scan.sizes[s] / layout.chunk);
    const rem = scan.sizes[s] - full * layout.chunk;
    const geom = full
      ? layout.full
      : geometry(layout, rem, s === scan.incomplete);
    const [column] = columns(layout, geom, targets);
    if (!column) continue;
    const at = scan.starts[s] + column.offset;
    const bytes = await scan.file.slice(at, at + 16).arrayBuffer();
    return stampParts(new DataView(bytes), 0, layout.little);
  }
  return [0, 0] as [number, number];
}

const isoTime = ([seconds, fraction]: [number, number]) => {
  const date = new Date((seconds - EPOCH_1904 + fraction) * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

async function buildTables(
  scan: Scan,
  objects: TdmsObject[],
  rawIndexes: RawIndex[],
  notes: string[],
) {
  const root = objects.find((o) => o.parts?.length === 0)?.properties;
  const groupProps = new Map<string, Map<string, Property>>();
  for (const o of objects)
    if (o.parts?.length === 1) groupProps.set(o.parts[0], o.properties);
  const groups = new Map<string, ChannelInfo[]>();
  const skipped = { text: [] as number[], complex: [] as string[] };
  /** Timestamp channels per group, which may become a time axis. */
  const stamps = new Map<string, number[]>();
  const unscaled: string[] = [];
  let startTimes = false;
  const channelGroups = new Set(
    objects.flatMap((o) => (o.parts?.length === 2 ? [o.parts[0]] : [])),
  );
  const label = (group: string, name: string) =>
    channelGroups.size > 1 ? `${group}/${name}` : name;
  objects.forEach((object, id) => {
    const parts = object.parts;
    if (parts?.length !== 2 || object.length === 0) return;
    const [group, name] = parts;
    const indexes = [...object.indexes].map((i) => rawIndexes[i]);
    const plain = indexes.find((index) => !index.scalers);
    const daqmx = indexes.filter((index) => index.scalers);
    const odd = indexes.find(
      (index) => !index.scalers && !NUMERIC.has(index.type) && index.type !== 0,
    );
    if (odd) {
      if (indexes.every((index) => index.type === TIMESTAMP))
        stamps.set(group, [...(stamps.get(group) ?? []), id]);
      else if (odd.type === STRING || odd.type === TIMESTAMP)
        skipped.text.push(id);
      else skipped.complex.push(label(group, name));
      return;
    }
    const resolved =
      [object.properties, groupProps.get(group), root]
        .map((p) => (p ? objectScaling(p) : null))
        .find((s) => s !== null) ?? null;
    let problem = '';
    if (resolved && 'error' in resolved) problem = resolved.error;
    else if (daqmx.some((index) => index.type === DAQMX_RAW)) {
      if (!resolved) problem = 'no scale information';
      else if (resolved.scaler < 0) problem = 'no DAQmx scaler input';
      else if (
        daqmx.some(
          (index) =>
            !index.scalers!.some(
              (s) => s.id === resolved.scaler && NUMERIC.has(s.type),
            ),
        )
      )
        problem = 'missing DAQmx scaler';
      if (plain && !problem) problem = 'mixed DAQmx and ordinary data';
    } else if (resolved && resolved.scaler >= 0)
      problem = 'DAQmx scale on ordinary data';
    else if (daqmx.some((index) => !NUMERIC.has(index.scalers![0].type)))
      problem = 'timestamp scaler';
    if (problem) {
      unscaled.push(`${label(group, name)} (${problem})`);
      return;
    }
    const unit = ['unit_string', 'NI_UnitDescription']
      .map((key) => object.properties.get(key))
      .find((value) => typeof value === 'string' && value.trim());
    if (object.properties.has('wf_start_time')) startTimes = true;
    const list = groups.get(group) ?? [];
    groups.set(group, list);
    list.push({
      object: id,
      group,
      name,
      unit: typeof unit === 'string' ? unit : '',
      scales: resolved && !('error' in resolved) ? resolved.scales : [],
      scaler:
        resolved && !('error' in resolved) && daqmx.length
          ? resolved.scaler
          : -1,
    });
  });
  const tables: { info: RecordingTable; table: TableInfo }[] = [];
  const used = new Set<string>();
  for (const [group, channels] of groups) {
    const classes = new Map<
      string,
      { channels: ChannelInfo[]; time: TimeAxis; rows: number }
    >();
    for (const channel of channels) {
      const p = objects[channel.object].properties;
      const rows = objects[channel.object].length;
      const increment = numberOf(p, 'wf_increment');
      const offset = numberOf(p, 'wf_start_offset') ?? 0;
      const wave = increment !== undefined && increment > 0;
      const key = wave ? `${rows}|${increment}|${offset}` : `${rows}|`;
      let entry = classes.get(key);
      if (!entry) {
        entry = {
          channels: [],
          rows,
          time: wave ? { kind: 'wave', offset, increment } : { kind: 'index' },
        };
        classes.set(key, entry);
      }
      entry.channels.push(channel);
    }
    const parts = [...classes.values()];
    for (const part of parts) {
      if (part.time.kind !== 'index' || part.channels.length < 2) continue;
      const at = part.channels.findIndex((c) => isTimeName(c.name));
      if (at < 0) continue;
      const [channel] = part.channels.splice(at, 1);
      const unit =
        channel.unit ||
        (channel.name.match(/[[(]([^\])]+)[\])]\s*$/)?.[1] ?? '');
      part.time = {
        kind: 'channel',
        channel,
        factor: TIME_FACTORS[unit.trim()] ?? 1,
      };
    }
    // Otherwise a timestamp channel of the same length: one named like time,
    // or the group's only timestamp channel.
    const groupStamps = stamps.get(group) ?? [];
    for (const part of parts) {
      if (part.time.kind !== 'index') continue;
      const fits = groupStamps.filter((id) => objects[id].length === part.rows);
      const stamp =
        fits.find((id) => isTimeName(objects[id].parts![1])) ??
        (groupStamps.length === 1 ? fits[0] : undefined);
      if (stamp === undefined) continue;
      groupStamps.splice(groupStamps.indexOf(stamp), 1);
      part.time = {
        kind: 'stamp',
        object: stamp,
        origin: await firstStamp(scan, stamp),
      };
    }
    const base = group || 'Unnamed group';
    const labels = parts.map((part) =>
      part.time.kind === 'wave'
        ? rateLabel(part.time.increment)
        : plural(part.rows, 'sample'),
    );
    const distinct = new Set(labels).size === labels.length;
    for (const [i, part] of parts.entries()) {
      if (part.channels.length > MAX_RECORDING_CHANNELS)
        throw new Error(
          `The TDMS group “${base}” has ${part.channels.length} channels with the same timing; Stratum imports at most ${MAX_RECORDING_CHANNELS} channels per recording.`,
        );
      let name =
        parts.length === 1
          ? base
          : distinct
            ? `${base} · ${labels[i]}`
            : i
              ? `${base} (${i + 1})`
              : base;
      for (let n = 2; used.has(name.toLowerCase()); n++)
        name = `${base} (${n})`;
      used.add(name.toLowerCase());
      const tableNotes: string[] = [];
      const info: RecordingTable = {
        name,
        channels: uniqueChannels(
          part.channels.map((c) => namedChannel(c.name, c.unit)),
        ),
        rows: part.rows,
        notes: tableNotes,
      };
      const time = part.time;
      if (time.kind === 'wave') {
        info.start = time.offset;
        info.end = time.offset + (part.rows - 1) * time.increment;
      } else if (time.kind === 'index') {
        info.start = 0;
        info.end = part.rows - 1;
        tableNotes.push(
          'No time channel or waveform timing: time is the sample number.',
        );
      } else if (time.kind === 'stamp') {
        const iso = isoTime(time.origin);
        info.start = 0;
        tableNotes.push(
          `Time is “${objects[time.object].parts![1]}” in seconds since its first sample${iso ? `, ${iso}` : ''}.`,
        );
      } else
        tableNotes.push(
          `Time comes from the “${time.channel.name}” channel${time.factor === 1 ? '' : ', converted to seconds'}.`,
        );
      tables.push({ info, table: part });
    }
  }
  for (const unused of stamps.values()) skipped.text.push(...unused);
  skipped.text.sort((a, b) => a - b);
  if (skipped.text.length)
    notes.push(
      `Skipped ${plural(skipped.text.length, 'text or timestamp channel')}: ${listNames(
        skipped.text.map((id) =>
          label(...(objects[id].parts as [string, string])),
        ),
      )}.`,
    );
  if (skipped.complex.length)
    notes.push(
      `Skipped ${plural(skipped.complex.length, 'complex or extended-precision channel')}: ${listNames(skipped.complex)}.`,
    );
  if (unscaled.length)
    notes.push(
      `Skipped ${plural(unscaled.length, 'channel')} whose NI scaling cannot be applied: ${listNames(unscaled)}.`,
    );
  if (startTimes)
    notes.push(
      'Absolute start times (wf_start_time) are not applied; time runs from each waveform’s start offset.',
    );

  return tables;
}

function columns(
  layout: Layout,
  geom: Geometry,
  targets: Map<number, Target>,
): Column[] {
  const out: Column[] = [];
  layout.objects.forEach((object, e) => {
    const target = targets.get(object);
    if (!target) return;
    const index = layout.indexes[e];
    if (index.scalers) {
      const scaler =
        target.scaler < 0
          ? index.scalers[0]
          : index.scalers.find((s) => s.id === target.scaler);
      if (!scaler || !NUMERIC.has(scaler.type))
        throw new Error(
          'A DAQmx channel changes its scalers between segments.',
        );
      out.push({
        target,
        type: scaler.type,
        size: SIZES.get(scaler.type)!,
        bit: scaler.bit,
        offset: geom.starts[scaler.buffer] + scaler.offset,
        stride: layout.buffers[scaler.buffer].width,
        count: geom.rows[scaler.buffer],
      });
      return;
    }
    if (!NUMERIC.has(index.type) && index.type !== TIMESTAMP) return;
    const size = SIZES.get(index.type)!;
    out.push({
      target,
      type: index.type,
      size,
      bit: -1,
      offset: geom.offsets[e],
      stride: layout.mode === 'interleaved' ? layout.width : size,
      count: geom.counts[e],
    });
  });
  return out.filter((column) => column.count > 0);
}

function makePlan(layout: Layout, targets: Map<number, Target>): Plan | null {
  const cols = columns(layout, layout.full, targets);
  if (!cols.length) return null;
  const first = cols[0];
  const rows = cols.every(
    (c) =>
      c.stride === first.stride &&
      c.count === first.count &&
      c.stride * c.count === layout.chunk,
  );
  let spanStart = Infinity;
  let spanEnd = 0;
  let used = 0;
  let maxCount = 1;
  for (const c of cols) {
    spanStart = Math.min(spanStart, c.offset);
    spanEnd = Math.max(spanEnd, c.offset + (c.count - 1) * c.stride + c.size);
    used += c.count * c.size;
    maxCount = Math.max(maxCount, c.count);
  }
  const dense =
    layout.chunk <= SLICE_BYTES &&
    (layout.chunk <= 256 << 10 || used * 4 >= layout.chunk);
  return { columns: cols, rows, dense, spanStart, spanEnd, maxCount };
}

/** Decodes `n` values `stride` bytes apart into a target's queue. */
function decode(
  bytes: Uint8Array,
  at: number,
  column: Column,
  n: number,
  little: boolean,
) {
  const { target, type, size, stride, bit } = column;
  const queue = target.queue;
  const w = queue.reserve(n);
  const out = queue.data;
  if (
    stride === size &&
    (little === HOST_LITTLE || size === 1) &&
    type !== I64 &&
    type !== U64 &&
    type !== BOOLEAN &&
    type !== TIMESTAMP
  ) {
    const buffer = bytes.slice(at, at + n * size).buffer;
    out.set(
      type === I8
        ? new Int8Array(buffer)
        : type === U8
          ? new Uint8Array(buffer)
          : type === I16
            ? new Int16Array(buffer)
            : type === U16
              ? new Uint16Array(buffer)
              : type === I32
                ? new Int32Array(buffer)
                : type === U32
                  ? new Uint32Array(buffer)
                  : type === SGL || type === SGL_UNIT
                    ? new Float32Array(buffer)
                    : new Float64Array(buffer),
      w,
    );
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const end = w + n;
    let p = at;
    switch (type) {
      case I8:
        for (let i = w; i < end; i++, p += stride) out[i] = view.getInt8(p);
        break;
      case U8:
        for (let i = w; i < end; i++, p += stride) out[i] = view.getUint8(p);
        break;
      case BOOLEAN:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getUint8(p) ? 1 : 0;
        break;
      case I16:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getInt16(p, little);
        break;
      case U16:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getUint16(p, little);
        break;
      case I32:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getInt32(p, little);
        break;
      case U32:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getUint32(p, little);
        break;
      case I64:
        for (let i = w; i < end; i++, p += stride)
          out[i] = Number(view.getBigInt64(p, little));
        break;
      case U64:
        for (let i = w; i < end; i++, p += stride)
          out[i] = Number(view.getBigUint64(p, little));
        break;
      case SGL:
      case SGL_UNIT:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getFloat32(p, little);
        break;
      case TIMESTAMP: {
        // Seconds since the first sample: whole seconds and fractions apart.
        const [s0, f0] = target.origin ?? [0, 0];
        for (let i = w; i < end; i++, p += stride) {
          const [seconds, fraction] = stampParts(view, p, little);
          out[i] = seconds - s0 + (fraction - f0);
        }
        break;
      }
      default:
        for (let i = w; i < end; i++, p += stride)
          out[i] = view.getFloat64(p, little);
    }
  }
  const end = w + n;
  if (bit >= 0) for (let i = w; i < end; i++) out[i] = (out[i] >>> bit) & 1;
  for (const scale of target.scales)
    if ('slope' in scale) {
      const { slope, intercept } = scale;
      for (let i = w; i < end; i++) out[i] = out[i] * slope + intercept;
    } else {
      const c = scale.coefficients;
      for (let i = w; i < end; i++) {
        const x = out[i];
        let y = 0;
        for (let k = c.length - 1; k >= 0; k--) y = y * x + c[k];
        out[i] = y;
      }
    }
  if (target.factor !== 1)
    for (let i = w; i < end; i++) out[i] *= target.factor;
  queue.commit(n);
}

/**
 * Raw-data reads. Small reads that follow each other closely share one
 * read-ahead window, so files of many tiny segments cost few slices; distant
 * reads fetch exactly what they need.
 */
class DataReader {
  private start = 0;
  private window = new Uint8Array(0);
  private last = -Infinity;
  constructor(
    private file: Blob,
    private readAhead: number,
  ) {}
  async bytes(offset: number, length: number) {
    const from = offset - this.start;
    if (from >= 0 && from + length <= this.window.length)
      return this.window.subarray(from, from + length);
    const near = offset >= this.last && offset - this.last <= 64 << 10;
    const size =
      near && length < this.readAhead
        ? Math.min(this.readAhead, this.file.size - offset)
        : length;
    const bytes = new Uint8Array(
      await this.file.slice(offset, offset + size).arrayBuffer(),
    );
    this.last = offset + length;
    if (size === length) return bytes;
    this.start = offset;
    this.window = bytes;
    return bytes.subarray(0, length);
  }
}

/** Reads `rows` rows `stride` bytes apart, in bounded windows. */
async function* readRows(
  reader: DataReader,
  start: number,
  stride: number,
  rows: number,
  cols: Column[],
  little: boolean,
): AsyncGenerator<void> {
  let width = 0;
  for (const c of cols) width = Math.max(width, c.offset + c.size);
  const step = Math.max(
    1,
    Math.min(SLICE_ROWS, Math.floor(SLICE_BYTES / stride)),
  );
  for (let r = 0; r < rows; r += step) {
    const n = Math.min(step, rows - r);
    const bytes = await reader.bytes(
      start + r * stride,
      (n - 1) * stride + width,
    );
    for (const c of cols) decode(bytes, c.offset, c, n, little);
    yield;
  }
}

/**
 * Reads separately placed columns of one chunk in lockstep, a bounded run of
 * each in turn, so a huge chunk never buffers one whole channel at once.
 */
async function* readColumns(
  reader: DataReader,
  base: number,
  cols: Column[],
  little: boolean,
): AsyncGenerator<void> {
  const steps = cols.map((c) =>
    Math.max(
      1,
      Math.min(SLICE_ROWS, Math.floor(SLICE_BYTES / cols.length / c.stride)),
    ),
  );
  let more = true;
  for (let round = 0; more; round++) {
    more = false;
    for (const [i, c] of cols.entries()) {
      const r = round * steps[i];
      if (r >= c.count) continue;
      const n = Math.min(steps[i], c.count - r);
      const bytes = await reader.bytes(
        base + c.offset + r * c.stride,
        (n - 1) * c.stride + c.size,
      );
      decode(bytes, 0, c, n, little);
      more ||= r + n < c.count;
    }
    yield;
  }
}

/** Decodes one set of targets from every segment, one slice per step. */
async function* walk(
  scan: Scan,
  targets: Target[],
  readAhead: number,
): AsyncGenerator<void> {
  const byObject = new Map(targets.map((t) => [t.object, t]));
  const plans = new Map<number, Plan | null>();
  const reader = new DataReader(scan.file, readAhead);
  for (let s = 0; s < scan.starts.length; s++) {
    const id = scan.ids[s];
    const layout = scan.layouts[id];
    let plan = plans.get(id);
    if (plan === undefined) {
      plan = makePlan(layout, byObject);
      plans.set(id, plan);
    }
    if (!plan) continue;
    const start = scan.starts[s];
    const size = scan.sizes[s];
    const { little, chunk } = layout;
    if (plan.rows) {
      const stride = plan.columns[0].stride;
      yield* readRows(
        reader,
        start,
        stride,
        Math.floor(size / stride),
        plan.columns,
        little,
      );
      continue;
    }
    const full = Math.floor(size / chunk);
    const rem = size - full * chunk;
    if (plan.dense) {
      const per = Math.max(
        1,
        Math.min(
          Math.floor(SLICE_BYTES / chunk),
          Math.floor(SLICE_ROWS / plan.maxCount),
        ),
      );
      for (let k = 0; k < full; k += per) {
        const m = Math.min(per, full - k);
        const bytes = await reader.bytes(
          start + k * chunk + plan.spanStart,
          (m - 1) * chunk + plan.spanEnd - plan.spanStart,
        );
        for (let j = 0; j < m; j++)
          for (const c of plan.columns)
            decode(
              bytes,
              j * chunk + c.offset - plan.spanStart,
              c,
              c.count,
              little,
            );
        yield;
      }
    } else
      for (let k = 0; k < full; k++)
        yield* readColumns(reader, start + k * chunk, plan.columns, little);
    if (rem > 0) {
      const last = geometry(layout, rem, s === scan.incomplete);
      const cols = columns(layout, last, byObject);
      if (cols.length)
        yield* readColumns(reader, start + full * chunk, cols, little);
    }
  }
}

/** Largest gap between the most and least advanced channel, in samples. */
function imbalance(scan: Scan, targets: Target[]) {
  const totals = targets.map(() => 0);
  let worst = 0;
  for (let s = 0; s < scan.starts.length; s++) {
    const layout = scan.layouts[scan.ids[s]];
    const full = Math.floor(scan.sizes[s] / layout.chunk);
    const rem = scan.sizes[s] - full * layout.chunk;
    const last = rem > 0 ? geometry(layout, rem, s === scan.incomplete) : null;
    let low = Infinity;
    let high = 0;
    for (let k = 0; k < targets.length; k++) {
      const e = layout.position.get(targets[k].object);
      if (e !== undefined)
        totals[k] += full * layout.full.counts[e] + (last?.counts[e] ?? 0);
      low = Math.min(low, totals[k]);
      high = Math.max(high, totals[k]);
    }
    worst = Math.max(worst, high - low);
  }
  return worst;
}

async function* readTable(
  scan: Scan,
  table: TableInfo,
  maxPending: number,
): AsyncGenerator<RecordingBlock> {
  const target = (channel: ChannelInfo, factor = 1): Target => ({
    object: channel.object,
    queue: new Queue(),
    scaler: channel.scaler,
    scales: channel.scales,
    factor,
  });
  const values = table.channels.map((c) => target(c));
  const { time, rows } = table;
  const clock: Target | null =
    time.kind === 'channel'
      ? target(time.channel, time.factor)
      : time.kind === 'stamp'
        ? {
            object: time.object,
            queue: new Queue(),
            scaler: -1,
            scales: [],
            factor: 1,
            origin: time.origin,
          }
        : null;
  const all = clock ? [...values, clock] : values;
  const shared = imbalance(scan, all) * all.length <= maxPending;
  // Separate cursors share the read-ahead budget.
  const readAhead = shared
    ? 4 << 20
    : Math.max(64 << 10, (16 << 20) / all.length);
  const cursors = (shared ? [all] : all.map((t) => [t])).map((group) => ({
    group,
    steps: walk(scan, group, readAhead),
  }));
  let done = 0;
  while (done < rows) {
    const n = Math.min(BLOCK_ROWS, rows - done);
    for (const { group, steps } of cursors)
      while (group.some((t) => t.queue.length < n))
        if ((await steps.next()).done) break;
    const got = Math.min(n, ...all.map((t) => t.queue.length));
    if (!got)
      throw new Error(
        'The TDMS file ended before all of its samples were read.',
      );
    let times: Float64Array;
    if (clock) times = clock.queue.take(got);
    else {
      times = new Float64Array(got);
      const [offset, increment] =
        time.kind === 'wave' ? [time.offset, time.increment] : [0, 1];
      for (let i = 0; i < got; i++) times[i] = offset + (done + i) * increment;
    }
    const block = values.map((t) => t.queue.take(got));
    done += got;
    yield { time: times, values: block, progress: done / rows };
  }
}

export type TdmsOptions = {
  /** Values buffered across unevenly spread channels before reading each separately. */
  maxPending?: number;
};

export async function openTdms(
  file: Blob,
  options: TdmsOptions = {},
): Promise<RecordingFile> {
  const { scan, objects, rawIndexes, version, notes } = await scanFile(file);
  const tables = await buildTables(scan, objects, rawIndexes, notes);
  if (!tables.length) throw new Error('The TDMS file has no numeric channels.');
  const maxPending = options.maxPending ?? MAX_PENDING_VALUES;
  return {
    format:
      version === 4712
        ? 'NI TDMS 1.0'
        : version === 4713
          ? 'NI TDMS 2.0'
          : 'NI TDMS',
    tables: tables.map((t) => t.info),
    notes,
    read: (index: number) => {
      const table = tables[index];
      if (!table) throw new Error(`The TDMS file has no table ${index + 1}.`);
      return readTable(scan, table.table, maxPending);
    },
  };
}
