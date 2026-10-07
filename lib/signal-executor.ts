import { RollingMean, bsfc, power } from './signal-math';
import {
  arithmeticValue,
  isArithmetic,
  isBinaryOperation,
} from './signal-arithmetic';
import { executeTime } from './time-executor';
import { compileFormula } from './formula';
import { yieldEngine } from './engine-yield';
import { parentWindow } from './signal-range';
import { ExponentialSmoother, RcFilter, RollingMedian } from './signal-filters';
import type { SignalGraph } from './signal-graph';
import type { Point, SeriesChunk, SignalNode } from './signal-types';

type Instruction =
  | { kind: 'input'; index: number }
  /** Read this input over a new window, replacing any earlier reader. */
  | { kind: 'open'; index: number; range?: [number, number] }
  | { kind: 'output'; chunk: SeriesChunk };
type Process = AsyncGenerator<Instruction, void, SeriesChunk | undefined>;
const SIZE = 16384;

/**
 * Exact filter state, recorded every 16,384 inputs during a complete pass:
 * the next input's time, inputs consumed before it, and up to three values.
 */
export const CHECKPOINT_INTERVAL = 16384;
export const CHECKPOINT_FIELDS = 5;
/** Running state that a window can only resume from a recorded checkpoint. */
export const CHECKPOINTED = new Set([
  'smooth',
  'exponential',
  'low-pass',
  'high-pass',
  'integral',
  'resample',
]);
/** Stateful operations that evaluate a window from look-back alone. */
const LOOKBACK = new Set(['median', 'derivative']);
/** Inputs immediately before a resumed sample that the state depends on. */
function historySize(node: SignalNode): number {
  if (node.operation === 'smooth' || node.operation === 'median')
    return node.parameters.value;
  return ['derivative', 'integral', 'resample'].includes(node.operation)
    ? 1
    : 0;
}

export type ExecutionOptions = {
  /** Checkpoints saved by an earlier complete pass of this exact recipe. */
  checkpoints?: (node: SignalNode) => Float64Array | undefined;
  /** Receives every checkpoint of a complete pass when its input ends. */
  record?: (node: SignalNode, checkpoints: Float64Array) => void;
  /** Typical sample spacing of a recorded channel, to size look-back reads. */
  spacing?: (node: SignalNode) => number | undefined;
};

/** First index whose time is not before `time`. */
function lowerBound(times: Float64Array, time: number): number {
  let low = 0,
    high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}
const pause = yieldEngine;
const arrays = (points: Point[]): SeriesChunk => ({
  time: Float64Array.from(points.map((point) => point[0])),
  values: Float64Array.from(points.map((point) => point[1])),
});

