'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  FilePlus2,
  ListChecks,
  ArrowUpLeft,
  Minus,
  Table2,
  Hash,
  LockKeyhole,
  Pencil,
  Scissors,
  SquareCheck,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { workflowRows, type WorkflowRow } from '@/lib/workflow-tree';
import { formatCount } from '@/lib/format-count';
import { segmentInterval } from '@/lib/file-segments';
import {
  stepInputs,
  stepName,
  type WorkflowIndex,
} from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import type { WorkflowManagementAction } from './workflow-management';
import { outputFlags, stepStatus, STATUS_LABELS } from '@/lib/workflow-checks';
import { StatusIcon } from './workflow-batch-view';
import {
  startWorkflowDrag,
  targetPlotOutputs,
  targetSignals,
} from '@/lib/workflow-drag';

export type WorkflowSelection = { kind: 'step' | 'output'; id: string };
/** Operations that run on the checked signals, as the top bar's tools do. */
export type CheckedAction = 'derive' | 'segment' | 'value';
type OutputView = {
  stepId: string;
  selectionKey: string;
  previousScroll: number;
  previousFocus: string;
};
const ROW_HEIGHT = 28;
/** A step row whose name wraps onto a second line. */
const TALL_ROW_HEIGHT = 44;
/**
 * Width beside a step name: indent, disclosure, number badge, output count,
 * check box and scroll bar. Overestimated, so a name estimated to fit does.
 */
