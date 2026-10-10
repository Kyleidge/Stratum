/**
 * Shared shapes for recording-file readers. A reader turns one file into one
 * or more tables; each table has a single, strictly increasing time axis in
 * seconds and becomes one recording (Source) in the workspace. Readers only
 * describe and stream samples: the engine validates times, chunks columns and
 * publishes everything atomically.
 */

import type { DelimitedLayout, DelimitedPreview } from './delimited-layout';

export type RecordingChannel = {
  name: string;
  /** Engineering unit; '—' when the file names none. */
  unit: string;
};

/** A bounded run of consecutive samples of one table. */
export type RecordingBlock = {
  /** Time in seconds, increasing across blocks. */
  time: Float64Array;
  /** One array per channel, as long as `time`; NaN marks a missing sample. */
  values: Float64Array[];
  /** Fraction of the table read so far, 0–1, for progress messages. */
  progress?: number;
};

export type RecordingTable = {
  /** Group name in the file; '' for a file that holds a single table. */
  name: string;
  channels: RecordingChannel[];
  /** Sample count when the metadata states it. */
  rows?: number;
  /** Time span in seconds when the metadata states it without a data scan. */
  start?: number;
  end?: number;
  /** Plain-language caveats, such as a missing time channel. */
  notes?: string[];
};

export type RecordingFile = {
  /** Format label shown to the user, such as “ASAM MDF 4.10”. */
  format: string;
  tables: RecordingTable[];
  /** File-level caveats, such as skipped channels. */
  notes?: string[];
  /** Delimited text: its columns, for the import dialog. */
  columns?: DelimitedPreview;
  /** Delimited text: the column layout these tables come from. */
  layout?: DelimitedLayout;
  /**
   * Streams one table's samples in time order. Blocks should stay bounded
   * (about 64 K rows or a few MiB) so cancellation and memory stay responsive.
   */
  read(table: number): AsyncGenerator<RecordingBlock>;
};

export type RecordingReader = {
  id: string;
  /** Short name shown in menus and messages, such as “MDF 4”. */
  label: string;
  /** Lower-case extensions including the dot. */
  extensions: readonly string[];
  /**
   * True when the first bytes (up to 4 KiB) identify this format. Readers that
   * cannot be recognised from content (delimited text) return false and are
   * chosen by extension.
   */
  sniff(head: Uint8Array): boolean;
  open(file: Blob): Promise<RecordingFile>;
};

/** Channels in one recording; larger groups are rejected with a clear message. */
export const MAX_RECORDING_CHANNELS = 1024;
/** Rows per streamed block that readers aim for. */
export const BLOCK_ROWS = 65536;

/** Splits “Torque [Nm]” into name and unit, as CSV headers do. */
export function headerChannel(header: string): RecordingChannel {
  const match = header.match(/^(.*?)\s*\[([^\]]+)\]$/);
  return {
    name: match?.[1].trim() || header.trim(),
    unit: match?.[2].trim() || '—',
  };
}

/** Builds a channel from separate name and unit fields of a binary format. */
export function namedChannel(name: string, unit?: string): RecordingChannel {
  const clean = (text: string) =>
    // Control characters never belong in labels.
    // oxlint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const label = clean(name).slice(0, 255) || 'Unnamed';
  const symbol = clean(unit ?? '').slice(0, 40);
  return { name: label, unit: symbol || '—' };
}

/** Appends “ (2)”, “ (3)” … to repeated channel names within a table. */
export function uniqueChannels(
  channels: RecordingChannel[],
): RecordingChannel[] {
  const seen = new Map<string, number>();
  return channels.map((channel) => {
    const key = channel.name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1
      ? channel
      : { ...channel, name: `${channel.name} (${count})` };
  });
}

/**
 * Random-access reads from a Blob with a read-ahead window, so many small
 * metadata reads cost one slice each. Offsets beyond the file throw a
 * plain-language error instead of returning short data.
 */
export class BlobBytes {
  readonly size: number;
  private windowStart = 0;
  private window = new Uint8Array(0);
  constructor(
    private blob: Blob,
    private readAhead = 1 << 20,
  ) {
    this.size = blob.size;
  }
  /** Exactly `length` bytes at `offset`. The result may share a buffer. */
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    )
      throw new Error(
        'The file is shorter than its own metadata says. It may be truncated or damaged.',
      );
    if (
      offset >= this.windowStart &&
      offset + length <= this.windowStart + this.window.length
    )
      return this.window.subarray(
        offset - this.windowStart,
        offset - this.windowStart + length,
      );
    if (length > this.readAhead)
      return new Uint8Array(
        await this.blob.slice(offset, offset + length).arrayBuffer(),
      );
    const end = Math.min(this.size, offset + Math.max(length, this.readAhead));
    this.window = new Uint8Array(
      await this.blob.slice(offset, end).arrayBuffer(),
    );
    this.windowStart = offset;
    return this.window.subarray(0, length);
  }
  async view(offset: number, length: number): Promise<DataView> {
    const bytes = await this.bytes(offset, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

/** Reads a little- or big-endian unsigned 64-bit integer as a safe number. */
export function uint64(view: DataView, offset: number, little = true) {
  const value = view.getBigUint64(offset, little);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('The file contains an offset or count that is too large.');
  return Number(value);
}

/** Inflates zlib (`deflate`) or raw deflate data with the platform decoder. */
export async function inflate(
  data: Uint8Array,
  format: 'deflate' | 'deflate-raw',
): Promise<Uint8Array> {
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('A compressed data block is damaged and cannot be read.');
  }
}

const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');

/** Decodes text up to the first NUL; invalid UTF-8 falls back to Latin-1. */
export function decodeText(bytes: Uint8Array, encoding: 'utf-8' | 'latin1') {
  const end = bytes.indexOf(0);
  const slice = end < 0 ? bytes : bytes.subarray(0, end);
  if (encoding === 'latin1') return latin1Decoder.decode(slice);
  const text = utf8Decoder.decode(slice);
  return text.includes('\uFFFD') ? latin1Decoder.decode(slice) : text;
}
