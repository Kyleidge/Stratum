'use client';

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type Ref,
  type DragEvent,
} from 'react';
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
  Hand,
  Scan,
  Crosshair,
  Settings2,
  Undo2,
  Copy,
  StickyNote,
  CircleHelp,
  ArrowUp,
  ArrowDown,
  LockKeyhole,
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
  Point,
  Project,
} from '@/lib/signal-types';
import type { SignalGraph } from '@/lib/signal-graph';
import type { WorkflowIndex } from '@/lib/workflow-history';
import { usePlotView } from '@/hooks/use-plot-view';
import type { PlotJob } from '@/lib/plot-view';
import {
  MAX_PLOT_TABS,
  MAX_PLOT_TRACES,
  MAX_CUSTOM_AXES,
  PLOT_STORAGE_KEY,
  TRACE_COLORS,
  readPlotSheets,
  navigatePlot,
  plotViewport,
  plotExtent,
  validPlotRange,
  type PlotRange,
  type PlotTrace,
  type PlotSheet,
  type PlotAxes,
  type PlotValueAxis,
} from '@/lib/plot-scratchpad';
import {
  groupPlotAxes,
  holdPlotYAxes,
  plotAxisKey,
  traceAxisKey,
  plotAxisOptions,
  type PlotAxisGroup,
  valueAxisSettings,
  MAX_CHART_AXES,
} from '@/lib/plot-axes';
import SignalChart, {
  formatValue,
  type ChartInteraction,
} from './signal-chart';
import PlotMeasurements from './plot-measurements';
import PlotSelect from './plot-select';
import { exportPlotImage } from '@/lib/plot-export';
import WorkflowList from './workflow-list';
import { stepName } from '@/lib/workflow-history';
import {
  readWorkflowDrag,
  targetPlotOutputs,
  WORKFLOW_DRAG_TYPE,
  type WorkflowTarget,
} from '@/lib/workflow-drag';

export type PlotScratchpadHandle = {
  createPlot: (target: WorkflowTarget) => void;
};

type Props = {
  ref?: Ref<PlotScratchpadHandle>;
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
  outputKey: string;
  valueCard: ReactNode;
  busy: boolean;
  onNotice: (message: string) => void;
  onDragEnd: () => void;
};
const initialSheet: PlotSheet = {
  id: 'result',
  name: 'Active',
  traces: [],
  layout: 'overlay',
  grid: true,
};

