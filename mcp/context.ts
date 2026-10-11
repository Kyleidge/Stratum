/**
 * Shared state for MCP tools: the engine workspace, the optional UI session,
 * path handling and the commit helper every operation tool uses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { EngineCommand } from '../lib/engine-requests';
import type { WorkflowCommand } from '../lib/workflow-lifecycle';
import { EngineBackend, type Backend, type Target } from './backend';
import { changedSteps, removedSteps } from './describe';
import type { CallContext, JsonSchema } from './protocol';
import type { UiSession } from './ui-session';

export class ServerContext {
  readonly engine = new EngineBackend();
  ui?: UiSession;
  constructor(readonly root: string) {}

  get outputDir() {
    return join(this.root, 'outputs', 'mcp');
  }

  /** Relative paths are taken from the repository root. */
  path(path: string) {
    return isAbsolute(path) ? path : resolve(this.root, path);
  }

  backend(target: unknown = 'engine'): Backend {
    if (target === 'ui') {
      if (!this.ui?.alive)
        throw new Error(
          'No UI session is running. Call ui_launch first, or use target "engine".',
        );
      return this.ui;
    }
    if (target !== 'engine' && target !== undefined)
      throw new Error('target must be "engine" or "ui".');
    return this.engine;
  }

  /** Writes bytes to `path` (or a default name in outputs/mcp). */
  save(bytes: Uint8Array, path: string | undefined, fallback: string) {
    const target = path ? this.path(path) : join(this.outputDir, fallback);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return target;
  }

  async closeAll() {
    await this.ui?.close().catch(() => {});
    this.engine.close();
  }
}

export const TARGET: JsonSchema = {
  type: 'string',
  enum: ['engine', 'ui'],
  description:
    'Where to run: "engine" (default; the headless engine in this server, its own in-memory workspace) or "ui" (the workbench of the session started by ui_launch, which updates on screen).',
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
