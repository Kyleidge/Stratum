/**
 * Slider ranges, presets and plain-language hints for derive parameters. The
 * engine still validates every value; these only make good values easy to pick.
 */
import type { Summary } from './signal-types';

/** What a dialog knows about the previewed input, from its full-range summary. */
export type ParameterContext = {
  /** Mean spacing of valid samples, in seconds. */
  interval?: number;
  /** Time span of the input, in seconds. */
  start?: number;
  end?: number;
  min?: number;
  max?: number;
  mean?: number;
};
export type ParameterPreset = { label: string; value: number; title?: string };
export type ParameterScale = {
  min: number;
  max: number;
  log: boolean;
  integer: boolean;
  presets: ParameterPreset[];
};

export function parameterContext(summary?: Summary): ParameterContext {
  if (!summary || !summary.count) return {};
  const finite = (value: number) =>
    Number.isFinite(value) ? value : undefined;
  const span = summary.end - summary.start;
  return {
    interval:
      summary.count > 1 && span > 0 ? span / (summary.count - 1) : undefined,
    start: finite(summary.start),
    end: finite(summary.end),
    min: finite(summary.min),
    max: finite(summary.max),
    mean: finite(summary.mean),
  };
}

/** Round to a readable number of significant digits without losing sign. */
export function roundSignificant(value: number, digits = 3): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(digits));
}

/**
 * A readable trigger threshold halfway between a signal's minimum and maximum,
 * rounded to a 1/2/5 step near 1 % of the range. `undefined` without a range.
 */
export function rangeMidpoint(min?: number, max?: number): number | undefined {
  if (min === undefined || max === undefined) return undefined;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  const middle = (min + max) / 2;
  const span = Math.abs(max - min);
  if (!span) return roundSignificant(middle, 6);
  const raw = span / 100;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  return Number((Math.round(middle / step) * step).toPrecision(12));
}

/** Compact number text for hints and preset labels. */
export function formatQuantity(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = roundSignificant(value, digits);
  const magnitude = Math.abs(rounded);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3))
    return rounded.toExponential(Math.max(0, digits - 1)).replace('e+', 'e');
  return rounded.toLocaleString('en-GB', { maximumFractionDigits: 6 });
}

/** Human time text, choosing ms / s / min by magnitude. */
export function formatDuration(seconds: number): string {
  const magnitude = Math.abs(seconds);
  if (!Number.isFinite(seconds)) return '—';
  if (magnitude > 0 && magnitude < 1)
    return `${formatQuantity(seconds * 1000)} ms`;
  if (magnitude >= 120) return `${formatQuantity(seconds / 60)} min`;
  return `${formatQuantity(seconds)} s`;
}

