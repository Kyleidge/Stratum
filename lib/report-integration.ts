import type { ReportBlock, ReportDocument } from './report-mockup';
import type { ReportSnapshotState } from './report-data';

/** References into the current workspace; report content is captured explicitly. */
export type ReportAsset = {
  id: string;
  kind: 'signal' | 'value' | 'values' | 'plot' | 'checks';
  name: string;
  detail: string;
  outputIds: string[];
};

export type ReportWorkspace = {
  assets: ReportAsset[];
  selectionIds: string[];
  busy: boolean;
  /** Identity changes with workspace mutations, so pending captures can be discarded. */
  revision: object;
  resolveAssets: (
    ids: string[],
    signal?: AbortSignal,
  ) => Promise<ReportBlock[]>;
  resolveDrop: (raw: string) => string[];
  /** Compares captures with the current workspace; never refreshes them. */
  snapshotStates?: (
    sources: readonly NonNullable<ReportBlock['source']>[],
  ) => ReportSnapshotState[];
};

/** A read-only report shown beside the draft, such as one batch item's report. */
export type ReportPreview = {
  report: ReportDocument;
  /** Names the preview, such as `Item SN-24001`. */
  label: string;
  /** Returns to where the preview was opened, such as the batch results. */
  back?: { label: string; run: () => void };
};

export type ReportBuilderHandle = {
  addAssets: (ids: string[]) => Promise<void>;
  addBlocks: (blocks: ReportBlock[]) => void;
  /** The current draft, for saving it as a workflow report template. */
  getReport: () => ReportDocument;
  /** Replace the draft (undoable within Reports). */
  loadReport: (report: ReportDocument) => void;
  /** Show a read-only report without touching the draft; it can be copied into the draft. */
  previewReport: (preview: ReportPreview) => void;
};
