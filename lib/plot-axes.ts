import type { Plot } from './signal-types';
import {
  validPlotRange,
  type PlotAxes,
  type PlotRange,
  type PlotValueAxis,
} from './plot-scratchpad';

export const MAX_CHART_AXES = 8;
export const plotAxisKey = (unit: string) => `unit:${unit.trim()}`;
export type PlotAxisGroup = {
  key: string;
  unit: string;
  label: string;
  color: string;
};

/** Exact unit strings share a scale; no implicit conversion between units. */
export function groupPlotAxes(
  items: { unit: string; name: string; color: string }[],
): PlotAxisGroup[] {
  const groups = new Map<
    string,
    { unit: string; names: Set<string>; color: string }
  >();
  for (const item of items) {
    const key = plotAxisKey(item.unit);
    const group = groups.get(key) ?? {
      unit: item.unit.trim(),
      names: new Set<string>(),
      color: item.color,
    };
    group.names.add(item.name.trim() || 'Value');
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => {
    const names = [...group.names];
    const name =
      names.slice(0, 2).join(' / ') +
      (names.length > 2 ? ` +${names.length - 2}` : '');
    return {
      key,
      unit: group.unit,
      color: group.color,
      label: `${name} (${group.unit || 'unitless'})`,
    };
  });
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
): PlotRange {
  if (validPlotRange(settings.y) && (!settings.log || settings.y[0] > 0))
    return settings.y;
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