/** A 1/2/5 × 10ⁿ value at or above `value`. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
  );
}

const within = (
  presets: ParameterPreset[],
  scale: { min: number; max: number },
) =>
  presets.filter(
    (preset, index) =>
      preset.value >= scale.min &&
      preset.value <= scale.max &&
      presets.findIndex((item) => item.value === preset.value) === index,
  );

export function parameterScale(
  operation: string,
  context: ParameterContext,
): ParameterScale | undefined {
  const { interval, start, end, min, max, mean } = context;
  const rate = interval ? 1 / interval : undefined;
  const span =
    start !== undefined && end !== undefined ? end - start : undefined;
  const samples =
    interval && span ? Math.round(span / interval) + 1 : undefined;
  switch (operation) {
    case 'smooth': {
      const scale = {
        min: 1,
        max: Math.min(100000, Math.max(10, Math.round((samples ?? 5000) / 5))),
      };
      const presets = interval
        ? [0.01, 0.1, 1, 10].map((seconds) => ({
            label: formatDuration(seconds),
            value: Math.round(seconds / interval),
            title: `${Math.round(seconds / interval)} samples`,
          }))
        : [5, 25, 100, 500].map((value) => ({ label: String(value), value }));
      return {
        ...scale,
        log: true,
        integer: true,
        presets: within(
          presets.filter((preset) => preset.value >= 2),
          scale,
        ),
      };
    }
    case 'median':
      return {
        min: 1,
        max: 1001,
        log: true,
        integer: true,
        presets: [3, 5, 11, 51, 101].map((value) => ({
          label: String(value),
          value,
          title: interval
            ? `${formatDuration(value * interval)} window`
            : undefined,
        })),
      };
    case 'exponential':
      return {
        min: 0.001,
        max: 1,
        log: true,
        integer: false,
        presets: [0.05, 0.1, 0.2, 0.5].map((value) => ({
          label: `α ${value}`,
          value,
        })),
      };
    case 'low-pass':
    case 'high-pass':
    case 'butterworth-low':
    case 'butterworth-high': {
      // Butterworth cutoffs must stay below Nyquist; RC cutoffs may not.
      const top = operation.startsWith('butterworth') ? 0.45 : 0.5;
      const scale = rate
        ? {
            min: roundSignificant(rate / 10000, 2),
            max: roundSignificant(rate * top, 3),
          }
        : { min: 0.001, max: 1000 };
      return {
        ...scale,
        log: true,
        integer: false,
        presets: within(
          [0.1, 1, 5, 10, 50, 100].map((value) => ({
            label: `${formatQuantity(value)} Hz`,
            value,
          })),
          scale,
        ),
      };
    }
    case 'resample': {
      const scale = rate
        ? {
            min: Math.max(0.01, roundSignificant(rate / 1000, 2)),
            max: Math.min(10000, roundSignificant(rate * 10, 3)),
          }
        : { min: 0.01, max: 10000 };
      return {
        ...scale,
        log: true,
        integer: false,
        presets: within(
          [
            ...(rate
              ? [
                  {
                    label: `Source ${formatQuantity(rate)} Hz`,
                    value: roundSignificant(rate, 6),
                  },
                ]
              : []),
            ...[1, 10, 100, 1000].map((value) => ({
              label: `${formatQuantity(value)} Hz`,
              value,
            })),
          ],
          scale,
        ),
      };
    }
    case 'scale':
      return {
        min: 0,
        max: 5,
        log: false,
        integer: false,
        presets: [
          { label: '× −1', value: -1, title: 'Invert the sign' },
          { label: '× 0.001', value: 0.001 },
          { label: '× 0.1', value: 0.1 },
          { label: '× 10', value: 10 },
          { label: '× 1000', value: 1000 },
        ],
      };
    case 'offset': {
      const reach = niceCeil(
        Math.max(
          Math.abs(min ?? 0),
          Math.abs(max ?? 0),
          (max ?? 0) - (min ?? 0),
          1e-9,
        ),
      );
      const presets: ParameterPreset[] = [];
      if (mean !== undefined && mean !== 0)
        presets.push({
          label: 'Remove mean',
          value: roundSignificant(-mean, 6),
          title: `Offset by ${formatQuantity(-mean)}`,
        });
      if (min !== undefined && min !== 0)
        presets.push({
          label: 'Minimum to 0',
          value: roundSignificant(-min, 6),
          title: `Offset by ${formatQuantity(-min)}`,
        });
      if (max !== undefined && max !== 0)
        presets.push({
          label: 'Maximum to 0',
          value: roundSignificant(-max, 6),
          title: `Offset by ${formatQuantity(-max)}`,
        });
      return {
        min: -reach,
        max: reach,
        log: false,
        integer: false,
        presets,
      };
    }
    case 'time-shift': {
      const reach = niceCeil(Math.max(span ?? 10, Math.abs(start ?? 0)));
      return {
        min: -reach,
        max: reach,
        log: false,
        integer: false,
        presets:
          start !== undefined && start !== 0
            ? [
                {
                  label: 'Start at 0 s',
                  value: roundSignificant(-start, 9),
                  title: `Shift by ${formatDuration(-start)}`,
                },
              ]
            : [],
      };
    }
    // Value settings: a level within the input's range, or a time from its start.
    case 'value-threshold': {
      if (min === undefined || max === undefined) return undefined;
      const pad = niceCeil(Math.max((max - min) * 0.05, 1e-9));
      const percent = (fraction: number) => ({
        label: `${fraction * 100} %`,
        value: roundSignificant(min + (max - min) * fraction, 6),
        title: `${fraction * 100} % of the input's range`,
      });
      return {
        min: Number((min - pad).toPrecision(12)),
        max: Number((max + pad).toPrecision(12)),
        log: false,
        integer: false,
        presets: max > min ? [0.1, 0.5, 0.9].map(percent) : [],
      };
    }
    case 'value-time': {
      if (span === undefined || span <= 0) return undefined;
      return {
        min: 0,
        max: niceCeil(span),
        log: false,
        integer: false,
        presets: [
          { label: 'Start', value: 0 },
          {
            label: 'Middle',
            value: roundSignificant(span / 2, 6),
            title: formatDuration(span / 2),
          },
        ],
      };
    }
  }
  return undefined;
}

/** Slider position in [0, 1] for a value, clamped to the scale. */
export function sliderPosition(value: number, scale: ParameterScale): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(scale.min, Math.min(scale.max, value));
  if (scale.log && scale.min > 0)
    return Math.log(clamped / scale.min) / Math.log(scale.max / scale.min || 1);
  return (clamped - scale.min) / (scale.max - scale.min || 1);
}

