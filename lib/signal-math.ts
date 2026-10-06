import type { Point, Summary } from './signal-types';
import { blockPoints } from './plot-index';
import type { PlotBlock } from './plot-index';

// Stateful RFC 4180 parser; state survives arbitrary character boundaries.
export class CsvParser {
  /** Commas by default; semicolons, tabs or bars for other delimited text. */
  constructor(private delimiter = ',') {}
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
        if (c !== this.delimiter && c !== '\r' && c !== '\n')
          throw new Error('Unexpected character after a CSV quote.');
      }
      if (this.quoted) {
        if (c === '"') this.afterQuote = true;
        else this.field += c;
      } else if (c === '"') {
        if (this.field.length)
          throw new Error('Unexpected quote in CSV field.');
        this.quoted = true;
      } else if (c === this.delimiter) endField();
      else if (c === '\r' || c === '\n') {
        endRow();
        this.skipLF = c === '\r';
      } else this.field += c;
      if (this.field.length > 65536 || this.row.length > 1025)
        throw new Error(
          'CSV field or column limit exceeded (64 KB / 1,025 columns).',
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
  /** The running sum carries rounding from every earlier sample. */
  state(): [total: number, valid: number] {
    return [this.total, this.valid];
  }
  /** Resume after `history`: the last min(size, consumed) inputs, oldest first. */
  restore(history: ArrayLike<number>, total: number, valid: number) {
    fillRing(this.values, history);
    this.cursor = history.length % this.values.length;
    this.total = total;
    this.valid = valid;
  }
}

/** Ring contents after consuming `history` from an empty, NaN-filled ring. */
export function fillRing(ring: Float64Array, history: ArrayLike<number>) {
  ring.fill(NaN);
  const count = Math.min(ring.length, history.length);
  for (let k = 1; k <= count; k++)
    ring[(history.length - k) % ring.length] = history[history.length - k];
}

// Bucket fields: first, last, min, max and gap as (time, value) pairs.
const FIRST = 0,
  LAST = 2,
  MIN = 4,
  MAX = 6,
  GAP = 8,
  FIELDS = 10;

/** Bounded min/max drawing envelope with an exact summary of added samples. */
export class Envelope {
  // Typed buckets: adding a sample allocates nothing.
  private buckets: Float64Array;
  private flags: Uint8Array; // 1: present, 2: has a gap point
  private previousTime = NaN;
  private previousValue = NaN;
  private hasPrevious = false;
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
    this.buckets = new Float64Array(width * FIELDS);
    this.flags = new Uint8Array(width);
  }
  add(t: number, value: number) {
    if (t < this.start || t > this.end) return;
    const s = this.summary;
    if (!Number.isFinite(s.start)) s.start = t;
    s.end = t;
    this.addPoint(t, value);
    if (Number.isFinite(value)) {
      s.count++;
      this.total += value;
      s.min = Math.min(s.min, value);
      s.max = Math.max(s.max, value);
      if (this.hasPrevious && Number.isFinite(this.previousValue))
        s.integral +=
          ((value + this.previousValue) / 2) * (t - this.previousTime);
    }
    this.previousTime = t;
    this.previousValue = value;
    this.hasPrevious = true;
  }
  /** Summary covers original samples; candidate points only drive the drawing. */
  addBlock(block: PlotBlock) {
    const s = this.summary;
    if (!Number.isFinite(s.start)) s.start = block.first[0];
    s.end = block.last[0];
    for (const point of blockPoints(block)) this.addPoint(point[0], point[1]);
    s.count += block.count;
    this.total += block.total;
    if (block.count) {
      s.min = Math.min(s.min, block.min[1]);
      s.max = Math.max(s.max, block.max[1]);
    }
    if (
      this.hasPrevious &&
      Number.isFinite(this.previousValue) &&
      Number.isFinite(block.first[1])
    )
      s.integral +=
        ((this.previousValue + block.first[1]) / 2) *
        (block.first[0] - this.previousTime);
    s.integral += block.integral;
    this.previousTime = block.last[0];
    this.previousValue = block.last[1];
    this.hasPrevious = true;
  }
  private addPoint(t: number, value: number) {
    const index = Math.min(
      this.width - 1,
      Math.max(
        0,
        Math.floor(
          ((t - this.start) / (this.end - this.start || 1)) * this.width,
        ),
      ),
    );
    const b = this.buckets,
      o = index * FIELDS;
    if (!this.flags[index]) {
      this.flags[index] = 1;
      for (const field of [FIRST, LAST, MIN, MAX]) {
        b[o + field] = t;
        b[o + field + 1] = value;
      }
      return;
    }
    b[o + LAST] = t;
    b[o + LAST + 1] = value;
    if (!Number.isFinite(value)) {
      b[o + GAP] = t;
      b[o + GAP + 1] = value;
      this.flags[index] |= 2;
    } else {
      if (!Number.isFinite(b[o + MIN + 1]) || value < b[o + MIN + 1]) {
        b[o + MIN] = t;
        b[o + MIN + 1] = value;
      }
      if (!Number.isFinite(b[o + MAX + 1]) || value > b[o + MAX + 1]) {
        b[o + MAX] = t;
        b[o + MAX + 1] = value;
      }
    }
  }
  finish(): { points: Point[]; summary: Summary } {
    const points: Point[] = [];
    for (let index = 0; index < this.width; index++) {
      const flags = this.flags[index];
      if (!flags) continue;
      const o = index * FIELDS;
      // One point per distinct sample time, in time order.
      const candidates = new Map<number, number>();
      for (const field of flags & 2
        ? [FIRST, MIN, MAX, GAP, LAST]
        : [FIRST, MIN, MAX, LAST])
        candidates.set(this.buckets[o + field], this.buckets[o + field + 1]);
      points.push(
        ...[...candidates]
          .map(([time, value]): Point => [time, value])
          .sort((a, b) => a[0] - b[0]),
      );
    }
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
