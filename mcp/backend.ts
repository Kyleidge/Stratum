/**
 * Where MCP requests run: the user's running app (`app-backend.ts`), or, in
 * the developer harness, the headless engine in this process
 * (`engine-backend.ts`) or a launched UI session (`ui-session.ts`). All speak
 * the worker protocol (`EngineRequest`), so every tool works on each.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { EngineCommand } from '../lib/engine-requests';
import type { EngineResponse, Project } from '../lib/signal-types';

export type Target = 'engine' | 'ui' | 'app';

/**
 * A file in a request, read by whichever backend runs it: a local path, or
 * generated `text` (examples) named by `name`.
 */
export type FileRef = { $file: string; name?: string; text?: string };
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
  /** Selects a step or output in the window (app and UI sessions). */
  show?(id: string): Promise<string>;
  /** Rasterises an SVG to PNG (where no image library is available). */
  renderPng?(svg: string): Promise<Uint8Array>;
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
/** Generated file content (examples), typed as a File. */
export const textFile = (name: string, text: string) =>
  ({ $file: name, name, text }) as unknown as File;

/** A `FileRef`'s name and bytes. */
export async function fileBytes(ref: FileRef) {
  return {
    name: ref.name ?? basename(ref.$file),
    bytes:
      ref.text !== undefined
        ? new TextEncoder().encode(ref.text)
        : new Uint8Array(await readFile(ref.$file)),
  };
}

export async function localFile(ref: FileRef): Promise<File> {
  const { name, bytes } = await fileBytes(ref);
  return new File([bytes], name);
}
