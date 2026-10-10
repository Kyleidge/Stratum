/**
 * Clock time: reading dates and times of day from text, and showing axis
 * times as clock times. A `TimeClock` says when axis time 0 happened; times
 * here stay relative to it, so they keep full double precision.
 */
import type { TimeClock } from './time-types';

/** How a date with the year last orders its day and month. */
export type DateOrder = 'dmy' | 'mdy';

/** One cell: its wall-clock date and time, and the zone it states. */
export type ClockReading = {
  /** Days since 1970-01-01 of the wall-clock date; 0 when undated. */
  day: number;
  /** Seconds into that day, with the cell's full fraction. */
  seconds: number;
  /** Minutes east of UTC the cell states (Z, +01:00 …). */
  zone?: number;
  dated: boolean;
};

const DATE_TIME =
  /^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([AaPp][Mm]))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|UTC|GMT)?$/;
const TIME_OF_DAY =
  /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([AaPp][Mm]))?$/;

function timeOfDay(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  fraction: string | undefined,
  meridiem: string | undefined,
): number | undefined {
  let h = Number(hours ?? 0);
  const m = Number(minutes ?? 0);
  const s = Number(seconds ?? 0);
  if (meridiem) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (/p/i.test(meridiem) ? 12 : 0);
  }
  if (h > 23 || m > 59 || s > 59) return undefined;
  return h * 3600 + m * 60 + s + (fraction ? Number(`0.${fraction}`) : 0);
}

function zoneMinutes(zone: string | undefined): number | undefined {
  if (!zone) return undefined;
  if (/^(?:Z|UTC|GMT)$/.test(zone)) return 0;
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})?$/)!;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return minutes > 18 * 60 ? undefined : (match[1] === '-' ? -1 : 1) * minutes;
}

/**
 * Reads a date and time (ISO 8601 `2026-10-10T14:03:22.120+01:00`,
 * `2026/10/10 14:03`, `10.10.2026 14:03:22`, `10/10/2026 2:03:22 PM`), a
 * date alone (midnight) or a time of day alone (`14:03:22.120`). Years have
 * four digits; `order` settles day and month when the year comes last
 * (dots always mean day first). Undefined when the cell is none of these.
 */
export function parseClockText(
  cell: string,
  order: DateOrder = 'dmy',
): ClockReading | undefined {
  const text = cell.trim();
  const time = text.match(TIME_OF_DAY);
  if (time) {
    const seconds = timeOfDay(time[1], time[2], time[3], time[4], time[5]);
    return seconds === undefined
      ? undefined
      : { day: 0, seconds, dated: false };
  }
  const match = text.match(DATE_TIME);
  if (!match) return undefined;
  const [, a, separator, b, c] = match;
  let year: number, month: number, date: number;
  if (a.length === 4) [year, month, date] = [+a, +b, +c];
  else if (c.length === 4)
    [year, month, date] =
      separator === '.' || order === 'dmy' ? [+c, +b, +a] : [+c, +a, +b];
  else return undefined;
  if (year < 1000 || month < 1 || month > 12 || date < 1) return undefined;
  const day = Date.UTC(year, month - 1, date) / 86400000;
  // Date.UTC rolls 31 April over to 1 May; a real date round-trips.
  if (new Date(day * 86400000).getUTCDate() !== date) return undefined;
  if (match[9] && !match[5]) return undefined;
  const seconds = timeOfDay(match[5], match[6], match[7], match[8], match[9]);
  if (seconds === undefined) return undefined;
  const zone = zoneMinutes(match[10]);
  if (match[10] && zone === undefined) return undefined;
  return { day, seconds, ...(zone !== undefined ? { zone } : {}), dated: true };
}

/** True when a cell reads as a date or a time of day in either order. */
export function isClockText(cell: string) {
  return parseClockText(cell) !== undefined;
}

/**
 * The day/month order that reads every cell, preferring `fallback` when
 * both do. `ambiguous` is true when nothing in the cells settles it.
 */
export function detectDateOrder(
  cells: string[],
  fallback: DateOrder = 'dmy',
): { order: DateOrder; ambiguous: boolean } {
  const reads = (order: DateOrder) =>
    cells.every((cell) => !cell.trim() || parseClockText(cell, order));
  const dmy = reads('dmy');
  const mdy = reads('mdy');
  if (dmy && !mdy) return { order: 'dmy', ambiguous: false };
  if (mdy && !dmy) return { order: 'mdy', ambiguous: false };
  const slashed = cells.some((cell) =>
    /^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(cell.trim()),
  );
  return { order: fallback, ambiguous: slashed };
}

