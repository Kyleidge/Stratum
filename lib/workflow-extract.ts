import { isBinaryOperation } from './signal-arithmetic';
import { SignalGraph } from './signal-graph';
import { stepName, WorkflowIndex } from './workflow-history';
import { savedCommand } from './workflow-lifecycle';
import {
  slug,
  WORKFLOW_VERSION,
  type RecipeChannel,
  type RecipeOperation,
  type RecipeRef,
  type RecipeStep,
  type RecipeWithin,
  type TimeOrigin,
  type WorkflowRecipe,
} from './workflow-recipe';
import type {
  EdgeTrigger,
  Project,
  SegmentationDefinition,
  SegmentScope,
} from './signal-types';
import type { TimeAnchor } from './time-types';
import type { ParameterBindings, WorkflowStep } from './workflow-types';

export type ExtractOptions = {
  name: string;
  revision?: string;
  description?: string;
  itemLabel?: string;
  pattern?: string;
  /** Limit the recipe to these steps; ineligible ones are reported. */
  stepIds?: ReadonlySet<string>;
  /** Override where fixed segment times are measured from. */
  timeOrigins?: Readonly<Record<string, TimeOrigin>>;
};
export type ExtractedStep = {
  stepId: string;
  recipeStepId: string;
  /** Segments with fixed times can be measured from a different origin. */
  timeOrigin?: TimeOrigin;
  /** Origins that are valid for this step. */
  origins?: TimeOrigin[];
};
export type ExtractedWorkflow = {
  recipe: WorkflowRecipe;
  included: ExtractedStep[];
  skipped: { stepId: string; reason: string }[];
  warnings: { recipeStepId: string; message: string }[];
  /**
   * Workspace output ID → recipe reference, for converting report blocks.
   * Segments are not listed: reports bind signals and values.
   */
  refs: Map<string, RecipeRef>;
};

class Unexportable extends Error {}

/**
 * Whether a step works on this recording: through its inputs, or, for
 * segments found by fixed times, because they are the recording's segments.
 */
function fromRecording(
  project: Project,
  index: WorkflowIndex,
  step: WorkflowStep,
  sourceId: string,
): boolean {
  if (
    step.segmentSetId &&
    project.segmentSets?.some(
      (set) => set.id === step.segmentSetId && set.sourceId === sourceId,
    )
  )
    return true;
  return index
    .lineage(step.outputIds)
    .originals.some((node) => node.sourceId === sourceId);
}

/** Segmentation clock start, matching the engine's axis offsets. */
export function clockStart(project: Project, graph: SignalGraph, id: string) {
  const node = graph.nodes.get(id);
  const range = graph.ranges.get(id);
  if (!node || !range) return 0;
  return node.sourceId === ''
    ? range[0]
    : range[0] - (graph.offsets.get(id) ?? 0);
}

/** Fixed ranges and windows moved by `shift` seconds. */
function shiftTimes(
  definition: SegmentationDefinition,
  shift: number,
): SegmentationDefinition {
  if (definition.method === 'ranges')
    return {
      ...definition,
      ranges: definition.ranges.map(
        ([start, end]) => [start + shift, end + shift] as [number, number],
      ),
    };
  if (definition.method === 'windows')
    return {
      ...definition,
      start: definition.start + shift,
      end: definition.end + shift,
    };
  return definition;
}

/** Fold numbered labels such as "Run 1", "Run 2" into "Run {n}". */
export function labelPattern(
  labels: (string | undefined)[],
): RecipeStep['outputs'] {
  if (!labels.length || labels.every((label) => label === undefined))
    return undefined;
  if (labels.length === 1) return labels[0];
  const first = labels[0];
  if (first && labels.every((label) => label !== undefined)) {
    for (
      let at = first.indexOf('1');
      at >= 0;
      at = first.indexOf('1', at + 1)
    ) {
      if (
        /[0-9]/.test(first[at - 1] ?? '') ||
        /[0-9]/.test(first[at + 1] ?? '')
      )
        continue;
      const template = `${first.slice(0, at)}{n}${first.slice(at + 1)}`;
      if (
        labels.every(
          (label, index) =>
            label === template.replace('{n}', String(index + 1)),
        )
      )
        return template;
    }
  }
  return labels.map((label) => label ?? null);
}

