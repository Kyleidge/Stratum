'use client';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Grid2X2,
  Hand,
  Hash,
  HelpCircle,
  Layers2,
  Layers3,
  ListChecks,
  LockKeyhole,
  Maximize,
  Moon,
  MoveHorizontal,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Redo2,
  Scissors,
  Search,
  Settings2,
  Sigma,
  Sun,
  Table2,
  Trash2,
  Undo2,
  Waves,
  X,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import MockupChart, {
  type ChartReference,
  type ChartTool,
  type ChartTrace,
} from './mockup-chart';
import {
  ancestry,
  formatExact,
  formatNumber,
  lowerBound,
  MOCK,
  stepOf,
  stepRef,
  usedBy,
  type MockOutput,
  type MockSignal,
  type MockStep,
  type MockValue,
} from '@/lib/mockup-data';

type Selection = { kind: 'step' | 'output'; id: string };
type Filter = 'all' | 'signals' | 'values';
type DockTab = 'outputs' | 'samples' | 'settings';

const STEP_ICON: Record<MockStep['kind'], LucideIcon> = {
  import: FileSpreadsheet,
  derive: Sigma,
  segment: Scissors,
  value: Hash,
};
const OUTPUT_ICON: Record<MockOutput['kind'], LucideIcon> = {
  original: LockKeyhole,
  derived: Activity,
  value: Hash,
};
const KIND_LABEL: Record<MockOutput['kind'], string> = {
  original: 'Original signal',
  derived: 'Derived signal',
  value: 'Value',
};
const STEP_LABEL: Record<MockStep['kind'], string> = {
  import: 'Import',
  derive: 'Derive',
  segment: 'Segment',
  value: 'Value',
};

const output = (id: string) => MOCK.outputs.get(id)!;
const signal = (id: string) => MOCK.outputs.get(id) as MockSignal;
const isSignal = (item: MockOutput): item is MockSignal =>
  item.kind !== 'value';

/** Colour follows the entity: its position within the operation that made it. */
function seriesColor(id: string) {
  const step = stepOf(id)!;
  return `var(--mk-series-${(step.outputs.indexOf(id) % 3) + 1})`;
}

function interval(item: MockSignal) {
  return `${formatExact(item.t[0])}–${formatExact(item.t[item.t.length - 1])} s`;
}

function Sparkline({ item }: { item: MockSignal }) {
  const stride = Math.max(1, Math.floor(item.v.length / 60));
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of item.v) {
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  const points: string[] = [];
  for (let i = 0; i < item.v.length; i += stride)
    points.push(
      `${((i / (item.v.length - 1)) * 88 + 2).toFixed(1)},${(20 - ((item.v[i] - lo) / (hi - lo || 1)) * 16).toFixed(1)}`,
    );
  return (
    <svg className="mk-sparkline" viewBox="0 0 92 24" aria-hidden="true">
      <polyline
        points={points.join(' ')}
        style={{ stroke: seriesColor(item.id) }}
      />
    </svg>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon: LucideIcon; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mk-segmented">
      <legend className="sr-only">{label}</legend>
      {options.map(({ value: option, label: text, icon: Icon, disabled }) => (
        <button
          key={option}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
          title={text}
        >
          <Icon size={14} />
          <span>{text}</span>
        </button>
      ))}
    </fieldset>
  );
}

function Toggle({
  pressed,
  onChange,
  icon: Icon,
  children,
  disabled,
  title,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  icon: LucideIcon;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className="mk-tool"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!pressed)}
    >
      <Icon size={14} />
      <span>{children}</span>
    </button>
  );
}

function KindChip({ kind }: { kind: MockOutput['kind'] }) {
  return (
    <span className="mk-kind" data-kind={kind}>
      <i />
      {KIND_LABEL[kind]}
    </span>
  );
}

