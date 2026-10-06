import type { Point, SeriesChunk, SignalNode } from './signal-types';
import type { SignalGraph } from './signal-graph';
import { arithmeticValue } from './signal-arithmetic';
import { COMPARISON_MATH } from './time-types';
import { yieldEngine } from './engine-yield';

export type SignalInstruction =
  | { kind: 'input'; index: number }
  | { kind: 'open'; index: number; range?: [number, number] }
  | { kind: 'output'; chunk: SeriesChunk };
export type SignalProcess = AsyncGenerator<
  SignalInstruction,
  void,
  SeriesChunk | undefined
>;
type Refill = AsyncGenerator<SignalInstruction, void, SeriesChunk | undefined>;
type Cursor = { chunk?: SeriesChunk; index: number; done: boolean };

/** Runs inside the existing iterative evaluator; no recursive graph evaluation. */
export async function* executeTime(
  node: SignalNode,
  graph: SignalGraph,
  check: () => void,
  range?: [number, number],
): SignalProcess {
  const recipe = node.timeRecipe!;
  // Inputs are read a chunk at a time; samples are taken synchronously.
  const cursors: Cursor[] = [
    { index: 0, done: false },
    { index: 0, done: false },
  ];
  const ready = (input: number) => {
    const cursor = cursors[input];
    return !!cursor.chunk && cursor.index < cursor.chunk.time.length;
  };
  async function* refill(input: number): Refill {
    const cursor = cursors[input];
    while (!cursor.done && !ready(input)) {
      check();
      cursor.chunk = yield { kind: 'input', index: input };
      cursor.index = 0;
      if (!cursor.chunk) cursor.done = true;
    }
  }
  const take = (input: number): Point => {
    const cursor = cursors[input];
    const i = cursor.index++;
    return [cursor.chunk!.time[i], cursor.chunk!.values[i]];
  };
  let outTime = new Float64Array(16384),
    outValues = new Float64Array(16384),
    count = 0;
  const emit = (time: number, value: number) => {
    outTime[count] = time;
    outValues[count++] = value;
  };
  const flush = (): SignalInstruction => {
    const chunk = {
      time: outTime.subarray(0, count),
      values: outValues.subarray(0, count),
    };
    outTime = new Float64Array(16384);
    outValues = new Float64Array(16384);
    count = 0;
    return { kind: 'output', chunk };
  };
  if (recipe.kind === 'align' || recipe.kind === 'crop') {
    let previous = -Infinity;
    while (true) {
      if (!ready(0)) yield* refill(0);
      if (!ready(0)) break;
      const cursor = cursors[0],
        { time, values } = cursor.chunk!;
      for (; cursor.index < time.length; cursor.index++) {
        let t = time[cursor.index];
        if (recipe.kind === 'align') {
          t = (t - recipe.anchor) * recipe.scale + recipe.target;
          if (!Number.isFinite(t) || t <= previous)
            throw new Error(
              'Alignment cannot represent distinct timestamps. Choose a smaller time origin.',
            );
          previous = t;
        } else if (t < recipe.start || t > recipe.end) continue;
        emit(t, values[cursor.index]);
        if (count === 16384) yield flush();
      }
    }
  } else if (recipe.kind === 'combine') {
    const operation = COMPARISON_MATH[recipe.operator];
    let started = false;
    while (true) {
      if (!ready(0)) yield* refill(0);
      if (!ready(1)) yield* refill(1);
      const hasA = ready(0),
        hasB = ready(1);
      if (!hasA && !hasB) break;
      if (range && (!hasA || !hasB)) break;
      if (!hasA || !hasB)
        throw new Error(
          'Inputs need identical timestamps and lengths. Resample both to one shared grid first.',
        );
      const a = cursors[0],
        b = cursors[1];
      const at = a.chunk!.time,
        av = a.chunk!.values,
        bt = b.chunk!.time,
        bv = b.chunk!.values;
      while (a.index < at.length && b.index < bt.length) {
        if (at[a.index] !== bt[b.index]) {
          // Windowed inputs cover the window but may begin at different
          // samples; past the first shared timestamp a mismatch is an error.
          if (range && !started) {
            if (at[a.index] < bt[b.index]) a.index++;
            else b.index++;
            continue;
          }
          throw new Error(
            'Inputs need identical timestamps and lengths. Resample both to one shared grid first.',
          );
        }
        started = true;
        const value = arithmeticValue(operation, av[a.index], bv[b.index]);
        emit(at[a.index], Number.isFinite(value) ? value : NaN);
        a.index++;
        b.index++;
        if (count === 16384) yield flush();
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
    /** One input sample into the FIR window, validating regular spacing. */
    const accept = (p: Point) => {
      if (!filter) return;
      if (previousTime !== undefined) {
        const dt = p[0] - previousTime;
        if (!spacing) {
          spacing = dt;
          if (filter.cutoff >= 0.5 / dt)
            throw new Error(
              'The filter cutoff must be below half the input sample rate.',
            );
          weights = Array.from({ length: filter.halfWidth * 2 + 1 }, (_, i) => {
            const k = i - filter.halfWidth;
            const f = filter.cutoff * dt;
            const sinc =
              k === 0 ? 2 * f : Math.sin(2 * Math.PI * f * k) / (Math.PI * k);
            return (
              sinc *
              (0.42 +
                0.5 * Math.cos((Math.PI * k) / filter.halfWidth) +
                0.08 * Math.cos((2 * Math.PI * k) / filter.halfWidth))
            );
          });
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
    };
    /** The next filtered sample once enough lookahead has been accepted. */
    const filtered = (): Point | undefined => {
      if (!filter) return undefined;
      if (center >= readCount) return undefined;
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
    };
    let previous: Point | undefined;
    let gridIndex = 0,
      priorGrid = -Infinity,
      lastIndex = Infinity;
    const grid = recipe.grid;
    if (range && grid.kind === 'uniform' && !filter) {
      // Exact uniform grid points from one before the window to one after it,
      // interpolated from the input samples around them.
      const at = (index: number) => grid.start + index / grid.rate;
      gridIndex = Math.max(0, Math.floor((range[0] - grid.start) * grid.rate));
      while (gridIndex > 0 && at(gridIndex) >= range[0]) gridIndex--;
      lastIndex = Math.max(
        gridIndex,
        Math.ceil((range[1] - grid.start) * grid.rate),
      );
      while (at(lastIndex) <= range[1]) lastIndex++;
      yield {
        kind: 'open',
        index: 0,
        range: [at(gridIndex), at(lastIndex)],
      };
    }
    let next: Point | undefined;
    let primed = false;
    const inputBounds = graph.ranges.get(node.parents[0])!;
    while (true) {
      check();
      let time: number;
      if (grid.kind === 'uniform') {
        if (gridIndex > lastIndex) break;
        time = grid.start + gridIndex++ / grid.rate;
        if (time > grid.end) break;
      } else {
        if (!ready(1)) yield* refill(1);
        if (!ready(1)) break;
        time = take(1)[0];
        if (time < grid.start) continue;
        if (time > grid.end) break;
      }
      if (time <= priorGrid || !Number.isFinite(time))
        throw new Error(
          'The output grid cannot represent distinct timestamps. Align to a smaller origin first.',
        );
      priorGrid = time;
      while (!primed || (next && next[0] < time)) {
        if (primed) previous = next;
        primed = true;
        if (filter) {
          while (!ended && readCount <= center + filter.halfWidth) {
            if (!ready(0)) yield* refill(0);
            if (!ready(0)) {
              ended = true;
              break;
            }
            accept(take(0));
          }
          next = filtered();
        } else {
          if (!ready(0)) yield* refill(0);
          next = ready(0) ? take(0) : undefined;
        }
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
      emit(time, value);
      if (count === 16384) {
        yield flush();
        await yieldEngine();
      }
    }
  }
  if (count) yield flush();
}
