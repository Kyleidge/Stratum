'use client';

import { useState, type DragEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpLeft,
  ChevronRight,
  Download,
  FilePlus2,
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
  X,
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
import { formatCount } from '@/lib/format-count';
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
  | 'report'
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
  {
    id: 'align',
    label: 'Compare & align',
    short: 'Compare',
    Icon: ScanLine,
    hint: 'Compare and align signal time bases across recordings.',
  },
] as const;
const inspectionActions = [
  { id: 'samples', label: 'View samples', Icon: Table2 },
  { id: 'inputs', label: 'Inputs and original signals', Icon: ArrowUpLeft },
  { id: 'used-by', label: 'Used by later steps', Icon: History },
  { id: 'lineage', label: 'Show lineage in History', Icon: GitBranch },
  { id: 'owner', label: 'Open producing step', Icon: ListTree },
  { id: 'export', label: 'Export data…', Icon: Download },
  { id: 'report', label: 'Add to report', Icon: FilePlus2 },
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
  if (action === 'export' || action === 'report')
    return targetOutputs(index, target).length > 0;
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
  inputIds,
  checked,
  hasPast,
  busy,
  empty = false,
  onAction,
  onClearChecked,
  onDragEnd,
}: {
  selection: WorkflowTarget;
  dragged: WorkflowTarget | null;
  index: WorkflowIndex;
  /** Processing inputs: checked signals, or the viewed selection's signals. */
  inputIds: string[];
  checked: boolean;
  hasPast: boolean;
  busy: boolean;
  /** No recording is imported yet, so no operation can have inputs. */
  empty?: boolean;
  onAction: (action: ToolbarAction, dropped?: WorkflowTarget) => void;
  onClearChecked: () => void;
  onDragEnd: () => void;
}) {
  const inputCount = inputIds.length;
  // Viewing a value processes its input signal; say so rather than retarget
  // Apply to silently.
  const valueInput =
    !checked && selection.kind === 'output' && index.values.has(selection.id);
  const scopeName = checked
    ? `${inputCount.toLocaleString()} checked`
    : inputCount === 1
      ? index.label(inputIds[0])
      : inputCount
        ? formatCount(inputCount, 'signal')
        : 'No signals';
  const scopeLabel =
    valueInput && inputCount
      ? `${scopeName} (input of selected value)`
      : scopeName;
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
                  {empty
                    ? 'Import a recording first.'
                    : 'Drop a signal or batch to choose its inputs.'}
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
                  aria-label={`Apply to ${scopeLabel}`}
                  data-checked={checked}
                  data-note={valueInput && !!inputCount}
                  aria-disabled={!enabled('checked') && !accepts('checked')}
                  disabled={busy}
                  {...dropProps('checked')}
                  onClick={() => {
                    if (enabled('checked')) invoke('checked');
                  }}
                />
              }
            >
              <ListChecks size={14} />
              <span className="workflow-scope-label">Apply to</span>
              <strong>{scopeName}</strong>
              {valueInput && !!inputCount && (
                <span className="workflow-scope-note">(input of value)</span>
              )}
              <ChevronRight size={12} />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>
                Apply to: {scopeLabel}
                <br />
                {checked
                  ? 'Derive, Segment, Value and Compare use these checked signals. Review or change them.'
                  : valueInput
                    ? 'A value is selected, so processing uses the signal it was calculated from. Check signals in History to choose other inputs.'
                    : 'Processing follows what you view. Check signals in History or the Outputs table to choose other inputs.'}
              </span>
            </TooltipContent>
          </Tooltip>
          {checked && (
            <button
              type="button"
              className="workflow-scope-clear"
              aria-label="Clear checked inputs"
              title="Clear checked inputs and follow the selection"
              disabled={busy}
              onClick={onClearChecked}
            >
              <X size={13} />
            </button>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="workflow-more-action workflow-report-action"
                  aria-label="Add to report"
                  aria-disabled={!enabled('report') && !accepts('report')}
                  disabled={busy}
                  {...dropProps('report')}
                  onClick={() => {
                    if (enabled('report')) invoke('report');
                  }}
                />
              }
            >
              <FilePlus2 size={15} />
              <span>Add to report</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Add the viewed output or step to your report. You stay in Data.
              Drop a signal, value or step here to choose a different item.
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="workflow-more-action workflow-export-action"
                  aria-label="Export data…"
                  aria-disabled={!enabled('export') && !accepts('export')}
                  disabled={busy}
                  {...dropProps('export')}
                  onClick={() => {
                    if (enabled('export')) invoke('export');
                  }}
                />
              }
            >
              <Download size={15} />
              <span>Export data…</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Download values or samples as CSV, or a quick HTML summary.
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
                  className="workflow-more-action workflow-more-menu"
                  aria-label="More actions for the selection"
                  title="More actions for the selection"
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
              <MoreHorizontal size={16} />
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
                Right-click a History item to edit, rename, make a new version
                or delete it.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>
    </TooltipProvider>
  );
}