/**
 * Build a portable recipe from the steps derived from one recording. Each
 * step's exact saved command (the one Edit uses) is translated, replacing every
 * signal ID with a channel alias or an earlier step's output reference.
 */
export function extractWorkflow(
  project: Project,
  sourceId: string,
  options: ExtractOptions,
): ExtractedWorkflow {
  const source = project.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error('Choose a recording to save the workflow from.');
  const index = new WorkflowIndex(project);
  const graph = new SignalGraph(project);
  const channels: RecipeChannel[] = [];
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  const unique = (base: string) => {
    let key = base,
      suffix = 2;
    while (used.has(key)) key = `${base.slice(0, 60)}-${suffix++}`;
    used.add(key);
    return key;
  };
  const owners = new Map<string, { key: string; outputs: string[] }>();
  const refs = new Map<string, RecipeRef>();
  const included: ExtractedStep[] = [];
  const skipped: ExtractedWorkflow['skipped'] = [];
  const warnings: ExtractedWorkflow['warnings'] = [];
  const steps: RecipeStep[] = [];

  const alias = (id: string) => {
    const existing = aliases.get(id);
    if (existing) return existing;
    const node = index.nodes.get(id)!;
    const key = unique(slug(node.name));
    aliases.set(id, key);
    refs.set(id, key);
    channels.push({
      alias: key,
      name: node.name,
      ...(node.unit && node.unit !== '—' ? { unit: node.unit } : {}),
    });
    return key;
  };
  const one = (id: string): RecipeRef => {
    if (source.channels.includes(id)) return alias(id);
    const owner = owners.get(index.owner.get(id)?.id ?? '');
    if (!owner)
      throw new Unexportable(
        `uses “${index.label(id)}”, which is not from this recording or an included step`,
      );
    return owner.outputs.length === 1
      ? owner.key
      : `${owner.key}[${owner.outputs.indexOf(id) + 1}]`;
  };
  // A complete, ordered output list becomes one cardinality-free reference.
  const many = (ids: string[]): RecipeRef[] => {
    const result: RecipeRef[] = [];
    for (let i = 0; i < ids.length;) {
      const owner = owners.get(index.owner.get(ids[i])?.id ?? '');
      if (
        owner &&
        owner.outputs.length > 1 &&
        owner.outputs.every((id, offset) => ids[i + offset] === id)
      ) {
        result.push(owner.key);
        i += owner.outputs.length;
      } else result.push(one(ids[i++]));
    }
    return result;
  };
  const trigger = (item: EdgeTrigger): EdgeTrigger => ({
    ...item,
    signalId: one(item.signalId),
  });
  // Bound settings reference value steps; their numbers are resolved per run.
  const bound = (bindings?: ParameterBindings) =>
    bindings
      ? Object.fromEntries(
          Object.entries(bindings).map(([name, binding]) => [
            name,
            { valueIds: many(binding.valueIds), factor: binding.factor },
          ]),
        )
      : undefined;
  const anchor = (item: TimeAnchor): TimeAnchor =>
    item.kind === 'event' ? { ...item, trigger: trigger(item.trigger) } : item;
  // Trigger signals become references; settings taken from values hold 0.
  const triggers = (source: SegmentationDefinition): SegmentationDefinition => {
    const definition = structuredClone(source);
    if (definition.method !== 'triggers') return definition;
    const bindings = definition.bindings;
    const placeholder = (side: 'start' | 'end', item: EdgeTrigger) => ({
      ...trigger(item),
      ...(bindings?.[`${side}.threshold`] ? { threshold: 0 } : {}),
      ...(bindings?.[`${side}.offset`] ? { offset: 0 } : {}),
    });
    return {
      ...definition,
      start: placeholder('start', definition.start),
      end: placeholder('end', definition.end),
      ...(bindings ? { bindings: bound(bindings) } : {}),
    };
  };
  // `within`: every segment of an included segment step, or positions.
  const scope = (within: SegmentScope): RecipeWithin => {
    const set = [...owners.entries()].find(
      ([id]) => index.steps.get(id)?.segmentSetId === within.setId,
    );
    if (!set) {
      const step = (project.workflowSteps ?? []).find(
        (item) => item.segmentSetId === within.setId,
      );
      throw new Unexportable(
        `works within “${step ? stepName(step) : 'segments'}”, which is not from this recording or an included step`,
      );
    }
    const [, owner] = set;
    const ids = within.segmentIds;
    if (
      !ids ||
      (ids.length === owner.outputs.length &&
        ids.every((id, position) => owner.outputs[position] === id))
    )
      return [owner.key];
    return ids.map((id) => {
      const position = owner.outputs.indexOf(id);
      if (position < 0)
        throw new Unexportable('works within a segment that no longer exists');
      return `${owner.key}[${position + 1}]`;
    });
  };

  // Dependencies on the recording decide eligibility; other recordings are skipped quietly.
  const candidates = (project.workflowSteps ?? [])
    .filter(
      (step) =>
        step.kind !== 'import' &&
        (!options.stepIds || options.stepIds.has(step.id)) &&
        fromRecording(project, index, step, sourceId),
    )
    .sort((a, b) => a.sequence - b.sequence);
  // Segment steps that crop signals exist only in version 1 files; a
  // workflow with file segments or `within` is version 2 and cannot hold them.
  const legacy = (step: WorkflowStep) =>
    step.kind === 'segment' && !step.segmentSetId && !!step.segmentationId;
  const version =
    candidates.some(legacy) &&
    !candidates.some((step) => step.segmentSetId || step.within)
      ? 1
      : WORKFLOW_VERSION;
  for (const step of candidates) {
    const snapshot = {
      channels: channels.length,
      aliases: new Map(aliases),
      used: new Set(used),
    };
    const key = unique(slug(stepName(step)));
    let origin: TimeOrigin | undefined;
    let origins: TimeOrigin[] | undefined;
    try {
      if (step.kind === 'regions')
        throw new Unexportable('is a saved region set from an earlier version');
      let command;
      try {
        command = savedCommand(project, step);
      } catch (error) {
        throw new Unexportable(
          error instanceof Error ? error.message : 'uses an unsupported recipe',
        );
      }
      let operation: RecipeOperation;
      switch (command.type) {
        case 'derive-many':
          operation = {
            kind: 'derive',
            operation: command.operation,
            inputs: many(command.parentIds),
            ...(command.within ? { within: scope(command.within) } : {}),
            // Bound, formula and conversion parameters are not numbers.
            parameter:
              command.bindings?.value ||
              command.formula ||
              command.operation === 'convert'
                ? 0
                : command.parameter,
            ...(command.bindings ? { bindings: bound(command.bindings) } : {}),
            ...(command.unit !== undefined ? { unit: command.unit } : {}),
            ...(command.formula
              ? {
                  formula: {
                    expression: command.formula.expression,
                    ...(command.formula.signals
                      ? {
                          signals: Object.fromEntries(
                            Object.entries(command.formula.signals).map(
                              ([letter, ids]) => [letter, many(ids)],
                            ),
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          };
          break;
        case 'region-function': {
          const settings = command.settings;
          if (settings.regionSetId || settings.regionIds?.length)
            throw new Unexportable(
              'uses saved region scopes from an earlier version',
            );
          const binary = isBinaryOperation(settings.operation);
          if (binary && settings.secondaryIds?.length !== 1)
            throw new Unexportable('needs exactly one second input');
          operation = {
            kind: 'derive',
            operation: settings.operation,
            inputs: many(settings.inputIds),
            parameter: settings.parameter,
            ...(binary ? { with: one(settings.secondaryIds![0]) } : {}),
            ...(settings.within ? { within: scope(settings.within) } : {}),
          };
          break;
        }
        case 'calculate-values':
          operation = {
            kind: 'value',
            operation: command.operation,
            inputs: many(command.inputIds),
            ...(command.within ? { within: scope(command.within) } : {}),
            ...(command.parameters
              ? {
                  parameters: Object.fromEntries(
                    Object.entries(command.parameters).map(([name, value]) => [
                      name,
                      command.bindings?.[name] ? 0 : value,
                    ]),
                  ),
                }
              : {}),
            ...(command.bindings ? { bindings: bound(command.bindings) } : {}),
          };
          break;
        case 'segment-set': {
          let definition = triggers(command.definition);
          let reference: RecipeRef | undefined;
          if (command.referenceId) reference = one(command.referenceId);
          // Nested ranges and windows are already relative to each parent.
          if (definition.method !== 'triggers' && !command.within) {
            origins = command.referenceId
              ? ['recording', 'input-start']
              : ['recording', 'recording-start'];
            origin = options.timeOrigins?.[step.id] ?? 'recording';
            if (!origins.includes(origin)) origin = 'recording';
            definition = shiftTimes(
              definition,
              origin === 'recording-start'
                ? -source.start
                : origin === 'input-start'
                  ? -clockStart(project, graph, command.referenceId!)
                  : 0,
            );
            if (origin === 'recording')
              warnings.push({
                recipeStepId: key,
                message: `“${stepName(step)}” uses fixed recording times. Every recording must have the same timing, or measure from its start instead.`,
              });
          }
          operation = {
            kind: 'segment',
            definition,
            ...(command.within ? { within: scope(command.within) } : {}),
            ...(reference ? { reference } : {}),
            timeOrigin: origin ?? 'recording',
          };
          break;
        }
        case 'segment': {
          if (version !== 1)
            throw new Unexportable(
              'crops signals, as segment steps did before file segments, so a workflow with file segments cannot hold it. Recreate it as a Segment step that finds segments',
            );
          let definition = triggers(command.definition);
          if (definition.method !== 'triggers') {
            // Nested segments default to times measured from their own input.
            const nested =
              command.targetIds.length === 1 &&
              index.owner.get(command.targetIds[0])?.kind === 'segment';
            origins = [
              'recording',
              'recording-start',
              ...(command.targetIds.length === 1
                ? (['input-start'] as const)
                : []),
            ];
            origin =
              options.timeOrigins?.[step.id] ??
              (nested ? 'input-start' : 'recording');
            if (!origins.includes(origin)) origin = 'recording';
            definition = shiftTimes(
              definition,
              origin === 'recording-start'
                ? -source.start
                : origin === 'input-start'
                  ? -clockStart(project, graph, command.targetIds[0])
                  : 0,
            );
          }
          operation = {
            kind: 'crop-segment',
            inputs: many(command.targetIds),
            definition,
            independently: !!command.independently,
            ...(command.scope === 'file' ? { scope: 'file' as const } : {}),
            timeOrigin: origin ?? 'recording',
          };
          if (definition.method !== 'triggers' && origin === 'recording')
            warnings.push({
              recipeStepId: key,
              message: `“${stepName(step)}” uses fixed recording times. Every recording must have the same timing, or measure from its start instead.`,
            });
          break;
        }
        case 'time-operation': {
          const settings = structuredClone(command.settings);
          if (settings.kind === 'align') {
            settings.reference = { ...settings.reference, id: '' };
            for (const group of settings.groups) {
              group.inputIds = many(group.inputIds);
              group.anchor = anchor(group.anchor);
              if (group.secondAnchor)
                group.secondAnchor = anchor(group.secondAnchor);
            }
          } else if (settings.kind === 'combine')
            settings.inputIds = [
              one(settings.inputIds[0]),
              one(settings.inputIds[1]),
            ];
          else {
            settings.inputIds = many(settings.inputIds);
            if (
              settings.kind === 'resample' &&
              settings.grid.kind === 'reference'
            )
              settings.grid = {
                ...settings.grid,
                signalId: one(settings.grid.signalId),
              };
          }
          if (
            settings.kind === 'crop' ||
            (settings.kind === 'resample' && settings.grid.kind === 'uniform')
          )
            warnings.push({
              recipeStepId: key,
              message: `“${stepName(step)}” uses fixed times that assume every recording has the same timing.`,
            });
          operation = { kind: 'time', settings };
          break;
        }
        default:
          throw new Unexportable('uses an unsupported recipe');
      }
      const outputs = step.outputIds;
      const recipeStep: RecipeStep = {
        id: key,
        ...(step.name ? { name: step.name } : {}),
        operation,
        onFail: 'continue',
      };
      const pattern = labelPattern(outputs.map((id) => project.labels?.[id]));
      if (pattern !== undefined) recipeStep.outputs = pattern;
      if (step.checks?.length) recipeStep.checks = structuredClone(step.checks);
      steps.push(recipeStep);
      owners.set(step.id, { key, outputs });
      if (!step.segmentSetId)
        outputs.forEach((id, position) =>
          refs.set(id, outputs.length === 1 ? key : `${key}[${position + 1}]`),
        );
      included.push({
        stepId: step.id,
        recipeStepId: key,
        ...(origin ? { timeOrigin: origin, origins } : {}),
      });
    } catch (error) {
      if (!(error instanceof Unexportable)) throw error;
      // Undo aliases and the key claimed by a step that cannot be exported.
      channels.length = snapshot.channels;
      aliases.clear();
      snapshot.aliases.forEach((value, id) => aliases.set(id, value));
      used.clear();
      snapshot.used.forEach((value) => used.add(value));
      for (const [id, ref] of refs)
        if (!snapshot.aliases.has(id) && source.channels.includes(id) && ref)
          refs.delete(id);
      skipped.push({
        stepId: step.id,
        reason: `${stepName(step)} ${error.message}.`,
      });
    }
  }
  // Warnings name steps as History does, never by their workflow IDs.
  const warned = new Set<string>();
  const named = (id: string) => {
    const step = steps.find((item) => item.id === id);
    return step?.name ?? id;
  };
  for (const step of steps)
    for (const ref of JSON.stringify(step.operation).matchAll(
      /"([a-z][a-z0-9-]*)\[(\d+)\]"/g,
    )) {
      const position = ref[2];
      if (warned.has(`${ref[1]}[${position}]`)) continue;
      warned.add(`${ref[1]}[${position}]`);
      const segments =
        steps.find((item) => item.id === ref[1])?.operation.kind === 'segment';
      warnings.push({
        recipeStepId: step.id,
        message: segments
          ? `“${named(step.id)}” works within segment ${position} of “${named(ref[1])}”. Items with fewer segments skip it; consider a count check on “${named(ref[1])}”.`
          : `“${named(step.id)}” uses output ${position} of “${named(ref[1])}”. Items with fewer outputs skip it; consider an output count check on “${named(ref[1])}”.`,
      });
    }
  if (!steps.length)
    throw new Error(
      skipped.length
        ? `No steps from this recording can be saved. ${skipped[0].reason}`
        : 'This recording has no steps to save yet. Derive, segment or calculate values first.',
    );
  return {
    recipe: {
      version,
      name: options.name,
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.description ? { description: options.description } : {}),
      item: {
        label: options.itemLabel || 'Item',
        ...(options.pattern ? { pattern: options.pattern } : {}),
      },
      channels,
      steps,
    },
    included,
    skipped,
    warnings,
    refs,
  };
}

/** Steps a recording's workflow could include, for the Save dialog. */
export function recordingSteps(
  project: Project,
  sourceId: string,
): WorkflowStep[] {
  const index = new WorkflowIndex(project);
  return (project.workflowSteps ?? [])
    .filter(
      (step) =>
        step.kind !== 'import' && fromRecording(project, index, step, sourceId),
    )
    .sort((a, b) => a.sequence - b.sequence);
}
