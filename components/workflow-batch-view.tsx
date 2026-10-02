'use client';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChartNoAxesCombined,
  CheckCircle2,
  Download,
  FileText,
  Pencil,
  XCircle,
  OctagonX,
} from 'lucide-react';
import { WorkflowIndex } from '@/lib/workflow-history';
import {
  liveRunStatus,
  runEdited,
  runProblems,
  STATUS_LABELS,
  formatNumber,
} from '@/lib/workflow-checks';
import { batchColumns, columnValue } from '@/lib/workflow-batch';
import { parseWorkflow } from '@/lib/workflow-recipe';
import type { Project } from '@/lib/signal-types';
import type {
  RunStatus,
  WorkflowBatch,
  WorkflowRun,
} from '@/lib/workflow-types';

const PAGE = 30;
const COLUMNS = 8;
export type BatchProgress = {
  batchId: string;
  name: string;
  startedAt: string;
  done: number;
  total: number;
  current: string;
  failures: { name: string; message: string }[];
};
type Filter = 'all' | 'flagged' | 'fail' | 'error';

export function StatusIcon({
  status,
  size = 14,
}: {
  status: RunStatus;
  size?: number;
}) {
  const Icon =
    status === 'pass'
      ? CheckCircle2
      : status === 'warning'
        ? AlertTriangle
        : status === 'fail'
          ? XCircle
          : OctagonX;
  return (
    <Icon
      size={size}
      className="workflow-status-icon"
      data-status={status}
      aria-label={STATUS_LABELS[status]}
    />
  );
}

