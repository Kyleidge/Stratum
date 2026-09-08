// Causal filters keep bounded state for one complete signal evaluation.
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
}
