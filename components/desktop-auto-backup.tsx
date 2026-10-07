'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import {
  desktopBridge,
  runAutoBackup,
  type AutoBackupResult,
  type StreamRequest,
} from '@/lib/desktop-bridge';

/** When an automatic backup failed, for a short notice. */
export function backupFailure(result: AutoBackupResult) {
  const when = new Date(result.time).toLocaleString();
  const during =
    result.reason === 'close'
      ? 'when Stratum closed'
      : result.reason === 'interval'
        ? 'during the session'
        : '';
  return `The automatic backup ${during ? `${during} ` : ''}(${when}) failed: ${result.error ?? 'unknown error'}`;
}

/**
 * Desktop only: answers the main process's backup requests (on close and
 * after a period of changes), reports the committed revision so main knows
 * when the workspace changed, and shows backup failures, including one from
 * the previous session.
 */
export default function DesktopAutoBackup({
  request,
  revision,
  recordings,
  ready,
  status,
  cancel,
  onOpenWorkspace,
}: {
  request: StreamRequest;
  revision?: number;
  recordings: number;
  ready: boolean;
  /** Worker progress text, shown while backing up before closing. */
  status: string;
  cancel: () => void;
  onOpenWorkspace: () => void;
}) {
  const [closing, setClosing] = useState<number>();
  const [failure, setFailure] = useState('');
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge && ready && revision !== undefined)
      bridge.autoBackup.changed(revision, recordings);
  }, [ready, revision, recordings]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge || !ready) return;
    let alive = true;
    // A failure from the previous session is shown once.
    void bridge.autoBackup
      .settings()
      .then((settings) => {
        if (!alive || !settings.notice) return;
        setFailure(backupFailure(settings.notice));
        void bridge.autoBackup.dismissNotice();
      })
      .catch(() => {});
    const stop = bridge.autoBackup.onRequest(({ id, reason }) => {
      if (reason === 'close') setClosing(id);
      void runAutoBackup(
        bridge,
        (message, transfer) => requestRef.current(message, transfer),
        id,
      ).then((settings) => {
        if (!alive) return;
        if (reason === 'close') setClosing(undefined);
        const last = settings.last;
        if (reason === 'interval' && last && !last.ok) {
          setFailure(backupFailure(last));
          void bridge.autoBackup.dismissNotice();
        }
      });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [ready]);
  return (
    <>
      {failure && (
        <output className="workflow-toast workflow-backup-failure" role="alert">
          <AlertCircle size={15} aria-hidden />
          <span>{failure}</span>
          <button
            className="workflow-link"
            onClick={() => {
              setFailure('');
              onOpenWorkspace();
            }}
          >
            Backup settings
          </button>
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label="Dismiss"
            onClick={() => setFailure('')}
          >
            <X size={14} />
          </button>
        </output>
      )}
      <AlertDialog open={closing !== undefined}>
        <AlertDialogContent className="workflow-dialog">
          <AlertDialogTitle>Saving an automatic backup</AlertDialogTitle>
          <AlertDialogDescription>
            Stratum closes when the backup is complete.
          </AlertDialogDescription>
          <output className="workflow-muted">{status}</output>
          <AlertDialogFooter>
            <button
              className="secondary-button"
              onClick={() => {
                const bridge = desktopBridge();
                if (!bridge || closing === undefined) return;
                // Main records the skip and closes; the partial file is removed.
                void bridge.autoBackup.report({
                  id: closing,
                  ok: false,
                  error: 'Skipped when quitting.',
                });
                cancel();
              }}
            >
              Quit without backup
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