const STEP_CHROME = 236;
let measureContext: CanvasRenderingContext2D | null | undefined;
/** Rendered text width, or 0 where no canvas is available. */
function textWidth(text: string, font: string): number {
  if (measureContext === undefined)
    measureContext =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  if (!measureContext) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
/** The first row whose bottom lies below an offset. */
function rowAt(tops: readonly number[], offset: number): number {
  let low = 0,
    high = tops.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (tops[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

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
  checkedIds,
  onCheck,
  onProcessChecked,
  workspaceEmpty = false,
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
  /**
   * Explicitly checked processing inputs. Ctrl+click, Shift+click and the row
   * check boxes edit them without changing the inspected selection.
   */
  checkedIds?: ReadonlySet<string>;
  /**
   * `extend` is set for Ctrl/Shift+click and keys, which extend from the
   * viewed signal; a check box click starts from the explicit checks alone.
   */
  onCheck?: (ids: string[], checked: boolean, extend?: boolean) => void;
  onProcessChecked?: (action: CheckedAction) => void;
  /** The workspace has no steps at all, rather than none in this view. */
  workspaceEmpty?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The row a Shift+click range starts from: the last plain or Ctrl+click.
  const anchor = useRef('');
  const [outputView, setOutputView] = useState<OutputView | null>(null);
  const [outputsCollapsed, setOutputsCollapsed] = useState(false);
  const focusedStepId = outputView?.stepId;
  // A selected segment is shown by its Segment step's row.
  const rawSelectedKey =
    selection.kind === 'step'
      ? selection.id
      : index.segments.has(selection.id)
        ? (index.owner.get(selection.id)?.id ?? `output:${selection.id}`)
        : `output:${selection.id}`;
  const selectedOwner =
    selection.kind === 'output' ? index.owner.get(selection.id)?.id : undefined;
  // Following an input or revealing another operation leaves the focused tree.
  if (
    outputView &&
    (outputView.selectionKey !== rawSelectedKey ||
      !steps.some((step) => step.id === outputView.stepId))
  ) {
    setOutputView(
      steps.some((step) => step.id === outputView.stepId) &&
        (selectedOwner ?? selection.id) === outputView.stepId
        ? { ...outputView, selectionKey: rawSelectedKey }
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
  /** A row's second column: a signal's or value's unit, a segment's times. */
  const outputDetail = (id: string) => {
    const segment = index.segments.get(id)?.segment;
    // A compact interval; Details and the Outputs table give exact times.
    return segment
      ? segmentInterval(segment, 1)
      : (index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? '');
  };
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
  // A selected step that History shows as one merged row highlights that row.
  const selectedKey =
    selection.kind === 'step' && !rows.some((row) => row.key === rawSelectedKey)
      ? (rows.find(
          (row) => row.kind === 'single' && row.step.id === selection.id,
        )?.key ?? rawSelectedKey)
      : rawSelectedKey;
  const container = useRef<HTMLDivElement>(null);
  const positions = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key =
        row.kind === 'step' || row.kind === 'single' ? 'root' : row.step.id;
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
  const [metrics, setMetrics] = useState({ height: 600, width: 0, font: '' });
  const height = metrics.height;
  const [focused, setFocused] = useState('');
  const selectedRow = rows.findIndex((row) => row.key === selectedKey);
  // Step names wrap onto a second line when they do not fit the pane.
  const tops = useMemo(() => {
    const result = [0];
    for (const row of rows) {
      const tall =
        !!row.stepLabel ||
        ((row.kind === 'step' || row.kind === 'single') &&
          !!metrics.font &&
          textWidth(row.label, metrics.font) >
            metrics.width - STEP_CHROME - (stepStatus(row.step) ? 17 : 0));
      result.push(result.at(-1)! + (tall ? TALL_ROW_HEIGHT : ROW_HEIGHT));
    }
    return result;
  }, [rows, metrics.font, metrics.width]);
  const rowHeight = (position: number) =>
    (tops[position + 1] ?? 0) - (tops[position] ?? 0);
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
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(element);
      const size = style.getPropertyValue('--text-sm').trim() || '12px';
      setMetrics({
        height: element.clientHeight,
        width: element.clientWidth,
        font: `600 ${size} ${style.fontFamily}`,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Scroll only when the selection or its position changes, never when rows
  // elsewhere change height.
  const selectedTop = selectedRow >= 0 ? tops[selectedRow] : -1;
  const selectedBottom = selectedRow >= 0 ? tops[selectedRow + 1] : -1;
  useLayoutEffect(() => {
    if (pendingNavigation.current || selectedTop < 0 || !container.current)
      return;
    const element = container.current;
    if (
      selectedTop < element.scrollTop ||
      selectedBottom > element.scrollTop + element.clientHeight
    )
      element.scrollTop = Math.max(0, selectedTop - element.clientHeight / 3);
  }, [selectedTop, selectedBottom, selectedKey]);
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
      selectionKey: rawSelectedKey,
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
    const top = tops[position];
    const bottom = top + rowHeight(position);
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight;
    setScroll(element.scrollTop);
  }
  /** Signals a row checks: one signal output, or a step's shown signals. */
  function rowSignals(row: WorkflowRow): string[] {
    if (row.kind === 'output' || row.kind === 'single')
      return index.nodes.has(row.outputId!) ? [row.outputId!] : [];
    if (row.kind !== 'step') return [];
    return row.step.outputIds.filter(
      (id) =>
        index.nodes.has(id) &&
        (!contributingOutputs || contributingOutputs.has(id)),
    );
  }
  /** Toggles a row; `extend` keeps a viewed signal, as Ctrl+click does. */
  function toggleChecked(row: WorkflowRow, extend = false) {
    const ids = rowSignals(row);
    if (!onCheck || !ids.length) return false;
    onCheck(ids, !ids.every((id) => checkedIds?.has(id)), extend);
    anchor.current = row.key;
    return true;
  }
  /** Checks every signal output row between the anchor and a row. */
  function checkRange(position: number) {
    if (!onCheck) return false;
    const from = rows.findIndex((row) => row.key === anchor.current);
    const origin = from >= 0 ? from : selectedRow >= 0 ? selectedRow : position;
    const ids = rows
      .slice(Math.min(origin, position), Math.max(origin, position) + 1)
      .flatMap((row) =>
        row.kind === 'output' || row.kind === 'single' ? rowSignals(row) : [],
      );
    if (!ids.length) return false;
    onCheck(ids, true, true);
    return true;
  }
  const start = Math.max(0, rowAt(tops, scroll) - 5);
  const visible = rows.slice(start, rowAt(tops, scroll + height) + 7);
  // One control collapses or expands every step's output preview.
  // Steps with one output are single rows, so only larger steps expand.
  const anyExpanded = steps.some(
    (step) => step.outputIds.length > 1 && !collapsed.has(step.id),
  );
  const anyExpandable = steps.some((step) => step.outputIds.length > 1);
  // Dots mark outputs used to make the selected item, never the item itself.
  const lineageShown =
    !!lineageOutputs &&
    rows.some(
      (row) =>
        (row.kind === 'output' || row.kind === 'single') &&
        row.key !== selectedKey &&
        lineageOutputs.has(row.outputId!),
    );
  return (
    <div className="workflow-history-pane">
      {(focusedStepId || anyExpandable) && (
        <div className="workflow-tree-controls">
          {focusedStepId ? (
            <button className="workflow-tree-back" onClick={returnToHistory}>
              <ArrowLeft size={14} /> Back to history
            </button>
          ) : (
            <button
              className="workflow-tree-toggle"
              disabled={!!query}
              title={
                query
                  ? 'Search results always show their matching outputs'
                  : anyExpanded
                    ? "Hide every step's outputs"
                    : "Show every step's outputs"
              }
              onClick={() =>
                setCollapsed(
                  anyExpanded
                    ? new Set(steps.map((step) => step.id))
                    : new Set(),
                )
              }
            >
              {anyExpanded ? (
                <ChevronsDownUp size={14} />
              ) : (
                <ChevronsUpDown size={14} />
              )}
              {anyExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
      )}
      <div
        className="workflow-tree"
        ref={container}
        role="tree"
        aria-label={
          focusedStepId ? 'Step outputs' : 'Chronological step history'
        }
        onKeyDown={(event) => {
          if (focusedStepId && event.key === 'Escape') {
            event.preventDefault();
            returnToHistory();
          }
        }}
        data-checking={!!checkedIds?.size}
        tabIndex={visible.some((row) => row.key === tabKey) ? -1 : 0}
        onFocus={(event) => {
          if (event.target === container.current && rows.length)
            focusRow(selectedRow >= 0 ? selectedRow : start);
        }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {!rows.length && (
          <p className="workflow-empty">
            {workspaceEmpty
              ? 'Imported recordings and your steps appear here, oldest first.'
              : steps.length
                ? 'No matching steps. Clear the search or lineage filter.'
                : 'No steps in this view. Clear the filters to show every step.'}
          </p>
        )}
        <div
          role="presentation"
          style={{ height: tops[rows.length], position: 'relative' }}
        >
          {visible.map((row, offset) => {
            const position = start + offset;
            const step = row.step;
            const inputSteps =
              row.kind === 'step'
                ? [
                    ...new Set(
                      stepInputs(step).flatMap((id) => {
                        const owner = index.owner.get(id);
                        return owner
                          ? [`#${String(owner.sequence + 1).padStart(3, '0')}`]
                          : [];
                      }),
                    ),
                  ]
                : [];
            const expanded = !effectiveCollapsed.has(step.id) || !!query;
            // A step's count names what it made: signals, values or both.
            const counted =
              row.kind === 'step'
                ? contributingOutputs
                  ? step.outputIds.filter((id) => contributingOutputs.has(id))
                  : step.outputIds
                : [];
            const outputCount = formatCount(
              counted.length,
              counted.length && counted.every((id) => index.values.has(id))
                ? 'value'
                : counted.length && counted.every((id) => index.nodes.has(id))
                  ? 'signal'
                  : counted.length &&
                      counted.every((id) => index.segments.has(id))
                    ? 'segment'
                    : 'output',
            );
            const Icon =
              row.kind === 'output'
                ? index.values.has(row.outputId!)
                  ? Hash
                  : index.segments.has(row.outputId!)
                    ? Scissors
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
            const single = row.kind === 'single';
            const reference = `#${String(step.sequence + 1).padStart(3, '0')}`;
            const target: WorkflowSelection =
              row.kind === 'output' || single
                ? { kind: 'output', id: row.outputId! }
                : { kind: 'step', id: step.id };
            const select = () => {
              if (row.kind === 'more') return showOutputs(step.id);
              anchor.current = row.key;
              onSelect(target);
            };
            // Checking is independent of inspection; values have no signal.
            const signals = row.kind === 'more' ? [] : rowSignals(row);
            const checkedCount = checkedIds
              ? signals.filter((id) => checkedIds.has(id)).length
              : 0;
            const checkState: boolean | 'mixed' | undefined =
              !onCheck || !signals.length
                ? undefined
                : checkedCount === 0
                  ? false
                  : checkedCount === signals.length || 'mixed';
            // Failed or warning checks mark the step and each affected output.
            const flag =
              row.kind === 'step'
                ? stepStatus(step)
                : row.outputId
                  ? outputFlags(step).get(row.outputId)
                  : undefined;
            const flagged = flag && flag !== 'pass' ? flag : undefined;
            const action = (action: WorkflowManagementAction) =>
              onAction(target, action);
            const item = (
              <div
                key={row.key}
                role="treeitem"
                aria-level={row.kind === 'step' || single ? 1 : 2}
                aria-posinset={positions.get(row.key)?.position}
                aria-setsize={positions.get(row.key)?.size}
                aria-expanded={
                  row.kind === 'step' &&
                  step.outputIds.length > 0 &&
                  !step.segmentSetId
                    ? expanded
                    : undefined
                }
                aria-selected={row.key === selectedKey}
                aria-checked={checkState}
                tabIndex={row.key === tabKey ? 0 : -1}
                data-row={position}
                data-kind={single ? 'output' : row.kind}
                data-merged={single || undefined}
                data-step-kind={step.kind === 'regions' ? 'segment' : step.kind}
                data-selected={row.key === selectedKey}
                data-checked={
                  checkState === undefined ? undefined : String(checkState)
                }
                data-flag={flagged}
                data-lineage={
                  !!lineageOutputs &&
                  row.key !== selectedKey &&
                  (row.kind === 'output' || single
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
                aria-label={`${
                  row.kind === 'step'
                    ? `${row.label} · ${outputCount}${inputSteps.length ? ` · from ${inputSteps.slice(0, 3).join(', ')}${inputSteps.length > 3 ? ' and more' : ''}` : ''}`
                    : row.outputId
                      ? `${row.label} · ${index.kind(row.outputId)} · ${outputDetail(row.outputId)}${single ? ` · step ${reference} ${stepName(step)}` : ''}`
                      : row.label
                }${flagged ? ` · check ${STATUS_LABELS[flagged].toLowerCase()}` : ''}`}
                data-wrap={
                  (!row.stepLabel && rowHeight(position) > ROW_HEIGHT) ||
                  undefined
                }
                style={{
                  position: 'absolute',
                  top: tops[position],
                  height: rowHeight(position),
                }}
                onFocus={() => setFocused(row.key)}
                onClick={(event) => {
                  // Ctrl/Cmd+click toggles a signal; Shift+click checks a range.
                  if (
                    row.kind !== 'more' &&
                    (event.shiftKey
                      ? checkRange(position)
                      : (event.ctrlKey || event.metaKey) &&
                        toggleChecked(row, true))
                  )
                    return;
                  select();
                }}
                onDoubleClick={(event) => {
                  if (
                    row.kind === 'more' ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
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
                    const next =
                      position + (event.key === 'ArrowDown' ? 1 : -1);
                    // Shift+arrow extends the checked signals row by row.
                    if (event.shiftKey && onCheck && rows[next]) {
                      const ids = [row, rows[next]].flatMap((item) =>
                        item.kind === 'output' || item.kind === 'single'
                          ? rowSignals(item)
                          : [],
                      );
                      if (ids.length) onCheck(ids, true, true);
                    }
                    focusRow(next);
                  } else if (
                    event.key === ' ' &&
                    row.kind !== 'more' &&
                    (event.ctrlKey || event.metaKey || event.shiftKey)
                  ) {
                    event.preventDefault();
                    if (event.shiftKey) checkRange(position);
                    else toggleChecked(row, true);
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    focusRow(event.key === 'Home' ? 0 : rows.length - 1);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    if (step.segmentSetId) return;
                    if (row.kind === 'step' && !expanded)
                      setExpanded(step.id, true);
                    else if (row.kind === 'step' && step.outputIds.length)
                      focusRow(position + 1);
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    if (single) return;
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
                {row.kind === 'step' && !step.segmentSetId ? (
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
                ) : single || row.kind === 'step' ? (
                  <span className="workflow-single-spacer" aria-hidden="true" />
                ) : (
                  <span className="workflow-branch" aria-hidden="true" />
                )}
                {row.kind === 'more' ? (
                  <span className="workflow-more">{row.label} →</span>
                ) : (
                  <>
                    {row.kind === 'step' || single ? (
                      <code className="workflow-step-node">
                        <Icon size={11} />#
                        {String(step.sequence + 1).padStart(3, '0')}
                      </code>
                    ) : (
                      <Icon
                        size={14}
                        className={`workflow-icon ${index.values.has(row.outputId!) ? 'value' : index.segments.has(row.outputId!) ? 'segment' : index.nodes.get(row.outputId!)?.operation === 'raw' ? 'import' : 'derive'}`}
                      />
                    )}
                    {flagged && <StatusIcon status={flagged} size={12} />}
                    <span className="workflow-row-copy">
                      {row.stepLabel ? (
                        <span className="workflow-row-title">
                          <strong>{row.label}</strong>
                          <em title={`${reference} ${row.stepLabel}`}>
                            {row.stepLabel}
                          </em>
                        </span>
                      ) : (
                        <strong>{row.label}</strong>
                      )}
                      <small>
                        {row.kind === 'step'
                          ? `${(step.revision ?? 1) > 1 ? `v${step.revision} · ` : ''}${outputCount}`
                          : outputDetail(row.outputId!)}
                      </small>
                    </span>
                    {checkState !== undefined && (
                      <button
                        tabIndex={-1}
                        className="workflow-row-check"
                        aria-label={`${checkState === true ? 'Uncheck' : 'Check'} ${row.kind === 'step' ? `the signals of ${row.label}` : row.label} as ${row.kind === 'step' ? 'inputs' : 'an input'}`}
                        title="Check as an input for Derive, Segment or Value · Ctrl+click or Shift+click rows to add the signal in view"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleChecked(row);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <span aria-hidden="true">
                          {checkState === 'mixed' ? (
                            <Minus size={12} />
                          ) : checkState ? (
                            <Check size={12} />
                          ) : null}
                        </span>
                      </button>
                    )}
                  </>
                )}
              </div>
            );
            const checkedTotal = checkedIds?.size ?? 0;
            if (row.kind === 'more') return item;
            return (
              <ContextMenu key={row.key}>
                <ContextMenuTrigger render={item} />
                <ContextMenuContent aria-label={`Actions for ${row.label}`}>
                  {/* Within the checked signals, the menu acts on all of them. */}
                  {onProcessChecked && checkState && checkedTotal > 0 && (
                    <>
                      <ContextMenuGroup>
                        <ContextMenuLabel>
                          {formatCount(
                            checkedTotal,
                            'checked signal',
                            'checked signals',
                          )}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          disabled={busy}
                          onClick={() => onProcessChecked('value')}
                        >
                          <Hash /> Calculate value…
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={busy}
                          onClick={() => onProcessChecked('derive')}
                        >
                          <Waves /> Derive signal…
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={busy}
                          onClick={() => onProcessChecked('segment')}
                        >
                          <Scissors /> Segment…
                        </ContextMenuItem>
                      </ContextMenuGroup>
                      <ContextMenuSeparator />
                    </>
                  )}
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
                        <ListChecks />{' '}
                        {targetSignals(index, target).length === 1
                          ? 'Check only this signal'
                          : 'Check only these signals'}
                      </ContextMenuItem>
                      {checkState !== undefined && (
                        <ContextMenuItem
                          disabled={busy}
                          onClick={() => toggleChecked(row)}
                        >
                          {checkState === true ? <X /> : <SquareCheck />}
                          {checkState === true
                            ? 'Uncheck as input'
                            : 'Check as input'}
                          <ContextMenuShortcut>Ctrl+Click</ContextMenuShortcut>
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        disabled={busy || !step.outputIds.length}
                        onClick={() => onInspect(target, 'export')}
                      >
                        <Download /> Export data…
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
                      <Copy /> New version…
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    disabled={busy}
                    onClick={() => action('rename')}
                  >
                    Rename{' '}
                    {single
                      ? index.values.has(row.outputId!)
                        ? 'value'
                        : 'signal'
                      : row.kind === 'output'
                        ? 'output'
                        : 'step'}
                    <ContextMenuShortcut>F2</ContextMenuShortcut>
                  </ContextMenuItem>
                  {single && (
                    <ContextMenuItem
                      disabled={busy}
                      onClick={() =>
                        onAction({ kind: 'step', id: step.id }, 'rename')
                      }
                    >
                      Rename step
                    </ContextMenuItem>
                  )}
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
                      ? 'Remove recording…'
                      : 'Delete step…'}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
      {lineageShown && (
        <p className="workflow-rail-hint">
          <i aria-hidden="true" /> Used to make the selected item
        </p>
      )}
    </div>
  );
}
