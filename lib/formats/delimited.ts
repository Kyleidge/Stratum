/**
 * Delimited text recordings: CSV, semicolon CSV with decimal commas, TSV and
 * tab- or bar-separated .txt. The first row holds headers and the first
 * column holds time in seconds; messages name the row and cause of problems.
 */
import { CsvParser } from '../signal-math';
import {
  columnCountProblem,
  headerProblem,
  timeProblem,
  valueProblem,
} from '../csv-import-messages';
import { headerChannel } from './recording';
import type { RecordingBlock, RecordingFile } from './recording';

const SLICE = 262144;
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
): Promise<RecordingFile> {
  const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const { label } = encodingOf(sample);
  const text = new TextDecoder(label).decode(sample, { stream: true });
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n|\r/, 1)[0];
  const tabbed = /\.(tsv|tab)$/i.test(file.name ?? '');
  const delimiter: Delimiter = tabbed ? '\t' : detectDelimiter(firstLine);
  const [record] = new CsvParser(delimiter).feed(`${firstLine}\n`, true);
  const headers = (record ?? ['']).map((cell) => cell.trim());
  const problem = headerProblem(headers);
  if (problem) throw new Error(problem);
  const decimalComma = delimiter !== ',';
  const encodingNote =
    label === 'windows-1252'
      ? [
          'The file is not UTF-8, so it was read as Windows-1252 (Latin-1) text.',
        ]
      : [];

  async function* read(): AsyncGenerator<RecordingBlock> {
    const parser = new CsvParser(delimiter);
    const decoder = new TextDecoder(label, { fatal: label === 'utf-8' });
    const width = headers.length;
    let header = true;
    let rows = 0;
    let end = -Infinity;
    let times: number[] = [];
    let columns: number[][] = headers.slice(1).map(() => []);
    const consume = (records: string[][]) => {
      for (const cells of records) {
        if (header) {
          header = false;
          continue;
        }
        if (cells.length !== width)
          throw new Error(columnCountProblem(rows + 2, width, cells.length));
        const t = parseNumber(cells[0], decimalComma);
        if (!Number.isFinite(t) || t <= end)
          throw new Error(timeProblem(rows + 2, cells[0], end));
        end = t;
        times.push(t);
        for (let c = 1; c < width; c++) {
          const value = parseNumber(cells[c], decimalComma);
          if (cells[c].trim() && !Number.isFinite(value))
            throw new Error(valueProblem(rows + 2, headers[c], cells[c]));
          columns[c - 1].push(value);
        }
        rows++;
      }
    };
    const block = (progress: number): RecordingBlock => {
      const result = {
        time: Float64Array.from(times),
        values: columns.map((column) => Float64Array.from(column)),
        progress,
      };
      times = [];
      columns = headers.slice(1).map(() => []);
      return result;
    };
    // Blob slices bound decoded input even if a stream emits huge chunks.
    for (let offset = 0; offset < file.size; offset += SLICE) {
      const bytes = await file.slice(offset, offset + SLICE).arrayBuffer();
      const chunk = decoder.decode(bytes, { stream: true });
      consume(parser.feed(offset ? chunk : chunk.replace(/^﻿/, '')));
      if (times.length) yield block((offset + bytes.byteLength) / file.size);
    }
    consume(parser.feed(decoder.decode(), true));
    if (times.length) yield block(1);
  }

  return {
    format: `${DELIMITER_NAMES[delimiter]} text`,
    tables: [{ name: '', channels: headers.slice(1).map(headerChannel) }],
    ...(encodingNote.length ? { notes: encodingNote } : {}),
    read,
  };
}