export default function PlotScratchpad({
  ref,
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
  outputKey,
  valueCard,
  busy,
  onNotice,
  onDragEnd,
}: Props) {
  const [sheets, setSheets] = useState<PlotSheet[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [activeSettings, setActiveSettings] = useState<
    Record<string, Partial<PlotSheet>>
  >({});
  const host = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<ChartInteraction['mode']>('pan');
  const [cursorWindows, setCursorWindows] = useState<Record<string, PlotRange>>(
    {},
  );
  const [measureStates, setMeasureStates] = useState<Record<string, boolean>>(
    {},
  );
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [backViews, setBackViews] = useState<
    Record<string, { window: PlotRange; axes?: PlotAxes }[]>
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [axisDraft, setAxisDraft] = useState({
    start: '',
    end: '',
    min: '',
    max: '',
    log: false,
    key: '',
    label: '',
    timeLabel: '',
  });
  const [axisError, setAxisError] = useState('');
  const [axisEdits, setAxisEdits] = useState<
    Record<string, Pick<typeof axisDraft, 'min' | 'max' | 'log' | 'label'>>
  >({});
  const [newAxes, setNewAxes] = useState<Record<string, PlotValueAxis>>({});
  const [removedAxes, setRemovedAxes] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState<{
    id?: string;
    time: string;
    text: string;
    clockId?: string;
  }>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [styleTrace, setStyleTrace] = useState<string>();
  const [exporting, setExporting] = useState(false);
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
  const selectedTab = saved?.id ?? 'result';
  const sheet: PlotSheet = saved ?? {
    ...initialSheet,
    ...activeSettings[activeId],
    traces: activeId
      ? [
          activeSettings[activeId]?.traces?.find(
            (trace) => trace.id === activeId,
          ) ?? { id: activeId, visible: true, color: TRACE_COLORS[0] },
        ]
      : [],
  };
  const windowKey = saved?.id ?? `active:${activeId}`;
  const measuring = measureStates[windowKey] ?? sheet.measuring ?? false;
  function setMeasuring(value: boolean) {
    setMeasureStates((old) => ({ ...old, [windowKey]: value }));
    update({ measuring: value });
  }
  const window: PlotRange = windows[windowKey] ?? sheet.window ?? [0, 1];
  const visibleIds = sheet.traces
    .filter(
      (trace) =>
        trace.visible &&
        (index.nodes.has(trace.id) || index.values.has(trace.id)),
    )
    .map((trace) => trace.id);
  const ranges = visibleIds.map(displayRange);
  const fullRange = plotExtent(
    ranges.length
      ? ranges.reduce<PlotRange>(
          (all, range) => [
            Math.min(all[0], range[0]),
            Math.max(all[1], range[1]),
          ],
          [Infinity, -Infinity],
        )
      : [0, 1],
  );
  const clocks = new Set(
    visibleIds.map((id) =>
      sheet.zeroTime
        ? 'elapsed'
        : (graph.timeReferences.get(signalFor(id)?.id ?? '')?.id ?? id),
    ),
  );
  function plotJobs(viewport: PlotRange): PlotJob[] {
    return visibleIds
      .filter((id) => index.nodes.has(id))
      .map((id) => {
        const source = timeRange(id);
        const display = plotExtent(
          clocks.size > 1 ? displayRange(id) : fullRange,
        );
        const span = display[1] - display[0];
        const zoomed = [
          display[0] + viewport[0] * span,
          display[0] + viewport[1] * span,
        ];
        const offset = sheet.zeroTime ? source[0] : 0;
        return {
          id,
          range: [zoomed[0] + offset, zoomed[1] + offset] as PlotRange,
        };
      });
  }
  const idsKey = JSON.stringify(plotJobs(window));
  const sourceKey = JSON.stringify(
    visibleIds
      .filter((id) => index.nodes.has(id))
      .map((id) => ({ id, range: timeRange(id) })),
  );
  const hasSignals = visibleIds.some((id) => index.nodes.has(id));
  const [retry, setRetry] = useState(0);
  const { view: plotView, preview: previewPlot } = usePlotView(
    project,
    sourceKey,
    idsKey,
    request,
    retry,
    windowKey,
  );
  const [over, setOver] = useState<string | null>(null);
  const [stackPage, setStackPage] = useState(0);
  const [axisPage, setAxisPage] = useState(0);
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
  const plots = new Map(plotView?.detail?.plots ?? plotView?.overview?.plots);
  function signalFor(id: string) {
    return (
      index.nodes.get(id) ??
      index.nodes.get(index.values.get(id)?.inputId ?? '')
    );
  }
  function timeRange(id: string): [number, number] {
    const value = index.values.get(id);
    return value ? [value.start, value.end] : (graph.ranges.get(id) ?? [0, 1]);
  }
  function displayRange(id: string): [number, number] {
    const range = timeRange(id);
    return sheet.zeroTime ? [0, range[1] - range[0]] : range;
  }
  for (const id of visibleIds) {
    const value = index.values.get(id);
    if (!value) continue;
    const y = value.value ?? NaN;
    plots.set(id, {
      id,
      points: [
        [value.start, y],
        [value.end, y],
      ],
      summary: {
        count: value.value === null ? 0 : 1,
        start: value.start,
        end: value.end,
        min: y,
        max: y,
        mean: y,
        integral: NaN,
      },
    });
  }
  const traces = sheet.traces.flatMap((trace) => {
    const signal = signalFor(trace.id),
      plot = plots.get(trace.id),
      value = index.values.get(trace.id);
    const node =
      signal && value
        ? {
            ...signal,
            id: value.id,
            name: index.label(value.id),
            unit: value.unit,
            operation: 'raw' as const,
          }
        : signal;
    return trace.visible && node && plot
      ? [
          {
            node,
            plot,
            drawingView: value ? undefined : plotView,
            color: trace.color,
            label: index.label(trace.id),
            offset: sheet.zeroTime ? timeRange(trace.id)[0] : 0,
            referenceLine: !!value,
            style: trace.style,
            width: trace.width,
            axisId: trace.axisId,
          },
        ]
      : [];
  });
  function traceUnit(id: string) {
    return index.values.get(id)?.unit ?? index.nodes.get(id)?.unit ?? '';
  }
  const axisTraces = sheet.traces
    .filter((trace) => index.nodes.has(trace.id) || index.values.has(trace.id))
    .map((trace) => ({
      ...trace,
      unit: traceUnit(trace.id),
      name: index.label(trace.id),
    }));
  const axisGroups = groupPlotAxes(
    axisTraces.filter((trace) => trace.visible),
    sheet.axes,
    true,
  );
  const editAxes: PlotAxes = {
    ...sheet.axes,
    values: Object.fromEntries(
      Object.entries({ ...sheet.axes?.values, ...newAxes }).filter(
        ([key]) => !removedAxes.includes(key),
      ),
    ),
  };
  const axisOptions = plotAxisOptions(
    axisTraces,
    settingsOpen ? editAxes : sheet.axes,
  );
  const axisChoices = axisOptions.map((axis, i) => ({
    value: axis.key,
    label: `Y${i + 1} · ${axis.label}`,
  }));
  const customAxisCount = Object.keys(
    (settingsOpen ? editAxes : sheet.axes)?.values ?? {},
  ).filter((key) => key.startsWith('axis:')).length;
  const firstTraceId =
    sheet.traces.find(
      (trace) => index.nodes.has(trace.id) || index.values.has(trace.id),
    )?.id ?? '';
  const primaryAxisKey = plotAxisKey(
    index.values.get(firstTraceId)?.unit ??
      index.nodes.get(firstTraceId)?.unit ??
      '',
  );
  const safeAxisPage = Math.min(
    axisPage,
    Math.max(0, Math.ceil(axisGroups.length / MAX_CHART_AXES) - 1),
  );
  const shownAxes = new Set(
    axisGroups
      .slice(safeAxisPage * MAX_CHART_AXES, (safeAxisPage + 1) * MAX_CHART_AXES)
      .map((axis) => axis.key),
  );
  const overlayTraces = traces.filter((trace) =>
    shownAxes.has(traceAxisKey(trace.node.unit, trace.axisId, sheet.axes)),
  );
  const canOverlay = clocks.size <= 1;
  const stacked = sheet.layout === 'stacked' || !canOverlay;
  const safeStackPage = Math.min(
    stackPage,
    Math.max(0, Math.ceil(traces.length / 8) - 1),
  );
  function zoomRange(range: [number, number]): [number, number] {
    const span = range[1] - range[0];
    return [range[0] + window[0] * span, range[0] + window[1] * span];
  }
  function zoom(factor: number, shift = 0) {
    setWindow(navigatePlot(window, factor, 0.5, shift, false));
  }
  function setWindow(next: PlotRange, remember = true) {
    const normalized = plotViewport(next);
    if (
      remember &&
      (normalized[0] !== window[0] || normalized[1] !== window[1])
    )
      rememberView();
    setWindows((old) => ({ ...old, [windowKey]: normalized }));
    update({ window: normalized });
  }
  function rememberView() {
    setBackViews((old) => ({
      ...old,
      [windowKey]: [
        ...(old[windowKey] ?? []).slice(-19),
        { window, axes: sheet.axes },
      ],
    }));
  }
  function setValueAxis(key: string, value: PlotValueAxis) {
    const values = { ...sheet.axes?.values };
    if (!values[primaryAxisKey])
      values[primaryAxisKey] = valueAxisSettings(
        sheet.axes,
        primaryAxisKey,
        primaryAxisKey,
      );
    values[key] = value;
    update({
      axes: {
        timeLabel: sheet.axes?.timeLabel,
        heldY: sheet.axes?.heldY,
        values,
      },
    });
  }
  function toggleHoldY() {
    rememberView();
    update({
      axes: {
        ...sheet.axes,
        heldY: sheet.axes?.heldY
          ? undefined
          : holdPlotYAxes(
              traces.map((trace) => ({
                id: trace.node.id,
                unit: trace.node.unit,
                axisId: trace.axisId,
                plot: trace.plot,
              })),
              sheet.axes,
              primaryAxisKey,
            ),
      },
    });
  }
  function back() {
    const history = backViews[windowKey] ?? [];
    if (!history.length) return;
    const previous = history[history.length - 1];
    setWindow(previous.window, false);
    update({ axes: previous.axes });
    setBackViews((old) => ({ ...old, [windowKey]: history.slice(0, -1) }));
  }
  function fit() {
    if (
      window[0] === 0 &&
      window[1] === 1 &&
      (sheet.axes?.heldY ||
        sheet.axes?.y ||
        Object.values(sheet.axes?.values ?? {}).some((axis) => axis.y))
    )
      rememberView();
    setWindow([0, 1]);
    update({
      axes: {
        ...sheet.axes,
        y: undefined,
        heldY: undefined,
        values: Object.fromEntries(
          Object.entries(sheet.axes?.values ?? {}).map(([key, value]) => [
            key,
            { ...value, y: undefined },
          ]),
        ),
      },
    });
  }
  function openAxes(key = axisGroups[0]?.key ?? primaryAxisKey) {
    const range = zoomRange(fullRange);
    const value = valueAxisSettings(sheet.axes, key, primaryAxisKey);
    setAxisDraft({
      start: String(range[0]),
      end: String(range[1]),
      min: value.y ? String(value.y[0]) : '',
      max: value.y ? String(value.y[1]) : '',
      log: !!value.log,
      key,
      label: value.label ?? '',
      timeLabel: sheet.axes?.timeLabel ?? '',
    });
    setAxisError('');
    setAxisEdits({});
    setNewAxes({});
    setRemovedAxes([]);
    setSettingsOpen(true);
  }
  function chooseAxis(key: string) {
    const value = valueAxisSettings(editAxes, key, primaryAxisKey);
    const next = axisEdits[key] ?? {
      min: value.y ? String(value.y[0]) : '',
      max: value.y ? String(value.y[1]) : '',
      log: !!value.log,
      label: value.label ?? '',
    };
    setAxisEdits({
      ...axisEdits,
      [axisDraft.key]: {
        min: axisDraft.min,
        max: axisDraft.max,
        log: axisDraft.log,
        label: axisDraft.label,
      },
    });
    setAxisDraft({ ...axisDraft, ...next, key });
    setAxisError('');
  }
  function addValueAxis(unit: string, traceId?: string) {
    if (
      Object.keys((traceId ? sheet.axes : editAxes)?.values ?? {}).filter(
        (key) => key.startsWith('axis:'),
      ).length >= MAX_CUSTOM_AXES
    )
      return;
    const key = `axis:${crypto.randomUUID()}`;
    if (traceId) {
      update({
        axes: {
          ...sheet.axes,
          values: { ...sheet.axes?.values, [key]: { unit: unit.trim() } },
        },
        traces: sheet.traces.map((trace) =>
          trace.id === traceId ? { ...trace, axisId: key } : trace,
        ),
      });
    } else {
      setNewAxes({ ...newAxes, [key]: { unit: unit.trim() } });
      chooseAxis(key);
    }
  }
  const cursorTimes: PlotRange = cursorWindows[windowKey] ??
    sheet.cursors ?? [
      fullRange[0] + (fullRange[1] - fullRange[0]) / 3,
      fullRange[0] + (2 * (fullRange[1] - fullRange[0])) / 3,
    ];
  function setCursors(next: PlotRange) {
    setCursorWindows((old) => ({ ...old, [windowKey]: next }));
    update({ cursors: next });
  }
  function interactionFor(
    extent: PlotRange,
    valueAxes?: PlotAxisGroup[],
    clockId = clocks.values().next().value,
    traceId?: string,
  ): ChartInteraction {
    const range = plotExtent(extent);
    return {
      mode,
      axes: sheet.axes,
      primaryAxisKey,
      traceId,
      valueAxes:
        valueAxes ?? axisGroups.filter((axis) => shownAxes.has(axis.key)),
      timeLabel: sheet.zeroTime ? 'Elapsed time (s)' : 'Time (s)',
      onValueRange: (key, range) => {
        rememberView();
        setValueAxis(key, {
          ...valueAxisSettings(sheet.axes, key, primaryAxisKey),
          y: range,
        });
      },
      cursors: measuring && clocks.size <= 1 ? cursorTimes : undefined,
      annotations: sheet.annotations?.filter((note) =>
        note.clockId ? note.clockId === clockId : clocks.size <= 1,
      ),
      onRange: (next) =>
        setWindow([
          (next[0] - range[0]) / (range[1] - range[0]),
          (next[1] - range[0]) / (range[1] - range[0]),
        ]),
      onPreviewRange: (next) =>
        previewPlot(
          next
            ? plotJobs([
                (next[0] - range[0]) / (range[1] - range[0]),
                (next[1] - range[0]) / (range[1] - range[0]),
              ])
            : undefined,
        ),
      onFit: fit,
      onBack: back,
      onAxes: openAxes,
      onCursors: setCursors,
      onAnnotationPosition: (id, labelPosition) =>
        update({
          annotations: sheet.annotations?.map((note) =>
            note.id === id ? { ...note, labelPosition } : note,
          ),
        }),
      onAnnotation: (time, id) =>
        setNoteDraft({
          id,
          time: String(time),
          text: sheet.annotations?.find((note) => note.id === id)?.text ?? '',
          clockId,
        }),
    };
  }
  function moveTrace(id: string, destination: number) {
    const next = [...sheet.traces];
    const position = next.findIndex((trace) => trace.id === id);
    if (position < 0) return;
    const [trace] = next.splice(position, 1);
    next.splice(Math.max(0, Math.min(next.length, destination)), 0, trace);
    update({ traces: next });
  }
  function moveTab(id: string, destination: number) {
    setSheets((old) => {
      const next = [...old],
        position = next.findIndex((item) => item.id === id);
      if (position < 0) return old;
      const [item] = next.splice(position, 1);
      next.splice(Math.max(0, Math.min(next.length, destination)), 0, item);
      return next;
    });
  }
  function closePlot(plot: PlotSheet) {
    setClosed({ sheet: plot, position: sheets.indexOf(plot) });
    setSheets((old) => old.filter((item) => item.id !== plot.id));
    if (selectedTab === plot.id) onView('result');
  }
  async function imageExport(format: 'svg' | 'png') {
    if (!host.current || exporting) return;
    setExporting(true);
    try {
      await exportPlotImage(
        host.current,
        saved?.name ?? index.label(activeId),
        format,
        (stacked
          ? traces.slice(safeStackPage * 8, (safeStackPage + 1) * 8)
          : overlayTraces
        ).map((trace) => ({
          label: `${trace.label} (${trace.node.unit || 'unitless'})`,
          color: trace.color,
        })),
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Plot export failed.');
    } finally {
      setExporting(false);
    }
  }
  function update(change: Partial<PlotSheet>) {
    if (
      change.traces &&
      !('axes' in change) &&
      sheet.axes &&
      (sheet.axes.y || sheet.axes.log || sheet.axes.label)
    ) {
      change = {
        ...change,
        axes: {
          timeLabel: sheet.axes.timeLabel,
          heldY: sheet.axes.heldY,
          values: {
            ...sheet.axes.values,
            [primaryAxisKey]: valueAxisSettings(
              sheet.axes,
              primaryAxisKey,
              primaryAxisKey,
            ),
          },
        },
      };
    }
    if (saved)
      setSheets((old) =>
        old.map((item) =>
          item.id === saved.id ? { ...item, ...change } : item,
        ),
      );
    else
      setActiveSettings((old) => ({
        ...old,
        [activeId]: { ...old[activeId], ...change },
      }));
  }
  function create(ids: string[], template?: PlotSheet) {
    if (sheets.length >= MAX_PLOT_TABS) return;
    const next: PlotSheet = {
      ...initialSheet,
      ...template,
      id: `plot:${crypto.randomUUID()}`,
      name: template
        ? template.name.slice(0, 80)
        : ids.length === 1
          ? index.label(ids[0]).slice(0, 80)
          : `Plot ${sheets.length + 1}`,
      traces:
        template?.traces.map((trace) => ({ ...trace })) ??
        [...new Set(ids)].slice(0, MAX_PLOT_TRACES).map((id, i) => ({
          id,
          visible: true,
          color: TRACE_COLORS[i % TRACE_COLORS.length],
        })),
    };
    setSheets((old) => [...old, next]);
    onView(next.id);
  }
  function dropOnPlot(raw: string, tabId = selectedTab) {
    if (busy) return;
    const target = readWorkflowDrag(raw, index);
    if (!target) {
      onNotice('This item is no longer available in the workspace.');
      return;
    }
    addTarget(target, tabId);
  }
  function addTarget(target: WorkflowTarget, tabId: string) {
    const ids = targetPlotOutputs(index, target);
    if (!ids.length) {
      onNotice('This operation has no plottable outputs.');
      return;
    }
    const destination = sheets.find((item) => item.id === tabId);
    const existing =
      destination?.traces ??
      (tabId === 'result' && activeId
        ? [{ id: activeId, visible: true, color: TRACE_COLORS[0] }]
        : []);
    const existingIds = new Set(existing.map((trace) => trace.id));
    const additions = ids.filter((id) => !existingIds.has(id));
    if (existing.length + additions.length > MAX_PLOT_TRACES) {
      onNotice(
        `A plot supports up to ${MAX_PLOT_TRACES.toLocaleString()} traces. Nothing was added.`,
      );
      return;
    }
    if (!destination && sheets.length >= MAX_PLOT_TABS) {
      onNotice('Close a plot tab before creating another.');
      return;
    }
    const nextTraces = [
      ...existing,
      ...additions.map((id, i) => ({
        id,
        visible: true,
        color: TRACE_COLORS[(existing.length + i) % TRACE_COLORS.length],
      })),
    ];
    if (destination) {
      setSheets((old) =>
        old.map((item) =>
          item.id === destination.id ? { ...item, traces: nextTraces } : item,
        ),
      );
      onView(destination.id);
    } else {
      const owner =
        target.kind === 'step'
          ? index.steps.get(target.id)
          : index.owner.get(target.id);
      const next: PlotSheet = {
        ...initialSheet,
        id: `plot:${crypto.randomUUID()}`,
        name:
          owner?.kind === 'segment'
            ? stepName(owner).slice(0, 80)
            : 'Comparison',
        traces: nextTraces,
      };
      setSheets((old) => [...old, next]);
      onView(next.id);
    }
    onNotice(
      `${additions.length} trace${additions.length === 1 ? '' : 's'} added${ids.length > 1 ? ` from ${ids.length} outputs` : ''}.`,
    );
  }
  useImperativeHandle(ref, () => ({
    createPlot(target) {
      if (busy || !loaded) return;
      addTarget(target, 'new');
    },
  }));
  function dropProps(tabId: string) {
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!busy && event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setOver(tabId);
        }
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        dropOnPlot(event.dataTransfer.getData(WORKFLOW_DRAG_TYPE), tabId);
        onDragEnd();
      },
    };
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
      [...project.nodes, ...(project.values ?? [])].filter((node) =>
        `${index.label(node.id)} ${node.unit} ${graph.timeReferences.get(index.values.get(node.id)?.inputId ?? node.id)?.name ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [project, index, graph, query],
  );
  const safePage = Math.min(
    pickerPage,
    Math.max(0, Math.ceil(matches.length / 30) - 1),
  );

  return (
    <section
      ref={host}
      className="plot-scratchpad"
      aria-label="Plot scratchpad"
    >
      <Tabs
        value={selectedTab}
        onValueChange={onView}
        className="scratchpad-tabs"
      >
        <div className="scratchpad-tabbar">
          <TabsList variant="line" aria-label="Plot tabs">
            <TabsTrigger
              value="result"
              title="Selected signal and operation outputs"
              {...dropProps('result')}
              data-drop={over === 'result'}
            >
              <Activity size={15} /> Active{' '}
            </TabsTrigger>
            {sheets.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                {...dropProps(item.id)}
                data-drop={over === item.id}
                title={item.name}
                draggable
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  closePlot(item);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(
                    'application/x-stratum-plot-tab',
                    item.id,
                  );
                }}
                onDragOver={(event) => {
                  if (
                    event.dataTransfer.types.includes(
                      'application/x-stratum-plot-tab',
                    )
                  ) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setOver(item.id);
                  } else dropProps(item.id).onDragOver(event);
                }}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData(
                    'application/x-stratum-plot-tab',
                  );
                  if (id) {
                    event.preventDefault();
                    moveTab(id, sheets.indexOf(item));
                    setOver(null);
                  } else dropProps(item.id).onDrop(event);
                }}
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
          </TabsList>
          <button
            className="secondary-button"
            disabled={!loaded || sheets.length >= MAX_PLOT_TABS}
            title={`Create a blank plot · up to ${MAX_PLOT_TABS} tabs`}
            {...dropProps('new')}
            onClick={() => create([])}
          >
            <Plus size={16} /> New plot
          </button>
        </div>
        {/* Only the selected plot mounts; large workspaces never render hidden charts. */}
        <TabsContent value={selectedTab}>
          {(saved || activeId) && (
            <>
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
                    <h1>
                      {activeId ? index.label(activeId) : 'Select a signal'}
                    </h1>
                  )}
                </div>
                {isActive ? (
                  <button
                    className="secondary-button"
                    disabled={
                      !activeId || !loaded || sheets.length >= MAX_PLOT_TABS
                    }
                    onClick={() =>
                      create([activeId], {
                        ...sheet,
                        name: index.label(activeId),
                      })
                    }
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
                      aria-label="Duplicate plot"
                      onClick={() =>
                        create([], { ...sheet, name: `${sheet.name} copy` })
                      }
                      disabled={sheets.length >= MAX_PLOT_TABS}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      className="workflow-icon-button"
                      aria-label="Move plot tab left"
                      disabled={sheets.indexOf(saved) === 0}
                      onClick={() =>
                        moveTab(saved.id, sheets.indexOf(saved) - 1)
                      }
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      className="workflow-icon-button"
                      aria-label="Move plot tab right"
                      disabled={sheets.indexOf(saved) === sheets.length - 1}
                      onClick={() =>
                        moveTab(saved.id, sheets.indexOf(saved) + 1)
                      }
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      className="workflow-icon-button"
                      aria-label={`Close plot ${sheet.name}`}
                      onClick={() => closePlot(saved)}
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
                              color:
                                TRACE_COLORS[
                                  saved.traces.length % TRACE_COLORS.length
                                ],
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
              <div
                className="scratchpad-canvas"
                {...dropProps(selectedTab)}
                data-drop={over === selectedTab}
                aria-label="Drop signals, segments or values onto this plot"
              >
                <div className="scratchpad-chart-tools">
                  {saved && (
                    <button
                      className="scratchpad-zero"
                      aria-label="Align trace starts at zero"
                      aria-pressed={!!sheet.zeroTime}
                      onClick={() => {
                        update({ zeroTime: !sheet.zeroTime });
                        setWindow([0, 1]);
                        setMeasuring(false);
                      }}
                    >
                      Δt ·{' '}
                      {sheet.zeroTime ? 'Starts at 0' : 'Align starts at 0'}
                    </button>
                  )}
                  <fieldset
                    className="scratchpad-mode"
                    aria-label="Plot layout"
                  >
                    <button
                      aria-pressed={!stacked}
                      disabled={!canOverlay}
                      title={
                        canOverlay
                          ? 'Overlay traces with a separate Y axis for each unit'
                          : 'Overlay requires matching time references'
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
                    className="scratchpad-mode"
                    aria-label="Plot interaction"
                  >
                    <button
                      aria-label="Pan mode"
                      aria-pressed={mode === 'pan'}
                      title="Drag to pan · Shift-drag always pans"
                      onClick={() => setMode('pan')}
                    >
                      <Hand size={14} /> Pan
                    </button>
                    <button
                      aria-label="Box zoom mode"
                      aria-pressed={mode === 'zoom'}
                      title="Drag across a time interval to zoom"
                      onClick={() => setMode('zoom')}
                    >
                      <Scan size={14} /> Zoom
                    </button>
                    <button
                      aria-label="Toggle measurement cursors"
                      aria-pressed={measuring}
                      disabled={!traces.length || clocks.size > 1}
                      title={
                        clocks.size > 1
                          ? 'Align starts or use one time reference to measure together'
                          : 'Drag A/B cursors to measure evaluated samples'
                      }
                      onClick={() => {
                        setMeasuring(!measuring);
                        setMode(measuring ? 'pan' : 'cursor');
                      }}
                    >
                      <Crosshair size={14} /> A/B
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
                      aria-label="Previous plot view"
                      title="Previous view · Backspace"
                      disabled={!backViews[windowKey]?.length}
                      onClick={back}
                    >
                      <Undo2 size={14} />
                    </button>
                    <button
                      aria-label="Pan plot left"
                      disabled={!traces.length}
                      onClick={() => zoom(1, -(window[1] - window[0]) / 4)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      aria-label="Zoom in"
                      disabled={
                        !traces.length || window[1] - window[0] <= 0.000001
                      }
                      onClick={() => zoom(0.5)}
                    >
                      <ZoomIn size={16} />
                    </button>
                    <button
                      aria-label="Zoom out"
                      disabled={!traces.length || window[1] - window[0] >= 1000}
                      onClick={() => zoom(2)}
                    >
                      <ZoomOut size={16} />
                    </button>
                    <button
                      aria-label="Pan plot right"
                      disabled={!traces.length}
                      onClick={() => zoom(1, (window[1] - window[0]) / 4)}
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button aria-label="Fit entire plot" onClick={fit}>
                      <Maximize size={15} /> Fit
                    </button>
                    <button
                      aria-label="Hold Y-axis scales"
                      aria-pressed={!!sheet.axes?.heldY}
                      disabled={!traces.length}
                      title={
                        sheet.axes?.heldY
                          ? 'Release held Y scales and resume autoscaling'
                          : 'Hold current Y scales while zooming and panning time'
                      }
                      onClick={toggleHoldY}
                    >
                      <LockKeyhole size={14} /> Hold Y
                    </button>
                  </fieldset>
                  <fieldset
                    className="scratchpad-mode"
                    aria-label="Plot settings and delivery"
                  >
                    {isActive && (
                      <button
                        aria-label="Active trace properties"
                        title="Trace color and rendering"
                        onClick={() => setStyleTrace(activeId)}
                      >
                        <Activity size={14} />
                      </button>
                    )}
                    <button
                      aria-label="Plot axes and limits"
                      title="Axes and limits · double-click an axis"
                      onClick={() => openAxes()}
                    >
                      <Settings2 size={14} />
                    </button>
                    <button
                      aria-label="Add plot annotation"
                      disabled={
                        !traces.length ||
                        clocks.size > 1 ||
                        (sheet.annotations?.length ?? 0) >= 50
                      }
                      title="Add a time annotation"
                      onClick={() =>
                        setNoteDraft({
                          time: String(
                            (zoomRange(fullRange)[0] +
                              zoomRange(fullRange)[1]) /
                              2,
                          ),
                          text: '',
                          clockId: clocks.values().next().value,
                        })
                      }
                    >
                      <StickyNote size={14} />
                    </button>
                    <button
                      aria-label="Export plot SVG"
                      disabled={!traces.length || exporting}
                      onClick={() => void imageExport('svg')}
                      title="Export current panels as SVG"
                    >
                      SVG
                    </button>
                    <button
                      aria-label="Export plot PNG"
                      disabled={!traces.length || exporting}
                      onClick={() => void imageExport('png')}
                      title="Export current panels as PNG"
                    >
                      PNG
                    </button>
                    <button
                      aria-label="Plot interaction help"
                      title="Plot gestures and shortcuts"
                      onClick={() => setHelpOpen(true)}
                    >
                      <CircleHelp size={14} />
                    </button>
                  </fieldset>
                </div>
                {visibleIds.length ? (
                  plotView?.error ? (
                    <div className="scratchpad-empty" role="alert">
                      <p>{plotView.error}</p>
                      <button
                        className="secondary-button"
                        onClick={() => setRetry((n) => n + 1)}
                      >
                        Retry plot
                      </button>
                    </div>
                  ) : hasSignals && !plotView?.overview ? (
                    <output className="scratchpad-empty">Loading plot…</output>
                  ) : stacked ? (
                    traces
                      .slice(safeStackPage * 8, (safeStackPage + 1) * 8)
                      .map((trace) => (
                        <div className="scratchpad-stack" key={trace.node.id}>
                          <div className="scratchpad-axis-label">
                            <span>
                              {sheet.zeroTime
                                ? 'Elapsed time (Δt)'
                                : graph.timeReferences.get(
                                    signalFor(trace.node.id)?.id ?? '',
                                  )?.name}
                            </span>
                          </div>
                          <SignalChart
                            key={windowKey}
                            traces={[trace]}
                            segments={[]}
                            range={zoomRange(
                              clocks.size > 1
                                ? displayRange(trace.node.id)
                                : fullRange,
                            )}
                            onSegment={() => {}}
                            fluid
                            height={traces.length > 1 ? 185 : 340}
                            fillHeight={traces.length === 1}
                            heading={false}
                            grid={sheet.grid}
                            includeZero={false}
                            interaction={interactionFor(
                              clocks.size > 1
                                ? displayRange(trace.node.id)
                                : fullRange,
                              axisGroups.filter(
                                (axis) =>
                                  axis.key ===
                                  traceAxisKey(
                                    trace.node.unit,
                                    trace.axisId,
                                    sheet.axes,
                                  ),
                              ),
                              sheet.zeroTime
                                ? 'elapsed'
                                : graph.timeReferences.get(
                                    signalFor(trace.node.id)?.id ?? '',
                                  )?.id,
                              trace.node.id,
                            )}
                          />
                        </div>
                      ))
                  ) : (
                    <>
                      <div className="scratchpad-axis-label">
                        <span>
                          {sheet.zeroTime
                            ? 'Elapsed time (Δt)'
                            : graph.timeReferences.get(
                                signalFor(visibleIds[0])?.id ?? '',
                              )?.name}
                        </span>
                      </div>
                      <SignalChart
                        key={windowKey}
                        traces={overlayTraces}
                        segments={[]}
                        range={zoomRange(fullRange)}
                        onSegment={() => {}}
                        fluid
                        height={340}
                        fillHeight
                        heading={false}
                        grid={sheet.grid}
                        includeZero={false}
                        interaction={interactionFor(fullRange)}
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
                          ? 'Empty plot'
                          : 'No signal selected'}
                    </h2>
                    <p>
                      {sheet.traces.length
                        ? 'Show a trace below, or add another signal.'
                        : saved
                          ? 'Add signals or drag outputs from History.'
                          : 'Select a signal in History. Keep a plot when you want to build on it.'}
                    </p>
                    {saved && (
                      <button className="secondary-button" onClick={openPicker}>
                        <Plus size={16} /> Add signals
                      </button>
                    )}
                  </div>
                )}
                {!stacked && axisGroups.length > MAX_CHART_AXES && (
                  <nav
                    className="workflow-list-pages"
                    aria-label="Value axis pages"
                  >
                    <button
                      className="workflow-link"
                      disabled={!safeAxisPage}
                      onClick={() => setAxisPage(safeAxisPage - 1)}
                    >
                      Previous axes
                    </button>
                    <span>
                      Axes {safeAxisPage * MAX_CHART_AXES + 1}–
                      {Math.min(
                        axisGroups.length,
                        (safeAxisPage + 1) * MAX_CHART_AXES,
                      )}{' '}
                      of {axisGroups.length}
                    </span>
                    <button
                      className="workflow-link"
                      disabled={
                        (safeAxisPage + 1) * MAX_CHART_AXES >= axisGroups.length
                      }
                      onClick={() => setAxisPage(safeAxisPage + 1)}
                    >
                      Next axes
                    </button>
                  </nav>
                )}
                {stacked && traces.length > 8 && (
                  <nav
                    className="workflow-list-pages"
                    aria-label="Stacked plot pages"
                  >
                    <button
                      className="workflow-link"
                      disabled={!safeStackPage}
                      onClick={() => setStackPage(safeStackPage - 1)}
                    >
                      Previous plots
                    </button>
                    <span>
                      Traces {safeStackPage * 8 + 1}–
                      {Math.min(traces.length, (safeStackPage + 1) * 8)} of{' '}
                      {traces.length}
                    </span>
                    <button
                      className="workflow-link"
                      disabled={(safeStackPage + 1) * 8 >= traces.length}
                      onClick={() => setStackPage(safeStackPage + 1)}
                    >
                      Next plots
                    </button>
                  </nav>
                )}
                <div className="scratchpad-axis-footer">
                  <span>
                    {sheet.zeroTime
                      ? 'Each trace starts at Δt = 0 s · display only'
                      : clocks.size > 1
                        ? 'Separate time references · independent time axes'
                        : stacked
                          ? 'Shared time axis · separate value axes'
                          : axisGroups.length > 1
                            ? `Shared time · ${axisGroups.length} Y axes`
                            : 'Shared time & value axes'}
                  </span>
                  <span>{formatValue(100 / (window[1] - window[0]), 0)}%</span>
                  <span>
                    {clocks.size <= 1
                      ? `${formatValue(zoomRange(fullRange)[0], 4)}–${formatValue(zoomRange(fullRange)[1], 4)} s`
                      : 'Independent time ranges'}
                  </span>
                  {hasSignals && plotView?.detail?.key !== idsKey && (
                    <output>Refining view…</output>
                  )}
                </div>
              </div>
              {measuring && clocks.size <= 1 && (
                <PlotMeasurements
                  key={windowKey}
                  project={project}
                  request={request}
                  cursors={cursorTimes}
                  onCursors={setCursors}
                  items={visibleIds.map((id) => ({
                    id,
                    label: index.label(id),
                    unit:
                      index.values.get(id)?.unit ??
                      index.nodes.get(id)?.unit ??
                      '',
                    offset: sheet.zeroTime ? timeRange(id)[0] : 0,
                    ...(index.values.has(id)
                      ? { scalar: index.values.get(id)!.value }
                      : {}),
                  }))}
                />
              )}
              {!!sheet.annotations?.length && (
                <details className="plot-notes">
                  <summary>Annotations · {sheet.annotations.length}</summary>
                  {sheet.annotations.map((note) => (
                    <button
                      key={note.id}
                      className="workflow-link"
                      onClick={() =>
                        setNoteDraft({
                          id: note.id,
                          time: String(note.time),
                          text: note.text,
                          clockId: note.clockId,
                        })
                      }
                    >
                      {formatValue(note.time, 4)} s · {note.text}
                    </button>
                  ))}
                </details>
              )}
              {saved ? (
                <div className="scratchpad-traces" aria-label="Plot traces">
                  <div className="scratchpad-trace-heading">
                    <span>TRACES</span>
                    <button
                      className="workflow-link"
                      onClick={() =>
                        update({
                          traces: sheet.traces.map((trace) => ({
                            ...trace,
                            visible: true,
                          })),
                        })
                      }
                    >
                      Show all
                    </button>
                    <span>Value range · plotted interval</span>
                  </div>
                  <WorkflowList
                    items={sheet.traces}
                    initialOpen
                    summary={`${sheet.traces.length} traces · show or edit`}
                  >
                    {(visible) => (
                      <>
                        {visible.map((trace) => {
                          const node =
                              index.values.get(trace.id) ??
                              index.nodes.get(trace.id),
                            plot = plots.get(trace.id);
                          return (
                            <div
                              className="scratchpad-trace"
                              key={trace.id}
                              data-hidden={!trace.visible}
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData(
                                  'application/x-stratum-plot-trace',
                                  JSON.stringify({
                                    sheet: sheet.id,
                                    id: trace.id,
                                  }),
                                );
                              }}
                              onDragOver={(event) => {
                                if (
                                  event.dataTransfer.types.includes(
                                    'application/x-stratum-plot-trace',
                                  )
                                ) {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = 'move';
                                }
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                try {
                                  const item: unknown = JSON.parse(
                                    event.dataTransfer.getData(
                                      'application/x-stratum-plot-trace',
                                    ),
                                  );
                                  if (
                                    item &&
                                    typeof item === 'object' &&
                                    'sheet' in item &&
                                    item.sheet === sheet.id &&
                                    'id' in item &&
                                    typeof item.id === 'string'
                                  )
                                    moveTrace(
                                      item.id,
                                      sheet.traces.indexOf(trace),
                                    );
                                } catch {
                                  /* Ignore foreign data. */
                                }
                              }}
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
                                {trace.visible ? (
                                  <Eye size={15} />
                                ) : (
                                  <EyeOff size={15} />
                                )}
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
                                title="Double-click to edit trace style"
                                onClick={() => setStyleTrace(trace.id)}
                                onDoubleClick={() => setStyleTrace(trace.id)}
                              >
                                <strong>
                                  {node
                                    ? index.label(trace.id)
                                    : 'Signal unavailable'}
                                </strong>
                                <small>
                                  {node
                                    ? index.values.has(trace.id)
                                      ? 'Scalar value · reference line'
                                      : graph.timeReferences.get(trace.id)?.name
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
                                aria-label={`Isolate trace ${index.label(trace.id)}`}
                                title="Show only this trace"
                                onClick={() =>
                                  update({
                                    traces: sheet.traces.map((item) => ({
                                      ...item,
                                      visible: item.id === trace.id,
                                    })),
                                  })
                                }
                              >
                                <Crosshair size={13} />
                              </button>
                              <button
                                className="workflow-icon-button"
                                aria-label={`Move trace up ${index.label(trace.id)}`}
                                disabled={sheet.traces.indexOf(trace) === 0}
                                onClick={() =>
                                  moveTrace(
                                    trace.id,
                                    sheet.traces.indexOf(trace) - 1,
                                  )
                                }
                              >
                                <ArrowUp size={13} />
                              </button>
                              <button
                                className="workflow-icon-button"
                                aria-label={`Move trace down ${index.label(trace.id)}`}
                                disabled={
                                  sheet.traces.indexOf(trace) ===
                                  sheet.traces.length - 1
                                }
                                onClick={() =>
                                  moveTrace(
                                    trace.id,
                                    sheet.traces.indexOf(trace) + 1,
                                  )
                                }
                              >
                                <ArrowDown size={13} />
                              </button>
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
                      </>
                    )}
                  </WorkflowList>
                </div>
              ) : null}
            </>
          )}
          {isActive && (
            <details
              className="plot-output-dock"
              key={outputKey}
              open={!activeId || view === 'outputs' || outputsOpen}
              onToggle={(event) => setOutputsOpen(event.currentTarget.open)}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  onView('result');
                  setOutputsOpen(!(view === 'outputs' || outputsOpen));
                }}
              >
                <Table2 size={14} /> Operation outputs{' '}
                <span>{outputCount}</span>
              </summary>
              {(!activeId || view === 'outputs' || outputsOpen) && outputs}
            </details>
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
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="workflow-dialog plot-settings-dialog">
          <DialogTitle>Plot axes and limits</DialogTitle>
          <DialogDescription>
            Each Y axis has independent limits. Add an axis in the selected
            unit, then assign signals in Trace properties. Blank names and
            limits use automatic labels and scaling. Hold Y keeps automatic
            scales fixed until released.
          </DialogDescription>
          <form
            className="plot-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              const range: PlotRange = [
                Number(axisDraft.start),
                Number(axisDraft.end),
              ];
              const values = {
                ...editAxes.values,
                [primaryAxisKey]: valueAxisSettings(
                  sheet.axes,
                  primaryAxisKey,
                  primaryAxisKey,
                ),
              };
              for (const [key, draft] of Object.entries({
                ...axisEdits,
                [axisDraft.key]: axisDraft,
              })) {
                if (removedAxes.includes(key)) continue;
                const y: PlotRange | undefined =
                  !draft.min.trim() && !draft.max.trim()
                    ? undefined
                    : [Number(draft.min), Number(draft.max)];
                if (
                  y &&
                  (!draft.min.trim() ||
                    !draft.max.trim() ||
                    !validPlotRange(y) ||
                    (draft.log && y[0] <= 0))
                ) {
                  setAxisError(
                    `${axisOptions.find((axis) => axis.key === key)?.label ?? key}: enter increasing Y limits. Log Y requires a positive minimum.`,
                  );
                  return;
                }
                values[key] = {
                  ...values[key],
                  y,
                  log: draft.log,
                  label: draft.label.trim() || undefined,
                };
              }
              if (
                clocks.size <= 1 &&
                (!axisDraft.start.trim() ||
                  !axisDraft.end.trim() ||
                  !validPlotRange(range))
              ) {
                setAxisError('Enter finite, increasing time limits.');
                return;
              }
              if (clocks.size <= 1)
                setWindow([
                  (range[0] - fullRange[0]) / (fullRange[1] - fullRange[0]),
                  (range[1] - fullRange[0]) / (fullRange[1] - fullRange[0]),
                ]);
              if (
                range[0] === zoomRange(fullRange)[0] &&
                range[1] === zoomRange(fullRange)[1]
              )
                rememberView();
              update({
                axes: {
                  values,
                  heldY: sheet.axes?.heldY,
                  timeLabel: axisDraft.timeLabel.trim() || undefined,
                },
              });
              setSettingsOpen(false);
            }}
          >
            <label className="plot-axis-field" htmlFor="plot-axis-selection">
              Y axis
              <PlotSelect
                id="plot-axis-selection"
                label="Y axis"
                value={axisDraft.key}
                onChange={chooseAxis}
                options={axisChoices}
              />
            </label>
            <div className="plot-axis-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={customAxisCount >= MAX_CUSTOM_AXES}
                onClick={() =>
                  addValueAxis(
                    axisOptions.find((axis) => axis.key === axisDraft.key)
                      ?.unit ?? '',
                  )
                }
              >
                <Plus size={14} />
                Add Y axis
              </button>
              {axisDraft.key.startsWith('axis:') && (
                <button
                  type="button"
                  className="secondary-button"
                  title="Reassign any signals before removing their axis"
                  disabled={axisTraces.some(
                    (trace) =>
                      traceAxisKey(trace.unit, trace.axisId, editAxes) ===
                      axisDraft.key,
                  )}
                  onClick={() => {
                    const key = axisDraft.key;
                    setRemovedAxes([...removedAxes, key]);
                    chooseAxis(
                      axisOptions.find((axis) => axis.key !== key)?.key ??
                        primaryAxisKey,
                    );
                  }}
                >
                  Remove Y axis
                </button>
              )}
            </div>
            <div className="plot-axis-names">
              <label className="plot-axis-field">
                Time axis name
                <input
                  aria-label="Time axis name"
                  maxLength={160}
                  value={axisDraft.timeLabel}
                  placeholder={sheet.zeroTime ? 'Elapsed time (s)' : 'Time (s)'}
                  onChange={(event) =>
                    setAxisDraft({
                      ...axisDraft,
                      timeLabel: event.target.value,
                    })
                  }
                />
              </label>
              <label className="plot-axis-field">
                Y axis name
                <input
                  aria-label="Y axis name"
                  maxLength={160}
                  value={axisDraft.label}
                  placeholder={
                    axisOptions.find((axis) => axis.key === axisDraft.key)
                      ?.label
                  }
                  onChange={(event) =>
                    setAxisDraft({ ...axisDraft, label: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="plot-limit-grid">
              {(['start', 'end', 'min', 'max'] as const).map((field) => (
                <label key={field}>
                  {
                    {
                      start: 'Time start (s)',
                      end: 'Time end (s)',
                      min: 'Y minimum',
                      max: 'Y maximum',
                    }[field]
                  }
                  <input
                    type="number"
                    step="any"
                    disabled={
                      clocks.size > 1 && (field === 'start' || field === 'end')
                    }
                    value={axisDraft[field]}
                    placeholder={
                      field === 'min' || field === 'max'
                        ? 'Automatic'
                        : undefined
                    }
                    onChange={(event) =>
                      setAxisDraft({
                        ...axisDraft,
                        [field]: event.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </div>
            {clocks.size > 1 && (
              <p>
                Independent time references: use plot gestures or align starts
                before entering common time limits.
              </p>
            )}
            <label className="plot-checkbox">
              <input
                type="checkbox"
                checked={axisDraft.log}
                onChange={(event) =>
                  setAxisDraft({ ...axisDraft, log: event.target.checked })
                }
              />{' '}
              Logarithmic Y axis
            </label>
            {axisError && <p role="alert">{axisError}</p>}
            <div className="plot-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  fit();
                  setSettingsOpen(false);
                }}
              >
                Automatic / fit
              </button>
              <button className="primary-button">Apply axes</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!noteDraft}
        onOpenChange={(open) => {
          if (!open) setNoteDraft(undefined);
        }}
      >
        <DialogContent className="workflow-dialog plot-settings-dialog">
          <DialogTitle>
            {noteDraft?.id ? 'Edit annotation' : 'Add annotation'}
          </DialogTitle>
          <DialogDescription>
            Drag the label vertically to reposition it at the same time.
            Double-click its marker to edit it.
          </DialogDescription>
          {noteDraft && (
            <form
              className="plot-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                const time = Number(noteDraft.time);
                if (
                  !noteDraft.time.trim() ||
                  !Number.isFinite(time) ||
                  !noteDraft.text.trim()
                )
                  return;
                const note = {
                  ...sheet.annotations?.find(
                    (item) => item.id === noteDraft.id,
                  ),
                  id: noteDraft.id ?? crypto.randomUUID(),
                  time,
                  text: noteDraft.text.trim().slice(0, 160),
                  clockId: noteDraft.clockId,
                };
                const existing = sheet.annotations ?? [];
                update({
                  annotations: noteDraft.id
                    ? existing.map((item) =>
                        item.id === noteDraft.id ? note : item,
                      )
                    : [...existing, note].slice(0, 50),
                });
                setNoteDraft(undefined);
              }}
            >
              <label>
                Time (s)
                <input
                  aria-label="Annotation time"
                  type="number"
                  step="any"
                  required
                  value={noteDraft.time}
                  onChange={(event) =>
                    setNoteDraft({ ...noteDraft, time: event.target.value })
                  }
                />
              </label>
              <label>
                Text
                <input
                  aria-label="Annotation text"
                  required
                  maxLength={160}
                  value={noteDraft.text}
                  onChange={(event) =>
                    setNoteDraft({ ...noteDraft, text: event.target.value })
                  }
                />
              </label>
              <div className="plot-dialog-actions">
                {noteDraft.id && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      update({
                        annotations: sheet.annotations?.filter(
                          (note) => note.id !== noteDraft.id,
                        ),
                      });
                      setNoteDraft(undefined);
                    }}
                  >
                    Remove annotation
                  </button>
                )}
                <button className="primary-button">Save annotation</button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!styleTrace}
        onOpenChange={(open) => {
          if (!open) setStyleTrace(undefined);
        }}
      >
        <DialogContent className="workflow-dialog plot-settings-dialog">
          <DialogTitle>Trace properties</DialogTitle>
          <DialogDescription>
            {styleTrace ? index.label(styleTrace) : ''}
          </DialogDescription>
          {styleTrace && (
            <div className="plot-settings-form">
              <label htmlFor="plot-trace-axis">
                Y axis
                <PlotSelect
                  id="plot-trace-axis"
                  label="Trace Y axis"
                  value={traceAxisKey(
                    traceUnit(styleTrace),
                    sheet.traces.find((trace) => trace.id === styleTrace)
                      ?.axisId,
                    sheet.axes,
                  )}
                  options={axisChoices.filter(
                    (choice) =>
                      axisOptions.find((axis) => axis.key === choice.value)
                        ?.unit === traceUnit(styleTrace).trim(),
                  )}
                  onChange={(axisId) =>
                    update({
                      traces: sheet.traces.map((trace) =>
                        trace.id === styleTrace ? { ...trace, axisId } : trace,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="secondary-button"
                disabled={customAxisCount >= MAX_CUSTOM_AXES}
                onClick={() => addValueAxis(traceUnit(styleTrace), styleTrace)}
              >
                <Plus size={14} />
                Add Y axis
              </button>
              <label>
                Color
                <input
                  type="color"
                  aria-label="Trace color"
                  value={
                    sheet.traces.find((trace) => trace.id === styleTrace)
                      ?.color ?? TRACE_COLORS[0]
                  }
                  onChange={(event) =>
                    update({
                      traces: sheet.traces.map((trace) =>
                        trace.id === styleTrace
                          ? { ...trace, color: event.target.value }
                          : trace,
                      ),
                    })
                  }
                />
              </label>
              <label htmlFor="plot-trace-rendering">
                Rendering
                <PlotSelect
                  id="plot-trace-rendering"
                  label="Trace rendering"
                  value={
                    sheet.traces.find((trace) => trace.id === styleTrace)
                      ?.style ?? 'line'
                  }
                  onChange={(style) =>
                    update({
                      traces: sheet.traces.map((trace) =>
                        trace.id === styleTrace
                          ? {
                              ...trace,
                              style: style as PlotTrace['style'],
                            }
                          : trace,
                      ),
                    })
                  }
                  options={[
                    { value: 'line', label: 'Line' },
                    { value: 'points', label: 'Points' },
                    { value: 'step', label: 'Step (hold previous)' },
                  ]}
                />
              </label>
              <label htmlFor="plot-trace-width">
                Line width
                <PlotSelect
                  id="plot-trace-width"
                  label="Trace line width"
                  value={String(
                    sheet.traces.find((trace) => trace.id === styleTrace)
                      ?.width ?? 1.45,
                  )}
                  onChange={(width) =>
                    update({
                      traces: sheet.traces.map((trace) =>
                        trace.id === styleTrace
                          ? { ...trace, width: Number(width) }
                          : trace,
                      ),
                    })
                  }
                  options={[
                    { value: '1.45', label: 'Standard' },
                    { value: '1', label: 'Thin' },
                    { value: '2', label: 'Medium' },
                    { value: '3', label: 'Heavy' },
                    { value: '4', label: 'Extra heavy' },
                  ]}
                />
              </label>
              <div className="plot-dialog-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    onInspect(styleTrace);
                    setStyleTrace(undefined);
                  }}
                >
                  Inspect source
                </button>
                <button
                  className="primary-button"
                  onClick={() => setStyleTrace(undefined)}
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="workflow-dialog plot-settings-dialog">
          <DialogTitle>Plot interactions</DialogTitle>
          <DialogDescription>
            Click a plot to focus it. Tools and keyboard commands act on the
            current plot.
          </DialogDescription>
          <dl className="plot-shortcuts">
            <dt>Drag axis</dt>
            <dd>Pan that axis only. Escape cancels the drag.</dd>
            <dt>Drag plot / Shift-drag</dt>
            <dd>Pan in time; Shift always pans.</dd>
            <dt>Wheel</dt>
            <dd>
              Over an axis, zoom only that axis about the pointer. Over a
              focused plot, zoom time.
            </dd>
            <dt>Zoom + drag</dt>
            <dd>Select a time band.</dd>
            <dt>Double-click plot</dt>
            <dd>Add an annotation at the pointer time.</dd>
            <dt>Drag annotation</dt>
            <dd>Move its label vertically while keeping its time fixed.</dd>
            <dt>Fit / Home</dt>
            <dd>Fit the complete signal and automatic Y limits.</dd>
            <dt>Hold Y</dt>
            <dd>
              Keep current Y scales while zooming and panning time. Click again
              to resume autoscaling; manual axis limits still apply. Fit
              releases the hold.
            </dd>
            <dt>Double-click axis / right-click</dt>
            <dd>Set time and Y limits, or logarithmic Y.</dd>
            <dt>+ / − / arrows</dt>
            <dd>Zoom and pan. Backspace returns to the previous view.</dd>
            <dt>Escape</dt>
            <dd>Cancel the current drag.</dd>
            <dt>A/B</dt>
            <dd>
              Drag the nearest cursor or enter its time in the measurement tray.
              Values come from evaluated samples.
            </dd>
            <dt>Tabs / trace rows</dt>
            <dd>
              Drag to reorder. Middle-click a plot tab to close it. Double-click
              a tab to rename, a trace to style, or a note to edit.
            </dd>
            <dt>Drop from History</dt>
            <dd>
              Add signals and scalar references. Segment members retain their
              operation family. Use Add signals for individual members.
            </dd>
            <dt>SVG / PNG</dt>
            <dd>
              Export the currently rendered panels. Samples and reports use
              workflow export.
            </dd>
          </dl>
        </DialogContent>
      </Dialog>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="workflow-dialog workflow-rename">
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
            Choose signals or scalar values. Each unit gets its own Y axis.
            Unrelated time references use stacked plots until starts are
            aligned.
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
            <span>{draft.length} selected</span>
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
                    {node.unit}
                    {index.values.has(node.id) ? ' · value' : ''} ·{' '}
                    {
                      graph.timeReferences.get(
                        index.values.get(node.id)?.inputId ?? node.id,
                      )?.name
                    }
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
                          color: TRACE_COLORS[i % TRACE_COLORS.length],
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

export function SignalSamples({
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
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{
    project: Project;
    page: number;
    rows?: Point[];
    more?: boolean;
    error?: string;
  }>();
  useEffect(() => {
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
  }, [page, project, id, request]);
  const current =
    state?.project === project && state.page === page ? state : undefined;
  return (
    <div className="scratchpad-samples">
      <div className="scratchpad-sample-actions">
        <button className="workflow-link" disabled={busy} onClick={onExport}>
          <Download size={15} /> Export / report
        </button>
      </div>
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
    </div>
  );
}
