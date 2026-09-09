import type { SegmentationDefinition } from './signal-types';

export const EXAMPLES = [
  {
    key: 'trigger-ramps',
    name: 'RPM triggers · 3 file segments',
    description:
      'Start rising above 900 rpm, offset −20 s. End falling below 900 rpm. The first interval clips to the recording start.',
    chain: false,
  },
  {
    key: 'manual-ranges',
    name: 'Manual ranges · 3 file segments',
    description:
      'Three explicit intervals: 12–51 s, 70–109 s, and 128–167 s. Each contains all four original signals.',
    chain: false,
  },
  {
    key: 'time-windows',
    name: '60-second windows · 3 file segments',
    description:
      'Split 0–180 s into three 60-second windows. Change the step in Segment settings to overlap windows.',
    chain: false,
  },
  {
    key: 'processing-chain',
    name: 'Filter → Segment → Average → Min / Max',
    description:
      'Median-filter RPM (5 samples), segment on 900 rpm crossings, average each segment (25 samples), then find each minimum and maximum.',
    chain: true,
  },
] as const;

export function exampleDefinition(
  key: string,
  triggerId: string,
): SegmentationDefinition {
  if (!EXAMPLES.some((example) => example.key === key))
    throw new Error('Choose an available example.');
  if (key === 'manual-ranges')
    return {
      method: 'ranges',
      boundary: 'clip',
      ranges: [
        [12, 51],
        [70, 109],
        [128, 167],
      ],
    };
  if (key === 'time-windows')
    return {
      method: 'windows',
      boundary: 'clip',
      start: 0,
      end: 180,
      duration: 60,
      step: 60,
      includePartial: false,
    };
  return {
    method: 'triggers',
    boundary: 'clip',
    minimumDuration: 0,
    start: {
      signalId: triggerId,
      edge: 'rising',
      threshold: 900,
      offset: key === 'trigger-ramps' ? -20 : 0,
    },
    end: { signalId: triggerId, edge: 'falling', threshold: 900, offset: 0 },
  };
}
