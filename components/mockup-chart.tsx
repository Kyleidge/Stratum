'use client';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  formatNumber,
  formatTick,
  lowerBound,
  niceDomain,
  niceTicks,
} from '@/lib/mockup-data';

export type ChartTrace = {
  id: string;
  label: string;
  short: string;
  unit: string;
  color: string;
  t: Float64Array;
  v: Float64Array;
  /** Display time = recording time − offset. */
  offset: number;
};

export type ChartReference = {
  id: string;
  traceId: string;
  value: number;
  label: string;
  t0: number;
  t1: number;
};

export type ChartTool = 'pan' | 'zoom' | 'measure';

type Props = {
  traces: ChartTrace[];
  references: ChartReference[];
  layout: 'overlay' | 'stacked';
  tool: ChartTool;
  grid: boolean;
  holdY: boolean;
  fitKey: number;
  timeLabel: string;
  onCursor?: (time: number | null) => void;
};

const MARGIN = { left: 72, right: 24, top: 14, gap: 22, axis: 40 };

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function visibleRange(trace: ChartTrace, d0: number, d1: number) {
  const first = Math.max(0, lowerBound(trace.t, d0 + trace.offset) - 1);
  const last = Math.min(
    trace.t.length,
    lowerBound(trace.t, d1 + trace.offset) + 1,
  );
  return [first, last] as const;
}

/** Min/max envelope per pixel column once samples outnumber pixels. */
function tracePath(
  trace: ChartTrace,
  d0: number,
  d1: number,
  x: (time: number) => number,
  y: (value: number) => number,
  width: number,
) {
  const [first, last] = visibleRange(trace, d0, d1);
  const parts: string[] = [];
  const point = (i: number) =>
    `${x(trace.t[i] - trace.offset).toFixed(1)} ${y(trace.v[i]).toFixed(1)}`;
  if (last - first <= width * 2) {
    for (let i = first; i < last; i++)
      parts.push(`${i === first ? 'M' : 'L'}${point(i)}`);
    return parts.join('');
  }
  let column = NaN;
  let low = first;
  let high = first;
  const flush = () => {
    const [a, b] = low < high ? [low, high] : [high, low];
    parts.push(`${parts.length ? 'L' : 'M'}${point(a)}`, `L${point(b)}`);
  };
  for (let i = first; i < last; i++) {
    const next = Math.floor(x(trace.t[i] - trace.offset));
    if (next !== column) {
      if (!Number.isNaN(column)) flush();
      column = next;
      low = high = i;
    } else {
      if (trace.v[i] < trace.v[low]) low = i;
      if (trace.v[i] > trace.v[high]) high = i;
    }
  }
  flush();
  return parts.join('');
}

function sampleAt(trace: ChartTrace, time: number) {
  const target = time + trace.offset;
  if (
    !trace.t.length ||
    target < trace.t[0] - 0.05 ||
    target > trace.t[trace.t.length - 1] + 0.05
  )
    return undefined;
  const i = Math.min(trace.t.length - 1, lowerBound(trace.t, target));
  const j = i > 0 && target - trace.t[i - 1] < trace.t[i] - target ? i - 1 : i;
  return { time: trace.t[j] - trace.offset, value: trace.v[j] };
}

type Label = {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
  anchor: 'start' | 'end';
};

/** Pushes overlapping direct labels apart vertically. */
function placeLabels(labels: Label[], top: number, bottom: number) {
  const placed = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < placed.length; i++)
    for (let j = 0; j < i; j++) {
      const a = placed[j];
      const b = placed[i];
      const width = Math.max(a.text.length, b.text.length) * 6.6;
      if (Math.abs(a.x - b.x) < width && b.y - a.y < 15) b.y = a.y + 15;
    }
  for (const label of placed)
    label.y = Math.min(bottom - 4, Math.max(top + 11, label.y));
  return placed;
}

