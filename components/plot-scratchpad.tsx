'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Grid2X2,
  Layers2,
  ListPlus,
  Maximize,
  Pin,
  Plus,
  Search,
  Table2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  Point,
  Project,
} from '@/lib/signal-types';
import type { SignalGraph } from '@/lib/signal-graph';
import type { WorkflowIndex } from '@/lib/workflow-history';
import {
  MAX_PLOT_TABS,
  MAX_PLOT_TRACES,
  PLOT_STORAGE_KEY,
  TRACE_COLORS,
  readPlotSheets,
  type PlotSheet,
} from '@/lib/plot-scratchpad';
import SignalChart, { formatValue } from './signal-chart';

type Props = {
  project: Project;
  graph: SignalGraph;
  index: WorkflowIndex;
  activeId: string;
  checkedIds: string[];
  view: string;
  onView: (view: string) => void;
  onInspect: (id: string) => void;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  outputs: ReactNode;
  outputCount: number;
  valueCard: ReactNode;
  onExport: () => void;
  busy: boolean;
};
const initialSheet: PlotSheet = {
  id: 'result',
  name: 'Active',
  traces: [],
  layout: 'overlay',
  grid: true,
};

export default function PlotScratchpad({
  project,
  graph,
  index,
  activeId,
  checkedIds,
  view,
  onView,
  onInspect,
  request,
  outputs,
  outputCount,
  valueCard,
  onExport,
  busy,
}: Props) {
  const [sheets, setSheets] = useState<PlotSheet[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [activeSettings, setActiveSettings] = useState(initialSheet);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [pickerPage, setPickerPage] = useState(0);
  const [draft, setDraft] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [closed, setClosed] = useState<{
    sheet: PlotSheet;
    position: number;
  }>();
  const [windows, setWindows] = useState<Record<string, [number, number]>>({});
  const saved = sheets.find((sheet) => sheet.id === view);
  const isActive = !saved;
  const selectedTab = view === 'outputs' ? view : (saved?.id ?? 'result');
  const sheet = saved ?? {
    ...activeSettings,
    traces: activeId
      ? [{ id: activeId, visible: true, color: TRACE_COLORS[0] }]
      : [],
  };
  const windowKey = saved?.id ?? `active:${activeId}`;
  const window = windows[windowKey] ?? [0, 1];
  const visibleIds = sheet.traces
    .filter((trace) => trace.visible && index.nodes.has(trace.id))
    .map((trace) => trace.id);
  const idsKey = JSON.stringify(view === 'outputs' ? [] : visibleIds);
  const [result, setResult] = useState<{
    key: string;
    project: Project;
    plots?: Plot[];
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    queueMicrotask(() => {
      try {
        setSheets(readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY)));
      } catch {
        setStorageError(
          'Plot layouts cannot be saved on this device. This session still works.',
        );
      }
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(sheets));
    } catch {
      queueMicrotask(() =>
        setStorageError(
          'Plot layouts could not be saved. Keep this window open to retain them.',
        ),
      );
    }
  }, [sheets, loaded]);
  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    if (!ids.length) return;
    let alive = true;
    void request({ type: 'view', ids, inspection: true })
      .then((response) => {
        if (alive && response.type === 'plots')
          setResult({ key: idsKey, project, plots: response.plots });
      })
      .catch((error: unknown) => {
        if (alive)
          setResult({
            key: idsKey,
            project,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load this plot.',
          });
      });
    return () => {
      alive = false;
    };
  }, [idsKey, project, request, retry]);
  const current =
    result?.key === idsKey && result.project === project ? result : undefined;
  const plots = new Map(current?.plots?.map((plot) => [plot.id, plot]));
  const traces = sheet.traces.flatMap((trace) => {
    const node = index.nodes.get(trace.id),
      plot = plots.get(trace.id);
    return trace.visible && node && plot
      ? [{ node, plot, color: trace.color, label: index.label(trace.id) }]
      : [];
  });
  const clocks = new Set(
    visibleIds.map((id) => graph.timeReferences.get(id)?.id ?? id),
  );
  const units = new Set(visibleIds.map((id) => index.nodes.get(id)?.unit));
  const canOverlay = clocks.size <= 1 && units.size <= 1;
  const stacked = sheet.layout === 'stacked' || !canOverlay;
  const ranges = visibleIds.flatMap((id) =>
    graph.ranges.get(id) ? [graph.ranges.get(id)!] : [],
  );
  const fullRange: [number, number] = ranges.length
    ? [
        Math.min(...ranges.map((r) => r[0])),
        Math.max(...ranges.map((r) => r[1])),
      ]
    : [0, 1];
  function zoomRange(range: [number, number]): [number, number] {
    const span = range[1] - range[0];
    return [range[0] + window[0] * span, range[0] + window[1] * span];
  }
  function zoom(factor: number, shift = 0) {
    const width = Math.min(
      1,
      Math.max(0.001, (window[1] - window[0]) * factor),
    );
    const start = Math.max(
      0,
      Math.min(1 - width, (window[0] + window[1] - width) / 2 + shift),
    );
    setWindows((old) => ({ ...old, [windowKey]: [start, start + width] }));
  }
  function update(change: Partial<PlotSheet>) {
    if (saved)
      setSheets((old) =>
        old.map((item) =>
          item.id === saved.id ? { ...item, ...change } : item,
        ),
      );
    else setActiveSettings((old) => ({ ...old, ...change }));
  }
  function create(ids: string[]) {
    if (sheets.length >= MAX_PLOT_TABS) return;
    const next: PlotSheet = {
      ...initialSheet,
      id: `plot:${crypto.randomUUID()}`,
      name:
        ids.length === 1
          ? index.label(ids[0]).slice(0, 80)
          : `Plot ${sheets.length + 1}`,
      traces: [...new Set(ids)]
        .slice(0, MAX_PLOT_TRACES)
        .map((id, i) => ({ id, visible: true, color: TRACE_COLORS[i] })),
    };
    setSheets((old) => [...old, next]);
    onView(next.id);
  }
  function openPicker() {
    setDraft(
      saved?.traces.map((trace) => trace.id) ?? (activeId ? [activeId] : []),
    );
    setQuery('');
    setPickerPage(0);
    setPicker(true);
  }
  const matches = useMemo(
    () =>
      project.nodes.filter((node) =>
        `${index.label(node.id)} ${node.unit} ${graph.timeReferences.get(node.id)?.name ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [project, index, graph, query],
  );
  const safePage = Math.min(
    pickerPage,
    Math.max(0, Math.ceil(matches.length / 30) - 1),
  );
  const mainPlot = traces[0]?.plot;

  return (
    <section className="plot-scratchpad" aria-label="Plot scratchpad">
      <header className="scratchpad-heading">
        <div>
          <ChartNoAxesCombined size={21} />
          <h1>Plot scratchpad</h1>
        </div>
        <span>Layouts saved on this device</span>
        <button
          className="secondary-button"
          disabled={!loaded || sheets.length >= MAX_PLOT_TABS}
          title={`Create a blank plot · up to ${MAX_PLOT_TABS} tabs`}
          onClick={() => create([])}
        >
          <Plus size={16} /> New plot
        </button>
      </header>
      <Tabs
        value={selectedTab}
        onValueChange={onView}
        className="scratchpad-tabs"
      >
        <div className="scratchpad-tabbar">
          <TabsList variant="line" aria-label="Plot tabs">
            <TabsTrigger value="result">
              <Activity size={15} /> Active{' '}
              <span className="scratchpad-live">LIVE</span>
            </TabsTrigger>
            {sheets.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                title={item.name}
                onDoubleClick={() => {
                  onView(item.id);
                  setName(item.name);
                  setRenaming(true);
                }}
              >
                <ChartNoAxesCombined size={14} />
                <span className="scratchpad-tab-name">{item.name}</span>
                <span className="scratchpad-tab-count">
                  {item.traces.length}
                </span>
              </TabsTrigger>
            ))}
            <TabsTrigger value="outputs">
              <Table2 size={14} /> Step outputs{' '}
              <span className="scratchpad-tab-count">{outputCount}</span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="outputs">
          <div className="scratchpad-output-actions">
            <button
              className="secondary-button"
              disabled={busy || !outputCount}
              onClick={onExport}
            >
              <Download size={15} /> Export / report
            </button>
          </div>
          {outputs}
        </TabsContent>
        {/* Only the selected plot mounts; large workspaces never render hidden charts. */}
        <TabsContent
          value={selectedTab === 'outputs' ? '__inactive-plot' : selectedTab}
        >
          <div className="scratchpad-plot-toolbar">
            <div className="scratchpad-plot-title">
              {saved ? (
                <button
                  className="scratchpad-name"
                  title="Rename plot"
                  onClick={() => {
                    setName(saved.name);
                    setRenaming(true);
                  }}
                >
                  {saved.name}
                </button>
              ) : (
                <strong>
                  {activeId
                    ? index.label(activeId)
                    : 'Select a signal to begin'}
                </strong>
              )}
              <small>
                {isActive
                  ? 'Follows your selection in History'
                  : `${sheet.traces.length} / ${MAX_PLOT_TRACES} traces · click the title to rename`}
              </small>
            </div>
            {isActive ? (
              <button
                className="secondary-button"
                disabled={
                  !activeId || !loaded || sheets.length >= MAX_PLOT_TABS
                }
                onClick={() => create([activeId])}
              >
                <Pin size={15} /> Keep plot
              </button>
            ) : (
              <>
                <button className="secondary-button" onClick={openPicker}>
                  <ListPlus size={16} /> Add signals
                </button>
                <button
                  className="workflow-icon-button"
                  aria-label={`Close plot ${sheet.name}`}
                  onClick={() => {
                    setClosed({
                      sheet: saved,
                      position: sheets.indexOf(saved),
                    });
                    setSheets((old) =>
                      old.filter((item) => item.id !== saved.id),
                    );
                    onView('result');
                  }}
                >
                  <X size={16} />
                </button>
              </>
            )}
          </div>
          {saved &&
            activeId &&
            !saved.traces.some((trace) => trace.id === activeId) &&
            saved.traces.length < MAX_PLOT_TRACES && (
              <div className="scratchpad-selection">
                <span>
                  Selected <strong>{index.label(activeId)}</strong>
                </span>
                <button
                  className="workflow-link"
                  onClick={() =>
                    update({
                      traces: [
                        ...saved.traces,
                        {
                          id: activeId,
                          color: TRACE_COLORS[saved.traces.length],
                          visible: true,
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} /> Add to this plot
                </button>
              </div>
            )}
          {isActive && valueCard}
          <div className="scratchpad-canvas">
            <div className="scratchpad-chart-tools">
              <fieldset className="scratchpad-mode" aria-label="Plot layout">
                <button
                  aria-pressed={!stacked}
                  disabled={!canOverlay}
                  title={
                    canOverlay
                      ? 'Overlay traces with the same unit and time reference'
                      : 'Overlay requires matching units and time references'
                  }
                  onClick={() => update({ layout: 'overlay' })}
                >
                  <ChartNoAxesCombined size={15} /> Overlay
                </button>
                <button
                  aria-pressed={stacked}
                  onClick={() => update({ layout: 'stacked' })}
                >
                  <Layers2 size={15} /> Stacked
                </button>
              </fieldset>
              <fieldset
                className="scratchpad-zoom"
                aria-label="Plot view controls"
              >
                <button
                  aria-label="Toggle plot grid"
                  aria-pressed={sheet.grid}
                  onClick={() => update({ grid: !sheet.grid })}
                >
                  <Grid2X2 size={15} />
                </button>
                <span />
                <button
                  aria-label="Pan plot left"
                  disabled={window[0] <= 0}
                  onClick={() => zoom(1, -(window[1] - window[0]) / 4)}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  aria-label="Zoom in"
                  disabled={!traces.length || window[1] - window[0] <= 0.001}
                  onClick={() => zoom(0.5)}
                >
                  <ZoomIn size={16} />
                </button>
                <button
                  aria-label="Zoom out"
                  disabled={window[1] - window[0] >= 1}
                  onClick={() => zoom(2)}
                >
                  <ZoomOut size={16} />
                </button>
                <button
                  aria-label="Pan plot right"
                  disabled={window[1] >= 1}
                  onClick={() => zoom(1, (window[1] - window[0]) / 4)}
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  aria-label="Fit entire plot"
                  onClick={() =>
                    setWindows((old) => ({ ...old, [windowKey]: [0, 1] }))
                  }
                >
                  <Maximize size={15} /> Fit
                </button>
              </fieldset>
            </div>
            {visibleIds.length ? (
              current?.error ? (
                <div className="scratchpad-empty" role="alert">
                  <p>{current.error}</p>
                  <button
                    className="secondary-button"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    Retry plot
                  </button>
                </div>
              ) : !current?.plots ? (
                <output className="scratchpad-empty">Loading plot…</output>
              ) : stacked ? (
                traces.map((trace) => (
                  <div className="scratchpad-stack" key={trace.node.id}>
                    <div className="scratchpad-axis-label">
                      <i style={{ background: trace.color }} />
                      <strong>{trace.label}</strong>
                      <span>
                        {trace.node.unit} ·{' '}
                        {graph.timeReferences.get(trace.node.id)?.name}
                      </span>
                    </div>
                    <SignalChart
                      traces={[trace]}
                      segments={[]}
                      range={zoomRange(
                        clocks.size > 1
                          ? graph.ranges.get(trace.node.id)!
                          : fullRange,
                      )}
                      onSegment={() => {}}
                      fluid
                      height={traces.length > 1 ? 185 : 340}
                      heading={false}
                      grid={sheet.grid}
                      includeZero={false}
                    />
                  </div>
                ))
              ) : (
                <>
                  <div className="scratchpad-axis-label">
                    <span>{traces[0]?.node.unit || 'Value'}</span>
                    <span>
                      {graph.timeReferences.get(visibleIds[0])?.name} · time (s)
                    </span>
                  </div>
                  <SignalChart
                    traces={traces}
                    segments={[]}
                    range={zoomRange(fullRange)}
                    onSegment={() => {}}
                    fluid
                    height={340}
                    heading={false}
                    grid={sheet.grid}
                    includeZero={false}
                  />
                </>
              )
            ) : (
              <div className="scratchpad-empty">
                <ChartNoAxesCombined size={38} />
                <h2>
                  {sheet.traces.length
                    ? 'No visible traces'
                    : saved
                      ? 'A fresh canvas'
                      : 'Your selection, in focus'}
                </h2>
                <p>
                  {sheet.traces.length
                    ? 'Show a trace below, or add another signal.'
                    : saved
                      ? 'Add signals to compare them here. This plot stays put as you explore.'
                      : 'Select a signal in History. Keep a plot when you want to build on it.'}
                </p>
                {saved && (
                  <button className="secondary-button" onClick={openPicker}>
                    <Plus size={16} /> Add signals
                  </button>
                )}
              </div>
            )}
            <div className="scratchpad-axis-footer">
              <span>
                {clocks.size > 1
                  ? 'Separate time references · independent time axes'
                  : !canOverlay
                    ? 'Different units · separate value axes'
                    : stacked
                      ? 'Shared time axis · separate value axes'
                      : 'Shared time & value axes'}
              </span>
              <span>
                {formatValue(100 / (window[1] - window[0]), 0)}% · hover to
                inspect preview
              </span>
            </div>
          </div>
          {saved ? (
            <div className="scratchpad-traces" aria-label="Plot traces">
              <div className="scratchpad-trace-heading">
                <span>TRACES</span>
                <span>Value range · all samples</span>
              </div>
              {sheet.traces.map((trace) => {
                const node = index.nodes.get(trace.id),
                  plot = plots.get(trace.id);
                return (
                  <div
                    className="scratchpad-trace"
                    key={trace.id}
                    data-hidden={!trace.visible}
                  >
                    <button
                      className="workflow-icon-button"
                      aria-label={`${trace.visible ? 'Hide' : 'Show'} trace ${index.label(trace.id)}`}
                      aria-pressed={trace.visible}
                      onClick={() =>
                        update({
                          traces: sheet.traces.map((item) =>
                            item.id === trace.id
                              ? { ...item, visible: !item.visible }
                              : item,
                          ),
                        })
                      }
                    >
                      {trace.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                    <input
                      type="color"
                      aria-label={`Color for ${index.label(trace.id)}`}
                      value={trace.color}
                      onChange={(event) =>
                        update({
                          traces: sheet.traces.map((item) =>
                            item.id === trace.id
                              ? { ...item, color: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                    <button
                      className="scratchpad-trace-name"
                      disabled={!node}
                      title="Inspect signal in History"
                      onClick={() => onInspect(trace.id)}
                    >
                      <strong>
                        {node ? index.label(trace.id) : 'Signal unavailable'}
                      </strong>
                      <small>
                        {node
                          ? graph.timeReferences.get(trace.id)?.name
                          : 'Removed from workspace · Undo can restore it'}
                      </small>
                    </button>
                    <span className="scratchpad-trace-range">
                      {plot
                        ? `${formatValue(plot.summary.min)} – ${formatValue(plot.summary.max)}`
                        : '—'}{' '}
                      <small>{node?.unit}</small>
                    </span>
                    <button
                      className="workflow-icon-button"
                      aria-label={`Remove trace ${index.label(trace.id)}`}
                      onClick={() =>
                        update({
                          traces: sheet.traces.filter(
                            (item) => item.id !== trace.id,
                          ),
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            mainPlot && (
              <div className="scratchpad-stats">
                <div>
                  <small>FINITE SAMPLES</small>
                  <strong>{mainPlot.summary.count.toLocaleString()}</strong>
                </div>
                <div>
                  <small>MINIMUM</small>
                  <strong>{formatValue(mainPlot.summary.min, 3)}</strong>
                </div>
                <div>
                  <small>MAXIMUM</small>
                  <strong>{formatValue(mainPlot.summary.max, 3)}</strong>
                </div>
                <div>
                  <small>SAMPLE AVERAGE</small>
                  <strong>{formatValue(mainPlot.summary.mean, 3)}</strong>
                </div>
              </div>
            )
          )}
          {isActive && activeId && (
            <SignalSamples
              key={activeId}
              id={activeId}
              project={project}
              unit={index.nodes.get(activeId)?.unit ?? ''}
              request={request}
              onExport={onExport}
              busy={busy}
            />
          )}
        </TabsContent>
      </Tabs>
      {closed && (
        <div className="scratchpad-closed" aria-live="polite">
          <span>Closed “{closed.sheet.name}”</span>
          <button
            className="workflow-link"
            disabled={sheets.length >= MAX_PLOT_TABS}
            onClick={() => {
              setSheets((old) => {
                const next = [...old];
                next.splice(closed.position, 0, closed.sheet);
                return next;
              });
              onView(closed.sheet.id);
              setClosed(undefined);
            }}
          >
            Reopen
          </button>
          <button
            className="workflow-icon-button"
            aria-label="Dismiss closed plot"
            onClick={() => setClosed(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {storageError && (
        <p className="scratchpad-storage-error" role="alert">
          {storageError}
        </p>
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="workflow-dialog scratchpad-rename">
          <DialogTitle>Rename plot</DialogTitle>
          <DialogDescription>
            Give this comparison a name you will recognise.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) {
                update({ name: name.trim().slice(0, 80) });
                setRenaming(false);
              }
            }}
          >
            <input
              aria-label="Plot name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <button className="primary-button" disabled={!name.trim()}>
              Save name
            </button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="workflow-dialog scratchpad-picker">
          <DialogTitle>Signals in this plot</DialogTitle>
          <DialogDescription>
            Choose up to {MAX_PLOT_TRACES} traces. Signals with different units
            or time references use stacked axes.
          </DialogDescription>
          <label className="scratchpad-search">
            <Search size={16} />
            <input
              aria-label="Search plot signals"
              placeholder="Search signals, units or time references…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPickerPage(0);
              }}
            />
          </label>
          <div className="scratchpad-picker-actions">
            <span>
              {draft.length} / {MAX_PLOT_TRACES} selected
            </span>
            <button
              className="workflow-link"
              disabled={!checkedIds.length}
              onClick={() =>
                setDraft([...new Set(checkedIds)].slice(0, MAX_PLOT_TRACES))
              }
            >
              Use checked inputs
              {checkedIds.length > MAX_PLOT_TRACES
                ? ` (first ${MAX_PLOT_TRACES})`
                : ''}
            </button>
            <button className="workflow-link" onClick={() => setDraft([])}>
              Clear
            </button>
          </div>
          <div className="scratchpad-choices">
            {matches.slice(safePage * 30, (safePage + 1) * 30).map((node) => (
              <label key={node.id} htmlFor={`plot-choice-${node.id}`}>
                <Checkbox
                  id={`plot-choice-${node.id}`}
                  checked={draft.includes(node.id)}
                  disabled={
                    !draft.includes(node.id) && draft.length >= MAX_PLOT_TRACES
                  }
                  onCheckedChange={(checked) =>
                    setDraft((old) =>
                      checked
                        ? [...old, node.id]
                        : old.filter((id) => id !== node.id),
                    )
                  }
                />
                <span>
                  <strong>{index.label(node.id)}</strong>
                  <small>
                    {node.unit} · {graph.timeReferences.get(node.id)?.name}
                  </small>
                </span>
              </label>
            ))}
            {!matches.length && <p>No signals match this search.</p>}
          </div>
          <div className="scratchpad-picker-actions">
            <button
              className="workflow-icon-button"
              aria-label="Previous signal choices"
              disabled={!safePage}
              onClick={() => setPickerPage(safePage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {matches.length ? safePage * 30 + 1 : 0}–
              {Math.min(matches.length, (safePage + 1) * 30)} of{' '}
              {matches.length}
            </span>
            <button
              className="workflow-icon-button"
              aria-label="Next signal choices"
              disabled={(safePage + 1) * 30 >= matches.length}
              onClick={() => setPickerPage(safePage + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <button
              className="primary-button"
              onClick={() => {
                if (saved)
                  update({
                    traces: draft.map(
                      (id, i) =>
                        saved.traces.find((trace) => trace.id === id) ?? {
                          id,
                          visible: true,
                          color: TRACE_COLORS[i],
                        },
                    ),
                  });
                else create(draft);
                setPicker(false);
              }}
            >
              Apply signals
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SignalSamples({
  id,
  unit,
  project,
  request,
  onExport,
  busy,
}: {
  id: string;
  unit: string;
  project: Project;
  request: Props['request'];
  onExport: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0);
  const [state, setState] = useState<{
    project: Project;
    page: number;
    rows?: Point[];
    more?: boolean;
    error?: string;
  }>();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void request({ type: 'rows', id, offset: page * 100, inspection: true })
      .then((response) => {
        if (alive && response.type === 'rows')
          setState({
            project,
            page,
            rows: response.rows,
            more: response.hasMore,
          });
      })
      .catch((error: unknown) => {
        if (alive)
          setState({
            project,
            page,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to read samples.',
          });
      });
    return () => {
      alive = false;
    };
  }, [open, page, project, id, request]);
  const current =
    state?.project === project && state.page === page ? state : undefined;
  return (
    <div className="scratchpad-samples">
      <div className="scratchpad-sample-actions">
        <button
          className="workflow-link"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Table2 size={15} />
          {open ? 'Hide samples' : 'View samples'}
        </button>
        <button className="workflow-link" disabled={busy} onClick={onExport}>
          <Download size={15} /> Export / report
        </button>
      </div>
      {open && (
        <div className="workflow-samples">
          {current?.error ? (
            <p role="alert">{current.error}</p>
          ) : !current?.rows ? (
            <output>Loading samples…</output>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time (s)</TableHead>
                    <TableHead>Value ({unit})</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.rows.map(([time, value], i) => (
                    <TableRow key={i}>
                      <TableCell>{formatValue(time, 3)}</TableCell>
                      <TableCell>{formatValue(value, 3)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="workflow-pager">
                <button
                  aria-label="Previous samples"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Samples {current.rows.length ? page * 100 + 1 : 0}–
                  {page * 100 + current.rows.length}
                </span>
                <button
                  aria-label="Next samples"
                  disabled={!current.more}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
