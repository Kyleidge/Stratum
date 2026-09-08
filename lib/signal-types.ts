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
  definition?: SegmentationDefinition;
  boundary?: SegmentBoundary;
  // Original prototype records retain their legacy provenance when reopened.
  triggerId?: string;
  threshold?: number;
  minimumDuration?: number;
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
  sources: Source[];
  nodes: SignalNode[];
  segments: Segment[];
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
  | { type: 'init' }
  | { type: 'import'; file: File }
  | { type: 'demo' }
  | {
      type: 'derive';
      parentId: string;
      operation: Operation;
      parameter: number;
    }
  | {
      type: 'segment' | 'segment-preview';
      sourceId: string;
      definition: SegmentationDefinition;
      targetIds: string[];
    }
  | { type: 'segment-metrics'; ids: string[] }
  | { type: 'view'; ids: string[]; range?: [number, number] }
  | { type: 'rows'; id: string; offset: number }
  | { type: 'export'; ids: string[] }
  | { type: 'cancel' };
export type EngineResponse = { requestId: number } & (
  | { type: 'project'; project: Project }
  | { type: 'segment-plan'; plan: SegmentationPlan }
  | { type: 'plots'; plots: Plot[] }
  | { type: 'rows'; rows: Point[]; hasMore: boolean }
  | { type: 'export'; blob: Blob }
  | { type: 'progress'; message: string; progress: number }
  | { type: 'error'; message: string }
);
