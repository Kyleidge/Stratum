'use client';
import { useEffect, useRef, useState } from 'react';
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
import {
  desktopBridge,
  fileErrorMessage,
  readNativeFile,
  runAutoBackup,
  streamToNativeFile,
  type AutoBackupSettings,
  type DesktopReadFile,
  type StreamRequest,
} from '@/lib/desktop-bridge';

/** A backup chosen for restore: a browser File or a native file handle. */
type Chosen = { name: string; file?: File; native?: DesktopReadFile };

export default function WorkflowStorage({
  open,
  onOpenChange: setOpen,
  disabled,
  recordings,
  request,
  restore,
  cancel,
  example,
  exampleName,
  onOpenWorkflow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  recordings: number;
  request: StreamRequest;
  /** Restores a File, or a native file stream transferred to the worker. */
  restore: (
    file: File | ReadableStream<Uint8Array>,
    transfer?: Transferable[],
  ) => Promise<void>;
  cancel: () => void;
  example: (refresh?: boolean) => Promise<void>;
  exampleName?: string;
  /** A workflow file chosen as a backup opens the Run dialog instead. */
  onOpenWorkflow: (file: File) => void;
}) {
  // Desktop: native dialogs and streamed files; browser: downloads and inputs.
  const [bridge] = useState(desktopBridge);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chosen, setChosen] = useState<Chosen>();
  const [auto, setAuto] = useState<AutoBackupSettings>();
  useEffect(() => {
    if (!open || !bridge) return;
    let alive = true;
    void bridge.autoBackup
      .settings()
      .then((settings) => alive && setAuto(settings))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, bridge]);
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    cancelled = useRef(false);
  async function backup() {
    setBusy(true);
    setError('');
    cancelled.current = false;
    const name = `Stratum-workspace-${new Date().toISOString().slice(0, 10)}.stratum`;
    try {
      if (bridge) {
        const file = await bridge.saveFile({
          kind: 'workspace',
          defaultName: name,
          title: 'Save workspace backup',
        });
        if (!file) return;
        await streamToNativeFile(bridge, file, request, (stream) => ({
          type: 'backup-workspace',
          stream,
        }));
        setError(
          `Backup saved to ${file.path}. Keep a copy somewhere separate from this device.`,
        );
        return;
      }
      const response = await request({ type: 'backup-workspace' });
      if (cancelled.current) throw new Error('Backup cancelled.');
      if (response.type !== 'export')
        throw new Error('Could not prepare the backup.');
      const link = document.createElement('a'),
        url = URL.createObjectURL(response.blob);
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setError(
        'Backup download prepared. Keep the file somewhere separate from this device.',
      );
    } catch (caught) {
      setError(
        cancelled.current
          ? 'Backup cancelled. No file was saved.'
          : fileErrorMessage(caught, 'Backup failed.'),
      );
    } finally {
      setBusy(false);
    }
  }
  async function chooseRestore() {
    setError('');
    if (!bridge) {
      file.current?.click();
      return;
    }
    try {
      const native = await bridge.openFile({
        kind: 'workspace',
        title: 'Restore workspace backup',
      });
      if (native) setChosen({ name: native.name, native });
    } catch (caught) {
      setError(fileErrorMessage(caught, 'Could not open the backup.'));
    }
  }
  /** Closes the confirmation; an unused native file is released. */
  function dismissChosen() {
    if (chosen?.native) void bridge?.abort(chosen.native.handle);
    setChosen(undefined);
  }
  async function autoBackupAction(
    action: (
      settings: NonNullable<typeof bridge>['autoBackup'],
    ) => Promise<AutoBackupSettings | void>,
  ) {
    if (!bridge) return;
    setBusy(true);
    setError('');
    try {
      const settings = await action(bridge.autoBackup);
      if (settings) setAuto(settings);
    } catch (caught) {
      setError(fileErrorMessage(caught, 'Could not change backup settings.'));
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
              {bridge ? 'Save workspace backup…' : 'Download workspace backup'}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void chooseRestore()}
            >
              {bridge
                ? 'Restore workspace backup…'
                : 'Restore workspace backup'}
            </button>
          </div>
          <p className="workflow-muted">
            {bridge
              ? 'Backups are written to disk as they are prepared, so their size is limited only by free space.'
              : 'Version 1 supports backups up to 128 MiB in the browser; the desktop app has no limit.'}{' '}
            Result CSV files are not workspace backups.
          </p>
          {bridge && (
            <>
              <h3 className="workflow-storage-heading">Automatic backups</h3>
              {auto?.folder ? (
                <>
                  <p className="workflow-muted">
                    Saved to <strong>{auto.folder}</strong> when Stratum closes
                    and every {auto.intervalMinutes} minutes while there are
                    changes. The newest {auto.keep} are kept.
                  </p>
                  <div className="workflow-storage-actions">
                    <button
                      className="secondary-button"
                      disabled={busy || !recordings}
                      onClick={() =>
                        void autoBackupAction(() =>
                          runAutoBackup(bridge, request),
                        )
                      }
                    >
                      Back up now
                    </button>
                    <button
                      className="workflow-link"
                      disabled={busy}
                      onClick={() =>
                        void autoBackupAction((backups) => backups.openFolder())
                      }
                    >
                      Open folder
                    </button>
                    <button
                      className="workflow-link"
                      disabled={busy}
                      onClick={() =>
                        void autoBackupAction((backups) =>
                          backups.chooseFolder(),
                        )
                      }
                    >
                      Change folder…
                    </button>
                    <button
                      className="workflow-link"
                      disabled={busy}
                      onClick={() =>
                        void autoBackupAction((backups) => backups.disable())
                      }
                    >
                      Turn off
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="workflow-muted">
                    Off. Choose a folder, ideally on another drive or a synced
                    folder, to keep the newest {auto?.keep ?? 10} backups,
                    written when Stratum closes and every{' '}
                    {auto?.intervalMinutes ?? 30} minutes while there are
                    changes.
                  </p>
                  <div className="workflow-storage-actions">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void autoBackupAction((backups) =>
                          backups.chooseFolder(),
                        )
                      }
                    >
                      Choose a backup folder…
                    </button>
                  </div>
                </>
              )}
              {auto?.last && (
                <p
                  className="workflow-muted workflow-storage-last"
                  data-ok={auto.last.ok}
                >
                  Last automatic backup,{' '}
                  {new Date(auto.last.time).toLocaleString()}:{' '}
                  {auto.last.ok
                    ? auto.last.file
                    : `failed. ${auto.last.error ?? ''}`}
                </p>
              )}
            </>
          )}
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
          if (!value && !busy) dismissChosen();
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
            workspace for good, {bridge ? 'save' : 'download'} a backup first.
          </p>
          {error && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <button
              className="secondary-button workflow-storage-backup-first"
              disabled={busy || !recordings}
              onClick={() => void backup()}
            >
              {bridge ? 'Save a backup first' : 'Download a backup first'}
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
              disabled={busy || (!chosen?.file && !chosen?.native)}
              onClick={() => {
                if (!chosen) return;
                setBusy(true);
                setRestoring(true);
                setError('');
                const native = chosen.native;
                void (
                  native && bridge
                    ? readNativeFile(bridge, native, (stream) =>
                        restore(stream, [stream]),
                      )
                    : restore(chosen.file!)
                )
                  .then(() => {
                    setChosen(undefined);
                    setOpen(false);
                  })
                  .catch((caught: Error) => {
                    setError(fileErrorMessage(caught, 'Restore failed.'));
                    // A native file is read once; choose it again to retry.
                    if (native) setChosen({ name: chosen.name });
                  })
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
