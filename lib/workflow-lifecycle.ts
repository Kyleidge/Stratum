import type { EngineRequest, Project } from './signal-types';
import type { WorkflowStep } from './workflow-types';
import { segmentationOperation } from './segmentation-operation';
import { formatCount } from './format-count';
import { stepName } from './workflow-history';
import { savedBindings } from './value-bindings';
import { compileFormula } from './formula';
import { isSegmentCrop, visibleInput } from './file-segments';
import { isBinaryOperation } from './signal-arithmetic';

const withBindings = (
  bindings: import('./workflow-types').ParameterBindings | undefined,
) => (bindings ? { bindings } : {});

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
      type: 'segment-set';
      sourceId: string;
      definition: import('./signal-types').SegmentationDefinition;
      referenceId?: string;
      within?: import('./signal-types').SegmentScope;
    }
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
          step.valueInputIds?.some((id) => outputs.has(id)) ||
          step.segmentInputIds?.some((id) => outputs.has(id)) ||
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
  const read = new Set(
    project.nodes.flatMap((node) => (outputs.has(node.id) ? [] : node.parents)),
  );
  // Hidden segment crops go with the last output that reads them.
  const nodes = project.nodes.filter(
    (node) =>
      !outputs.has(node.id) &&
      !sources.has(node.sourceId) &&
      (!isSegmentCrop(node) || read.has(node.id)),
  );
  const live = new Set(nodes.map((node) => node.id));
  const sets = new Set(
    steps.flatMap((step) => (step.segmentSetId ? [step.segmentSetId] : [])),
  );
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
    ...(project.segmentSets
      ? {
          segmentSets: project.segmentSets.filter(
            (set) => !sets.has(set.id) && !sources.has(set.sourceId),
          ),
        }
      : {}),
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
  if (step.segmentSetId) {
    const set = project.segmentSets?.find(
      (item) => item.id === step.segmentSetId,
    );
    if (!set) throw new Error('These segments no longer exist.');
    return {
      type: 'segment-set',
      sourceId: set.sourceId,
      definition: structuredClone(set.definition),
      ...(set.referenceId ? { referenceId: set.referenceId } : {}),
      ...(set.within ? { within: structuredClone(set.within) } : {}),
    };
  }
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
  const within = step.within ? { within: structuredClone(step.within) } : {};
  if (step.kind === 'value')
    return {
      ...within,
      type: 'calculate-values',
      inputIds: step.inputIds,
      operation: step.operation as import('./workflow-types').ValueOperation,
      ...(step.parameters ? { parameters: { ...step.parameters } } : {}),
      ...withBindings(
        savedBindings(
          step.outputIds.flatMap(
            (id) => project.values?.find((value) => value.id === id) ?? [],
          ),
        ),
      ),
    };
  if (step.kind === 'derive' && step.within) {
    // Outputs read hidden crops; the command names the signals they crop.
    const nodes = new Map(project.nodes.map((node) => [node.id, node]));
    const outputs = step.outputIds.flatMap((id) => nodes.get(id) ?? []);
    const first = outputs[0];
    if (!first) throw new Error('This step has no outputs to rebuild.');
    const read = (position: number) => [
      ...new Set(
        outputs.flatMap((node) =>
          node.parents[position] === undefined
            ? []
            : [visibleInput(nodes, node.parents[position])],
        ),
      ),
    ];
    if (isBinaryOperation(first.operation))
      return {
        type: 'region-function',
        settings: {
          sourceId: first.sourceId,
          operation: first.operation,
          parameter: 0,
          inputIds: read(0),
          secondaryIds: read(1),
          within: structuredClone(step.within),
        },
      };
    const letters =
      first.operation === 'formula'
        ? compileFormula(first.expression ?? '').signals.slice(1)
        : [];
    return {
      ...within,
      type: 'derive-many',
      parentIds: read(0),
      operation: first.operation,
      parameter: step.parameters?.value ?? first.parameters.value ?? 0,
      ...withBindings(savedBindings(outputs)),
      ...(first.operation === 'formula'
        ? {
            unit: first.unit,
            formula: {
              expression: first.expression ?? '',
              ...(letters.length
                ? {
                    signals: Object.fromEntries(
                      letters.map((letter, k) => [letter, read(k + 1)]),
                    ),
                  }
                : {}),
            },
          }
        : first.operation === 'convert'
          ? { unit: first.unit }
          : {}),
    };
  }
  if (step.kind === 'derive') {
    const run = project.functionRuns?.find((item) =>
      item.outputs.some((output) => step.outputIds.includes(output.signalId)),
    );
    if (run) return { type: 'region-function', settings: { ...run } };
    const first = project.nodes.find((node) => node.id === step.outputIds[0]);
    if (first && first.operation !== 'raw' && first.operation !== 'crop') {
      const outputs = step.outputIds.flatMap(
        (id) => project.nodes.find((node) => node.id === id) ?? [],
      );
      // A formula's other signals: each letter's inputs across the batch.
      const letters =
        first.operation === 'formula'
          ? compileFormula(first.expression ?? '').signals.slice(1)
          : [];
      const formula =
        first.operation === 'formula'
          ? {
              unit: first.unit,
              formula: {
                expression: first.expression ?? '',
                ...(letters.length
                  ? {
                      signals: Object.fromEntries(
                        letters.map((letter, k) => [
                          letter,
                          [
                            ...new Set(
                              outputs.map((node) => node.parents[k + 1]),
                            ),
                          ],
                        ]),
                      ),
                    }
                  : {}),
              },
            }
          : first.operation === 'convert'
            ? { unit: first.unit }
            : {};
      return {
        type: 'derive-many',
        parentIds: step.outputIds.map(
          (id) => project.nodes.find((node) => node.id === id)!.parents[0],
        ),
        operation: first.operation,
        parameter: step.parameters?.value ?? first.parameters.value ?? 0,
        ...withBindings(savedBindings(outputs)),
        ...formula,
      };
    }
  }
  throw new Error(
    `Operation #${step.sequence + 1} uses a legacy recipe that cannot be rebuilt safely. Remove or recreate that dependent operation first.`,
  );
}

