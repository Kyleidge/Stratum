'use client';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  ArrowDownToLine,
  BookOpen,
  Check,
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
  RotateCcw,
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
  CommandPalette,
  DeleteDialog,
  GuideDialog,
  OperationDialog,
  type OperationKind,
  type PaletteItem,
} from './mockup-dialogs';
import {
  ancestry,
  apply,
  duplicate,
  edit,
  EXAMPLE,
  formatExact,
  formatNumber,
  importCsv,
  lowerBound,
  remove,
  rename,
  settings,
  stepKind,
  stepOf,
  stepRef,
  summary,
  usedBy,
  type MockOutput,
  type MockSignal,
  type MockStep,
  type MockStepKind,
  type MockValue,
  type Recipe,
  type Workspace,
} from '@/lib/mockup-data';

type Selection = { kind: 'step' | 'output'; id: string };
type Filter = 'all' | 'signals' | 'values';
type DockTab = 'outputs' | 'samples' | 'settings';
type Snapshot = { ws: Workspace; selection: Selection; label: string };
type SavedPlot = { id: string; name: string; ids: string[] };
type DialogState =
  | {
      type: 'operation';
      kind: OperationKind;
      inputs: string[];
      editing?: MockStep;
    }
  | { type: 'delete'; step: MockStep }
  | { type: 'guide' }
  | { type: 'palette' };

const DRAG_TYPE = 'application/x-stratum-mockup-output';
const MAX_TRACES = 8;
let plotCount = 1;
const nextPlotId = () => `p${++plotCount}`;

