import type { SignalNode } from './signal-types';

/**
 * The sample-grid identity the engine checks before combining two signals,
 * mirrored here only to group Input B choices. The engine still validates.
 */
export function gridKey(
  nodes: ReadonlyMap<string, SignalNode>,
  id: string,
): string {
  const operations: [string, Record<string, number>][] = [];
  let node = nodes.get(id);
  while (node && node.operation !== 'raw') {
    if (node.timeRecipe?.kind === 'resample')
      return JSON.stringify([
        node.timeReference?.id,
        node.timeRecipe.grid,
        operations,
      ]);
    if (
      node.timeRecipe?.kind === 'align' ||
      node.timeRecipe?.kind === 'crop' ||
      node.operation === 'min-max'
    )
      return JSON.stringify([node.id, operations]);
    if (
      ['crop', 'resample', 'time-shift', 'zero-time'].includes(node.operation)
    ) {
      const last = operations.at(-1);
      if (node.operation === 'crop' && last?.[0] === 'crop') {
        const a = last[1],
          b = node.parameters;
        const end = Math.min(a.end, b.end);
        last[1] = {
          start: Math.max(a.start, b.start),
          end,
          endExclusive:
            (a.end === end && a.endExclusive === 1) ||
            (b.end === end && b.endExclusive === 1)
              ? 1
              : 0,
        };
      } else
        operations.push([
          node.operation,
          node.operation === 'crop'
            ? {
                ...node.parameters,
                endExclusive: node.parameters.endExclusive ?? 0,
              }
            : node.parameters,
        ]);
    }
    node = nodes.get(node.parents[0]);
  }
  return JSON.stringify([node?.sourceId, operations]);
}
