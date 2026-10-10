/**
 * How the columns of a delimited text file become recordings. Each column is
 * a time axis, a signal on one of the time axes, or skipped; every time axis
 * with signals becomes one table (one recording). The importer suggests a
 * layout and the import dialog lets the user change it; the reader validates
 * whatever it is given.
 */
import { describeUnit, unitConversion } from '../units';
import { detectDateOrder, isClockText } from '../clock-time';
import type { DateOrder } from '../clock-time';
import type { RecordingChannel } from './recording';

/**
 * A time column that tells clock time. `zone` reads text without a stated
 * zone and sets the zone times show in: minutes east of UTC, or 'local' for
 * this device's zone.
 */
export type ClockFormat =
  /** Dates and/or times of day as text; `order` settles 10/11/2026. */
  | { kind: 'text'; order: DateOrder; zone: number | 'local' }
  /** Numbers in the column's unit of time since 1970-01-01 UTC. */
  | { kind: 'unix'; zone: number | 'local' };

export type DelimitedColumn =
  /**
   * A time axis; `unit` is a unit of time ('' means seconds). Without
   * `clock` it holds elapsed time from an unknown start.
   */
  | { role: 'time'; unit: string; clock?: ClockFormat }
  /** A signal sampled on the time axis in column `time`. */
  | { role: 'signal'; time: number }
  | { role: 'skip' };
export type DelimitedLayout = DelimitedColumn[];

/** What the import dialog shows of a delimited file before importing. */
export type DelimitedPreview = {
  /** Each column's header split into name and unit ('—' when none). */
  headers: RecordingChannel[];
  /** The first data rows as text, for a preview. */
  rows: string[][];
  /** False for columns with text in the preview rows. */
  numeric: boolean[];
  /** The layout Stratum suggests for this file. */
  suggested: DelimitedLayout;
};

/** One table of a layout: its time column and signal columns. */
export type LayoutTable = { time: number; signals: number[] };

/** Time axes that have signals, in column order, with their signals. */
export function layoutTables(layout: DelimitedLayout): LayoutTable[] {
  return layout.flatMap((column, time) =>
    column.role === 'time'
      ? (() => {
          const signals = layout.flatMap((item, index) =>
            item.role === 'signal' && item.time === time ? [index] : [],
          );
          return signals.length ? [{ time, signals }] : [];
        })()
      : [],
  );
}

/** Seconds per unit of a time column, or undefined for other units. */
export function timeScale(unit: string): number | undefined {
  if (!unit.trim() || unit === '—') return 1;
  const conversion = unitConversion(unit, 's');
  return conversion &&
    conversion.offset === 0 &&
    describeUnit(unit)?.quantity === 'Time'
    ? conversion.factor
    : undefined;
}

/** A plain-language problem with a layout, or undefined when it is usable. */
export function layoutProblem(
  headers: RecordingChannel[],
  layout: DelimitedLayout,
): string | undefined {
  if (!Array.isArray(layout) || layout.length !== headers.length)
    return 'The column settings do not match the file’s columns.';
  for (const [index, column] of layout.entries()) {
    const name = `“${headers[index].name}”`;
    if (column?.role === 'time') {
      const clock = column.clock;
      if (clock !== undefined && clockFormatProblem(clock))
        return `Time column ${name}: ${clockFormatProblem(clock)}`;
      if (
        clock?.kind !== 'text' &&
        (typeof column.unit !== 'string' ||
          timeScale(column.unit) === undefined)
      )
        return `Time column ${name} is in ${column.unit}, which is not a unit of time. Choose s, ms, min or another unit of time.`;
    } else if (column?.role === 'signal') {
      if (
        !Number.isInteger(column.time) ||
        layout[column.time]?.role !== 'time'
      )
        return `Choose a time axis for ${name}.`;
    } else if (column?.role !== 'skip')
      return `Column ${name} has an unknown role.`;
  }
  if (!layoutTables(layout).length)
    return 'Choose at least one signal column and the time axis it uses.';
  return undefined;
}

function clockFormatProblem(clock: ClockFormat): string | undefined {
  if (!clock || typeof clock !== 'object') return 'unknown time format.';
  if (clock.kind !== 'text' && clock.kind !== 'unix')
    return 'unknown time format.';
  if (clock.kind === 'text' && clock.order !== 'dmy' && clock.order !== 'mdy')
    return 'choose day/month or month/day.';
  if (
    clock.zone !== 'local' &&
    (!Number.isInteger(clock.zone) || Math.abs(clock.zone) > 18 * 60)
  )
    return 'choose a time zone.';
  return undefined;
}

