import { fillRing } from './signal-math';

// Causal filters keep bounded state for one complete signal evaluation.
// Windowed evaluation restores exactly the state a full pass would hold.
export class RollingMedian {
  private values: Float64Array;
  private sorted: number[] = [];
  private cursor = 0;

  constructor(size: number) {
    this.values = new Float64Array(size).fill(NaN);
  }

  private lowerBound(value: number): number {
    let start = 0;
    let end = this.sorted.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (this.sorted[middle] < value) start = middle + 1;
      else end = middle;
    }
    return start;
  }

  next(value: number): number {
    const old = this.values[this.cursor];
    if (Number.isFinite(old)) this.sorted.splice(this.lowerBound(old), 1);
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.values.length;
    if (Number.isFinite(value))
      this.sorted.splice(this.lowerBound(value), 0, value);
    const length = this.sorted.length;
    if (!length) return NaN;
    const middle = Math.floor(length / 2);
    if (length % 2) return this.sorted[middle];
    const lower = this.sorted[middle - 1];
    const upper = this.sorted[middle];
    // Preserve tiny values without overflowing large equal values.
    const sum = lower + upper;
    return Number.isFinite(sum) ? sum / 2 : lower / 2 + upper / 2;
  }

  /** The median depends only on the last `size` inputs, oldest first. */
  restore(history: ArrayLike<number>) {
    fillRing(this.values, history);
    this.cursor = history.length % this.values.length;
    this.sorted = [...this.values]
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  }
}

export class ExponentialSmoother {
  private value = NaN;

  constructor(private alpha: number) {}

  next(input: number): number {
    if (!Number.isFinite(input)) this.value = NaN;
    else
      this.value = Number.isFinite(this.value)
        ? this.alpha * input + (1 - this.alpha) * this.value
        : input;
    return this.value;
  }
  state(): number {
    return this.value;
  }
  restore(value: number) {
    this.value = value;
  }
}

// First-order RC filters, discretized with backward Euler using actual dt.
// A missing input breaks the recurrence; the next finite sample restarts it.
export class RcFilter {
  private previousTime = NaN;
  private previousInput = NaN;
  private value = NaN;
  constructor(
    private cutoff: number,
    private mode: 'low-pass' | 'high-pass',
  ) {}

  next(time: number, input: number): number {
    if (!Number.isFinite(input)) {
      this.value = NaN;
      this.previousInput = NaN;
      this.previousTime = NaN;
      return NaN;
    }
    if (!Number.isFinite(this.previousInput)) {
      this.value = this.mode === 'low-pass' ? input : 0;
    } else {
      const dt = time - this.previousTime;
      const ratio = this.cutoff * dt * (2 * Math.PI); // dt / tau
      const low = 1 / (1 + 1 / ratio);
      const high = 1 / (1 + ratio);
      if (this.mode === 'low-pass') {
        this.value = low * input + high * this.value;
      } else {
        // Subtract DC before adding retained AC state to avoid cancellation.
        // Scale separately only if the raw difference itself overflows.
        const difference = input - this.previousInput;
        if (Number.isFinite(difference)) {
          this.value = high * this.value + high * difference;
        } else {
          const retained = high * this.value;
          const current = high * input;
          const previous = high * this.previousInput;
          // Cancel with retained state before combining an overflowing step.
          this.value =
            Math.abs(input) >= Math.abs(this.previousInput)
              ? retained + current - previous
              : retained - previous + current;
        }
      }
    }
    this.previousTime = time;
    this.previousInput = input;
    return this.value;
  }
  state(): [previousTime: number, previousInput: number, value: number] {
    return [this.previousTime, this.previousInput, this.value];
  }
  restore(previousTime: number, previousInput: number, value: number) {
    this.previousTime = previousTime;
    this.previousInput = previousInput;
    this.value = value;
  }
}

/**
 * Whether a cutoff is below the Nyquist frequency. An estimated rate is
 * rounded, so a cutoff within a millionth of Nyquist counts as at Nyquist.
 */
export const belowNyquist = (cutoff: number, rate: number) =>
  cutoff < (rate / 2) * (1 - 1e-6);

/**
 * Second-order Butterworth coefficients (bilinear transform with
 * prewarping, Q = 1/√2) for a cutoff below the Nyquist frequency.
 */
export function butterworth(
  cutoff: number,
  rate: number,
  mode: 'low-pass' | 'high-pass',
): { b: [number, number, number]; a: [number, number] } {
  if (!(cutoff > 0) || !(rate > 0) || !belowNyquist(cutoff, rate))
    throw new Error(
      'The cutoff must be above 0 Hz and below half the sample rate.',
    );
  const w = (2 * Math.PI * cutoff) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const edge = mode === 'low-pass' ? (1 - cos) / 2 : (1 + cos) / 2;
  const middle = mode === 'low-pass' ? 1 - cos : -(1 + cos);
  return {
    b: [edge / a0, middle / a0, edge / a0],
    a: [(-2 * cos) / a0, (1 - alpha) / a0],
  };
}

// A second-order Butterworth section in transposed direct form II for a
// regular sample interval. It starts in the steady state of its first input
// (low-pass: that input; high-pass: zero). A missing input, or an interval
// more than 1 % from the nominal one, restarts it at the next finite sample.
export class ButterworthFilter {
  private readonly b: [number, number, number];
  private readonly a: [number, number];
  private readonly interval: number;
  private previousTime = NaN;
  private s1 = 0;
  private s2 = 0;
  constructor(
    cutoff: number,
    rate: number,
    private mode: 'low-pass' | 'high-pass',
  ) {
    ({ b: this.b, a: this.a } = butterworth(cutoff, rate, mode));
    this.interval = 1 / rate;
  }

  next(time: number, input: number): number {
    if (!Number.isFinite(input)) {
      this.previousTime = NaN;
      return NaN;
    }
    const [b0, b1, b2] = this.b;
    const [a1, a2] = this.a;
    const dt = time - this.previousTime;
    const restart =
      !Number.isFinite(this.previousTime) ||
      Math.abs(dt - this.interval) > this.interval * 0.01;
    if (restart) {
      // Steady state for a constant input equal to this one.
      if (this.mode === 'low-pass') {
        this.s2 = (b2 - a2) * input;
        this.s1 = (b1 - a1) * input + this.s2;
      } else {
        this.s2 = b2 * input;
        this.s1 = b1 * input + this.s2;
      }
    }
    // In steady state the output is exactly the input (low-pass) or zero.
    const output = restart
      ? this.mode === 'low-pass'
        ? input
        : 0
      : b0 * input + this.s1;
    this.s1 = b1 * input - a1 * output + this.s2;
    this.s2 = b2 * input - a2 * output;
    this.previousTime = time;
    return output;
  }
  state(): [previousTime: number, s1: number, s2: number] {
    return [this.previousTime, this.s1, this.s2];
  }
  restore(previousTime: number, s1: number, s2: number) {
    this.previousTime = previousTime;
    this.s1 = s1;
    this.s2 = s2;
  }
}
