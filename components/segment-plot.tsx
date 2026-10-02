'use client';

import { useEffect, useState, type PointerEvent } from 'react';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  SegmentBoundary,
} from '@/lib/signal-types';
import type { SignalGraph } from '@/lib/signal-graph';
import {
  dragTimeRange,
  segmentPlotDomain,
  type RangeDrag,
  type TimeRange,
} from '@/lib/time-range-selection';
import SignalChart, { formatValue, type ChartGeometry } from './signal-chart';
import { RegionSelect } from './region-controls';

type Request = (message: EngineRequest) => Promise<EngineResponse>;
export type PlotThreshold = {
  boundary: 'start' | 'end';
  signalId: string;
  /** NaN while the typed threshold is not a number. */
  value: number;
  edge: 'rising' | 'falling';
  onChange: (value: number) => void;
};
export type PlotSpan = {
  range: TimeRange;
  onChange: (range: TimeRange) => void;
};

/** A 1/2/5 × 10ⁿ step near `span / 200`, so dragged values stay readable. */
function snapStep(span: number) {
  const raw = Math.abs(span) / 200 || 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
  );
}
const snap = (value: number, step: number) =>
  Number((Math.round(value / step) * step).toPrecision(12));

/**
 * Segmentation plot: one signal in the segmentation clock, with the planned
 * segments, trigger crossings, draggable thresholds and a draggable span.
 */
export default function SegmentPlot({
  graph,
  request,
  label,
  ids,
  busy,
  ranges = [],
  thresholds = [],
  span,
  help,
}: {
  graph: SignalGraph;
  request: Request;
  label: (id: string) => string;
  /** Signals offered for display; the first is shown initially. */
  ids: string[];
  busy: boolean;
  /** Planned segments in the segmentation clock. */
  ranges?: SegmentBoundary[];
  thresholds?: PlotThreshold[];
  span?: PlotSpan;
  help: string;
}) {
  const [chosen, setChosen] = useState(ids[0]);
  const id = ids.includes(chosen) ? chosen : ids[0];
  const node = graph.nodes.get(id);
  const domain = node ? segmentPlotDomain(graph, id) : undefined;
  const [result, setResult] = useState<{
    key: string;
    plot?: Plot;
    error?: string;
  }>();
  const requestKey = domain
    ? JSON.stringify([id, domain.range, domain.offset])
    : '';
  useEffect(() => {
    if (!requestKey) return;
    let alive = true;
    const [signal, range, offset] = JSON.parse(requestKey) as [
      string,
      TimeRange,
      number,
    ];
    void request({
      type: 'view',
      ids: [signal],
      range: [range[0] + offset, range[1] + offset],
    })
      .then((response) => {
        if (!alive) return;
        if (response.type !== 'plots' || !response.plots[0])
          throw new Error('No plot was returned for this signal.');
        setResult({ key: requestKey, plot: response.plots[0] });
      })
      .catch((error: unknown) => {
        if (alive)
          setResult({
            key: requestKey,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load the signal.',
          });
      });
    return () => {
      alive = false;
    };
  }, [requestKey, request]);
  const current = result?.key === requestKey ? result : undefined;
  const shownThresholds = thresholds.filter((item) => item.signalId === id);
  // Independent members each have their own crossings; show the plotted one's.
  const members = ranges.some((range) => range.inputId);
  const shownRanges = members
    ? ranges.filter(
        (range) =>
          range.inputId ===
          (ranges.some((item) => item.inputId === id) ? id : ranges[0].inputId),
      )
    : ranges;
  return (
    <div className="segment-plot">
      <div className="segment-plot-heading">
        {ids.length > 1 ? (
          <RegionSelect
            label="Plot signal"
            value={id}
            items={ids.flatMap((item) => {
              const signal = graph.nodes.get(item);
              return signal
                ? [
                    {
                      value: item,
                      label: `${label(item)}${signal.unit ? ` [${signal.unit}]` : ''}`,
                    },
                  ]
                : [];
            })}
            onChange={setChosen}
            disabled={busy}
          />
        ) : (
          <span className="segment-plot-signal">
            {label(id)}
            {node?.unit && <small> [{node.unit}]</small>}
          </span>
        )}
        <span className="segment-plot-key" aria-hidden="true">
          <i data-key="segment" /> Segment
          {shownThresholds.map((item) => (
            <span key={item.boundary}>
              <i data-key={item.boundary} />
              {item.boundary === 'start' ? 'Start' : 'End'}
            </span>
          ))}
        </span>
      </div>
      <div className="segment-plot-canvas" aria-busy={!current}>
        {node && domain && current?.plot ? (
          <SignalChart
            traces={[{ node, plot: current.plot, offset: domain.offset }]}
            segments={[]}
            range={domain.range}
            onSegment={() => {}}
            fluid
            height={220}
            heading={false}
            includeZero={false}
            extent={shownThresholds.map((item) => item.value)}
            overlay={(geometry) => (
              <SegmentOverlay
                key={`${requestKey}:${busy}`}
                geometry={geometry}
                domain={domain.range}
                ranges={shownRanges}
                thresholds={shownThresholds}
                span={span}
                unit={node.unit}
                busy={busy}
              />
            )}
          />
        ) : (
          <output className="range-plot-loading">
            {current?.error ?? 'Loading signal plot…'}
          </output>
        )}
      </div>
      <p className="input-hint segment-plot-help">{help}</p>
    </div>
  );
}

