/**
 * Shared state for MCP tools: the engine workspace, the optional UI session,
 * path handling and the commit helper every operation tool uses.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { EngineCommand } from '../lib/engine-requests';
import type { WorkflowCommand } from '../lib/workflow-lifecycle';
import type { Backend, Target } from './backend';
import { changedSteps, removedSteps } from './describe';
import type { CallContext, JsonSchema } from './protocol';
import type { UiSession } from './ui-session';

/**
 * `developer`: the repository harness (engine and UI-session targets, paths
 * from the repository root, outputs in outputs/mcp). `app`: the user-facing
 * server (`Stratum.exe --mcp`), whose one backend is the user's running app;
 * paths must be absolute and files are never overwritten unasked.
 */
export type ServerMode = 'developer' | 'app';

/** A backend that can be reset and closed (the developer engine). */
export type PrimaryBackend = Backend & {
  reset?(): Promise<void>;
  close?(): void;
};

export class ServerContext {
  ui?: UiSession;
  constructor(
    readonly mode: ServerMode,
    /** The default backend: the engine (developer) or the app. */
    readonly primary: PrimaryBackend,
    /** The repository root (developer mode only). */
    readonly root = '',
  ) {}

  get outputDir() {
    return join(this.root, 'outputs', 'mcp');
  }

  /**
   * Developer: relative paths are from the repository root. App: a path
   * must be absolute (or start with ~), since there is no working folder.
   */
  path(path: string) {
    if (this.mode === 'app') {
      const home = /^~(?=$|[\\/])/.test(path)
        ? join(homedir(), path.slice(1))
        : path;
      if (!isAbsolute(home))
        throw new Error(
          `Give a full path (such as C:\\Users\\you\\Documents\\file.csv), not "${path}".`,
        );
      return resolve(home);
    }
    return isAbsolute(path) ? path : resolve(this.root, path);
  }

  backend(target?: unknown): Backend {
    if (this.mode === 'app') return this.primary;
    if (target === 'ui') {
      if (!this.ui?.alive)
        throw new Error(
          'No UI session is running. Call ui_launch first, or use target "engine".',
        );
      return this.ui;
    }
    if (target !== 'engine' && target !== undefined)
      throw new Error('target must be "engine" or "ui".');
    return this.primary;
  }

  /**
   * Writes bytes to `path`, or in developer mode to a default name in
   * outputs/mcp. An existing file is replaced only with `overwrite`.
   */
  save(
    bytes: Uint8Array,
    path: string | undefined,
    fallback: string,
    overwrite = false,
  ) {
    if (!path && this.mode === 'app')
      throw new Error('Give the full path of the file to write.');
    const target = path ? this.path(path) : join(this.outputDir, fallback);
    if (existsSync(target) && !overwrite)
      throw new Error(
        `${target} already exists. Choose another name, or pass overwrite: true to replace it.`,
      );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return target;
  }

  async closeAll() {
    await this.ui?.close().catch(() => {});
    this.primary.close?.();
  }
}

/** Replaces existing files only when asked; for every tool that writes. */
export const OVERWRITE: JsonSchema = {
  type: 'boolean',
  description: 'Replace the file if it already exists (default false).',
};

export const TARGET: JsonSchema = {
  type: 'string',
  enum: ['engine', 'ui'],
  description:
    'Where to run: "engine" (default; the headless engine in this server, its own in-memory workspace) or "ui" (the workbench of the session started by ui_launch, which updates on screen). Developer harness only; the app server has no target.',
};

export const stringList = (description: string): JsonSchema => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

export const objectArg = (description: string): JsonSchema => ({
  type: 'object',
  description,
  additionalProperties: true,
});

export function argList(value: unknown, name: string): string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((item) => typeof item !== 'string')
  )
    throw new Error(`"${name}" must be a non-empty list of IDs.`);
  return list as string[];
}

/**
 * Commits a request (optionally named, through `create-named`) and reports
 * the steps it created or changed plus Undo state.
 */
export async function commit(
  backend: Backend,
  request: EngineCommand,
  call: CallContext,
  name?: unknown,
) {
  const before = (await backend.state()).project;
  const message: EngineCommand =
    typeof name === 'string' && name.trim()
      ? {
          type: 'create-named',
          command: request as WorkflowCommand,
          name: name.trim(),
        }
      : request;
  const cancel = () => backend.cancel();
  call.signal.addEventListener('abort', cancel);
  try {
    const reply = await backend.request(message, call.progress);
    if (reply.type !== 'project')
      throw new Error(`Unexpected reply "${reply.type}".`);
    const removed = removedSteps(before, reply.project);
    return {
      changed: changedSteps(before, reply.project),
      ...(removed.length ? { removed } : {}),
      ...(reply.undoLabel ? { undo: reply.undoLabel } : {}),
      ...(reply.redoLabel ? { redo: reply.redoLabel } : {}),
    };
  } finally {
    call.signal.removeEventListener('abort', cancel);
  }
}

export type { Target };
