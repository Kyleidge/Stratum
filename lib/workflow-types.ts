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
  timeSettings?: import('./time-types').TimeSettings;
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
  /** Workflow run that produced this step, when created by a batch. */
  runId?: string;
  /** Recipe step this invocation was replayed from. */
  recipeStepId?: string;
  checks?: CheckDefinition[];
  /** Results for `checks`, evaluated against the step's current revision. */
  checkResults?: { revision: number; results: CheckResult[] };
};

export type CheckKind = 'count' | 'limits' | 'missing' | 'duration';
/** An expectation on a step's outputs. Limits are inclusive. */
export type CheckDefinition = {
  kind: CheckKind;
  min?: number;
  max?: number;
  /** Limits only: must equal the output unit exactly; never converted. */
  unit?: string;
  /** 1-based output positions; all outputs when omitted. */
  outputs?: number[];
  severity: 'warning' | 'fail';
  message?: string;
};
export type CheckStatus = 'pass' | 'warning' | 'fail';
export type CheckResult = {
  /** Index into the step's checks. */
  check: number;
  status: CheckStatus;
  outputId?: string;
  observed: number | null;
  message: string;
};

export type RunStatus = 'pass' | 'warning' | 'fail' | 'error';
/** A problem found while replaying a workflow, separate from check results. */
export type RunFlag = {
  severity: 'warning' | 'error';
  recipeStepId?: string;
  message: string;
};
export type WorkflowRun = {
  id: string;
  batchId: string;
  itemId: string;
  fileName: string;
  sourceId: string;
  status: RunStatus;
  /** Recipe step ID → produced workflow step ID. */
  steps: Record<string, string>;
  flags: RunFlag[];
  startedAt: string;
  finishedAt: string;
};
export type WorkflowBatch = {
  id: string;
  name: string;
  recipeHash: string;
  createdAt: string;
  state: 'running' | 'complete' | 'cancelled';
  runs: WorkflowRun[];
};
/** Exact workflow text used by batches, for provenance and re-runs. */
export type WorkflowRecipeRecord = {
  hash: string;
  name: string;
  revision?: string;
  text: string;
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
