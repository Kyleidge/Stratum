/**
 * The developer harness: every tool, with a headless engine and UI sessions,
 * started with `node mcp/start.mjs` from the repository (see
 * docs/mcp-server.md). The user-facing server is `app-server.ts`. New tool
 * groups go in TOOL_GROUPS (and in its USER_TOOL_GROUPS when they are for
 * users).
 */
import { fileURLToPath } from 'node:url';
import { ServerContext } from './context';
import { assemble, type ToolGroup } from './assemble';
import { EngineBackend } from './engine-backend';
import { referenceTools, resources } from './reference';
import { inspectTools } from './tools/inspect';
import { operationTools } from './tools/operations';
import { uiTools } from './tools/ui';
import { workflowTools } from './tools/workflows';
import { workspaceTools } from './tools/workspace';

export const SERVER_NAME = 'stratum';
export const SERVER_VERSION = '1.0.0';

/** Every tool group; each is a function of the shared context. */
export const TOOL_GROUPS: ToolGroup[] = [
  workspaceTools,
  inspectTools,
  operationTools,
  workflowTools,
  referenceTools,
  uiTools,
];

const INSTRUCTIONS = `Stratum is a local signal-workflow workbench: recordings are imported as immutable signals; steps derive signals, find segments (time intervals of a recording) and calculate values; History lists steps chronologically.

Two places to work:
- The headless engine (default, target "engine"): the real SignalEngine in this server with an in-memory workspace. Fast; use it for engine behaviour and numbers.
- The real UI (ui_launch, then ui_* tools): the workbench in a hidden Electron window. Engine tools with target "ui" act through its own worker so the screen updates; ui_snapshot/ui_click/ui_fill/ui_press drive it like a user; ui_screenshot shows it.

Typical flow: stratum_status → load_example or import_recording → list_history/describe for IDs → derive / calculate_values / segment (preview first if unsure) → read_samples, signal_statistics or plot to check → edit_step/delete_step/undo. catalog lists every operation and setting. engine_request sends any raw worker request. Relative paths are from the repository root; outputs go to outputs/mcp/.`;

export function createServer(root: string) {
  const context = new ServerContext('developer', new EngineBackend(), root);
  const server = assemble(
    context,
    { name: SERVER_NAME, version: SERVER_VERSION, instructions: INSTRUCTIONS },
    TOOL_GROUPS,
    resources(context),
  );
  return { server, context };
}

export async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { server, context } = createServer(root);
  const stop = async () => {
    await context.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await server.serve();
  process.exit(0);
}
