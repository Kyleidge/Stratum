'use client';
import {
  ClockTextReader,
  describeClock,
  detectDateOrder,
  formatOffset,
  localOffset,
} from '@/lib/clock-time';
import type { DateOrder } from '@/lib/clock-time';
import { timeScale } from '@/lib/formats/delimited-layout';
import type { DelimitedColumn } from '@/lib/formats/delimited-layout';
import type { TimeClock } from '@/lib/time-types';

type TimeColumn = Extract<DelimitedColumn, { role: 'time' }>;
type Format = 'elapsed' | 'unix' | 'text';

/** Whole and half hours, and the zones a quarter past. */
const ZONES = [
  ...Array.from({ length: 53 }, (_, i) => (i - 24) * 30),
  345,
  525,
  765,
].sort((a, b) => a - b);

/** What the first cell reads as, for the column's description. */
function firstClock(
  column: TimeColumn,
  cells: string[],
  number: (cell: string) => number,
): TimeClock | undefined {
  const cell = cells.find((item) => item.trim());
  if (!cell || !column.clock) return undefined;
  if (column.clock.kind === 'text') {
    const reader = new ClockTextReader(column.clock.order, column.clock.zone);
    reader.read(cell);
    return reader.clock;
  }
  const start = number(cell) * (timeScale(column.unit) ?? NaN);
  if (!Number.isFinite(start)) return undefined;
  return {
    start,
    offset:
      column.clock.zone === 'local'
        ? localOffset(Math.floor(start))
        : column.clock.zone,
  };
}

/**
 * How a time column tells time in the import dialog: elapsed time in a unit,
 * Unix time in a unit, or dates and times as text; clock time also takes the
 * zone it is read and shown in, and text its day/month order.
 */
export default function TimeFormatField({
  name,
  column,
  cells,
  units,
  number,
  onChange,
}: {
  name: string;
  column: TimeColumn;
  /** Preview cells of the column. */
  cells: string[];
  units: string[];
  number: (cell: string) => number;
  onChange: (column: TimeColumn) => void;
}) {
  const format: Format = column.clock?.kind ?? 'elapsed';
  const zone = column.clock?.zone ?? 'local';
  const order = column.clock?.kind === 'text' ? column.clock.order : 'dmy';
  const scale = timeScale(column.unit);
  const choose = (next: Format) => {
    if (next === format) return;
    const unit = scale !== undefined && column.unit ? column.unit : 's';
    onChange(
      next === 'elapsed'
        ? { role: 'time', unit }
        : next === 'unix'
          ? { role: 'time', unit, clock: { kind: 'unix', zone } }
          : {
              role: 'time',
              unit: '',
              clock: {
                kind: 'text',
                order: detectDateOrder(cells).order,
                zone,
              },
            },
    );
  };
  const filled = cells.filter((cell) => cell.trim());
  const ambiguous = format === 'text' && detectDateOrder(filled).ambiguous;
  const clock = firstClock(column, cells, number);
  const textual = filled.some((cell) => !Number.isFinite(number(cell)));
  return (
    <div
      className="unit-field time-format-field"
      data-state={
        format !== 'text' && scale === undefined ? 'unknown' : 'known'
      }
    >
      <div className="time-format-controls">
        <select
          value={format}
          aria-label={`How ${name} tells time`}
          onChange={(event) => choose(event.target.value as Format)}
        >
          <option value="elapsed" disabled={textual}>
            Elapsed time
          </option>
          <option value="unix" disabled={textual}>
            Unix time
          </option>
          <option value="text">Date and time</option>
        </select>
        {format !== 'text' && (
          <select
            value={column.unit}
            aria-label={`Time unit of ${name}`}
            aria-invalid={scale === undefined}
            onChange={(event) =>
              onChange({ ...column, unit: event.target.value })
            }
          >
            {!units.includes(column.unit) && (
              <option value={column.unit}>{column.unit}</option>
            )}
            {units.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        )}
        {format === 'text' && (ambiguous || order === 'mdy') && (
          <select
            value={order}
            aria-label={`Date order of ${name}`}
            onChange={(event) =>
              onChange({
                ...column,
                clock: {
                  kind: 'text',
                  order: event.target.value as DateOrder,
                  zone,
                },
              })
            }
          >
            <option value="dmy">Day first</option>
            <option value="mdy">Month first</option>
          </select>
        )}
        {format !== 'elapsed' && !clock?.undated && (
          <select
            value={String(zone)}
            aria-label={`Time zone of ${name}`}
            title={
              format === 'text'
                ? 'The zone of times that do not state one, and the zone times show in. Local time is this computer’s zone.'
                : 'The zone times show in. Local time is this computer’s zone.'
            }
            onChange={(event) =>
              onChange({
                ...column,
                clock: {
                  ...column.clock!,
                  zone:
                    event.target.value === 'local'
                      ? 'local'
                      : Number(event.target.value),
                },
              })
            }
          >
            <option value="local">Local time</option>
            {ZONES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatOffset(minutes)}
              </option>
            ))}
          </select>
        )}
      </div>
      <small>
        {format !== 'text' && scale === undefined ? (
          <span className="unit-field-problem">Not a unit of time</span>
        ) : format === 'elapsed' ? (
          column.unit === 's' ? null : (
            'Kept in seconds'
          )
        ) : clock ? (
          `Starts ${describeClock(clock)}`
        ) : (
          <span className="unit-field-problem">
            {format === 'text'
              ? 'The first time is not a date or time of day'
              : 'The first time is not a number'}
          </span>
        )}
        {ambiguous && (
          <span>Dates such as 10/11 could be either order; check it.</span>
        )}
      </small>
    </div>
  );
}
