import type { WorkflowIndex } from './workflow-history';

export type WorkflowTarget = { kind: 'step' | 'output'; id: string };
export const WORKFLOW_DRAG_TYPE = 'application/x-stratum-workflow';

export function readWorkflowDrag(
  raw: string,
  index: WorkflowIndex,
): WorkflowTarget | undefined {
  try {
    const item: unknown = JSON.parse(raw);
    if (!item || typeof item !== 'object') return;
    const target = item as Partial<WorkflowTarget>;
    if (typeof target.id !== 'string') return;
    if (target.kind === 'step' && index.steps.has(target.id))
      return { kind: 'step', id: target.id };
    if (
      target.kind === 'output' &&
      (index.nodes.has(target.id) || index.values.has(target.id))
    )
      return { kind: 'output', id: target.id };
  } catch {
    /* Foreign drags and stale workspace references are ignored. */
  }
}

export function targetOutputs(
  index: WorkflowIndex,
  target: WorkflowTarget,
): string[] {
  return target.kind === 'step'
    ? (index.steps.get(target.id)?.outputIds ?? [])
    : index.nodes.has(target.id) || index.values.has(target.id)
      ? [target.id]
      : [];
}

/** Processing a member stays scoped to that member; values expose their inputs. */
export function targetSignals(
  index: WorkflowIndex,
  target: WorkflowTarget,
): string[] {
  return [
    ...new Set(
      targetOutputs(index, target).flatMap((id) => {
        if (index.nodes.has(id)) return [id];
        const input = index.values.get(id)?.inputId;
        return input && index.nodes.has(input) ? [input] : [];
      }),
    ),
  ];
}

/** Plot segment siblings only from explicit operation membership, never labels. */
export function targetPlotOutputs(
  index: WorkflowIndex,
  target: WorkflowTarget,
): string[] {
  const owner =
    target.kind === 'output' ? index.owner.get(target.id) : undefined;
  const ids =
    owner && (owner.kind === 'segment' || owner.timeSettings?.kind === 'crop')
      ? owner.outputIds
      : targetOutputs(index, target);
  return ids.filter((id) => index.nodes.has(id) || index.values.has(id));
}

export function startWorkflowDrag(
  transfer: DataTransfer,
  target: WorkflowTarget,
  label: string,
) {
  transfer.effectAllowed = 'copy';
  transfer.setData(WORKFLOW_DRAG_TYPE, JSON.stringify(target));
  transfer.setData('text/plain', label);
}
