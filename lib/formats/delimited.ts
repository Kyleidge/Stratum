/**
 * Delimited text recordings: CSV, semicolon CSV with decimal commas, TSV and
 * tab- or bar-separated .txt. The first row holds headers. By default the
 * first column is time; a layout (`delimited-layout.ts`) can name several
 * time columns, each with its own unit of time and signals, and skip others.
 * Messages name the row and cause of problems.
 */
import { CsvParser } from '../signal-math';
import {
  columnCountProblem,
  headerProblem,
  timeProblem,
  valueProblem,
} from '../csv-import-messages';
import {
  layoutProblem,
  layoutTables,
  suggestLayout,
  timeScale,
} from './delimited-layout';
import type { DelimitedLayout } from './delimited-layout';
import { headerChannel } from './recording';
import type { RecordingBlock, RecordingFile } from './recording';

const SLICE = 262144;
/** Rows read from the start of the file to suggest a layout. */
const PREVIEW_ROWS = 200;
/** Rows the import dialog shows. */
const SHOWN_ROWS = 5;
const DELIMITERS = [',', ';', '\t', '|'] as const;
type Delimiter = (typeof DELIMITERS)[number];
const DELIMITER_NAMES: Record<Delimiter, string> = {
  ',': 'Comma-separated',
  ';': 'Semicolon-separated',
  '\t': 'Tab-separated',
  '|': 'Bar-separated',
};

type Encoding = { label: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' };

/** UTF-16 needs its byte-order mark; other text is UTF-8 unless it can't be. */
function encodingOf(head: Uint8Array): Encoding {
  if (head[0] === 0xff && head[1] === 0xfe) return { label: 'utf-16le' };
  if (head[0] === 0xfe && head[1] === 0xff) return { label: 'utf-16be' };
  try {
    // A character split by the sample boundary is not an encoding error.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return { label: 'utf-8' };
  } catch {
    return { label: 'windows-1252' };
  }
}

/** Counts delimiters outside quotes in the header line. */
export function detectDelimiter(line: string): Delimiter {
  const counts = new Map<Delimiter, number>();
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (DELIMITERS as readonly string[]).includes(c))
      counts.set(c as Delimiter, (counts.get(c as Delimiter) ?? 0) + 1);
  }
  let best: Delimiter = ',';
  for (const delimiter of DELIMITERS)
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0))
      best = delimiter;
  return best;
}

/** Decimal commas are read only when commas cannot separate columns. */
function parseNumber(cell: string, decimalComma: boolean) {
  const text = cell.trim();
  if (!text) return NaN;
  return Number(
    decimalComma && /^[+-]?\d*,\d+(?:[eE][+-]?\d+)?$/.test(text)
      ? text.replace(',', '.')
      : text,
  );
}

export async function openDelimited(
  file: Blob & { name?: string },
  layout?: DelimitedLayout,
): Promise<RecordingFile> {
  const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const { label } = encodingOf(sample);
  const text = new TextDecoder(label).decode(sample, { stream: true });
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n|\r/, 1)[0];
  const tabbed = /\.(tsv|tab)$/i.test(file.name ?? '');
  const delimiter: Delimiter = tabbed ? '\t' : detectDelimiter(firstLine);
  const [record] = new CsvParser(delimiter).feed(`${firstLine}\n`, true);
  const raw = (record ?? ['']).map((cell) => cell.trim());
  const problem = headerProblem(raw);
  if (problem) throw new Error(problem);
  const decimalComma = delimiter !== ',';
  const number = (cell: string) => parseNumber(cell, decimalComma);
  const headers = raw.map(headerChannel);
  // The sample's last line may be cut short, so it is left out.
  const rows = new CsvParser(delimiter)
    .feed(text.replace(/^\uFEFF/, ''))
    .slice(1, PREVIEW_ROWS + 1)
    .filter((cells) => cells.length === raw.length);
  const suggested = suggestLayout(headers, rows, number);
  const columns = layout ?? suggested;
  // A chosen layout must be usable; a suggested one is shown to be fixed and
  // only stops reading (batch runs).
  const layoutIssue = layoutProblem(headers, columns);
  if (layoutIssue && layout) throw new Error(layoutIssue);
  const tables = layoutTables(columns);
  const notes = [
    ...(label === 'windows-1252'
      ? [
          'The file is not UTF-8, so it was read as Windows-1252 (Latin-1) text.',
        ]
      : []),
    ...(layout
      ? []
      : columns.flatMap((column, c) =>
          column.role === 'skip'
            ? [`Column “${raw[c]}” holds text, so it was not imported.`]
            : [],
        )),
  ];

  async function* read(index: number): AsyncGenerator<RecordingBlock> {
    const table = tables[index];
    if (layoutIssue) throw new Error(layoutIssue);
    if (!table) throw new Error('The file has no such group.');
    const parser = new CsvParser(delimiter);
    const decoder = new TextDecoder(label, { fatal: label === 'utf-8' });
    const width = raw.length;
    const scale = timeScale((columns[table.time] as { unit: string }).unit)!;
    const timeName = tables.length > 1 ? raw[table.time] : undefined;
    let header = true;
    let line = 1;
    let end = -Infinity;
    let times: number[] = [];
    let values: number[][] = table.signals.map(() => []);
    const consume = (records: string[][]) => {
      for (const cells of records) {
        if (header) {
          header = false;
          continue;
        }
        line++;
        if (cells.length !== width)
          throw new Error(columnCountProblem(line, width, cells.length));
        const timeCell = cells[table.time];
        // A shorter time axis leaves its rows empty below its last sample.
        if (
          !timeCell.trim() &&
          tables.length > 1 &&
          table.signals.every((c) => !cells[c].trim())
        )
          continue;
        const t = number(timeCell) * scale;
        if (!Number.isFinite(t) || t <= end)
          throw new Error(
            timeProblem(line, timeCell, end / scale, timeName, scale),
          );
        end = t;
        times.push(t);
        table.signals.forEach((c, k) => {
          const value = number(cells[c]);
          if (cells[c].trim() && !Number.isFinite(value))
            throw new Error(valueProblem(line, raw[c], cells[c]));
          values[k].push(value);
        });
      }
    };
    const block = (progress: number): RecordingBlock => {
      const result = {
        time: Float64Array.from(times),
        values: values.map((column) => Float64Array.from(column)),
        progress,
      };
      times = [];
      values = table.signals.map(() => []);
      return result;
    };
    // Blob slices bound decoded input even if a stream emits huge chunks.
    for (let offset = 0; offset < file.size; offset += SLICE) {
      const bytes = await file.slice(offset, offset + SLICE).arrayBuffer();
      const chunk = decoder.decode(bytes, { stream: true });
      consume(parser.feed(offset ? chunk : chunk.replace(/^\uFEFF/, '')));
      if (times.length) yield block((offset + bytes.byteLength) / file.size);
    }
    consume(parser.feed(decoder.decode(), true));
    if (times.length) yield block(1);
  }

  return {
    format: `${DELIMITER_NAMES[delimiter]} text`,
    tables: tables.map((table) => ({
      name: tables.length > 1 ? headers[table.time].name : '',
      channels: table.signals.map((c) => headers[c]),
    })),
    ...(notes.length ? { notes } : {}),
    columns: {
      headers,
      rows: rows.slice(0, SHOWN_ROWS),
      numeric: suggested.map((column, c) =>
        rows.every((row) => !row[c].trim() || Number.isFinite(number(row[c]))),
      ),
      suggested,
    },
    layout: columns,
    read,
  };
}
