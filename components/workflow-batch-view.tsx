'use client';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChartNoAxesCombined,
  CheckCircle2,
  CircleMinus,
  Download,
  FileText,
  Pencil,
  XCircle,
  OctagonX,
} from 'lucide-react';
import { stepName, WorkflowIndex } from '@/lib/workflow-history';
import {
  liveRunStatus,
  runEdited,
  runProblems,
  STATUS_LABELS,
  formatNumber,
} from '@/lib/workflow-checks';
import { batchColumns, columnCheck, columnValue } from '@/lib/workflow-batch';
import { formatCount } from '@/lib/format-count';
import { parseWorkflow } from '@/lib/workflow-recipe';
import type { Project } from '@/lib/signal-types';
import type {
  RunStatus,
  WorkflowBatch,
  WorkflowRun,
} from '@/lib/workflow-types';

const PAGE = 30;
/** Value columns kept in the DOM; the summary CSV has every value. */
const COLUMNS = 24;
export type BatchProgress = {
  batchId: string;
  name: string;
  startedAt: string;
  done: number;
  total: number;
  current: string;
  failures: { name: string; message: string }[];
};
type Filter = 'all' | RunStatus;
/** Exclusive status chips: every item is in exactly one. */
const CHIPS: RunStatus[] = ['pass', 'warning', 'fail', 'error', 'none'];

export function StatusIcon({
  status,
  size = 14,
  decorative = false,
}: {
  status: RunStatus;
  size?: number;
  /** Hide from assistive technology when the label is already shown. */
  decorative?: boolean;
}) {
  const Icon =
    status === 'none'
      ? CircleMinus
      : status === 'pass'
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
      {...(decorative
        ? { 'aria-hidden': true }
        : { 'aria-label': STATUS_LABELS[status] })}
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
  const counts: Record<RunStatus, number> = {
    none: 0,
    pass: 0,
    warning: 0,
    fail: 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;
  const flagged = counts.warning + counts.fail + counts.error;
  const running = progress?.batchId === batch.id;
  const failures = (running ? progress.failures : batch.failures) ?? [];
  const shown = rows.filter((row) => filter === 'all' || row.status === filter);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages - 1);
  // Signal steps that every item can plot together.
  const signalSteps = useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of batch.runs)
      for (const [recipeStepId, stepId] of Object.entries(run.steps)) {
        const step = index.steps.get(stepId);
        if (step && step.kind !== 'value' && !seen.has(recipeStepId))
          seen.set(recipeStepId, stepName(step));
      }
    return [...seen];
  }, [batch, index]);
  const chosenPlot = signalSteps.some(([id]) => id === plotStep)
    ? plotStep
    : (signalSteps[0]?.[0] ?? '');
  // Items without this output (skipped or failed) are named before plotting.
  const unplotted = shown.filter(
    (row) =>
      !index.steps
        .get(row.run.steps[chosenPlot] ?? '')
        ?.outputIds.some((id) => index.nodes.has(id)),
  );
  const folderSupported =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  return (
    <section className="workflow-batch-view" aria-label="Batch results">
      <header className="workflow-batch-header">
        <button
          className="secondary-button workflow-batch-close"
          title="Hide batch results and show the plots of the selected item"
          onClick={onClose}
        >
          <ArrowLeft size={14} /> Show plots
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
          {!!rows.length && (
            <p className="workflow-batch-headline">
              <strong>
                {counts.pass} of {formatCount(rows.length, 'item')} passed
              </strong>
              {flagged ? ` · ${flagged} need attention` : ''}
              {counts.none
                ? ` · ${counts.none} ${counts.none === 1 ? 'has' : 'have'} no checks`
                : ''}
              {failures.length ? ` · ${failures.length} not imported` : ''}
            </p>
          )}
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
                <FileText size={14} /> Export{' '}
                {formatCount(shown.length, 'report')}
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
            {flagged ? ` · ${flagged} need attention so far` : ''}
          </span>
        </output>
      )}
      <div className="workflow-batch-toolbar">
        <fieldset className="workflow-chips">
          <legend className="sr-only">Show items</legend>
          <button
            aria-pressed={filter === 'all'}
            onClick={() => {
              setFilter('all');
              setPage(0);
            }}
          >
            All {rows.length}
          </button>
          {CHIPS.filter(
            (status) => status !== 'none' || counts.none || filter === 'none',
          ).map((status) => (
            <button
              key={status}
              aria-pressed={filter === status}
              data-status={status}
              onClick={() => {
                setFilter(status);
                setPage(0);
              }}
            >
              <StatusIcon status={status} size={13} decorative />
              {STATUS_LABELS[status]} {counts[status]}
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
              disabled={busy || unplotted.length === shown.length}
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
            {!!unplotted.length && !!shown.length && (
              <small
                className="workflow-muted"
                title={unplotted.map((row) => row.run.itemId).join(', ')}
              >
                {unplotted.length === shown.length
                  ? 'No item shown has this output.'
                  : `${unplotted.length} of ${shown.length} have no output here (skipped or failed): ${unplotted
                      .slice(0, 3)
                      .map((row) => row.run.itemId)
                      .join(', ')}${unplotted.length > 3 ? '…' : ''}`}
              </small>
            )}
          </span>
        )}
      </div>
      <div className="workflow-batch-table-wrap">
        <table className="workflow-batch-table">
          <thead>
            <tr>
              <th className="workflow-batch-sticky-start">{itemLabel}</th>
              <th>Status</th>
              <th>Problems</th>
              {columns.map((column) => (
                <th
                  key={`${column.recipeStepId}:${column.position}`}
                  className="workflow-batch-number"
                  title={column.label}
                >
                  <span>{column.label}</span>
                  <small>
                    {column.unit && column.unit !== '—'
                      ? column.unit
                      : '\u00a0'}
                  </small>
                </th>
              ))}
              <th className="workflow-batch-sticky-end">
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
                <td className="workflow-batch-sticky-start">
                  <span className="workflow-batch-id">
                    <StatusIcon status={row.status} />
                    <span>
                      <strong>{row.run.itemId}</strong>
                      <small>{row.run.fileName}</small>
                    </span>
                  </span>
                </td>
                <td>
                  <span className="workflow-batch-status">
                    {STATUS_LABELS[row.status]}
                    {row.edited && (
                      <Pencil size={11} aria-label="Edited after processing" />
                    )}
                  </span>
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
                  const check = columnCheck(index, row.run, column);
                  return (
                    <td
                      key={`${column.recipeStepId}:${column.position}`}
                      className="workflow-batch-number"
                      data-check={check?.status}
                      title={check?.message}
                    >
                      {value === undefined
                        ? '—'
                        : value === null
                          ? 'n/a'
                          : formatNumber(value)}
                    </td>
                  );
                })}
                <td className="workflow-batch-sticky-end">
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
            {(filter === 'all' || filter === 'error' ? failures : []).map(
              (failure) => (
                <tr key={failure.name} data-status="error">
                  <td className="workflow-batch-sticky-start">
                    <span className="workflow-batch-id">
                      <StatusIcon status="error" />
                      <span>
                        <small>{failure.name}</small>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="workflow-batch-status">Not imported</span>
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
