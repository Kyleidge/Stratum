/** Device-local plot layouts. Signal data and workflow history stay in the engine. */
export const PLOT_STORAGE_KEY = 'stratus.plot-scratchpad.v1';
export const MAX_PLOT_TABS = 12;
// Bounded persisted metadata; complete normal segment batches remain intact.
export const MAX_PLOT_TRACES = 10000;
export const MAX_CUSTOM_AXES = 32;
/** Categorical series order, distinguishable with colour-vision deficiency. */
export const TRACE_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];
/** Short tags for a value's direct label at the end of its reference line. */
export const VALUE_TAGS: Record<string, string> = {
  'time-average': 'avg',
  'sample-average': 'mean',
  minimum: 'min',
  maximum: 'max',
};
export type PlotRange = [number, number];
export type PlotTrace = {
  id: string;
  visible: boolean;
  color: string;
  style?: 'line' | 'points' | 'step';
  width?: number;
  axisId?: string;
};
export type PlotAnnotation = {
  id: string;
  time: number;
  text: string;
  clockId?: string;
  /** Label height as a fraction of the available plot height, from the top. */
  labelPosition?: number;
};
export type PlotValueAxis = {
  y?: PlotRange;
  log?: boolean;
  label?: string;
  unit?: string;
};
export type PlotAxes = PlotValueAxis & {
  values?: Record<string, PlotValueAxis>;
  timeLabel?: string;
  /** Captured automatic scales, keyed by stable axis and stacked trace IDs. */
  heldY?: Record<string, PlotRange>;
};
export type PlotSheet = {
  id: string;
  name: string;
  traces: PlotTrace[];
  /**
   * Overlay draws traces on one time axis, splitting different units into
   * lanes; axes overlays every unit on independent Y axes; stacked gives each
   * trace its own panel.
   */
  layout: 'overlay' | 'stacked' | 'axes';
  grid: boolean;
  zeroTime?: boolean;
  window?: PlotRange;
  axes?: PlotAxes;
  annotations?: PlotAnnotation[];
  cursors?: PlotRange;
  measuring?: boolean;
};

export function validPlotRange(value: unknown): value is PlotRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    value[1] > value[0] &&
    Number.isFinite(value[1] - value[0])
  );
}

/** Fractions of the evaluated time extent, including one-sample recordings. */
export function plotWindow(value: PlotRange): PlotRange {
  const width = Math.max(0.000001, Math.min(1, value[1] - value[0]));
  const start = Math.max(0, Math.min(1 - width, value[0]));
  return [start, start + width];
}

/** Interactive axes may pan beyond the data; fit restores the full extent. */
export function plotViewport(value: PlotRange): PlotRange {
  if (!validPlotRange(value)) return [0, 1];
  const width = Math.max(0.000001, Math.min(1000, value[1] - value[0]));
  const next: PlotRange = [value[0], value[0] + width];
  return validPlotRange(next) ? next : [0, 1];
}

export function navigatePlot(
  value: PlotRange,
  factor: number,
  anchor = 0.5,
  shift = 0,
  bounded = true,
): PlotRange {
  const width = value[1] - value[0];
  const nextWidth = Math.max(
    0.000001,
    Math.min(bounded ? 1 : 1000, width * factor),
  );
  const start = value[0] + width * anchor - nextWidth * anchor + shift;
  return (bounded ? plotWindow : plotViewport)([start, start + nextWidth]);
}

export function plotExtent(range: PlotRange): PlotRange {
  return validPlotRange(range) ? range : [range[0], range[0] + 1];
}

