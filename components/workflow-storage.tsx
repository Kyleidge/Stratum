'use client';
import { useRef, useState } from 'react';
import { FolderArchive } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { formatCount } from '@/lib/format-count';
import type { EngineRequest, EngineResponse } from '@/lib/signal-types';

export default function WorkflowStorage({
  disabled,
  recordings,
  request,
  restore,
  cancel,
  example,
  exampleName,
  onOpenWorkflow,
}: {
  disabled: boolean;
  recordings: number;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  restore: (file: File) => Promise<void>;
  cancel: () => void;
  example: (refresh?: boolean) => Promise<void>;
  exampleName?: string;
  /** A workflow file chosen as a backup opens the Run dialog instead. */
  onOpenWorkflow: (file: File) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chosen, setChosen] = useState<File>();
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    cancelled = useRef(false);
  async function backup() {
    setBusy(true);
    setError('');
    cancelled.current = false;
    try {
      const response = await request({ type: 'backup-workspace' });
      if (cancelled.current) throw new Error('Backup cancelled.');
      if (response.type !== 'export')
        throw new Error('Could not prepare the backup.');
      const link = document.createElement('a'),
        url = URL.createObjectURL(response.blob);
      link.href = url;
      link.download = `Stratum-workspace-${new Date().toISOString().slice(0, 10)}.stratum`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setError(
        'Backup download prepared. Keep the file somewhere separate from this device.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  }
  async function loadExample(refresh = false) {
    setBusy(true);
    setError('');
    try {
      await example(refresh);
      setRefreshing(false);
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not load the example.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="secondary-button"
        aria-label="Workspace"
        title="Back up or restore this device's workspace"
        disabled={disabled}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <FolderArchive size={14} />
        <span>Workspace</span>
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="workflow-dialog" showCloseButton={!busy}>
          <DialogTitle>Workspace</DialogTitle>
          <DialogDescription>
            {formatCount(recordings, 'recording')}{' '}
            {recordings === 1 ? 'is' : 'are'} saved on this device. A backup
            includes original samples, History steps, names, workflows, batches
            and calculated results. It excludes Undo/Redo history.
          </DialogDescription>
          <div className="workflow-storage-actions">
            <button
              className="primary-button"
              disabled={busy || !recordings}
              onClick={() => void backup()}
            >
              Download workspace backup
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              Restore workspace backup
            </button>
          </div>
          <p className="workflow-muted">
            Version 1 supports backups up to 128 MiB. Result CSV files are not
            workspace backups.
          </p>
          <p className="workflow-muted">
            Workflow files (.stratum.yaml) are opened, run and saved from the
            Import menu.
          </p>
          <h3 className="workflow-storage-heading">Example</h3>
          <div className="workflow-storage-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void loadExample()}
            >
              Open the example recording
            </button>
            {exampleName && (
              <button
                className="workflow-link"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setRefreshing(true);
                }}
              >
                Refresh this example
              </button>
            )}
          </div>
          <button
            className="workflow-link"
            disabled={busy}
            title="Reload the page. The workspace saved on this device reopens unchanged."
            onClick={() => location.reload()}
          >
            Reload the app
          </button>
          {busy && (
            <button
              className="secondary-button"
              onClick={() => {
                cancelled.current = true;
                cancel();
              }}
            >
              Cancel transfer
            </button>
          )}
          {error && <output>{error}</output>}
          <input
            className="sr-only"
            ref={file}
            type="file"
            accept=".stratum,.stratus"
            aria-label="Workspace backup file"
            onChange={(event) => {
              setError('');
              const chosenFile = event.target.files?.[0];
              event.target.value = '';
              // A workflow file chosen here opens the Run dialog instead.
              if (chosenFile && /\.ya?ml$/i.test(chosenFile.name)) {
                setOpen(false);
                onOpenWorkflow(chosenFile);
              } else setChosen(chosenFile);
            }}
          />
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={refreshing}
        onOpenChange={(value) => {
          if (!busy) setRefreshing(value);
        }}
      >
        <AlertDialogContent className="workflow-dialog">
          <AlertDialogTitle>Refresh this example?</AlertDialogTitle>
          <AlertDialogDescription>
            Replace {exampleName} and its operations with the seven-step motor
            test workflow. Imported recordings are kept. Your current example
            remains available through Undo.
          </AlertDialogDescription>
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep current example
            </AlertDialogCancel>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void loadExample(true)}
            >
              Refresh example
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!chosen}
        onOpenChange={(value) => {
          if (!value && !busy) setChosen(undefined);
        }}
      >
        <AlertDialogContent className="workflow-dialog">
          <AlertDialogTitle>Restore this workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            {chosen?.name} will replace the current workspace after validation.
            The current workspace remains available through Undo. Invalid or
            incomplete backups leave it unchanged.
          </AlertDialogDescription>
          <p className="workflow-muted">
            Undo keeps only recent changes on this device. To keep the current
            workspace for good, download a backup first.
          </p>
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <button
              className="secondary-button workflow-storage-backup-first"
              disabled={busy || !recordings}
              onClick={() => void backup()}
            >
              Download a backup first
            </button>
            {busy ? (
              <button
                className="secondary-button"
                onClick={() => {
                  cancelled.current = true;
                  cancel();
                }}
              >
                {restoring ? 'Cancel restore' : 'Cancel backup'}
              </button>
            ) : (
              <AlertDialogCancel>Keep current workspace</AlertDialogCancel>
            )}
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!chosen) return;
                setBusy(true);
                setRestoring(true);
                setError('');
                void restore(chosen)
                  .then(() => {
                    setChosen(undefined);
                    setOpen(false);
                  })
                  .catch((caught: Error) => setError(caught.message))
                  .finally(() => {
                    setBusy(false);
                    setRestoring(false);
                  });
              }}
            >
              Restore and replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