type Gesture =
  | {
      pointerId: number;
      kind: 'threshold';
      boundary: 'start' | 'end';
      value: number;
    }
  | {
      pointerId: number;
      kind: 'span';
      mode: RangeDrag;
      anchor: number;
      origin: TimeRange;
      range: TimeRange;
    };

function SegmentOverlay({
  geometry,
  domain,
  ranges,
  thresholds,
  span,
  unit,
  busy,
}: {
  geometry: ChartGeometry;
  domain: TimeRange;
  ranges: SegmentBoundary[];
  thresholds: PlotThreshold[];
  span?: PlotSpan;
  unit: string;
  busy: boolean;
}) {
  const [gesture, setGesture] = useState<Gesture>();
  const { left, right, top, bottom, x, y, valueAt } = geometry;
  const step = snapStep(valueAt(top) - valueAt(bottom));
  function point(event: PointerEvent<SVGGElement>) {
    const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((event.clientX - rect.left) * geometry.width) / rect.width;
    const py = ((event.clientY - rect.top) * geometry.height) / rect.height;
    const duration = domain[1] - domain[0];
    const digits = Math.max(
      3,
      Math.min(12, Math.ceil(-Math.log10(duration / 10000))),
    );
    return {
      time: Number(
        (domain[0] + ((px - left) / (right - left)) * duration).toFixed(digits),
      ),
      value: snap(valueAt(Math.max(top, Math.min(bottom, py))), step),
    };
  }
  const shownSpan =
    gesture?.kind === 'span' ? gesture.range : (span?.range ?? undefined);
  const clampX = (time: number) => Math.max(left, Math.min(right, x(time)));
  return (
    <g
      className="segment-plot-surface"
      aria-disabled={busy}
      onPointerDown={(event) => {
        if (busy || event.button !== 0 || gesture) return;
        const target = event.target as Element;
        const threshold = target
          .closest('[data-threshold]')
          ?.getAttribute('data-threshold');
        const edge = target.getAttribute('data-span-edge') as RangeDrag | null;
        const body = target.closest('[data-span-body]');
        if (!threshold && !edge && !body) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.isTrusted)
          event.currentTarget.setPointerCapture(event.pointerId);
        const at = point(event);
        if (threshold === 'start' || threshold === 'end')
          setGesture({
            pointerId: event.pointerId,
            kind: 'threshold',
            boundary: threshold,
            value: at.value,
          });
        else if (span)
          setGesture({
            pointerId: event.pointerId,
            kind: 'span',
            mode: edge ?? 'move',
            anchor: at.time,
            origin: span.range,
            range: span.range,
          });
      }}
      onPointerMove={(event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const at = point(event);
        setGesture(
          gesture.kind === 'threshold'
            ? { ...gesture, value: at.value }
            : {
                ...gesture,
                range: dragTimeRange(
                  gesture.origin,
                  gesture.mode,
                  gesture.anchor,
                  at.time,
                  domain,
                ),
              },
        );
      }}
      onPointerUp={(event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const at = point(event);
        if (gesture.kind === 'threshold')
          thresholds
            .find((item) => item.boundary === gesture.boundary)
            ?.onChange(at.value);
        else {
          const range = dragTimeRange(
            gesture.origin,
            gesture.mode,
            gesture.anchor,
            at.time,
            domain,
          );
          if (range[1] > range[0]) span?.onChange(range);
        }
        setGesture(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => setGesture(undefined)}
      onLostPointerCapture={() => setGesture(undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && gesture) {
          event.preventDefault();
          event.stopPropagation();
          setGesture(undefined);
        }
      }}
    >
      {shownSpan && (
        <g data-span-body className="segment-span">
          <title>
            Windowed range {formatValue(shownSpan[0], 3)} to{' '}
            {formatValue(shownSpan[1], 3)} s. Drag to move; drag an edge to
            resize.
          </title>
          <rect
            className="segment-span-fill"
            x={clampX(shownSpan[0])}
            y={top}
            width={Math.max(0, clampX(shownSpan[1]) - clampX(shownSpan[0]))}
            height={bottom - top}
          />
        </g>
      )}
      {ranges.map((range, index) => {
        const start = clampX(range.start),
          end = clampX(range.end);
        return (
          <g
            key={index}
            className="segment-band"
            data-clipped={range.clipped || undefined}
            pointerEvents="none"
          >
            <rect
              x={start}
              y={top}
              width={Math.max(1, end - start)}
              height={bottom - top}
              data-odd={index % 2 || undefined}
            />
            {end - start > 16 && (
              <text x={start + 4} y={top + 12}>
                {index + 1}
              </text>
            )}
            {range.startTrigger !== undefined &&
              x(range.startTrigger) >= left &&
              x(range.startTrigger) <= right && (
                <path
                  className="segment-crossing"
                  data-boundary="start"
                  d={`M${x(range.startTrigger) - 4},${bottom} l4,-7 l4,7 z`}
                />
              )}
            {range.endTrigger !== undefined &&
              x(range.endTrigger) >= left &&
              x(range.endTrigger) <= right && (
                <path
                  className="segment-crossing"
                  data-boundary="end"
                  d={`M${x(range.endTrigger) - 4},${bottom} l4,-7 l4,7 z`}
                />
              )}
          </g>
        );
      })}
      {shownSpan &&
        ([0, 1] as const).map((side) => {
          const position = x(shownSpan[side]);
          return position >= left && position <= right ? (
            <g key={side} className="segment-span-edge">
              <line x1={position} x2={position} y1={top} y2={bottom} />
              <rect
                data-span-edge={side ? 'end' : 'start'}
                x={Math.max(left, Math.min(right - 10, position - 5))}
                y={top}
                width={10}
                height={bottom - top}
                fill="transparent"
              />
              <rect
                className="range-grip"
                x={position - 3}
                y={top + (bottom - top) / 2 - 12}
                width={6}
                height={24}
                rx={2}
                pointerEvents="none"
              />
            </g>
          ) : null;
        })}
      {thresholds.map((item) => {
        const value =
          gesture?.kind === 'threshold' && gesture.boundary === item.boundary
            ? gesture.value
            : item.value;
        if (!Number.isFinite(value)) return null;
        const py = Math.max(top, Math.min(bottom, y(value)));
        const text = `${item.boundary === 'start' ? 'Start' : 'End'} ${item.edge === 'rising' ? '↗' : '↘'} ${formatValue(value, Math.max(0, Math.min(6, -Math.floor(Math.log10(step)))))}${unit ? ` ${unit}` : ''}`;
        return (
          <g
            key={item.boundary}
            className="segment-threshold"
            data-threshold={item.boundary}
            data-dragging={
              gesture?.kind === 'threshold' &&
              gesture.boundary === item.boundary
                ? true
                : undefined
            }
          >
            <line x1={left} x2={right} y1={py} y2={py} />
            <rect
              x={left}
              y={py - 6}
              width={Math.max(0, right - left)}
              height={12}
              fill="transparent"
            >
              <title>Drag to change the {item.boundary} threshold</title>
            </rect>
            <text
              x={right - 4}
              y={
                // End labels sit below their line unless that leaves the plot.
                item.boundary === 'end'
                  ? py + 13 <= bottom - 2
                    ? py + 13
                    : py - 5
                  : py + 13 > bottom - 2 && py - 18 >= top + 10
                    ? py - 18
                    : py - 5
              }
              textAnchor="end"
            >
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
