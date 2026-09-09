import type { Project } from './signal-types';
import type { FunctionRun, RegionSet, Region } from './region-types';

export function nextSequence(project: Project): number {
  let value = 0;
  for (const item of [
    ...(project.regionSets ?? []),
    ...(project.functionRuns ?? []),
  ])
    value = Math.max(value, item.sequence + 1);
  return value;
}

/** Adapt existing history without changing a single signal recipe or sample. */
export function migrateRegionHistory(project: Project): Project {
  const sets = [...(project.regionSets ?? [])];
  const runs = [...(project.functionRuns ?? [])];
  const knownSets = new Set(sets.map((set) => set.id));
  const knownNodes = new Set(
    runs.flatMap((run) => run.outputs.map((output) => output.signalId)),
  );
  const byId = new Map(
    project.nodes.map((node, index) => [node.id, { node, index }]),
  );
  const bySegment = new Map(
    project.segments.map((segment) => [segment.id, segment]),
  );
  const bindings = new Map(
    project.segments.flatMap((segment) =>
      segment.nodes.map((id) => [id, segment.id] as const),
    ),
  );
  for (const run of runs)
    for (const output of run.outputs)
      if (output.regionId) bindings.set(output.signalId, output.regionId);
  for (const operation of project.segmentationOperations ?? []) {
    if (knownSets.has(operation.id) || !operation.definition) continue;
    const segments = operation.segmentIds.flatMap(
      (id) => bySegment.get(id) ?? [],
    );
    if (!segments.length) continue;
    sets.push({
      id: operation.id,
      sourceId: operation.sourceId,
      name: 'Regions',
      version: 1,
      sequence: byId.get(segments[0].nodes[0])?.index ?? 0,
      createdAt: byId.get(segments[0].nodes[0])?.node.createdAt ?? '',
      timeReference: 'recording',
      definition: operation.definition,
      regions: segments.map((segment) => ({
        id: segment.id,
        name: segment.name,
        start: segment.start,
        end: segment.end,
        endInclusive: true,
        boundary: segment.boundary,
      })),
    });
  }
  const groups = new Map<string, FunctionRun>();
  for (const [index, node] of project.nodes.entries()) {
    const regionId = bindings.get(node.id) ?? bindings.get(node.parents[0]);
    if (regionId) bindings.set(node.id, regionId);
    if (
      node.operation === 'raw' ||
      node.operation === 'crop' ||
      node.internal ||
      knownNodes.has(node.id)
    )
      continue;
    const id = node.batchId ?? node.id;
    let run = groups.get(id);
    if (!run) {
      run = {
        id,
        sourceId: node.sourceId,
        sequence: index,
        createdAt: node.createdAt,
        operation: node.operation,
        parameter: node.parameters.value ?? 0,
        inputIds: [],
        outputs: [],
        skipped: 0,
        regionSetId: sets.find((set) =>
          set.regions.some((region) => region.id === regionId),
        )?.id,
      };
      groups.set(id, run);
    }
    run.inputIds.push(node.parents[0]);
    if (node.parents[1])
      run.secondaryIds = [
        ...new Set([...(run.secondaryIds ?? []), node.parents[1]]),
      ];
    run.outputs.push({ signalId: node.id, inputId: node.parents[0], regionId });
  }
  if (sets.length === (project.regionSets?.length ?? 0) && !groups.size)
    return project;
  return {
    ...project,
    regionSets: sets,
    functionRuns: [...runs, ...groups.values()],
  };
}

export function regionBindings(project: Project): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const segment of project.segments)
    for (const id of segment.nodes) bindings.set(id, segment.id);
  for (const run of project.functionRuns ?? [])
    for (const output of run.outputs)
      if (output.regionId) bindings.set(output.signalId, output.regionId);
  return bindings;
}

export function regionContains(
  project: Project,
  ancestorId: string,
  childId: string,
  index?: ReadonlyMap<string, Region>,
): boolean {
  const byId =
    index ??
    new Map(
      (project.regionSets ?? []).flatMap((set) =>
        set.regions.map((region) => [region.id, region] as const),
      ),
    );
  let id: string | undefined = childId;
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    if (id === ancestorId) return true;
    visited.add(id);
    id = byId.get(id)?.parentRegionId;
  }
  return false;
}

export type HistoryItem = {
  id: string;
  sequence: number;
  set?: RegionSet;
  run?: FunctionRun;
};
export function regionHistory(
  project: Project,
  sourceId: string,
): HistoryItem[] {
  return [
    ...(project.regionSets ?? [])
      .filter((set) => set.sourceId === sourceId)
      .map((set) => ({ id: set.id, sequence: set.sequence, set })),
    ...(project.functionRuns ?? [])
      .filter((run) => run.sourceId === sourceId)
      .map((run) => ({ id: run.id, sequence: run.sequence, run })),
  ].sort((a, b) => a.sequence - b.sequence);
}
