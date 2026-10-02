import type { ReportBlock } from './report-mockup';

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
};

export type ReportBuilderHandle = {
  addAssets: (ids: string[]) => Promise<void>;
  addBlocks: (blocks: ReportBlock[]) => void;
  /** The current draft, for saving it as a workflow report template. */
  getReport: () => import('./report-mockup').ReportDocument;
  /** Replace the draft (undoable within Reports), such as a rendered item report. */
  loadReport: (report: import('./report-mockup').ReportDocument) => void;
};
