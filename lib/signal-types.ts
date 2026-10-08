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
  | 'bsfc'
  | 'formula'
  | 'convert'
  | 'butterworth-low'
  | 'butterworth-high';
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
  /** Settings taken from values; `parameters` holds their results. */
  bindings?: Record<string, import('./workflow-types').BoundValue>;
  /**
   * Formula nodes: the expression. Parents are its signal variables in
   * alphabetical order (A first); `parameters` holds its value variables.
   */
  expression?: string;
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
/**
 * A formula's expression and its other signal variables: each letter's
 * candidates, of which the one on each input's sample grid is used.
 */
export type FormulaSettings = {
  expression: string;
  signals?: Record<string, string[]>;
};
export type EdgeTrigger = {
  signalId: string;
  edge: 'rising' | 'falling';
  threshold: number;
  offset: number;
  /**
   * Re-arm distance in the signal's unit: after a crossing, the signal must
   * return past threshold ∓ hysteresis before the next one counts.
   */
  hysteresis?: number;
  /** Seconds the signal must stay crossed before a crossing counts. */
  debounce?: number;
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
) & {
  boundary: 'clip' | 'discard';
  /**
   * Trigger settings taken from values: `start.threshold`, `end.threshold`,
   * `start.offset` and `end.offset`. The saved numbers are their results.
   */
  bindings?: import('./workflow-types').ParameterBindings;
};
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
/** An unsaved derive candidate, evaluated for a dialog preview. */
export type DerivePreview = {
  node: SignalNode;
  plot: Plot;
  /** Input envelopes in operation order (A, then B), each on its own axis. */
  inputs: Plot[];
  /** Union of the candidate's and its inputs' time ranges. */
  domain: [number, number];
};
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
      /** The group of a multi-group file chosen in pre-flight. */
      table?: number;
      sourceId?: string;
      /** Pre-flight column choices for missing channels: alias → column. */
      channelMap?: Record<string, string>;
    }
  | {
      type: 'finish-batch';
      batchId: string;
      state: 'complete' | 'cancelled';
      failures?: { name: string; message: string }[];
    }
  | {
      type: 'set-checks';
      stepId: string;
      checks: import('./workflow-types').CheckDefinition[];
    }
  | { type: 'undo' | 'redo' }
  | {
      type: 'backup-workspace';
      /** A native file stream; without one the reply is a capped Blob. */
      stream?: WritableStream<Uint8Array>;
    }
  | { type: 'demo-workflow'; refresh?: boolean; sourceId?: string }
  | {
      type: 'restore-workspace';
      /** A chosen File (browser, 128 MiB) or a native file stream. */
      file: Blob | ReadableStream<Uint8Array>;
    }
  | RegionRequest
  | { type: 'init-workflow'; refreshExample?: boolean }
  | {
      type: 'calculate-values';
      inputIds: string[];
      operation: ValueOperation;
      parameters?: import('./workflow-types').ValueParameters;
      /** Settings taken from other values; they replace `parameters`. */
      bindings?: import('./workflow-types').ParameterBindings;
    }
  | { type: 'init' }
  | { type: 'import'; file: File; tables?: number[] }
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
      /**
       * `value`: the parameter taken from values for each input; for a
       * formula, its value variables by name.
       */
      bindings?: import('./workflow-types').ParameterBindings;
      /** The output unit of a formula, or the target unit of a conversion. */
      unit?: string;
      formula?: FormulaSettings;
    }
  | {
      type: 'segment' | 'segment-preview';
      sourceId: string;
      definition: SegmentationDefinition;
      targetIds: string[];
      independently?: boolean;
      scope?: SegmentationScope;
      inspection?: boolean;
    }
  | {
      type: 'derive-preview';
      inputId: string;
      operation: Operation;
      parameter: number;
      bindings?: import('./workflow-types').ParameterBindings;
      unit?: string;
      formula?: FormulaSettings;
      secondaryId?: string;
      range?: [number, number];
      inspection?: boolean;
    }
  | {
      type: 'value-preview';
      ids: string[];
      /** A parameterised calculation to evaluate with the statistics. */
      operation?: ValueOperation;
      parameters?: import('./workflow-types').ValueParameters;
      bindings?: import('./workflow-types').ParameterBindings;
      inspection?: boolean;
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
  | {
      type: 'export-samples';
      ids: string[];
      /** A native file stream; without one the reply is a capped Blob. */
      stream?: WritableStream<Uint8Array>;
    }
  | { type: 'cancel'; requestIds?: number[] };
export type EngineResponse = { requestId: number } & (
  | { type: 'region-plan'; plan: RegionPlan }
  | {
      type: 'project';
      project: Project;
      /** Committed metadata revision; it changes with every save. */
      revision?: number;
      canUndo?: boolean;
      canRedo?: boolean;
      /** What Undo/Redo would reverse or repeat; absent when unnamed. */
      undoLabel?: string;
      redoLabel?: string;
    }
  | { type: 'segment-plan'; plan: SegmentationPlan }
  | { type: 'derive-preview'; preview: DerivePreview }
  | {
      type: 'value-preview';
      statistics: import('./workflow-types').ValueStatistics[];
    }
  | { type: 'plots'; plots: Plot[] }
  | {
      type: 'plot-measurements';
      measurements: import('./plot-measurement').PlotMeasurement[];
    }
  | { type: 'rows'; rows: Point[]; hasMore: boolean }
  | { type: 'sample-count'; count: number | null }
  | { type: 'export'; blob: Blob }
  /** A stream request finished; `revision` is the state that was written. */
  | { type: 'written'; bytes: number; revision: number }
  | { type: 'progress'; message: string; progress: number }
  | { type: 'error'; message: string }
);
