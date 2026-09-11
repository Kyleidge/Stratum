'use client';

import { useState, type DragEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpLeft,
  ChevronRight,
  Download,
  GitBranch,
  History,
  ListChecks,
  ListTree,
  MoreHorizontal,
  ScanLine,
  Scissors,
  Table2,
  Waves,
  Hash,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
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
const creationActions = [
  {
    id: 'derive',
    label: 'Derive signal',
    short: 'Derive',
    Icon: Waves,
    hint: 'Create a signal with math, filters or calculus.',
  },
  {
    id: 'segment',
    label: 'Segment',
    short: 'Segment',
    Icon: Scissors,
    hint: 'Split signals by ranges, windows or triggers.',
  },
  {
    id: 'value',
    label: 'Calculate value',
    short: 'Value',
    Icon: Hash,
    hint: 'Calculate an average, minimum or maximum.',
  },
] as const;
const inspectionActions = [
  { id: 'samples', label: 'View samples', Icon: Table2 },
  { id: 'inputs', label: 'Inputs and originals', Icon: ArrowUpLeft },
  { id: 'used-by', label: 'Used by later operations', Icon: History },
  { id: 'lineage', label: 'Show lineage in tree', Icon: GitBranch },
  { id: 'owner', label: 'Open producing operation', Icon: ListTree },
  { id: 'export', label: 'Export / report', Icon: Download },
  { id: 'back', label: 'Back to previous selection', Icon: ArrowLeft },
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
  checked,
  hasPast,
  busy,
  onAction,
  onDragEnd,
}: {
  selection: WorkflowTarget;
  dragged: WorkflowTarget | null;
  index: WorkflowIndex;
  inputCount: number;
  checked: boolean;
  hasPast: boolean;
  busy: boolean;
  onAction: (action: ToolbarAction, dropped?: WorkflowTarget) => void;
  onDragEnd: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<WorkflowTarget>();
  const [hoverTarget, setHoverTarget] = useState<WorkflowTarget>();
  const subject = menuTarget ?? selection;
  const subjectStep =
    subject.kind === 'step' ? index.steps.get(subject.id) : undefined;
  const subjectLabel =
    subject.kind === 'step'
      ? subjectStep
        ? stepName(subjectStep)
        : 'Selection'
      : index.label(subject.id) || 'Selection';
  const accepts = (id: ToolbarAction) =>
    !busy && !!dragged && acceptsToolbarTarget(id, dragged, index);
  const enabled = (id: ToolbarAction) =>
    !busy &&
    (id === 'back'
      ? hasPast
      : id === 'checked'
        ? checked ||
          inputCount > 0 ||
          targetSignals(index, selection).length > 0
        : ['derive', 'segment', 'value', 'align'].includes(id)
          ? inputCount > 0
          : acceptsToolbarTarget(id, subject, index));
  function invoke(id: ToolbarAction, target = menuTarget) {
    setMoreOpen(false);
    setHoverTarget(undefined);
    setMenuTarget(undefined);
    onAction(id, target);
  }
  function dropProps(id: ToolbarAction) {
    return {
      'data-action': id,
      'data-drop': dragged ? (accepts(id) ? 'accept' : 'reject') : undefined,
      onDragOver(event: DragEvent<HTMLElement>) {
        if (
          accepts(id) &&
          event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const target = readWorkflowDrag(
          event.dataTransfer.getData(WORKFLOW_DRAG_TYPE),
          index,
        );
        if (!busy && target && acceptsToolbarTarget(id, target, index)) {
          event.preventDefault();
          event.stopPropagation();
          invoke(id, target);
        }
        onDragEnd();
      },
    };
  }
  return (
    <TooltipProvider delay={400}>
      <section className="workflow-action-toolbar" aria-label="Signal tools">
        <div className="workflow-create-actions">
          {creationActions.map(({ id, label, short, Icon, hint }) => (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="workflow-create-action"
                    aria-label={label}
                    aria-disabled={!enabled(id) && !accepts(id)}
                    disabled={busy}
                    {...dropProps(id)}
                    onClick={() => {
                      if (enabled(id)) invoke(id);
                    }}
                  />
                }
              >
                <Icon size={19} />
                <span>{short}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span>
                  {hint}
                  <br />
                  Drop a signal or batch to choose its inputs.
                </span>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="workflow-tool-utilities">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="workflow-input-scope"
                  aria-label="Review checked inputs"
                  data-checked={checked}
                  aria-disabled={!enabled('checked') && !accepts('checked')}
                  disabled={busy}
                  {...dropProps('checked')}
                  onClick={() => {
                    if (enabled('checked')) invoke('checked');
                  }}
                />
              }
            >
              <ListChecks size={15} />
              <span>
                {inputCount
                  ? `${inputCount} ${checked ? 'checked' : inputCount === 1 ? 'input' : 'inputs'}`
                  : 'Choose inputs'}
              </span>
              <ChevronRight size={12} />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {checked
                ? 'Review the checked signals used by creation tools.'
                : 'Review the inputs for the current selection.'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="workflow-utility-action"
                  aria-label="Compare & align"
                  aria-disabled={!enabled('align') && !accepts('align')}
                  disabled={busy}
                  {...dropProps('align')}
                  onClick={() => {
                    if (enabled('align')) invoke('align');
                  }}
                />
              }
            >
              <ScanLine size={15} />
              <span>Compare</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Compare and align signal time bases. Accepts signal and batch
              drops.
            </TooltipContent>
          </Tooltip>
          <DropdownMenu
            open={moreOpen || (!!dragged && hoverTarget === dragged)}
            modal={false}
            onOpenChange={(open) => {
              setMoreOpen(open);
              if (!open) {
                setMenuTarget(undefined);
                setHoverTarget(undefined);
              }
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="workflow-more-action"
                  aria-label="Inspect and export"
                  title="Inspect and export"
                  disabled={busy}
                  data-action="more"
                  data-drop={dragged && !busy ? 'accept' : undefined}
                  onDragOver={(event) => {
                    if (
                      !busy &&
                      dragged &&
                      event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      setHoverTarget(dragged);
                    }
                  }}
                  onDrop={(event) => {
                    const target = readWorkflowDrag(
                      event.dataTransfer.getData(WORKFLOW_DRAG_TYPE),
                      index,
                    );
                    if (!busy && target) {
                      event.preventDefault();
                      setMenuTarget(target);
                      setHoverTarget(undefined);
                      setMoreOpen(true);
                    }
                    onDragEnd();
                  }}
                />
              }
            >
              <MoreHorizontal size={19} />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="workflow-tools-menu" align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel
                  className="workflow-menu-subject"
                  title={subjectLabel}
                >
                  {subjectLabel}
                </DropdownMenuLabel>
                {inspectionActions.map(({ id, label, Icon }) => (
                  <DropdownMenuItem
                    key={id}
                    disabled={!enabled(id) && !accepts(id)}
                    {...dropProps(id)}
                    onClick={() => invoke(id)}
                  >
                    <Icon />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <p className="workflow-menu-hint">
                Right-click a History item to edit, rename, duplicate or delete.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>
    </TooltipProvider>
  );
}