/** The readable value at a slider position. */
export function sliderValue(position: number, scale: ParameterScale): number {
  const fraction = Math.max(0, Math.min(1, position));
  const raw =
    scale.log && scale.min > 0
      ? scale.min * (scale.max / scale.min) ** fraction
      : scale.min + fraction * (scale.max - scale.min);
  if (scale.integer)
    return Math.max(scale.min, Math.min(scale.max, Math.round(raw)));
  if (scale.log) return roundSignificant(raw, 2);
  // Linear sliders snap to a 1/2/5 step near a thousandth of their span.
  const step = niceCeil((scale.max - scale.min) / 1000);
  return Number((Math.round(raw / step) * step).toPrecision(12));
}

/** What a parameter means for this input, such as a window in seconds. */
export function parameterHint(
  operation: string,
  value: number,
  context: ParameterContext,
  unit = '',
): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const { interval, start, end, min, max } = context;
  const rate = interval ? 1 / interval : undefined;
  const suffix = unit ? ` ${unit}` : '';
  switch (operation) {
    case 'smooth':
    case 'median':
      return interval
        ? `Window ≈ ${formatDuration(value * interval)} at ${formatQuantity(rate!)} Hz.`
        : undefined;
    case 'exponential':
      if (!interval || value <= 0 || value > 1) return undefined;
      return value === 1
        ? 'α = 1 leaves the signal unchanged.'
        : `Time constant ≈ ${formatDuration(-interval / Math.log(1 - value))}.`;
    case 'butterworth-low':
    case 'butterworth-high':
      if (value <= 0) return undefined;
      return rate && value >= rate / 2
        ? `Must be below Nyquist (${formatQuantity(rate / 2)} Hz) for this input.`
        : `−3 dB at ${formatQuantity(value)} Hz, −40 dB a decade ${operation === 'butterworth-low' ? 'above' : 'below'}.${rate ? ` Nyquist ${formatQuantity(rate / 2)} Hz.` : ''}`;
    case 'low-pass':
    case 'high-pass': {
      if (value <= 0) return undefined;
      const tau = `Time constant ${formatDuration(1 / (2 * Math.PI * value))}.`;
      return rate && value >= rate / 2
        ? `${tau} At or above Nyquist (${formatQuantity(rate / 2)} Hz), this barely filters.`
        : rate
          ? `${tau} Nyquist ${formatQuantity(rate / 2)} Hz.`
          : tau;
    }
    case 'resample': {
      if (value <= 0 || start === undefined || end === undefined)
        return undefined;
      const count = Math.floor((end - start) * value) + 1;
      return `≈ ${formatQuantity(count)} samples${
        rate && value < rate * 0.999
          ? ` · fewer than the source ${formatQuantity(rate)} Hz; filter first to avoid aliasing`
          : ''
      }.`;
    }
    case 'scale':
    case 'offset':
      if (min === undefined || max === undefined) return undefined;
      {
        const a = operation === 'scale' ? min * value : min + value;
        const b = operation === 'scale' ? max * value : max + value;
        return `Output ${formatQuantity(Math.min(a, b), 5)} to ${formatQuantity(Math.max(a, b), 5)}${suffix}.`;
      }
    case 'time-shift':
      return start !== undefined && end !== undefined
        ? `New time range ${formatQuantity(start + value)} to ${formatQuantity(end + value)} s.`
        : undefined;
  }
  return undefined;
}
