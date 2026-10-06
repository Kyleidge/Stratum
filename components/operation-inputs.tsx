'use client';

import { useId } from 'react';
import { X } from 'lucide-react';
import { formatCount } from '@/lib/format-count';
import { stepName } from '@/lib/workflow-history';
import { affectedOperations } from '@/lib/workflow-lifecycle';
import type { Project } from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';
import WorkflowList from './workflow-list';

/** Inputs shown as chips; longer selections add a paged, collapsible list. */
const CHIP_LIMIT = 5;

export type OperationInput = {
  id: string;
  label: string;
  /** Full text for the tooltip, such as the owning step and recording. */
  title?: string;
};

/**
 * "Applies to" chips under an operation dialog's title, so the inputs a step
 * will use are visible without opening a disclosure.
 */
export default function OperationInputs({
  items,
  label = 'Applies to',
  empty = 'No inputs yet.',
  onRemove,
}: {
  items: OperationInput[];
  label?: string;
  empty?: string;
  onRemove?: (id: string) => void;
}) {
  const labelId = useId();
  const chip = (item: OperationInput) => (
    <li key={item.id} className="operation-input-chip" title={item.title}>
      <span>{item.label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${item.label}`}
          onClick={() => onRemove(item.id)}
        >
          <X size={12} />
        </button>
      )}
    </li>
  );
  return (
    <div className="operation-inputs">
      <span className="operation-inputs-label" id={labelId}>
        {label}
      </span>
      {items.length ? (
        <ul aria-labelledby={labelId}>
          {items.slice(0, CHIP_LIMIT).map(chip)}
        </ul>
      ) : (
        <span className="operation-inputs-empty">{empty}</span>
      )}
      {items.length > CHIP_LIMIT && (
        <WorkflowList
          className="operation-inputs-more"
          items={items}
          summary={`Show all ${formatCount(items.length, 'input')}`}
        >
          {(visible) => <ul aria-labelledby={labelId}>{visible.map(chip)}</ul>}
        </WorkflowList>
      )}
    </div>
  );
}

const reference = (step: WorkflowStep) =>
  `#${String(step.sequence + 1).padStart(3, '0')}`;

/** Edit dialog title naming the step: "Edit #009 Segment signals". */
export function editTitle(step: WorkflowStep) {
  return `Edit ${reference(step)} ${stepName(step)}`;
}

/** Plain impact text naming the steps that saving recalculates. */
export function editImpact(project: Project, stepId: string) {
  let dependents: WorkflowStep[];
  try {
    dependents = affectedOperations(project, stepId).slice(1);
  } catch {
    return 'Saving replaces this step. Undo restores the previous version.';
  }
  if (!dependents.length)
    return 'Saving replaces this step; nothing else uses its outputs. Undo restores the previous version.';
  const named = dependents
    .slice(0, 3)
    .map((step) => `${reference(step)} ${stepName(step)}`);
  const rest = dependents.length - named.length;
  const list = rest
    ? `${named.join(', ')} and ${formatCount(rest, 'more step')}`
    : named.length > 1
      ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
      : named[0];
  return `Saving recalculates ${list}. Original signals stay unchanged and Undo restores the previous version. Changes that cannot rebuild every dependent step are rejected.`;
}
