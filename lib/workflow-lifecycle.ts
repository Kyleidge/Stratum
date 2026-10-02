import type { EngineRequest, Project } from './signal-types';
import type { WorkflowStep } from './workflow-types';
import { segmentationOperation } from './segmentation-operation';

export type WorkflowCommand =
  | Extract<
      EngineRequest,
      {
        type:
          | 'derive-many'
          | 'calculate-values'
          | 'region-function'
          | 'time-operation';
      }
    >
  | {
      type: 'segment';
      sourceId: string;
      definition: import('./signal-types').SegmentationDefinition;
      targetIds: string[];
      independently?: boolean;
      scope?: import('./signal-types').SegmentationScope;
    };

function ownedRegionSetIds(project: Project, step: WorkflowStep): string[] {
  if (step.kind === 'regions' && step.regionSetId) return [step.regionSetId];
  if (
    step.kind === 'segment' &&
    step.segmentationId &&
    project.regionSets?.some((set) => set.id === step.segmentationId)
  )
    return [step.segmentationId];
  return [];
}

/** Operations are atomic batches: a dependent invocation is rebuilt/removed whole. */
export function affectedOperations(
  project: Project,
  stepId: string,
): WorkflowStep[] {
  const steps = project.workflowSteps ?? [];
  const first = steps.find((step) => step.id === stepId);
  if (!first)
    throw new Error('This operation no longer exists. Reload the workspace.');
  const removed = new Set([stepId]),
    outputs = new Set(first.outputIds);
  const sets = new Set(ownedRegionSetIds(project, first));
  const regionsById = new Map(project.regionSets?.map((set) => [set.id, set]));
  const segmentations = new Map(
    project.segmentationOperations?.map((operation) => [
      operation.id,
      operation,
    ]),
  );
  const runByOutput = new Map(
    project.functionRuns?.flatMap((run) =>
      run.outputs.map((output) => [output.signalId, run] as const),
    ),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      const region = regionsById.get(step.regionSetId ?? '');
      const segmentation = segmentations.get(step.segmentationId ?? '');
      const runs = step.outputIds.flatMap((id) => runByOutput.get(id) ?? []);
      if (
        !removed.has(step.id) &&
        ((first.kind === 'import' && step.sourceId === first.sourceId) ||
          step.inputIds.some((id) => outputs.has(id)) ||
          // Saved invocations also depend on inputs that yielded no outputs.
          segmentation?.targetIds.some((id) => outputs.has(id)) ||
          (!!step.regionSetId && sets.has(step.regionSetId)) ||
          (!!region?.parentSetId && sets.has(region.parentSetId)) ||
          (!!region?.previousId && sets.has(region.previousId)) ||
          runs.some(
            (run) =>
              (!!run.regionSetId && sets.has(run.regionSetId)) ||
              [...run.inputIds, ...(run.secondaryIds ?? [])].some((id) =>
                outputs.has(id),
              ),
          ))
      ) {
        removed.add(step.id);
        step.outputIds.forEach((id) => outputs.add(id));
        ownedRegionSetIds(project, step).forEach((id) => sets.add(id));
        changed = true;
      }
    }
  }
  return steps
    .filter((step) => removed.has(step.id))
    .sort((a, b) => a.sequence - b.sequence);
}

