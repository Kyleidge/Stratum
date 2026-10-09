import type { SegmentSet } from './signal-types';
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
      (index.nodes.has(target.id) ||
        index.values.has(target.id) ||
        index.segments.has(target.id))
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
    : index.nodes.has(target.id) ||
        index.values.has(target.id) ||
        index.segments.has(target.id)
      ? [target.id]
      : [];
}

/**
 * The signals a segment is shown and processed with by default: its
 * triggers, its workspace reference, or its recording's original signals.
 */
export function segmentSignals(index: WorkflowIndex, id: string): string[] {
  const entry = index.segments.get(id);
  if (!entry) return [];
  const { definition, referenceId, sourceId } = entry.set;
  const ids =
    definition.method === 'triggers'
      ? [definition.start.signalId, definition.end.signalId]
      : referenceId
        ? [referenceId]
        : (index.project.sources.find((source) => source.id === sourceId)
            ?.channels ?? []);
  return [...new Set(ids)].filter((item) => index.nodes.has(item));
}

/**
 * Every visible signal a segment set's intervals apply to: those of its
 * recording, or for workspace sets those on its time reference, in workflow
 * order. Hidden segment crops are never offered.
 */
export function segmentSetSignals(
  index: WorkflowIndex,
  timeReferences: ReadonlyMap<string, { id: string }>,
  set: SegmentSet,
): string[] {
  return index.project.nodes
    .filter(
      (node) =>
        !node.internal &&
        node.sourceId === set.sourceId &&
        (set.sourceId !== '' ||
          timeReferences.get(node.id)?.id === set.timeReferenceId),
    )
    .map((node) => node.id);
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
        if (index.segments.has(id)) return segmentSignals(index, id);
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
    owner &&
    (owner.kind === 'segment' ||
      owner.timeSettings?.kind === 'crop' ||
      // Signals within segments come with their siblings, to compare runs.
      (!!owner.within && owner.kind === 'derive'))
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
