import type { EngineRequest, EngineResponse, Project } from './signal-types';

/**
 * The private channel between `Stratum.exe --mcp` (the user's AI assistant
 * server, `mcp/app-server.ts`) and the running app: JSON lines over a local
 * pipe that the main process (`desktop/assistant.mjs`) opens only while the
 * user allows AI assistants, authenticated by a token in the user's profile.
 * The main process forwards calls to the workbench (`lib/assistant-host.ts`).
 */

/** In userData: the user's choice, and where the open channel is. */
export const ASSISTANT_SETTINGS_FILE = 'assistant-settings.json';
export const ASSISTANT_ENDPOINT_FILE = 'assistant-endpoint.json';

export type AssistantSettings = { enabled: boolean };
export type AssistantEndpoint = { path: string; token: string; pid: number };

export type AssistantMethod =
  | 'hello'
  | 'state'
  | 'request'
  | 'cancel'
  | 'show'
  | 'render-png';
export type AssistantCall = {
  id: number;
  method: AssistantMethod;
  params?: Record<string, unknown>;
};
export type AssistantReply = { id: number; result?: unknown; error?: string };

/** Files travel as base64; requests refer to them as `{ $fileIndex }`. */
export type AssistantFile = { name: string; data: string };

export type AssistantState = {
  project: Project;
  revision?: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
};

/**
 * What an assistant may ask the workbench to do: the operations, inspections,
 * exports and backups a user can do in the window. Legacy and start-up
 * requests are refused.
 */
export const ASSISTANT_REQUESTS: ReadonlySet<EngineRequest['type']> = new Set<
  EngineRequest['type']
>([
  'import',
  'demo-workflow',
  'derive-many',
  'derive-preview',
  'calculate-values',
  'value-preview',
  'segment-set',
  'segment-set-preview',
  'time-operation',
  'edit-operation',
  'delete-operation',
  'create-named',
  'rename',
  'set-checks',
  'run-workflow',
  'finish-batch',
  'undo',
  'redo',
  'backup-workspace',
  'restore-workspace',
  'rows',
  'sample-count',
  'view',
  'measure-plot',
  'export',
  'export-samples',
]);

/** Requests that only read; the rest change the workspace. */
export const READ_REQUESTS: ReadonlySet<EngineRequest['type']> = new Set<
  EngineRequest['type']
>([
  'derive-preview',
  'value-preview',
  'segment-set-preview',
  'rows',
  'sample-count',
  'view',
  'measure-plot',
  'export',
  'export-samples',
  'backup-workspace',
]);

/** A reply to `request`: exports and backups carry base64 bytes. */
export type AssistantRequestResult =
  | Exclude<EngineResponse, { type: 'progress' | 'export' }>
  | { type: 'export'; requestId: number; bytesBase64: string };

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
