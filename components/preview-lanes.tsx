'use client';

import { useState, type PointerEvent } from 'react';
import type { Plot, SignalNode } from '@/lib/signal-types';
import SignalChart, { formatValue, type ChartGeometry } from './signal-chart';

export type PreviewTrace = {
  node: SignalNode;
  plot: Plot;
  label: string;
  color: string;
  width?: number;
  referenceLine?: boolean;
  referenceLabel?: string;
  referenceTime?: number;
};
type Range = [number, number];

/**
 * Dialog preview plot. Traces sharing a unit overlay in one lane; other units
 * get their own lane on the same time axis. Drag to zoom, double-click to fit.
 */
export default function PreviewLanes({
  traces,
  range,
  height = 290,
  onZoom,
}: {
  traces: PreviewTrace[];
  range: Range;
  height?: number;
  onZoom?: (range?: Range) => void;
}) {
  const lanes: { unit: string; traces: PreviewTrace[] }[] = [];
  for (const trace of traces) {
    const lane = lanes.find((item) => item.unit === trace.node.unit);
    if (lane) lane.traces.push(trace);
    else lanes.push({ unit: trace.node.unit, traces: [trace] });
  }
  const laneHeight = Math.max(110, Math.round(height / (lanes.length || 1)));
  return (
    <div className="preview-lanes">
      <ul className="preview-legend" aria-label="Preview traces">
        {traces.map((trace) => (
          <li key={trace.node.id}>
            <i
              style={{ background: trace.color }}
              data-reference={trace.referenceLine || undefined}
            />
            {trace.label}
            {trace.node.unit && <small>{trace.node.unit}</small>}
          </li>
        ))}
      </ul>
      {lanes.map((lane, index) => (
        <div className="preview-lane" key={lane.unit || `lane-${index}`}>
          <span className="preview-lane-unit">{lane.unit || 'no unit'}</span>
          <SignalChart
            traces={lane.traces.map((trace) => ({
              node: trace.node,
              plot: trace.plot,
              color: trace.color,
              label: trace.label,
              width: trace.width,
              referenceLine: trace.referenceLine,
              referenceLabel: trace.referenceLabel,
              referenceTime: trace.referenceTime,
            }))}
            segments={[]}
            range={range}
            onSegment={() => {}}
            fluid
            heading={false}
            includeZero={false}
            timeAxis={index === lanes.length - 1}
            height={laneHeight}
            overlay={
              onZoom
                ? (geometry) => (
                    <ZoomSurface
                      geometry={geometry}
                      range={range}
                      onZoom={onZoom}
                    />
                  )
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

function ZoomSurface({
  geometry,
  range,
  onZoom,
}: {
  geometry: ChartGeometry;
  range: Range;
  onZoom: (range?: Range) => void;
}) {
  const [drag, setDrag] = useState<{
    pointerId: number;
    a: number;
    b: number;
  }>();
  const [hover, setHover] = useState<number>();
  const { left, right, top, bottom, x } = geometry;
  function time(event: PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const position =
      (((event.clientX - rect.left) * geometry.width) / rect.width - left) /
      (right - left);
    return (
      range[0] + Math.max(0, Math.min(1, position)) * (range[1] - range[0])
    );
  }
  return (
    <g className="preview-zoom-surface">
      <title>Drag to zoom; double-click to fit</title>
      {drag && (
        <rect
          className="preview-zoom-band"
          x={Math.min(x(drag.a), x(drag.b))}
          y={top}
          width={Math.abs(x(drag.b) - x(drag.a))}
          height={bottom - top}
          pointerEvents="none"
        />
      )}
      {hover !== undefined && !drag && (
        <g pointerEvents="none" className="preview-hover">
          <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} />
          <text
            x={Math.min(right - 4, x(hover) + 5)}
            y={top + 11}
            textAnchor={x(hover) + 80 > right ? 'end' : 'start'}
          >
            {formatValue(hover, range[1] - range[0] < 10 ? 3 : 1)} s
          </text>
        </g>
      )}
      <rect
        x={left}
        y={top}
        width={Math.max(0, right - left)}
        height={Math.max(0, bottom - top)}
        fill="transparent"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          if (event.isTrusted)
            event.currentTarget.setPointerCapture(event.pointerId);
          const at = time(event);
          setDrag({ pointerId: event.pointerId, a: at, b: at });
        }}
        onPointerMove={(event) => {
          const at = time(event);
          setHover(at);
          if (drag?.pointerId === event.pointerId) setDrag({ ...drag, b: at });
        }}
        onPointerLeave={() => setHover(undefined)}
        onPointerUp={(event) => {
          if (drag?.pointerId !== event.pointerId) return;
          const a = Math.min(drag.a, time(event)),
            b = Math.max(drag.a, time(event));
          setDrag(undefined);
          // Ignore clicks; a deliberate drag spans at least 1 % of the view.
          if (b - a > (range[1] - range[0]) * 0.01) onZoom([a, b]);
        }}
        onPointerCancel={() => setDrag(undefined)}
        onLostPointerCapture={() => setDrag(undefined)}
        onDoubleClick={() => onZoom(undefined)}
      />
    </g>
  );
}
