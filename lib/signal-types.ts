import type {
  FunctionRun,
  RegionExample,
  RegionPlan,
  RegionRequest,
  RegionSet,
} from './region-types';
import type {
  ScalarValue,
  ValueOperation,
  WorkflowStep,
} from './workflow-types';

export type Operation =
  | keyof typeof import('./time-types').TIME_OPERATIONS
  | 'raw'
  | 'crop'
  | 'smooth'
  | 'median'
  | 'exponential'
  | 'low-pass'
  | 'high-pass'
  | 'scale'
  | 'offset'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'absolute'
  | 'derivative'
  | 'integral'
  | 'min-max'
  | 'time-shift'
  | 'zero-time'
  | 'resample'
  | 'power'
  | 'bsfc';
export type SignalNode = {
  timeReference?: import('./time-types').TimeReference;
  timeRecipe?: import('./time-types').TimeRecipe;
  id: string;
  name: string;
  unit: string;
  /** Empty for workspace outputs; provenance is the complete parent graph. */
  sourceId: string;
  parents: string[];
  operation: Operation;
  parameters: Record<string, number>;
  channel?: number;
  color: string;
  createdAt: string;
  version: 1;
  batchId?: string;
  internal?: boolean;
};
export type Source = {
  id: string;
  name: string;
  rows: number;
  chunks: number;
  bytes: number;
  start: number;
  end: number;
  channels: string[];
  synthetic: boolean;
  exampleKey?: string;
  chunkRanges: [number, number][];
};
export type Segment = {
  id: string;
  name: string;
  sourceId: string;
  start: number;
  end: number;
  nodes: string[];
  batchId?: string;
  scope?: SegmentationScope;
  definition?: SegmentationDefinition;
  boundary?: SegmentBoundary;
  // Original prototype records retain their legacy provenance when reopened.
  triggerId?: string;
  threshold?: number;
  minimumDuration?: number;
};
export type SegmentationScope = 'file' | 'signals';
export type SegmentationOperation = {
  id: string;
  sourceId: string;
  definition?: SegmentationDefinition; // Missing only for early legacy records.
  targetIds: string[];
  independently: boolean;
  scope: SegmentationScope;
  segmentIds: string[];
};
export type EdgeTrigger = {
  signalId: string;
  edge: 'rising' | 'falling';
  threshold: number;
  offset: number;
};
export type SegmentationDefinition = (
  | {
      method: 'triggers';
      start: EdgeTrigger;
      end: EdgeTrigger;
      minimumDuration: number;
    }
  | { method: 'ranges'; ranges: [number, number][] }
  | {
      method: 'windows';
      start: number;
      end: number;
      duration: number;
      step: number;
      includePartial: boolean;
    }
) & { boundary: 'clip' | 'discard' };
export type SegmentBoundary = {
  inputId?: string;
  start: number;
  end: number;
  requestedStart: number;
  requestedEnd: number;
  startTrigger?: number;
  endTrigger?: number;
  clipped: boolean;
};
export type SegmentationPlan = {
  ranges: SegmentBoundary[];
  skipped: number;
  incomplete: number;
};
export type Project = {
  labels?: Record<string, string>;
  workflowSteps?: WorkflowStep[];
  values?: ScalarValue[];
  sources: Source[];
  nodes: SignalNode[];
  segments: Segment[];
  segmentationOperations?: SegmentationOperation[];
  examples?: ExampleRun[];
  regionSets?: RegionSet[];
  functionRuns?: FunctionRun[];
  regionExamples?: RegionExample[];
  workflowRecipes?: import('./workflow-types').WorkflowRecipeRecord[];
  workflowBatches?: import('./workflow-types').WorkflowBatch[];
};
export type ExampleRun = {
  key: string;
  sourceId: string;
  segmentationId: string;
  outputIds: string[];
};
export type Chunk = { time: Float64Array; values: Float64Array[] };
export type SeriesChunk = { time: Float64Array; values: Float64Array };
export type Point = [number, number];
export type Summary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  integral: number;
  start: number;
  end: number;
  weightedMean?: number;
};
export type Plot = { id: string; points: Point[]; summary: Summary };
export type EngineRequest =
  | { type: 'time-operation'; settings: import('./time-types').TimeSettings }
  | { type: 'delete-operation'; stepId: string }
  | {
      type: 'edit-operation';
      stepId: string;
      command: import('./workflow-lifecycle').WorkflowCommand;
    }
  | { type: 'rename'; id: string; name: string }
  | {
      type: 'run-workflow';
      /** Workflow file text; the worker validates it again. */
      recipe: string;
      batchId: string;
      batchName: string;
      itemId: string;
      file?: File;
      sourceId?: string;
    }
  | {
      type: 'finish-batch';
      batchId: string;
      state: 'complete' | 'cancelled';
    }
  | {
      type: 'set-checks';
      stepId: string;
      checks: import('./workflow-types').CheckDefinition[];
    }
  | { type: 'undo' | 'redo' | 'backup-workspace' }
  | { type: 'demo-workflow'; refresh?: boolean; sourceId?: string }
  | { type: 'restore-workspace'; file: File }
  | RegionRequest
  | { type: 'init-workflow'; refreshExample?: boolean }
  | { type: 'calculate-values'; inputIds: string[]; operation: ValueOperation }
  | { type: 'init' }
  | { type: 'import'; file: File }
  | { type: 'demo' }
  | { type: 'example'; key: string }
  | {
      type: 'derive';
      parentId: string;
      operation: Operation;
      parameter: number;
    }
  | {
      type: 'derive-many';
      parentIds: string[];
      operation: Operation;
      parameter: number;
    }
  | {
      type: 'segment' | 'segment-preview';
      sourceId: string;
      definition: SegmentationDefinition;
      targetIds: string[];
      independently?: boolean;
      scope?: SegmentationScope;
    }
  | { type: 'segment-metrics'; ids: string[] }
  | {
      type: 'view';
      ids: string[];
      range?: [number, number];
      ranges?: Record<string, [number, number]>;
      inspection?: boolean;
    }
  | {
      type: 'measure-plot';
      items: { id: string; a: number; b: number }[];
      inspection?: boolean;
    }
  | { type: 'rows'; id: string; offset: number; inspection?: boolean }
  | { type: 'sample-count'; id: string | null; inspection?: boolean }
  | { type: 'export'; ids: string[] }
  | { type: 'export-samples'; ids: string[] }
  | { type: 'cancel'; requestIds?: number[] };
export type EngineResponse = { requestId: number } & (
  | { type: 'region-plan'; plan: RegionPlan }
  | { type: 'project'; project: Project; canUndo?: boolean; canRedo?: boolean }
  | { type: 'segment-plan'; plan: SegmentationPlan }
  | { type: 'plots'; plots: Plot[] }
  | {
      type: 'plot-measurements';
      measurements: import('./plot-measurement').PlotMeasurement[];
    }
  | { type: 'rows'; rows: Point[]; hasMore: boolean }
  | { type: 'sample-count'; count: number | null }
  | { type: 'export'; blob: Blob }
  | { type: 'progress'; message: string; progress: number }
  | { type: 'error'; message: string }
);
