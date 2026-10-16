'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import type { BatchProgress } from '@/components/workflow-batch-view';
import { prepareItems, type BatchPlan } from '@/components/workflow-run-dialog';
import { formatCount } from '@/lib/format-count';
import { randomId } from '@/lib/random-id';
import type { Project } from '@/lib/signal-types';
import {
  batchSummaryCsv,
  downloadBlob,
  mappedChannels,
  storeBatchView,
  storedBatchView,
  type PreflightItem,
} from '@/lib/workflow-batch';
import {
  batchRecipe,
  chooseFolder,
  exportRunReports,
} from '@/lib/workflow-batch-report';
import {
  isFlagged,
  liveRunStatus,
  runEdited,
  runProblems,
} from '@/lib/workflow-checks';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowBatch, WorkflowRun } from '@/lib/workflow-types';
import { YAML_LIMITS } from '@/lib/workflow-yaml';
import {
  componentFiles,
  EOL_WORKFLOW,
  EOL_WORKFLOW_NAME,
} from '@/lib/eol-example';

/**
 * Batch workflows: the Run dialog, running a batch with live progress and
 * cancellation, report and summary export, and the batch results view,
 * reopened after a reload (device-local).
 */
export function useWorkflowBatches({
  project,
  index,
  engine,
  sourceId,
  scopeBatch,
  itemRun,
  setSourceId,
  onStart,
  setNotice,
  announceChange,
}: {
  project: Project;
  index: WorkflowIndex;
  engine: SignalEngineState;
  sourceId: string;
  /** The batch History is scoped to, if any. */
  scopeBatch?: WorkflowBatch;
  /** The batch item of the recording History is scoped to, if any. */
  itemRun?: { batch: WorkflowBatch; run: WorkflowRun };
  setSourceId: (id: string) => void;
  /** Clears the selection, searches and checks as a batch starts. */
  onStart: () => void;
  setNotice: (notice: string) => void;
  announceChange: (message: string) => void;
}) {
  const request = engine.request;
  // Batch workflows: dialogs, live progress and report export.
  const [batchPanel, setBatchPanel] = useState(true);
  const [runDialog, setRunDialog] = useState<{
    key: number;
    text?: string;
    name?: string;
    items: PreflightItem[];
  } | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress>();
  const batchStop = useRef(false);
  const [reportJob, setReportJob] = useState<{
    done: number;
    total: number;
    item: string;
  }>();
  const reportAbort = useRef<AbortController | null>(null);
  const runDialogKey = useRef(0);
  async function openRunDialog(
    text?: string,
    name?: string,
    files: File[] = [],
  ) {
    const items = await prepareItems(text, files);
    runDialogKey.current++;
    setRunDialog({ key: runDialogKey.current, text, name, items });
  }
  async function openWorkflowFile(file: File, recordings: File[] = []) {
    if (file.size > YAML_LIMITS.bytes) {
      setNotice('Workflow files are limited to 8 MiB.');
      return;
    }
    await openRunDialog(await file.text(), file.name, recordings);
  }
  function openBatchExample() {
    void openRunDialog(EOL_WORKFLOW, EOL_WORKFLOW_NAME, componentFiles());
  }
  async function exportReports(
    snapshot: Project,
    batch: WorkflowBatch,
    runs: WorkflowRun[],
    mode: 'zip' | 'folder' = 'zip',
  ) {
    if (reportAbort.current || !runs.length) return;
    let folder;
    if (mode === 'folder') {
      try {
        folder = await chooseFolder();
      } catch {
        return; // The folder picker was dismissed.
      }
    }
    const controller = new AbortController();
    reportAbort.current = controller;
    setReportJob({ done: 0, total: runs.length, item: runs[0].itemId });
    try {
      const result = await exportRunReports({
        project: snapshot,
        batch,
        runs,
        request,
        folder,
        signal: controller.signal,
        progress: (done, total, item) => setReportJob({ done, total, item }),
      });
      if (result.zip) downloadBlob(result.zip, `${batch.name} · reports.zip`);
      setNotice(
        `${result.written} ${result.written === 1 ? 'report' : 'reports'} ${folder ? 'saved to the chosen folder' : 'downloaded as a ZIP'}.`,
      );
    } catch (error) {
      setNotice(
        controller.signal.aborted
          ? 'Report export cancelled. Nothing was downloaded.'
          : error instanceof Error
            ? error.message
            : 'Reports could not be exported.',
      );
    } finally {
      reportAbort.current = null;
      setReportJob(undefined);
    }
  }
  function exportSummary(snapshot: Project, batch: WorkflowBatch) {
    downloadBlob(
      new Blob([batchSummaryCsv(snapshot, batch)], { type: 'text/csv' }),
      `${batch.name} · summary.csv`,
    );
  }
  async function runBatch(plan: BatchPlan) {
    setRunDialog(null);
    if (engine.busy) return;
    const batchId = randomId();
    const failures: { name: string; message: string }[] = [];
    let cancelled = false;
    batchStop.current = false;
    setBatchProgress({
      batchId,
      name: plan.batchName,
      startedAt: new Date().toISOString(),
      done: 0,
      total: plan.items.length,
      current: plan.items[0]?.name ?? '',
      failures: [],
    });
    setSourceId(`batch:${batchId}`);
    setBatchPanel(true);
    onStart();
    await engine.sequence(
      plan.items.map((item) => ({
        type: 'run-workflow' as const,
        recipe: plan.recipeText,
        batchId,
        batchName: plan.batchName,
        itemId: item.itemId,
        file: item.file,
        ...(item.table !== undefined ? { table: item.table } : {}),
        sourceId: item.sourceId,
        ...(Object.keys(item.mapping).length
          ? { channelMap: item.mapping }
          : {}),
      })),
      plan.items.map(
        (item, position) =>
          `Processing ${item.itemId} · ${position + 1} of ${plan.items.length}`,
      ),
      (position, result) => {
        if (result.error) {
          if (batchStop.current || /cancelled/i.test(result.error.message)) {
            cancelled = true;
            return false;
          }
          failures.push({
            name: plan.items[position].name,
            message: result.error.message,
          });
        }
        setBatchProgress(
          (old) =>
            old && {
              ...old,
              done: position + 1,
              current: plan.items[position + 1]?.name ?? '',
              failures: [...failures],
            },
        );
        if (batchStop.current) {
          cancelled = true;
          return false;
        }
      },
    );
    let finished: Project | undefined;
    try {
      finished = await engine.mutate(
        {
          type: 'finish-batch',
          batchId,
          state: cancelled ? 'cancelled' : 'complete',
          failures,
        },
        'Finishing batch…',
      );
    } catch {
      finished = undefined;
    }
    setBatchProgress(undefined);
    const batch = finished?.workflowBatches?.find(
      (item) => item.id === batchId,
    );
    if (!finished || !batch) {
      setSourceId('all');
      setNotice(
        cancelled
          ? 'Batch cancelled before any recording was processed. Nothing was added.'
          : `No recordings were processed. ${failures[0] ? `${failures[0].name}: ${failures[0].message}` : ''}`,
      );
      return;
    }
    const steps = new Map(
      (finished.workflowSteps ?? []).map((item) => [item.id, item]),
    );
    const flagged = batch.runs.filter((run) =>
      isFlagged(liveRunStatus(run, steps)),
    ).length;
    announceChange(
      `${cancelled ? 'Batch cancelled · ' : ''}${formatCount(batch.runs.length, 'recording')} processed · ${flagged} flagged${failures.length ? ` · ${failures.length} not imported` : ''}.`,
    );
    if (plan.exportSummary) exportSummary(finished, batch);
    if (plan.exportReports && !cancelled)
      await exportReports(finished, batch, batch.runs);
  }
  function cancelBatch() {
    batchStop.current = true;
    engine.cancel();
  }
  const itemBatch = itemRun?.batch;
  const itemLabel = useMemo(() => {
    if (!itemBatch) return 'Item';
    try {
      return batchRecipe(project, itemBatch).recipe.item.label;
    } catch {
      return 'Item';
    }
  }, [project, itemBatch]);
  const itemInfo = itemRun && {
    label: itemLabel,
    status: liveRunStatus(itemRun.run, index.steps),
    problems: runProblems(itemRun.run, index.steps),
    edited: runEdited(itemRun.run, index.steps),
    mapped: mappedChannels(
      project.workflowRecipes?.find(
        (recipe) => recipe.hash === itemRun.batch.recipeHash,
      )?.text,
      itemRun.run,
    ),
  };
  // Until its first item commits, a starting batch is shown from its progress.
  const displayBatch: WorkflowBatch | undefined =
    scopeBatch ??
    (batchProgress && sourceId === `batch:${batchProgress.batchId}`
      ? {
          id: batchProgress.batchId,
          name: batchProgress.name,
          recipeHash: '',
          createdAt: batchProgress.startedAt,
          state: 'running',
          runs: [],
        }
      : undefined);
  const batchShown = !!displayBatch && batchPanel;
  // Reopen the batch results that were open before a reload (device-local).
  const batchViewRestored = useRef(false);
  useEffect(() => {
    if (batchViewRestored.current || !engine.ready) return;
    batchViewRestored.current = true;
    const id = storedBatchView();
    if (id && (project.workflowBatches ?? []).some((item) => item.id === id))
      queueMicrotask(() => {
        setSourceId(`batch:${id}`);
        setBatchPanel(true);
      });
  }, [engine.ready, project, setSourceId]);
  const openBatchId = batchShown && scopeBatch ? scopeBatch.id : '';
  useEffect(() => {
    if (batchViewRestored.current) storeBatchView(openBatchId);
  }, [openBatchId]);
  const canReport = (batch: WorkflowBatch) => {
    try {
      return !!batchRecipe(project, batch).recipe.report;
    } catch {
      return false;
    }
  };
  return {
    batchPanel,
    setBatchPanel,
    runDialog,
    setRunDialog,
    batchProgress,
    reportJob,
    cancelReports: () => reportAbort.current?.abort(),
    displayBatch,
    batchShown,
    canReport,
    openRunDialog,
    openWorkflowFile,
    openBatchExample,
    exportReports,
    exportSummary,
    runBatch,
    cancelBatch,
    itemInfo,
  };
}
