import type { EngineRequest, EngineResponse } from './signal-types';

/**
 * Typed client for the Electron preload bridge (`window.stratumDesktop`).
 *
 * The renderer never names filesystem paths: files come only from native
 * dialogs the user answered, or from the auto-backup folder the user chose,
 * and are addressed through opaque handles. In the browser build the bridge
 * is absent and callers keep the download and file-input behaviour.
 */

/** What a native dialog is for; the main process owns the file filters. */
export type DesktopFileKind = 'workspace' | 'csv';
export type DesktopWriteFile = {
  handle: string;
  /** File name chosen, for messages. */
  name: string;
  /** Full path, for display only. */
  path: string;
};
export type DesktopReadFile = DesktopWriteFile & { size: number };
export type AutoBackupResult = {
  ok: boolean;
  /** ISO time the attempt finished. */
  time: string;
  file?: string;
  error?: string;
  reason?: AutoBackupReason;
};
export type AutoBackupSettings = {
  /** The chosen folder, or null when automatic backups are off. */
  folder: string | null;
  /** How many timestamped backups are kept. */
  keep: number;
  /** Minutes between backups while the workspace has unsaved changes. */
  intervalMinutes: number;
  last: AutoBackupResult | null;
  /** A failure not yet acknowledged in the app (shown once at launch). */
  notice: AutoBackupResult | null;
};
export type AutoBackupReason = 'close' | 'interval' | 'manual';
export type AutoBackupRequest = { id: number; reason: AutoBackupReason };

export type StratumDesktop = {
  version: 1;
  saveFile(options: {
    kind: DesktopFileKind;
    defaultName: string;
    title?: string;
  }): Promise<DesktopWriteFile | null>;
  openFile(options: {
    kind: DesktopFileKind;
    title?: string;
  }): Promise<DesktopReadFile | null>;
  write(handle: string, bytes: Uint8Array): Promise<void>;
  /** Reads the next bytes; an empty array marks the end of the file. */
  read(handle: string, length: number): Promise<Uint8Array>;
  /** Completes a write (flush, then rename over the target) or a read. */
  finish(handle: string): Promise<void>;
  /** Abandons a handle; an unfinished write leaves no file behind. */
  abort(handle: string): Promise<void>;
  autoBackup: {
    settings(): Promise<AutoBackupSettings>;
    chooseFolder(): Promise<AutoBackupSettings>;
    disable(): Promise<AutoBackupSettings>;
    openFolder(): Promise<void>;
    /** Opens a new timestamped backup in the chosen folder. */
    begin(): Promise<DesktopWriteFile>;
    /** Reports the outcome of a requested or manual backup. */
    report(result: {
      id?: number;
      ok: boolean;
      revision?: number;
      /** The backup's file name. */
      file?: string;
      error?: string;
    }): Promise<AutoBackupSettings>;
    /** The workspace's committed revision, so main knows when it changed. */
    changed(revision: number, recordings: number): void;
    dismissNotice(): Promise<void>;
    /** Main asks for a backup (on close or after a period of changes). */
    onRequest(callback: (request: AutoBackupRequest) => void): () => void;
  };
};

export function desktopBridge(): StratumDesktop | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as { stratumDesktop?: StratumDesktop }).stratumDesktop;
  return bridge?.version === 1 ? bridge : undefined;
}

/** Bytes read from a native file per request. */
const READ_CHUNK = 1024 * 1024;

/**
 * A pull-based stream over a native file, transferable to the worker. It
 * reads only when the consumer asks, so at most a chunk or two is in memory.
 */
export function nativeReadable(
  bridge: StratumDesktop,
  file: DesktopReadFile,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const bytes = await bridge.read(file.handle, READ_CHUNK);
        if (bytes.length) controller.enqueue(bytes);
        else controller.close();
      },
    },
    { highWaterMark: 1 },
  );
}

/**
 * A stream that writes to a native file, transferable to the worker. `done`
 * settles once every accepted chunk has reached the file (or failed), which
 * can be after the worker has finished writing.
 */
export function nativeWritable(
  bridge: StratumDesktop,
  file: DesktopWriteFile,
): { stream: WritableStream<Uint8Array>; done: Promise<void> } {
  let settle!: (error?: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (error) => (error === undefined ? resolve() : reject(error));
  });
  // Callers await `done` only after the worker replies; avoid an unhandled
  // rejection if the worker failed first.
  done.catch(() => {});
  const stream = new WritableStream<Uint8Array>(
    {
      async write(chunk) {
        try {
          await bridge.write(file.handle, chunk);
        } catch (error) {
          settle(error ?? new Error('Could not write the file.'));
          throw error;
        }
      },
      close() {
        settle();
      },
      abort(reason) {
        settle(reason ?? new Error('The transfer was cancelled.'));
      },
    },
    { highWaterMark: 1 },
  );
  return { stream, done };
}

/**
 * Runs `produce` with a stream to a native file, then commits the file only
 * if both the producer and every write succeeded. Otherwise the partial file
 * is discarded and the previous file at that path (if any) is untouched.
 */
export async function writeNativeFile<T>(
  bridge: StratumDesktop,
  file: DesktopWriteFile,
  produce: (stream: WritableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  const { stream, done } = nativeWritable(bridge, file);
  try {
    const result = await produce(stream);
    await done;
    await bridge.finish(file.handle);
    return result;
  } catch (error) {
    await bridge.abort(file.handle).catch(() => {});
    throw error;
  }
}

/** Reads a native file as a stream for `consume`, always releasing it. */
export async function readNativeFile<T>(
  bridge: StratumDesktop,
  file: DesktopReadFile,
  consume: (stream: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  try {
    return await consume(nativeReadable(bridge, file));
  } finally {
    await bridge.abort(file.handle).catch(() => {});
  }
}

/** A short, readable message for a native file failure. */
export function fileErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  // Electron prefixes IPC failures with the channel name.
  const cleaned = message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );
  return cleaned || fallback;
}

/** Sends a worker request, transferring the streams it carries. */
export type StreamRequest = (
  message: EngineRequest,
  transfer?: Transferable[],
) => Promise<EngineResponse>;

/** Streams a request's output (a backup or samples CSV) to a native file. */
export function streamToNativeFile(
  bridge: StratumDesktop,
  file: DesktopWriteFile,
  request: StreamRequest,
  message: (stream: WritableStream<Uint8Array>) => EngineRequest,
) {
  return writeNativeFile(bridge, file, async (stream) => {
    const response = await request(message(stream), [stream]);
    if (response.type !== 'written')
      throw new Error('Could not write the file.');
    return response;
  });
}

/**
 * Writes one automatic backup to the chosen folder and reports the outcome
 * to the main process, which rotates older backups after a success.
 */
export async function runAutoBackup(
  bridge: StratumDesktop,
  request: StreamRequest,
  id?: number,
): Promise<AutoBackupSettings> {
  let file: DesktopWriteFile | undefined;
  try {
    file = await bridge.autoBackup.begin();
    const written = await streamToNativeFile(
      bridge,
      file,
      request,
      (stream) => ({ type: 'backup-workspace', stream }),
    );
    return await bridge.autoBackup.report({
      id,
      ok: true,
      revision: written.revision,
      file: file.name,
    });
  } catch (error) {
    return bridge.autoBackup.report({
      id,
      ok: false,
      file: file?.name,
      error: fileErrorMessage(error, 'The automatic backup failed.'),
    });
  }
}
