import type { EdgeTrigger, Point } from './signal-types';

export type TriggerEvent = {
  time: number;
  kind: 'crossing' | 'gap' | 'valid' | 'finish';
};

// No implicit smoothing or engineering-specific assumptions. State persists
// across chunks, and missing samples break adjacency rather than invent edges.
export class CrossingDetector {
  private previous?: Point;
  private valid: boolean | undefined;
  constructor(private trigger: Pick<EdgeTrigger, 'edge' | 'threshold'>) {}
  next(time: number, value: number): TriggerEvent | undefined {
    if (!Number.isFinite(value)) {
      this.previous = undefined;
      const changed = this.valid !== false;
      this.valid = false;
      return changed ? { time, kind: 'gap' } : undefined;
    }
    const previous = this.previous;
    this.previous = [time, value];
    if (this.valid !== true) {
      this.valid = true;
      return { time, kind: 'valid' };
    }
    const level = this.trigger.threshold;
    if (
      previous &&
      (this.trigger.edge === 'rising'
        ? previous[1] <= level && value > level
        : previous[1] >= level && value < level)
    ) {
      return {
        time:
          previous[0] +
          ((time - previous[0]) * (level - previous[1])) /
            (value - previous[1]),
        kind: 'crossing',
      };
    }
  }
}
