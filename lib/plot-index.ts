import type { Point, SeriesChunk } from './signal-types';

// Rebuildable display data. Never use these summaries as measurement samples.
export const PLOT_INDEX_VERSION = 2;
export const PLOT_LEAF_SIZE = 256;
export const PLOT_FANOUT = 16;
export const PLOT_BLOCK_SIZE = PLOT_LEAF_SIZE * PLOT_FANOUT;
export const STORAGE_CHUNK_SIZE = 16384;

export type PlotBlock = {
  first: Point;
  last: Point;
  min: Point;
  max: Point;
  gap?: Point;
  count: number;
  total: number;
  integral: number;
};
/**
 * Packed blocks: 13 doubles each, so long recordings fit a compact budget and
 * load from storage without one object per block. A block's fields are
 * first, last, min, max and gap (time, value), then count, total, integral.
 * A block without a missing sample has a NaN gap time.
 */
export type PlotBlocks = Float64Array<ArrayBuffer>;
export const BLOCK_FIELDS = 13;
const FIRST = 0,
  LAST = 2,
  MIN = 4,
  MAX = 6,
  GAP = 8,
  COUNT = 10,
  TOTAL = 11,
  INTEGRAL = 12;
export type PlotIndex = {
  version: typeof PLOT_INDEX_VERSION;
  rows: number;
  // Level zero represents groups of 4,096 samples. Each higher level groups 16.
  levels: PlotBlocks[];
};

export const blockCount = (blocks: PlotBlocks) => blocks.length / BLOCK_FIELDS;
export const blockStart = (blocks: PlotBlocks, i: number) =>
  blocks[i * BLOCK_FIELDS + FIRST];
export const blockEnd = (blocks: PlotBlocks, i: number) =>
  blocks[i * BLOCK_FIELDS + LAST];

export function readBlock(blocks: PlotBlocks, i: number): PlotBlock {
  const o = i * BLOCK_FIELDS;
  const point = (field: number): Point => [
    blocks[o + field],
    blocks[o + field + 1],
  ];
  return {
    first: point(FIRST),
    last: point(LAST),
    min: point(MIN),
    max: point(MAX),
    ...(Number.isNaN(blocks[o + GAP]) ? {} : { gap: point(GAP) }),
    count: blocks[o + COUNT],
    total: blocks[o + TOTAL],
    integral: blocks[o + INTEGRAL],
  };
}

export function blockPoints(block: PlotBlock): Point[] {
  return [
    ...new Map(
      [
        block.first,
        block.min,
        block.max,
        ...(block.gap ? [block.gap] : []),
        block.last,
      ].map((point) => [point[0], point]),
    ).values(),
  ].sort((a, b) => a[0] - b[0]);
}

/** Merge source blocks [from, to) into the target block slot. */
function mergeBlocks(
  source: PlotBlocks,
  from: number,
  to: number,
  target: PlotBlocks,
  slot: number,
) {
  const o = slot * BLOCK_FIELDS;
  target.set(
    source.subarray(from * BLOCK_FIELDS, (from + 1) * BLOCK_FIELDS),
    o,
  );
  for (let i = from + 1; i < to; i++) {
    const b = i * BLOCK_FIELDS;
    const lastValue = target[o + LAST + 1],
      firstValue = source[b + FIRST + 1];
    if (Number.isFinite(lastValue) && Number.isFinite(firstValue))
      target[o + INTEGRAL] +=
        ((lastValue + firstValue) / 2) * (source[b + FIRST] - target[o + LAST]);
    target[o + INTEGRAL] += source[b + INTEGRAL];
    target[o + LAST] = source[b + LAST];
    target[o + LAST + 1] = source[b + LAST + 1];
    target[o + COUNT] += source[b + COUNT];
    target[o + TOTAL] += source[b + TOTAL];
    if (!Number.isNaN(source[b + GAP])) {
      target[o + GAP] = source[b + GAP];
      target[o + GAP + 1] = source[b + GAP + 1];
    }
    const min = source[b + MIN + 1],
      max = source[b + MAX + 1];
    if (
      Number.isFinite(min) &&
      (!Number.isFinite(target[o + MIN + 1]) || min < target[o + MIN + 1])
    ) {
      target[o + MIN] = source[b + MIN];
      target[o + MIN + 1] = min;
    }
    if (
      Number.isFinite(max) &&
      (!Number.isFinite(target[o + MAX + 1]) || max > target[o + MAX + 1])
    ) {
      target[o + MAX] = source[b + MAX];
      target[o + MAX + 1] = max;
    }
  }
}