export default function MockupChart({
  traces,
  references,
  layout,
  tool,
  grid,
  holdY,
  fitKey,
  timeLabel,
  onCursor,
}: Props) {
  const [box, size] = useSize();
  const svg = useRef<SVGSVGElement>(null);
  const width = Math.max(320, size.width);
  const height = Math.max(220, size.height);
  const plotWidth = width - MARGIN.left - MARGIN.right;

  const extent = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of traces) {
      if (!trace.t.length) continue;
      lo = Math.min(lo, trace.t[0] - trace.offset);
      hi = Math.max(hi, trace.t[trace.t.length - 1] - trace.offset);
    }
    return Number.isFinite(lo) && hi > lo
      ? ([lo, hi] as const)
      : ([0, 1] as const);
  }, [traces]);
  const viewKey = `${fitKey}:${extent[0]}:${extent[1]}`;
  const [view, setView] = useState<{
    key: string;
    range: readonly [number, number];
  }>();
  const [d0, d1] = view?.key === viewKey ? view.range : extent;
  const x = (time: number) =>
    MARGIN.left + ((time - d0) / (d1 - d0)) * plotWidth;
  const timeAt = (px: number) =>
    d0 + ((px - MARGIN.left) / plotWidth) * (d1 - d0);

  const lanes = useMemo(() => {
    const groups: { key: string; unit: string; traces: ChartTrace[] }[] = [];
    for (const trace of traces) {
      const key = layout === 'stacked' ? trace.id : trace.unit;
      let group = groups.find((item) => item.key === key);
      if (!group) groups.push((group = { key, unit: trace.unit, traces: [] }));
      group.traces.push(trace);
    }
    return groups;
  }, [traces, layout]);

  const laneHeight =
    (height - MARGIN.top - MARGIN.axis - MARGIN.gap * (lanes.length - 1)) /
    Math.max(1, lanes.length);
  const scaled = lanes.map((lane, index) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const trace of lane.traces) {
      const [first, last] = holdY
        ? [0, trace.t.length]
        : visibleRange(trace, d0, d1);
      for (let i = first; i < last; i++) {
        lo = Math.min(lo, trace.v[i]);
        hi = Math.max(hi, trace.v[i]);
      }
    }
    for (const reference of references)
      if (lane.traces.some((trace) => trace.id === reference.traceId)) {
        lo = Math.min(lo, reference.value);
        hi = Math.max(hi, reference.value);
      }
    if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
    const target = Math.max(3, Math.min(7, Math.floor(laneHeight / 56)));
    const domain = niceDomain(lo, hi, target);
    const top = MARGIN.top + index * (laneHeight + MARGIN.gap);
    const y = (value: number) =>
      top +
      laneHeight -
      ((value - domain.lo) / (domain.hi - domain.lo)) * laneHeight;
    return { ...lane, domain, top, y };
  });
  const bottom = height - MARGIN.axis;
  const timeTicks = niceTicks(
    d0,
    d1,
    Math.max(3, Math.min(10, Math.floor(plotWidth / 90))),
  );

  const [cursor, setCursor] = useState<number | null>(null);
  const [marks, setMarks] = useState<{ a?: number; b?: number }>({});
  const [band, setBand] = useState<{ from: number; to: number }>();
  const drag = useRef<{ px: number; range: readonly [number, number] }>(
    undefined,
  );

  function moveCursor(time: number | null) {
    setCursor(time);
    onCursor?.(time);
  }
  function localX(event: PointerEvent) {
    const rect = svg.current!.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  }
  function zoomAround(time: number, factor: number) {
    const span = Math.max((extent[1] - extent[0]) / 400, (d1 - d0) * factor);
    const ratio = (time - d0) / (d1 - d0);
    const lo = Math.max(extent[0], time - ratio * span);
    const hi = Math.min(extent[1], lo + span);
    setView({ key: viewKey, range: [Math.max(extent[0], hi - span), hi] });
  }

  // Native listener: React registers wheel handlers as passive.
  const wheel = useRef<(event: WheelEvent) => void>(undefined);
  useEffect(() => {
    wheel.current = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.current!.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      zoomAround(timeAt(px), Math.exp(event.deltaY * 0.0015));
    };
  });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheel.current?.(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    const px = localX(event);
    if (px < MARGIN.left || px > width - MARGIN.right) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'measure') {
      const time = timeAt(px);
      setMarks((old) =>
        old.a === undefined || old.b !== undefined
          ? { a: time }
          : { a: old.a, b: time },
      );
      return;
    }
    if (tool === 'zoom') setBand({ from: px, to: px });
    else drag.current = { px, range: [d0, d1] };
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const px = localX(event);
    if (band) setBand({ ...band, to: px });
    if (drag.current) {
      const { px: start, range } = drag.current;
      const span = range[1] - range[0];
      let lo = range[0] - ((px - start) / plotWidth) * span;
      lo = Math.min(extent[1] - span, Math.max(extent[0], lo));
      setView({ key: viewKey, range: [lo, lo + span] });
    }
    moveCursor(
      px >= MARGIN.left && px <= width - MARGIN.right ? timeAt(px) : null,
    );
  }
  function pointerUp() {
    drag.current = undefined;
    if (band && Math.abs(band.to - band.from) > 6) {
      const a = timeAt(Math.min(band.from, band.to));
      const b = timeAt(Math.max(band.from, band.to));
      setView({
        key: viewKey,
        range: [Math.max(extent[0], a), Math.min(extent[1], b)],
      });
    }
    setBand(undefined);
  }
  // Arrow keys move the range input natively; these add zoom and reset.
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const current = cursor ?? (d0 + d1) / 2;
    if (event.key === '+' || event.key === '=') zoomAround(current, 0.8);
    else if (event.key === '-') zoomAround(current, 1.25);
    else if (event.key === '0') setView(undefined);
    else if (event.key === 'Escape') {
      moveCursor(null);
      setMarks({});
    }
  }

  const readout =
    cursor === null
      ? []
      : traces
          .map((trace) => ({ trace, sample: sampleAt(trace, cursor) }))
          .filter((item) => item.sample);
  const cursorX = cursor === null ? 0 : x(cursor);
  const measured = (['a', 'b'] as const).filter(
    (key) => marks[key] !== undefined,
  );

  return (
    <div className="mk-chart" ref={box} data-tool={tool}>
      {/* Keyboard and screen-reader access: the cursor is a time slider. */}
      <input
        type="range"
        className="mk-cursor-input"
        aria-label={`Plot cursor for ${traces.map((trace) => trace.label).join(', ')} against ${timeLabel}. Plus and minus zoom; 0 fits; Escape clears.`}
        min={d0}
        max={d1}
        step={(d1 - d0) / 200}
        value={cursor ?? d0}
        aria-valuetext={
          cursor === null
            ? 'No cursor'
            : `${formatNumber(cursor, 2)} s: ${readout
                .map(
                  ({ trace, sample }) =>
                    `${trace.short} ${formatNumber(sample!.value)} ${trace.unit}`,
                )
                .join(', ')}`
        }
        onChange={(event) => moveCursor(Number(event.target.value))}
        onKeyDown={keyDown}
      />
      <svg
        ref={svg}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerLeave={() => {
          if (!drag.current && !band) moveCursor(null);
        }}
        onDoubleClick={() => setView(undefined)}
      >
        <defs>
          {scaled.map((lane) => (
            <clipPath id={`mk-clip-${lane.key}`} key={lane.key}>
              <rect
                x={MARGIN.left}
                y={lane.top - 2}
                width={plotWidth}
                height={laneHeight + 4}
              />
            </clipPath>
          ))}
        </defs>
        {scaled.map((lane) => {
          const labels = placeLabels(
            [
              ...references
                .filter((reference) =>
                  lane.traces.some((trace) => trace.id === reference.traceId),
                )
                .map((reference) => {
                  const trace = lane.traces.find(
                    (item) => item.id === reference.traceId,
                  )!;
                  return {
                    key: reference.id,
                    x: Math.max(
                      MARGIN.left + 4,
                      x(Math.max(d0, reference.t0 - trace.offset)) + 4,
                    ),
                    y: lane.y(reference.value) - 6,
                    text: reference.label,
                    color: trace.color,
                    anchor: 'start' as const,
                  };
                })
                .filter((label) => label.x < width - MARGIN.right - 40),
              ...(lane.traces.length > 1 || layout === 'overlay'
                ? lane.traces.flatMap((trace) => {
                    const [first, last] = visibleRange(trace, d0, d1);
                    if (last - first < 2) return [];
                    // Label each trace at its visible peak, clear of the data.
                    let i = first;
                    for (let j = first; j < last; j++)
                      if (trace.v[j] > trace.v[i]) i = j;
                    return [
                      {
                        key: trace.id,
                        x: Math.min(
                          width - MARGIN.right - 2,
                          x(trace.t[i] - trace.offset),
                        ),
                        y: lane.y(trace.v[i]) - 8,
                        text: trace.short,
                        color: trace.color,
                        anchor: 'end' as const,
                      },
                    ];
                  })
                : []),
            ],
            lane.top,
            lane.top + laneHeight,
          );
          return (
            <g key={lane.key}>
              {lane.domain.ticks.map((tick) => (
                <g key={tick}>
                  {grid && (
                    <line
                      className="mk-grid"
                      x1={MARGIN.left}
                      x2={width - MARGIN.right}
                      y1={lane.y(tick)}
                      y2={lane.y(tick)}
                    />
                  )}
                  <text
                    className="mk-tick"
                    x={MARGIN.left - 8}
                    y={lane.y(tick) + 4}
                    textAnchor="end"
                  >
                    {formatTick(tick, lane.domain.step)}
                  </text>
                </g>
              ))}
              <text
                className="mk-axis-title"
                transform={`translate(14 ${lane.top + laneHeight / 2}) rotate(-90)`}
                textAnchor="middle"
              >
                {layout === 'stacked' ? `${lane.traces[0].short} · ` : ''}
                {lane.unit}
              </text>
              <line
                className="mk-baseline"
                x1={MARGIN.left}
                x2={MARGIN.left}
                y1={lane.top}
                y2={lane.top + laneHeight}
              />
              <g clipPath={`url(#mk-clip-${lane.key})`}>
                {references.map((reference) => {
                  const trace = lane.traces.find(
                    (item) => item.id === reference.traceId,
                  );
                  if (!trace) return null;
                  return (
                    <line
                      key={reference.id}
                      className="mk-reference"
                      x1={x(reference.t0 - trace.offset)}
                      x2={x(reference.t1 - trace.offset)}
                      y1={lane.y(reference.value)}
                      y2={lane.y(reference.value)}
                      style={{ stroke: trace.color }}
                    />
                  );
                })}
                {lane.traces.map((trace) => (
                  <path
                    key={trace.id}
                    className="mk-trace"
                    d={tracePath(trace, d0, d1, x, lane.y, plotWidth)}
                    style={{ stroke: trace.color }}
                  />
                ))}
                {readout
                  .filter(({ trace }) => lane.traces.includes(trace))
                  .map(({ trace, sample }) => (
                    <circle
                      key={trace.id}
                      className="mk-cursor-dot"
                      cx={x(sample!.time)}
                      cy={lane.y(sample!.value)}
                      r={4}
                      style={{ fill: trace.color }}
                    />
                  ))}
              </g>
              {labels.map((label) => (
                <g key={label.key} className="mk-direct-label">
                  <text
                    x={label.x + (label.anchor === 'start' ? 11 : -1)}
                    y={label.y}
                    textAnchor={label.anchor}
                  >
                    {label.text}
                  </text>
                  <rect
                    x={
                      label.anchor === 'start'
                        ? label.x
                        : label.x - label.text.length * 6.4 - 12
                    }
                    y={label.y - 7}
                    width={7}
                    height={7}
                    rx={2}
                    style={{ fill: label.color }}
                  />
                </g>
              ))}
            </g>
          );
        })}
        <line
          className="mk-baseline"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={bottom}
          y2={bottom}
        />
        {timeTicks.ticks.map((tick) => (
          <g key={tick}>
            {grid && (
              <line
                className="mk-grid"
                x1={x(tick)}
                x2={x(tick)}
                y1={MARGIN.top}
                y2={bottom}
              />
            )}
            <text
              className="mk-tick"
              x={x(tick)}
              y={bottom + 17}
              textAnchor="middle"
            >
              {formatTick(tick, timeTicks.step)}
            </text>
          </g>
        ))}
        <text
          className="mk-axis-title"
          x={MARGIN.left + plotWidth / 2}
          y={height - 6}
          textAnchor="middle"
        >
          {timeLabel}
        </text>
        {measured.map((key) => (
          <g key={key} className="mk-marker">
            <line
              x1={x(marks[key]!)}
              x2={x(marks[key]!)}
              y1={MARGIN.top}
              y2={bottom}
            />
            <text x={x(marks[key]!) + 4} y={MARGIN.top + 10}>
              {key.toUpperCase()}
            </text>
          </g>
        ))}
        {band && (
          <rect
            className="mk-band"
            x={Math.min(band.from, band.to)}
            y={MARGIN.top}
            width={Math.abs(band.to - band.from)}
            height={bottom - MARGIN.top}
          />
        )}
        {cursor !== null && (
          <line
            className="mk-crosshair"
            x1={cursorX}
            x2={cursorX}
            y1={MARGIN.top}
            y2={bottom}
          />
        )}
      </svg>
      {cursor !== null && readout.length > 0 && (
        <div
          className="mk-tooltip"
          style={
            cursorX > width - 240
              ? { right: width - cursorX + 12 }
              : { left: cursorX + 12 }
          }
        >
          <strong>{formatNumber(cursor, 2)} s</strong>
          {readout.map(({ trace, sample }) => (
            <span key={trace.id}>
              <i style={{ background: trace.color }} />
              {trace.label}
              <b>
                {formatNumber(sample!.value)} {trace.unit}
              </b>
            </span>
          ))}
        </div>
      )}
      {marks.a !== undefined && marks.b !== undefined && (
        <div className="mk-measure">
          <strong>A → B · Δt {formatNumber(marks.b - marks.a, 2)} s</strong>
          {traces.map((trace) => {
            const a = sampleAt(trace, marks.a!);
            const b = sampleAt(trace, marks.b!);
            return a && b ? (
              <span key={trace.id}>
                <i style={{ background: trace.color }} />
                {trace.short}
                <b>
                  Δ {formatNumber(b.value - a.value)} {trace.unit}
                </b>
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
