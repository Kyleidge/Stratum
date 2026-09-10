import type { EdgeTrigger } from './signal-types';

/** An explicit clock relationship; a file and a sampling grid are not clocks. */
export type TimeReference = {
  id: string;
  name: string;
  kind: 'relative' | 'absolute';
};
export type TimeAnchor =
  | { kind: 'point'; time: number }
  | { kind: 'start' }
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
