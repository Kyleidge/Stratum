import { timeNodes } from './time-model';
import { TIME_OPERATIONS, timeInputs, type TimeSettings } from './time-types';
import { withWorkflowHistory, WorkflowIndex } from './workflow-history';
import { segmentEntries } from './file-segments';
import {
  bestTable,
  recipeUnits,
  bindChannels,
  createResolver,
  outputLabels,
  parseRef,
  parseWorkflow,
  recipeHash,
  stepCommand,
  stepRefs,
  type BindContext,
  type RecipeStep,
} from './workflow-recipe';
import {
  evaluateChecks,
  runStatus,
  validateChecks,
  type CheckOutput,
  type OutputStatistics,
} from './workflow-checks';
import {
  affectedOperations,
  withoutOperations,
  savedCommand,
  remapProject,
  type WorkflowCommand,
  followRebuiltBatches,
  segmentOutputKeys,
} from './workflow-lifecycle';
import type {
  CheckDefinition,
  RunFlag,
  WorkflowRun,
  WorkflowStep,
} from './workflow-types';
import {
  WORKFLOW_EXAMPLE,
  workflowExampleFile,
  buildExampleWorkflow,
} from './workflow-example';
import type { Project, Source } from './signal-types';
import { randomId } from './random-id';
import {
  chosenNames,
  outputInputLabel,
  outputSegmentLabel,
} from './output-names';
import { uid } from './engine/store';
import { EngineFiles } from './engine/files';

export {
  NEWER_WORKSPACE_MESSAGE,
  WORKSPACE_SCHEMA_VERSION,
} from './engine/store';

/**
 * The signal engine: workflow commands, Edit, checks and batch runs on top of
 * the layers in lib/engine/ (storage, evaluation, plots, segments, values,
 * derive, imports, legacy regions and workspace files). Each layer calls only
 * the layers below it.
 */
