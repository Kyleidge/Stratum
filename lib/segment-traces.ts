import type { Plot, Segment, SignalNode } from './signal-types';

// Compare a channel across heterogeneous segment groups, never by array index.
export function segmentTraces(
  target: SignalNode,
  segments: Segment[],
  nodes: SignalNode[],
  plots: Record<string, Plot>,
  colors: string[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  function origin(node: SignalNode): string {
    let current = node;
    const seen = new Set<string>();
    while (current.parents[0] && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parents[0]);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }
  const channel = origin(target);
  return segments.flatMap((segment, index) => {
    const node = segment.nodes
      .map((id) => byId.get(id))
      .find(
        (item) =>
          item &&
          item.operation === 'crop' &&
          item.unit === target.unit &&
          origin(item) === channel,
      );
    const plot = node && plots[node.id];
    return node && plot
      ? [
          {
            node,
            plot,
            offset: node.parameters.start,
            color: colors[index % colors.length],
            label: segment.name,
          },
        ]
      : [];
  });
}