/** Names that read as a time axis: Time, t2, ECU time, Time_B, Zeit … */
const TIME_NAME =
  /^(?:[a-z0-9]{1,10}[\s_.-]+)?(?:time|zeit|timestamp|datetime|date|datum|t)(?:[\s_.-]+[a-z0-9]{1,10}|\d+)?$/i;
/** Names of Unix-time columns: Unix time, epoch_ms, POSIX … */
const UNIX_NAME = /\b(?:unix|epoch|posix)|(?:^|_)(?:unix|epoch|posix)/i;
/** Unix seconds from 2000 to 2100: elapsed times never run that long. */
const UNIX_RANGE = [946684800, 4102444800];

/**
 * How a time column's preview cells tell time: elapsed numbers, Unix time
 * or clock text. `unit` is the column's unit, as for elapsed time.
 */
export function suggestClock(
  name: string,
  unit: string,
  cells: string[],
  numbers: (cell: string) => number,
  fallback: DateOrder = 'dmy',
): { unit: string; clock?: ClockFormat } | undefined {
  const filled = cells.map((cell) => cell.trim()).filter(Boolean);
  if (!filled.length) return undefined;
  // “Time [UTC]” names the zone of text without one.
  const zone = /^(?:UTC|GMT|Z)$/i.test(unit) ? 0 : 'local';
  if (filled.every(isClockText))
    return {
      unit: '',
      clock: {
        kind: 'text',
        order: detectDateOrder(filled, fallback).order,
        zone,
      },
    };
  if (!filled.every((cell) => Number.isFinite(numbers(cell)))) return undefined;
  const first = numbers(filled[0]);
  const inRange = (scale: number) =>
    first * scale >= UNIX_RANGE[0] && first * scale <= UNIX_RANGE[1];
  const stated = unit === '—' ? undefined : timeScale(unit);
  if (stated !== undefined && unit !== '—')
    return UNIX_NAME.test(name) || inRange(stated)
      ? { unit, clock: { kind: 'unix', zone: 'local' } }
      : { unit };
  for (const [scaleUnit, scale] of [
    ['s', 1],
    ['ms', 1e-3],
    ['µs', 1e-6],
    ['ns', 1e-9],
  ] as const)
    if (inRange(scale))
      return { unit: scaleUnit, clock: { kind: 'unix', zone: 'local' } };
  return UNIX_NAME.test(name)
    ? { unit: 's', clock: { kind: 'unix', zone: 'local' } }
    : { unit: 's' };
}

/**
 * The layout to start from. The first column is always a time axis, as
 * before. A later column is another time axis only when its name reads as
 * time, its unit (if any) is a unit of time and its preview values strictly
 * increase; signals use the nearest time axis to their left. Columns with
 * text in the preview are skipped, except dates and times of day, which make
 * clock-time axes; so do numbers that can only be Unix time.
 */
export function suggestLayout(
  headers: RecordingChannel[],
  rows: string[][],
  numbers: (cell: string) => number,
  order: DateOrder = 'dmy',
): DelimitedLayout {
  const numeric = headers.map((_, c) =>
    rows.every((row) => {
      const cell = row[c]?.trim() ?? '';
      return !cell || Number.isFinite(numbers(cell));
    }),
  );
  const increasing = (c: number) => {
    const values = rows
      .map((row) => row[c]?.trim() ?? '')
      .filter(Boolean)
      .map(numbers);
    return (
      values.length >= 2 &&
      values.every((value, i) => !i || value > values[i - 1])
    );
  };
  const cells = (c: number) => rows.map((row) => row[c] ?? '');
  const clockText = (c: number) =>
    !numeric[c] &&
    cells(c).some((cell) => cell.trim()) &&
    cells(c).every((cell) => !cell.trim() || isClockText(cell));
  const timeColumn = (c: number): DelimitedColumn => {
    const header = headers[c];
    const suggestion = suggestClock(
      header.name,
      header.unit,
      cells(c),
      numbers,
      order,
    );
    return {
      role: 'time',
      unit:
        suggestion?.clock?.kind === 'text'
          ? ''
          : header.unit === '—'
            ? (suggestion?.unit ?? 's')
            : header.unit,
      ...(suggestion?.clock ? { clock: suggestion.clock } : {}),
    };
  };
  let time = 0;
  return headers.map((header, c): DelimitedColumn => {
    if (c === 0) return timeColumn(0);
    if (
      TIME_NAME.test(header.name) &&
      (clockText(c) ||
        (numeric[c] &&
          (header.unit === '—' || timeScale(header.unit) !== undefined) &&
          increasing(c)))
    ) {
      time = c;
      return timeColumn(c);
    }
    return numeric[c] ? { role: 'signal', time } : { role: 'skip' };
  });
}
