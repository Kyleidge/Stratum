import { isBinaryOperation } from './signal-arithmetic';
import { SignalGraph } from './signal-graph';
import { stepName, WorkflowIndex } from './workflow-history';
import { savedCommand } from './workflow-lifecycle';
import {
  slug,
  type RecipeChannel,
  type RecipeOperation,
  type RecipeRef,
  type RecipeStep,
  type TimeOrigin,
  type WorkflowRecipe,
} from './workflow-recipe';
import type {
  EdgeTrigger,
  Project,
  SegmentationDefinition,
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
  /** Workspace output ID → recipe reference, for converting report blocks. */
  refs: Map<string, RecipeRef>;
};

class Unexportable extends Error {}

/** Segmentation clock start, matching the engine's axis offsets. */
export function clockStart(project: Project, graph: SignalGraph, id: string) {
  const node = graph.nodes.get(id);
  const range = graph.ranges.get(id);
  if (!node || !range) return 0;
  return node.sourceId === ''
    ? range[0]
    : range[0] - (graph.offsets.get(id) ?? 0);
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

  const candidates = (project.workflowSteps ?? [])
    .filter(
      (step) =>
        step.kind !== 'import' &&
        (!options.stepIds || options.stepIds.has(step.id)),
    )
    .sort((a, b) => a.sequence - b.sequence);
  for (const step of candidates) {
    // Dependencies on the recording decide eligibility; other recordings are skipped quietly.
    const originals = index.lineage(step.outputIds).originals;
    if (!originals.some((node) => node.sourceId === sourceId)) continue;
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
          };
          break;
        }
        case 'calculate-values':
          operation = {
            kind: 'value',
            operation: command.operation,
            inputs: many(command.inputIds),
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
        case 'segment': {
          let definition: SegmentationDefinition = structuredClone(
            command.definition,
          );
          if (definition.method === 'triggers') {
            const bindings = definition.bindings;
            const placeholder = (side: 'start' | 'end', item: EdgeTrigger) => ({
              ...trigger(item),
              ...(bindings?.[`${side}.threshold`] ? { threshold: 0 } : {}),
              ...(bindings?.[`${side}.offset`] ? { offset: 0 } : {}),
            });
            definition = {
              ...definition,
              start: placeholder('start', definition.start),
              end: placeholder('end', definition.end),
              ...(bindings ? { bindings: bound(bindings) } : {}),
            };
          } else {
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
            const shift =
              origin === 'recording-start'
                ? -source.start
                : origin === 'input-start'
                  ? -clockStart(project, graph, command.targetIds[0])
                  : 0;
            definition =
              definition.method === 'ranges'
                ? {
                    ...definition,
                    ranges: definition.ranges.map(
                      ([start, end]) =>
                        [start + shift, end + shift] as [number, number],
                    ),
                  }
                : {
                    ...definition,
                    start: definition.start + shift,
                    end: definition.end + shift,
                  };
          }
          operation = {
            kind: 'segment',
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
      warnings.push({
        recipeStepId: step.id,
        message: `“${named(step.id)}” uses output ${position} of “${named(ref[1])}”. Items with fewer outputs skip it; consider an output count check on “${named(ref[1])}”.`,
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
        step.kind !== 'import' &&
        index
          .lineage(step.outputIds)
          .originals.some((node) => node.sourceId === sourceId),
    )
    .sort((a, b) => a.sequence - b.sequence);
}
