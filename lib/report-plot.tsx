import { renderToStaticMarkup } from 'react-dom/server';
import SignalChart, {
  formatValue,
  type ChartInteraction,
} from '@/components/signal-chart';
import { SignalGraph } from './signal-graph';
import { WorkflowIndex } from './workflow-history';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  Project,
} from './signal-types';
import {
  groupPlotAxes,
  heldValueAxisKey,
  MAX_CHART_AXES,
  plotAxisKey,
  traceAxisKey,
  valueAxisSettings,
} from './plot-axes';
import {
  plotExtent,
  valueReference,
  type PlotRange,
  type PlotSheet,
} from './plot-scratchpad';
import { capturePlotSvg } from './plot-export';
import { createBlock, type ReportBlock } from './report-mockup';
import { reportSource } from './report-data';

export const MAX_REPORT_PLOT_TRACES = 30;
const MAX_REPORT_PLOT_BYTES = 8 * 1024 * 1024;
const noAction = () => {};

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('Plot capture cancelled.', 'AbortError');
}

/** Capture saved settings without switching tabs or changing workspace selection. */
export async function captureReportPlot(
  project: Project,
  sheet: PlotSheet,
  request: (message: EngineRequest) => Promise<EngineResponse>,
  signal?: AbortSignal,
): Promise<ReportBlock[]> {
  checkAbort(signal);
  const visible = sheet.traces.filter((trace) => trace.visible);
  if (!visible.length)
    throw new Error('This saved plot has no visible traces.');
  if (visible.length > MAX_REPORT_PLOT_TRACES)
    throw new Error(
      `Report snapshots support up to ${MAX_REPORT_PLOT_TRACES} visible traces. Split this saved plot before adding it.`,
    );
  const index = new WorkflowIndex(project);
  const graph = new SignalGraph(project);
  for (const trace of visible)
    if (!index.nodes.has(trace.id) && !index.values.has(trace.id))
      throw new Error(
        'A visible output in this saved plot no longer exists. Update the plot before adding it.',
      );
  const signalFor = (id: string) =>
    index.nodes.get(id) ?? index.nodes.get(index.values.get(id)?.inputId ?? '');
  const timeRange = (id: string): PlotRange => {
    const value = index.values.get(id);
    return value ? [value.start, value.end] : (graph.ranges.get(id) ?? [0, 1]);
  };
  const displayRange = (id: string): PlotRange => {
    const range = timeRange(id);
    return sheet.zeroTime ? [0, range[1] - range[0]] : range;
  };
  const clockFor = (id: string) =>
    sheet.zeroTime
      ? 'elapsed'
      : (graph.timeReferences.get(signalFor(id)?.id ?? '')?.id ?? id);
  const clocks = new Set(visible.map((trace) => clockFor(trace.id)));
  const fullRange = plotExtent(
    visible.reduce<PlotRange>(
      (range, trace) => {
        const extent = displayRange(trace.id);
        return [Math.min(range[0], extent[0]), Math.max(range[1], extent[1])];
      },
      [Infinity, -Infinity],
    ),
  );
  const viewport = sheet.window ?? [0, 1];
  const zoomRange = (range: PlotRange): PlotRange => {
    const extent = plotExtent(range);
    const span = extent[1] - extent[0];
    return [extent[0] + viewport[0] * span, extent[0] + viewport[1] * span];
  };
  const plots = new Map<string, Plot>();
  const plotRanges = new Map<string, PlotRange>();
  const signals = visible.filter((trace) => index.nodes.has(trace.id));
  const firstTrace = sheet.traces.find(
    (trace) => index.nodes.has(trace.id) || index.values.has(trace.id),
  );
  const primaryAxisKey = plotAxisKey(
    firstTrace
      ? (index.values.get(firstTrace.id)?.unit ??
          index.nodes.get(firstTrace.id)?.unit ??
          '')
      : '',
  );
  // The same layout rules as the plot workspace: overlays split different
  // units into lanes unless independent Y axes are chosen, and separate time
  // references share time values except in stacked panels.
  const stacked = sheet.layout === 'stacked';
  const independent = stacked && clocks.size > 1;
  const multiAxis = !stacked && sheet.layout === 'axes';
  async function readPlots(
    ranges: Record<string, PlotRange>,
    destination: Map<string, Plot>,
  ) {
    const ids = Object.keys(ranges);
    checkAbort(signal);
    const response = await request({ type: 'view', ids, ranges });
    checkAbort(signal);
    if (response.type !== 'plots')
      throw new Error('The saved plot could not be evaluated for the report.');
    for (const plot of response.plots) destination.set(plot.id, plot);
    if (ids.some((id) => !destination.has(id)))
      throw new Error(
        'A saved plot trace could not be evaluated. No snapshot was added.',
      );
  }
  // Keep individual worker reads bounded and allow cancellation between reads.
  for (let start = 0; start < signals.length; start += 8) {
    const batch = signals.slice(start, start + 8);
    const ranges = Object.fromEntries(
      batch.map(({ id }) => {
        const display = zoomRange(independent ? displayRange(id) : fullRange);
        const offset = sheet.zeroTime ? timeRange(id)[0] : 0;
        return [id, [display[0] + offset, display[1] + offset] as PlotRange];
      }),
    );
    await readPlots(ranges, plots);
    for (const [id, range] of Object.entries(ranges)) plotRanges.set(id, range);
  }
  // SignalChart holds new/invalid held axes to overview data until Hold Y is
  // released. Keep that full extent separate from the exact viewport drawing.
  const overviewPlots = new Map<string, Plot>();
  const overviewRanges = new Map<string, PlotRange>();
  const overviewSignals = signals.filter((trace) => {
    if (!sheet.axes?.heldY) return false;
    const key = traceAxisKey(
      index.nodes.get(trace.id)!.unit,
      trace.axisId,
      sheet.axes,
    );
    const settings = valueAxisSettings(sheet.axes, key, primaryAxisKey);
    const held =
      sheet.axes.heldY[heldValueAxisKey(key, stacked ? trace.id : undefined)];
    return !held || (!!settings.log && held[0] <= 0);
  });
  for (let start = 0; start < overviewSignals.length; start += 8) {
    const batch = overviewSignals.slice(start, start + 8);
    const ranges = Object.fromEntries(
      batch.map(({ id }) => [id, timeRange(id)]),
    );
    await readPlots(ranges, overviewPlots);
    for (const [id, range] of Object.entries(ranges))
      overviewRanges.set(id, range);
  }
  const traces = visible.map((trace) => {
    const value = index.values.get(trace.id);
    const node = signalFor(trace.id);
    if (!node) throw new Error('A saved plot value has lost its input signal.');
    const reference = value
      ? valueReference(value, node.unit, (number) => formatValue(number, 1))
      : undefined;
    const y = reference?.y ?? NaN;
    const plot: Plot = value
      ? {
          id: value.id,
          points: [
            [value.start, y],
            [value.end, y],
          ],
          summary: {
            count: Number.isFinite(y) ? 1 : 0,
            start: value.start,
            end: value.end,
            min: y,
            max: y,
            mean: y,
            integral: NaN,
          },
        }
      : plots.get(trace.id)!;
    return {
      node: value
        ? {
            ...node,
            id: value.id,
            name: index.label(value.id),
            unit: reference!.unit,
            operation: 'raw' as const,
          }
        : node,
      plot,
      drawingView: value
        ? undefined
        : {
            overview: {
              key: 'report-overview',
              plots: overviewPlots,
              ranges: overviewRanges,
            },
            detail: { key: 'report-viewport', plots, ranges: plotRanges },
          },
      color: trace.color,
      label: trace.label ?? index.label(trace.id),
      offset: sheet.zeroTime ? timeRange(trace.id)[0] : 0,
      referenceLine: !!value,
      referenceLabel: reference?.label,
      referenceTime: value?.timestamp,
      style: trace.style,
      width: trace.width,
      axisId: trace.axisId,
    };
  });
  const axes = groupPlotAxes(
    traces.map((trace) => ({
      unit: trace.node.unit,
      name: trace.label,
      color: trace.color,
      axisId: trace.axisId,
      reference: trace.referenceLine,
    })),
    sheet.axes,
    true,
  );
  const axisKey = (trace: (typeof traces)[number]) =>
    traceAxisKey(trace.node.unit, trace.axisId, sheet.axes);
  const panels = stacked
    ? traces.map((trace) => ({
        traces: [trace],
        axes: axes.filter((axis) => axis.key === axisKey(trace)),
      }))
    : Array.from(
        { length: Math.ceil(axes.length / MAX_CHART_AXES) },
        (_, panel) => {
          const panelAxes = axes.slice(
            panel * MAX_CHART_AXES,
            (panel + 1) * MAX_CHART_AXES,
          );
          return {
            traces: traces.filter((trace) =>
              panelAxes.some((axis) => axis.key === axisKey(trace)),
            ),
            axes: panelAxes,
          };
        },
      );
  const blocks: ReportBlock[] = [];
  if (panels.length > 32)
    throw new Error(
      'Report snapshots support up to 32 plot panels. Split this saved plot before adding it.',
    );
  let bytes = 0;
  for (const [panelIndex, panel] of panels.entries()) {
    checkAbort(signal);
    const first = panel.traces[0];
    const own = independent && first ? first.node.id : undefined;
    const panelClocks = own ? [clockFor(own)] : [...clocks];
    const range = zoomRange(own ? displayRange(own) : fullRange);
    const interaction: ChartInteraction = {
      mode: 'pan',
      axes: sheet.axes,
      primaryAxisKey,
      valueAxes: panel.axes,
      traceId: stacked ? first?.node.id : undefined,
      timeLabel: sheet.zeroTime ? 'Elapsed time (s)' : 'Time (s)',
      cursors:
        sheet.measuring && !independent
          ? (sheet.cursors ?? [
              fullRange[0] + (fullRange[1] - fullRange[0]) / 3,
              fullRange[0] + (2 * (fullRange[1] - fullRange[0])) / 3,
            ])
          : undefined,
      annotations: sheet.annotations?.filter((note) =>
        note.clockId ? panelClocks.includes(note.clockId) : clocks.size <= 1,
      ),
      onRange: noAction,
      onCursors: noAction,
      onFit: noAction,
      onBack: noAction,
      onAxes: noAction,
      onValueRange: noAction,
      onAnnotation: noAction,
      onAnnotationPosition: noAction,
    };
    const label = `${sheet.name}${panels.length > 1 ? ` · panel ${panelIndex + 1} of ${panels.length}` : ''}`;
    const clockLabel = sheet.zeroTime
      ? 'Elapsed time (Δt)'
      : [
          ...new Set(
            panel.traces.map(
              (trace) =>
                graph.timeReferences.get(signalFor(trace.node.id)?.id ?? '')
                  ?.name ?? '',
            ),
          ),
        ]
          .filter(Boolean)
          .join(' · ');
    // Different units share one time axis in lanes, drawn by the lowest lane.
    const lanes = !stacked && !multiAxis && panel.axes.length > 1;
    // Existing application CSS is resolved locally before the SVG is detached.
    const host = document.createElement('div');
    host.className = 'plot-scratchpad';
    host.style.cssText =
      'position:fixed;left:-20000px;top:0;width:900px;pointer-events:none';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = renderToStaticMarkup(
      <div className="scratchpad-canvas">
        <div className="scratchpad-axis-label">
          <span>{clockLabel}</span>
        </div>
        {lanes ? (
          panel.axes.map((axis, i) => (
            <div className="scratchpad-lane" key={axis.key}>
              <SignalChart
                traces={panel.traces.filter(
                  (trace) => axisKey(trace) === axis.key,
                )}
                segments={[]}
                range={range}
                onSegment={noAction}
                fluid
                height={180}
                heading={false}
                grid={sheet.grid}
                includeZero={false}
                timeAxis={i === panel.axes.length - 1}
                interaction={{ ...interaction, valueAxes: [axis] }}
              />
            </div>
          ))
        ) : (
          <SignalChart
            traces={panel.traces}
            segments={[]}
            range={range}
            onSegment={noAction}
            fluid
            height={340}
            heading={false}
            grid={sheet.grid}
            includeZero={false}
            interaction={interaction}
          />
        )}
      </div>,
    );
    document.body.appendChild(host);
    try {
      const { background, ...snapshot } = capturePlotSvg(
        host,
        label,
        panel.traces.map((trace) => ({
          label: `${trace.label} (${trace.node.unit || 'unitless'})`,
          color: trace.color,
        })),
      );
      bytes += new TextEncoder().encode(snapshot.svg).byteLength;
      if (bytes > MAX_REPORT_PLOT_BYTES)
        throw new Error(
          'This plot snapshot exceeds 8 MiB. Split it into smaller saved plots before adding it.',
        );
      blocks.push(
        createBlock('plot', {
          name: label,
          text: label,
          width: 640,
          height: Math.max(
            140,
            Math.min(800, (640 * snapshot.height) / snapshot.width),
          ),
          padding: 0,
          fill: background,
          plotSnapshot: snapshot,
          ...(blocks.length ? {} : { plotSheet: structuredClone(sheet) }),
          source: reportSource(
            project,
            (panel.traces.length ? panel.traces : traces).map(
              (trace) => trace.node.id,
            ),
            'plot',
            `${label} · saved plot snapshot`,
          ),
        }),
      );
    } finally {
      host.remove();
    }
  }
  checkAbort(signal);
  return blocks;
}
