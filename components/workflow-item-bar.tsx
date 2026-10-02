'use client';
import { ChevronLeft, ChevronRight, ListChecks, Pencil } from 'lucide-react';
import { STATUS_LABELS } from '@/lib/workflow-checks';
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
  onStep,
  onBatch,
}: {
  batch: WorkflowBatch;
  run: WorkflowRun;
  itemLabel: string;
  status: RunStatus;
  problems: { status: RunStatus; message: string }[];
  edited: boolean;
  onStep: (offset: -1 | 1) => void;
  onBatch: () => void;
}) {
  const position = batch.runs.findIndex((item) => item.id === run.id);
  return (
    <section
      className="workflow-item-bar"
      data-status={status}
      aria-label="Batch item"
    >
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
      <span
        className="workflow-item-bar-problem"
        title={problems.map((problem) => problem.message).join('\n')}
      >
        {problems.length
          ? `${problems[0].message}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`
          : 'All checks passed.'}
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
      <button className="secondary-button" onClick={onBatch}>
        <ListChecks size={14} /> {batch.name}
      </button>
    </section>
  );
}
