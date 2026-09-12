import type { Point, SeriesChunk } from './signal-types';

// Rebuildable display data. Never use these summaries as measurement samples.
export const PLOT_INDEX_VERSION = 1;
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
export type PlotIndex = {
  version: typeof PLOT_INDEX_VERSION;
  rows: number;
  // Level zero represents groups of 4,096 samples. Each higher level groups 16.
  levels: PlotBlock[][];
};

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

export function mergeBlocks(blocks: PlotBlock[]): PlotBlock {
  const result = { ...blocks[0] };
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (Number.isFinite(result.last[1]) && Number.isFinite(block.first[1]))
      result.integral +=
        ((result.last[1] + block.first[1]) / 2) *
        (block.first[0] - result.last[0]);
    result.integral += block.integral;
    result.last = block.last;
    result.count += block.count;
    result.total += block.total;
    if (block.gap) result.gap = block.gap;
    if (
      Number.isFinite(block.min[1]) &&
      (!Number.isFinite(result.min[1]) || block.min[1] < result.min[1])
    )
      result.min = block.min;
    if (
      Number.isFinite(block.max[1]) &&
      (!Number.isFinite(result.max[1]) || block.max[1] > result.max[1])
    )
      result.max = block.max;
  }
  return result;
}

export function groupBlocks(blocks: PlotBlock[]): PlotBlock[] {
  const groups: PlotBlock[] = [];
  for (let i = 0; i < blocks.length; i += PLOT_FANOUT)
    groups.push(mergeBlocks(blocks.slice(i, i + PLOT_FANOUT)));
  return groups;
}

export function indexLeaves(chunk: SeriesChunk): PlotBlock[] {
  const blocks: PlotBlock[] = [];
  for (let offset = 0; offset < chunk.time.length; offset += PLOT_LEAF_SIZE) {
    const first: Point = [chunk.time[offset], chunk.values[offset]];
    const block: PlotBlock = {
      first,
      last: first,
      min: first,
      max: first,
      count: 0,
      total: 0,
      integral: 0,
    };
    for (
      let i = offset;
      i < Math.min(offset + PLOT_LEAF_SIZE, chunk.time.length);
      i++
    ) {
      const point: Point = [chunk.time[i], chunk.values[i]];
      if (Number.isFinite(point[1])) {
        block.count++;
        block.total += point[1];
        if (!Number.isFinite(block.min[1]) || point[1] < block.min[1])
          block.min = point;
        if (!Number.isFinite(block.max[1]) || point[1] > block.max[1])
          block.max = point;
        if (i > offset && Number.isFinite(block.last[1]))
          block.integral +=
            ((block.last[1] + point[1]) / 2) * (point[0] - block.last[0]);
      } else block.gap = point;
      block.last = point;
    }
    blocks.push(block);
  }
  return blocks;
}

export function finishIndex(base: PlotBlock[], rows: number): PlotIndex {
  const levels = [base];
  while (levels.at(-1)!.length > 1) levels.push(groupBlocks(levels.at(-1)!));
  return { version: PLOT_INDEX_VERSION, rows, levels };
}

export function usableIndex(
  index: PlotIndex | undefined,
  rows: number,
): index is PlotIndex {
  return (
    index?.version === PLOT_INDEX_VERSION &&
    index.rows === rows &&
    Array.isArray(index.levels) &&
    index.levels[0]?.length === Math.ceil(rows / PLOT_BLOCK_SIZE) &&
    index.levels.at(-1)?.length === 1
  );
}

/** Cache accounting deliberately overestimates object/point storage. */
export function indexBytes(value: PlotIndex | PlotBlock[]): number {
  return (
    (Array.isArray(value)
      ? value.length
      : value.levels.reduce((sum, level) => sum + level.length, 0)) * 320
  );
}

export type PlotSlice =
  | { block: PlotBlock }
  | { chunk: number; start: number; end: number };

/** Descend only overlapping branches; partial leaf blocks always read exact data. */
export async function* indexSlices(
  index: PlotIndex,
  range: [number, number],
  leaves: (chunk: number) => Promise<PlotBlock[]>,
  check: () => void,
): AsyncGenerator<PlotSlice> {
  const span = (range[1] - range[0]) / 700;
  const stack = [{ level: index.levels.length - 1, offset: 0 }];
  while (stack.length) {
    check();
    const { level, offset } = stack.pop()!;
    const block = index.levels[level][offset];
    if (block.last[0] < range[0] || block.first[0] > range[1]) continue;
    if (
      block.first[0] >= range[0] &&
      block.last[0] <= range[1] &&
      block.last[0] - block.first[0] <= span
    ) {
      yield { block };
    } else if (level) {
      const end = Math.min(
        (offset + 1) * PLOT_FANOUT,
        index.levels[level - 1].length,
      );
      for (let i = end - 1; i >= offset * PLOT_FANOUT; i--)
        stack.push({ level: level - 1, offset: i });
    } else {
      const sample = offset * PLOT_BLOCK_SIZE;
      const chunk = Math.floor(sample / STORAGE_CHUNK_SIZE);
      const firstLeaf = (sample % STORAGE_CHUNK_SIZE) / PLOT_LEAF_SIZE;
      // Small windows bypass the leaf-index read and go straight to raw samples.
      if (span * 700 < block.last[0] - block.first[0]) {
        yield {
          chunk,
          start: firstLeaf * PLOT_LEAF_SIZE,
          end: Math.min(
            firstLeaf * PLOT_LEAF_SIZE + PLOT_BLOCK_SIZE,
            index.rows - chunk * STORAGE_CHUNK_SIZE,
          ),
        };
        continue;
      }
      const children = await leaves(chunk);
      for (
        let i = firstLeaf;
        i < Math.min(firstLeaf + PLOT_FANOUT, children.length);
        i++
      ) {
        const child = children[i];
        if (child.last[0] < range[0] || child.first[0] > range[1]) continue;
        if (
          child.first[0] >= range[0] &&
          child.last[0] <= range[1] &&
          child.last[0] - child.first[0] <= span
        )
          yield { block: child };
        else
          yield {
            chunk,
            start: i * PLOT_LEAF_SIZE,
            end: Math.min(
              (i + 1) * PLOT_LEAF_SIZE,
              index.rows - chunk * STORAGE_CHUNK_SIZE,
            ),
          };
      }
    }
  }
}
