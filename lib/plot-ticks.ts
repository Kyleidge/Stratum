/**
 * Round-number axis ticks: steps of 1, 2 or 5 × 10ⁿ. Tick generation is
 * bounded so extreme offsets, narrow spans or invalid inputs cannot hang.
 */

/**
 * The 1/2/5 × 10ⁿ step whose tick count is nearest `target`, with at least
 * three ticks. With `expand`, ticks are counted on the domain rounded outward
 * to whole steps, and ties prefer the tighter domain.
 */
function tickStep(min: number, max: number, target: number, expand: boolean) {
  const tickTarget = Number.isFinite(target)
    ? Math.max(3, Math.min(20, target))
    : 6;
  const intervals = tickTarget - 1;
  const span = (max - min) / intervals;
  const rough = Number.isFinite(span)
    ? span
    : max / intervals - min / intervals;
  const magnitude = Math.max(
    Number.MIN_VALUE,
    10 ** Math.floor(Math.log10(rough)),
  );
  let step = magnitude;
  let best = [Infinity, Infinity];
  for (const factor of [0.5, 1, 2, 5, 10, 20]) {
    const candidate = factor * magnitude;
    if (!Number.isFinite(candidate) || candidate <= 0) continue;
    const first = expand
      ? Math.floor(min / candidate + 1e-9)
      : Math.ceil(min / candidate - 1e-9);
    const last = expand
      ? Math.ceil(max / candidate - 1e-9)
      : Math.floor(max / candidate + 1e-9);
    const count = last - first + 1;
    const score = [
      Math.abs(count - tickTarget) + (count < 3 ? 100 : 0),
      expand ? (last - first) * candidate : -candidate,
    ];
    if (score[0] < best[0] || (score[0] === best[0] && score[1] < best[1])) {
      best = score;
      step = candidate;
    }
  }
  return step;
}

function padded(min: number, max: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max > min) return [min, max];
  const pad = Math.abs(min) * 0.1 || 1;
  const lo = min - pad;
  const hi = min + pad;
  return [Number.isFinite(lo) ? lo : min, Number.isFinite(hi) ? hi : min];
}

/** An axis index can exceed 2^53; increment a bounded local count instead. */
function tickValues(first: number, last: number, step: number) {
  const count = Math.max(0, Math.min(100, Math.floor(last - first) + 1));
  const ticks: number[] = [];
  for (let offset = 0; offset < count; offset++) {
    const index = first + offset;
    const value = index === 0 ? 0 : index * step;
    if (
      Number.isFinite(value) &&
      (!ticks.length || value > ticks[ticks.length - 1])
    )
      ticks.push(value);
  }
  return ticks;
}

/** Round-number ticks inside [min, max], about `target` of them. */
export function niceTicks(low: number, high: number, target = 6) {
  const [min, max] = padded(low, high);
  const step = tickStep(min, max, target, false);
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  const ticks = tickValues(first, last, step).filter(
    (value) => value >= min - step * 1e-9 && value <= max + step * 1e-9,
  );
  return { ticks, step };
}

/** Expands [min, max] outward so the first and last ticks are the axis ends. */
export function niceDomain(low: number, high: number, target = 5) {
  const [min, max] = padded(low, high);
  const step = tickStep(min, max, target, true);
  const first = Math.floor(min / step + 1e-9);
  const last = Math.max(first + 1, Math.ceil(max / step - 1e-9));
  const roundedLo = first * step;
  const roundedHi = last * step;
  const lo = Number.isFinite(roundedLo) ? Math.min(min, roundedLo) : min;
  const hi = Number.isFinite(roundedHi) ? Math.max(max, roundedHi) : max;
  const ticks = [
    lo,
    ...tickValues(first, last, step).filter(
      (value) => value > lo && value < hi,
    ),
    hi,
  ];
  return { lo, hi, ticks, step };
}

/**
 * Logarithmic ticks inside [low, high] (positive values): decades, adding
 * 2 and 5 multiples when the axis spans less than two decades.
 */
export function logTicks(low: number, high: number) {
  if (!(low > 0) || !(high > low) || !Number.isFinite(high))
    return { ticks: [] as number[], step: 1 };
  const first = Math.floor(Math.log10(low));
  const last = Math.ceil(Math.log10(high));
  const factors = last - first <= 2 ? [1, 2, 5] : [1];
  const ticks: number[] = [];
  for (let decade = first; decade <= last && ticks.length < 100; decade++)
    for (const factor of factors) {
      const value = factor * 10 ** decade;
      if (value >= low * (1 - 1e-9) && value <= high * (1 + 1e-9))
        ticks.push(value);
    }
  return { ticks, step: 10 ** Math.max(first, -324) };
}

export function formatTick(value: number, step: number) {
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Label for a tick spaced `step` from its neighbours. Very large or very
 * small magnitudes use scientific notation with enough digits to differ.
 */
export function formatAxisTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (!abs) return '0';
  if (abs >= 1e6 || abs < 1e-4 || !(step >= 1e-6)) {
    const digits =
      Number.isFinite(step) && step > 0
        ? Math.ceil(Math.log10(abs / step) + 1e-9)
        : 2;
    return value.toExponential(Math.max(1, Math.min(12, digits)));
  }
  return formatTick(value, step);
}