/**
 * What each output of a segment step, or of a derive or value step, is: a
 * segment's place within its parent, or an input (within a segment). Edit
 * keeps an output's ID when its key survives, however many there are.
 */
export function segmentOutputKeys(
  project: Project,
  step: WorkflowStep,
): string[] | undefined {
  if (step.segmentSetId) {
    const set = project.segmentSets?.find(
      (item) => item.id === step.segmentSetId,
    );
    if (!set) return undefined;
    const counts = new Map<string, number>();
    const keys = new Map(
      set.segments.map((segment) => {
        const parent = segment.parentId ?? '';
        const place = (counts.get(parent) ?? 0) + 1;
        counts.set(parent, place);
        return [segment.id, `${parent}#${place}`] as const;
      }),
    );
    return step.outputIds.map((id) => keys.get(id) ?? id);
  }
  if (step.kind !== 'derive' && step.kind !== 'value') return undefined;
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const values = new Map(project.values?.map((value) => [value.id, value]));
  const keys = step.outputIds.map((id) => {
    const node = nodes.get(id);
    const value = values.get(id);
    const input = node
      ? visibleInput(nodes, node.parents[0])
      : (value?.inputId ?? id);
    return `${input}\n${(node ?? value)?.segmentId ?? ''}`;
  });
  // Other steps match by position.
  return new Set(keys).size === keys.length ? keys : undefined;
}

/**
 * A later step's saved command after earlier steps were rebuilt: a list that
 * used every output of a rebuilt step uses all of its new outputs. Outputs
 * that no longer exist may not be used on their own.
 */
