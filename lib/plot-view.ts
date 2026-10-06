import type { EngineRequest, EngineResponse, Plot } from './signal-types';
import type { PlotRange } from './plot-scratchpad';

export type PlotJob = { id: string; range: PlotRange };
export type PlotLayer = {
  key: string;
  plots: Map<string, Plot>;
  ranges: Map<string, PlotRange>;
};
export type PlotView = {
  overview?: PlotLayer;
  detail?: PlotLayer;
  buffer?: PlotLayer;
  error?: string;
};

export function coversPlotRange(outer: PlotRange, inner: PlotRange): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1];
}

/** Drawing only: exact summaries and measurements never use the preview. */
export function plotDrawing(
  id: string,
  range: PlotRange,
  view: PlotView,
): Plot | undefined {
  let partial: { plot: Plot; overlap: number } | undefined;
  for (const layer of [view.detail, view.buffer]) {
    const bounds = layer?.ranges.get(id);
    const plot = layer?.plots.get(id);
    if (!bounds || !plot) continue;
    if (coversPlotRange(bounds, range)) return plot;
    const overlap =
      Math.min(bounds[1], range[1]) - Math.max(bounds[0], range[0]);
    if (overlap > 0 && overlap > (partial?.overlap ?? 0))
      partial = { plot, overlap };
  }
  const overview = view.overview?.plots.get(id);
  if (!partial?.plot.points.length || !overview) return overview;
  // While a moved view loads, keep the finer drawing where it reaches and use
  // overview candidates only beyond it, rather than coarsening the whole view.
  const fine = partial.plot.points;
  const first = fine[0][0],
    last = fine[fine.length - 1][0];
  return {
    ...partial.plot,
    points: [
      ...overview.points.filter(([time]) => time < first),
      ...fine,
      ...overview.points.filter(([time]) => time > last),
    ],
  };
}

/** One bounded overview, one exact view and one two-screen drawing buffer.
 * A slow read is allowed to finish; only the newest target runs after it.
 */
export function createPlotLoader(
  sources: PlotJob[],
  request: (message: EngineRequest) => Promise<EngineResponse>,
  publish: (view: PlotView) => void,
) {
  let view: PlotView = {};
  let target: { jobs: PlotJob[]; key: string; preview: boolean };
  let disposed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStart = -Infinity;
  let failed: string | undefined;
  const sourceKey = JSON.stringify(sources);
  function needed() {
    if (!target || !sources.length || failed === target.key) return false;
    if (!view.overview) return true;
    if (!target.preview) return view.detail?.key !== target.key;
    return !target.jobs.every(({ id, range }) =>
      [view.detail, view.buffer].some((layer) => {
        const bounds = layer?.ranges.get(id);
        return bounds && coversPlotRange(bounds, range);
      }),
    );
  }
  function schedule() {
    if (disposed || running || timer !== undefined || !needed()) return;
    // Throttle, rather than debounce: continuous movement still receives data.
    timer = setTimeout(
      () => {
        timer = undefined;
        if (needed()) void read();
      },
      Math.max(0, 100 - (Date.now() - lastStart)),
    );
  }
  async function read() {
    const selected = target;
    const kind = !view.overview
      ? 'overview'
      : selected.preview
        ? 'buffer'
        : 'detail';
    const jobs =
      kind === 'overview'
        ? sources
        : selected.jobs.map(({ id, range }): PlotJob => {
            const pad = kind === 'buffer' ? (range[1] - range[0]) / 2 : 0;
            return { id, range: [range[0] - pad, range[1] + pad] };
          });
    running = true;
    lastStart = Date.now();
    try {
      const response = await request({
        type: 'view',
        ids: jobs.map(({ id }) => id),
        ranges: Object.fromEntries(jobs.map(({ id, range }) => [id, range])),
        inspection: true,
      });
      if (disposed) return;
      if (response.type !== 'plots')
        throw new Error('Unable to load this plot.');
      const layer: PlotLayer = {
        key: JSON.stringify(jobs),
        plots: new Map(response.plots.map((plot) => [plot.id, plot])),
        ranges: new Map(jobs.map(({ id, range }) => [id, range])),
      };
      view = { ...view, [kind]: layer, error: undefined };
      if (kind === 'overview' && target.key === sourceKey) view.detail = layer;
      publish(view);
    } catch (error) {
      if (disposed) return;
      // Ignore obsolete failures, but do not repeatedly retry a failing target.
      if (kind === 'overview' || selected.key === target.key) {
        failed = target.key;
        view = {
          ...view,
          error:
            error instanceof Error
              ? error.message
              : 'Unable to load this plot.',
        };
        publish(view);
      }
    } finally {
      running = false;
      schedule();
    }
  }
  return {
    update(jobs: PlotJob[], preview = false) {
      const key = JSON.stringify(jobs);
      if (target?.key !== key) failed = undefined;
      target = { jobs, key, preview };
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
