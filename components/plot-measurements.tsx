'use client';

import { useEffect, useState } from 'react';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';
import type { PlotMeasurement } from '@/lib/plot-measurement';
import type { PlotRange } from '@/lib/plot-scratchpad';
import { formatValue } from './signal-chart';

export default function PlotMeasurements({
  items,
  cursors,
  onCursors,
  request,
  project,
}: {
  items: {
    id: string;
    label: string;
    unit: string;
    offset: number;
    scalar?: number | null;
  }[];
  cursors: PlotRange;
  onCursors: (value: PlotRange) => void;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  project: Project;
}) {
  const [page, setPage] = useState(0);
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(items.length / 30) - 1),
  );
  const shown = items.slice(safePage * 30, (safePage + 1) * 30);
  const key = JSON.stringify(
    shown
      .filter((item) => item.scalar === undefined)
      .map((item) => ({
        id: item.id,
        a: cursors[0] + item.offset,
        b: cursors[1] + item.offset,
      })),
  );
  const [result, setResult] = useState<{
    key: string;
    project: Project;
    rows?: PlotMeasurement[];
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void request({
        type: 'measure-plot',
        items: JSON.parse(key) as { id: string; a: number; b: number }[],
        inspection: true,
      })
        .then((response) => {
          if (alive && response.type === 'plot-measurements')
            setResult({ key, project, rows: response.measurements });
        })
        .catch((error: unknown) => {
          if (alive)
            setResult({
              key,
              project,
              error:
                error instanceof Error ? error.message : 'Measurement failed.',
            });
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, project, request, retry]);
  const current =
    result?.key === key && result.project === project ? result : undefined;
  return (
    <section className="plot-measurements" aria-label="Plot measurements">
      <div className="plot-measurement-tools">
        <strong>Cursors</strong>
        {(['A', 'B'] as const).map((label, i) => (
          <label key={label}>
            {label} (s)
            <input
              type="number"
              step="any"
              aria-label={`Cursor ${label} time`}
              value={Number(cursors[i].toPrecision(12))}
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value))
                  onCursors(i ? [cursors[0], value] : [value, cursors[1]]);
              }}
            />
          </label>
        ))}
        <span>
          Δt <b>{formatValue(cursors[1] - cursors[0], 6)} s</b>
        </span>
        <span className="workflow-muted">
          Nearest samples · statistics between cursors
        </span>
      </div>
      {current?.error ? (
        <p role="alert">
          {current.error}{' '}
          <button
            className="workflow-link"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry measurements
          </button>
        </p>
      ) : (
        <div className="plot-measurement-table">
          <table>
            <thead>
              <tr>
                <th>Trace / unit</th>
                <th>A / sample time</th>
                <th>B / sample time</th>
                <th>Δvalue</th>
                <th>Count</th>
                <th>Min</th>
                <th>Max</th>
                <th>Mean</th>
                <th>RMS</th>
                <th>Integral (unit·s)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const row = current?.rows?.find((r) => r.id === item.id);
                const scalar = item.scalar !== undefined;
                const a = scalar ? item.scalar : row?.a?.[1],
                  b = scalar ? item.scalar : row?.b?.[1];
                return (
                  <tr key={item.id}>
                    <th title={item.label}>
                      {item.label} <small>{item.unit}</small>
                    </th>
                    <td>
                      {number(a)}
                      {row?.a && (
                        <small>
                          {formatValue(row.a[0] - item.offset, 6)} s
                        </small>
                      )}
                    </td>
                    <td>
                      {number(b)}
                      {row?.b && (
                        <small>
                          {formatValue(row.b[0] - item.offset, 6)} s
                        </small>
                      )}
                    </td>
                    <td>
                      {number(
                        typeof a === 'number' && typeof b === 'number'
                          ? b - a
                          : null,
                      )}
                    </td>
                    {scalar ? (
                      <td colSpan={6}>Scalar reference</td>
                    ) : (
                      <>
                        <td>{row?.count ?? '…'}</td>
                        <td>{number(row?.min)}</td>
                        <td>{number(row?.max)}</td>
                        <td>{number(row?.mean)}</td>
                        <td>{number(row?.rms)}</td>
                        <td>{number(row?.integral)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="plot-measurement-tools">
        <output>
          {!current
            ? 'Measuring evaluated samples…'
            : `${shown.length} trace${shown.length === 1 ? '' : 's'}`}
        </output>
        {items.length > 30 && (
          <>
            <button
              className="workflow-link"
              disabled={!safePage}
              onClick={() => setPage(safePage - 1)}
            >
              Previous measurements
            </button>
            <span>
              {safePage * 30 + 1}–{Math.min(items.length, (safePage + 1) * 30)}{' '}
              of {items.length}
            </span>
            <button
              className="workflow-link"
              disabled={(safePage + 1) * 30 >= items.length}
              onClick={() => setPage(safePage + 1)}
            >
              Next measurements
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function number(value: number | null | undefined) {
  return value === undefined
    ? '…'
    : value === null || !Number.isFinite(value)
      ? '—'
      : Math.abs(value) >= 1e9 ||
          (Math.abs(value) > 0 && Math.abs(value) < 0.00001)
        ? value.toExponential(5)
        : value.toLocaleString('en-GB', { maximumSignificantDigits: 8 });
}
