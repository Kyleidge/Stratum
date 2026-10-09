import type { WorkflowStep } from './workflow-types';
import { stepName, WorkflowIndex } from './workflow-history';

export type WorkflowRow = {
  key: string;
  /** `single` is one row for a step that made exactly one output. */
  kind: 'step' | 'output' | 'single' | 'more';
  step: WorkflowStep;
  outputId?: string;
  label: string;
  /** For `single` rows: the step's name, when it differs from the output's. */
  stepLabel?: string;
};

/**
 * Two levels with bounded previews, or every member of one focused operation.
 * A step with exactly one output is a single row that stands for both.
 */
export function workflowRows(
  steps: WorkflowStep[],
  index: WorkflowIndex,
  collapsed: ReadonlySet<string>,
  query = '',
  selectedOutput?: string,
  contributingOutputs?: ReadonlySet<string>,
  focusedStepId?: string,
  outputKind: 'all' | 'signals' | 'values' = 'all',
): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  const search = query.trim().toLowerCase();
  for (const step of steps) {
    if (focusedStepId && step.id !== focusedStepId) continue;
    const label = stepName(step);
    const matchesStep =
      `#${String(step.sequence + 1).padStart(3, '0')} ${step.sequence + 1} ${label}`
        .toLowerCase()
        .includes(search);
    const candidates = step.outputIds.filter(
      (id) =>
        (!contributingOutputs || contributingOutputs.has(id)) &&
        (outputKind === 'all' ||
          (outputKind === 'values'
            ? index.values.has(id)
            : index.nodes.has(id))),
    );
    // Type filters show only steps that produced a matching output.
    if (outputKind !== 'all' && !candidates.length) continue;
    const outputs =
      search && !matchesStep
        ? candidates.filter((id) =>
            `${index.label(id)} ${index.kind(id)} ${index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? ''}`
              .toLowerCase()
              .includes(search),
          )
        : candidates;
    if (search && !matchesStep && !outputs.length) continue;
    // A Segment step is one row: its segments are chosen on the plot, not
    // listed, however many there are.
    if (step.segmentSetId) {
      rows.push({ key: step.id, kind: 'step', step, label });
      continue;
    }
    if (!focusedStepId && step.outputIds.length === 1 && outputs.length) {
      const id = outputs[0];
      const output = index.label(id);
      rows.push({
        key: `output:${id}`,
        kind: 'single',
        step,
        outputId: id,
        label: output,
        stepLabel:
          label.trim().toLowerCase() === output.trim().toLowerCase()
            ? undefined
            : label,
      });
      continue;
    }
    rows.push({ key: step.id, kind: 'step', step, label });
    if (!search && collapsed.has(step.id)) continue;
    const shown = focusedStepId ? [...outputs] : outputs.slice(0, 3);
    // A selected output is always revealed, including a member beyond the preview.
    if (
      selectedOutput &&
      outputs.includes(selectedOutput) &&
      !shown.includes(selectedOutput)
    )
      shown.push(selectedOutput);
    for (const id of shown)
      rows.push({
        key: `output:${id}`,
        kind: 'output',
        step,
        outputId: id,
        label: index.label(id),
      });
    if (outputs.length > shown.length)
      rows.push({
        key: `more:${step.id}`,
        kind: 'more',
        step,
        label: `View all ${outputs.length} outputs`,
      });
  }
  return rows;
}
