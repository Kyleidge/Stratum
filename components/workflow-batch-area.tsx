'use client';
import { ListChecks } from 'lucide-react';
import type { useWorkflowBatches } from '@/hooks/use-workflow-batches';
import { formatCount } from '@/lib/format-count';
import type { Project } from '@/lib/signal-types';
import type { WorkflowBatch, WorkflowRun } from '@/lib/workflow-types';
import WorkflowBatchView, { type BatchProgress } from './workflow-batch-view';
import WorkflowItemBar from './workflow-item-bar';

/**
 * Above Active: the open batch's results, or a bar that reopens them, and
 * the bar of the batch item History is scoped to.
 */
export default function WorkflowBatchArea({
  project,
  busy,
  displayBatch,
  batchShown,
  batchPanel,
  setBatchPanel,
  batchProgress,
  reportJob,
  canReport,
  openItem,
  cancelBatch,
  exportSummary,
  exportReports,
  previewReport,
  plotAcross,
  cancelReports,
  itemRun,
  itemInfo,
  stepItem,
  switchSource,
}: {
  project: Project;
  busy: boolean;
  /** The batch History is scoped to, or one starting. */
  displayBatch?: WorkflowBatch;
  /** The batch results are shown in place of the plots. */
  batchShown: boolean;
  batchPanel: boolean;
  setBatchPanel: (open: boolean) => void;
  batchProgress?: BatchProgress;
  reportJob?: { done: number; total: number; item: string };
  canReport: (batch: WorkflowBatch) => boolean;
  openItem: (run: WorkflowRun) => void;
  cancelBatch: () => void;
  exportSummary: (snapshot: Project, batch: WorkflowBatch) => void;
  exportReports: (
    snapshot: Project,
    batch: WorkflowBatch,
    runs: WorkflowRun[],
    mode?: 'zip' | 'folder',
  ) => Promise<void>;
  previewReport: (batch: WorkflowBatch, run: WorkflowRun) => Promise<void>;
  plotAcross: (recipeStepId: string, runs: WorkflowRun[]) => void;
  cancelReports: () => void;
  /** The batch item of the recording History is scoped to, if any. */
  itemRun?: { batch: WorkflowBatch; run: WorkflowRun };
  itemInfo: ReturnType<typeof useWorkflowBatches>['itemInfo'];
  stepItem: (offset: -1 | 1) => void;
  switchSource: (id: string) => void;
}) {
  return (
    <>
      {displayBatch && batchShown && (
        <WorkflowBatchView
          project={project}
          batch={displayBatch}
          progress={batchProgress}
          busy={busy || !!reportJob}
          canReport={canReport(displayBatch)}
          onOpen={(run) => openItem(run)}
          onClose={() => setBatchPanel(false)}
          onCancel={cancelBatch}
          onExportSummary={() => exportSummary(project, displayBatch)}
          onExportReports={(runs, mode) =>
            void exportReports(project, displayBatch, runs, mode)
          }
          onPreviewReport={(run) => void previewReport(displayBatch, run)}
          onPlotAcross={plotAcross}
          reportJob={reportJob}
          onCancelReports={cancelReports}
        />
      )}
      {displayBatch && !batchPanel && (
        <section className="workflow-item-bar" aria-label="Batch">
          <ListChecks size={14} />
          <span className="workflow-item-bar-name">
            <strong>{displayBatch.name}</strong>
            <small>
              {formatCount(displayBatch.runs.length, 'item')} in History
            </small>
          </span>
          <span className="workflow-item-bar-problem" />
          <button
            className="secondary-button"
            onClick={() => setBatchPanel(true)}
          >
            <ListChecks size={14} /> Batch results
          </button>
        </section>
      )}
      {itemRun && itemInfo && (
        <WorkflowItemBar
          batch={itemRun.batch}
          run={itemRun.run}
          itemLabel={itemInfo.label}
          status={itemInfo.status}
          problems={itemInfo.problems}
          edited={itemInfo.edited}
          mapped={itemInfo.mapped}
          onStep={stepItem}
          onBatch={() => switchSource(`batch:${itemRun.batch.id}`)}
        />
      )}
    </>
  );
}
