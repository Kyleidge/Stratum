import type { Point, Summary } from './signal-types';
import { blockPoints } from './plot-index';
import type { PlotBlock } from './plot-index';

// Stateful RFC 4180 parser; state survives arbitrary character boundaries.
export class CsvParser {
  private field = '';
  private row: string[] = [];
  private quoted = false;
  private afterQuote = false;
  private skipLF = false;
  feed(text: string, final = false): string[][] {
    const result: string[][] = [];
    const endField = () => {
      this.row.push(this.field);
      this.field = '';
    };
    const endRow = () => {
      endField();
      if (this.row.length > 1 || this.row[0].trim()) result.push(this.row);
      this.row = [];
    };
    for (const c of text) {
      if (this.skipLF) {
        this.skipLF = false;
        if (c === '\n') continue;
      }
      if (this.afterQuote) {
        if (c === '"') {
          this.field += '"';
          this.afterQuote = false;
          continue;
        }
        this.quoted = false;
        this.afterQuote = false;
        if (c !== ',' && c !== '\r' && c !== '\n')
          throw new Error('Unexpected character after a CSV quote.');
      }
      if (this.quoted) {
        if (c === '"') this.afterQuote = true;
        else this.field += c;
      } else if (c === '"') {
        if (this.field.length)
          throw new Error('Unexpected quote in CSV field.');
        this.quoted = true;
      } else if (c === ',') endField();
      else if (c === '\r' || c === '\n') {
        endRow();
        this.skipLF = c === '\r';
      } else this.field += c;
      if (this.field.length > 65536 || this.row.length > 256)
        throw new Error(
          'CSV field or column limit exceeded (64 KB / 256 columns).',
        );
    }
    if (final) {
      if (this.quoted && !this.afterQuote)
        throw new Error('Unclosed CSV quote.');
      if (this.field.length || this.row.length) endRow();
    }
    return result;
  }
}

export function power(torque: number, rpm: number): number {
  return (torque * rpm * 2 * Math.PI) / 60000;
}
export function bsfc(fuel: number, kilowatts: number): number {
  return kilowatts > 0.1 && fuel >= 0 ? (fuel * 1000) / kilowatts : NaN;
}

export class RollingMean {
  private values: Float64Array;
  private cursor = 0;
  private total = 0;
  private valid = 0;
  constructor(size: number) {
    this.values = new Float64Array(size).fill(NaN);
  }
  next(value: number): number {
    const old = this.values[this.cursor];
    if (Number.isFinite(old)) {
      this.total -= old;
      this.valid--;
    }
    this.values[this.cursor] = value;
    if (Number.isFinite(value)) {
      this.total += value;
      this.valid++;
    }
    this.cursor = (this.cursor + 1) % this.values.length;
    return this.valid ? this.total / this.valid : NaN;
  }
}

export class Envelope {
  private buckets: {
    first: Point;
    last: Point;
    min: Point;
    max: Point;
    gap?: Point;
  }[];
  private previous?: Point;
  private total = 0;
  summary: Summary = {
    count: 0,
    min: Infinity,
    max: -Infinity,
    mean: NaN,
    integral: 0,
    start: NaN,
    end: NaN,
  };
  constructor(
    private start: number,
    private end: number,
    private width = 700,
  ) {
    this.buckets = [];
  }
  add(t: number, value: number) {
    if (t < this.start || t > this.end) return;
    const s = this.summary;
    if (!Number.isFinite(s.start)) s.start = t;
    s.end = t;
    const point: Point = [t, value];
    this.addPoint(point);
    if (Number.isFinite(value)) {
      s.count++;
      this.total += value;
      s.min = Math.min(s.min, value);
      s.max = Math.max(s.max, value);
      if (this.previous && Number.isFinite(this.previous[1]))
        s.integral += ((value + this.previous[1]) / 2) * (t - this.previous[0]);
    }
    this.previous = point;
  }
  /** Summary covers original samples; candidate points only drive the drawing. */
  addBlock(block: PlotBlock) {
    const s = this.summary;
    if (!Number.isFinite(s.start)) s.start = block.first[0];
    s.end = block.last[0];
    for (const point of blockPoints(block)) this.addPoint(point);
    s.count += block.count;
    this.total += block.total;
    if (block.count) {
      s.min = Math.min(s.min, block.min[1]);
      s.max = Math.max(s.max, block.max[1]);
    }
    if (
      this.previous &&
      Number.isFinite(this.previous[1]) &&
      Number.isFinite(block.first[1])
    )
      s.integral +=
        ((this.previous[1] + block.first[1]) / 2) *
        (block.first[0] - this.previous[0]);
    s.integral += block.integral;
    this.previous = block.last;
  }
  private addPoint(point: Point) {
    const [t, value] = point;
    const index = Math.min(
      this.width - 1,
      Math.max(
        0,
        Math.floor(
          ((t - this.start) / (this.end - this.start || 1)) * this.width,
        ),
      ),
    );
    const b = this.buckets[index];
    if (!b)
      this.buckets[index] = {
        first: point,
        last: point,
        min: point,
        max: point,
      };
    else {
      b.last = point;
      if (!Number.isFinite(value)) b.gap = point;
      else {
        if (!Number.isFinite(b.min[1]) || value < b.min[1]) b.min = point;
        if (!Number.isFinite(b.max[1]) || value > b.max[1]) b.max = point;
      }
    }
  }
  finish(): { points: Point[]; summary: Summary } {
    const points = this.buckets.flatMap((b) =>
      b
        ? [
            ...new Map(
              [b.first, b.min, b.max, ...(b.gap ? [b.gap] : []), b.last].map(
                (p) => [p[0], p],
              ),
            ).values(),
          ].sort((a, b) => a[0] - b[0])
        : [],
    );
    this.summary.mean = this.summary.count
      ? this.total / this.summary.count
      : NaN;
    if (!this.summary.count) {
      this.summary.min = NaN;
      this.summary.max = NaN;
    }
    return { points, summary: this.summary };
  }
}
