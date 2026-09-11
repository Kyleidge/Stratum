'use client';

import {
  ArrowLeft,
  ArrowUpLeft,
  CheckCheck,
  Copy,
  Download,
  FolderPen,
  GitBranch,
  History,
  ListChecks,
  ListTree,
  Table2,
  Pencil,
  ScanLine,
  Scissors,
  Trash2,
  Type,
  Waves,
  Hash,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { WorkflowIndex } from '@/lib/workflow-history';
import {
  readWorkflowDrag,
  targetSignals,
  targetOutputs,
  WORKFLOW_DRAG_TYPE,
  type WorkflowTarget,
} from '@/lib/workflow-drag';

export type ToolbarAction =
  | 'samples'
  | 'back'
  | 'inputs'
  | 'lineage'
  | 'used-by'
  | 'checked'
  | 'use-viewed'
  | 'derive'
  | 'segment'
  | 'value'
  | 'align'
  | 'edit'
  | 'duplicate'
  | 'rename'
  | 'rename-recording'
  | 'delete'
  | 'export'
  | 'owner';
const actions = [
  { id: 'derive', label: 'Derive signal', Icon: Waves },
  { id: 'segment', label: 'Segment', Icon: Scissors },
  { id: 'value', label: 'Calculate value', Icon: Hash },
  { id: 'align', label: 'Compare & align', Icon: ScanLine },
  { id: 'samples', label: 'View samples', Icon: Table2 },
  { id: 'export', label: 'Export / report', Icon: Download },
  { id: 'checked', label: 'Review checked inputs', Icon: ListChecks },
  { id: 'use-viewed', label: 'Use only this signal', Icon: CheckCheck },
  { id: 'back', label: 'Back to previous selection', Icon: ArrowLeft },
  { id: 'inputs', label: 'Inputs and originals', Icon: ArrowUpLeft },
  { id: 'lineage', label: 'Show lineage in tree', Icon: GitBranch },
  { id: 'used-by', label: 'Used by later operations', Icon: History },
  { id: 'owner', label: 'Open producing operation', Icon: ListTree },
  { id: 'edit', label: 'Edit settings', Icon: Pencil },
  { id: 'duplicate', label: 'Duplicate operation', Icon: Copy },
  { id: 'rename', label: 'Rename output', Icon: Type },
  { id: 'rename-recording', label: 'Rename recording', Icon: FolderPen },
  { id: 'delete', label: 'Delete operation', Icon: Trash2 },
] as const;

export function acceptsToolbarTarget(
  action: ToolbarAction,
  target: WorkflowTarget,
  index: WorkflowIndex,
): boolean {
  const step =
    target.kind === 'step'
      ? index.steps.get(target.id)
      : index.owner.get(target.id);
  if (
    ['derive', 'segment', 'value', 'align', 'use-viewed', 'checked'].includes(
      action,
    )
  )
    return targetSignals(index, target).length > 0;
  if (action === 'samples') return targetSignals(index, target).length === 1;
  if (action === 'export') return targetOutputs(index, target).length > 0;
  if (action === 'edit')
    return !!step && !['import', 'regions'].includes(step.kind);
  if (action === 'duplicate') return !!step && step.kind !== 'import';
  if (action === 'rename-recording') return !!step?.sourceId;
  if (action === 'back') return false;
  return !!step;
}

export default function WorkflowToolbar({
  selection,
  dragged,
  index,
  inputCount,
  hasPast,
  busy,
  onAction,
  onDragEnd,
}: {
  selection: WorkflowTarget;
  dragged: WorkflowTarget | null;
  index: WorkflowIndex;
  inputCount: number;
  hasPast: boolean;
  busy: boolean;
  onAction: (action: ToolbarAction, dropped?: WorkflowTarget) => void;
  onDragEnd: () => void;
}) {
  const step =
    selection.kind === 'step'
      ? index.steps.get(selection.id)
      : index.owner.get(selection.id);
  return (
    <TooltipProvider delay={350}>
      <div className="workflow-action-toolbar" aria-label="Workflow actions">
        {actions.map(({ id, label: defaultLabel, Icon }) => {
          const label =
            id === 'rename' && selection.kind === 'step'
              ? 'Rename operation'
              : id === 'delete' && step?.kind === 'import'
                ? 'Remove recording'
                : id === 'use-viewed' && selection.kind === 'step'
                  ? 'Use this operation’s signals'
                  : id === 'use-viewed' && index.values.has(selection.id)
                    ? 'Use this value’s input'
                    : defaultLabel;
          const acceptsDrop =
            dragged && acceptsToolbarTarget(id, dragged, index);
          const enabled =
            !busy &&
            (id === 'back'
              ? hasPast
              : id === 'checked'
                ? inputCount > 0
                : ['derive', 'segment', 'value', 'align'].includes(id)
                  ? inputCount > 0 || acceptsToolbarTarget(id, selection, index)
                  : acceptsToolbarTarget(id, selection, index));
          return (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="workflow-action-icon"
                    aria-label={label}
                    aria-disabled={!enabled && !acceptsDrop}
                    disabled={busy}
                    data-action={id}
                    data-drop={
                      dragged ? (acceptsDrop ? 'accept' : 'reject') : undefined
                    }
                    onClick={() => {
                      if (enabled) onAction(id);
                    }}
                    onDragOver={(event) => {
                      if (
                        !busy &&
                        acceptsDrop &&
                        event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)
                      ) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'copy';
                      }
                    }}
                    onDrop={(event) => {
                      const target = readWorkflowDrag(
                        event.dataTransfer.getData(WORKFLOW_DRAG_TYPE),
                        index,
                      );
                      if (
                        !busy &&
                        target &&
                        acceptsToolbarTarget(id, target, index)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        onAction(id, target);
                      }
                      onDragEnd();
                    }}
                  />
                }
              >
                <Icon size={16} />
                <span className="sr-only">{label}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {label}
                {['derive', 'segment', 'value', 'align'].includes(id)
                  ? ' · drop a signal, segment or value input'
                  : ''}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