export function groupBlocks(blocks: PlotBlocks): PlotBlocks {
  const count = blockCount(blocks);
  const groups = new Float64Array(
    Math.ceil(count / PLOT_FANOUT) * BLOCK_FIELDS,
  );
  for (let i = 0; i < count; i += PLOT_FANOUT)
    mergeBlocks(
      blocks,
      i,
      Math.min(count, i + PLOT_FANOUT),
      groups,
      i / PLOT_FANOUT,
    );
  return groups;
}

export function indexLeaves(chunk: SeriesChunk): PlotBlocks {
  const { time, values } = chunk;
  const leaves = new Float64Array(
    Math.ceil(time.length / PLOT_LEAF_SIZE) * BLOCK_FIELDS,
  );
  for (let offset = 0; offset < time.length; offset += PLOT_LEAF_SIZE) {
    const o = (offset / PLOT_LEAF_SIZE) * BLOCK_FIELDS;
    const firstTime = time[offset],
      firstValue = values[offset];
    let lastTime = firstTime,
      lastValue = firstValue,
      minTime = firstTime,
      minValue = firstValue,
      maxTime = firstTime,
      maxValue = firstValue,
      gapTime = NaN,
      gapValue = NaN,
      count = 0,
      total = 0,
      integral = 0;
    const end = Math.min(offset + PLOT_LEAF_SIZE, time.length);
    for (let i = offset; i < end; i++) {
      const t = time[i],
        value = values[i];
      if (Number.isFinite(value)) {
        count++;
        total += value;
        if (!Number.isFinite(minValue) || value < minValue) {
          minTime = t;
          minValue = value;
        }
        if (!Number.isFinite(maxValue) || value > maxValue) {
          maxTime = t;
          maxValue = value;
        }
        if (i > offset && Number.isFinite(lastValue))
          integral += ((lastValue + value) / 2) * (t - lastTime);
      } else {
        gapTime = t;
        gapValue = value;
      }
      lastTime = t;
      lastValue = value;
    }
    leaves.set(
      [
        firstTime,
        firstValue,
        lastTime,
        lastValue,
        minTime,
        minValue,
        maxTime,
        maxValue,
        gapTime,
        gapValue,
        count,
        total,
        integral,
      ],
      o,
    );
  }
  return leaves;
}

/** Accumulates base blocks chunk by chunk without one object per block. */
export class IndexBuilder {
  private blocks = new Float64Array(64 * BLOCK_FIELDS);
  private length = 0;
  get bytes() {
    return this.length * 8;
  }
  push(blocks: PlotBlocks) {
    if (this.length + blocks.length > this.blocks.length) {
      const grown = new Float64Array(
        Math.max(this.blocks.length * 2, this.length + blocks.length),
      );
      grown.set(this.blocks.subarray(0, this.length));
      this.blocks = grown;
    }
    this.blocks.set(blocks, this.length);
    this.length += blocks.length;
  }
  finish(rows: number): PlotIndex {
    const levels = [this.blocks.slice(0, this.length)];
    while (blockCount(levels.at(-1)!) > 1)
      levels.push(groupBlocks(levels.at(-1)!));
    return { version: PLOT_INDEX_VERSION, rows, levels };
  }
}

export function usableIndex(
  index: PlotIndex | undefined,
  rows: number,
): index is PlotIndex {
  return (
    index?.version === PLOT_INDEX_VERSION &&
    index.rows === rows &&
    Array.isArray(index.levels) &&
    index.levels.every((level) => level instanceof Float64Array) &&
    index.levels[0]?.length ===
      Math.ceil(rows / PLOT_BLOCK_SIZE) * BLOCK_FIELDS &&
    index.levels.at(-1)?.length === BLOCK_FIELDS
  );
}

export function indexBytes(value: PlotIndex | PlotBlocks): number {
  return value instanceof Float64Array
    ? value.byteLength
    : value.levels.reduce((sum, level) => sum + level.byteLength, 0);
}

/** Summary blocks, or exact samples by storage position and time span. */
export type PlotSlice =
  | { block: PlotBlock }
  | { chunk: number; start: number; end: number; from: number; to: number };