export function followRebuiltBatches(
  command: WorkflowCommand,
  rebuilt: { old: string[]; now: string[] }[],
): WorkflowCommand {
  const follow = (ids: string[]): string[] => {
    let list = ids;
    for (const batch of rebuilt) {
      const kept = new Set(batch.now);
      const gone = batch.old.filter((id) => !kept.has(id));
      const all = batch.old.every((id) => list.includes(id));
      if (all && (gone.length || batch.now.length !== batch.old.length)) {
        const old = new Set(batch.old);
        const at = list.findIndex((id) => old.has(id));
        const rest = list.filter((id) => !old.has(id));
        list = [...rest.slice(0, at), ...batch.now, ...rest.slice(at)];
      } else if (gone.some((id) => list.includes(id)))
        throw new Error(
          'The new settings remove outputs that later steps use on their own. Remove or revise those steps first. Existing work is unchanged.',
        );
    }
    return list;
  };
  switch (command.type) {
    case 'derive-many':
      return {
        ...command,
        parentIds: follow(command.parentIds),
        ...(command.formula?.signals
          ? {
              formula: {
                ...command.formula,
                signals: Object.fromEntries(
                  Object.entries(command.formula.signals).map(
                    ([letter, ids]) => [letter, follow(ids)],
                  ),
                ),
              },
            }
          : {}),
      };
    case 'calculate-values':
      return { ...command, inputIds: follow(command.inputIds) };
    case 'region-function':
      return {
        ...command,
        settings: {
          ...command.settings,
          inputIds: follow(command.settings.inputIds),
          ...(command.settings.secondaryIds
            ? { secondaryIds: follow(command.settings.secondaryIds) }
            : {}),
        },
      };
    default:
      return command;
  }
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

/** A History reference such as `#009`. */
export const stepReference = (step: Pick<WorkflowStep, 'sequence'>) =>
  `#${String(step.sequence + 1).padStart(3, '0')}`;

const stepTitle = (step: WorkflowStep) =>
  `${stepReference(step)} ${stepName(step)}`;
const quoted = (text: string) =>
  `'${text.length > 60 ? `${text.slice(0, 59)}…` : text}'`;
const bySequence = (a: WorkflowStep, b: WorkflowStep) =>
  a.sequence - b.sequence;

/** A journaled change: its Undo/Redo label and the step it centres on. */
export type JournalChange = { label: string; stepId?: string };

/**
 * Names the user action that turned `before` into `after`, for Undo/Redo
 * labels ("Edit #009 Segment signals"). Reads only explicit records (steps,
 * batches, names, checks); returns undefined when nothing recognisable changed.
 */
export function describeChange(
  before: Project,
  after: Project,
): JournalChange | undefined {
  const priorBatches = new Map(
    before.workflowBatches?.map((batch) => [batch.id, batch]),
  );
  for (const batch of after.workflowBatches ?? []) {
    const prior = priorBatches.get(batch.id);
    const added = batch.runs.length - (prior?.runs.length ?? 0);
    if (added > 0)
      return {
        label: `Run ${quoted(batch.name)} on ${formatCount(added, 'recording')}`,
      };
    if (prior && prior.state !== batch.state)
      return { label: `Finish batch ${quoted(batch.name)}` };
  }
  const priorSteps = new Map(
    (before.workflowSteps ?? []).map((step) => [step.id, step]),
  );
  const steps = after.workflowSteps ?? [];
  const kept = new Set(steps.map((step) => step.id));
  const removed = (before.workflowSteps ?? [])
    .filter((step) => !kept.has(step.id))
    .sort(bySequence);
  const added = steps
    .filter((step) => !priorSteps.has(step.id))
    .sort(bySequence);
  const sourceName = (project: Project, id: string) =>
    project.sources.find((source) => source.id === id)?.name ?? 'recording';
  if (removed.length && !added.length) {
    const [first] = removed;
    const rest = removed.length - 1;
    const target =
      first.kind === 'import'
        ? `Remove recording ${sourceName(before, first.sourceId)}`
        : `Delete ${stepTitle(first)}`;
    return {
      label: rest
        ? `${target} and ${formatCount(rest, first.kind === 'import' ? 'step' : 'dependent step')}`
        : target,
      stepId: first.id,
    };
  }
  if (added.length && !removed.length) {
    const imports = added.filter((step) => step.kind === 'import');
    const [first] = imports.length ? imports : added;
    const rest = added.length - 1;
    const target =
      imports.length > 1
        ? `Import ${formatCount(imports.length, 'recording')}`
        : first.kind === 'import'
          ? `Import ${sourceName(after, first.sourceId)}`
          : `Add ${stepTitle(first)}`;
    return {
      label:
        rest && imports.length <= 1
          ? `${target} and ${formatCount(rest, 'more step', 'more steps')}`
          : target,
      stepId: first.id,
    };
  }
  if (added.length) return undefined;
  const changed = steps
    .map((step) => [priorSteps.get(step.id)!, step] as const)
    .sort(([a], [b]) => bySequence(a, b));
  const edited = changed.find(
    ([old, step]) => (step.revision ?? 1) > (old.revision ?? 1),
  );
  if (edited)
    return { label: `Edit ${stepTitle(edited[0])}`, stepId: edited[1].id };
  const renamed = changed.find(([old, step]) => old.name !== step.name);
  if (renamed)
    return {
      label: `Rename ${stepReference(renamed[1])} to ${quoted(stepName(renamed[1]))}`,
      stepId: renamed[1].id,
    };
  const checked = changed.find(
    ([old, step]) =>
      JSON.stringify(old.checks ?? []) !== JSON.stringify(step.checks ?? []),
  );
  if (checked)
    return {
      label: `Change checks on ${stepTitle(checked[1])}`,
      stepId: checked[1].id,
    };
  const priorSources = new Map(
    before.sources.map((source) => [source.id, source]),
  );
  const recording = after.sources.find(
    (source) =>
      priorSources.has(source.id) &&
      priorSources.get(source.id)!.name !== source.name,
  );
  if (recording)
    return {
      label: `Rename recording to ${quoted(recording.name)}`,
      stepId: steps.find(
        (step) => step.kind === 'import' && step.sourceId === recording.id,
      )?.id,
    };
  const labels = after.labels ?? {},
    priorLabels = before.labels ?? {};
  const output = Object.keys(labels).find(
    (id) => labels[id] !== priorLabels[id],
  );
  if (output)
    return {
      label: `Rename ${after.nodes.some((node) => node.id === output) ? 'signal' : 'value'} to ${quoted(labels[output])}`,
      stepId: steps.find((step) => step.outputIds.includes(output))?.id,
    };
  const imported = after.sources.filter(
    (source) => !priorSources.has(source.id),
  );
  if (imported.length)
    return {
      label:
        imported.length === 1
          ? `Import ${imported[0].name}`
          : `Import ${formatCount(imported.length, 'recording')}`,
    };
  return undefined;
}
