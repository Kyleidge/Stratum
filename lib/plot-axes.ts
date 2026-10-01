import type { Plot } from './signal-types';
import {
  validPlotRange,
  type PlotAxes,
  type PlotRange,
  type PlotValueAxis,
} from './plot-scratchpad';

export const MAX_CHART_AXES = 8;
export const plotAxisKey = (unit: string) => `unit:${unit.trim()}`;
export const heldValueAxisKey = (axisKey: string, traceId?: string) =>
  traceId ? `trace:${JSON.stringify([traceId, axisKey])}` : axisKey;
export type PlotAxisGroup = {
  key: string;
  unit: string;
  label: string;
  color: string;
};
type AxisTrace = {
  unit: string;
  name: string;
  color: string;
  axisId?: string;
  /** Value reference lines name an axis only when no signal shares it. */
  reference?: boolean;
};

export function traceAxisKey(
  unit: string,
  axisId?: string,
  axes?: PlotAxes,
): string {
  return axisId?.startsWith('axis:') &&
    axes?.values?.[axisId]?.unit === unit.trim()
    ? axisId
    : plotAxisKey(unit);
}

/** Exact unit strings share a scale; no implicit conversion between units. */
export function groupPlotAxes(
  items: AxisTrace[],
  axes?: PlotAxes,
  includeEmpty = false,
): PlotAxisGroup[] {
  const groups = new Map<
    string,
    {
      unit: string;
      names: Set<string>;
      references: Set<string>;
      color: string;
    }
  >();
  for (const item of items) {
    const key = traceAxisKey(item.unit, item.axisId, axes);
    const group = groups.get(key) ?? {
      unit: item.unit.trim(),
      names: new Set<string>(),
      references: new Set<string>(),
      color: item.color,
    };
    (item.reference ? group.references : group.names).add(
      item.name.trim() || 'Value',
    );
    groups.set(key, group);
  }
  if (includeEmpty)
    for (const [key, axis] of Object.entries(axes?.values ?? {})) {
      if (
        key.startsWith('axis:') &&
        axis.unit !== undefined &&
        !groups.has(key)
      )
        groups.set(key, {
          unit: axis.unit,
          names: new Set(['Y axis']),
          references: new Set<string>(),
          color: 'var(--ink-3)',
        });
    }
  return [...groups].map(([key, group]) => {
    const names = [...(group.names.size ? group.names : group.references)];
    const name =
      names.slice(0, 2).join(' / ') +
      (names.length > 2 ? ` +${names.length - 2}` : '');
    return {
      key,
      unit: group.unit,
      color: group.color,
      label:
        axes?.values?.[key]?.label || `${name} (${group.unit || 'unitless'})`,
    };
  });
}

/** Offer each unit's automatic axis as well as compatible named extra axes. */
export function plotAxisOptions(
  items: AxisTrace[],
  axes?: PlotAxes,
): PlotAxisGroup[] {
  const automatic = groupPlotAxes(
    items.map((item) => ({ ...item, axisId: undefined })),
    axes,
  );
  const assigned = groupPlotAxes(items, axes, true);
  return [
    ...new Map(
      [...automatic, ...assigned].map((axis) => [axis.key, axis]),
    ).values(),
  ];
}

/** Shift in scale coordinates, retaining logarithmic ratios and missing data. */
export function panValueAxis(
  range: PlotRange,
  fraction: number,
  log = false,
): PlotRange {
  if (
    !validPlotRange(range) ||
    !Number.isFinite(fraction) ||
    (log && range[0] <= 0)
  )
    return range;
  const low = log ? Math.log10(range[0]) : range[0];
  const high = log ? Math.log10(range[1]) : range[1];
  const shift = (high - low) * fraction;
  const next: PlotRange = log
    ? [10 ** (low + shift), 10 ** (high + shift)]
    : [low + shift, high + shift];
  return validPlotRange(next) && (!log || next[0] > 0) ? next : range;
}

/** Legacy single-axis limits belong to the first unit, never to other units. */
export function valueAxisSettings(
  axes: PlotAxes | undefined,
  key: string,
  primaryKey: string,
): PlotValueAxis {
  return (
    axes?.values?.[key] ??
    (key === primaryKey
      ? { y: axes?.y, log: axes?.log, label: axes?.label }
      : {})
  );
}

export function valueAxisRange(
  plots: Plot[],
  settings: PlotValueAxis,
  includeZero: boolean,
  held?: PlotRange,
): PlotRange {
  if (validPlotRange(settings.y) && (!settings.log || settings.y[0] > 0))
    return settings.y;
  if (validPlotRange(held) && (!settings.log || held[0] > 0)) return held;
  let low = Infinity,
    high = -Infinity;
  const include = (value: number) => {
    if (!Number.isFinite(value) || (settings.log && value <= 0)) return;
    low = Math.min(low, value);
    high = Math.max(high, value);
  };
  for (const plot of plots) {
    if (plot.summary.count) {
      include(plot.summary.min);
      include(plot.summary.max);
    }
    if (!plot.summary.count || settings.log)
      for (const [, value] of plot.points) include(value);
  }
  const safeLow = Number.isFinite(low) ? low : settings.log ? 0.1 : 0;
  const safeHigh = Number.isFinite(high) ? high : 1;
  const padding = (safeHigh - safeLow || Math.abs(safeHigh) || 1) * 0.08;
  return settings.log
    ? [
        safeLow / 1.1 || Number.MIN_VALUE,
        Math.min(Number.MAX_VALUE, safeHigh * 1.1),
      ]
    : [
        includeZero ? Math.min(0, safeLow - padding) : safeLow - padding,
        includeZero ? Math.max(0, safeHigh + padding) : safeHigh + padding,
      ];
}

/** Snapshot the displayed scales without reading or evaluating more samples. */
export function holdPlotYAxes(
  traces: { id: string; unit: string; axisId?: string; plot: Plot }[],
  axes: PlotAxes | undefined,
  primaryKey: string,
): Record<string, PlotRange> {
  const held: Record<string, PlotRange> = {};
  const groups = new Map<string, Plot[]>();
  for (const trace of traces) {
    const key = traceAxisKey(trace.unit, trace.axisId, axes);
    const settings = valueAxisSettings(axes, key, primaryKey);
    held[heldValueAxisKey(key, trace.id)] = valueAxisRange(
      [trace.plot],
      settings,
      false,
    );
    const plots = groups.get(key) ?? [];
    plots.push(trace.plot);
    groups.set(key, plots);
  }
  for (const [key, plots] of groups)
    held[key] = valueAxisRange(
      plots,
      valueAxisSettings(axes, key, primaryKey),
      false,
    );
  return held;
}

/** Zoom about a vertical pointer fraction, in log space for logarithmic axes. */
export function zoomValueAxis(
  range: PlotRange,
  factor: number,
  anchor: number,
  log = false,
): PlotRange {
  if (
    !validPlotRange(range) ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    !Number.isFinite(anchor) ||
    (log && range[0] <= 0)
  )
    return range;
  const low = log ? Math.log10(range[0]) : range[0];
  const high = log ? Math.log10(range[1]) : range[1];
  const pivot = low + (high - low) * Math.max(0, Math.min(1, anchor));
  const min = pivot + (low - pivot) * factor;
  const max = pivot + (high - pivot) * factor;
  const next: PlotRange = log ? [10 ** min, 10 ** max] : [min, max];
  return validPlotRange(next) &&
    (!log || next[0] > 0) &&
    max - min >
      Math.max(log ? 1 : Number.MIN_VALUE, Math.abs(min), Math.abs(max)) *
        Number.EPSILON *
        16
    ? next
    : range;
}
