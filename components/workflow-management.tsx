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
import { affectedOperations } from '@/lib/workflow-lifecycle';
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
          Duplicate operation
        </button>
      )}
      <button
        className="workflow-link"
        disabled={busy}
        onClick={() => onAction('rename')}
      >
        Rename {outputId ? 'output' : 'operation'}
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
        {step.kind === 'import' ? 'Remove recording' : 'Delete operation'}
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
            {step.kind === 'import'
              ? 'Remove this recording?'
              : `Delete ${stepName(step)}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes {affected.length} operation
            {affected.length === 1 ? '' : 's'} and{' '}
            {affected.reduce((sum, item) => sum + item.outputIds.length, 0)}{' '}
            outputs from the workspace. Dependent operations are removed as
            complete batches, including their other outputs. Unrelated
            operations stay in place. Undo can restore this change, including
            after restarting the app (last 20 changes).
          </AlertDialogDescription>
          <ul className="workflow-impact">
            {affected.slice(0, 30).map((item) => (
              <li key={item.id}>
                #{String(item.sequence + 1).padStart(3, '0')} {stepName(item)} ·{' '}
                {item.outputIds.length} outputs
              </li>
            ))}
          </ul>
          {affected.length > 30 && (
            <p>And {affected.length - 30} more dependent operations.</p>
          )}
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep operation
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              variant="destructive"
              onClick={() =>
                void onDelete(step.id)
                  .then(onClose)
                  .catch((caught: Error) => setError(caught.message))
              }
            >
              {busy ? 'Removing…' : 'Delete listed operations'}
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
        <DialogContent className="workflow-dialog">
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            Change the display name. Samples and dependency links stay
            unchanged.
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
            <label className="region-field">
              <span>Name</span>
              <input
                aria-label="Display name"
                value={name}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
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