export async function* executeSignal(
  id: string,
  graph: SignalGraph,
  raw: (id: string, range?: [number, number]) => AsyncGenerator<SeriesChunk>,
  check: () => void,
  range?: [number, number],
  options: ExecutionOptions = {},
): AsyncGenerator<SeriesChunk> {
  /** Estimated input spacing, from checkpoints or the nearest known rate. */
  function inputSpacing(node: SignalNode, checkpoints?: Float64Array) {
    const F = CHECKPOINT_FIELDS;
    if (checkpoints && checkpoints.length >= 2 * F) {
      const n = checkpoints.length - F;
      const spacing =
        (checkpoints[n] - checkpoints[n - F]) /
        (checkpoints[n + 1] - checkpoints[n + 1 - F]);
      if (spacing > 0) return spacing;
    }
    let current = graph.find(node.parents[0]);
    for (let depth = 0; depth < 100000; depth++) {
      if (current.operation === 'resample') return 1 / current.parameters.value;
      if (
        current.timeRecipe?.kind === 'resample' &&
        current.timeRecipe.grid.kind === 'uniform'
      )
        return 1 / current.timeRecipe.grid.rate;
      if (!current.parents.length) return options.spacing?.(current);
      current = graph.find(current.parents[0]);
    }
    return undefined;
  }
  async function* process(
    node: SignalNode,
    inputRange?: [number, number],
  ): Process {
    if (node.timeRecipe) {
      yield* executeTime(node, graph, check, inputRange);
      return;
    }
    if (node.operation === 'raw') {
      for await (const chunk of raw(node.id, inputRange))
        yield { kind: 'output', chunk };
      return;
    }
    if (isBinaryOperation(node.operation)) {
      let a = yield { kind: 'input', index: 0 };
      let b = yield { kind: 'input', index: 1 };
      let ai = 0;
      let bi = 0;
      // Windowed inputs cover the window but may begin at different samples.
      while (inputRange && a && b && a.time[ai] !== b.time[bi])
        if (a.time[ai] < b.time[bi]) {
          if (++ai === a.time.length) {
            a = yield { kind: 'input', index: 0 };
            ai = 0;
          }
        } else if (++bi === b.time.length) {
          b = yield { kind: 'input', index: 1 };
          bi = 0;
        }
      let output: Point[] = [];
      while (a && b) {
        check();
        if (a.time[ai] !== b.time[bi])
          throw new Error('Inputs must share timestamps.');
        output.push([
          a.time[ai],
          isArithmetic(node.operation)
            ? arithmeticValue(node.operation, a.values[ai], b.values[bi])
            : node.operation === 'power'
              ? power(a.values[ai], b.values[bi])
              : bsfc(a.values[ai], b.values[bi]),
        ]);
        if (++ai === a.time.length) {
          a = yield { kind: 'input', index: 0 };
          ai = 0;
        }
        if (++bi === b.time.length) {
          b = yield { kind: 'input', index: 1 };
          bi = 0;
        }
        if (output.length === SIZE) {
          yield { kind: 'output', chunk: arrays(output) };
          output = [];
        }
      }
      if ((a || b) && !inputRange) throw new Error('Input lengths differ.');
      if (output.length) yield { kind: 'output', chunk: arrays(output) };
      return;
    }
    if (node.operation === 'formula') {
      // Shared-timestamp math over every signal variable, in lockstep.
      const formula = compileFormula(node.expression ?? '');
      const count = node.parents.length;
      const constants = formula.values.map((name) => node.parameters[name]);
      const chunks: (SeriesChunk | undefined)[] = [];
      const at: number[] = Array.from({ length: count }, () => 0);
      for (let k = 0; k < count; k++)
        chunks[k] = yield { kind: 'input', index: k };
      const advance = async function* (k: number): Process {
        if (++at[k] === chunks[k]!.time.length) {
          chunks[k] = yield { kind: 'input', index: k };
          at[k] = 0;
        }
      };
      // Windowed inputs cover the window but may begin at different samples.
      while (inputRange && chunks.every(Boolean)) {
        const latest = Math.max(
          ...chunks.map((chunk, k) => chunk!.time[at[k]]),
        );
        if (chunks.every((chunk, k) => chunk!.time[at[k]] === latest)) break;
        for (let k = 0; k < count && chunks.every(Boolean); k++)
          while (chunks[k] && chunks[k]!.time[at[k]] < latest)
            yield* advance(k);
      }
      const signals = new Float64Array(count);
      let output: Point[] = [];
      while (chunks.every(Boolean)) {
        check();
        const time = chunks[0]!.time[at[0]];
        for (let k = 0; k < count; k++) {
          if (chunks[k]!.time[at[k]] !== time)
            throw new Error('Inputs must share timestamps.');
          signals[k] = chunks[k]!.values[at[k]];
        }
        output.push([time, formula.evaluate(signals, constants)]);
        for (let k = 0; k < count; k++) yield* advance(k);
        if (output.length === SIZE) {
          yield { kind: 'output', chunk: arrays(output) };
          output = [];
        }
      }
      if (chunks.some(Boolean) && !inputRange)
        throw new Error('Input lengths differ.');
      if (output.length) yield { kind: 'output', chunk: arrays(output) };
      return;
    }
    const mean =
      node.operation === 'smooth'
        ? new RollingMean(node.parameters.value)
        : undefined;
    const median =
      node.operation === 'median'
        ? new RollingMedian(node.parameters.value)
        : undefined;
    const exponential =
      node.operation === 'exponential'
        ? new ExponentialSmoother(node.parameters.value)
        : undefined;
    const rc =
      node.operation === 'low-pass' || node.operation === 'high-pass'
        ? new RcFilter(node.parameters.value, node.operation)
        : undefined;
    const origin = graph.ranges.get(node.parents[0])![0];
    let previous: Point | undefined;
    let integrated = 0;
    let gridIndex = 0;
    let minimum: Point | undefined;
    let maximum: Point | undefined;
    let chunk: SeriesChunk | undefined;
    const checkpointed = CHECKPOINTED.has(node.operation);
    if (inputRange && (checkpointed || LOOKBACK.has(node.operation))) {
      // Resume exactly: restore the state a complete pass would hold at a
      // sample before the window, then process from there to the window end.
      const F = CHECKPOINT_FIELDS;
      const margin =
        node.operation === 'resample' ? 2 / node.parameters.value : 0;
      const start = inputRange[0] - margin,
        end = inputRange[1] + margin;
      const history = historySize(node);
      const checkpoints = checkpointed
        ? options.checkpoints?.(node)
        : undefined;
      let row = -1;
      if (checkpoints) {
        let low = 0,
          high = checkpoints.length / F;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (checkpoints[middle * F] < start) low = middle + 1;
          else high = middle;
        }
        row = low - 1;
      }
      if (checkpointed && row < 0) {
        // No saved state before the window: evaluate from the first sample.
        yield { kind: 'open', index: 0, range: [-Infinity, end] };
        chunk = yield { kind: 'input', index: 0 };
      } else {
        const anchor = checkpointed ? checkpoints![row * F] : start;
        // A look-back operation also emits the sample before the window.
        const need = checkpointed
          ? Math.min(history, checkpoints![row * F + 1])
          : history + 1;
        const spacing = inputSpacing(node, checkpoints);
        const parentStart = graph.ranges.get(node.parents[0])![0];
        let span = !need
          ? 0
          : spacing && Number.isFinite(spacing)
            ? (need + 2) * spacing * 1.25
            : Infinity;
        const times = new Float64Array(need),
          values = new Float64Array(need);
        while (true) {
          const from = anchor - span;
          yield { kind: 'open', index: 0, range: [from, end] };
          const complete = from <= parentStart;
          let seen = 0;
          chunk = yield { kind: 'input', index: 0 };
          let split = 0;
          while (chunk) {
            check();
            split = lowerBound(chunk.time, anchor);
            for (let i = Math.max(0, split - need); i < split; i++) {
              times[seen % need] = chunk.time[i];
              values[seen % need] = chunk.values[i];
              seen++;
            }
            if (split < chunk.time.length) break;
            chunk = yield { kind: 'input', index: 0 };
          }
          if (seen < need && !complete) {
            // Too little look-back before the anchor: widen and read again.
            span = Math.max(span * 4, (need + 2) * 1e-9);
            if (!Number.isFinite(anchor - span)) span = Infinity;
            continue;
          }
          const count = Math.min(seen, need);
          const ordered = (source: Float64Array) =>
            Float64Array.from({ length: count }, (_, k) => {
              const position = seen - count + k;
              return source[position % need];
            });
          let oldTimes = ordered(times),
            oldValues = ordered(values);
          let replay: Point | undefined;
          if (!checkpointed && count) {
            // The newest look-back sample is the neighbor before the window.
            replay = [oldTimes[count - 1], oldValues[count - 1]];
            oldTimes = oldTimes.subarray(0, count - 1);
            oldValues = oldValues.subarray(0, count - 1);
          }
          const state = checkpointed ? row * F + 2 : 0;
          if (mean)
            mean.restore(
              oldValues,
              checkpoints![state],
              checkpoints![state + 1],
            );
          median?.restore(oldValues);
          exponential?.restore(checkpoints![state]);
          rc?.restore(
            checkpoints![state],
            checkpoints![state + 1],
            checkpoints![state + 2],
          );
          if (node.operation === 'integral') integrated = checkpoints![state];
          if (node.operation === 'resample') gridIndex = checkpoints![state];
          if (oldTimes.length) previous = [oldTimes.at(-1)!, oldValues.at(-1)!];
          // Continue with the replayed neighbor and the rest of this chunk.
          const rest = chunk
            ? {
                time: chunk.time.subarray(split),
                values: chunk.values.subarray(split),
              }
            : { time: new Float64Array(), values: new Float64Array() };
          const length = rest.time.length + (replay ? 1 : 0);
          const time = new Float64Array(length),
            value = new Float64Array(length);
          if (replay) {
            time[0] = replay[0];
            value[0] = replay[1];
          }
          time.set(rest.time, replay ? 1 : 0);
          value.set(rest.values, replay ? 1 : 0);
          chunk = length ? { time, values: value } : undefined;
          if (!chunk) chunk = yield { kind: 'input', index: 0 };
          break;
        }
      }
    } else chunk = yield { kind: 'input', index: 0 };
    // A complete pass records exact state for later windows.
    const recording = !inputRange && checkpointed && !!options.record;
    const saved: number[] = [];
    let consumed = 0;
    const save = (time: number) => {
      const state: number[] = mean
        ? mean.state()
        : exponential
          ? [exponential.state()]
          : rc
            ? rc.state()
            : node.operation === 'integral'
              ? [integrated]
              : [gridIndex];
      saved.push(time, consumed, state[0] ?? 0, state[1] ?? 0, state[2] ?? 0);
    };
    while (chunk) {
      check();
      if (node.operation === 'resample') {
        let output: Point[] = [];
        for (let i = 0; i < chunk.time.length; i++) {
          const t = chunk.time[i];
          const input = chunk.values[i];
          if (recording) {
            if (consumed && consumed % CHECKPOINT_INTERVAL === 0) save(t);
            consumed++;
          }
          let next = origin + gridIndex / node.parameters.value;
          while (next <= t) {
            check();
            output.push([
              next,
              next === t
                ? input
                : previous && next === previous[0]
                  ? previous[1]
                  : previous && t - previous[0] <= node.parameters.maxGap
                    ? previous[1] +
                      ((input - previous[1]) * (next - previous[0])) /
                        (t - previous[0])
                    : NaN,
            ]);
            const candidate = origin + ++gridIndex / node.parameters.value;
            if (candidate <= next)
              throw new Error(
                'The output rate is too precise for these timestamps. Align to zero first.',
              );
            next = candidate;
            if (output.length === SIZE) {
              yield { kind: 'output', chunk: arrays(output) };
              output = [];
              await pause();
            }
          }
          previous = [t, input];
        }
        if (output.length) yield { kind: 'output', chunk: arrays(output) };
      } else if (node.operation === 'min-max') {
        for (let i = 0; i < chunk.time.length; i++) {
          const v = chunk.values[i];
          if (!Number.isFinite(v)) continue;
          if (!minimum || v < minimum[1]) minimum = [chunk.time[i], v];
          if (!maximum || v > maximum[1]) maximum = [chunk.time[i], v];
        }
      } else {
        // Each evaluation owns its raw copies. Reuse these buffers through unary
        // stages, including crop views, so chain depth does not multiply buffers.
        let count = 0;
        for (let i = 0; i < chunk.time.length; i++) {
          let t = chunk.time[i];
          const input = chunk.values[i];
          if (recording) {
            if (consumed && consumed % CHECKPOINT_INTERVAL === 0) save(t);
            consumed++;
          }
          let value = input;
          switch (node.operation) {
            case 'crop':
              if (
                t < node.parameters.start ||
                t > node.parameters.end ||
                (node.parameters.endExclusive === 1 &&
                  t === node.parameters.end)
              )
                continue;
              break;
            case 'smooth':
              value = mean!.next(input);
              break;
            case 'median':
              value = median!.next(input);
              break;
            case 'exponential':
              value = exponential!.next(input);
              break;
            case 'low-pass':
            case 'high-pass':
              value = rc!.next(t, input);
              break;
            case 'scale':
              value *= node.parameters.value;
              break;
            case 'offset':
              value += node.parameters.value;
              break;
            case 'convert':
              value = value * node.parameters.factor + node.parameters.offset;
              break;
            case 'absolute':
              value = Math.abs(value);
              break;
            case 'time-shift':
              t += node.parameters.value;
              break;
            case 'zero-time':
              t -= origin;
              break;
            case 'derivative':
              value = previous
                ? (input - previous[1]) / (t - previous[0])
                : NaN;
              break;
            case 'integral':
              if (
                previous &&
                Number.isFinite(input) &&
                Number.isFinite(previous[1])
              )
                integrated += ((input + previous[1]) * (t - previous[0])) / 2;
              value = Number.isFinite(input) ? integrated : NaN;
              break;
          }
          previous = [chunk.time[i], input];
          chunk.time[count] = t;
          chunk.values[count] = value;
          count++;
        }
        if (count)
          yield {
            kind: 'output',
            chunk: {
              time: chunk.time.subarray(0, count),
              values: chunk.values.subarray(0, count),
            },
          };
      }
      chunk = yield { kind: 'input', index: 0 };
    }
    if (recording && saved.length)
      options.record!(node, Float64Array.from(saved));
    if (node.operation === 'min-max' && minimum && maximum)
      yield {
        kind: 'output',
        chunk: arrays(
          minimum[0] === maximum[0]
            ? [minimum]
            : [minimum, maximum].sort((a, b) => a[0] - b[0]),
        ),
      };
  }
  type Frame = {
    node: SignalNode;
    range?: [number, number];
    process: Process;
    inputs: Map<number, Frame>;
    response?: SeriesChunk;
  };
  const frame = (node: SignalNode, inputRange?: [number, number]): Frame => ({
    node,
    range: inputRange,
    process: process(node, inputRange),
    inputs: new Map(),
  });
  const stack = [frame(graph.find(id), range)];
  let ticks = 0;
  try {
    while (stack.length) {
      check();
      if (++ticks % 256 === 0) {
        await pause();
        check();
      }
      const current = stack.at(-1)!;
      const result = await current.process.next(current.response);
      current.response = undefined;
      if (result.done) {
        stack.pop();
        continue;
      }
      if (result.value.kind === 'open') {
        const index = result.value.index;
        current.inputs.set(
          index,
          frame(graph.find(current.node.parents[index]), result.value.range),
        );
        continue;
      }
      if (result.value.kind === 'input') {
        const index = result.value.index;
        let child = current.inputs.get(index);
        if (!child) {
          child = frame(
            graph.find(current.node.parents[index]),
            parentWindow(current.node, graph, current.range),
          );
          current.inputs.set(index, child);
        }
        stack.push(child);
      } else if (stack.length === 1) yield result.value.chunk;
      else {
        stack.pop();
        stack.at(-1)!.response = result.value.chunk;
      }
    }
  } finally {
    // Do not recursively close nested generators; input frames contain no open
    // transactions or external handles and become collectable with the root.
    stack.length = 0;
  }
}
