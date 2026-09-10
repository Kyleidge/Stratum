import type { WorkflowStep } from './workflow-types';
import { stepName, WorkflowIndex } from './workflow-history';

export type WorkflowRow = {
  key: string;
  kind: 'step' | 'output' | 'more';
  step: WorkflowStep;
  outputId?: string;
  label: string;
};

/** A bounded two-level tree; depth of the dependency graph cannot bury outputs. */
export function workflowRows(
  steps: WorkflowStep[],
  index: WorkflowIndex,
  collapsed: ReadonlySet<string>,
  query = '',
  selectedOutput?: string,
): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  const search = query.trim().toLowerCase();
  for (const step of steps) {
    const label = stepName(step);
    const matchesStep =
      `#${String(step.sequence + 1).padStart(3, '0')} ${step.sequence + 1} ${label}`
        .toLowerCase()
        .includes(search);
    const outputs =
      search && !matchesStep
        ? step.outputIds.filter((id) =>
            `${index.label(id)} ${index.kind(id)} ${index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? ''}`
              .toLowerCase()
              .includes(search),
          )
        : step.outputIds;
    if (search && !matchesStep && !outputs.length) continue;
    rows.push({ key: step.id, kind: 'step', step, label });
    if (!search && collapsed.has(step.id)) continue;
    const shown = outputs.slice(0, 3);
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