export default function UiRefreshMockup() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [selection, setSelection] = useState<Selection>({
    kind: 'step',
    id: 's5',
  });
  const [history, setHistory] = useState<Selection[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<'overlay' | 'stacked'>('overlay');
  const [tool, setTool] = useState<ChartTool>('pan');
  const [grid, setGrid] = useState(true);
  const [holdY, setHoldY] = useState(false);
  const [align, setAlign] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dock, setDock] = useState<DockTab>('outputs');
  const [dockOpen, setDockOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const step =
    selection.kind === 'step'
      ? MOCK.steps.find((item) => item.id === selection.id)!
      : stepOf(selection.id)!;
  const selected =
    selection.kind === 'output' ? output(selection.id) : undefined;
  const lineage = useMemo(
    () => ancestry(selected ? [selected.id] : step.outputs),
    [selected, step],
  );
  const consumers = selected
    ? usedBy(selected.id)
    : MOCK.steps.filter((item) =>
        item.inputs.some((id) => step.outputs.includes(id)),
      );

  // What the plot shows for the current selection.
  const plotted = useMemo(() => {
    const values: MockValue[] = [];
    let ids: string[];
    if (selected?.kind === 'value') {
      values.push(selected);
      ids = selected.inputs;
    } else if (selected) ids = [selected.id];
    else if (step.kind === 'value') {
      values.push(...step.outputs.map((id) => output(id) as MockValue));
      ids = step.inputs;
    } else ids = step.outputs;
    return { ids, values };
  }, [selected, step]);
  const alignable =
    plotted.ids.length > 1 &&
    new Set(plotted.ids.map((id) => signal(id).t[0])).size > 1;
  const aligned = align && alignable;
  const traces: ChartTrace[] = plotted.ids
    .filter((id) => !hidden.has(id))
    .map((id) => {
      const item = signal(id);
      return {
        id,
        label: item.label,
        short: item.short,
        unit: item.unit,
        color: seriesColor(id),
        t: item.t,
        v: item.v,
        offset: aligned ? item.t[0] : 0,
      };
    });
  const references: ChartReference[] = plotted.values
    .filter((value) => !hidden.has(value.inputs[0]))
    .map((value) => {
      const input = signal(value.inputs[0]);
      return {
        id: value.id,
        traceId: input.id,
        value: value.value,
        label: `${value.fn === 'Maximum' ? 'max' : 'avg'} ${formatNumber(value.value)}`,
        t0: value.fn === 'Maximum' ? value.at! - 2 : input.t[0],
        t1:
          value.fn === 'Maximum' ? value.at! + 2 : input.t[input.t.length - 1],
      };
    });

  const scopeIds = checked.size
    ? [...checked]
    : plotted.ids.filter((id) => output(id).kind !== 'value');
  const scopeLabel = checked.size
    ? `${checked.size} checked signal${checked.size === 1 ? '' : 's'}`
    : scopeIds.length === 1
      ? output(scopeIds[0]).label
      : `${scopeIds.length} signals · ${stepRef(stepOf(scopeIds[0])!)}`;

  function select(next: Selection) {
    if (next.kind === selection.kind && next.id === selection.id) return;
    setHistory((old) => [...old.slice(-50), selection]);
    setSelection(next);
    setHidden(new Set());
    setRailOpen(false);
  }
  function say(message: string) {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }
  function command(name: string) {
    say(
      `Mockup: ${name} opens its settings dialog for ${scopeLabel} in the full app.`,
    );
  }

  const needle = query.trim().toLowerCase();
  const visibleOutputs = (item: MockStep) =>
    item.outputs.filter((id) => {
      const entry = output(id);
      if (filter === 'signals' && entry.kind === 'value') return false;
      if (filter === 'values' && entry.kind !== 'value') return false;
      return (
        !needle ||
        `${entry.label} ${entry.unit}`.toLowerCase().includes(needle) ||
        `${stepRef(item)} ${item.name}`.toLowerCase().includes(needle)
      );
    });
  const originals = [...MOCK.outputs.values()].filter(
    (item) => item.kind === 'original',
  ).length;
  const derived = [...MOCK.outputs.values()].filter(
    (item) => item.kind === 'derived',
  ).length;
  const values = MOCK.outputs.size - originals - derived;

  const title = selected ? selected.label : step.name;
  const subtitle = selected
    ? `${KIND_LABEL[selected.kind]} · ${stepRef(step)} ${step.name}`
    : `${STEP_LABEL[step.kind]} · ${step.outputs.length} output${step.outputs.length === 1 ? '' : 's'} · ${step.summary}`;
  const samplesTrace = traces[0];
  const sampleRows = useMemo(() => {
    if (!traces.length) return [];
    const start = Math.max(
      Math.min(...traces.map((trace) => trace.t[0] - trace.offset)),
      cursor ?? -Infinity,
    );
    return Array.from({ length: 40 }, (_, row) => {
      const time = Math.round((start + row / 10) * 10) / 10;
      return {
        time,
        cells: traces.map((trace) => {
          const i = lowerBound(trace.t, time + trace.offset - 1e-6);
          return i < trace.t.length &&
            Math.abs(trace.t[i] - trace.offset - time) < 1e-6
            ? trace.v[i]
            : undefined;
        }),
      };
    });
  }, [traces, cursor]);

  const inspectorItem = selected;
  const lineageSteps = MOCK.steps.filter((item) =>
    item.outputs.some((id) => lineage.has(id)),
  );

  return (
    <div
      className="mk-app"
      data-theme={theme}
      data-rail={railOpen}
      data-inspector={inspectorOpen}
    >
      <header className="mk-topbar">
        <button
          className="mk-icon mk-rail-toggle"
          aria-label="Toggle history"
          aria-expanded={railOpen}
          onClick={() => setRailOpen((open) => !open)}
        >
          <PanelLeft size={16} />
        </button>
        <div className="mk-brand">
          <Waves size={18} />
          <strong>Stratum</strong>
        </div>
        <button className="mk-workspace" title="Scope: recordings and results">
          <FileSpreadsheet size={14} />
          <span>Motor test · three runs</span>
          <ChevronDown size={14} />
        </button>
        <div className="mk-divider" />
        <button className="mk-icon" aria-label="Undo" title="Undo · Ctrl+Z">
          <Undo2 size={16} />
        </button>
        <button
          className="mk-icon"
          aria-label="Redo"
          title="Redo · Ctrl+Y"
          disabled
        >
          <Redo2 size={16} />
        </button>
        <div className="mk-divider" />
        <nav className="mk-commands" aria-label="Operations">
          <button onClick={() => command('Derive')} title="Apply a function">
            <Sigma size={15} />
            <span>Derive</span>
          </button>
          <button
            onClick={() => command('Segment')}
            title="Split by ranges, windows or triggers"
          >
            <Scissors size={15} />
            <span>Segment</span>
          </button>
          <button
            onClick={() => command('Value')}
            title="Average, minimum or maximum"
          >
            <Hash size={15} />
            <span>Value</span>
          </button>
          <button
            onClick={() => command('Compare & align')}
            title="Align recordings on a shared time base"
          >
            <Layers2 size={15} />
            <span>Compare</span>
          </button>
          <div className="mk-scope" data-checked={checked.size > 0}>
            <button
              title="Processing inputs are independent of what you are viewing. Check outputs in the table to choose them."
              onClick={() => {
                setDock('outputs');
                setDockOpen(true);
              }}
            >
              <ListChecks size={14} />
              <span className="mk-scope-label">Apply to</span>
              <strong>{scopeLabel}</strong>
            </button>
            {checked.size > 0 && (
              <button
                aria-label="Clear checked inputs"
                onClick={() => setChecked(new Set())}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </nav>
        <div className="mk-topbar-end">
          <button
            className="mk-search-trigger"
            onClick={() =>
              say('Mockup: Ctrl+K opens a command and output search.')
            }
          >
            <Search size={14} />
            <span>Search or run a command</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button
            className="mk-button"
            onClick={() => say('Mockup: opens the CSV file picker.')}
          >
            <ArrowDownToLine size={14} />
            <span>Import</span>
          </button>
          <button
            className="mk-icon"
            aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            title="Toggle light and dark theme"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            className="mk-icon"
            aria-label="Guide"
            title="Guide and shortcuts"
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </header>

      <div className="mk-body">
        <aside className="mk-rail" aria-label="Operation history">
          <div className="mk-rail-head">
            <strong>History</strong>
            <small>{MOCK.steps.length} steps · oldest first</small>
          </div>
          <label className="mk-field">
            <Search size={14} />
            <input
              placeholder="Filter steps and outputs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button aria-label="Clear filter" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>
          <fieldset className="mk-chips">
            <legend className="sr-only">Output type</legend>
            {(['all', 'signals', 'values'] as const).map((item) => (
              <button
                key={item}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                {item === 'all'
                  ? 'All'
                  : item === 'signals'
                    ? 'Signals'
                    : 'Values'}
              </button>
            ))}
          </fieldset>
          <ol className="mk-timeline">
            {MOCK.steps.map((item) => {
              const outputs = visibleOutputs(item);
              if (!outputs.length && needle) return null;
              const Icon = STEP_ICON[item.kind];
              const open = !collapsed.has(item.id) || !!needle;
              const active =
                selection.kind === 'step' && selection.id === item.id;
              return (
                <li
                  key={item.id}
                  className="mk-step"
                  data-kind={item.kind}
                  data-lineage={lineageSteps.includes(item)}
                >
                  <div className="mk-step-row" data-selected={active}>
                    <button
                      className="mk-disclosure"
                      aria-label={open ? 'Collapse outputs' : 'Expand outputs'}
                      aria-expanded={open}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      {open ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                    </button>
                    <button
                      className="mk-step-main"
                      onClick={() => select({ kind: 'step', id: item.id })}
                      title={`${stepRef(item)} ${item.name} · ${item.summary}`}
                    >
                      <span className="mk-node" aria-label={stepRef(item)}>
                        {item.sequence}
                      </span>
                      <span className="mk-step-text">
                        <span className="mk-step-name">{item.name}</span>
                        <small>
                          <Icon size={11} />
                          {STEP_LABEL[item.kind]} · {item.summary}
                          {item.revision > 1 ? ` · rev ${item.revision}` : ''}
                        </small>
                      </span>
                      <span className="mk-count">{item.outputs.length}</span>
                    </button>
                  </div>
                  {open && (
                    <ul className="mk-outputs">
                      {outputs.map((id) => {
                        const entry = output(id);
                        const OutputIcon = OUTPUT_ICON[entry.kind];
                        return (
                          <li key={id}>
                            <button
                              className="mk-output-row"
                              data-kind={entry.kind}
                              data-selected={
                                selection.kind === 'output' &&
                                selection.id === id
                              }
                              data-lineage={lineage.has(id)}
                              onClick={() => select({ kind: 'output', id })}
                              title={`${entry.label} · ${KIND_LABEL[entry.kind]}`}
                            >
                              <OutputIcon size={13} />
                              <span>{entry.label}</span>
                              <small>
                                {entry.kind === 'value'
                                  ? formatNumber(entry.value)
                                  : entry.unit}
                              </small>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="mk-rail-hint">
            <span className="mk-lineage-key" /> Contributes to the selection
          </p>
        </aside>

        <main className="mk-document">
          <div className="mk-tabs" role="tablist" aria-label="Plots">
            <button role="tab" aria-selected="true">
              <Activity size={14} />
              Active selection
            </button>
            <button
              role="tab"
              aria-selected="false"
              onClick={() =>
                say(
                  'Mockup: saved plots keep their own traces, limits and annotations.',
                )
              }
            >
              <Pin size={13} />
              Speed vs torque
            </button>
            <button
              className="mk-tab-add"
              aria-label="New plot"
              onClick={() => say('Mockup: creates an empty saved plot.')}
            >
              <Plus size={14} />
            </button>
            <div className="mk-tabs-end">
              <button
                className="mk-icon mk-inspector-toggle"
                aria-label="Toggle inspector"
                aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen((open) => !open)}
              >
                <PanelRight size={16} />
              </button>
            </div>
          </div>

          <section className="mk-plot">
            <div className="mk-plot-head">
              <div>
                <h1>{title}</h1>
                <p>{subtitle}</p>
              </div>
              <div className="mk-plot-actions">
                {history.length > 0 && (
                  <button
                    className="mk-button mk-quiet"
                    onClick={() => {
                      const previous = history[history.length - 1];
                      setHistory((old) => old.slice(0, -1));
                      setSelection(previous);
                    }}
                  >
                    Back
                  </button>
                )}
                <button
                  className="mk-button"
                  onClick={() => say('Mockup: pins this view as a saved plot.')}
                >
                  <Pin size={14} />
                  Keep plot
                </button>
              </div>
            </div>

            {plotted.values.length > 0 && (
              <div className="mk-stats">
                {plotted.values.map((value) => (
                  <button
                    key={value.id}
                    className="mk-stat"
                    data-selected={selected?.id === value.id}
                    onClick={() => select({ kind: 'output', id: value.id })}
                  >
                    <span>
                      <i style={{ background: seriesColor(value.inputs[0]) }} />
                      {value.label}
                    </span>
                    <strong>
                      {formatNumber(value.value)} <small>{value.unit}</small>
                    </strong>
                    <em>
                      {value.fn}
                      {value.at !== undefined
                        ? ` · at ${formatExact(value.at)} s`
                        : ` · ${value.samples.toLocaleString('en-US')} samples`}
                    </em>
                  </button>
                ))}
              </div>
            )}

            <div className="mk-toolbar" role="toolbar" aria-label="Plot tools">
              <Segmented
                label="Layout"
                value={layout}
                onChange={setLayout}
                options={[
                  { value: 'overlay', label: 'Overlay', icon: Layers3 },
                  { value: 'stacked', label: 'Stacked', icon: Table2 },
                ]}
              />
              <Segmented
                label="Pointer tool"
                value={tool}
                onChange={setTool}
                options={[
                  { value: 'pan', label: 'Pan', icon: Hand },
                  { value: 'zoom', label: 'Zoom', icon: ZoomIn },
                  { value: 'measure', label: 'Measure', icon: Crosshair },
                ]}
              />
              <button
                className="mk-tool"
                onClick={() => setFitKey((key) => key + 1)}
                title="Fit all data · 0"
              >
                <Maximize size={14} />
                <span>Fit</span>
              </button>
              <Toggle
                pressed={holdY}
                onChange={setHoldY}
                icon={LockKeyhole}
                title="Keep the value scale while panning"
              >
                Hold Y
              </Toggle>
              <Toggle
                pressed={aligned}
                onChange={setAlign}
                icon={MoveHorizontal}
                disabled={!alignable}
                title="Plot each segment from its own start time"
              >
                Align starts
              </Toggle>
              <span className="mk-toolbar-gap" />
              <Toggle
                pressed={grid}
                onChange={setGrid}
                icon={Grid2X2}
                title="Grid lines"
              >
                Grid
              </Toggle>
              <button
                className="mk-tool"
                onClick={() =>
                  say('Mockup: exports the displayed plot as SVG or PNG.')
                }
              >
                <Download size={14} />
                <span>Export</span>
              </button>
            </div>

            {plotted.ids.length > 1 && (
              <div className="mk-legend" aria-label="Traces">
                {plotted.ids.map((id) => {
                  const item = signal(id);
                  const off = hidden.has(id);
                  return (
                    <button
                      key={id}
                      aria-pressed={!off}
                      title={off ? 'Show trace' : 'Hide trace'}
                      onClick={() =>
                        setHidden((old) => {
                          const next = new Set(old);
                          if (off) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                    >
                      <i style={{ background: seriesColor(id) }} />
                      <span>{item.label}</span>
                      <small>{item.unit}</small>
                      {off ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  );
                })}
                {new Set(traces.map((trace) => trace.unit)).size > 1 &&
                  layout === 'overlay' && (
                    <span className="mk-legend-note">
                      Different units plot in separate lanes on one time axis
                    </span>
                  )}
              </div>
            )}

            {traces.length ? (
              <MockupChart
                traces={traces}
                references={references}
                layout={layout}
                tool={tool}
                grid={grid}
                holdY={holdY}
                fitKey={fitKey}
                timeLabel={
                  aligned ? 'Time from segment start (s)' : 'Recording time (s)'
                }
                onCursor={setCursor}
              />
            ) : (
              <div className="mk-empty">
                All traces are hidden. Choose one in the legend.
              </div>
            )}
          </section>

          <section className="mk-dock" data-open={dockOpen}>
            <div className="mk-dock-head">
              <div role="tablist" aria-label="Details">
                {(
                  [
                    ['outputs', `Outputs`, step.outputs.length],
                    ['samples', 'Samples', undefined],
                    ['settings', 'Settings', undefined],
                  ] as const
                ).map(([key, text, count]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={dock === key}
                    onClick={() => {
                      setDock(key);
                      setDockOpen(true);
                    }}
                  >
                    {text}
                    {count !== undefined && (
                      <span className="mk-count">{count}</span>
                    )}
                  </button>
                ))}
              </div>
              <span className="mk-dock-context">
                {dock === 'samples' && samplesTrace
                  ? `Exact samples from ${formatExact(sampleRows[0]?.time ?? 0)} s${cursor !== null ? ' · following cursor' : ''}`
                  : `${stepRef(step)} ${step.name}`}
              </span>
              <button
                className="mk-button mk-quiet"
                onClick={() =>
                  say('Mockup: exports values, samples or a printable report.')
                }
              >
                <Download size={14} />
                Export / report
              </button>
              <button
                className="mk-icon"
                aria-label={dockOpen ? 'Collapse panel' : 'Expand panel'}
                aria-expanded={dockOpen}
                onClick={() => setDockOpen((open) => !open)}
              >
                <PanelBottom size={16} />
              </button>
            </div>
            {dockOpen && (
              <div className="mk-dock-body">
                {dock === 'outputs' && (
                  <table className="mk-table">
                    <thead>
                      <tr>
                        <th className="mk-check">
                          <span className="sr-only">Use as input</span>
                        </th>
                        <th>Output</th>
                        <th>Type</th>
                        <th className="mk-col-preview">Preview</th>
                        <th>From</th>
                        <th>Interval</th>
                        <th className="mk-num">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {step.outputs.map((id) => {
                        const entry = output(id);
                        const OutputIcon = OUTPUT_ICON[entry.kind];
                        const source = entry.inputs[0]
                          ? output(entry.inputs[0])
                          : undefined;
                        return (
                          <tr key={id} data-selected={selected?.id === id}>
                            <td className="mk-check">
                              {entry.kind !== 'value' && (
                                <input
                                  type="checkbox"
                                  aria-label={`Use ${entry.label} as a processing input`}
                                  checked={checked.has(id)}
                                  onChange={(event) =>
                                    setChecked((old) => {
                                      const next = new Set(old);
                                      if (event.target.checked) next.add(id);
                                      else next.delete(id);
                                      return next;
                                    })
                                  }
                                />
                              )}
                            </td>
                            <td>
                              <button
                                className="mk-cell-link mk-strong"
                                onClick={() => select({ kind: 'output', id })}
                              >
                                <OutputIcon size={13} />
                                {entry.label}
                              </button>
                            </td>
                            <td>
                              <KindChip kind={entry.kind} />
                            </td>
                            <td className="mk-col-preview">
                              {isSignal(entry) ? (
                                <Sparkline item={entry} />
                              ) : (
                                <span className="mk-muted">{entry.fn}</span>
                              )}
                            </td>
                            <td>
                              {source ? (
                                <button
                                  className="mk-cell-link"
                                  onClick={() =>
                                    select({ kind: 'output', id: source.id })
                                  }
                                >
                                  {stepRef(stepOf(source.id)!)} {source.label}
                                </button>
                              ) : (
                                <span className="mk-muted">Recording</span>
                              )}
                            </td>
                            <td className="mk-tabular">
                              {isSignal(entry)
                                ? interval(entry)
                                : interval(signal(entry.inputs[0]))}
                            </td>
                            <td className="mk-num">
                              {entry.kind === 'value'
                                ? formatExact(entry.value)
                                : `${entry.t.length.toLocaleString('en-US')} samples`}{' '}
                              <span className="mk-muted">{entry.unit}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {dock === 'samples' && (
                  <table className="mk-table mk-samples">
                    <thead>
                      <tr>
                        <th className="mk-num">
                          {aligned ? 'Time from start (s)' : 'Time (s)'}
                        </th>
                        {traces.map((trace) => (
                          <th key={trace.id} className="mk-num">
                            <i style={{ background: trace.color }} />
                            {trace.short} ({trace.unit})
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sampleRows.map((row) => (
                        <tr key={row.time}>
                          <td className="mk-num">{row.time.toFixed(1)}</td>
                          {row.cells.map((cell, i) => (
                            <td key={traces[i].id} className="mk-num">
                              {cell === undefined ? '' : formatExact(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {dock === 'settings' && (
                  <div className="mk-settings">
                    <dl className="mk-props">
                      <dt>Operation</dt>
                      <dd>
                        {stepRef(step)} {step.name}
                      </dd>
                      <dt>Revision</dt>
                      <dd>{step.revision}</dd>
                      {step.settings.map(([key, value]) => (
                        <FragmentRow key={key} term={key} value={value} />
                      ))}
                    </dl>
                    <button
                      className="mk-button"
                      onClick={() =>
                        say(
                          'Mockup: Edit rebuilds this operation and its dependants atomically.',
                        )
                      }
                    >
                      <Settings2 size={14} />
                      Edit settings
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>

        <aside className="mk-inspector" aria-label="Inspector">
          <div className="mk-inspector-head">
            <span className="mk-eyebrow">
              {inspectorItem ? (
                <KindChip kind={inspectorItem.kind} />
              ) : (
                <span className="mk-kind" data-kind="step">
                  <i />
                  {STEP_LABEL[step.kind]} operation
                </span>
              )}
            </span>
            <h2>{inspectorItem ? inspectorItem.label : step.name}</h2>
            <button
              className="mk-icon"
              aria-label="Rename"
              title="Rename · F2"
              onClick={() => say('Mockup: renames in place.')}
            >
              <Pencil size={14} />
            </button>
          </div>

          {inspectorItem?.kind === 'value' && (
            <div className="mk-hero">
              <strong>{formatExact(inspectorItem.value)}</strong>
              <small>{inspectorItem.unit}</small>
            </div>
          )}

          <section className="mk-section">
            <h3>Properties</h3>
            <dl className="mk-props">
              {inspectorItem ? (
                <>
                  <dt>Produced by</dt>
                  <dd>
                    <button
                      className="mk-cell-link"
                      onClick={() => select({ kind: 'step', id: step.id })}
                    >
                      {stepRef(step)} {step.name}
                    </button>
                  </dd>
                  <dt>Unit</dt>
                  <dd>{inspectorItem.unit}</dd>
                  {isSignal(inspectorItem) ? (
                    <>
                      <dt>Samples</dt>
                      <dd>{inspectorItem.t.length.toLocaleString('en-US')}</dd>
                      <dt>Time range</dt>
                      <dd>{interval(inspectorItem)}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Function</dt>
                      <dd>{inspectorItem.fn}</dd>
                      <dt>Input samples</dt>
                      <dd>
                        {inspectorItem.samples.toLocaleString('en-US')} finite
                      </dd>
                      <dt>Valid duration</dt>
                      <dd>{formatExact(inspectorItem.duration)} s</dd>
                      {inspectorItem.at !== undefined && (
                        <>
                          <dt>First occurs</dt>
                          <dd>{formatExact(inspectorItem.at)} s</dd>
                        </>
                      )}
                    </>
                  )}
                  <dt>Time reference</dt>
                  <dd>Motor test · three runs</dd>
                </>
              ) : (
                <>
                  <dt>Step</dt>
                  <dd>
                    {stepRef(step)} · revision {step.revision}
                  </dd>
                  <dt>Outputs</dt>
                  <dd>{step.outputs.length}</dd>
                  {step.settings.slice(0, 3).map(([key, value]) => (
                    <FragmentRow key={key} term={key} value={value} />
                  ))}
                </>
              )}
            </dl>
          </section>

          <section className="mk-section">
            <h3>
              Lineage <small>{lineageSteps.length} steps</small>
            </h3>
            <ol className="mk-lineage">
              {lineageSteps.map((item) => {
                const Icon = STEP_ICON[item.kind];
                const contributing = item.outputs.filter((id) =>
                  lineage.has(id),
                );
                const current = item.id === step.id;
                return (
                  <li
                    key={item.id}
                    data-kind={item.kind}
                    data-current={current}
                  >
                    <span className="mk-node">
                      <Icon size={11} />
                    </span>
                    <div>
                      <button
                        className="mk-cell-link"
                        onClick={() => select({ kind: 'step', id: item.id })}
                      >
                        <code>{stepRef(item)}</code> {item.name}
                      </button>
                      <small>
                        {contributing.length === item.outputs.length &&
                        contributing.length > 1
                          ? `All ${contributing.length} outputs`
                          : contributing
                              .map((id) => output(id).short)
                              .join(', ')}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="mk-section">
            <h3>Used by</h3>
            {consumers.length ? (
              <ul className="mk-used-by">
                {consumers.map((item) => (
                  <li key={item.id}>
                    <button
                      className="mk-cell-link"
                      onClick={() => select({ kind: 'step', id: item.id })}
                    >
                      <code>{stepRef(item)}</code> {item.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mk-muted">No later operations use this yet.</p>
            )}
          </section>

          <div className="mk-inspector-actions">
            <button
              className="mk-button"
              onClick={() =>
                say(
                  'Mockup: Edit rebuilds this operation and its dependants atomically.',
                )
              }
            >
              <Settings2 size={14} />
              Edit settings
            </button>
            <button
              className="mk-button"
              onClick={() =>
                say('Mockup: duplicates the operation with the same settings.')
              }
            >
              <Copy size={14} />
              Duplicate
            </button>
            <button
              className="mk-button mk-danger"
              onClick={() =>
                say(
                  'Mockup: Delete first shows every dependent step it removes.',
                )
              }
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </aside>
      </div>

      <footer className="mk-status">
        <span className="mk-ready">
          <i /> Ready
        </span>
        <span>Saved locally</span>
        <output aria-live="polite">{notice}</output>
        <span className="mk-inventory">
          <span>
            <LockKeyhole size={12} /> {originals} originals
          </span>
          <span>
            <Activity size={12} /> {derived} derived
          </span>
          <span>
            <Hash size={12} /> {values} values
          </span>
        </span>
        <span className="mk-badge">UI refresh mockup · sample data</span>
      </footer>
      {railOpen && (
        <button
          className="mk-scrim"
          aria-label="Close history"
          onClick={() => setRailOpen(false)}
        />
      )}
    </div>
  );
}

function FragmentRow({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}
