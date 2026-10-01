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
import type { EngineRequest, EngineResponse } from '@/lib/signal-types';

export default function WorkflowStorage({
  disabled,
  recordings,
  request,
  restore,
  cancel,
  example,
  exampleName,
}: {
  disabled: boolean;
  recordings: number;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  restore: (file: File) => Promise<void>;
  cancel: () => void;
  example: (refresh?: boolean) => Promise<void>;
  exampleName?: string;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chosen, setChosen] = useState<File>();
  const [refreshing, setRefreshing] = useState(false);
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
        disabled={disabled}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <FolderArchive size={16} />
        Workspace
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
            {recordings} {recordings === 1 ? 'recording is' : 'recordings are'}{' '}
            saved on this device. A backup includes original samples, recipes,
            history, names and calculated results. It excludes Undo/Redo
            history.
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
          <div className="workflow-storage-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void loadExample()}
            >
              Open example workflow
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
            onClick={() => location.reload()}
          >
            Reload saved workspace
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
              setChosen(event.target.files?.[0]);
              event.target.value = '';
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
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep current workspace
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (!chosen) return;
                setBusy(true);
                setError('');
                void restore(chosen)
                  .then(() => {
                    setChosen(undefined);
                    setOpen(false);
                  })
                  .catch((caught: Error) => setError(caught.message))
                  .finally(() => setBusy(false));
              }}
            >
              Restore and replace
            </AlertDialogAction>
          </AlertDialogFooter>
          {busy && <button onClick={cancel}>Cancel restore</button>}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