export function withoutOperations(
  project: Project,
  steps: WorkflowStep[],
): Project {
  const stepIds = new Set(steps.map((step) => step.id));
  const outputs = new Set(steps.flatMap((step) => step.outputIds));
  const sources = new Set(
    steps.filter((step) => step.kind === 'import').map((step) => step.sourceId),
  );
  const regions = new Set(
    steps.flatMap((step) => ownedRegionSetIds(project, step)),
  );
  const segmentation = new Set(
    steps.flatMap((step) => (step.segmentationId ? [step.segmentationId] : [])),
  );
  const nodes = project.nodes.filter(
    (node) => !outputs.has(node.id) && !sources.has(node.sourceId),
  );
  const live = new Set(nodes.map((node) => node.id));
  const segments = project.segments
    .map((segment) => ({
      ...segment,
      nodes: segment.nodes.filter((id) => live.has(id)),
    }))
    .filter(
      (segment) => segment.nodes.length && !sources.has(segment.sourceId),
    );
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const functionRuns = project.functionRuns?.filter(
    (run) =>
      run.outputs.every((output) => live.has(output.signalId)) &&
      !sources.has(run.sourceId),
  );
  const runIds = new Set(functionRuns?.map((run) => run.id));
  // Batch items keep only their remaining steps; removed recordings drop the item.
  const remainingSteps = new Set(
    (project.workflowSteps ?? [])
      .filter((step) => !stepIds.has(step.id))
      .map((step) => step.id),
  );
  const workflowBatches = project.workflowBatches
    ?.map((batch) => ({
      ...batch,
      runs: batch.runs
        .filter((run) => !sources.has(run.sourceId))
        .map((run) => ({
          ...run,
          steps: Object.fromEntries(
            Object.entries(run.steps).filter(([, id]) =>
              remainingSteps.has(id),
            ),
          ),
        })),
    }))
    .filter((batch) => batch.runs.length);
  const hashes = new Set(workflowBatches?.map((batch) => batch.recipeHash));
  return {
    ...project,
    sources: project.sources.filter((source) => !sources.has(source.id)),
    nodes,
    values: project.values?.filter(
      (value) => !outputs.has(value.id) && !sources.has(value.sourceId),
    ),
    workflowSteps: project.workflowSteps?.filter(
      (step) => !stepIds.has(step.id),
    ),
    segments,
    segmentationOperations: project.segmentationOperations
      ?.filter(
        (operation) =>
          !segmentation.has(operation.id) &&
          !sources.has(operation.sourceId) &&
          operation.targetIds.every((id) => live.has(id)),
      )
      .map((operation) => ({
        ...operation,
        segmentIds: operation.segmentIds.filter((id) => segmentIds.has(id)),
      })),
    regionSets: project.regionSets?.filter(
      (set) => !regions.has(set.id) && !sources.has(set.sourceId),
    ),
    functionRuns,
    examples: project.examples?.filter(
      (example) =>
        !sources.has(example.sourceId) &&
        example.outputIds.every((id) => live.has(id)),
    ),
    regionExamples: project.regionExamples?.filter(
      (example) =>
        !sources.has(example.sourceId) &&
        !regions.has(example.regionSetId) &&
        (!example.runId || runIds.has(example.runId)),
    ),
    ...(project.workflowBatches ? { workflowBatches } : {}),
    ...(project.workflowRecipes
      ? {
          workflowRecipes: project.workflowRecipes.filter((recipe) =>
            hashes.has(recipe.hash),
          ),
        }
      : {}),
  };
}

export function savedCommand(
  project: Project,
  step: WorkflowStep,
): WorkflowCommand {
  if (step.timeSettings)
    return {
      type: 'time-operation',
      settings: structuredClone(step.timeSettings),
    };
  if (step.kind === 'segment' && step.segmentationId) {
    const saved = segmentationOperation(project, step.segmentationId);
    return {
      type: 'segment',
      sourceId: saved.sourceId,
      definition: saved.definition,
      targetIds: saved.targetIds,
      independently: saved.independently,
      scope: saved.scope,
    };
  }
  if (step.kind === 'value')
    return {
      type: 'calculate-values',
      inputIds: step.inputIds,
      operation: step.operation as import('./workflow-types').ValueOperation,
    };
  if (step.kind === 'derive') {
    const run = project.functionRuns?.find((item) =>
      item.outputs.some((output) => step.outputIds.includes(output.signalId)),
    );
    if (run) return { type: 'region-function', settings: { ...run } };
    const first = project.nodes.find((node) => node.id === step.outputIds[0]);
    if (first && first.operation !== 'raw' && first.operation !== 'crop')
      return {
        type: 'derive-many',
        parentIds: step.outputIds.map(
          (id) => project.nodes.find((node) => node.id === id)!.parents[0],
        ),
        operation: first.operation,
        parameter: step.parameters?.value ?? first.parameters.value ?? 0,
      };
  }
  throw new Error(
    `Operation #${step.sequence + 1} uses a legacy recipe that cannot be rebuilt safely. Remove or recreate that dependent operation first.`,
  );
}

/** Metadata IDs only: this never touches immutable raw sample columns. */
export function remapProject(
  project: Project,
  ids: Map<string, string>,
): Project {
  return JSON.parse(
    JSON.stringify(project, (_key, value: unknown) =>
      typeof value === 'string' ? (ids.get(value) ?? value) : value,
    ),
  ) as Project;
}
