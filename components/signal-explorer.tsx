'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Crosshair,
  FileSpreadsheet,
  FolderOpen,
  GitBranch,
  Layers3,
  LockKeyhole,
  Search,
  Scissors,
  Sigma,
} from 'lucide-react';
import {
  buildExplorer,
  explorerRows,
  operationDetail,
  operationLabels,
  revealEntry,
  type ExplorerEntry,
} from '@/lib/signal-explorer';
import { SignalGraph } from '@/lib/signal-graph';
import type { Project, SignalNode } from '@/lib/signal-types';

export default function SignalExplorer({
  project,
  sourceId,
  selectedId,
  collectionId,
  onSelect,
  onCollection,
}: {
  project: Project;
  sourceId: string;
  selectedId: string;
  collectionId?: string;
  onSelect: (node: SignalNode) => void;
  onCollection: (entry: ExplorerEntry) => void;
}) {
  const model = useMemo(
    () => buildExplorer(project, sourceId),
    [project, sourceId],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    revealEntry(model, selectedId),
  );
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const viewport = useRef<HTMLDivElement>(null);
  const activeId =
    collectionId && model.entries.has(collectionId) ? collectionId : selectedId;
  const [navigation, setNavigation] = useState<{
    selection: string;
    id: string;
  }>();
  const navigationId =
    navigation?.selection === activeId ? navigation.id : activeId;
  const ancestors = useMemo(
    () => revealEntry(model, activeId),
    [model, activeId],
  );
  const rows = useMemo(
    () =>
      explorerRows(
        model,
        new Set([...expanded, ...ancestors].filter((id) => !closed.has(id))),
        query,
      ),
    [model, expanded, ancestors, closed, query],
  );
  const start = Math.min(
    Math.max(0, rows.length - Math.ceil(height / 38)),
    Math.max(0, Math.floor(scrollTop / 38) - 8),
  );
  const visible = rows.slice(start, start + Math.ceil(height / 38) + 16);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(entry.contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const revealed = useRef('');
  useEffect(() => {
    if (revealed.current === navigationId) return;
    const index = rows.findIndex((row) => row.entry.id === navigationId);
    if (index < 0) return;
    revealed.current = navigationId;
    viewport.current?.scrollTo({ top: Math.max(0, index * 38 - height / 3) });
  }, [navigationId, rows, height]);
  function reveal() {
    setQuery('');
    setClosed((old) => new Set([...old].filter((id) => !ancestors.has(id))));
    setExpanded((old) => new Set([...old, ...ancestors]));
    const full = explorerRows(model, new Set([...expanded, ...ancestors]));
    const index = full.findIndex((row) => row.entry.id === activeId);
    viewport.current?.scrollTo({ top: Math.max(0, index * 38 - height / 3) });
  }
  function toggle(id: string) {
    const open = !closed.has(id) && (expanded.has(id) || ancestors.has(id));
    setClosed((old) => {
      const next = new Set(old);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    setExpanded((old) => {
      const next = new Set(old);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function select(entry: ExplorerEntry) {
    setNavigation({ selection: activeId, id: entry.id });
    if (entry.node) onSelect(entry.node);
    else if (entry.ids.length) onCollection(entry);
    else toggle(entry.id);
  }
  return (
    <>
      <label className="search-box">
        <Search size={14} />
        <input
          aria-label="Find signals or operations"
          placeholder="Find signals or operations…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            viewport.current?.scrollTo({ top: 0 });
          }}
        />
      </label>
      <div className="explorer-tools">
        <span>OPERATION ORDER</span>
        <button
          className="icon-button"
          aria-label="Reveal selected operation"
          title="Reveal selected operation"
          onClick={reveal}
        >
          <Crosshair size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="Collapse other branches"
          title="Collapse other branches"
          onClick={() => {
            setExpanded(new Set());
            setClosed(new Set());
            viewport.current?.scrollTo({ top: 0 });
          }}
        >
          <ChevronsDownUp size={14} />
        </button>
      </div>
      <div
        ref={viewport}
        className="chronological-scroll"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="tree"
        tabIndex={0}
        aria-activedescendant={
          visible.some((row) => row.entry.id === navigationId)
            ? `explorer-${navigationId}`
            : undefined
        }
        aria-label="Signals in operation order"
        onKeyDown={(event) => {
          if (
            ![
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
              'Home',
              'End',
              'Enter',
              ' ',
            ].includes(event.key) ||
            !rows.length
          )
            return;
          event.preventDefault();
          const index = rows.findIndex((row) => row.entry.id === navigationId);
          const entry = rows[Math.max(0, index)].entry;
          const open =
            !closed.has(entry.id) &&
            (expanded.has(entry.id) || ancestors.has(entry.id));
          if (event.key === 'ArrowLeft') {
            if (open) toggle(entry.id);
            else if (entry.parent) select(model.entries.get(entry.parent)!);
          } else if (event.key === 'ArrowRight') {
            if (!open && (entry.members.length || entry.next.length))
              toggle(entry.id);
            else if (rows[index + 1]) select(rows[index + 1].entry);
          } else if (event.key === 'Enter' || event.key === ' ') select(entry);
          else {
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        rows.length - 1,
                        index + (event.key === 'ArrowDown' ? 1 : -1),
                      ),
                    );
            select(rows[next].entry);
          }
        }}
      >
        <div
          style={{
            height: rows.length * 38,
            position: 'relative',
            minWidth: '100%',
          }}
        >
          {visible.map(({ entry, indent, step }, index) => {
            const open =
              (!closed.has(entry.id) &&
                (expanded.has(entry.id) || ancestors.has(entry.id))) ||
              !!query;
            const expandable =
              entry.kind === 'collection'
                ? !!entry.members.length
                : !!(entry.next.length || entry.members.length);
            const rowStyle: CSSProperties & { '--step-rail-left': string } = {
              '--step-rail-left': `${37 + Math.min(indent, 6) * 12}px`,
              top: (start + index) * 38,
              paddingLeft: 8 + Math.min(indent, 6) * 12,
            };
            return (
              <div
                key={entry.id}
                id={`explorer-${entry.id}`}
                role="treeitem"
                aria-level={indent + 1}
                aria-selected={entry.id === activeId}
                aria-expanded={expandable ? open : undefined}
                className={`chronological-row ${entry.kind} ${entry.id === activeId ? 'selected-step' : ''} ${entry.id === navigationId ? 'focused-step' : ''}`}
                style={rowStyle}
              >
                <button
                  className="step-toggle"
                  tabIndex={-1}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.label}`}
                  disabled={!expandable}
                  onClick={() => toggle(entry.id)}
                >
                  {expandable ? (
                    open ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )
                  ) : (
                    <span className="step-rail" />
                  )}
                </button>
                <button
                  className="step-main"
                  tabIndex={-1}
                  title={`${step === 0 ? 'Source' : `Step ${step}`} · ${entry.label} · ${entry.detail}${entry.node?.parents.length && entry.node.parents.length > 1 ? ` · ${entry.node.parents.length - 1} linked inputs` : ''}`}
                  onClick={() => select(entry)}
                >
                  <span className="step-number">
                    {entry.kind === 'file' || entry.kind === 'file-segment' ? (
                      <FileSpreadsheet size={13} />
                    ) : entry.kind === 'folder' ? (
                      <FolderOpen size={13} />
                    ) : entry.node?.operation === 'raw' ? (
                      <LockKeyhole size={12} />
                    ) : (
                      String(step).padStart(2, '0')
                    )}
                  </span>
                  <span className="step-title">
                    <strong>{entry.label}</strong>
                    <small>{entry.detail}</small>
                  </span>
                  {entry.kind === 'collection' ||
                  entry.kind === 'file-segment' ? (
                    <Layers3 size={13} />
                  ) : entry.node?.operation === 'crop' ||
                    entry.kind === 'file-operation' ? (
                    <Scissors size={12} />
                  ) : (entry.node?.parents.length ?? 0) > 1 ? (
                    <span className="step-links">
                      +{entry.node!.parents.length - 1}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <p className="tree-hint">No matching signals or operations.</p>
        )}
      </div>
      <div className="explorer-legend">
        <GitBranch size={12} />
        File segments keep channels together. Expand Original signals for
        signal-specific operations.
      </div>
    </>
  );
}

export function OperationHistory({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: SignalNode;
  onSelect: (node: SignalNode) => void;
}) {
  const graph = useMemo(() => new SignalGraph(project), [project]);
  const chain = graph.chain(selected.id);
  const [page, setPage] = useState(() => Math.floor((chain.length - 1) / 50));
  const start = page * 50;
  return (
    <div className="operation-history">
      <div className="history-heading">
        <span>{chain.length - 1} operations from raw signal</span>
        <span>
          {start + 1}–{Math.min(start + 50, chain.length)} of {chain.length}
        </span>
      </div>
      {chain.slice(start, start + 50).map((node, index) => (
        <div className="history-step" key={node.id}>
          <span className="history-number">
            {String(start + index).padStart(2, '0')}
          </span>
          <button className="history-main" onClick={() => onSelect(node)}>
            {node.operation === 'raw' ? (
              <LockKeyhole size={16} />
            ) : (
              <Sigma size={16} />
            )}
            <span>
              <strong>
                {node.operation === 'raw'
                  ? node.name
                  : operationLabels[node.operation]}
              </strong>
              <small>{operationDetail(node)}</small>
            </span>
            <code>{node.id.slice(0, 8)}</code>
          </button>
          {node.parents.length > 1 && (
            <div className="history-inputs">
              Linked inputs:
              {node.parents.slice(1).map((id) => {
                const input = graph.find(id);
                return (
                  <button key={id} onClick={() => onSelect(input)}>
                    {input.name} →
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {chain.length > 50 && (
        <div className="history-pages">
          <button
            className="secondary-button"
            disabled={!page}
            onClick={() => setPage(0)}
          >
            First
          </button>
          <button
            className="secondary-button"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <button
            className="secondary-button"
            disabled={start + 50 >= chain.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
          <button
            className="secondary-button"
            disabled={start + 50 >= chain.length}
            onClick={() => setPage(Math.floor((chain.length - 1) / 50))}
          >
            Latest
          </button>
        </div>
      )}
    </div>
  );
}
