/**
 * Where MCP requests run: the headless engine in this process, or the
 * workbench's own worker in a launched UI session (`ui-session.ts`). Both
 * speak the worker protocol (`EngineRequest`), so every tool works on either.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  handleEngineRequest,
  type EngineCommand,
} from '../lib/engine-requests';
import { SignalEngine } from '../lib/signal-engine';
import type { EngineResponse, Project } from '../lib/signal-types';

export type Target = 'engine' | 'ui';

/** A local file in a request, read by whichever backend runs it. */
export type FileRef = { $file: string; name?: string };
export const isFileRef = (value: unknown): value is FileRef =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as FileRef).$file === 'string';

/** A reply; exports and backups carry their bytes instead of a Blob. */
export type Reply = Exclude<EngineResponse, { type: 'progress' }> & {
  bytes?: Uint8Array;
};

export type WorkspaceState = {
  project: Project;
  revision?: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
};

export interface Backend {
  readonly target: Target;
  /** Runs one request; `FileRef`s anywhere in it become files. */
  request(
    request: EngineCommand | Record<string, unknown>,
    progress?: (message: string, fraction?: number) => void,
  ): Promise<Reply>;
  state(): Promise<WorkspaceState>;
  /** Cancels the running request, as the workbench's Cancel does. */
  cancel(): void;
}

/** Replaces every `FileRef` in `value` using `make`. */
export async function withFiles(
  value: unknown,
  make: (ref: FileRef) => Promise<unknown>,
): Promise<unknown> {
  if (isFileRef(value)) return make(value);
  if (Array.isArray(value))
    return Promise.all(value.map((item) => withFiles(item, make)));
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      copy[key] = await withFiles(item, make);
    return copy;
  }
  return value;
}

/** A `FileRef` typed as the File a request expects. */
export const fileRef = (path: string, name?: string) =>
  ({ $file: path, ...(name ? { name } : {}) }) as unknown as File;

export async function localFile(ref: FileRef): Promise<File> {
  const bytes = await readFile(ref.$file);
  return new File([bytes], ref.name ?? basename(ref.$file));
}

/**
 * The signal engine on fake-indexeddb (in memory): a fresh, isolated
 * workspace per server, saved and opened through backups.
 */
export class EngineBackend implements Backend {
  readonly target = 'engine';
  private engine?: SignalEngine;
  private database = '';
  private queue: Promise<unknown> = Promise.resolve();
  private serial = 0;
  private report?: (message: string, fraction?: number) => void;

  private async open(): Promise<SignalEngine> {
    if (this.engine) return this.engine;
    this.database = `stratum-mcp-${randomUUID()}`;
    const engine = new SignalEngine(
      (message, percent) =>
        this.report?.(
          message,
          Number.isFinite(percent)
            ? Math.max(0, Math.min(1, percent / 100))
            : undefined,
        ),
      this.database,
    );
    await handleEngineRequest(engine, { type: 'init-workflow' }, 0, () => {});
    this.engine = engine;
    return engine;
  }

  /** Serialised like the worker's queue. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  request(
    request: EngineCommand | Record<string, unknown>,
    progress?: (message: string, fraction?: number) => void,
  ): Promise<Reply> {
    return this.run(async () => {
      const engine = await this.open();
      const message = (await withFiles(request, localFile)) as EngineCommand;
      let reply: EngineResponse | undefined;
      this.report = progress;
      engine.cancelled = false;
      try {
        // Progress arrives through the engine's callback, not replies.
        await handleEngineRequest(engine, message, ++this.serial, (sent) => {
          if (sent.type !== 'progress') reply = sent;
        });
      } finally {
        this.report = undefined;
      }
      if (!reply) throw new Error(`No reply to "${message.type}".`);
      if (reply.type === 'export') {
        const { blob, ...rest } = reply;
        return {
          ...rest,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        } as unknown as Reply;
      }
      return reply as Reply;
    });
  }

  state(): Promise<WorkspaceState> {
    return this.run(async () => {
      const engine = await this.open();
      return {
        project: engine.project,
        revision: engine.savedRevision,
        canUndo: engine.canUndo,
        canRedo: engine.canRedo,
        undoLabel: engine.undoLabel,
        redoLabel: engine.redoLabel,
      };
    });
  }

  cancel() {
    if (this.engine) this.engine.cancelled = true;
  }

  /** Discards the workspace; the next request opens an empty one. */
  reset(): Promise<void> {
    return this.run(async () => {
      if (!this.engine) return;
      this.engine.close();
      this.engine = undefined;
      await new Promise<void>((resolve) => {
        const deleting = indexedDB.deleteDatabase(this.database);
        deleting.onsuccess =
          deleting.onerror =
          deleting.onblocked =
            () => resolve();
      });
    });
  }

  close() {
    this.engine?.close();
  }
}
