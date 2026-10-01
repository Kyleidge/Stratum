import type { WorkflowStep } from './workflow-types';
import { stepName, WorkflowIndex } from './workflow-history';

export type WorkflowRow = {
  key: string;
  kind: 'step' | 'output' | 'more';
  step: WorkflowStep;
  outputId?: string;
  label: string;
};

/** Two levels with bounded previews, or every member of one focused operation. */
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
          (outputKind === 'values') === index.values.has(id)),
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
