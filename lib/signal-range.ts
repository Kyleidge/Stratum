import type { SignalGraph } from './signal-graph';
import type { SignalNode } from './signal-types';

export type SignalRange = [number, number];

/** Include the chunks beside a gap as well as both viewport boundary neighbors. */
export function chunkWindow(
  chunks: SignalRange[],
  range?: SignalRange,
): [number, number] {
  if (!range) return [0, chunks.length];
  let low = 0,
    high = chunks.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (chunks[mid][1] < range[0]) low = mid + 1;
    else high = mid;
  }
  const first = Math.max(0, low - 1);
  high = chunks.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (chunks[mid][0] <= range[1]) low = mid + 1;
    else high = mid;
  }
  return [first, Math.min(chunks.length, low + 1)];
}

/** Only stateless, unary paths can prune their parent's history safely. */
export function parentWindow(
  node: SignalNode,
  graph: SignalGraph,
  range?: SignalRange,
): SignalRange | undefined {
  const recipe = node.timeRecipe;
  if (recipe) {
    if (recipe.kind === 'align')
      return range?.map(
        (time) => (time - recipe.target) / recipe.scale + recipe.anchor,
      ) as SignalRange | undefined;
    if (recipe.kind === 'crop')
      return cropWindow([recipe.start, recipe.end], range);
    return undefined;
  }
  if (node.operation === 'crop')
    return cropWindow([node.parameters.start, node.parameters.end], range);
  if (!range) return undefined;
  if (node.operation === 'time-shift')
    return [range[0] - node.parameters.value, range[1] - node.parameters.value];
  if (node.operation === 'zero-time') {
    const origin = graph.ranges.get(node.parents[0])![0];
    return [range[0] + origin, range[1] + origin];
  }
  if (['scale', 'offset', 'absolute'].includes(node.operation)) return range;
  // Filters, reductions, resampling and binary grids retain complete input state.
  return undefined;
}

function cropWindow(bounds: SignalRange, range?: SignalRange): SignalRange {
  return range
    ? [
        Math.max(bounds[0], Math.min(bounds[1], range[0])),
        Math.max(bounds[0], Math.min(bounds[1], range[1])),
      ]
    : bounds;
}