export class SignalEngine extends EngineFiles {
  async applyTimeOperation(settings: TimeSettings) {
    const original = this.project;
    const before = withWorkflowHistory(original);
    const snapshot = structuredClone(settings);
    const nodes = await timeNodes(
      before,
      snapshot,
      (id) => this.evaluate(id),
      () => this.check(),
    );
    const step = {
      id: randomId(),
      sourceId: '',
      sequence: (before.workflowSteps ?? []).reduce(
        (max, item) => Math.max(max, item.sequence + 1),
        0,
      ),
      createdAt: new Date().toISOString(),
      kind: 'derive' as const,
      operation: `time-${snapshot.kind}` as keyof typeof TIME_OPERATIONS,
      inputIds: timeInputs(snapshot),
      outputIds: nodes.map((node) => node.id),
      timeSettings: snapshot,
    };
    const next = {
      ...before,
      nodes: [...before.nodes, ...nodes],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    };
    try {
      this.project = next;
      this.invalidate();
      for (const node of nodes) {
        const plot = await this.plot(node.id);
        if (!plot.summary.count && snapshot.kind === 'crop')
          throw new Error(
            'A selected signal has no finite samples in this interval.',
          );
      }
    } finally {
      this.project = original;
      this.invalidate();
    }
    await this.save(next);
    return nodes;
  }
  private async applyCommand(command: WorkflowCommand) {
    switch (command.type) {
      case 'time-operation':
        await this.applyTimeOperation(command.settings);
        break;
      case 'derive-many':
        await this.deriveMany(
          command.parentIds,
          command.operation,
          command.parameter,
          true,
          command.bindings,
          {
            ...(command.unit !== undefined ? { unit: command.unit } : {}),
            ...(command.formula ? { formula: command.formula } : {}),
            ...(command.within ? { within: command.within } : {}),
          },
        );
        break;
      case 'calculate-values':
        await this.calculateValues(
          command.inputIds,
          command.operation,
          command.parameters,
          command.bindings,
          command.within,
          command.expression,
          command.unit,
        );
        break;
      case 'segment-set':
        await this.segmentSet(
          command.sourceId,
          command.definition,
          command.referenceId,
          command.within,
        );
        break;
      case 'segment':
        await this.segment(
          command.sourceId,
          command.definition,
          command.targetIds,
          command.independently,
          command.scope,
        );
        break;
      case 'region-function':
        await this.applyRegionFunction(command.settings);
        break;
    }
  }
  /**
   * Create a step with a name chosen in its dialog, in one commit (and one
   * Undo entry) with its outputs. See `chosenNames` for how it applies.
   */
  async createNamed(command: WorkflowCommand, name: string) {
    name = name.trim();
    if (name.length > 160)
      throw new Error('Enter a name of at most 160 characters.');
    if (!name) return this.applyCommand(command);
    const before = this.project;
    let next: Project;
    this.staging = true;
    try {
      const prior = new Set(this.project.workflowSteps?.map((step) => step.id));
      await this.applyCommand(command);
      const created = this.project.workflowSteps?.filter(
        (step) => !prior.has(step.id),
      );
      if (created?.length !== 1)
        throw new Error('This operation did not produce exactly one step.');
      const { labels, stepName } = chosenNames(
        new WorkflowIndex(this.project),
        created[0],
        name,
      );
      next = {
        ...this.project,
        labels: { ...this.project.labels, ...labels },
        workflowSteps: this.project.workflowSteps!.map((step) =>
          step.id === created[0].id && stepName
            ? { ...step, name: stepName }
            : step,
        ),
      };
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    await this.save(next);
  }
  async editOperation(stepId: string, command: WorkflowCommand) {
    const before = this.project;
    const affected = affectedOperations(before, stepId);
    if (
      affected[0]?.id !== stepId ||
      ['import', 'regions'].includes(affected[0].kind)
    )
      throw new Error('This operation cannot be edited with signal settings.');
    let next: Project;
    this.staging = true;
    // Rebuilt outputs, so later steps that used a whole batch follow it.
    const rebuilt: { old: string[]; now: string[] }[] = [];
    try {
      this.project = withoutOperations(before, affected);
      this.invalidate();
      for (const old of affected) {
        this.check();
        const prior = new Set(
          this.project.workflowSteps?.map((step) => step.id),
        );
        await this.applyCommand(
          old.id === stepId
            ? command
            : followRebuiltBatches(savedCommand(before, old), rebuilt),
        );
        const added =
          this.project.workflowSteps?.filter((step) => !prior.has(step.id)) ??
          [];
        if (added.length !== 1)
          throw new Error(
            'This legacy operation cannot be rebuilt as one atomic step. Existing work is unchanged.',
          );
        const generated = added[0];
        // Segments and outputs within segments match by what they are (the
        // segment's place, or input and segment), so their count may change.
        const oldKeys = segmentOutputKeys(before, old);
        const newKeys = segmentOutputKeys(this.project, generated);
        // With the same count, keys must all match to replace positions
        // (older steps rebuild hidden crops under new IDs).
        const keyed =
          !!oldKeys &&
          !!newKeys &&
          (generated.outputIds.length !== old.outputIds.length ||
            ((known) => newKeys.every((key) => known.has(key)))(
              new Set(oldKeys),
            ));
        if (
          !keyed &&
          generated.outputIds.length !== old.outputIds.length &&
          affected.length > 1
        )
          throw new Error(
            'The new settings change the number of outputs used by later operations. Remove or revise those dependent operations first. Existing work is unchanged.',
          );
        const mapping = new Map<string, string>([[generated.id, old.id]]);
        if (keyed) {
          const byKey = new Map(
            old.outputIds.map((id, position) => [oldKeys![position], id]),
          );
          generated.outputIds.forEach((id, position) => {
            const match = byKey.get(newKeys![position]);
            if (match) mapping.set(id, match);
          });
        } else if (generated.outputIds.length === old.outputIds.length)
          generated.outputIds.forEach((id, position) =>
            mapping.set(id, old.outputIds[position]),
          );
        if (generated.segmentationId && old.segmentationId)
          mapping.set(generated.segmentationId, old.segmentationId);
        if (generated.segmentSetId && old.segmentSetId)
          mapping.set(generated.segmentSetId, old.segmentSetId);
        rebuilt.push({
          old: old.outputIds,
          now: generated.outputIds.map((id) => mapping.get(id) ?? id),
        });
        this.project = remapProject(this.project, mapping);
        this.project = {
          ...this.project,
          workflowSteps: this.project
            .workflowSteps!.map((step) =>
              step.id === old.id
                ? {
                    ...step,
                    sequence: old.sequence,
                    createdAt: old.createdAt,
                    name: old.name,
                    revision: (old.revision ?? 1) + 1,
                    updatedAt: new Date().toISOString(),
                    // Checks and batch membership belong to the operation, not its settings.
                    ...(old.checks ? { checks: old.checks } : {}),
                    ...(old.runId ? { runId: old.runId } : {}),
                    ...(old.recipeStepId
                      ? { recipeStepId: old.recipeStepId }
                      : {}),
                  }
                : step,
            )
            .sort((a, b) => a.sequence - b.sequence),
        };
        this.invalidate();
      }
      // A step may only use values calculated before it: History, backups
      // and workflow files are chronological.
      const sequences = new Map(
        this.project.workflowSteps!.flatMap((step) =>
          step.outputIds.map((id) => [id, step.sequence] as const),
        ),
      );
      for (const step of this.project.workflowSteps ?? [])
        if (
          affected.some((item) => item.id === step.id) &&
          [
            ...(step.operation === 'calculate' ? step.inputIds : []),
            ...(step.valueInputIds ?? []),
          ].some((id) => (sequences.get(id) ?? Infinity) >= step.sequence)
        )
          throw new Error(
            'A step can only use values calculated before it. Choose an earlier value, or create a new step instead. Existing work is unchanged.',
          );
      // Build every affected signal before commit so bad recipes never publish.
      const affectedIds = new Set(affected.map((step) => step.id));
      const signalIds = new Set(this.project.nodes.map((node) => node.id));
      for (const step of this.project.workflowSteps ?? [])
        if (affectedIds.has(step.id))
          for (const id of step.outputIds)
            if (signalIds.has(id)) await this.plot(id);
      for (const step of this.project.workflowSteps ?? [])
        if (affectedIds.has(step.id) && step.checks?.length)
          await this.save(await this.withCheckResults(step));
      next = this.project;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    await this.save(next);
  }
  /** Exact sample statistics from the evaluated signal, never a plot preview. */
  async outputStatistics(id: string): Promise<OutputStatistics> {
    let samples = 0,
      finite = 0,
      min = Infinity,
      max = -Infinity;
    for await (const chunk of this.evaluate(id)) {
      this.check();
      samples += chunk.time.length;
      for (const value of chunk.values)
        if (Number.isFinite(value)) {
          finite++;
          if (value < min) min = value;
          if (value > max) max = value;
        }
    }
    const [start, end] = this.bounds(id);
    return {
      samples,
      finite,
      min: finite ? min : null,
      max: finite ? max : null,
      start,
      end,
    };
  }
  private async checkOutputs(
    step: WorkflowStep,
    statistics = new Map<string, OutputStatistics>(),
  ): Promise<CheckOutput[]> {
    const index = new WorkflowIndex(this.project);
    const outputs: CheckOutput[] = [];
    for (const id of step.outputIds) {
      this.check();
      const value = index.values.get(id);
      if (value) {
        outputs.push({
          id,
          label: index.label(id),
          unit: value.unit,
          value: value.value,
        });
        continue;
      }
      // A file segment is a time interval: its duration, never samples.
      const segment = index.segments.get(id)?.segment;
      if (segment) {
        outputs.push({
          id,
          label: index.label(id),
          unit: 's',
          interval: { start: segment.start, end: segment.end },
        });
        continue;
      }
      const node = this.find(id);
      let stats = statistics.get(id);
      if (!stats) {
        stats = await this.outputStatistics(id);
        statistics.set(id, stats);
      }
      outputs.push({
        id,
        label: index.label(id),
        unit: node.unit,
        statistics: stats,
      });
    }
    return outputs;
  }
  /** The project with this step's checks evaluated for its current revision. */
  private async withCheckResults(
    step: WorkflowStep,
    statistics?: Map<string, OutputStatistics>,
  ): Promise<Project> {
    // Segment steps take count and duration checks only.
    if (step.segmentSetId && step.checks?.length)
      validateChecks(step.checks, 'segments');
    const results = step.checks?.length
      ? evaluateChecks(step.checks, await this.checkOutputs(step, statistics))
      : undefined;
    return {
      ...this.project,
      workflowSteps: this.project.workflowSteps!.map((item) => {
        if (item.id !== step.id) return item;
        const { checkResults: _old, ...rest } = item;
        void _old;
        return results
          ? { ...rest, checkResults: { revision: item.revision ?? 1, results } }
          : rest;
      }),
    };
  }
  /** Replace a step's checks and evaluate them. Undoable like a rename. */
  async setChecks(stepId: string, checks: CheckDefinition[]) {
    const step = this.project.workflowSteps?.find((item) => item.id === stepId);
    if (!step) throw new Error('This operation no longer exists.');
    if (step.kind === 'import' || step.kind === 'regions')
      throw new Error('Add checks to a derived, segment or value operation.');
    const valid = validateChecks(
      checks,
      step.kind === 'value' ? 'values' : 'signals',
    );
    const before = this.project;
    let next: Project;
    this.staging = true;
    try {
      const updated = {
        ...step,
        ...(valid.length ? { checks: valid } : {}),
      };
      if (!valid.length) delete updated.checks;
      await this.save({
        ...this.project,
        workflowSteps: this.project.workflowSteps!.map((item) =>
          item.id === stepId ? updated : item,
        ),
      });
      next = await this.withCheckResults(updated);
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    await this.save(next);
  }
  /**
   * Import one file (or use an existing recording), replay a workflow on it and
   * evaluate its checks. Everything for the item publishes in one commit; later
   * items of the same batch share one Undo entry.
   */
  async runWorkflow(options: {
    recipe: string;
    batchId: string;
    batchName: string;
    itemId: string;
    file?: File;
    /** The group of a multi-group file; the best-matching one by default. */
    table?: number;
    sourceId?: string;
    /** Pre-flight column choices for missing channels: alias → column. */
    channelMap?: Record<string, string>;
  }): Promise<WorkflowRun> {
    const recipe = parseWorkflow(options.recipe);
    // Keep only string choices for this recipe's channels; recorded with the run.
    const channelMap: Record<string, string> = {};
    for (const channel of recipe.channels) {
      const column = options.channelMap?.[channel.alias];
      if (typeof column === 'string' && column.trim())
        channelMap[channel.alias] = column.trim().slice(0, 255);
    }
    const hash = await recipeHash(recipe);
    const itemId = options.itemId.trim().slice(0, 120);
    if (!itemId) throw new Error('Enter an item ID.');
    const startedAt = new Date().toISOString();
    const before = this.project;
    let imported: Source | undefined;
    let next: Project;
    let run: WorkflowRun;
    this.staging = true;
    try {
      await this.initializeWorkflow();
      let source: Source | undefined;
      if (options.file)
        source = imported = (
          await this.importRecording(options.file, {
            choose: (recording) => [
              recording.tables[options.table ?? -1]
                ? options.table!
                : bestTable(recipe, recording.tables, channelMap),
            ],
            fill: (channels) => recipeUnits(recipe, channels, channelMap),
          })
        )[0];
      else
        source = this.project.sources.find(
          (item) => item.id === options.sourceId,
        );
      if (!source) throw new Error('Choose a recording or file to process.');
      const runId = uid();
      const flags: RunFlag[] = [];
      const stepMap: Record<string, string> = {};
      const aliases = new Map<string, string>();
      for (const binding of bindChannels(
        recipe,
        source.channels.map((id) => this.find(id)),
        channelMap,
      )) {
        if (binding.problem)
          flags.push({ severity: 'error', message: binding.problem });
        else aliases.set(binding.alias, source.channels[binding.channel]);
      }
      const outputs = new Map<string, string[]>();
      const resolve = createResolver(aliases, outputs);
      // Unavailable channel or step → the root cause it traces back to.
      const unavailable = new Map(
        recipe.channels
          .filter((channel) => !aliases.has(channel.alias))
          .map((channel) => [channel.alias, channel.alias]),
      );
      const skippedBy = new Map<string, string[]>();
      const context: BindContext = {
        resolve,
        sourceOf: (id) => this.find(id).sourceId,
        sourceId: source.id,
        segmentSet: (id) => {
          const set = segmentEntries(this.project).get(id)?.set;
          if (!set) throw new Error('These segments no longer exist.');
          return { id: set.id, sourceId: set.sourceId };
        },
        clockStart: (id) => this.bounds(id)[0] - this.axisOffset(id),
        recordingStart: source.start,
        newId: uid,
      };
      // A newly imported item is named after it, so History reads per item.
      const importStep = `import:${source.id}`;
      await this.save({
        ...this.project,
        workflowSteps: this.project.workflowSteps!.map((step) =>
          step.id === importStep && !step.runId
            ? {
                ...step,
                runId,
                ...(imported && !step.name
                  ? { name: `${recipe.item.label} ${itemId}`.slice(0, 160) }
                  : {}),
              }
            : step,
        ),
      });
      let stoppedAt: string | undefined;
      const label = (step: RecipeStep) => step.name ?? step.id;
      for (const step of recipe.steps) {
        this.check();
        if (stoppedAt) {
          unavailable.set(step.id, stoppedAt);
          continue;
        }
        const missing = stepRefs(step)
          .map((ref) => parseRef(ref).name)
          .find((name) => unavailable.has(name));
        if (missing) {
          const root = unavailable.get(missing)!;
          unavailable.set(step.id, root);
          skippedBy.set(root, [...(skippedBy.get(root) ?? []), label(step)]);
          continue;
        }
        const prior = new Set(
          this.project.workflowSteps!.map((item) => item.id),
        );
        try {
          await this.applyCommand(stepCommand(step, context));
        } catch (error) {
          if (this.cancelled) throw error;
          unavailable.set(step.id, step.id);
          flags.push({
            severity: 'error',
            recipeStepId: step.id,
            message: `“${label(step)}” could not run: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
          continue;
        }
        const added = this.project.workflowSteps!.filter(
          (item) => !prior.has(item.id),
        );
        if (added.length !== 1)
          throw new Error(
            'A workflow step did not produce exactly one operation.',
          );
        const created = added[0];
        outputs.set(step.id, created.outputIds);
        stepMap[step.id] = created.id;
        const index = new WorkflowIndex(this.project);
        // `{input}` names the signal chosen (never a hidden segment crop),
        // or the value calculated from; `{segment}` the segment an output
        // was made within.
        const names = outputLabels(
          step,
          created.outputIds.length,
          itemId,
          (position) => outputInputLabel(index, created.outputIds[position]),
          (position) => outputSegmentLabel(index, created.outputIds[position]),
        );
        const tagged: WorkflowStep = {
          ...created,
          runId,
          recipeStepId: step.id,
          ...(step.name ? { name: step.name } : {}),
          ...(step.checks?.length
            ? { checks: structuredClone(step.checks) }
            : {}),
        };
        const labels = { ...this.project.labels };
        names.forEach((name, position) => {
          if (name) labels[created.outputIds[position]] = name;
        });
        await this.save({
          ...this.project,
          labels,
          workflowSteps: this.project.workflowSteps!.map((item) =>
            item.id === created.id ? tagged : item,
          ),
        });
        // Evaluate every signal once: checks use the exact statistics, and a
        // recipe that cannot evaluate is reported now rather than on first plot.
        const statistics = new Map<string, OutputStatistics>();
        try {
          for (const id of created.outputIds.slice(0, 1000))
            if (index.nodes.has(id)) {
              const stats = await this.outputStatistics(id);
              statistics.set(id, stats);
              if (!stats.finite)
                flags.push({
                  severity: 'warning',
                  recipeStepId: step.id,
                  message: `${labels[id] ?? index.label(id)} has no finite samples.`,
                });
            }
        } catch (error) {
          if (this.cancelled) throw error;
          flags.push({
            severity: 'error',
            recipeStepId: step.id,
            message: `“${label(step)}” could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
        }
        if (tagged.checks) {
          await this.save(await this.withCheckResults(tagged, statistics));
          const results =
            this.project.workflowSteps!.find((item) => item.id === created.id)
              ?.checkResults?.results ?? [];
          if (
            step.onFail === 'stop' &&
            results.some((result) => result.status === 'fail')
          )
            stoppedAt = step.id;
        }
      }
      // One flag per root cause rather than one per dependent step.
      for (const [root, skipped] of skippedBy) {
        const channel = recipe.channels.find((item) => item.alias === root);
        const step = recipe.steps.find((item) => item.id === root);
        flags.push({
          severity: 'error',
          recipeStepId: step?.id,
          message: `Skipped ${skipped.length} ${skipped.length === 1 ? 'step' : 'steps'} that need “${channel?.name ?? (step ? label(step) : root)}”: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}.`,
        });
      }
      if (stoppedAt) {
        const remaining =
          recipe.steps.length -
          1 -
          recipe.steps.findIndex((step) => step.id === stoppedAt);
        if (remaining > 0)
          flags.push({
            severity: 'warning',
            recipeStepId: stoppedAt,
            message: `Stopped after a failed check in “${label(recipe.steps.find((step) => step.id === stoppedAt)!)}”; ${remaining} later ${remaining === 1 ? 'step was' : 'steps were'} skipped.`,
          });
      }
      const steps = new Map(
        this.project.workflowSteps!.map((step) => [step.id, step]),
      );
      run = {
        id: runId,
        batchId: options.batchId,
        itemId,
        fileName: options.file?.name ?? source.name,
        sourceId: source.id,
        status: runStatus(
          flags,
          Object.values(stepMap).map((id) => steps.get(id)),
        ),
        steps: stepMap,
        flags,
        ...(Object.keys(channelMap).length ? { channelMap } : {}),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      const batches = this.project.workflowBatches ?? [];
      const existing = batches.find((batch) => batch.id === options.batchId);
      if (existing && existing.recipeHash !== hash)
        throw new Error(
          'Every item in a batch must use the same workflow revision.',
        );
      next = {
        ...this.project,
        workflowRecipes: [
          ...(this.project.workflowRecipes ?? []).filter(
            (item) => item.hash !== hash,
          ),
          {
            hash,
            name: recipe.name,
            ...(recipe.revision ? { revision: recipe.revision } : {}),
            text: options.recipe,
          },
        ],
        workflowBatches: existing
          ? batches.map((batch) =>
              batch.id === existing.id
                ? { ...batch, runs: [...batch.runs, run] }
                : batch,
            )
          : [
              ...batches,
              {
                id: options.batchId,
                name: options.batchName.trim().slice(0, 160) || recipe.name,
                recipeHash: hash,
                createdAt: startedAt,
                state: 'running',
                runs: [run],
              },
            ],
      };
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    try {
      await this.save(next, undefined, options.batchId);
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    }
    if (imported) await this.trackImport(imported.id, false).catch(() => {});
    return run;
  }
  /** Mark a batch complete or cancelled, within the batch's Undo entry. */
  async finishBatch(
    batchId: string,
    state: 'complete' | 'cancelled',
    failures: { name: string; message: string }[] = [],
  ) {
    const batch = this.project.workflowBatches?.find(
      (item) => item.id === batchId,
    );
    if (!batch || (batch.state === state && !failures.length)) return;
    const recorded = failures.slice(0, 500).map((failure) => ({
      name: String(failure.name).slice(0, 255),
      message: String(failure.message).slice(0, 500),
    }));
    await this.save(
      {
        ...this.project,
        workflowBatches: this.project.workflowBatches!.map((item) =>
          item.id === batchId
            ? {
                ...item,
                state,
                ...(recorded.length
                  ? { failures: [...(item.failures ?? []), ...recorded] }
                  : {}),
              }
            : item,
        ),
      },
      undefined,
      batchId,
    );
  }
  async workflowExample(refresh = false, sourceId?: string) {
    const existing = sourceId
      ? this.project.sources.find((source) => source.id === sourceId)
      : (this.project.sources.find(
          (source) => source.exampleKey === WORKFLOW_EXAMPLE,
        ) ?? this.project.sources.find((source) => source.synthetic));
    if ((sourceId && !existing) || (existing && !existing.synthetic))
      throw new Error('Only a built-in example can be refreshed.');
    if (!refresh && existing?.exampleKey === WORKFLOW_EXAMPLE) return existing;
    const before = this.project;
    let imported: Source | undefined;
    let next: Project;
    this.staging = true;
    try {
      await this.initializeWorkflow();
      // Opening an example never replaces saved work. Replacement is explicit.
      if (refresh && existing)
        await this.deleteOperation(`import:${existing.id}`);
      imported = await this.importCsv(workflowExampleFile(), true);
      const source = { ...imported, exampleKey: WORKFLOW_EXAMPLE };
      await this.save({
        ...this.project,
        sources: [
          source,
          ...this.project.sources.filter((item) => item.id !== source.id),
        ],
      });
      await buildExampleWorkflow(this, source);
      next = this.project;
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    try {
      await this.save(
        next,
        undefined,
        undefined,
        refresh && existing
          ? 'Refresh example recording'
          : 'Open example recording',
      );
    } catch (error) {
      await this.removeIncomplete(imported.id);
      await this.trackImport(imported.id, false);
      throw error;
    }
    await this.trackImport(imported.id, false).catch(() => {});
    return this.project.sources.find((source) => source.id === imported.id)!;
  }
}