/** This device's UTC offset, in minutes east, at a wall-clock time. */
export function localOffset(wallSeconds: number): number {
  const guess = -new Date(wallSeconds * 1000).getTimezoneOffset();
  // Historical local mean times have fractional minutes; clocks keep whole
  // ones, and UTC is 0, never −0.
  return (
    Math.round(
      -new Date((wallSeconds - guess * 60) * 1000).getTimezoneOffset(),
    ) + 0
  );
}

/**
 * Turns the cells of one clock-time column into seconds since its first
 * cell, and records the column's clock. Cells without a zone are read in
 * `zone` (minutes east of UTC, or this device's zone at the first cell, kept
 * for the whole recording so a daylight-saving change never makes time jump).
 * Times of day without dates pass midnight when they fall back by more than
 * 12 hours.
 */
export class ClockTextReader {
  clock?: TimeClock;
  private day0 = 0;
  private seconds0 = 0;
  private zone0 = 0;
  private fixed = 0;
  private days = 0;
  private last = 0;
  constructor(
    private order: DateOrder,
    private zone: number | 'local',
  ) {}
  /** Seconds since the first cell; NaN when the cell does not read. */
  read(cell: string): number {
    const reading = parseClockText(cell, this.order);
    if (!reading) return NaN;
    if (!this.clock) {
      if (!reading.dated) {
        this.seconds0 = this.last = reading.seconds;
        this.clock = { start: reading.seconds, offset: 0, undated: true };
        return 0;
      }
      const wall = reading.day * 86400 + reading.seconds;
      this.fixed =
        this.zone === 'local' ? localOffset(Math.floor(wall)) : this.zone;
      this.day0 = reading.day;
      this.seconds0 = reading.seconds;
      this.zone0 = reading.zone ?? this.fixed;
      this.clock = {
        start: reading.day * 86400 + reading.seconds - this.zone0 * 60,
        offset: this.zone0,
      };
      return 0;
    }
    if (reading.dated === !!this.clock.undated) return NaN;
    if (!reading.dated) {
      if (reading.seconds < this.last - 43200) this.days++;
      this.last = reading.seconds;
      return this.days * 86400 + (reading.seconds - this.seconds0);
    }
    return (
      (reading.day - this.day0) * 86400 +
      (reading.seconds - this.seconds0) -
      ((reading.zone ?? this.fixed) - this.zone0) * 60
    );
  }
}

/** “UTC+01:00”, “UTC−05:30”, or “UTC”. */
export function formatOffset(minutes: number) {
  if (!minutes) return 'UTC';
  const size = Math.abs(minutes);
  return `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`;
}

/** Whole wall-clock seconds since 1970 and the fraction, at axis time t. */
function wallParts(clock: TimeClock, time: number): [number, number] {
  const base = clock.start + clock.offset * 60;
  const whole = Math.floor(base);
  const fraction = base - whole + time;
  const carry = Math.floor(fraction);
  return [whole + carry, fraction - carry];
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** Wall-clock fields of axis time t, the seconds rounded to `decimals`. */
function fields(clock: TimeClock, time: number, decimals: number) {
  const [wallWhole, fraction] = wallParts(clock, time);
  let whole = wallWhole;
  const scale = 10 ** decimals;
  let digits = Math.round(fraction * scale);
  if (digits >= scale) {
    whole += 1;
    digits = 0;
  }
  const date = new Date(whole * 1000);
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    short: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
    hours: pad(date.getUTCHours()),
    minutes: pad(date.getUTCMinutes()),
    seconds: `${pad(date.getUTCSeconds())}${decimals ? `.${pad(digits, decimals)}` : ''}`,
    midnight:
      !digits &&
      !date.getUTCHours() &&
      !date.getUTCMinutes() &&
      !date.getUTCSeconds(),
  };
}

/**
 * Axis time t as clock time, “2026-10-10 14:03:22.120” (time of day only
 * for undated clocks), with `decimals` digits of seconds.
 */
