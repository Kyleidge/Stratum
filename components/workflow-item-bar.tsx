'use client';
import { ArrowLeft, ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { STATUS_LABELS } from '@/lib/workflow-checks';
import { formatCount } from '@/lib/format-count';
import { StatusIcon } from './workflow-batch-view';
import type {
  RunStatus,
  WorkflowBatch,
  WorkflowRun,
} from '@/lib/workflow-types';

/** Where this recording sits in its batch, with quick item-to-item navigation. */
export default function WorkflowItemBar({
  batch,
  run,
  itemLabel,
  status,
  problems,
  edited,
  mapped = [],
  onStep,
  onBatch,
}: {
  batch: WorkflowBatch;
  run: WorkflowRun;
  itemLabel: string;
  status: RunStatus;
  problems: { status: RunStatus; message: string }[];
  edited: boolean;
  /** Channels bound to another column in pre-flight ("Torque ← Shaft"). */
  mapped?: string[];
  onStep: (offset: -1 | 1) => void;
  onBatch: () => void;
}) {
  const position = batch.runs.findIndex((item) => item.id === run.id);
  const summary = problems.length
    ? `${problems[0].message}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`
    : status === 'none'
      ? 'This workflow has no checks.'
      : 'All checks passed.';
  return (
    <section
      className="workflow-item-bar"
      data-status={status}
      aria-label="Batch item"
    >
      <button
        className="secondary-button workflow-item-bar-back"
        title={`Back to the results of ${batch.name}`}
        onClick={onBatch}
      >
        <ArrowLeft size={14} /> All {formatCount(batch.runs.length, 'item')}
      </button>
      <button
        className="workflow-icon-button workflow-quiet"
        aria-label="Previous item"
        title="Previous item, same step · Alt+←"
        disabled={position <= 0}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <span className="workflow-item-bar-name">
        <StatusIcon status={status} />
        <strong>
          {itemLabel} {run.itemId}
        </strong>
        <small>
          {STATUS_LABELS[status]} · {position + 1} of {batch.runs.length}
          {edited ? ' · edited' : ''}
        </small>
        {edited && <Pencil size={11} aria-hidden="true" />}
      </span>
      <button
        className="workflow-icon-button workflow-quiet"
        aria-label="Next item"
        title="Next item, same step · Alt+→"
        disabled={position >= batch.runs.length - 1}
        onClick={() => onStep(1)}
      >
        <ChevronRight size={15} />
      </button>
      <span
        className="workflow-item-bar-problem"
        title={[
          ...problems.map((problem) => problem.message),
          ...(mapped.length ? [`Columns chosen: ${mapped.join(', ')}`] : []),
        ].join('\n')}
      >
        {summary}
        {mapped.length ? (
          <small> · {formatCount(mapped.length, 'column')} chosen</small>
        ) : null}
      </span>
    </section>
  );
}
