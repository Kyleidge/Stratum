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
    const parent = byId.get(node.parents[0]);
    return parent ? origin(parent) : node.id;
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
