'use client';

import { useEffect, useState } from 'react';
import SignalChart from './signal-chart';
import { seriesColor, TRACE_COLORS } from '@/lib/plot-scratchpad';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { EngineRequest, EngineResponse, Plot } from '@/lib/signal-types';

/** Traces overlaid per chart; the rest are named in a note. */
export const MAX_ALIGNED = 100;
/** Charts shown, one per signal. */
const MAX_GROUPS = 4;

/** One segment's trace: a window of a signal, or a signal within it. */
export type AlignedTrace = {
  /** The segment, which also keys the trace's colour. */
  segmentId: string;
  signalId: string;
  /** Display-time window of `signalId` to draw; all of it when absent. */
  window?: [number, number];
  /** Display time drawn as t = 0. */
  start: number;
};
/** One chart: a signal's traces in every segment. */
export type AlignedGroup = { id: string; traces: AlignedTrace[] };

/**
 * Each segment's part of a signal drawn from its own start (t = 0), so runs
 * compare directly. One chart per signal; one trace per segment.
 */
export default function AlignedSegmentsPlot({
  index,
  request,
  groups,
  segments,
  onSegment,
}: {
  index: WorkflowIndex;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  groups: AlignedGroup[];
  /** The segments drawn, in order, for the legend and colours. */
  segments: { id: string; name: string }[];
  onSegment: (id: string) => void;
}) {
  const shown = groups.slice(0, MAX_GROUPS).map((group) => ({
    ...group,
    traces: group.traces.slice(0, MAX_ALIGNED),
  }));
  const key = JSON.stringify(shown);
  const [plots, setPlots] = useState<{
    key: string;
    byGroup: Record<string, Plot[]>;
    error?: string;
  }>();
  useEffect(() => {
    const groups = JSON.parse(key) as AlignedGroup[];
    let alive = true;
    void (async () => {
      const byGroup: Record<string, Plot[]> = {};
      try {
        for (const group of groups) {
          // Windows of one signal in one request, or several whole signals.
          const windows = group.traces.every(
            (trace) =>
              trace.window && trace.signalId === group.traces[0].signalId,
          );
          const response = await request(
            windows
              ? {
                  type: 'view',
                  ids: [group.traces[0].signalId],
                  windows: group.traces.map((trace) => trace.window!),
                }
              : {
                  type: 'view',
                  ids: group.traces.map((trace) => trace.signalId),
                },
          );
          if (response.type !== 'plots')
            throw new Error('No plots were returned for these segments.');
          byGroup[group.id] = response.plots;
          if (alive) setPlots({ key, byGroup: { ...byGroup } });
        }
      } catch (caught) {
        if (alive)
          setPlots({
            key,
            byGroup,
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
  }, [key, request]);
  const current = plots?.key === key ? plots : undefined;
  const position = new Map(segments.map((segment, k) => [segment.id, k]));
  const color = (segmentId: string) =>
    seriesColor(
      TRACE_COLORS[(position.get(segmentId) ?? 0) % TRACE_COLORS.length],
    );
  const longest = Math.max(
    1e-9,
    ...shown.flatMap((group) =>
      group.traces.map((trace, k) => {
        const plot = current?.byGroup[group.id]?.[k];
        const end = trace.window?.[1] ?? plot?.summary.end ?? trace.start;
        return end - trace.start;
      }),
    ),
  );
  const total = Math.max(0, ...groups.map((group) => group.traces.length));
  return (
    <div className="aligned-segments">
      <ul className="aligned-segments-legend" aria-label="Segments">
        {segments.slice(0, 24).map((segment) => (
          <li key={segment.id}>
            <button
              type="button"
              className="workflow-link"
              title={`Show ${segment.name} alone`}
              onClick={() => onSegment(segment.id)}
            >
              <i style={{ background: color(segment.id) }} />
              {segment.name}
            </button>
          </li>
        ))}
        {segments.length > 24 && (
          <li className="workflow-muted">and {segments.length - 24} more</li>
        )}
      </ul>
      {current?.error && (
        <p className="workflow-error" role="alert">
          {current.error}
        </p>
      )}
      {shown.map((group) => {
        const node = index.nodes.get(group.traces[0]?.signalId ?? group.id);
        const groupPlots = current?.byGroup[group.id];
        return (
          <section key={group.id} className="aligned-segments-chart">
            <h3>
              {index.label(group.id)}
              {node?.unit ? ` [${node.unit}]` : ''}
            </h3>
            {node && groupPlots ? (
              <SignalChart
                traces={groupPlots.map((plot, k) => {
                  const trace = group.traces[k];
                  const traceNode = index.nodes.get(trace.signalId) ?? node;
                  return {
                    node: { ...traceNode, id: `${group.id}:${k}` },
                    plot,
                    offset: trace.start,
                    color: color(trace.segmentId),
                    label: index.segmentLabel(trace.segmentId),
                  };
                })}
                segments={[]}
                range={[0, longest]}
                onSegment={() => {}}
                fluid
                height={shown.length > 1 ? 180 : 320}
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
        {total > MAX_ALIGNED
          ? ` Showing the first ${MAX_ALIGNED} of ${total} segments.`
          : ''}
        {groups.length > shown.length
          ? ` Showing ${MAX_GROUPS} of ${groups.length} signals.`
          : ''}
      </p>
    </div>
  );
}
