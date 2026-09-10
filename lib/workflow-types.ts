import type { Operation, SegmentationDefinition } from './signal-types';

export type ValueOperation =
  | 'minimum'
  | 'maximum'
  | 'time-average'
  | 'sample-average';

export type ScalarValue = {
  id: string;
  sourceId: string;
  inputId: string;
  batchId: string;
  name: string;
  unit: string;
  operation: ValueOperation;
  value: number | null;
  sampleCount: number;
  validDuration: number;
  start: number;
  end: number;
  timestamp?: number;
  createdAt: string;
};

/** Chronological invocation record; explicit edits increment its revision. */
export type WorkflowStep = {
  revision?: number;
  updatedAt?: string;
  name?: string;
  id: string;
  sourceId: string;
  sequence: number;
  createdAt: string;
  kind: 'import' | 'derive' | 'segment' | 'value' | 'regions';
  operation: Operation | ValueOperation | 'import' | 'regions' | 'segment';
  inputIds: string[];
  outputIds: string[];
  parameters?: Record<string, number>;
  definition?: SegmentationDefinition;
  segmentationId?: string;
  regionSetId?: string;
};

export const VALUE_FUNCTIONS: {
  operation: ValueOperation;
  name: string;
  description: string;
}[] = [
  {
    operation: 'time-average',
    name: 'Time average',
    description:
      'Trapezoidal integral divided by valid elapsed time. Adjacent finite samples contribute; missing intervals are excluded. Requires a positive valid duration.',
  },
  {
    operation: 'minimum',
    name: 'Minimum',
    description: 'Lowest finite sample, with its first occurrence time.',
  },
  {
    operation: 'maximum',
    name: 'Maximum',
    description: 'Highest finite sample, with its first occurrence time.',
  },
  {
    operation: 'sample-average',
    name: 'Sample average',
    description:
      'Arithmetic mean of finite samples. Each sample has equal weight.',
  },
];
