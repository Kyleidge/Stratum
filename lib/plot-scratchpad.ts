/** Device-local plot layouts. Signal data and workflow history stay in the engine. */
export const PLOT_STORAGE_KEY = 'stratus.plot-scratchpad.v1';
export const MAX_PLOT_TABS = 12;
// Bounded persisted metadata; complete normal segment batches remain intact.
export const MAX_PLOT_TRACES = 10000;
export const TRACE_COLORS = [
  '#91e5ba',
  '#7ebcff',
  '#f2c479',
  '#c4a0ff',
  '#fb9bac',
  '#78d6df',
  '#ded785',
  '#b6c7db',
];
export type PlotTrace = { id: string; visible: boolean; color: string };
export type PlotSheet = {
  id: string;
  name: string;
  traces: PlotTrace[];
  layout: 'overlay' | 'stacked';
  grid: boolean;
  zeroTime?: boolean;
};

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
            },
          ];
        });
      return [
        {
          id: sheet.id,
          name: sheet.name.trim().slice(0, 80),
          traces,
          layout:
            sheet.layout === 'stacked'
              ? ('stacked' as const)
              : ('overlay' as const),
          grid: sheet.grid !== false,
          zeroTime: sheet.zeroTime === true,
        },
      ];
    });
  } catch {
    return [];
  }
}
