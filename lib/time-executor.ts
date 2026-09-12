import type { Point, SeriesChunk, SignalNode } from './signal-types';
import type { SignalGraph } from './signal-graph';
import { arithmeticValue } from './signal-arithmetic';
import { COMPARISON_MATH } from './time-types';
import { yieldEngine } from './engine-yield';

export type SignalInstruction =
  | { kind: 'input'; index: number }
  | { kind: 'output'; chunk: SeriesChunk };
export type SignalProcess = AsyncGenerator<
  SignalInstruction,
  void,
  SeriesChunk | undefined
>;
type Reader = AsyncGenerator<
  SignalInstruction,
  Point | undefined,
  SeriesChunk | undefined
>;

/** Runs inside the existing iterative evaluator; no recursive graph evaluation. */
export async function* executeTime(
  node: SignalNode,
  graph: SignalGraph,
  check: () => void,
): SignalProcess {
  const recipe = node.timeRecipe!;
  const cursors = new Map<number, { chunk?: SeriesChunk; index: number }>();
  async function* point(input: number): Reader {
    check();
    let cursor = cursors.get(input);
    if (!cursor) {
      cursor = { index: 0 };
      cursors.set(input, cursor);
    }
    while (!cursor.chunk || cursor.index === cursor.chunk.time.length) {
      cursor.chunk = yield { kind: 'input', index: input };
      cursor.index = 0;
      if (!cursor.chunk) return;
    }
    const i = cursor.index++;
    return [cursor.chunk.time[i], cursor.chunk.values[i]];
  }
  const arrays = (points: Point[]): SeriesChunk => ({
    time: Float64Array.from(points.map((p) => p[0])),
    values: Float64Array.from(points.map((p) => p[1])),
  });
  let output: Point[] = [];
  if (recipe.kind === 'align' || recipe.kind === 'crop') {
    let previous = -Infinity;
    while (true) {
      const p = yield* point(0);
      if (!p) break;
      if (recipe.kind === 'align') {
        p[0] = (p[0] - recipe.anchor) * recipe.scale + recipe.target;
        if (!Number.isFinite(p[0]) || p[0] <= previous)
          throw new Error(
            'Alignment cannot represent distinct timestamps. Choose a smaller time origin.',
          );
        previous = p[0];
      } else if (p[0] < recipe.start || p[0] > recipe.end) continue;
      output.push(p);
      if (output.length === 16384) {
        yield { kind: 'output', chunk: arrays(output) };
        output = [];
      }
    }
  } else if (recipe.kind === 'combine') {
    while (true) {
      const a = yield* point(0),
        b = yield* point(1);
      if (!a && !b) break;
      if (!a || !b || a[0] !== b[0])
        throw new Error(
          'Inputs need identical timestamps and lengths. Resample both to one shared grid first.',
        );
      const value = arithmeticValue(
        COMPARISON_MATH[recipe.operator],
        a[1],
        b[1],
      );
      output.push([a[0], Number.isFinite(value) ? value : NaN]);
      if (output.length === 16384) {
        yield { kind: 'output', chunk: arrays(output) };
        output = [];
      }
    }
  } else {
    // FIR lookahead and interpolation retain at most one chunk plus 513 points.
    const filter = recipe.filter;
    const window: Point[] = [];
    let center = 0,
      base = 0,
      readCount = 0;
    let ended = false,
      spacing = 0,
      previousTime: number | undefined;
    let weights: number[] | undefined;
    async function* filtered(): Reader {
      if (!filter) return yield* point(0);
      while (!ended && readCount <= center + filter.halfWidth) {
        const p = yield* point(0);
        if (!p) {
          ended = true;
          break;
        }
        if (previousTime !== undefined) {
          const dt = p[0] - previousTime;
          if (!spacing) {
            spacing = dt;
            if (filter.cutoff >= 0.5 / dt)
              throw new Error(
                'The filter cutoff must be below half the input sample rate.',
              );
            weights = Array.from(
              { length: filter.halfWidth * 2 + 1 },
              (_, i) => {
                const k = i - filter.halfWidth;
                const f = filter.cutoff * dt;
                const sinc =
                  k === 0
                    ? 2 * f
                    : Math.sin(2 * Math.PI * f * k) / (Math.PI * k);
                return (
                  sinc *
                  (0.42 +
                    0.5 * Math.cos((Math.PI * k) / filter.halfWidth) +
                    0.08 * Math.cos((2 * Math.PI * k) / filter.halfWidth))
                );
              },
            );
            const total = weights.reduce((a, b) => a + b, 0);
            weights = weights.map((w) => w / total);
          } else if (
            Math.abs(dt - spacing) >
            Math.max(spacing * 1e-5, Number.EPSILON * Math.abs(p[0]) * 4)
          )
            throw new Error(
              'Anti-alias filtering requires regularly spaced input samples. Regularize irregular data first, or disable this filter explicitly.',
            );
        }
        previousTime = p[0];
        window.push(p);
        readCount++;
      }
      if (center >= readCount) return;
      const p = window[center - base];
      let value = NaN;
      if (
        weights &&
        center >= filter.halfWidth &&
        center + filter.halfWidth < readCount
      ) {
        value = 0;
        for (let k = 0; k < weights.length; k++)
          value += weights[k] * window[center - filter.halfWidth + k - base][1];
      }
      center++;
      if (center - filter.halfWidth > base) {
        window.shift();
        base++;
      }
      return [p[0], value];
    }
    let previous: Point | undefined;
    let next = yield* filtered();
    let gridIndex = 0,
      priorGrid = -Infinity;
    const grid = recipe.grid;
    const inputBounds = graph.ranges.get(node.parents[0])!;
    while (true) {
      check();
      let time: number;
      if (grid.kind === 'uniform') {
        time = grid.start + gridIndex++ / grid.rate;
        if (time > grid.end) break;
      } else {
        const p = yield* point(1);
        if (!p) break;
        time = p[0];
        if (time < grid.start) continue;
        if (time > grid.end) break;
      }
      if (time <= priorGrid || !Number.isFinite(time))
        throw new Error(
          'The output grid cannot represent distinct timestamps. Align to a smaller origin first.',
        );
      priorGrid = time;
      while (next && next[0] < time) {
        previous = next;
        next = yield* filtered();
      }
      let value = NaN;
      if (time >= inputBounds[0] && time <= inputBounds[1]) {
        if (next && next[0] === time) value = next[1];
        else if (previous && next && next[0] - previous[0] <= recipe.maxGap) {
          if (recipe.interpolation === 'previous') value = previous[1];
          else if (recipe.interpolation === 'nearest')
            value =
              time - previous[0] <= next[0] - time ? previous[1] : next[1];
          else
            value =
              previous[1] +
              ((next[1] - previous[1]) * (time - previous[0])) /
                (next[0] - previous[0]);
        }
      }
      output.push([time, value]);
      if (output.length === 16384) {
        yield { kind: 'output', chunk: arrays(output) };
        output = [];
        await yieldEngine();
      }
    }
  }
  if (output.length) yield { kind: 'output', chunk: arrays(output) };
}