export function readPlotSheets(raw: string | null): PlotSheet[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.slice(0, MAX_PLOT_TABS).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const sheet = item as Partial<PlotSheet>;
      if (
        typeof sheet.id !== 'string' ||
        !sheet.id.startsWith('plot:') ||
        ids.has(sheet.id) ||
        typeof sheet.name !== 'string' ||
        !sheet.name.trim() ||
        !Array.isArray(sheet.traces)
      )
        return [];
      ids.add(sheet.id);
      const traceIds = new Set<string>();
      const traces = sheet.traces
        .slice(0, MAX_PLOT_TRACES)
        .flatMap((trace: unknown) => {
          if (!trace || typeof trace !== 'object') return [];
          const t = trace as Partial<PlotTrace>;
          if (typeof t.id !== 'string' || !t.id || traceIds.has(t.id))
            return [];
          traceIds.add(t.id);
          return [
            {
              id: t.id,
              visible: t.visible !== false,
              color:
                typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color)
                  ? t.color
                  : TRACE_COLORS[(traceIds.size - 1) % TRACE_COLORS.length],
              ...(['line', 'points', 'step'].includes(t.style ?? '')
                ? { style: t.style }
                : {}),
              ...(typeof t.width === 'number' && Number.isFinite(t.width)
                ? { width: Math.min(4, Math.max(1, t.width)) }
                : {}),
              ...(typeof t.axisId === 'string' &&
              /^(unit:|axis:)/.test(t.axisId) &&
              t.axisId.length <= 256
                ? { axisId: t.axisId }
                : {}),
            },
          ];
        });
      let customAxes = 0;
      return [
        {
          id: sheet.id,
          name: sheet.name.trim().slice(0, 80),
          traces,
          layout:
            sheet.layout === 'stacked' || sheet.layout === 'axes'
              ? sheet.layout
              : ('overlay' as const),
          grid: sheet.grid !== false,
          zeroTime: sheet.zeroTime === true,
          measuring: sheet.measuring === true,
          ...(Array.isArray(sheet.cursors) &&
          sheet.cursors.length === 2 &&
          sheet.cursors.every(
            (n) => typeof n === 'number' && Number.isFinite(n),
          )
            ? { cursors: sheet.cursors }
            : {}),
          ...(validPlotRange(sheet.window)
            ? { window: plotViewport(sheet.window) }
            : {}),
          axes: {
            ...readValueAxis(sheet.axes),
            timeLabel: readAxisLabel(sheet.axes?.timeLabel),
            ...(sheet.axes?.heldY &&
            typeof sheet.axes.heldY === 'object' &&
            !Array.isArray(sheet.axes.heldY)
              ? {
                  heldY: Object.fromEntries(
                    Object.entries(sheet.axes.heldY)
                      .slice(0, MAX_PLOT_TRACES * 2 + MAX_CUSTOM_AXES)
                      .filter(
                        ([key, range]) =>
                          key.length <= 1024 &&
                          /^(unit:|axis:|trace:)/.test(key) &&
                          validPlotRange(range),
                      ),
                  ),
                }
              : {}),
            values: Object.fromEntries(
              sheet.axes?.values && typeof sheet.axes.values === 'object'
                ? Object.entries(sheet.axes.values)
                    .slice(0, MAX_PLOT_TRACES + MAX_CUSTOM_AXES)
                    .filter(
                      ([key, value]) =>
                        key.startsWith('unit:') ||
                        (key.startsWith('axis:') &&
                          key.length <= 256 &&
                          value &&
                          typeof value === 'object' &&
                          typeof value.unit === 'string' &&
                          ++customAxes <= MAX_CUSTOM_AXES),
                    )
                    .map(([key, axis]) => [key, readValueAxis(axis)])
                : [],
            ),
          },
          annotations: Array.isArray(sheet.annotations)
            ? sheet.annotations.slice(0, 50).flatMap((note) =>
                note &&
                typeof note.id === 'string' &&
                typeof note.time === 'number' &&
                Number.isFinite(note.time) &&
                typeof note.text === 'string' &&
                note.text.trim()
                  ? [
                      {
                        id: note.id.slice(0, 80),
                        time: note.time,
                        text: note.text.trim().slice(0, 160),
                        ...(typeof note.labelPosition === 'number' &&
                        Number.isFinite(note.labelPosition)
                          ? {
                              labelPosition: Math.max(
                                0,
                                Math.min(1, note.labelPosition),
                              ),
                            }
                          : {}),
                        ...(typeof note.clockId === 'string'
                          ? { clockId: note.clockId.slice(0, 256) }
                          : {}),
                      },
                    ]
                  : [],
              )
            : [],
        },
      ];
    });
  } catch {
    return [];
  }
}

function readAxisLabel(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.trim().slice(0, 160) || undefined
    : undefined;
}

function readValueAxis(value: unknown): PlotValueAxis {
  if (!value || typeof value !== 'object') return {};
  const axis = value as PlotValueAxis;
  return {
    log: axis.log === true,
    label: readAxisLabel(axis.label),
    ...(typeof axis.unit === 'string'
      ? { unit: axis.unit.trim().slice(0, 160) }
      : {}),
    ...(validPlotRange(axis.y) && (!axis.log || axis.y[0] > 0)
      ? { y: axis.y }
      : {}),
  };
}