const STEP_ICON: Record<MockStepKind, LucideIcon> = {
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
const STEP_LABEL: Record<MockStepKind, string> = {
  import: 'Import',
  derive: 'Derive',
  segment: 'Segment',
  value: 'Value',
};

const isSignal = (item: MockOutput | undefined): item is MockSignal =>
  !!item && item.kind !== 'value';
const valueTag = (value: MockValue) =>
  value.fn === 'Time average' ? 'avg' : value.fn === 'Maximum' ? 'max' : 'min';

/**
 * Colour follows the entity: outputs of one operation keep their position in
 * it; a mixed set uses its own fixed order. Hiding a trace never recolours.
 */
function colorFor(ws: Workspace, id: string, ids: string[]) {
  const owners = new Set(ids.map((item) => stepOf(ws, item)?.id));
  const slot =
    owners.size === 1
      ? (stepOf(ws, id)?.outputs.indexOf(id) ?? 0)
      : ids.indexOf(id);
  return `var(--mk-series-${(Math.max(0, slot) % MAX_TRACES) + 1})`;
}

function interval(item: MockSignal) {
  return `${formatExact(item.t[0])}–${formatExact(item.t[item.t.length - 1])} s`;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]+/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV text cell: quoted so spreadsheets keep it as text. */
const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;

function Sparkline({ item, color }: { item: MockSignal; color: string }) {
  const stride = Math.max(1, Math.floor(item.v.length / 60));
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of item.v)
    if (Number.isFinite(value)) {
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
  const points: string[] = [];
  for (let i = 0; i < item.v.length; i += stride)
    if (Number.isFinite(item.v[i]))
      points.push(
        `${((i / Math.max(1, item.v.length - 1)) * 88 + 2).toFixed(1)},${(20 - ((item.v[i] - lo) / (hi - lo || 1)) * 16).toFixed(1)}`,
      );
  return (
    <svg className="mk-sparkline" viewBox="0 0 92 24" aria-hidden="true">
      <polyline points={points.join(' ')} style={{ stroke: color }} />
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
  options: { value: T; label: string; icon: LucideIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mk-segmented">
      <legend className="sr-only">{label}</legend>
      {options.map(({ value: option, label: text, icon: Icon }) => (
        <button
          key={option}
          aria-pressed={value === option}
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

function FragmentRow({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

export default function UiRefreshMockup() {
  const [ws, setWs] = useState<Workspace>(EXAMPLE);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [chosen, setChosen] = useState<Selection>({ kind: 'step', id: 's5' });
  const [trail, setTrail] = useState<Selection[]>([]);
  const [recording, setRecording] = useState('all');
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
  const [checkedIds, setChecked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [plots, setPlots] = useState<SavedPlot[]>([
    { id: 'p1', name: 'Speed vs torque', ids: ['speed', 'torque'] },
  ]);
  const [activePlot, setActivePlot] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [menu, setMenu] = useState<'workspace' | 'export' | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    undo?: boolean;
    error?: boolean;
  }>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const plotArea = useRef<HTMLDivElement>(null);

  // A deleted or undone selection falls back to the latest operation.
  const selection: Selection =
    (chosen.kind === 'step'
      ? ws.steps.some((step) => step.id === chosen.id)
      : ws.outputs.has(chosen.id)) || !ws.steps.length
      ? chosen
      : { kind: 'step', id: ws.steps[ws.steps.length - 1].id };
  const step =
    (selection.kind === 'step'
      ? ws.steps.find((item) => item.id === selection.id)
      : stepOf(ws, selection.id)) ?? ws.steps[0];
  const selected =
    selection.kind === 'output' ? ws.outputs.get(selection.id) : undefined;
  const checked = new Set(
    [...checkedIds].filter((id) => isSignal(ws.outputs.get(id))),
  );
  const saved = plots.find((plot) => plot.id === activePlot);

  const lineage = useMemo(
    () =>
      step ? ancestry(ws, selected ? [selected.id] : step.outputs) : new Set(),
    [ws, selected, step],
  );
  const consumers = step
    ? usedBy(ws, selected ? [selected.id] : step.outputs).filter(
        (item) => item.id !== step.id,
      )
    : [];

  // What the plot shows: the selection, or a saved plot's own traces.
  const plotted = useMemo(() => {
    const values: MockValue[] = [];
    let ids: string[] = [];
    if (saved) ids = saved.ids.filter((id) => isSignal(ws.outputs.get(id)));
    else if (selected?.kind === 'value') {
      values.push(selected);
      ids = selected.inputs;
    } else if (selected) ids = [selected.id];
    else if (step && stepKind(step) === 'value') {
      values.push(...step.outputs.map((id) => ws.outputs.get(id) as MockValue));
      ids = step.inputs;
    } else if (step) ids = step.outputs;
    return {
      ids: ids.filter((id) => isSignal(ws.outputs.get(id))),
      values,
    };
  }, [ws, saved, selected, step]);
  const shownIds = plotted.ids.slice(0, MAX_TRACES);
  const alignable =
    shownIds.length > 1 &&
    new Set(shownIds.map((id) => (ws.outputs.get(id) as MockSignal).t[0]))
      .size > 1;
  const aligned = align && alignable;
  const traces: ChartTrace[] = shownIds
    .filter((id) => !hidden.has(id))
    .map((id) => {
      const item = ws.outputs.get(id) as MockSignal;
      return {
        id,
        label: item.label,
        short: item.short,
        unit: item.unit,
        color: colorFor(ws, id, shownIds),
        t: item.t,
        v: item.v,
        offset: aligned ? item.t[0] : 0,
      };
    });
  const references: ChartReference[] = plotted.values
    .filter(
      (value) =>
        Number.isFinite(value.value) &&
        traces.some((trace) => trace.id === value.inputs[0]),
    )
    .map((value) => {
      const input = ws.outputs.get(value.inputs[0]) as MockSignal;
      const point = value.at !== undefined;
      return {
        id: value.id,
        traceId: input.id,
        value: value.value,
        label: `${valueTag(value)} ${formatNumber(value.value)}`,
        t0: point ? value.at! - 2 : input.t[0],
        t1: point ? value.at! + 2 : input.t[input.t.length - 1],
      };
    });

  const scopeIds = checked.size ? [...checked] : shownIds;
  const scopeLabel = checked.size
    ? `${checked.size} checked signal${checked.size === 1 ? '' : 's'}`
    : scopeIds.length === 0
      ? 'No signals'
      : scopeIds.length === 1
        ? (ws.outputs.get(scopeIds[0])?.label ?? '')
        : `${scopeIds.length} signals`;

  // Recording scope for the history rail.
  const shownSteps =
    recording === 'all'
      ? ws.steps
      : ws.steps.filter((item) => {
          const origin = ws.steps.find((entry) => entry.id === recording);
          if (!origin) return true;
          const roots = ancestry(ws, item.outputs);
          return origin.outputs.some((id) => roots.has(id));
        });
  const recordings = ws.steps.filter((item) => item.recipe.op === 'import');
  const scopeName =
    recordings.find((item) => item.id === recording)?.name ??
    'All recordings & results';

  // History, notifications and commits.
  function say(
    message: string,
    options: { undo?: boolean; error?: boolean } = {},
  ) {
    setToast({ message, ...options });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 5000);
  }
  function commit(next: Workspace, nextSelection: Selection, label: string) {
    setPast((old) => [...old.slice(-19), { ws, selection, label }]);
    setFuture([]);
    setWs(next);
    setChosen(nextSelection);
    setHidden(new Set());
    setActivePlot(null);
    say(label, { undo: true });
  }
  function undo() {
    const last = past[past.length - 1];
    if (!last) return;
    setPast((old) => old.slice(0, -1));
    setFuture((old) => [{ ws, selection, label: last.label }, ...old]);
    setWs(last.ws);
    setChosen(last.selection);
    say(`Undid: ${last.label}`);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((old) => old.slice(1));
    setPast((old) => [...old, { ws, selection, label: next.label }]);
    setWs(next.ws);
    setChosen(next.selection);
    say(`Redid: ${next.label}`);
  }
  function select(next: Selection) {
    setActivePlot(null);
    setRenaming(false);
    setRailOpen(false);
    if (next.kind === selection.kind && next.id === selection.id) return;
    setTrail((old) => [...old.slice(-50), selection]);
    setChosen(next);
    setHidden(new Set());
  }

  // Operations.
  function openOperation(kind: OperationKind) {
    const inputs = scopeIds.filter((id) => isSignal(ws.outputs.get(id)));
    if (!inputs.length) {
      say('Select a signal, or check outputs in the table, first.', {
        error: true,
      });
      return;
    }
    setMenu(null);
    setDialog({ type: 'operation', kind, inputs });
  }
  function applyOperation(recipe: Recipe, name: string, editing?: MockStep) {
    setDialog(null);
    if (editing) {
      let next = edit(ws, editing.id, recipe);
      if (name !== editing.name) next = rename(next, editing.id, name);
      commit(
        next,
        { kind: 'step', id: editing.id },
        `Updated ${stepRef(editing)} ${name} and rebuilt its dependants`,
      );
      return;
    }
    const inputs = dialog?.type === 'operation' ? dialog.inputs : scopeIds;
    const result = apply(ws, recipe, inputs, name);
    setChecked(new Set());
    commit(
      result.ws,
      result.step.outputs.length === 1 && recipe.op !== 'value'
        ? { kind: 'output', id: result.step.outputs[0] }
        : { kind: 'step', id: result.step.id },
      `Created ${stepRef(result.step)} ${name} · ${result.step.outputs.length} output${result.step.outputs.length === 1 ? '' : 's'}`,
    );
  }
  function editStep(target: MockStep | undefined) {
    if (!target) return;
    if (target.recipe.op === 'import') {
      say('Recordings are immutable. Import creates a new recording step.', {
        error: true,
      });
      return;
    }
    const kind = stepKind(target);
    setDialog({
      type: 'operation',
      kind:
        target.recipe.op === 'shift'
          ? 'compare'
          : kind === 'import'
            ? 'derive'
            : kind,
      inputs: target.inputs,
      editing: target,
    });
  }
  function duplicateStep(target: MockStep | undefined) {
    if (!target) return;
    if (target.recipe.op === 'import') {
      say('Import the file again to duplicate a recording.', { error: true });
      return;
    }
    const result = duplicate(ws, target.id);
    commit(
      result.ws,
      { kind: 'step', id: result.step.id },
      `Duplicated ${stepRef(target)} as ${stepRef(result.step)}`,
    );
  }
  function deleteStep(target: MockStep) {
    setDialog(null);
    const index = ws.steps.findIndex((item) => item.id === target.id);
    const next = remove(ws, target.id);
    const removed = ws.steps.length - next.steps.length;
    const fallback = next.steps[Math.min(index, next.steps.length) - 1];
    commit(
      next,
      fallback ? { kind: 'step', id: fallback.id } : selection,
      `Deleted ${stepRef(target)} ${target.name}${removed > 1 ? ` and ${removed - 1} dependent step${removed > 2 ? 's' : ''}` : ''}`,
    );
  }
  function finishRename(value: string) {
    setRenaming(false);
    const name = value.trim();
    const id = selected ? selected.id : step?.id;
    const current = selected ? selected.label : step?.name;
    if (!id || !name || name === current) return;
    commit(
      rename(ws, id, name),
      selection,
      `Renamed “${current}” to “${name}”`,
    );
  }
  async function importFiles(files: FileList | null) {
    let next = ws;
    let last: MockStep | undefined;
    for (const file of Array.from(files ?? [])) {
      try {
        const result = importCsv(next, file.name, await file.text());
        next = result.ws;
        last = result.step;
      } catch (error) {
        say(
          `${file.name}: ${error instanceof Error ? error.message : 'could not be read.'}`,
          { error: true },
        );
        return;
      }
    }
    if (last)
      commit(
        next,
        { kind: 'step', id: last.id },
        `Imported ${stepRef(last)} ${last.name} · ${last.outputs.length} channels`,
      );
  }

  // Plots and export.
  function keepPlot() {
    const plot = {
      id: nextPlotId(),
      name: saved ? `${saved.name} (copy)` : title,
      ids: traces.map((trace) => trace.id),
    };
    setPlots((old) => [...old, plot]);
    setActivePlot(plot.id);
    say(`Saved “${plot.name}” as a plot. Drag signals onto it to add more.`);
  }
  function newPlot() {
    const plot = {
      id: nextPlotId(),
      name: `Plot ${plots.length + 1}`,
      ids: [],
    };
    setPlots((old) => [...old, plot]);
    setActivePlot(plot.id);
  }
  function addToPlot(plotId: string | null, id: string) {
    if (!isSignal(ws.outputs.get(id))) return;
    if (plotId === null) {
      const plot = {
        id: nextPlotId(),
        name: `${title} + ${ws.outputs.get(id)!.short}`,
        ids: [...new Set([...traces.map((trace) => trace.id), id])],
      };
      setPlots((old) => [...old, plot]);
      setActivePlot(plot.id);
      say(`Created “${plot.name}”.`);
      return;
    }
    setPlots((old) =>
      old.map((plot) =>
        plot.id === plotId && !plot.ids.includes(id)
          ? { ...plot, ids: [...plot.ids, id] }
          : plot,
      ),
    );
    setActivePlot(plotId);
  }
  // Drop targets name their saved plot in data-plot; empty means Active.
  function dragOver(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget(true);
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(false);
    addToPlot(
      event.currentTarget.dataset.plot || null,
      event.dataTransfer.getData(DRAG_TYPE),
    );
  }
  function exportSvg() {
    setMenu(null);
    const source =
      plotArea.current?.querySelector<SVGSVGElement>('.mk-chart svg');
    if (!source) return;
    const copy = source.cloneNode(true) as SVGSVGElement;
    const originals = [source, ...source.querySelectorAll('*')];
    const clones = [copy, ...copy.querySelectorAll('*')];
    originals.forEach((element, i) => {
      const style = getComputedStyle(element);
      const target = clones[i] as SVGElement;
      for (const property of [
        'fill',
        'stroke',
        'stroke-width',
        'stroke-dasharray',
        'font-size',
        'font-family',
        'opacity',
        'paint-order',
      ])
        target.style.setProperty(property, style.getPropertyValue(property));
    });
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const background = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'rect',
    );
    background.setAttribute('width', '100%');
    background.setAttribute('height', '100%');
    background.style.fill = getComputedStyle(plotArea.current!).backgroundColor;
    copy.insertBefore(background, copy.firstChild);
    download(
      `${title}.svg`,
      new XMLSerializer().serializeToString(copy),
      'image/svg+xml',
    );
    say(`Exported ${title}.svg`);
  }
  function exportSamples() {
    setMenu(null);
    const lines = ['signal,unit,time_s,value'];
    for (const trace of traces)
      for (let i = 0; i < trace.t.length; i++)
        lines.push(
          `${cell(trace.label)},${cell(trace.unit)},${trace.t[i]},${Number.isFinite(trace.v[i]) ? trace.v[i] : ''}`,
        );
    download(`${title} samples.csv`, lines.join('\n'), 'text/csv');
    say(
      `Exported ${lines.length - 1} exact samples from ${traces.length} signals.`,
    );
  }
  function exportOutputs() {
    if (!step) return;
    const lines = ['output,type,produced_by,start_s,end_s,result,unit'];
    for (const id of step.outputs) {
      const item = ws.outputs.get(id)!;
      const span = isSignal(item)
        ? item
        : (ws.outputs.get(item.inputs[0]) as MockSignal | undefined);
      lines.push(
        [
          cell(item.label),
          cell(KIND_LABEL[item.kind]),
          cell(`${stepRef(step)} ${step.name}`),
          span?.t[0] ?? '',
          span?.t[span.t.length - 1] ?? '',
          item.kind === 'value'
            ? Number.isFinite(item.value)
              ? item.value
              : ''
            : cell(`${item.t.length} samples`),
          cell(item.unit),
        ].join(','),
      );
    }
    download(`${stepRef(step)} ${step.name}.csv`, lines.join('\n'), 'text/csv');
    say(`Exported ${step.outputs.length} outputs of ${stepRef(step)}.`);
  }

  // Keyboard shortcuts, with the latest state and handlers.
  const shortcuts = useRef<(event: KeyboardEvent) => void>(undefined);
  useEffect(() => {
    shortcuts.current = (event: KeyboardEvent) => {
      if (dialog) return;
      // Key events can target the window or document before anything is focused.
      const typing =
        event.target instanceof Element &&
        !!event.target.closest('input, textarea, select');
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'k') {
        event.preventDefault();
        setDialog({ type: 'palette' });
      } else if (typing) return;
      else if (mod && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
        event.preventDefault();
        redo();
      } else if (event.key === 'F2') {
        event.preventDefault();
        setRenaming(true);
      } else if (event.key === 'Delete' && step) {
        event.preventDefault();
        setDialog({ type: 'delete', step });
      } else if (event.key === 'Escape') setMenu(null);
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcuts.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  // Menus close on any press outside them.
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (
        !(
          event.target instanceof Element && event.target.closest('[data-menu]')
        )
      )
        setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  // Every typed word must appear in the output or its step, in any order.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const needle = words.length > 0;
  const visibleOutputs = (item: MockStep) =>
    item.outputs.filter((id) => {
      const entry = ws.outputs.get(id);
      if (!entry) return false;
      if (filter === 'signals' && entry.kind === 'value') return false;
      if (filter === 'values' && entry.kind !== 'value') return false;
      const text =
        `${entry.label} ${entry.unit} ${stepRef(item)} ${item.name}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  const all = [...ws.outputs.values()];
  const originals = all.filter((item) => item.kind === 'original').length;
  const derived = all.filter((item) => item.kind === 'derived').length;
  const values = all.length - originals - derived;

  const title = saved
    ? saved.name
    : selected
      ? selected.label
      : (step?.name ?? 'Empty workspace');
  const subtitle = saved
    ? `Saved plot · ${saved.ids.length} trace${saved.ids.length === 1 ? '' : 's'} · drag signals from History to add`
    : selected && step
      ? `${KIND_LABEL[selected.kind]} · ${stepRef(step)} ${step.name}`
      : step
        ? `${STEP_LABEL[stepKind(step)]} · ${step.outputs.length} output${step.outputs.length === 1 ? '' : 's'} · ${summary(ws, step)}`
        : 'Import a CSV recording to begin';
  const sampleRows = (() => {
    const lead = traces[0];
    if (!lead) return [];
    const start =
      cursor === null ? 0 : lowerBound(lead.t, cursor + lead.offset);
    const rows: { time: number; cells: (number | undefined)[] }[] = [];
    for (
      let i = Math.min(start, lead.t.length - 1);
      i < lead.t.length && rows.length < 40;
      i++
    ) {
      const time = lead.t[i] - lead.offset;
      rows.push({
        time,
        cells: traces.map((trace) => {
          const j = lowerBound(trace.t, time + trace.offset - 1e-6);
          return j < trace.t.length &&
            Math.abs(trace.t[j] - trace.offset - time) < 1e-6 &&
            Number.isFinite(trace.v[j])
            ? trace.v[j]
            : undefined;
        }),
      });
    }
    return rows;
  })();
  const lineageSteps = ws.steps.filter((item) =>
    item.outputs.some((id) => lineage.has(id)),
  );

  const palette: PaletteItem[] = [
    {
      id: 'c-derive',
      label: 'Derive…',
      hint: `Command · ${scopeLabel}`,
      icon: Sigma,
      run: () => openOperation('derive'),
    },
    {
      id: 'c-segment',
      label: 'Segment…',
      hint: `Command · ${scopeLabel}`,
      icon: Scissors,
      run: () => openOperation('segment'),
    },
    {
      id: 'c-value',
      label: 'Calculate value…',
      hint: `Command · ${scopeLabel}`,
      icon: Hash,
      run: () => openOperation('value'),
    },
    {
      id: 'c-compare',
      label: 'Compare & align…',
      hint: `Command · ${scopeLabel}`,
      icon: Layers2,
      run: () => openOperation('compare'),
    },
    {
      id: 'c-import',
      label: 'Import CSV…',
      hint: 'Command',
      icon: ArrowDownToLine,
      run: () => fileInput.current?.click(),
    },
    {
      id: 'c-undo',
      label: 'Undo',
      hint: past.length ? past[past.length - 1].label : 'Nothing to undo',
      icon: Undo2,
      run: undo,
    },
    {
      id: 'c-redo',
      label: 'Redo',
      hint: future.length ? future[0].label : 'Nothing to redo',
      icon: Redo2,
      run: redo,
    },
    {
      id: 'c-theme',
      label: `Use ${theme === 'dark' ? 'light' : 'dark'} theme`,
      hint: 'Command',
      icon: theme === 'dark' ? Sun : Moon,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'c-keep',
      label: 'Keep plot',
      hint: 'Command · save the current view',
      icon: Pin,
      run: keepPlot,
    },
    ...ws.steps.map((item) => ({
      id: item.id,
      label: `${stepRef(item)} ${item.name}`,
      hint: `Step · ${summary(ws, item)}`,
      icon: STEP_ICON[stepKind(item)],
      run: () => select({ kind: 'step', id: item.id }),
    })),
    ...all.map((item) => ({
      id: item.id,
      label: item.label,
      hint: `${KIND_LABEL[item.kind]} · ${item.kind === 'value' ? `${formatNumber(item.value)} ${item.unit}` : item.unit}`,
      icon: OUTPUT_ICON[item.kind],
      run: () => select({ kind: 'output', id: item.id }),
    })),
  ];

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
        <div className="mk-menu-anchor" data-menu>
          <button
            className="mk-workspace"
            aria-haspopup="menu"
            aria-expanded={menu === 'workspace'}
            title="Recordings shown in History"
            onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}
          >
            <FileSpreadsheet size={14} />
            <span>{scopeName}</span>
            <ChevronDown size={14} />
          </button>
          {menu === 'workspace' && (
            <div className="mk-menu" role="menu">
              {[
                { id: 'all', name: 'All recordings & results' },
                ...recordings,
              ].map((item) => (
                <button
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={recording === item.id}
                  onClick={() => {
                    setRecording(item.id);
                    setMenu(null);
                  }}
                >
                  {recording === item.id ? (
                    <Check size={14} />
                  ) : (
                    <span className="mk-menu-gap" />
                  )}
                  {item.name}
                </button>
              ))}
              <hr />
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  fileInput.current?.click();
                }}
              >
                <ArrowDownToLine size={14} />
                Import CSV…
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  commit(
                    EXAMPLE,
                    { kind: 'step', id: 's5' },
                    'Reset the example workspace',
                  );
                }}
              >
                <RotateCcw size={14} />
                Reset example workspace
              </button>
            </div>
          )}
        </div>
        <div className="mk-divider" />
        <button
          className="mk-icon"
          aria-label="Undo"
          title={
            past.length
              ? `Undo ${past[past.length - 1].label} · Ctrl+Z`
              : 'Nothing to undo'
          }
          disabled={!past.length}
          onClick={undo}
        >
          <Undo2 size={16} />
        </button>
        <button
          className="mk-icon"
          aria-label="Redo"
          title={
            future.length
              ? `Redo ${future[0].label} · Ctrl+Y`
              : 'Nothing to redo'
          }
          disabled={!future.length}
          onClick={redo}
        >
          <Redo2 size={16} />
        </button>
        <div className="mk-divider" />
        <nav className="mk-commands" aria-label="Operations">
          <button
            onClick={() => openOperation('derive')}
            title="Apply a function"
          >
            <Sigma size={15} />
            <span>Derive</span>
          </button>
          <button
            onClick={() => openOperation('segment')}
            title="Split by time ranges or windows"
          >
            <Scissors size={15} />
            <span>Segment</span>
          </button>
          <button
            onClick={() => openOperation('value')}
            title="Average, minimum or maximum"
          >
            <Hash size={15} />
            <span>Value</span>
          </button>
          <button
            onClick={() => openOperation('compare')}
            title="Align signals in time"
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
            onClick={() => setDialog({ type: 'palette' })}
          >
            <Search size={14} />
            <span>Search or run a command</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button
            className="mk-button"
            onClick={() => fileInput.current?.click()}
          >
            <ArrowDownToLine size={14} />
            <span>Import</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            multiple
            className="sr-only"
            aria-label="Import CSV recording"
            onChange={(event) => {
              const files = event.target.files;
              void importFiles(files).finally(() => {
                event.target.value = '';
              });
            }}
          />
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
            onClick={() => setDialog({ type: 'guide' })}
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </header>

      <div className="mk-body">
        <aside className="mk-rail" aria-label="Operation history">
          <div className="mk-rail-head">
            <strong>History</strong>
            <small>{shownSteps.length} steps · oldest first</small>
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
            {shownSteps.map((item) => {
              const outputs = visibleOutputs(item);
              if (!outputs.length && needle) return null;
              const kind = stepKind(item);
              const Icon = STEP_ICON[kind];
              const open = !collapsed.has(item.id) || !!needle;
              const active =
                selection.kind === 'step' && selection.id === item.id;
              return (
                <li
                  key={item.id}
                  className="mk-step"
                  data-kind={kind}
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
                      onDoubleClick={() => editStep(item)}
                      title={`${stepRef(item)} ${item.name} · ${summary(ws, item)} · double-click to edit`}
                    >
                      <span className="mk-node" aria-label={stepRef(item)}>
                        {item.sequence}
                      </span>
                      <span className="mk-step-text">
                        <span className="mk-step-name">{item.name}</span>
                        <small>
                          <Icon size={11} />
                          {STEP_LABEL[kind]} · {summary(ws, item)}
                          {item.revision > 1 ? ` · rev ${item.revision}` : ''}
                        </small>
                      </span>
                      <span className="mk-count">{item.outputs.length}</span>
                    </button>
                  </div>
                  {open && (
                    <ul className="mk-outputs">
                      {outputs.map((id) => {
                        const entry = ws.outputs.get(id)!;
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
                              draggable={entry.kind !== 'value'}
                              onDragStart={(event) => {
                                event.dataTransfer.setData(DRAG_TYPE, id);
                                event.dataTransfer.effectAllowed = 'copy';
                              }}
                              onClick={() => select({ kind: 'output', id })}
                              title={`${entry.label} · ${KIND_LABEL[entry.kind]}${entry.kind !== 'value' ? ' · drag onto a plot' : ''}`}
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
            {!shownSteps.length && (
              <li className="mk-rail-empty">
                No operations yet.
                <button
                  className="mk-button"
                  onClick={() => fileInput.current?.click()}
                >
                  <ArrowDownToLine size={14} />
                  Import CSV
                </button>
              </li>
            )}
          </ol>
          <p className="mk-rail-hint">
            <span className="mk-lineage-key" /> Contributes to the selection ·
            drag signals onto plots
          </p>
        </aside>

        <main className="mk-document">
          <div className="mk-tabs" role="tablist" aria-label="Plots">
            <button
              role="tab"
              aria-selected={!saved}
              onClick={() => setActivePlot(null)}
              data-plot=""
              onDragOver={dragOver}
              onDragLeave={() => setDropTarget(false)}
              onDrop={drop}
            >
              <Activity size={14} />
              Active selection
            </button>
            {plots.map((plot) => (
              <span
                key={plot.id}
                className="mk-tab-saved"
                data-active={plot.id === activePlot}
              >
                <button
                  role="tab"
                  aria-selected={plot.id === activePlot}
                  onClick={() => setActivePlot(plot.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      setPlots((old) =>
                        old.filter((item) => item.id !== plot.id),
                      );
                      if (activePlot === plot.id) setActivePlot(null);
                    }
                  }}
                  data-plot={plot.id}
                  onDragOver={dragOver}
                  onDragLeave={() => setDropTarget(false)}
                  onDrop={drop}
                >
                  <Pin size={13} />
                  <span className="mk-tab-label" title={plot.name}>
                    {plot.name}
                  </span>
                </button>
                <button
                  className="mk-tab-close"
                  aria-label={`Close ${plot.name}`}
                  onClick={() => {
                    setPlots((old) =>
                      old.filter((item) => item.id !== plot.id),
                    );
                    if (activePlot === plot.id) setActivePlot(null);
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              className="mk-tab-add"
              aria-label="New plot"
              title="New empty plot"
              onClick={newPlot}
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

          {/* Drop zone for dragged signals; keyboard users add via Keep plot. */}
          <div
            className="mk-plot"
            ref={plotArea}
            data-drop={dropTarget}
            data-plot={saved?.id ?? ''}
            onDragOver={dragOver}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setDropTarget(false);
            }}
            onDrop={drop}
          >
            <div className="mk-plot-head">
              <div>
                <h1>{title}</h1>
                <p>{subtitle}</p>
              </div>
              <div className="mk-plot-actions">
                {trail.length > 0 && !saved && (
                  <button
                    className="mk-button mk-quiet"
                    onClick={() => {
                      const previous = trail[trail.length - 1];
                      setTrail((old) => old.slice(0, -1));
                      setChosen(previous);
                    }}
                  >
                    Back
                  </button>
                )}
                <button
                  className="mk-button"
                  disabled={!traces.length}
                  onClick={keepPlot}
                >
                  <Pin size={14} />
                  {saved ? 'Copy plot' : 'Keep plot'}
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
                      <i
                        style={{
                          background: colorFor(ws, value.inputs[0], shownIds),
                        }}
                      />
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
              <div className="mk-menu-anchor" data-menu>
                <button
                  className="mk-tool"
                  aria-haspopup="menu"
                  aria-expanded={menu === 'export'}
                  disabled={!traces.length}
                  onClick={() => setMenu(menu === 'export' ? null : 'export')}
                >
                  <Download size={14} />
                  <span>Export</span>
                </button>
                {menu === 'export' && (
                  <div className="mk-menu mk-menu-end" role="menu">
                    <button role="menuitem" onClick={exportSvg}>
                      <Download size={14} />
                      Plot image (SVG)
                    </button>
                    <button role="menuitem" onClick={exportSamples}>
                      <Table2 size={14} />
                      Exact samples (CSV)
                    </button>
                  </div>
                )}
              </div>
            </div>

            {plotted.ids.length > 1 || saved ? (
              <div className="mk-legend" aria-label="Traces">
                {shownIds.map((id) => {
                  const item = ws.outputs.get(id) as MockSignal;
                  const off = hidden.has(id);
                  return (
                    <span key={id} className="mk-legend-item">
                      <button
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
                        <i style={{ background: colorFor(ws, id, shownIds) }} />
                        <span>{item.label}</span>
                        <small>{item.unit}</small>
                        {off ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      {saved && (
                        <button
                          className="mk-legend-remove"
                          aria-label={`Remove ${item.label} from ${saved.name}`}
                          onClick={() =>
                            setPlots((old) =>
                              old.map((plot) =>
                                plot.id === saved.id
                                  ? {
                                      ...plot,
                                      ids: plot.ids.filter(
                                        (entry) => entry !== id,
                                      ),
                                    }
                                  : plot,
                              ),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  );
                })}
                {plotted.ids.length > MAX_TRACES && (
                  <span className="mk-legend-note">
                    Showing {MAX_TRACES} of {plotted.ids.length}; check fewer or
                    use Stacked.
                  </span>
                )}
                {new Set(traces.map((trace) => trace.unit)).size > 1 &&
                  layout === 'overlay' && (
                    <span className="mk-legend-note">
                      Different units plot in separate lanes on one time axis
                    </span>
                  )}
              </div>
            ) : null}

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
                {saved
                  ? 'Drag signals from History onto this plot.'
                  : shownIds.length
                    ? 'All traces are hidden. Choose one in the legend.'
                    : 'Nothing to plot for this selection.'}
              </div>
            )}
          </div>

          <section className="mk-dock" data-open={dockOpen}>
            <div className="mk-dock-head">
              <div role="tablist" aria-label="Details">
                {(
                  [
                    ['outputs', 'Outputs', step?.outputs.length],
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
                {dock === 'samples'
                  ? traces.length
                    ? `Exact samples from ${formatExact(sampleRows[0]?.time ?? 0)} s${cursor !== null ? ' · following the cursor' : ' · hover the plot to follow'}`
                    : ''
                  : step
                    ? `${stepRef(step)} ${step.name}`
                    : ''}
              </span>
              <button
                className="mk-button mk-quiet"
                disabled={!step}
                onClick={exportOutputs}
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
            {dockOpen && step && (
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
                        const entry = ws.outputs.get(id)!;
                        const OutputIcon = OUTPUT_ICON[entry.kind];
                        const source = entry.inputs[0]
                          ? ws.outputs.get(entry.inputs[0])
                          : undefined;
                        const span = isSignal(entry)
                          ? entry
                          : isSignal(source)
                            ? source
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
                                    setChecked(() => {
                                      const next = new Set(checked);
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
                                <Sparkline
                                  item={entry}
                                  color={colorFor(ws, id, step.outputs)}
                                />
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
                                  {stepRef(stepOf(ws, source.id)!)}{' '}
                                  {source.label}
                                </button>
                              ) : (
                                <span className="mk-muted">Recording</span>
                              )}
                            </td>
                            <td className="mk-tabular">
                              {span ? interval(span) : '—'}
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
                          <td className="mk-num">{formatExact(row.time)}</td>
                          {row.cells.map((value, i) => (
                            <td key={traces[i].id} className="mk-num">
                              {value === undefined ? '' : formatExact(value)}
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
                      {settings(ws, step).map(([key, value]) => (
                        <FragmentRow key={key} term={key} value={value} />
                      ))}
                    </dl>
                    <button
                      className="mk-button"
                      disabled={step.recipe.op === 'import'}
                      onClick={() => editStep(step)}
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
          {step && (
            <>
              <div className="mk-inspector-head">
                <span className="mk-eyebrow">
                  {selected ? (
                    <KindChip kind={selected.kind} />
                  ) : (
                    <span className="mk-kind" data-kind="step">
                      <i />
                      {STEP_LABEL[stepKind(step)]} operation · {stepRef(step)}
                    </span>
                  )}
                </span>
                {renaming ? (
                  <input
                    ref={renameInput}
                    className="mk-rename"
                    aria-label="New name"
                    defaultValue={selected ? selected.label : step.name}
                    onBlur={(event) => finishRename(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter')
                        finishRename(event.currentTarget.value);
                      if (event.key === 'Escape') setRenaming(false);
                    }}
                  />
                ) : (
                  <h2>{selected ? selected.label : step.name}</h2>
                )}
                <button
                  className="mk-icon"
                  aria-label="Rename"
                  title="Rename · F2"
                  onClick={() => setRenaming(true)}
                >
                  <Pencil size={14} />
                </button>
              </div>

              {selected?.kind === 'value' && (
                <div className="mk-hero">
                  <strong>{formatExact(selected.value)}</strong>
                  <small>{selected.unit}</small>
                </div>
              )}

              <section className="mk-section">
                <h3>Properties</h3>
                <dl className="mk-props">
                  {selected ? (
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
                      <dd>{selected.unit || '—'}</dd>
                      {isSignal(selected) ? (
                        <>
                          <dt>Samples</dt>
                          <dd>{selected.t.length.toLocaleString('en-US')}</dd>
                          <dt>Time range</dt>
                          <dd>{interval(selected)}</dd>
                        </>
                      ) : (
                        <>
                          <dt>Function</dt>
                          <dd>{selected.fn}</dd>
                          <dt>Input samples</dt>
                          <dd>
                            {selected.samples.toLocaleString('en-US')} finite
                          </dd>
                          <dt>Valid duration</dt>
                          <dd>{formatExact(selected.duration)} s</dd>
                          {selected.at !== undefined && (
                            <>
                              <dt>First occurs</dt>
                              <dd>{formatExact(selected.at)} s</dd>
                            </>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <dt>Revision</dt>
                      <dd>{step.revision}</dd>
                      <dt>Outputs</dt>
                      <dd>{step.outputs.length}</dd>
                      {settings(ws, step)
                        .slice(0, 3)
                        .map(([key, value]) => (
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
                    const Icon = STEP_ICON[stepKind(item)];
                    const contributing = item.outputs.filter((id) =>
                      lineage.has(id),
                    );
                    return (
                      <li
                        key={item.id}
                        data-kind={stepKind(item)}
                        data-current={item.id === step.id}
                      >
                        <span className="mk-node">
                          <Icon size={11} />
                        </span>
                        <div>
                          <button
                            className="mk-cell-link"
                            onClick={() =>
                              select({ kind: 'step', id: item.id })
                            }
                          >
                            <code>{stepRef(item)}</code> {item.name}
                          </button>
                          <small>
                            {contributing.length === item.outputs.length &&
                            contributing.length > 1
                              ? `All ${contributing.length} outputs`
                              : contributing
                                  .map((id) => ws.outputs.get(id)?.short)
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
                  disabled={step.recipe.op === 'import'}
                  title={
                    step.recipe.op === 'import'
                      ? 'Recordings are immutable'
                      : 'Rebuild with new settings'
                  }
                  onClick={() => editStep(step)}
                >
                  <Settings2 size={14} />
                  Edit settings
                </button>
                <button
                  className="mk-button"
                  disabled={step.recipe.op === 'import'}
                  onClick={() => duplicateStep(step)}
                >
                  <Copy size={14} />
                  Duplicate
                </button>
                <button
                  className="mk-button mk-danger"
                  onClick={() => setDialog({ type: 'delete', step })}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      <footer className="mk-status">
        <span className="mk-ready">
          <i /> Ready
        </span>
        <span>
          {past.length
            ? `${past.length} change${past.length === 1 ? '' : 's'} · Ctrl+Z undoes`
            : 'No changes yet'}
        </span>
        <output aria-live="polite">{toast?.message}</output>
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
        <button
          className="mk-badge"
          onClick={() => setDialog({ type: 'guide' })}
        >
          <BookOpen size={12} />
          UI refresh prototype · in-memory data
        </button>
      </footer>

      {toast && (
        <div
          className="mk-toast"
          data-error={toast.error}
          role={toast.error ? 'alert' : 'status'}
        >
          <span>{toast.message}</span>
          {toast.undo && past.length > 0 && (
            <button
              onClick={() => {
                setToast(undefined);
                undo();
              }}
            >
              Undo
            </button>
          )}
          <button
            aria-label="Dismiss"
            className="mk-icon"
            onClick={() => setToast(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {railOpen && (
        <button
          className="mk-scrim"
          aria-label="Close history"
          onClick={() => setRailOpen(false)}
        />
      )}

      {dialog?.type === 'operation' && (
        <OperationDialog
          key={`${dialog.kind}:${dialog.editing?.id ?? 'new'}`}
          kind={dialog.kind}
          ws={ws}
          inputs={dialog.inputs}
          editing={dialog.editing}
          onApply={(recipe, name) =>
            applyOperation(recipe, name, dialog.editing)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'delete' && (
        <DeleteDialog
          ws={ws}
          step={dialog.step}
          onConfirm={() => deleteStep(dialog.step)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'guide' && (
        <GuideDialog onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'palette' && (
        <CommandPalette items={palette} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