/** Descend only overlapping branches; partial leaf blocks always read exact data. */
export async function* indexSlices(
  index: PlotIndex,
  range: [number, number],
  leaves: (chunk: number) => Promise<PlotBlocks>,
  check: () => void,
): AsyncGenerator<PlotSlice> {
  const span = (range[1] - range[0]) / 700;
  const stack = [{ level: index.levels.length - 1, offset: 0 }];
  while (stack.length) {
    check();
    const { level, offset } = stack.pop()!;
    const blocks = index.levels[level];
    const first = blockStart(blocks, offset),
      last = blockEnd(blocks, offset);
    if (last < range[0] || first > range[1]) continue;
    if (first >= range[0] && last <= range[1] && last - first <= span) {
      yield { block: readBlock(blocks, offset) };
    } else if (level) {
      const end = Math.min(
        (offset + 1) * PLOT_FANOUT,
        blockCount(index.levels[level - 1]),
      );
      for (let i = end - 1; i >= offset * PLOT_FANOUT; i--)
        stack.push({ level: level - 1, offset: i });
    } else {
      const sample = offset * PLOT_BLOCK_SIZE;
      const chunk = Math.floor(sample / STORAGE_CHUNK_SIZE);
      const firstLeaf = (sample % STORAGE_CHUNK_SIZE) / PLOT_LEAF_SIZE;
      // Small windows bypass the leaf-index read and go straight to raw samples.
      if (span * 700 < last - first) {
        yield {
          chunk,
          start: firstLeaf * PLOT_LEAF_SIZE,
          end: Math.min(
            firstLeaf * PLOT_LEAF_SIZE + PLOT_BLOCK_SIZE,
            index.rows - chunk * STORAGE_CHUNK_SIZE,
          ),
          from: first,
          to: last,
        };
        continue;
      }
      const children = await leaves(chunk);
      for (
        let i = firstLeaf;
        i < Math.min(firstLeaf + PLOT_FANOUT, blockCount(children));
        i++
      ) {
        const childFirst = blockStart(children, i),
          childLast = blockEnd(children, i);
        if (childLast < range[0] || childFirst > range[1]) continue;
        if (
          childFirst >= range[0] &&
          childLast <= range[1] &&
          childLast - childFirst <= span
        )
          yield { block: readBlock(children, i) };
        else
          yield {
            chunk,
            start: i * PLOT_LEAF_SIZE,
            end: Math.min(
              (i + 1) * PLOT_LEAF_SIZE,
              index.rows - chunk * STORAGE_CHUNK_SIZE,
            ),
            from: childFirst,
            to: childLast,
          };
      }
    }
  }
}

/**
 * Regroups a derived signal's output, which arrives in arbitrary pieces, into
 * storage-sized index leaves. Leaves are held until the signal is long enough
 * to index, so short outputs never write anything.
 */
export class LeafWriter {
  private time = new Float64Array(STORAGE_CHUNK_SIZE);
  private values = new Float64Array(STORAGE_CHUNK_SIZE);
  private length = 0;
  private pending: PlotBlocks[] = [];
  private written = 0;
  readonly builder = new IndexBuilder();
  rows = 0;
  constructor(
    private minimumRows: number,
    /** Store leaves for consecutive chunks starting at `first`, in one write. */
    private write: (first: number, leaves: PlotBlocks[]) => Promise<void>,
  ) {}
  // Leaf writes are batched and not awaited one by one; finish() awaits them
  // all, so a root is only published after every leaf it describes.
  private writes: Promise<void>[] = [];
  async add(chunk: SeriesChunk) {
    for (let offset = 0; offset < chunk.time.length;) {
      const count = Math.min(
        STORAGE_CHUNK_SIZE - this.length,
        chunk.time.length - offset,
      );
      this.time.set(chunk.time.subarray(offset, offset + count), this.length);
      this.values.set(
        chunk.values.subarray(offset, offset + count),
        this.length,
      );
      this.length += count;
      offset += count;
      if (this.length === STORAGE_CHUNK_SIZE) await this.flush();
    }
  }
  private async flush() {
    if (!this.length) return;
    const leaves = indexLeaves({
      time: this.time.subarray(0, this.length),
      values: this.values.subarray(0, this.length),
    });
    this.builder.push(groupBlocks(leaves));
    this.rows += this.length;
    this.length = 0;
    this.pending.push(leaves);
    if (this.rows >= this.minimumRows && this.pending.length >= 64)
      this.store();
  }
  private store() {
    if (!this.pending.length) return;
    const write = this.write(this.written, this.pending);
    // Surface a failure from finish(), not as an unhandled rejection.
    write.catch(() => {});
    this.writes.push(write);
    this.written += this.pending.length;
    this.pending = [];
  }
  /** The finished index, or undefined when the output is too short to need one. */
  async finish(): Promise<PlotIndex | undefined> {
    await this.flush();
    if (this.rows < this.minimumRows) return undefined;
    this.store();
    await Promise.all(this.writes);
    return this.builder.finish(this.rows);
  }
}
