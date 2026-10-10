/**
 * How the columns of a delimited text file become recordings. Each column is
 * a time axis, a signal on one of the time axes, or skipped; every time axis
 * with signals becomes one table (one recording). The importer suggests a
 * layout and the import dialog lets the user change it; the reader validates
 * whatever it is given.
 */
import { describeUnit, unitConversion } from '../units';
import type { RecordingChannel } from './recording';

export type DelimitedColumn =
  /** A time axis; `unit` is a unit of time ('' means seconds). */
  | { role: 'time'; unit: string }
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
      if (
        typeof column.unit !== 'string' ||
        timeScale(column.unit) === undefined
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

/** Names that read as a time axis: Time, t2, ECU time, Time_B, Zeit … */
const TIME_NAME =
  /^(?:[a-z0-9]{1,10}[\s_.-]+)?(?:time|zeit|timestamp|t)(?:[\s_.-]+[a-z0-9]{1,10}|\d+)?$/i;

/**
 * The layout to start from. The first column is always a time axis, as
 * before. A later column is another time axis only when its name reads as
 * time, its unit (if any) is a unit of time and its preview values strictly
 * increase; signals use the nearest time axis to their left. Columns with
 * text in the preview are skipped.
 */
export function suggestLayout(
  headers: RecordingChannel[],
  rows: string[][],
  numbers: (cell: string) => number,
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
  let time = 0;
  return headers.map((header, c): DelimitedColumn => {
    if (c === 0)
      return { role: 'time', unit: header.unit === '—' ? 's' : header.unit };
    if (
      numeric[c] &&
      TIME_NAME.test(header.name) &&
      (header.unit === '—' || timeScale(header.unit) !== undefined) &&
      increasing(c)
    ) {
      time = c;
      return { role: 'time', unit: header.unit === '—' ? 's' : header.unit };
    }
    return numeric[c] ? { role: 'signal', time } : { role: 'skip' };
  });
}
