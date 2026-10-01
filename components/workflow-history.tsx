'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  ListChecks,
  ArrowUpLeft,
  Table2,
  Hash,
  LockKeyhole,
  Pencil,
  Scissors,
  Trash2,
  Waves,
} from 'lucide-react';
import { workflowRows } from '@/lib/workflow-tree';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import type { WorkflowManagementAction } from './workflow-management';
import {
  startWorkflowDrag,
  targetPlotOutputs,
  targetSignals,
} from '@/lib/workflow-drag';

export type WorkflowSelection = { kind: 'step' | 'output'; id: string };
type OutputView = {
  stepId: string;
  selectionKey: string;
  previousScroll: number;
  previousFocus: string;
};
const ROW_HEIGHT = 28;

export default function WorkflowHistory({
  steps,
  index,
  query,
  selection,
  onSelect,
  busy,
  onAction,
  contributingOutputs,
  outputKind = 'all',
  lineageOutputs,
  onDragSelection,
  onInspect,
  onCreatePlot,
}: {
  steps: WorkflowStep[];
  index: WorkflowIndex;
  query: string;
  selection: WorkflowSelection;
  onSelect: (selection: WorkflowSelection) => void;
  busy: boolean;
  onAction: (
    selection: WorkflowSelection,
    action: WorkflowManagementAction,
  ) => void;
  onInspect?: (
    target: WorkflowSelection,
    action: 'samples' | 'inputs' | 'export' | 'report' | 'use-viewed',
  ) => void;
  onCreatePlot?: (target: WorkflowSelection) => void;
  contributingOutputs?: ReadonlySet<string>;
  /** Show only signal or value outputs, and the steps that produced them. */
  outputKind?: 'all' | 'signals' | 'values';
  /** Outputs that contribute to the current selection, marked in the tree. */
  lineageOutputs?: ReadonlySet<string>;
  onDragSelection?: (selection: WorkflowSelection | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [outputView, setOutputView] = useState<OutputView | null>(null);
  const [outputsCollapsed, setOutputsCollapsed] = useState(false);
  const focusedStepId = outputView?.stepId;
  const selectedKey =
    selection.kind === 'step' ? selection.id : `output:${selection.id}`;
  const selectedOwner =
    selection.kind === 'output' ? index.owner.get(selection.id)?.id : undefined;
  // Following an input or revealing another operation leaves the focused tree.
  if (
    outputView &&
    (outputView.selectionKey !== selectedKey ||
      !steps.some((step) => step.id === outputView.stepId))
  ) {
    setOutputView(
      steps.some((step) => step.id === outputView.stepId) &&
        (selectedOwner ?? selection.id) === outputView.stepId
        ? { ...outputView, selectionKey: selectedKey }
        : null,
    );
  }
  const effectiveCollapsed = useMemo(() => {
    const next = focusedStepId
      ? new Set(outputsCollapsed ? [focusedStepId] : [])
      : new Set(collapsed);
    if (selectedOwner) next.delete(selectedOwner);
    return next;
  }, [collapsed, selectedOwner, focusedStepId, outputsCollapsed]);
  const rows = useMemo(
    () =>
      workflowRows(
        steps,
        index,
        effectiveCollapsed,
        query,
        selection.kind === 'output' ? selection.id : undefined,
        contributingOutputs,
        focusedStepId,
        outputKind,
      ),
    [
      steps,
      index,
      effectiveCollapsed,
      query,
      selection,
      contributingOutputs,
      focusedStepId,
      outputKind,
    ],
  );
  const container = useRef<HTMLDivElement>(null);
  const positions = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.kind === 'step' ? 'root' : row.step.id;
      const group = groups.get(key) ?? [];
      group.push(row.key);
      groups.set(key, group);
    }
    const result = new Map<string, { position: number; size: number }>();
    for (const group of groups.values())
      group.forEach((key, position) =>
        result.set(key, { position: position + 1, size: group.length }),
      );
    return result;
  }, [rows]);
  const pendingFocus = useRef<number | null>(null);
  const pendingNavigation = useRef<{
    scroll: number;
    key: string;
    fallback: string;
  } | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [focused, setFocused] = useState('');
  const selectedRow = rows.findIndex((row) => row.key === selectedKey);
  const tabKey = rows.some((row) => row.key === focused)
    ? focused
    : selectedRow >= 0
      ? selectedKey
      : rows[0]?.key;
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const element = container.current?.querySelector<HTMLElement>(
      `[data-row="${pendingFocus.current}"]`,
    );
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (pendingNavigation.current || selectedRow < 0 || !container.current)
      return;
    const element = container.current;
    const top = selectedRow * ROW_HEIGHT;
    if (
      top < element.scrollTop ||
      top + ROW_HEIGHT > element.scrollTop + element.clientHeight
    )
      element.scrollTop = Math.max(0, top - element.clientHeight / 3);
  }, [selectedRow, selectedKey]);
  useLayoutEffect(() => {
    const navigation = pendingNavigation.current;
    if (navigation && container.current) {
      pendingNavigation.current = null;
      container.current.scrollTop = navigation.scroll;
      const target = rows.findIndex((row) => row.key === navigation.key);
      const position =
        target >= 0
          ? target
          : rows.findIndex((row) => row.key === navigation.fallback);
      container.current
        .querySelector<HTMLElement>(`[data-row="${position}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [rows]);
  function showOutputs(stepId: string) {
    setOutputView({
      stepId,
      selectionKey: selectedKey,
      previousScroll: container.current?.scrollTop ?? scroll,
      previousFocus: `more:${stepId}`,
    });
    setOutputsCollapsed(false);
    pendingFocus.current = null;
    pendingNavigation.current = { scroll: 0, key: stepId, fallback: stepId };
    setScroll(0);
    setFocused(stepId);
  }
  function returnToHistory() {
    if (!outputView) return;
    pendingFocus.current = null;
    pendingNavigation.current = {
      scroll: outputView.previousScroll,
      key: outputView.previousFocus,
      fallback: outputView.stepId,
    };
    setScroll(outputView.previousScroll);
    setFocused(outputView.previousFocus);
    setOutputView(null);
  }
  function setExpanded(id: string, expanded: boolean) {
    if (!expanded && selectedOwner === id) onSelect({ kind: 'step', id });
    if (focusedStepId) {
      setOutputsCollapsed(!expanded);
      return;
    }
    setCollapsed((old) => {
      const next = new Set(old);
      if (expanded) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function focusRow(rowIndex: number) {
    const position = Math.max(0, Math.min(rows.length - 1, rowIndex));
    const row = rows[position];
    if (!row || !container.current) return;
    pendingFocus.current = position;
    setFocused(row.key);
    const element = container.current;
    const top = position * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    setScroll(element.scrollTop);
  }
  const start = Math.max(
    0,
    Math.min(
      Math.floor(scroll / ROW_HEIGHT) - 5,
      rows.length - Math.ceil(height / ROW_HEIGHT),
    ),
  );
  const visible = rows.slice(
    start,
    start + Math.ceil(height / ROW_HEIGHT) + 12,
  );
  return (
    <div className="workflow-history-pane">
      <div className="workflow-tree-controls">
        {focusedStepId ? (
          <button className="workflow-tree-back" onClick={returnToHistory}>
            <ArrowLeft size={14} /> Back to history
          </button>
        ) : (
          <>
            <button
              onClick={() =>
                setCollapsed(new Set(steps.map((step) => step.id)))
              }
            >
              Compact history
            </button>
            <button onClick={() => setCollapsed(new Set())}>
              Show outputs
            </button>
          </>
        )}
      </div>
      <div
        className="workflow-tree"
        ref={container}
        role="tree"
        aria-label={
          focusedStepId
            ? 'Operation outputs'
            : 'Chronological operation history'
        }
        onKeyDown={(event) => {
          if (focusedStepId && event.key === 'Escape') {
            event.preventDefault();
            returnToHistory();
          }
        }}
        tabIndex={visible.some((row) => row.key === tabKey) ? -1 : 0}
        onFocus={(event) => {
          if (event.target === container.current && rows.length)
            focusRow(selectedRow >= 0 ? selectedRow : start);
        }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {!rows.length && (
          <p className="workflow-empty">
            {steps.length
              ? 'No matching steps. Clear the search or lineage filter.'
              : 'No operations in this scope.'}
          </p>
        )}
        <div
          role="presentation"
          style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}
        >
          {visible.map((row, offset) => {
            const position = start + offset;
            const step = row.step;
            const inputSteps =
              row.kind === 'step'
                ? [
                    ...new Set(
                      step.inputIds.flatMap((id) => {
                        const owner = index.owner.get(id);
                        return owner
                          ? [`#${String(owner.sequence + 1).padStart(3, '0')}`]
                          : [];
                      }),
                    ),
                  ]
                : [];
            const expanded = !effectiveCollapsed.has(step.id) || !!query;
            const Icon =
              row.kind === 'output'
                ? index.values.has(row.outputId!)
                  ? Hash
                  : index.nodes.get(row.outputId!)?.operation === 'raw'
                    ? LockKeyhole
                    : Waves
                : step.kind === 'value'
                  ? Hash
                  : step.kind === 'segment' || step.kind === 'regions'
                    ? Scissors
                    : step.kind === 'import'
                      ? LockKeyhole
                      : Waves;
            const target: WorkflowSelection =
              row.kind === 'output'
                ? { kind: 'output', id: row.outputId! }
                : { kind: 'step', id: step.id };
            const select = () =>
              row.kind === 'more' ? showOutputs(step.id) : onSelect(target);
            const action = (action: WorkflowManagementAction) =>
              onAction(target, action);
            const item = (
              <div
                key={row.key}
                role="treeitem"
                aria-level={row.kind === 'step' ? 1 : 2}
                aria-posinset={positions.get(row.key)?.position}
                aria-setsize={positions.get(row.key)?.size}
                aria-expanded={
                  row.kind === 'step' && step.outputIds.length > 0
                    ? expanded
                    : undefined
                }
                aria-selected={row.key === selectedKey}
                tabIndex={row.key === tabKey ? 0 : -1}
                data-row={position}
                data-kind={row.kind}
                data-step-kind={step.kind === 'regions' ? 'segment' : step.kind}
                data-selected={row.key === selectedKey}
                data-lineage={
                  !!lineageOutputs &&
                  (row.kind === 'output'
                    ? lineageOutputs.has(row.outputId!)
                    : step.outputIds.some((id) => lineageOutputs.has(id)))
                }
                className="workflow-tree-row"
                draggable={row.kind !== 'more' && !busy}
                onDragStart={(event) => {
                  if (
                    row.kind === 'more' ||
                    (event.target as HTMLElement).closest('button')
                  ) {
                    event.preventDefault();
                    return;
                  }
                  startWorkflowDrag(event.dataTransfer, target, row.label);
                  onDragSelection?.(target);
                }}
                onDragEnd={() => onDragSelection?.(null)}
                title={row.label}
                aria-label={
                  row.kind === 'step'
                    ? `${row.label} · ${step.outputIds.length} outputs${inputSteps.length ? ` · from ${inputSteps.slice(0, 3).join(', ')}${inputSteps.length > 3 ? ' and more' : ''}` : ''}`
                    : row.outputId
                      ? `${row.label} · ${index.kind(row.outputId)} · ${index.nodes.get(row.outputId)?.unit ?? index.values.get(row.outputId)?.unit ?? ''}`
                      : row.label
                }
                style={{
                  position: 'absolute',
                  top: position * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                }}
                onFocus={() => setFocused(row.key)}
                onClick={select}
                onDoubleClick={(event) => {
                  if (
                    row.kind === 'more' ||
                    (event.target as HTMLElement).closest('button')
                  )
                    return;
                  action('edit');
                }}
                onKeyDown={(event) => {
                  if (
                    row.kind !== 'more' &&
                    (event.key === 'ContextMenu' ||
                      (event.shiftKey && event.key === 'F10'))
                  ) {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    event.currentTarget.dispatchEvent(
                      new MouseEvent('contextmenu', {
                        bubbles: true,
                        cancelable: true,
                        clientX: bounds.left + 24,
                        clientY: bounds.top + bounds.height / 2,
                        button: 2,
                      }),
                    );
                  } else if (row.kind !== 'more' && event.key === 'F2') {
                    event.preventDefault();
                    action('rename');
                  } else if (
                    event.key === 'ArrowDown' ||
                    event.key === 'ArrowUp'
                  ) {
                    event.preventDefault();
                    focusRow(position + (event.key === 'ArrowDown' ? 1 : -1));
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    focusRow(event.key === 'Home' ? 0 : rows.length - 1);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    if (row.kind === 'step' && !expanded)
                      setExpanded(step.id, true);
                    else if (row.kind === 'step' && step.outputIds.length)
                      focusRow(position + 1);
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    if (row.kind === 'step' && expanded)
                      setExpanded(step.id, false);
                    else
                      focusRow(rows.findIndex((item) => item.key === step.id));
                  } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select();
                  }
                }}
              >
                {row.kind === 'step' ? (
                  <button
                    tabIndex={-1}
                    className="workflow-disclosure"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} step ${step.sequence + 1}`}
                    disabled={!step.outputIds.length}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded(step.id, !expanded);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {expanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                ) : (
                  <span className="workflow-branch" aria-hidden="true" />
                )}
                {row.kind === 'more' ? (
                  <span className="workflow-more">{row.label} →</span>
                ) : (
                  <>
                    {row.kind === 'step' ? (
                      <code className="workflow-step-node">
                        <Icon size={11} />#
                        {String(step.sequence + 1).padStart(3, '0')}
                      </code>
                    ) : (
                      <Icon
                        size={14}
                        className={`workflow-icon ${index.values.has(row.outputId!) ? 'value' : index.nodes.get(row.outputId!)?.operation === 'raw' ? 'import' : 'derive'}`}
                      />
                    )}
                    <span className="workflow-row-copy">
                      <strong>{row.label}</strong>
                      <small>
                        {row.kind === 'step'
                          ? `${(step.revision ?? 1) > 1 ? `v${step.revision} · ` : ''}${contributingOutputs ? step.outputIds.filter((id) => contributingOutputs.has(id)).length : step.outputIds.length}`
                          : (index.nodes.get(row.outputId!)?.unit ??
                            index.values.get(row.outputId!)?.unit ??
                            '')}
                      </small>
                    </span>
                  </>
                )}
              </div>
            );
            if (row.kind === 'more') return item;
            return (
              <ContextMenu key={row.key}>
                <ContextMenuTrigger render={item} />
                <ContextMenuContent aria-label={`Actions for ${row.label}`}>
                  {onCreatePlot && (
                    <ContextMenuItem
                      disabled={
                        busy || !targetPlotOutputs(index, target).length
                      }
                      onClick={() => onCreatePlot(target)}
                    >
                      <ChartNoAxesCombined /> Create plot
                    </ContextMenuItem>
                  )}
                  {onInspect && (
                    <>
                      <ContextMenuItem
                        disabled={
                          busy || targetSignals(index, target).length !== 1
                        }
                        onClick={() => onInspect(target, 'samples')}
                      >
                        <Table2 /> View samples
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={busy}
                        onClick={() => onInspect(target, 'inputs')}
                      >
                        <ArrowUpLeft /> Inputs and originals
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={busy || !targetSignals(index, target).length}
                        onClick={() => onInspect(target, 'use-viewed')}
                      >
                        <ListChecks /> Use as processing inputs
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={busy || !step.outputIds.length}
                        onClick={() => onInspect(target, 'export')}
                      >
                        <Download /> Export / report
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={busy || !step.outputIds.length}
                        onClick={() => onInspect(target, 'report')}
                      >
                        <FilePlus2 /> Add to report
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {!['import', 'regions'].includes(step.kind) && (
                    <ContextMenuItem
                      disabled={busy}
                      onClick={() => action('edit')}
                    >
                      <Pencil /> Edit settings
                    </ContextMenuItem>
                  )}
                  {step.kind !== 'import' && (
                    <ContextMenuItem
                      disabled={busy}
                      onClick={() => action('duplicate')}
                    >
                      <Copy /> Duplicate operation
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    disabled={busy}
                    onClick={() => action('rename')}
                  >
                    Rename {row.kind === 'output' ? 'output' : 'operation'}
                    <ContextMenuShortcut>F2</ContextMenuShortcut>
                  </ContextMenuItem>
                  {step.kind === 'import' && (
                    <ContextMenuItem
                      disabled={busy}
                      onClick={() => action('rename-recording')}
                    >
                      Rename recording
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    disabled={busy}
                    onClick={() => action('delete')}
                  >
                    <Trash2 />{' '}
                    {step.kind === 'import'
                      ? 'Remove recording'
                      : 'Delete operation'}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}
