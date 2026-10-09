'use client';

import { useEffect, useState } from 'react';
import SignalChart from './signal-chart';
import { seriesColor, TRACE_COLORS } from '@/lib/plot-scratchpad';
import type { SignalGraph } from '@/lib/signal-graph';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
} from '@/lib/signal-types';

/** Segments overlaid at once; the rest are named in a note. */
const MAX_SEGMENTS = 100;
/** Signals shown, one chart each. */
const MAX_SIGNALS = 4;

export type AlignedWindow = {
  id: string;
  name: string;
  /** Recording (or workspace) time of the segment. */
  start: number;
  end: number;
};

/**
 * Each segment's part of a signal drawn from its own start (t = 0), so runs
 * compare directly. One chart per signal; one trace per segment.
 */
export default function AlignedSegmentsPlot({
  index,
  graph,
  request,
  signalIds,
  windows,
  onSegment,
}: {
  index: WorkflowIndex;
  graph: SignalGraph;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  signalIds: string[];
  windows: AlignedWindow[];
  onSegment: (id: string) => void;
}) {
  const shownWindows = windows.slice(0, MAX_SEGMENTS);
  const shownSignals = signalIds.slice(0, MAX_SIGNALS);
  const key = JSON.stringify([shownSignals, shownWindows]);
  const [plots, setPlots] = useState<{
    key: string;
    bySignal: Record<string, Plot[]>;
    error?: string;
  }>();
  useEffect(() => {
    const [ids, segments] = JSON.parse(key) as [string[], AlignedWindow[]];
    let alive = true;
    void (async () => {
      const bySignal: Record<string, Plot[]> = {};
      try {
        for (const id of ids) {
          const node = graph.nodes.get(id);
          const offset = node?.sourceId ? (graph.offsets.get(id) ?? 0) : 0;
          const response = await request({
            type: 'view',
            ids: [id],
            windows: segments.map(
              (segment) =>
                [segment.start + offset, segment.end + offset] as [
                  number,
                  number,
                ],
            ),
          });
          if (response.type !== 'plots')
            throw new Error('No plots were returned for these segments.');
          bySignal[id] = response.plots;
          if (alive) setPlots({ key, bySignal: { ...bySignal } });
        }
      } catch (caught) {
        if (alive)
          setPlots({
            key,
            bySignal,
            error:
              caught instanceof Error
                ? caught.message
                : 'The segments could not be plotted.',
          });
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, graph, request]);
  const current = plots?.key === key ? plots : undefined;
  const longest = Math.max(
    1e-9,
    ...shownWindows.map((segment) => segment.end - segment.start),
  );
  const color = (position: number) =>
    seriesColor(TRACE_COLORS[position % TRACE_COLORS.length]);
  return (
    <div className="aligned-segments">
      <ul className="aligned-segments-legend" aria-label="Segments">
        {shownWindows.slice(0, 24).map((segment, position) => (
          <li key={segment.id}>
            <button
              type="button"
              className="workflow-link"
              title={`Show ${segment.name} alone`}
              onClick={() => onSegment(segment.id)}
            >
              <i style={{ background: color(position) }} />
              {segment.name}
            </button>
          </li>
        ))}
        {shownWindows.length > 24 && (
          <li className="workflow-muted">
            and {shownWindows.length - 24} more
          </li>
        )}
      </ul>
      {current?.error && (
        <p className="workflow-error" role="alert">
          {current.error}
        </p>
      )}
      {shownSignals.map((id) => {
        const node = index.nodes.get(id);
        const signalPlots = current?.bySignal[id];
        const offset = node?.sourceId ? (graph.offsets.get(id) ?? 0) : 0;
        return (
          <section key={id} className="aligned-segments-chart">
            <h3>
              {index.label(id)}
              {node?.unit ? ` [${node.unit}]` : ''}
            </h3>
            {node && signalPlots ? (
              <SignalChart
                traces={signalPlots.map((plot, position) => ({
                  node: { ...node, id: `${id}:${shownWindows[position].id}` },
                  plot,
                  offset: shownWindows[position].start + offset,
                  color: color(position),
                  label: shownWindows[position].name,
                }))}
                segments={[]}
                range={[0, longest]}
                onSegment={() => {}}
                fluid
                height={signalIds.length > 1 ? 180 : 320}
                heading={false}
                includeZero={false}
              />
            ) : (
              <output className="workflow-muted">Loading segments…</output>
            )}
          </section>
        );
      })}
      <p className="input-hint">
        Time from each segment&apos;s start.
        {windows.length > shownWindows.length
          ? ` Showing the first ${MAX_SEGMENTS} of ${windows.length} segments.`
          : ''}
        {signalIds.length > shownSignals.length
          ? ` Showing ${MAX_SIGNALS} of ${signalIds.length} signals.`
          : ''}
      </p>
    </div>
  );
}
