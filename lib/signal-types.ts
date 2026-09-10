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
  | 'raw'
  | 'crop'
  | 'smooth'
  | 'median'
  | 'exponential'
  | 'low-pass'
  | 'high-pass'
  | 'scale'
  | 'offset'
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
  id: string;
  name: string;
  unit: string;
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
  | RegionRequest
  | { type: 'init-workflow' }
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
  | { type: 'view'; ids: string[]; range?: [number, number] }
  | { type: 'rows'; id: string; offset: number }
  | { type: 'export'; ids: string[] }
  | { type: 'export-samples'; ids: string[] }
  | { type: 'cancel' };
export type EngineResponse = { requestId: number } & (
  | { type: 'region-plan'; plan: RegionPlan }
  | { type: 'project'; project: Project }
  | { type: 'segment-plan'; plan: SegmentationPlan }
  | { type: 'plots'; plots: Plot[] }
  | { type: 'rows'; rows: Point[]; hasMore: boolean }
  | { type: 'export'; blob: Blob }
  | { type: 'progress'; message: string; progress: number }
  | { type: 'error'; message: string }
);
