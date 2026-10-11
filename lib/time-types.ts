import type { EdgeTrigger } from './signal-types';

/**
 * When a time axis happened: axis time t is the instant `start + t` (Unix
 * seconds, UTC). Sample times stay small numbers relative to `start`, so
 * they keep their full precision.
 */
export type TimeClock = {
  /** Unix seconds (since 1970-01-01 UTC) at axis time 0. */
  start: number;
  /** Minutes east of UTC that the file's clock showed; times show in it. */
  offset: number;
  /** The file gives times of day only: dates are unknown and never shown. */
  undated?: true;
};

/** An explicit clock relationship; a file and a sampling grid are not clocks. */
export type TimeReference = {
  id: string;
  name: string;
  kind: 'relative' | 'absolute';
  /**
   * Absolute references: when axis time 0 happened. Without it, an absolute
   * axis counts Unix seconds (axis time = instant).
   */
  clock?: TimeClock;
};
export type TimeAnchor =
  | { kind: 'point'; time: number }
  | { kind: 'start' }
  /** Line up by clock time: the instant the target time stands for. */
  | { kind: 'clock' }
  | { kind: 'event'; trigger: EdgeTrigger; occurrence: number };
export type TimeGrid =
  | { kind: 'uniform'; start: number; end: number; rate: number }
  | { kind: 'reference'; signalId: string; start: number; end: number };
export type Interpolation = 'linear' | 'previous' | 'nearest';
export type TimeSettings =
  | {
      kind: 'align';
      reference: TimeReference;
      target: number;
      secondTarget?: number;
      groups: {
        inputIds: string[];
        anchor: TimeAnchor;
        secondAnchor?: TimeAnchor;
      }[];
    }
  | {
      kind: 'resample';
      inputIds: string[];
      grid: TimeGrid;
      interpolation: Interpolation;
      maxGap: number;
      /** Symmetric windowed-sinc filter, evaluated before interpolation. */
      filter?: { cutoff: number; halfWidth: number };
    }
  | {
      kind: 'combine';
      inputIds: [string, string];
      operator: 'difference' | 'sum' | 'product' | 'ratio';
    }
  | { kind: 'crop'; inputIds: string[]; start: number; end: number };

export type TimeRecipe =
  | { kind: 'align'; scale: number; anchor: number; target: number }
  | {
      kind: 'resample';
      grid: TimeGrid;
      interpolation: Interpolation;
      maxGap: number;
      filter?: { cutoff: number; halfWidth: number };
    }
  | {
      kind: 'combine';
      operator: Extract<TimeSettings, { kind: 'combine' }>['operator'];
    }
  | { kind: 'crop'; start: number; end: number };

export const TIME_OPERATIONS = {
  'time-align': 'Align time bases',
  'time-resample': 'Resample to a shared grid',
  'time-combine': 'Calculate between signals',
  'time-crop': 'Crop comparison interval',
} as const;

export const COMPARISON_MATH = {
  difference: 'subtract',
  sum: 'add',
  product: 'multiply',
  ratio: 'divide',
} as const;

export function timeInputs(settings: TimeSettings): string[] {
  return [
    ...new Set(
      settings.kind === 'align'
        ? settings.groups.flatMap((group) => [
            ...group.inputIds,
            ...[group.anchor, group.secondAnchor].flatMap((anchor) =>
              anchor?.kind === 'event' ? [anchor.trigger.signalId] : [],
            ),
          ])
        : [
            ...settings.inputIds,
            ...(settings.kind === 'resample' &&
            settings.grid.kind === 'reference'
              ? [settings.grid.signalId]
              : []),
          ],
    ),
  ];
}

/** The clock of a time reference, or undefined for relative time. */
export function referenceClock(
  reference: TimeReference | undefined,
): TimeClock | undefined {
  if (reference?.kind !== 'absolute') return undefined;
  return reference.clock ?? { start: 0, offset: 0 };
}

/** A plain-language problem with a stored clock, or undefined. */
export function clockProblem(clock: unknown): string | undefined {
  const item = clock as Partial<TimeClock> | null;
  if (!item || typeof item !== 'object') return 'Invalid clock time.';
  if (!Number.isFinite(item.start) || Math.abs(item.start!) > 1e11)
    return 'A clock start time is invalid.';
  if (
    !Number.isInteger(item.offset) ||
    item.offset! < -18 * 60 ||
    item.offset! > 18 * 60
  )
    return 'A clock’s UTC offset is invalid.';
  if (item.undated !== undefined && item.undated !== true)
    return 'Invalid clock time.';
  return undefined;
}
