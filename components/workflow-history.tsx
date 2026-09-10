'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Hash,
  LockKeyhole,
  Scissors,
  Waves,
} from 'lucide-react';
import { workflowRows } from '@/lib/workflow-tree';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';

export type WorkflowSelection = { kind: 'step' | 'output'; id: string };
const ROW_HEIGHT = 48;

export default function WorkflowHistory({
  steps,
  index,
  query,
  selection,
  onSelect,
  contributingOutputs,
}: {
  steps: WorkflowStep[];
  index: WorkflowIndex;
  query: string;
  selection: WorkflowSelection;
  onSelect: (selection: WorkflowSelection) => void;
  contributingOutputs?: ReadonlySet<string>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedOwner =
    selection.kind === 'output' ? index.owner.get(selection.id)?.id : undefined;
  const effectiveCollapsed = useMemo(() => {
    const next = new Set(collapsed);
    if (selectedOwner) next.delete(selectedOwner);
    return next;
  }, [collapsed, selectedOwner]);
  const rows = useMemo(
    () =>
      workflowRows(
        steps,
        index,
        effectiveCollapsed,
        query,
        selection.kind === 'output' ? selection.id : undefined,
        contributingOutputs,
      ),
    [steps, index, effectiveCollapsed, query, selection, contributingOutputs],
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
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [focused, setFocused] = useState('');
  const selectedKey =
    selection.kind === 'step' ? selection.id : `output:${selection.id}`;
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
  useEffect(() => {
    if (selectedRow < 0 || !container.current) return;
    const element = container.current;
    const top = selectedRow * ROW_HEIGHT;
    if (
      top < element.scrollTop ||
      top + ROW_HEIGHT > element.scrollTop + element.clientHeight
    )
      element.scrollTop = Math.max(0, top - element.clientHeight / 3);
  }, [selectedRow, selectedKey]);
  function setExpanded(id: string, expanded: boolean) {
    if (!expanded && selectedOwner === id) onSelect({ kind: 'step', id });
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
        <button
          onClick={() => setCollapsed(new Set(steps.map((step) => step.id)))}
        >
          Compact history
        </button>
        <button onClick={() => setCollapsed(new Set())}>Show outputs</button>
      </div>
      <div
        className="workflow-tree"
        ref={container}
        role="tree"
        aria-label="Chronological operation history"
        tabIndex={visible.some((row) => row.key === tabKey) ? -1 : 0}
        onFocus={(event) => {
          if (event.target === container.current && rows.length)
            focusRow(selectedRow >= 0 ? selectedRow : start);
        }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {!rows.length && (
          <p className="workflow-empty">
            No matching steps. Clear the search or lineage filter.
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
            const select = () =>
              onSelect(
                row.kind === 'output'
                  ? { kind: 'output', id: row.outputId! }
                  : { kind: 'step', id: step.id },
              );
            return (
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
                data-selected={row.key === selectedKey}
                className="workflow-tree-row"
                title={row.label}
                style={{
                  position: 'absolute',
                  top: position * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                }}
                onFocus={() => setFocused(row.key)}
                onClick={select}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
                  >
                    {expanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                ) : (
                  <CornerDownRight className="workflow-branch" size={14} />
                )}
                {row.kind === 'more' ? (
                  <span className="workflow-more">{row.label} →</span>
                ) : (
                  <>
                    <Icon size={15} className={`workflow-icon ${step.kind}`} />
                    <span className="workflow-row-copy">
                      <strong>
                        {row.kind === 'step' && (
                          <code>
                            #{String(step.sequence + 1).padStart(3, '0')}{' '}
                          </code>
                        )}
                        {row.label}
                      </strong>
                      <small>
                        {row.kind === 'step' &&
                          (step.revision ?? 1) > 1 &&
                          `v${step.revision} · `}
                        {row.kind === 'step'
                          ? `${contributingOutputs ? step.outputIds.filter((id) => contributingOutputs.has(id)).length : step.outputIds.length} ${contributingOutputs ? 'contributing ' : ''}${step.kind === 'value' ? 'values' : 'signals'}${step.kind === 'regions' ? ' · saved ranges' : ''}${inputSteps.length ? ` · from ${inputSteps.slice(0, 3).join(', ')}${inputSteps.length > 3 ? ` +${inputSteps.length - 3}` : ''}` : ''}`
                          : `${index.kind(row.outputId!)} · ${index.nodes.get(row.outputId!)?.unit ?? index.values.get(row.outputId!)?.unit ?? ''}`}
                      </small>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
