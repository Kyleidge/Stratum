import { MAX_RECORDING_CHANNELS } from './formats/recording';

/**
 * Plain-language CSV import messages. Each names the cause and, where it
 * helps, the expected format; the engine prefixes the file name.
 */
export const CSV_FORMAT_EXAMPLE = 'Time [s],Speed [rpm],Torque [Nm]';
const FORMAT_HINT = `The first row holds headers such as ${CSV_FORMAT_EXAMPLE}, with time in the first column (seconds, or dates and times).`;
const CANCELLED = 'Operation cancelled.';

function quote(text: string) {
  const trimmed = text.trim();
  return `“${trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed}”`;
}

/** Validates the header row; returns a message for the first problem. */
export function headerProblem(headers: string[]): string | undefined {
  if (headers.length === 1)
    return `The header row has only one column. Separate columns with commas, semicolons or tabs. ${FORMAT_HINT}`;
  if (headers.length > MAX_RECORDING_CHANNELS + 1)
    return `The header row has ${headers.length.toLocaleString()} columns; a recording can have time and at most ${MAX_RECORDING_CHANNELS.toLocaleString()} signals.`;
  const empty = headers.findIndex((header) => !header);
  if (empty >= 0)
    return `Column ${empty + 1} has no header. Give every column a name, such as Torque [Nm].`;
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header))
      return `The header ${quote(header)} appears more than once. Each column needs a unique name.`;
    seen.add(header);
  }
  return undefined;
}

/** True when a cell looks like a calendar date or a clock time. */
function looksLikeDate(cell: string) {
  return (
    /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(cell) ||
    /^\d{1,2}:\d{2}/.test(cell) ||
    /\d[T ]\d{1,2}:\d{2}/.test(cell)
  );
}

/**
 * Row numbers count the header as row 1, as spreadsheets do. `column` names
 * the time column when a file has several; `scale` is seconds per unit;
 * `clock` is how the column tells clock time, if it does.
 */
export function timeProblem(
  row: number,
  cell: string,
  previous: number,
  column?: string,
  scale = 1,
  clock?: 'text' | 'unix',
): string {
  const text = cell.trim();
  const where = column ? `Row ${row}, column ${quote(column)}` : `Row ${row}`;
  const unit = scale === 1 ? 's' : 'units';
  if (!text)
    return `${where}: the time cell is empty. Every row needs a time${column || clock ? ' where its signals have values' : ' in seconds'}.`;
  if (clock === 'text')
    return looksLikeDate(text)
      ? `${where}: time ${quote(text)} does not come after the previous row’s time, or is not a real date and time. Times must increase from row to row; check the day and month order.`
      : `${where}: time ${quote(text)} is not a date and time. Use dates such as 2026-10-10 14:03:22.120 or times of day such as 14:03:22.`;
  if (looksLikeDate(text))
    return `${where}: time ${quote(text)} is a date or clock time, but the column is read as elapsed time. Read it as “Date and time” instead.`;
  const value = Number(text);
  if (!Number.isFinite(value))
    return /^-?\d+,\d+$/.test(text)
      ? `${where}: time ${quote(text)} uses a decimal comma. Use a decimal point (0.5).`
      : `${where}: time ${quote(text)} is not a number.`;
  if (clock === 'unix')
    return `${where}: time ${value.toLocaleString()} does not come after the previous time. Times must increase from row to row.`;
  return `${where}: time ${value.toLocaleString()}${unit === 's' ? ' s' : ''} does not come after the previous time ${previous.toLocaleString()}${unit === 's' ? ' s' : ''}. Times must increase from row to row.`;
}

/** Binary formats count samples from 1 within a named table. */
export function sampleTimeProblem(
  table: string,
  sample: number,
  time: number,
  previous: number,
) {
  const where = `${table ? `${table}, s` : 'S'}ample ${sample.toLocaleString()}`;
  return Number.isFinite(time)
    ? `${where}: time ${time.toLocaleString()} s does not come after the previous time ${previous.toLocaleString()} s. Times must increase from sample to sample.`
    : `${where} has no valid time.`;
}

export function valueProblem(row: number, header: string, cell: string) {
  return `Row ${row}, column ${quote(header)}: ${quote(cell)} is not a number. Use a decimal point, and leave missing values empty.`;
}

export function columnCountProblem(
  row: number,
  expected: number,
  received: number,
) {
  return `Row ${row} has ${received.toLocaleString()} ${received === 1 ? 'column' : 'columns'}, but the header row has ${expected.toLocaleString()}.`;
}

/** Names the file; cancellation and already-named messages pass through. */
export function importError(error: unknown, fileName: string): unknown {
  if (!(error instanceof Error) || error.message.startsWith(CANCELLED))
    return error;
  if (error.message.startsWith(`${fileName}: `)) return error;
  const message =
    error instanceof TypeError && /utf-?8|encod/i.test(error.message)
      ? 'The file is not UTF-8 text. Save it as “CSV UTF-8” and import it again.'
      : error.message;
  return new Error(`${fileName}: ${message}`);
}
