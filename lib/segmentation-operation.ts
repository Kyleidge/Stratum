import type { Project, SegmentationOperation } from './signal-types';

/** Return an isolated settings snapshot. Opening history must never change it. */
export function segmentationOperation(
  project: Project,
  id: string,
): SegmentationOperation {
  const saved = project.segmentationOperations?.find(
    (operation) => operation.id === id,
  );
  if (saved) return structuredClone(saved);
  const first = project.segments.find(
    (segment) => segment.batchId === id || segment.id === id,
  );
  if (!first) throw new Error('This segmentation operation no longer exists.');
  const segments = project.segments.filter((segment) =>
    first.batchId
      ? segment.batchId === first.batchId
      : segment.id === first.id ||
        (first.definition && segment.definition === first.definition),
  );
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const targetIds = [
    ...new Set(
      segments.flatMap((segment) =>
        segment.nodes.flatMap((nodeId) => {
          const node = byId.get(nodeId);
          return node?.operation === 'crop' ? [node.parents[0]] : [];
        }),
      ),
    ),
  ];
  const source = project.sources.find(
    (source) => source.id === first.sourceId,
  )!;
  const independently = segments.some((segment) => !!segment.boundary?.inputId);
  const scope =
    first.scope ??
    (!independently &&
    targetIds.length === source.channels.length &&
    source.channels.every((id) => targetIds.includes(id))
      ? 'file'
      : 'signals');
  return structuredClone({
    id,
    sourceId: first.sourceId,
    definition: first.definition,
    targetIds,
    independently,
    scope,
    segmentIds: segments.map((segment) => segment.id),
  });
}
