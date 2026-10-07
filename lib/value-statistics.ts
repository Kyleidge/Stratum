import { CrossingDetector } from './segmentation';
import {
  valueParameters,
  valueSpec,
  type ValueOperation,
  type ValueParameters,
  type ValueStatistics,
} from './workflow-types';

const finite = (value: number) => (Number.isFinite(value) ? value : null);

/**
 * One streaming pass over an input's samples that produces every value
 * statistic, plus the result of one parameterised calculation. Missing
 * samples are excluded and break adjacency: no interval spans a gap.
 */
export class ValueAccumulator {
  private count = 0;
  private mean = 0;
  private squares = 0;
  /** Welford's running sum of squared deviations. */
  private deviation = 0;
  private minimum = Infinity;
  private maximum = -Infinity;
  private minimumTime = 0;
  private maximumTime = 0;
  private duration = 0;
  private area = 0;
  private first?: [number, number];
  private last?: [number, number];
  private previous?: [number, number];
  private readonly parameters: ValueParameters;
  private readonly crossings?: CrossingDetector;
  private crossingCount = 0;
  private firstCrossing?: number;
  private beyond = 0;
  private at?: number;
  constructor(
    readonly inputId: string,
    /** The input's time bounds; elapsed times are measured from `start`. */
    private readonly start: number,
    private readonly end: number,
    private readonly operation?: ValueOperation,
    parameters?: ValueParameters,
  ) {
    const spec = operation ? valueSpec(operation) : undefined;
    this.parameters = spec?.parameters?.length
      ? valueParameters(operation!, parameters)
      : {};
    if (operation === 'first-crossing' || operation === 'crossing-count')
      this.crossings = new CrossingDetector({
        edge: this.parameters.edge === -1 ? 'falling' : 'rising',
        threshold: this.parameters.threshold!,
        hysteresis: this.parameters.hysteresis,
        debounce: this.parameters.debounce,
      });
  }
  add(time: number, value: number) {
    if (this.crossings) {
      const event = this.crossings.next(time, value);
      if (event?.kind === 'crossing') {
        this.crossingCount++;
        this.firstCrossing ??= event.time;
      }
    }
    if (!Number.isFinite(value)) {
      this.previous = undefined;
      return;
    }
    const count = ++this.count;
    const delta = value - this.mean;
    this.mean = this.mean * ((count - 1) / count) + value / count;
    this.deviation += delta * (value - this.mean);
    this.squares =
      this.squares * ((count - 1) / count) + (value * value) / count;
    if (value < this.minimum) {
      this.minimum = value;
      this.minimumTime = time;
    }
    if (value > this.maximum) {
      this.maximum = value;
      this.maximumTime = time;
    }
    this.first ??= [time, value];
    this.last = [time, value];
    const previous = this.previous;
    if (previous && time > previous[0]) {
      const dt = time - previous[0];
      this.area += (previous[1] / 2 + value / 2) * dt;
      this.duration += dt;
      if (this.operation === 'time-above' || this.operation === 'time-below')
        this.beyond += this.timeBeyond(previous, [time, value]);
    }
    if (this.operation === 'value-at' && this.at === undefined) {
      const target = this.start + this.parameters.time!;
      if (time === target) this.at = value;
      else if (previous && previous[0] < target && target < time)
        this.at =
          previous[1] +
          ((value - previous[1]) * (target - previous[0])) /
            (time - previous[0]);
    }
    this.previous = [time, value];
  }
  /** Seconds of one valid interval strictly beyond the threshold. */
  private timeBeyond(a: [number, number], b: [number, number]) {
    const level = this.parameters.threshold!;
    const sign = this.operation === 'time-above' ? 1 : -1;
    const da = sign * (a[1] - level),
      db = sign * (b[1] - level);
    const dt = b[0] - a[0];
    if (da > 0 && db > 0) return dt;
    if (da <= 0 && db <= 0) return 0;
    // One end beyond: the share past the linearly interpolated crossing.
    return (dt * Math.max(da, db)) / Math.abs(db - da);
  }
  finish(): ValueStatistics {
    const count = this.count;
    const statistics: ValueStatistics = {
      inputId: this.inputId,
      sampleCount: count,
      validDuration: this.duration,
      sampleAverage: count ? finite(this.mean) : null,
      timeAverage: this.duration > 0 ? finite(this.area / this.duration) : null,
      minimum: finite(this.minimum),
      maximum: finite(this.maximum),
      ...(count
        ? { minimumTime: this.minimumTime, maximumTime: this.maximumTime }
        : {}),
      rms: count ? finite(Math.sqrt(this.squares)) : null,
      standardDeviation:
        count > 1
          ? finite(Math.sqrt(Math.max(0, this.deviation) / (count - 1)))
          : null,
      integral: this.duration > 0 ? finite(this.area) : null,
      startValue: this.first?.[1] ?? null,
      endValue: this.last?.[1] ?? null,
      ...(this.first ? { startTime: this.first[0] } : {}),
      ...(this.last ? { endTime: this.last[0] } : {}),
      start: this.start,
      end: this.end,
    };
    const operation = this.operation;
    if (operation && valueSpec(operation)?.parameters?.length) {
      let value: number | null = null;
      let timestamp: number | undefined;
      if (operation === 'value-at') {
        timestamp = this.start + this.parameters.time!;
        value = this.at === undefined ? null : finite(this.at);
      } else if (operation === 'first-crossing') {
        if (this.firstCrossing !== undefined) {
          timestamp = this.firstCrossing;
          value = this.firstCrossing - this.start;
        }
      } else if (operation === 'crossing-count')
        value = count ? this.crossingCount : null;
      else value = this.duration > 0 ? this.beyond : null;
      statistics.result = {
        operation,
        parameters: this.parameters,
        value,
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    }
    return statistics;
  }
}
