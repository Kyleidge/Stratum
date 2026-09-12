'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Plot, Segment, SignalNode } from '@/lib/signal-types';
import type {
  PlotAnnotation,
  PlotAxes,
  PlotRange,
  PlotTrace,
} from '@/lib/plot-scratchpad';
import {
  groupPlotAxes,
  plotAxisKey,
  valueAxisRange,
  valueAxisSettings,
  zoomValueAxis,
} from '@/lib/plot-axes';

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
  style?: PlotTrace['style'];
  width?: number;
};
export type ChartInteraction = {
  mode: 'pan' | 'zoom' | 'cursor';
  axes?: PlotAxes;
  primaryAxisKey?: string;
  timeLabel?: string;
  cursors?: PlotRange;
  annotations?: PlotAnnotation[];
  onRange: (range: PlotRange) => void;
  onCursors: (range: PlotRange) => void;
  onFit: () => void;
  onBack: () => void;
  onAxes: (key?: string) => void;
  onValueRange: (key: string, range: PlotRange) => void;
  onAnnotation: (time: number, id?: string) => void;
};
export default function SignalChart({
  traces,
  segments,
  range: inputRange,
  onSegment,
  compact = false,
  fluid = false,
  height = 151,
  heading = true,
  grid = true,
  includeZero = true,
  fillHeight = false,
  interaction,
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
  /** Match a CSS-sized viewport without stretching labels or pointer geometry. */
  fillHeight?: boolean;
  interaction?: ChartInteraction;
}) {
  const clipId = useId();
  const [cursor, setCursor] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [measuredHeight, setMeasuredHeight] = useState(height);
  const [gesture, setGesture] = useState<{
    start: number;
    end: number;
    range: PlotRange;
    mode: 'pan' | 'zoom' | 'a' | 'b';
  }>();
  const range = useMemo<PlotRange>(
    () =>
      gesture?.mode === 'pan'
        ? [
            gesture.range[0] + gesture.start - gesture.end,
            gesture.range[1] + gesture.start - gesture.end,
          ]
        : inputRange,
    [gesture, inputRange],
  );
  useEffect(() => {
    if ((!fluid && !fillHeight) || !svg.current) return;
    const element = svg.current;
    const observer = new ResizeObserver(() => {
      setWidth(Math.max(200, element.clientWidth));
      if (fillHeight) setMeasuredHeight(Math.max(120, element.clientHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fluid, fillHeight]);
  const chartHeight = fillHeight ? measuredHeight : height;
  const axisGroups = useMemo(
    () =>
      groupPlotAxes(
        traces.map((trace) => ({
          unit: trace.node.unit,
          name: trace.label || trace.node.name,
          color: trace.color || trace.node.color,
        })),
      ),
    [traces],
  );
  const axisCount = interaction ? Math.max(1, axisGroups.length) : 1;
  const minimumWidth = 300 + axisCount * 88;
  const chartWidth = Math.max(
    fluid ? width : 900,
    interaction ? minimumWidth : 0,
  );
  const left = interaction ? 92 : fluid ? 70 : 58;
  const right =
    chartWidth - (interaction && axisCount > 1 ? (axisCount - 1) * 88 : 28);
  const span = right - left;
  const ticks = fluid ? Math.max(3, Math.min(10, Math.floor(span / 85))) : 10;
  const primary = traces[0];
  const scales = useMemo(() => {
    const groups = interaction
      ? axisGroups
      : [{ key: '', label: '', color: '', unit: '' }];
    return groups.map((group) => {
      const settings = valueAxisSettings(
        interaction?.axes,
        group.key,
        interaction?.primaryAxisKey ?? axisGroups[0]?.key,
      );
      const plots = traces
        .filter(
          (trace) => !interaction || plotAxisKey(trace.node.unit) === group.key,
        )
        .map((trace) => trace.plot);
      const range = valueAxisRange(plots, settings, includeZero);
      return {
        ...group,
        label: settings.label || group.label,
        range,
        log: !!settings.log,
        min: settings.log ? Math.log10(range[0]) : range[0],
        max: settings.log ? Math.log10(range[1]) : range[1],
      };
    });
  }, [axisGroups, traces, interaction, includeZero]);
  const bottom = chartHeight - (interaction ? 51 : 31);
  const plotHeight = bottom - 15;
  const valueTicks = fluid
    ? Math.max(4, Math.min(8, Math.floor(plotHeight / 85)))
    : 4;
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
        width: number;
      }
    >();
    for (const trace of traces) {
      const scale = scales.find(
        (axis) => !interaction || axis.key === plotAxisKey(trace.node.unit),
      )!;
      const { min, max, log: logarithmic } = scale;
      const color = trace.color || trace.node.color;
      const dots =
        trace.style === 'points' ||
        trace.node.operation === 'min-max' ||
        trace.plot.points.length === 1;
      const reference = !!trace.referenceLine;
      const strokeWidth = trace.width ?? 1.45;
      const key = `${scale.key}:${color}:${dots}:${reference}:${trace.style ?? 'line'}:${strokeWidth}`;
      const group = groups.get(key) ?? {
        key,
        d: [],
        color,
        reference,
        dots,
        width: strokeWidth,
      };
      let drawing = false;
      const parts: string[] = [];
      for (const [time, value] of trace.plot.points) {
        if (!Number.isFinite(value) || (logarithmic && value <= 0)) {
          drawing = false;
          continue;
        }
        const px =
          left +
          ((time - (trace.offset ?? 0) - range[0]) /
            (range[1] - range[0] || 1)) *
            span;
        const py =
          bottom -
          (((logarithmic ? Math.log10(value) : value) - min) /
            (max - min || 1)) *
            plotHeight;
        if (dots) {
          parts.push(
            `M${(px - 3.5).toFixed(2)},${py.toFixed(2)}a3.5,3.5 0 1,0 7,0a3.5,3.5 0 1,0 -7,0`,
          );
        } else {
          parts.push(
            drawing && trace.style === 'step'
              ? `H${px.toFixed(2)}V${py.toFixed(2)}`
              : `${drawing ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`,
          );
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
  }, [traces, left, span, range, bottom, scales, plotHeight, interaction]);
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
  const eventTime = (clientX: number) => {
    const rect = svg.current!.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (((clientX - rect.left) * chartWidth) / rect.width - left) / span,
      ),
    );
    return inputRange[0] + fraction * (inputRange[1] - inputRange[0]);
  };
  const hitAxis = (clientX: number, clientY: number) => {
    const rect = svg.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) * chartWidth) / rect.width;
    const py = ((clientY - rect.top) * chartHeight) / rect.height;
    const axis =
      px < left
        ? scales[0]
        : px > right && axisCount > 1
          ? scales[
              Math.min(scales.length - 1, 1 + Math.floor((px - right) / 88))
            ]
          : undefined;
    return {
      axis,
      time: !axis && py > bottom,
      fraction: Math.max(0, Math.min(1, (bottom - py) / plotHeight)),
    };
  };
  useEffect(() => {
    const element = svg.current;
    if (!interaction || !element) return;
    const wheel = (event: WheelEvent) => {
      const hit = hitAxis(event.clientX, event.clientY);
      if (document.activeElement !== element && !hit.axis && !hit.time) return;
      event.preventDefault();
      element.focus({ preventScroll: true });
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chartHeight : 1);
      const factor = Math.exp(Math.max(-1, Math.min(1, delta * 0.002)));
      if (hit.axis) {
        interaction.onValueRange(
          hit.axis.key,
          zoomValueAxis(hit.axis.range, factor, hit.fraction, hit.axis.log),
        );
        return;
      }
      const anchor = eventTime(event.clientX);
      interaction.onRange([
        anchor + (inputRange[0] - anchor) * factor,
        anchor + (inputRange[1] - anchor) * factor,
      ]);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
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
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Role is application for interactive plots and img for retained static callers. */}
      <svg
        ref={svg}
        role={interaction ? 'application' : 'img'}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        data-fill-height={fillHeight || undefined}
        style={{
          ...(!fillHeight && height !== 151 ? { height } : {}),
          ...(interaction ? { minWidth: minimumWidth } : {}),
        }}
        preserveAspectRatio={fluid ? 'xMidYMid meet' : 'none'}
        aria-label={`${primary?.label || primary?.node.name || 'Signal'} over time`}
        tabIndex={interaction ? 0 : undefined}
        data-interactive={interaction?.mode}
        data-range-start={inputRange[0]}
        data-range-end={inputRange[1]}
        data-plot-left={left}
        data-plot-right={right}
        onDoubleClick={
          interaction
            ? (event) => {
                event.preventDefault();
                setGesture(undefined);
                const hit = hitAxis(event.clientX, event.clientY);
                if (hit.axis || hit.time) interaction.onAxes(hit.axis?.key);
                else interaction.onFit();
              }
            : undefined
        }
        onContextMenu={
          interaction
            ? (event) => {
                event.preventDefault();
                interaction.onAxes(
                  hitAxis(event.clientX, event.clientY).axis?.key,
                );
              }
            : undefined
        }
        onKeyDown={
          interaction
            ? (event) => {
                const width = inputRange[1] - inputRange[0];
                let next: PlotRange | undefined;
                if (event.key === 'Escape') setGesture(undefined);
                else if (event.key === 'Home') interaction.onFit();
                else if (event.key === 'Backspace') interaction.onBack();
                else if (event.key === '+' || event.key === '=')
                  next = [inputRange[0] + width / 4, inputRange[1] - width / 4];
                else if (event.key === '-')
                  next = [inputRange[0] - width / 2, inputRange[1] + width / 2];
                else if (
                  event.key === 'ArrowLeft' ||
                  event.key === 'ArrowRight'
                ) {
                  const delta =
                    width * (event.key === 'ArrowLeft' ? -0.1 : 0.1);
                  next = [inputRange[0] + delta, inputRange[1] + delta];
                } else return;
                event.preventDefault();
                if (next) interaction.onRange(next);
              }
            : undefined
        }
        onPointerDown={
          interaction
            ? (event) => {
                if (event.button !== 0 && event.button !== 1) return;
                event.preventDefault();
                event.currentTarget.focus();
                const hit = hitAxis(event.clientX, event.clientY);
                if (hit.axis || hit.time) return;
                if (event.isTrusted)
                  event.currentTarget.setPointerCapture(event.pointerId);
                const time = eventTime(event.clientX);
                const mode =
                  event.shiftKey || event.button === 1
                    ? 'pan'
                    : interaction.mode === 'cursor' && interaction.cursors
                      ? Math.abs(time - interaction.cursors[0]) <=
                        Math.abs(time - interaction.cursors[1])
                        ? 'a'
                        : 'b'
                      : interaction.mode === 'zoom'
                        ? 'zoom'
                        : 'pan';
                setGesture({ start: time, end: time, range: inputRange, mode });
              }
            : undefined
        }
        onPointerUp={
          interaction
            ? (event) => {
                if (!gesture) return;
                const time = eventTime(event.clientX);
                if (
                  gesture.mode === 'pan' &&
                  Math.abs(time - gesture.start) > 0
                )
                  interaction.onRange([
                    gesture.range[0] + gesture.start - time,
                    gesture.range[1] + gesture.start - time,
                  ]);
                else if (
                  gesture.mode === 'zoom' &&
                  Math.abs(time - gesture.start) >
                    (inputRange[1] - inputRange[0]) * 0.005
                )
                  interaction.onRange([
                    Math.min(time, gesture.start),
                    Math.max(time, gesture.start),
                  ]);
                else if (
                  (gesture.mode === 'a' || gesture.mode === 'b') &&
                  interaction.cursors
                )
                  interaction.onCursors(
                    gesture.mode === 'a'
                      ? [time, interaction.cursors[1]]
                      : [interaction.cursors[0], time],
                  );
                setGesture(undefined);
              }
            : undefined
        }
        onPointerCancel={() => setGesture(undefined)}
        onPointerMove={(event) => {
          if (gesture)
            setGesture({ ...gesture, end: eventTime(event.clientX) });
          if (interaction && !gesture) {
            const hit = hitAxis(event.clientX, event.clientY);
            if (hit.axis || hit.time) {
              setCursor(null);
              return;
            }
          }
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
        {Array.from({ length: valueTicks }, (_, i) => (
          <g key={i}>
            {grid && (
              <line
                x1={left}
                x2={right}
                y1={15 + (i * plotHeight) / (valueTicks - 1)}
                y2={15 + (i * plotHeight) / (valueTicks - 1)}
                className="chart-grid"
              />
            )}
          </g>
        ))}
        {scales.map((axis, axisIndex) => {
          const position = axisIndex ? right + (axisIndex - 1) * 88 : left;
          const direction = axisIndex ? 1 : -1;
          const label = axis.label + (axis.log ? ' · Log Y' : '');
          const labelLimit = Math.max(12, Math.floor(plotHeight / 6));
          return (
            <g
              key={axis.key}
              data-value-axis={axis.key}
              data-axis-min={axis.range[0]}
              data-axis-max={axis.range[1]}
              data-axis-log={axis.log}
              className={interaction ? 'plot-value-axis' : undefined}
            >
              {interaction && (
                <>
                  <title>
                    {label}
                    {axis.log ? ' · positive values only' : ''} · Scroll to
                    zoom; double-click to edit
                  </title>
                  <rect
                    x={axisIndex ? position : 0}
                    y="0"
                    width={axisIndex ? 88 : left}
                    height={chartHeight}
                    fill="transparent"
                  />
                  <line
                    x1={position}
                    x2={position}
                    y1="15"
                    y2={bottom}
                    stroke={axis.color}
                    opacity="0.6"
                  />
                  <text
                    className="plot-axis-title"
                    transform={`translate(${position + direction * 73}, ${15 + plotHeight / 2}) rotate(${axisIndex ? 90 : -90})`}
                    textAnchor="middle"
                    style={{ fill: axis.color }}
                  >
                    {label.length > labelLimit
                      ? `${label.slice(0, labelLimit - 1)}…`
                      : label}
                  </text>
                </>
              )}
              {Array.from({ length: valueTicks }, (_, i) => (
                <text
                  key={i}
                  x={position + direction * 9}
                  y={19 + (i * plotHeight) / (valueTicks - 1)}
                  textAnchor={axisIndex ? 'start' : 'end'}
                  style={interaction ? { fill: axis.color } : undefined}
                >
                  {axisNumber(
                    axis.log
                      ? 10 **
                          (axis.max -
                            (i / (valueTicks - 1)) * (axis.max - axis.min))
                      : axis.max -
                          (i / (valueTicks - 1)) * (axis.max - axis.min),
                  )}
                </text>
              ))}
            </g>
          );
        })}
        {interaction && (
          <g className="plot-time-axis">
            <title>Scroll to zoom time; double-click to edit</title>
            <rect
              x={left}
              y={bottom + 3}
              width={span}
              height={chartHeight - bottom - 3}
              fill="transparent"
            />
          </g>
        )}
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
              y={bottom + 22}
              textAnchor="middle"
              className={interaction ? 'plot-time-axis' : undefined}
            >
              {axisNumber(range[0] + (i / (ticks - 1)) * (range[1] - range[0]))}
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
          {geometry.map(
            ({ key, d, color, reference, dots, width: strokeWidth }) => (
              <path
                key={key}
                d={d}
                fill={dots ? color : 'none'}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={reference ? '6 4' : undefined}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            ),
          )}
        </g>
        {currentTime !== null && !gesture && !interaction?.cursors && (
          <g pointerEvents="none" data-plot-transient>
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
              {formatValue(currentTime, interaction ? 5 : 1)} s
              {!interaction && ` · ${formatValue(nearest?.[1] ?? NaN)}`}
            </text>
          </g>
        )}
        {gesture?.mode === 'zoom' && (
          <rect
            x={Math.min(x(gesture.start), x(gesture.end))}
            y="8"
            width={Math.abs(x(gesture.start) - x(gesture.end))}
            height={plotHeight}
            fill="#87baf2"
            opacity="0.2"
            pointerEvents="none"
          />
        )}
        {interaction?.cursors?.map((original, i) => {
          const time =
            gesture?.mode === (i ? 'b' : 'a') ? gesture.end : original;
          return (
            time >= range[0] &&
            time <= range[1] && (
              <g
                key={i}
                className="plot-cursor"
                data-cursor={i ? 'B' : 'A'}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  svg.current?.focus();
                  if (event.isTrusted)
                    svg.current?.setPointerCapture(event.pointerId);
                  setGesture({
                    start: eventTime(event.clientX),
                    end: original,
                    range: inputRange,
                    mode: i ? 'b' : 'a',
                  });
                }}
              >
                <line
                  x1={x(time)}
                  x2={x(time)}
                  y1="8"
                  y2={bottom}
                  stroke={i ? '#f2c479' : '#87baf2'}
                  strokeDasharray="5 3"
                />
                <rect
                  x={x(time) - 10}
                  y="4"
                  width="20"
                  height="20"
                  rx="2"
                  fill={i ? '#f2c479' : '#87baf2'}
                />
                <text
                  x={x(time)}
                  y="18"
                  textAnchor="middle"
                  style={{ fill: '#142235' }}
                >
                  {i ? 'B' : 'A'}
                </text>
              </g>
            )
          );
        })}
        {interaction?.annotations
          ?.filter((note) => note.time >= range[0] && note.time <= range[1])
          .map((note, i) => (
            <g
              key={note.id}
              className="plot-annotation"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation();
                interaction.onAnnotation(note.time, note.id);
              }}
            >
              <title>{note.text}</title>
              <line
                x1={x(note.time)}
                x2={x(note.time)}
                y1={35 + (i % 3) * 20}
                y2={bottom}
                stroke="#b6c7db"
                opacity="0.45"
              />
              <text
                x={Math.min(right - 100, Math.max(left, x(note.time) + 4))}
                y={35 + (i % 3) * 20}
              >
                {note.text.length > 28
                  ? `${note.text.slice(0, 28)}…`
                  : note.text}
              </text>
            </g>
          ))}
        <text
          data-time-axis
          className={interaction ? 'plot-time-axis plot-axis-title' : undefined}
          x={interaction ? left + span / 2 : chartWidth - 5}
          y={chartHeight - 6}
          textAnchor={interaction ? 'middle' : 'end'}
        >
          {interaction
            ? interaction.axes?.timeLabel || interaction.timeLabel || 'Time (s)'
            : 's'}
        </text>
      </svg>
    </section>
  );
}

function axisNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  return abs && (abs >= 1e6 || abs < 0.001)
    ? value.toExponential(2)
    : Number(value.toPrecision(5)).toLocaleString('en-GB', {
        maximumFractionDigits: 6,
      });
}
