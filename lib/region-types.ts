import type {
  Operation,
  SegmentationDefinition,
  SegmentBoundary,
} from './signal-types';

export type Region = {
  id: string;
  name: string;
  start: number;
  end: number;
  endInclusive: boolean;
  parentRegionId?: string;
  boundary?: SegmentBoundary;
};
export type RegionSettings = {
  sourceId: string;
  name: string;
  definition: SegmentationDefinition;
  parentSetId?: string;
  parentRegionIds?: string[];
  timeReference: 'recording' | 'parent';
  previousId?: string;
};
export type RegionSet = RegionSettings & {
  id: string;
  version: number;
  sequence: number;
  createdAt: string;
  regions: Region[];
};
export type RegionPlan = {
  regions: Omit<Region, 'id' | 'name'>[];
  skipped: number;
  incomplete: number;
};
export type FunctionSettings = {
  sourceId: string;
  operation: Operation;
  parameter: number;
  inputIds: string[];
  secondaryIds?: string[];
  regionSetId?: string;
  regionIds?: string[];
};
export type FunctionOutput = {
  signalId: string;
  inputId: string;
  regionId?: string;
};
export type FunctionRun = FunctionSettings & {
  id: string;
  sequence: number;
  createdAt: string;
  outputs: FunctionOutput[];
  skipped: number;
};
export type RegionExample = {
  key: string;
  sourceId: string;
  regionSetId: string;
  runId?: string;
};
export type RegionRequest =
  | { type: 'init-regions' }
  | { type: 'region-preview' | 'region-create'; settings: RegionSettings }
  | { type: 'region-function'; settings: FunctionSettings }
  | { type: 'region-example'; key: string };

export const REGION_EXAMPLES = [
  { key: 'ramps', name: 'Ramps → Filter → Average → Min / Max' },
  { key: 'nested', name: 'Segment a segment · 10-second windows' },
  { key: 'overlap', name: 'Overlapping windows · independent processing' },
  { key: 'fuel', name: 'Power and fuel consumption within ramps' },
] as const;
