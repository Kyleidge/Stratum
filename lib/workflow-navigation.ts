import { formatCount } from './format-count';
import type { Project } from './signal-types';
import type { WorkflowTarget } from './workflow-drag';
import { runForSource } from './workflow-batch';
import { currentResults, stepStatus } from './workflow-checks';
import { stepName, type WorkflowIndex } from './workflow-history';
import { describeChange } from './workflow-lifecycle';
import type { WorkflowRun, WorkflowStep } from './workflow-types';

/**
 * History scope: everything (`all`), one batch's items (`batch:<id>`), or one
 * recording (with the workspace-scope outputs its batch item produced).
 * `source` is the recording in scope, else the first one; `scopeSource` the
 * recording a scoped batch's first item came from.
 */
export function historyScope(project: Project, sourceId: string) {
  const source =
    project.sources.find((item) => item.id === sourceId) ?? project.sources[0];
  const batches = project.workflowBatches ?? [];
  const scopeBatch = sourceId.startsWith('batch:')
    ? batches.find((batch) => `batch:${batch.id}` === sourceId)
    : undefined;
  const allScope =
    sourceId === 'all' || (sourceId.startsWith('batch:') && !scopeBatch);
  const itemRun =
    !scopeBatch && !allScope ? runForSource(project, source?.id) : undefined;
  const itemRunId = itemRun?.run.id;
  const all = project.workflowSteps ?? [];
  let steps = all;
  if (scopeBatch) {
    const runs = new Set(scopeBatch.runs.map((run) => run.id));
    steps = all.filter((step) => !!step.runId && runs.has(step.runId));
  } else if (!allScope)
    steps = all.filter(
      (step) =>
        step.sourceId === source?.id ||
        (!!itemRunId && step.runId === itemRunId),
    );
  const scopeSource = scopeBatch
    ? (project.sources.find(
        (item) => item.id === scopeBatch.runs[0]?.sourceId,
      ) ?? source)
    : source;
  return { source, batches, scopeBatch, allScope, itemRun, steps, scopeSource };
}

/**
 * Where the selection goes after Undo or Redo turned `before` into `after`:
 * it stays when it still exists, unless the change affected another step,
 * which is then selected (`target`) while it exists.
 */
export function travelSelection(
  before: Project,
  after: Project,
  direction: 'undo' | 'redo',
  chosen: WorkflowTarget | null,
): { target?: WorkflowStep; next: WorkflowTarget | null } {
  const change =
    direction === 'undo'
      ? describeChange(after, before)
      : describeChange(before, after);
  const steps = after.workflowSteps ?? [];
  const target = steps.find((item) => item.id === change?.stepId);
  const exists = (item: WorkflowTarget | null) =>
    !!item &&
    (item.kind === 'step'
      ? steps.some((candidate) => candidate.id === item.id)
      : steps.some((candidate) => candidate.outputIds.includes(item.id)));
  const kept = exists(chosen) ? chosen : null;
  const keptOwner =
    kept?.kind === 'step'
      ? kept.id
      : steps.find((item) => kept && item.outputIds.includes(kept.id))?.id;
  const next =
    kept && (!target || keptOwner === target.id)
      ? kept
      : target
        ? { kind: 'step' as const, id: target.id }
        : kept;
  return { target, next };
}

/**
 * The selection that opens a batch item: the output at `position` of the
 * step made by `recipeStepId`, else its first flagged output (or step), else
 * its last step.
 */
export function itemSelection(
  index: WorkflowIndex,
  run: WorkflowRun,
  recipeStepId?: string,
  position = 0,
): WorkflowTarget | undefined {
  const runSteps = Object.entries(run.steps).flatMap(([recipeId, id]) => {
    const item = index.steps.get(id);
    return item ? [[recipeId, item] as const] : [];
  });
  let target: WorkflowTarget | undefined;
  const kept = runSteps.find(([recipeId]) => recipeId === recipeStepId)?.[1];
  if (kept)
    target = kept.outputIds.length
      ? {
          kind: 'output',
          id: kept.outputIds[Math.min(position, kept.outputIds.length - 1)],
        }
      : { kind: 'step', id: kept.id };
  if (!target)
    for (const [, item] of runSteps) {
      const status = stepStatus(item);
      if (status && status !== 'pass') {
        const failing = currentResults(item).find(
          (result) => result.status !== 'pass' && result.outputId,
        );
        target = failing?.outputId
          ? { kind: 'output', id: failing.outputId }
          : { kind: 'step', id: item.id };
        break;
      }
    }
  const last = runSteps.at(-1)?.[1];
  if (!target && last) target = { kind: 'step', id: last.id };
  return target;
}

/**
 * One recipe step's signal outputs across batch items, labelled by item, to
 * plot together. Items whose step was skipped or produced nothing are named
 * in `note`, not hidden.
 */
export function itemsAcross(
  index: WorkflowIndex,
  recipeStepId: string,
  runs: WorkflowRun[],
): { title: string; traces: { id: string; label: string }[]; note?: string } {
  const traces = runs.flatMap((run) => {
    const item = index.steps.get(run.steps[recipeStepId] ?? '');
    return item
      ? item.outputIds
          .filter((id) => index.nodes.has(id))
          .map((id) => ({ id, label: `${run.itemId} · ${index.label(id)}` }))
      : [];
  });
  const first = runs
    .map((run) => index.steps.get(run.steps[recipeStepId] ?? ''))
    .find(Boolean);
  // Items whose step was skipped or produced nothing are named, not hidden.
  const missing = runs.filter(
    (run) =>
      !index.steps
        .get(run.steps[recipeStepId] ?? '')
        ?.outputIds.some((id) => index.nodes.has(id)),
  );
  const plotted = runs.length - missing.length;
  return {
    title: `${first ? stepName(first) : recipeStepId} · ${formatCount(plotted, 'item')}`,
    traces,
    note: missing.length
      ? `Plotted ${plotted} of ${formatCount(runs.length, 'item')}. ${missing
          .slice(0, 5)
          .map((run) => run.itemId)
          .join(
            ', ',
          )}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''} ${missing.length === 1 ? 'has' : 'have'} no output for this step, because it was skipped or failed.`
      : undefined,
  };
}