/** Batch results in Data Inspector: one row per item with status and values. */
export default function WorkflowBatchView({
  project,
  batch,
  progress,
  busy,
  canReport,
  onOpen,
  onClose,
  onCancel,
  onExportSummary,
  onExportReports,
  onPreviewReport,
  onPlotAcross,
  reportJob,
  onCancelReports,
}: {
  project: Project;
  batch: WorkflowBatch;
  progress?: BatchProgress;
  busy: boolean;
  canReport: boolean;
  onOpen: (run: WorkflowRun) => void;
  onClose: () => void;
  onCancel: () => void;
  onExportSummary: () => void;
  onExportReports: (runs: WorkflowRun[], mode: 'zip' | 'folder') => void;
  onPreviewReport: (run: WorkflowRun) => void;
  onPlotAcross: (recipeStepId: string, runs: WorkflowRun[]) => void;
  reportJob?: { done: number; total: number; item: string };
  onCancelReports: () => void;
}) {
  const index = useMemo(() => new WorkflowIndex(project), [project]);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [plotStep, setPlotStep] = useState('');
  const recipe = project.workflowRecipes?.find(
    (item) => item.hash === batch.recipeHash,
  );
  const itemLabel = useMemo(() => {
    try {
      return recipe ? parseWorkflow(recipe.text).item.label : 'Item';
    } catch {
      return 'Item';
    }
  }, [recipe]);
  const rows = useMemo(
    () =>
      batch.runs.map((run) => ({
        run,
        status: liveRunStatus(run, index.steps),
        problems: runProblems(run, index.steps),
        edited: runEdited(run, index.steps),
      })),
    [batch, index],
  );
  const columns = useMemo(
    () => batchColumns(project, batch).slice(0, COLUMNS),
    [project, batch],
  );
  const counts = rows.reduce(
    (total, row) => ({ ...total, [row.status]: total[row.status] + 1 }),
    { pass: 0, warning: 0, fail: 0, error: 0 } as Record<RunStatus, number>,
  );
  const shown = rows.filter(
    (row) =>
      filter === 'all' ||
      (filter === 'flagged' ? row.status !== 'pass' : row.status === filter),
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages - 1);
  // Signal steps that every item can plot together.
  const signalSteps = useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of batch.runs)
      for (const [recipeStepId, stepId] of Object.entries(run.steps)) {
        const step = index.steps.get(stepId);
        if (step && step.kind !== 'value' && !seen.has(recipeStepId))
          seen.set(recipeStepId, step.name ?? recipeStepId);
      }
    return [...seen];
  }, [batch, index]);
  const chosenPlot = signalSteps.some(([id]) => id === plotStep)
    ? plotStep
    : (signalSteps[0]?.[0] ?? '');
  const running = progress?.batchId === batch.id;
  const folderSupported =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  return (
    <section className="workflow-batch-view" aria-label="Batch results">
      <header className="workflow-batch-header">
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label="Back to plots"
          title="Back to plots"
          onClick={onClose}
        >
          <ArrowLeft size={15} />
        </button>
        <div>
          <h2>{batch.name}</h2>
          <small>
            {recipe?.name ?? 'Workflow'}
            {recipe?.revision ? ` · revision ${recipe.revision}` : ''} · SHA-256{' '}
            <code title={batch.recipeHash}>
              {batch.recipeHash.slice(0, 12)}
            </code>{' '}
            · {new Date(batch.createdAt).toLocaleString()} ·{' '}
            {running
              ? `processing ${progress.done + 1} of ${progress.total}`
              : batch.state === 'running'
                ? 'interrupted'
                : batch.state}
          </small>
        </div>
        <div className="workflow-batch-header-actions">
          {running ? (
            <button className="secondary-button" onClick={onCancel}>
              Cancel batch
            </button>
          ) : (
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={onExportSummary}
              >
                <Download size={14} /> Summary CSV
              </button>
              <button
                className="secondary-button"
                disabled={busy || !canReport || !shown.length}
                title={
                  canReport
                    ? `One PDF for each of the ${shown.length} items shown, in a ZIP`
                    : 'This workflow has no report template'
                }
                onClick={() =>
                  onExportReports(
                    shown.map((row) => row.run),
                    'zip',
                  )
                }
              >
                <FileText size={14} /> Export {shown.length}{' '}
                {shown.length === 1 ? 'report' : 'reports'}
              </button>
              {folderSupported && (
                <button
                  className="workflow-link"
                  disabled={busy || !canReport || !shown.length}
                  title="Write each PDF straight into a folder you choose"
                  onClick={() =>
                    onExportReports(
                      shown.map((row) => row.run),
                      'folder',
                    )
                  }
                >
                  To a folder…
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {reportJob && (
        <output className="workflow-batch-progress">
          <progress value={reportJob.done} max={reportJob.total} />
          <span>
            Creating report {Math.min(reportJob.done + 1, reportJob.total)} of{' '}
            {reportJob.total}
            {reportJob.item ? ` · ${reportJob.item}` : ''}
          </span>
          <button className="workflow-link" onClick={onCancelReports}>
            Cancel
          </button>
        </output>
      )}
      {running && (
        <output className="workflow-batch-progress">
          <progress value={progress.done} max={progress.total} />
          <span>
            {progress.done} of {progress.total} done
            {progress.current ? ` · ${progress.current}` : ''}
            {counts.warning + counts.fail + counts.error
              ? ` · ${counts.warning + counts.fail + counts.error} flagged so far`
              : ''}
          </span>
        </output>
      )}
      <div className="workflow-batch-toolbar">
        <fieldset className="workflow-chips">
          <legend className="sr-only">Show items</legend>
          {(
            [
              ['all', `All ${rows.length}`],
              [
                'flagged',
                `Flagged ${counts.warning + counts.fail + counts.error}`,
              ],
              ['fail', `Failed ${counts.fail}`],
              ['error', `Errors ${counts.error}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {!!signalSteps.length && (
          <span className="workflow-batch-plot">
            <select
              aria-label="Output to plot across items"
              value={chosenPlot}
              onChange={(event) => setPlotStep(event.target.value)}
            >
              {signalSteps.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              disabled={busy || !shown.length}
              title="Overlay this output from every item shown, starting each at 0 s"
              onClick={() =>
                onPlotAcross(
                  chosenPlot,
                  shown.map((row) => row.run),
                )
              }
            >
              <ChartNoAxesCombined size={14} /> Plot across items
            </button>
          </span>
        )}
      </div>
      <div className="workflow-batch-table-wrap">
        <table className="workflow-batch-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>{itemLabel}</th>
              <th>Problems</th>
              {columns.map((column) => (
                <th
                  key={`${column.recipeStepId}:${column.position}`}
                  title={column.label}
                >
                  {column.label}
                  {column.unit && column.unit !== '—' ? (
                    <small> {column.unit}</small>
                  ) : null}
                </th>
              ))}
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(current * PAGE, (current + 1) * PAGE).map((row) => (
              <tr
                key={row.run.id}
                data-status={row.status}
                tabIndex={0}
                onClick={() => onOpen(row.run)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(row.run);
                  }
                }}
              >
                <td>
                  <span className="workflow-batch-status">
                    <StatusIcon status={row.status} />
                    {STATUS_LABELS[row.status]}
                    {row.edited && (
                      <Pencil size={11} aria-label="Edited after processing" />
                    )}
                  </span>
                </td>
                <td>
                  <strong>{row.run.itemId}</strong>
                  <small>{row.run.fileName}</small>
                </td>
                <td
                  title={row.problems
                    .map((problem) => problem.message)
                    .join('\n')}
                >
                  {row.problems.length ? (
                    <>
                      {row.problems[0].message}
                      {row.problems.length > 1 && (
                        <small> +{row.problems.length - 1} more</small>
                      )}
                    </>
                  ) : (
                    <span className="workflow-muted">—</span>
                  )}
                </td>
                {columns.map((column) => {
                  const value = columnValue(project, index, row.run, column);
                  return (
                    <td
                      key={`${column.recipeStepId}:${column.position}`}
                      className="workflow-batch-number"
                    >
                      {value === undefined
                        ? '—'
                        : value === null
                          ? 'n/a'
                          : formatNumber(value)}
                    </td>
                  );
                })}
                <td>
                  <button
                    className="workflow-link"
                    disabled={busy || !canReport}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreviewReport(row.run);
                    }}
                  >
                    Report
                  </button>
                </td>
              </tr>
            ))}
            {(running ? progress.failures : (batch.failures ?? [])).map(
              (failure) => (
                <tr key={failure.name} data-status="error">
                  <td>
                    <span className="workflow-batch-status">
                      <StatusIcon status="error" /> Not imported
                    </span>
                  </td>
                  <td>
                    <small>{failure.name}</small>
                  </td>
                  <td colSpan={columns.length + 2}>{failure.message}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {!shown.length && (
          <p className="workflow-empty">No items match this filter.</p>
        )}
      </div>
      {pages > 1 && (
        <div className="workflow-list-pages">
          <button
            className="workflow-link"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span>
            Page {current + 1} of {pages}
          </span>
          <button
            className="workflow-link"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
