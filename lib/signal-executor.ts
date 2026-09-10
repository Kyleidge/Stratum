import { RollingMean, bsfc, power } from './signal-math';
import {
  arithmeticValue,
  isArithmetic,
  isBinaryOperation,
} from './signal-arithmetic';
import { ExponentialSmoother, RcFilter, RollingMedian } from './signal-filters';
import type { SignalGraph } from './signal-graph';
import type { Point, SeriesChunk, SignalNode } from './signal-types';

type Instruction =
  | { kind: 'input'; index: number }
  | { kind: 'output'; chunk: SeriesChunk };
type Process = AsyncGenerator<Instruction, void, SeriesChunk | undefined>;
const SIZE = 16384;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
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
): AsyncGenerator<SeriesChunk> {
  async function* process(
    node: SignalNode,
    inputRange?: [number, number],
  ): Process {
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
      if (a || b) throw new Error('Input lengths differ.');
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
    let chunk = yield { kind: 'input', index: 0 };
    while (chunk) {
      check();
      if (node.operation === 'resample') {
        let output: Point[] = [];
        for (let i = 0; i < chunk.time.length; i++) {
          const t = chunk.time[i];
          const input = chunk.values[i];
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
    process: Process;
    inputs: Map<number, Frame>;
    response?: SeriesChunk;
  };
  const frame = (node: SignalNode, inputRange?: [number, number]): Frame => ({
    node,
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
      if (result.value.kind === 'input') {
        const index = result.value.index;
        let child = current.inputs.get(index);
        if (!child) {
          // Only a crop directly above raw storage may prune reads. Stateful
          // predecessors must see their full history before a later crop.
          child = frame(
            graph.find(current.node.parents[index]),
            current.node.operation === 'crop'
              ? [current.node.parameters.start, current.node.parameters.end]
              : undefined,
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
