'use client';

import { useEffect, useId, useState, type PointerEvent } from 'react';
import {
  BetweenHorizontalStart,
  MoveHorizontal,
  Plus,
  Trash2,
  Scan,
  ZoomIn,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  SignalNode,
} from '@/lib/signal-types';
import type { SignalGraph } from '@/lib/signal-graph';
import {
  dragTimeRange,
  rangeFields,
  segmentPlotDomain,
  validTimeRange,
  type RangeDrag,
  type TimeRange,
} from '@/lib/time-range-selection';
import SignalChart, { formatValue, type ChartGeometry } from './signal-chart';
import { RegionSelect } from './region-controls';
import { Textarea } from '@/components/ui/textarea';

type Request = (message: EngineRequest) => Promise<EngineResponse>;
type Selection = { index: number; range: TimeRange };
const PAGE_SIZE = 30;
const serialize = (rows: string[][]) =>
  rows.map((row) => row.join(', ')).join('\n');
const time = (value: number) => Number(value.toPrecision(15)).toString();

export default function TimeRangePicker({
  graph,
  ids,
  value,
  onChange,
  request,
  busy,
  label = (id) => graph.nodes.get(id)?.name ?? id,
}: {
  graph: SignalGraph;
  /** Workflow label for a signal, matching History. */
  label?: (id: string) => string;
  ids: string[];
  value: string;
  onChange: (value: string) => void;
  request: Request;
  busy: boolean;
}) {
  const textId = useId();
  const [signalId, setSignalId] = useState(ids[0]);
  const [selected, setSelected] = useState(0);
  const [draw, setDraw] = useState(true);
  const [page, setPage] = useState(0);
  const rows = rangeFields(value);
  const ranges = rows.flatMap((fields, index): Selection[] => {
    const range = validTimeRange(fields);
    return range ? [{ index, range }] : [];
  });
  const node = graph.nodes.get(ids.includes(signalId) ? signalId : ids[0]);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1),
  );
  const invalid = rows.findIndex((fields) => !validTimeRange(fields));
  function select(index: number) {
    setSelected(index);
    setPage(Math.floor(index / PAGE_SIZE));
  }
  function update(index: number, fields: string[]) {
    const next = [...rows];
    next[index] = fields;
    onChange(serialize(next));
  }
  function commit(index: number, range: TimeRange) {
    update(index, range.map(time));
    select(index);
  }
  function remove(index: number) {
    onChange(serialize(rows.filter((_, i) => i !== index)));
    select(Math.max(0, Math.min(index, rows.length - 2)));
  }
  return (
    <div className="time-range-picker">
      <div className="range-picker-chart">
        {node && (
          <>
            <div className="range-picker-heading">
              <RegionSelect
                label="Preview signal"
                value={node.id}
                items={ids.flatMap((id) => {
                  const signal = graph.nodes.get(id);
                  return signal
                    ? [
                        {
                          value: id,
                          label: `${label(id)}${signal.unit ? ` [${signal.unit}]` : ''}`,
                        },
                      ]
                    : [];
                })}
                onChange={setSignalId}
                disabled={busy}
              />
              <span className="range-picker-count" aria-live="polite">
                {rows.length} {rows.length === 1 ? 'range' : 'ranges'}
              </span>
            </div>
            <RangePlot
              key={node.id}
              node={node}
              graph={graph}
              request={request}
              ranges={ranges}
              selected={selected}
              draw={draw}
              setDraw={setDraw}
              onSelect={select}
              onCommit={commit}
              onRemove={remove}
              nextIndex={rows.length}
              busy={busy}
            />
          </>
        )}
      </div>
      <div className="range-picker-list">
        <div className="range-list-heading">
          <strong>Selected ranges</strong>
          <button
            type="button"
            className="workflow-property-link"
            disabled={busy || rows.length >= 1000}
            onClick={() => {
              update(rows.length, ['', '']);
              select(rows.length);
              setDraw(false);
            }}
          >
            <Plus size={13} /> Add exact range
          </button>
        </div>
        {!rows.length ? (
          <p className="input-hint">
            Drag across the plot to add your first range, or enter exact start
            and end times.
          </p>
        ) : (
          <div className="range-list">
            <table>
              <thead>
                <tr>
                  <th>Range</th>
                  <th>Start (s)</th>
                  <th>End (s)</th>
                  <th>Duration (s)</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                  .map((fields, position) => {
                    const index = currentPage * PAGE_SIZE + position;
                    const range = validTimeRange(fields);
                    return (
                      <tr key={index} data-selected={index === selected}>
                        <td>
                          <button
                            type="button"
                            className="range-row-select"
                            aria-label={`Select range ${index + 1}`}
                            aria-pressed={index === selected}
                            onClick={() => {
                              select(index);
                              setDraw(false);
                            }}
                          >
                            {String(index + 1).padStart(2, '0')}
                          </button>
                        </td>
                        {[0, 1].map((side) => (
                          <td key={side}>
                            <input
                              type="number"
                              step="any"
                              title={fields[side] ?? ''}
                              aria-label={`Range ${index + 1} ${side === 0 ? 'start' : 'end'}`}
                              aria-invalid={!range}
                              value={fields[side] ?? ''}
                              onFocus={() => {
                                select(index);
                                setDraw(false);
                              }}
                              onChange={(event) =>
                                update(
                                  index,
                                  side === 0
                                    ? [event.target.value, fields[1] ?? '']
                                    : [fields[0] ?? '', event.target.value],
                                )
                              }
                            />
                          </td>
                        ))}
                        <td className="range-duration">
                          {range ? formatValue(range[1] - range[0], 3) : '—'}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="workflow-icon-button"
                            aria-label={`Remove range ${index + 1}`}
                            onClick={() => remove(index)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > PAGE_SIZE && (
          <div className="range-pagination">
            <button
              type="button"
              className="secondary-button"
              disabled={!currentPage}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous ranges
            </button>
            <span>
              {currentPage * PAGE_SIZE + 1}–
              {Math.min(rows.length, (currentPage + 1) * PAGE_SIZE)} of{' '}
              {rows.length}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={(currentPage + 1) * PAGE_SIZE >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next ranges
            </button>
          </div>
        )}
        {invalid >= 0 && (
          <output className="segment-error">
            Range {invalid + 1} needs a finite start and an end after it.
          </output>
        )}
        {rows.length > 1000 && (
          <output className="segment-error">
            Use no more than 1,000 ranges in one operation.
          </output>
        )}
        <details className="range-paste">
          <summary>Paste or edit range pairs</summary>
          <label className="field-label" htmlFor={textId}>
            Start, end · one range per line, in seconds
          </label>
          <Textarea
            id={textId}
            aria-label="Time range pairs"
            className="segment-ranges"
            rows={4}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </details>
      </div>
    </div>
  );
}

function RangePlot({
  node,
  graph,
  request,
  ranges,
  selected,
  draw,
  setDraw,
  onSelect,
  onCommit,
  onRemove,
  nextIndex,
  busy,
}: {
  node: SignalNode;
  graph: SignalGraph;
  request: Request;
  ranges: Selection[];
  selected: number;
  draw: boolean;
  setDraw: (draw: boolean) => void;
  onSelect: (index: number) => void;
  onCommit: (index: number, range: TimeRange) => void;
  onRemove: (index: number) => void;
  nextIndex: number;
  busy: boolean;
}) {
  const domain = segmentPlotDomain(graph, node.id);
  const [viewport, setViewport] = useState<TimeRange>(domain.range);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    plot?: Plot;
    error?: string;
  }>();
  const requestKey = JSON.stringify([node.id, viewport, domain.offset]);
  useEffect(() => {
    let alive = true;
    const [id, range, offset] = JSON.parse(requestKey) as [
      string,
      TimeRange,
      number,
    ];
    const timer = setTimeout(() => {
      void request({
        type: 'view',
        ids: [id],
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
    }, 100);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [requestKey, request, retry]);
  const current = result?.key === requestKey ? result : undefined;
  const selection = ranges.find((item) => item.index === selected)?.range;
  const full =
    viewport[0] === domain.range[0] && viewport[1] === domain.range[1];
  function zoomSelection() {
    if (!selection) return;
    const pad = (selection[1] - selection[0]) * 0.1;
    const range: TimeRange = [
      Math.max(domain.range[0], selection[0] - pad),
      Math.min(domain.range[1], selection[1] + pad),
    ];
    if (range[1] > range[0]) setViewport(range);
  }
  function pan(direction: number) {
    const width = viewport[1] - viewport[0];
    const start = Math.max(
      domain.range[0],
      Math.min(domain.range[1] - width, viewport[0] + width * direction * 0.5),
    );
    setViewport([start, start + width]);
  }
  return (
    <div className="range-plot">
      <div
        className="range-plot-toolbar"
        role="toolbar"
        aria-label="Time range plot tools"
      >
        <button
          type="button"
          className="secondary-button"
          aria-pressed={draw}
          onClick={() => setDraw(true)}
        >
          <BetweenHorizontalStart size={14} /> Draw ranges
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-pressed={!draw}
          onClick={() => setDraw(false)}
        >
          <MoveHorizontal size={14} /> Adjust ranges
        </button>
        <div className="range-zoom-tools">
          <button
            type="button"
            className="workflow-icon-button"
            aria-label="Pan range plot left"
            disabled={full || busy}
            onClick={() => pan(-1)}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="workflow-icon-button"
            aria-label="Pan range plot right"
            disabled={full || busy}
            onClick={() => pan(1)}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!selection || busy}
            onClick={zoomSelection}
          >
            <ZoomIn size={14} /> Zoom to range
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={full || busy}
            onClick={() => setViewport(domain.range)}
          >
            <Scan size={14} /> Fit
          </button>
        </div>
      </div>
      <p className="input-hint range-plot-help">
        {draw
          ? 'Drag to add a range. Repeat to select more; overlaps are allowed.'
          : 'Drag a shaded range to move it, or drag either edge to resize. Arrow keys move the selected range.'}{' '}
        Escape cancels a drag.
      </p>
      <div className="range-plot-canvas" aria-busy={!current}>
        {current?.plot ? (
          <SignalChart
            traces={[{ node, plot: current.plot, offset: domain.offset }]}
            segments={[]}
            range={viewport}
            onSegment={() => {}}
            fluid
            height={260}
            heading={false}
            includeZero={false}
            overlay={(geometry) => (
              <RangeOverlay
                key={`${requestKey}:${draw}:${busy}`}
                geometry={geometry}
                viewport={viewport}
                ranges={ranges}
                selected={selected}
                draw={draw}
                onSelect={onSelect}
                onCommit={onCommit}
                onRemove={onRemove}
                nextIndex={nextIndex}
                busy={busy}
              />
            )}
          />
        ) : (
          <output className="range-plot-loading">
            {current?.error ? (
              <>
                <span>{current.error}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setRetry(retry + 1)}
                >
                  Retry plot
                </button>
              </>
            ) : (
              'Loading signal plot…'
            )}
          </output>
        )}
      </div>
      <div className="range-plot-axis">
        <span>{domain.label} · seconds</span>
        <span>
          Available {formatValue(domain.range[0], 3)}–
          {formatValue(domain.range[1], 3)} s
        </span>
      </div>
    </div>
  );
}

function RangeOverlay({
  geometry,
  viewport,
  ranges,
  selected,
  draw,
  onSelect,
  onCommit,
  onRemove,
  nextIndex,
  busy,
}: {
  geometry: ChartGeometry;
  viewport: TimeRange;
  ranges: Selection[];
  selected: number;
  draw: boolean;
  onSelect: (index: number) => void;
  onCommit: (index: number, range: TimeRange) => void;
  onRemove: (index: number) => void;
  nextIndex: number;
  busy: boolean;
}) {
  const [gesture, setGesture] = useState<{
    pointerId: number;
    mode: RangeDrag;
    index: number;
    anchor: number;
    origin: TimeRange;
    range: TimeRange;
    clientX: number;
  }>();
  const { left, right, top, bottom, x } = geometry;
  const span = right - left;
  function pointerTime(event: PointerEvent<SVGGElement>) {
    const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const position =
      (((event.clientX - rect.left) * geometry.width) / rect.width - left) /
      span;
    const duration = viewport[1] - viewport[0];
    // Match pointer precision to the visible time span, without rounding typed times.
    const digits = Math.max(
      3,
      Math.min(12, Math.ceil(-Math.log10(duration / 10000))),
    );
    return Number((viewport[0] + position * duration).toFixed(digits));
  }
  const painted = ranges.map((item) =>
    gesture?.index === item.index ? { ...item, range: gesture.range } : item,
  );
  if (gesture?.mode === 'draw')
    painted.push({ index: nextIndex, range: gesture.range });
  // Paint the selected interval last so overlapping intervals remain editable.
  painted.sort(
    (a, b) => Number(a.index === selected) - Number(b.index === selected),
  );
  return (
    <g
      className="range-selection-surface"
      data-mode={draw ? 'draw' : 'adjust'}
      role="application"
      aria-label="Select time ranges on the plot"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy}
      onKeyDown={(event) => {
        if (busy) return;
        if (event.key === 'Escape' && gesture) {
          event.preventDefault();
          event.stopPropagation();
          setGesture(undefined);
          return;
        }
        const range = ranges.find((item) => item.index === selected)?.range;
        if (!range) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onRemove(selected);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const step =
            (viewport[1] - viewport[0]) *
            (event.shiftKey ? 0.01 : 0.001) *
            (event.key === 'ArrowLeft' ? -1 : 1);
          onCommit(
            selected,
            dragTimeRange(range, 'move', 0, step, [
              Math.min(viewport[0], range[0]),
              Math.max(viewport[1], range[1]),
            ]),
          );
        }
      }}
      onPointerDown={(event) => {
        if (busy || event.button !== 0 || gesture) return;
        const hit = (event.target as Element).closest('[data-range-index]');
        const index = draw
          ? nextIndex
          : Number(hit?.getAttribute('data-range-index'));
        if ((!draw && !hit) || (draw && nextIndex >= 1000)) return;
        const anchor = pointerTime(event);
        const origin = ranges.find((item) => item.index === index)?.range ?? [
          anchor,
          anchor,
        ];
        const mode = draw
          ? 'draw'
          : (((event.target as Element).getAttribute(
              'data-range-edge',
            ) as RangeDrag | null) ?? 'move');
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        if (event.isTrusted)
          event.currentTarget.setPointerCapture(event.pointerId);
        onSelect(index);
        setGesture({
          pointerId: event.pointerId,
          mode,
          index,
          anchor,
          origin,
          range: origin,
          clientX: event.clientX,
        });
      }}
      onPointerMove={(event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        event.stopPropagation();
        setGesture({
          ...gesture,
          range: dragTimeRange(
            gesture.origin,
            gesture.mode,
            gesture.anchor,
            pointerTime(event),
            [
              Math.min(viewport[0], gesture.origin[0]),
              Math.max(viewport[1], gesture.origin[1]),
            ],
          ),
        });
      }}
      onPointerUp={(event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        event.stopPropagation();
        const range = dragTimeRange(
          gesture.origin,
          gesture.mode,
          gesture.anchor,
          pointerTime(event),
          [
            Math.min(viewport[0], gesture.origin[0]),
            Math.max(viewport[1], gesture.origin[1]),
          ],
        );
        if (
          (gesture.mode !== 'draw' ||
            Math.abs(event.clientX - gesture.clientX) >= 3) &&
          range[1] > range[0]
        )
          onCommit(gesture.index, range);
        setGesture(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => setGesture(undefined)}
      onLostPointerCapture={() => setGesture(undefined)}
    >
      <rect
        className="range-draw-surface"
        x={left}
        y={top}
        width={span}
        height={bottom - top}
        fill="transparent"
      />
      {painted.map(({ index, range }) => {
        if (range[1] < viewport[0] || range[0] > viewport[1]) return null;
        const start = Math.max(left, x(range[0])),
          end = Math.min(right, x(range[1]));
        const active = index === selected;
        return (
          <g
            key={index}
            data-range-index={index}
            data-selected={active}
            className="range-interval"
          >
            <title>
              Range {index + 1}: {time(range[0])} to {time(range[1])} seconds
            </title>
            <rect
              className="range-fill"
              x={start}
              y={top}
              width={Math.max(0, end - start)}
              height={bottom - top}
            />
            <text
              className="range-number"
              x={Math.max(left + 3, Math.min(right - 20, start + 5))}
              y={top + 15}
              pointerEvents="none"
            >
              {index + 1}
            </text>
            {[0, 1].map((side) => {
              const position = x(range[side]);
              return position >= left && position <= right ? (
                <g key={side}>
                  <line
                    className="range-edge-line"
                    x1={position}
                    x2={position}
                    y1={top}
                    y2={bottom}
                    pointerEvents="none"
                  />
                  <rect
                    data-range-edge={side === 0 ? 'start' : 'end'}
                    className="range-edge"
                    x={Math.max(left, Math.min(right - 10, position - 5))}
                    y={top}
                    width={10}
                    height={bottom - top}
                    fill="transparent"
                  />
                  {active && (
                    <rect
                      className="range-grip"
                      x={Math.max(left, Math.min(right - 6, position - 3))}
                      y={top + (bottom - top) / 2 - 12}
                      width={6}
                      height={24}
                      rx={2}
                      pointerEvents="none"
                    />
                  )}
                </g>
              ) : null;
            })}
          </g>
        );
      })}
      {gesture && (
        <g pointerEvents="none">
          <rect
            x={left + 8}
            y={bottom - 29}
            width={240}
            height={23}
            rx={3}
            className="range-readout-bg"
          />
          <text className="range-readout" x={left + 15} y={bottom - 13}>
            {formatValue(gesture.range[0], 3)} →{' '}
            {formatValue(gesture.range[1], 3)} s
          </text>
        </g>
      )}
    </g>
  );
}
