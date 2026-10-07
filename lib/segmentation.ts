import type { EdgeTrigger, Point } from './signal-types';

export type TriggerEvent = {
  time: number;
  kind: 'crossing' | 'gap' | 'valid' | 'finish';
};

/** Hysteresis and debounce must be absent or finite and not negative. */
export function validTriggerNoise(
  trigger: Pick<EdgeTrigger, 'hysteresis' | 'debounce'>,
): boolean {
  return [trigger.hysteresis, trigger.debounce].every(
    (value) => value === undefined || (Number.isFinite(value) && value >= 0),
  );
}

// No implicit smoothing or engineering-specific assumptions. State persists
// across chunks, and missing samples break adjacency rather than invent edges.
// A rising detector is armed at or below `threshold − hysteresis` and fires
// when it next rises above the threshold; falling mirrors this. With
// `debounce`, a crossing counts only once the signal has not returned to the
// re-arm level for that many seconds; it is reported at its crossing time.
// Without hysteresis or debounce, a crossing is exactly a pair of adjacent
// samples on either side of the threshold.
export class CrossingDetector {
  private previous?: Point;
  private valid: boolean | undefined;
  private armed = false;
  /** A crossing awaiting its debounce time. */
  private candidate?: number;
  private readonly hysteresis: number;
  private readonly debounce: number;
  constructor(
    private trigger: Pick<EdgeTrigger, 'edge' | 'threshold'> &
      Partial<Pick<EdgeTrigger, 'hysteresis' | 'debounce'>>,
  ) {
    if (!validTriggerNoise(trigger))
      throw new Error('Hysteresis and debounce must be zero or positive.');
    this.hysteresis = trigger.hysteresis ?? 0;
    this.debounce = trigger.debounce ?? 0;
  }
  next(time: number, value: number): TriggerEvent | undefined {
    if (!Number.isFinite(value)) {
      this.previous = undefined;
      this.armed = false;
      this.candidate = undefined;
      const changed = this.valid !== false;
      this.valid = false;
      return changed ? { time, kind: 'gap' } : undefined;
    }
    const previous = this.previous;
    this.previous = [time, value];
    const level = this.trigger.threshold;
    const rising = this.trigger.edge === 'rising';
    const rearm = rising
      ? value <= level - this.hysteresis
      : value >= level + this.hysteresis;
    if (this.valid !== true) {
      this.valid = true;
      this.armed = rearm;
      return { time, kind: 'valid' };
    }
    if (this.candidate !== undefined) {
      if (rearm) {
        // It returned before the debounce time: not a crossing.
        this.candidate = undefined;
        this.armed = true;
        return;
      }
      if (time < this.candidate + this.debounce) return;
      const crossing = this.candidate;
      this.candidate = undefined;
      return { time: crossing, kind: 'crossing' };
    }
    if (rearm) {
      this.armed = true;
      return;
    }
    if (!this.armed || !previous || (rising ? value <= level : value >= level))
      return;
    this.armed = false;
    // Armed means the previous sample was on the other side of the level.
    const crossing =
      previous[0] +
      ((time - previous[0]) * (level - previous[1])) / (value - previous[1]);
    if (this.debounce > 0 && time < crossing + this.debounce) {
      this.candidate = crossing;
      return;
    }
    return { time: crossing, kind: 'crossing' };
  }
}
