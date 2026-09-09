import type {
  Project,
  Segment,
  SegmentationDefinition,
  SegmentationOperation,
  SignalNode,
} from './signal-types';

export type CompleteSegmentationOperation = SegmentationOperation & {
  definition: SegmentationDefinition;
};

function batches(project: Project): Map<string, Segment[]> {
  const groups = new Map<string, Segment[]>();
  const definitions = new Map<SegmentationDefinition, string>();
  const savedIds = new Map(
    (project.segmentationOperations ?? []).flatMap((operation) =>
      operation.segmentIds.map((id) => [id, operation.id] as const),
    ),
  );
  for (const segment of project.segments) {
    const id =
      segment.batchId ??
      savedIds.get(segment.id) ??
      (segment.definition && definitions.get(segment.definition)) ??
      segment.id;
    if (segment.definition) definitions.set(segment.definition, id);
    const members = groups.get(id) ?? [];
    members.push(segment);
    groups.set(id, members);
  }
  return groups;
}

/** Return an isolated settings snapshot. Opening history must never change it. */
export function segmentationOperation(
  project: Project,
  id: string,
): CompleteSegmentationOperation {
  const saved = project.segmentationOperations?.find(
    (operation) => operation.id === id,
  );
  if (saved?.definition)
    return structuredClone({ ...saved, definition: saved.definition });
  return completeOperation(
    project,
    id,
    batches(project).get(id) ?? [],
    new Map(project.nodes.map((node) => [node.id, node])),
    saved,
  );
}

function completeOperation(
  project: Project,
  id: string,
  segments: Segment[],
  byId: Map<string, SignalNode>,
  saved?: SegmentationOperation,
): CompleteSegmentationOperation {
  const first = segments[0];
  if (!first) throw new Error('This segmentation operation no longer exists.');
  const targetIds = saved?.targetIds ?? [
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
  const independently =
    saved?.independently ??
    segments.some((segment) => !!segment.boundary?.inputId);
  const scope =
    saved?.scope ??
    first.scope ??
    (!independently &&
    targetIds.length === source.channels.length &&
    source.channels.every((id) => targetIds.includes(id))
      ? 'file'
      : 'signals');
  return structuredClone({
    id,
    sourceId: first.sourceId,
    // Old ramp heuristics did not retain enough information to reproduce their
    // triggers. Their exact output boundaries are a complete manual recipe.
    definition: first.definition ?? {
      method: 'ranges',
      boundary: 'clip',
      ranges: segments.map((segment) => [segment.start, segment.end]),
    },
    targetIds,
    independently,
    scope,
    segmentIds: segments.map((segment) => segment.id),
  });
}

/** Upgrade metadata only; existing node IDs, samples and dependencies stay put. */
export function restoreSegmentationOperations(project: Project): Project {
  const operations = new Map(
    (project.segmentationOperations ?? []).map((operation) => [
      operation.id,
      operation,
    ]),
  );
  const replacements = new Map<string, Segment>();
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  for (const [id, segments] of batches(project)) {
    if (operations.get(id)?.definition) continue;
    const operation = completeOperation(
      project,
      id,
      segments,
      byId,
      operations.get(id),
    );
    operations.set(id, operation);
    for (const segment of segments)
      replacements.set(segment.id, {
        ...segment,
        batchId: id,
        scope: operation.scope,
        definition: segment.definition ?? operation.definition,
      });
  }
  if (!replacements.size) return project;
  return {
    ...project,
    segmentationOperations: [...operations.values()],
    segments: project.segments.map(
      (segment) => replacements.get(segment.id) ?? segment,
    ),
  };
}