export function formatClockTime(clock: TimeClock, time: number, decimals = 3) {
  const part = fields(clock, time, decimals);
  const clockTime = `${part.hours}:${part.minutes}:${part.seconds}`;
  return clock.undated ? clockTime : `${part.date} ${clockTime}`;
}

/**
 * Axis time t as ISO 8601 with the clock's offset,
 * “2026-10-10T14:03:22.120+01:00”; undated clocks give the time of day.
 */
export function isoClockTime(clock: TimeClock, time: number, decimals = 6) {
  const part = fields(clock, time, decimals);
  const clockTime = `${part.hours}:${part.minutes}:${part.seconds}`;
  if (clock.undated) return clockTime;
  const size = Math.abs(clock.offset);
  const zone = clock.offset
    ? `${clock.offset < 0 ? '-' : '+'}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
    : 'Z';
  return `${part.date}T${clockTime}${zone}`;
}

/** “Starts 2026-10-10 14:03:22.120 (UTC+01:00)” for Details and reports. */
export function describeClock(clock: TimeClock, time = 0) {
  return clock.undated
    ? `${formatClockTime(clock, time)} (time of day; the file gives no date)`
    : `${formatClockTime(clock, time)} (${formatOffset(clock.offset)})`;
}

/** Tick steps in seconds: 1/2/5 below a second, then clock-friendly ones. */
const CLOCK_STEPS = [
  ...[-6, -5, -4, -3, -2, -1].flatMap((power) =>
    [1, 2, 5].map((factor) => factor * 10 ** power),
  ),
  1,
  2,
  5,
  10,
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  10800,
  21600,
  43200,
  86400,
  172800,
  432000,
  864000,
  1728000,
  4320000,
  8640000,
];

export type ClockTicks = {
  /** Axis times of the ticks. */
  ticks: number[];
  labels: string[];
  /** Axis title naming the zone and the first date shown. */
  title: string;
};

/**
 * Ticks at round clock times (whole seconds, minutes, hours, local
 * midnights) inside [low, high], about `target` of them. Labels show the
 * time of day, with seconds and decimals as the step needs; a tick at
 * midnight shows its date.
 */
export function clockTicks(
  clock: TimeClock,
  low: number,
  high: number,
  target = 6,
): ClockTicks {
  const span = high - low;
  const title = clock.undated
    ? 'Time of day'
    : `Clock time (${formatOffset(clock.offset)}) · ${fields(clock, low, 0).date}`;
  if (!Number.isFinite(span) || !(span > 0))
    return { ticks: [], labels: [], title };
  const wanted = Math.max(2, Math.min(20, target));
  const step =
    CLOCK_STEPS.find((candidate) => span / candidate <= wanted) ??
    CLOCK_STEPS[CLOCK_STEPS.length - 1];
  const base = clock.start + clock.offset * 60;
  const whole = Math.floor(base);
  const fraction = base - whole;
  // A wall-clock second divisible by the step, near the low end.
  const [lowWhole] = wallParts(clock, low);
  const anchor =
    step >= 1 ? lowWhole - (((lowWhole % step) + step) % step) : lowWhole;
  const anchorTime = anchor - whole - fraction;
  const first = Math.ceil((low - anchorTime) / step - 1e-9);
  const decimals = step < 1 ? Math.ceil(-Math.log10(step) - 1e-9) : 0;
  const ticks: number[] = [];
  const labels: string[] = [];
  for (let k = first; ticks.length < 100; k++) {
    const time = anchorTime + k * step;
    if (time > high + step * 1e-9) break;
    const part = fields(clock, time, decimals);
    ticks.push(time);
    labels.push(
      step >= 86400 || (part.midnight && !clock.undated)
        ? clock.undated
          ? `${part.hours}:${part.minutes}`
          : part.short
        : step < 60
          ? `${step < 1 && ticks.length > 1 ? '' : `${part.hours}:${part.minutes}:`}${part.seconds}`
          : `${part.hours}:${part.minutes}`,
    );
  }
  // Sub-second ticks after the first show only seconds unless the minute
  // changes, so long labels never collide.
  if (step < 1)
    for (let i = 1; i < ticks.length; i++) {
      const part = fields(clock, ticks[i], decimals);
      const before = fields(clock, ticks[i - 1], decimals);
      if (part.minutes !== before.minutes || part.hours !== before.hours)
        labels[i] = `${part.hours}:${part.minutes}:${part.seconds}`;
    }
  return { ticks, labels, title };
}
