'use client';
import { useState } from 'react';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { formatCount } from '@/lib/format-count';
import { affectedOperations, stepReference } from '@/lib/workflow-lifecycle';
import { stepName, WorkflowIndex } from '@/lib/workflow-history';
import type { Project } from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';

export type WorkflowManagementAction =
  | 'edit'
  | 'duplicate'
  | 'rename'
  | 'rename-recording'
  | 'delete';

export type WorkflowManagementRequest = {
  action: 'rename' | 'rename-recording' | 'delete';
  step: WorkflowStep;
  outputId?: string;
};

export default function WorkflowManagement({
  step,
  outputId,
  busy,
  onAction,
}: {
  step: WorkflowStep;
  outputId?: string;
  busy: boolean;
  onAction: (action: WorkflowManagementAction) => void;
}) {
  return (
    <div className="workflow-management">
      {!['import', 'regions'].includes(step.kind) && (
        <button
          className="workflow-link"
          disabled={busy}
          onClick={() => onAction('edit')}
        >
          <Pencil size={14} />
          Edit settings
        </button>
      )}
      {step.kind !== 'import' && (
        <button
          className="workflow-link"
          disabled={busy}
          onClick={() => onAction('duplicate')}
        >
          <Copy size={14} />
          New version…
        </button>
      )}
      <button
        className="workflow-link"
        disabled={busy}
        onClick={() => onAction('rename')}
      >
        Rename {outputId ? 'output' : 'step'}
      </button>
      {step.kind === 'import' && (
        <button
          className="workflow-link"
          disabled={busy}
          onClick={() => onAction('rename-recording')}
        >
          Rename recording
        </button>
      )}
      <button
        className="workflow-link workflow-delete"
        disabled={busy}
        onClick={() => onAction('delete')}
      >
        <Trash2 size={14} />
        {step.kind === 'import' ? 'Remove recording' : 'Delete step'}
      </button>
    </div>
  );
}

export function WorkflowManagementDialogs({
  project,
  request,
  busy,
  onClose,
  onDelete,
  onRename,
}: {
  project: Project;
  request: WorkflowManagementRequest;
  busy: boolean;
  onClose: () => void;
  onDelete: (stepId: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const { step, outputId, action } = request;
  const deleting = action === 'delete';
  const renaming =
    action === 'rename-recording' ? step.sourceId : (outputId ?? step.id);
  const renameSubject =
    action === 'rename-recording'
      ? 'recording'
      : outputId
        ? project.nodes.some((node) => node.id === outputId)
          ? 'signal'
          : 'value'
        : 'step';
  const [name, setName] = useState(() =>
    action === 'rename-recording'
      ? (project.sources.find((source) => source.id === step.sourceId)?.name ??
        '')
      : outputId
        ? new WorkflowIndex(project).label(outputId)
        : stepName(step),
  );
  const [error, setError] = useState('');
  const affected = deleting ? affectedOperations(project, step.id) : [];
  const recording =
    step.kind === 'import'
      ? project.sources.find((source) => source.id === step.sourceId)
      : undefined;
  const dependents = affected.filter((item) => item.id !== step.id);
  const outputCount = (items: WorkflowStep[]) =>
    items.reduce((sum, item) => sum + item.outputIds.length, 0);
  // A recording that is a batch item leaves that batch when it is removed.
  const batch = recording
    ? project.workflowBatches?.find((item) =>
        item.runs.some((run) => run.sourceId === recording.id),
      )
    : undefined;
  const itemId = batch?.runs.find(
    (run) => run.sourceId === recording?.id,
  )?.itemId;
  const remaining =
    batch?.runs.filter((run) => run.sourceId !== recording?.id).length ?? 0;
  const target = recording
    ? `recording ${recording.name}`
    : `step ${stepReference(step)} ${stepName(step)}`;
  const confirm = recording
    ? dependents.length
      ? `Remove recording and ${formatCount(dependents.length, 'step')}`
      : 'Remove recording'
    : affected.length > 1
      ? `Delete ${formatCount(affected.length, 'step')}`
      : 'Delete step';
  return (
    <>
      <AlertDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy && !open) onClose();
        }}
      >
        <AlertDialogContent className="workflow-dialog">
          <AlertDialogTitle>
            {recording ? 'Remove' : 'Delete'} {target}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {recording
              ? `This removes the recording's ${formatCount(step.outputIds.length, 'original signal')}${
                  dependents.length
                    ? ` and the ${formatCount(dependents.length, 'step')} built on them (${formatCount(outputCount(dependents), 'output')})`
                    : ''
                }. Unrelated recordings and steps stay in place.`
              : dependents.length
                ? `This deletes the step's ${formatCount(step.outputIds.length, 'output')} and the ${formatCount(dependents.length, 'later step')} that ${dependents.length === 1 ? 'uses' : 'use'} them (${formatCount(outputCount(dependents), 'output')}). Later steps are removed whole, including their other outputs. Unrelated steps stay in place.`
                : `This deletes the step and its ${formatCount(step.outputIds.length, 'output')}. No later steps use them.`}{' '}
            {batch &&
              `${itemId ?? recording?.name} will be removed from batch '${batch.name}' (${
                remaining
                  ? `${formatCount(remaining, 'item')} ${remaining === 1 ? 'remains' : 'remain'}`
                  : 'no items remain, so the batch is removed'
              }). `}
            Undo can restore this change, including after restarting the app
            (last 20 changes).
          </AlertDialogDescription>
          <ul className="workflow-impact">
            {affected.slice(0, 30).map((item) => (
              <li key={item.id}>
                {stepReference(item)} {stepName(item)} ·{' '}
                {formatCount(
                  item.outputIds.length,
                  item.kind === 'import' ? 'original signal' : 'output',
                )}
              </li>
            ))}
          </ul>
          {affected.length > 30 && (
            <p>
              And {formatCount(affected.length - 30, 'more step', 'more steps')}
              .
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              variant="destructive"
              onClick={() =>
                void onDelete(step.id)
                  .then(onClose)
                  .catch((caught: Error) => setError(caught.message))
              }
            >
              {busy ? (recording ? 'Removing…' : 'Deleting…') : confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={!deleting}
        onOpenChange={(open) => {
          if (!busy && !open) onClose();
        }}
      >
        <DialogContent className="workflow-dialog workflow-rename">
          <DialogTitle>Rename {renameSubject}</DialogTitle>
          <DialogDescription>
            Give this {renameSubject} a name you will recognise.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming)
                void onRename(renaming, name)
                  .then(onClose)
                  .catch((caught: Error) => setError(caught.message));
            }}
          >
            <input
              aria-label="Display name"
              value={name}
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            {error && <p role="alert">{error}</p>}
            <button
              className="primary-button"
              disabled={busy || !name.trim()}
              type="submit"
            >
              Save name
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
