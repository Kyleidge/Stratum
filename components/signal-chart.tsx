'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Plot, Segment, SignalNode } from '@/lib/signal-types';

export function formatValue(value: number, digits = 1): string {
  return Number.isFinite(value)
    ? value.toLocaleString('en-GB', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : '—';
}

type Trace = {
  node: SignalNode;
  plot: Plot;
  offset?: number;
  color?: string;
  label?: string;
  referenceLine?: boolean;
};
export default function SignalChart({
  traces,
  segments,
  range,
  onSegment,
  compact = false,
  fluid = false,
  height = 151,
  heading = true,
  grid = true,
  includeZero = true,
}: {
  traces: Trace[];
  segments: Segment[];
  range: [number, number];
  onSegment: (id: string) => void;
  compact?: boolean;
  fluid?: boolean;
  height?: number;
  heading?: boolean;
  grid?: boolean;
  includeZero?: boolean;
}) {
  const clipId = useId();
  const [cursor, setCursor] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!fluid || !svg.current) return;
    const element = svg.current;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(200, element.clientWidth)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [fluid]);
  const chartWidth = fluid ? width : 900;
  const left = fluid ? 70 : 58;
  const right = chartWidth - 28;
  const span = right - left;
  const ticks = fluid ? Math.max(3, Math.min(10, Math.floor(span / 85))) : 10;
  const primary = traces[0];
  const finite = traces
    .flatMap((t) => [t.plot.summary.min, t.plot.summary.max])
    .filter(Number.isFinite);
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 1;
  const padding = (high - low || Math.abs(high) || 1) * 0.08;
  const min = includeZero ? Math.min(0, low - padding) : low - padding;
  const max = includeZero ? Math.max(0, high + padding) : high + padding;
  const bottom = height - 31;
  const plotHeight = bottom - 15;
  const x = (t: number) =>
    left + ((t - range[0]) / (range[1] - range[0] || 1)) * span;
  // Merge independent subpaths by style for large overlays. Every trace and
  // missing-data break remains present without one DOM element per signal.
  const geometry = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        d: string[];
        color: string;
        reference: boolean;
        dots: boolean;
      }
    >();
    for (const trace of traces) {
      const color = trace.color || trace.node.color;
      const dots = trace.node.operation === 'min-max';
      const reference = !!trace.referenceLine;
      const key = `${color}:${dots}:${reference}`;
      const group = groups.get(key) ?? { key, d: [], color, reference, dots };
      let drawing = false;
      const parts: string[] = [];
      for (const [time, value] of trace.plot.points) {
        if (!Number.isFinite(value)) {
          drawing = false;
          continue;
        }
        const px =
          left +
          ((time - (trace.offset ?? 0) - range[0]) /
            (range[1] - range[0] || 1)) *
            span;
        const py = bottom - ((value - min) / (max - min || 1)) * plotHeight;
        if (dots) {
          parts.push(
            `M${(px - 3.5).toFixed(2)},${py.toFixed(2)}a3.5,3.5 0 1,0 7,0a3.5,3.5 0 1,0 -7,0`,
          );
        } else {
          parts.push(`${drawing ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`);
          drawing = true;
        }
      }
      group.d.push(parts.join(' '));
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      d: group.d.join(' '),
    }));
  }, [traces, left, span, range, bottom, min, max, plotHeight]);
  const currentTime =
    cursor === null ? null : range[0] + cursor * (range[1] - range[0]);
  const nearest =
    primary && currentTime !== null
      ? primary.plot.points.reduce(
          (best, p) =>
            Math.abs(p[0] - (primary.offset || 0) - currentTime) <
            Math.abs(best[0] - (primary.offset || 0) - currentTime)
              ? p
              : best,
          primary.plot.points[0] || [0, NaN],
        )
      : null;
  return (
    <section className={`signal-chart ${compact ? 'compact-chart' : ''}`}>
      {heading && (
        <div className="chart-heading">
          <span>
            <i
              className="signal-dot"
              style={{ background: primary?.node.color }}
            />
            {primary?.label || primary?.node.name || 'Loading signal'}{' '}
            <small>{primary?.node.unit}</small>
          </span>
          <div>
            {traces.length > 1 ? (
              traces.map((t) => (
                <span className="trace-legend" key={t.node.id}>
                  <i style={{ background: t.color || t.node.color }} />
                  {t.label}
                </span>
              ))
            ) : (
              <>
                <small>
                  MIN <b>{formatValue(primary?.plot.summary.min ?? NaN)}</b>
                </small>
                <small>
                  MAX <b>{formatValue(primary?.plot.summary.max ?? NaN)}</b>
                </small>
              </>
            )}
          </div>
        </div>
      )}
      <svg
        ref={svg}
        viewBox={`0 0 ${chartWidth} ${height}`}
        style={height !== 151 ? { height } : undefined}
        preserveAspectRatio={fluid ? 'xMidYMid meet' : 'none'}
        aria-label={`${primary?.label || primary?.node.name || 'Signal'} over time`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setCursor(
            Math.max(
              0,
              Math.min(
                1,
                (((event.clientX - rect.left) / rect.width) * chartWidth -
                  left) /
                  span,
              ),
            ),
          );
        }}
        onPointerLeave={() => setCursor(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={left} y="8" width={span} height={bottom - 5} />
          </clipPath>
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            {grid && (
              <line
                x1={left}
                x2={right}
                y1={15 + (i * plotHeight) / 3}
                y2={15 + (i * plotHeight) / 3}
                className="chart-grid"
              />
            )}
            <text x={left - 12} y={19 + (i * plotHeight) / 3} textAnchor="end">
              {formatValue(max - (i / 3) * (max - min), max > 100 ? 0 : 1)}
            </text>
          </g>
        ))}
        {Array.from({ length: ticks }, (_, i) => (
          <g key={i}>
            {grid && (
              <line
                x1={left + (i * span) / (ticks - 1)}
                x2={left + (i * span) / (ticks - 1)}
                y1="9"
                y2={bottom + 3}
                className="chart-grid vertical"
              />
            )}
            <text
              x={left + (i * span) / (ticks - 1)}
              y={height - 9}
              textAnchor="middle"
            >
              {formatValue(
                range[0] + (i / (ticks - 1)) * (range[1] - range[0]),
                range[1] - range[0] > 100 ? 0 : 1,
              )}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {segments.map((s, i) => (
            <g
              key={s.id}
              className="chart-segment"
              onClick={() => onSegment(s.id)}
            >
              <rect
                x={x(s.start)}
                y="8"
                width={Math.max(0, x(s.end) - x(s.start))}
                height={bottom - 5}
                fill={['#62d7ae', '#a795ec', '#e2ae79'][i % 3]}
                opacity="0.055"
              />
              <line
                x1={x(s.start)}
                x2={x(s.start)}
                y1="8"
                y2={bottom + 3}
                stroke={['#62d7ae', '#a795ec', '#e2ae79'][i % 3]}
                strokeDasharray="3 4"
                opacity="0.4"
              />
            </g>
          ))}
          {geometry.map(({ key, d, color, reference, dots }) => (
            <path
              key={key}
              d={d}
              fill={dots ? color : 'none'}
              stroke={color}
              strokeWidth="1.45"
              strokeDasharray={reference ? '6 4' : undefined}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          ))}
        </g>
        {currentTime !== null && (
          <g>
            <line
              x1={x(currentTime)}
              x2={x(currentTime)}
              y1="8"
              y2={bottom + 3}
              stroke="#d6dfe2"
              opacity=".45"
              strokeDasharray="3 3"
            />
            <rect
              x={Math.min(right - 132, Math.max(left, x(currentTime) + 8))}
              y="10"
              width="128"
              height="24"
              rx="3"
              fill="#2b343b"
            />
            <text
              x={Math.min(right - 124, Math.max(left + 8, x(currentTime) + 16))}
              y="26"
              className="cursor-value"
            >
              {formatValue(currentTime)} s · {formatValue(nearest?.[1] ?? NaN)}
            </text>
          </g>
        )}
        <text x={chartWidth - 5} y={height - 9} textAnchor="end">
          s
        </text>
      </svg>
    </section>
  );
}
