/**
 * Stratum's MCP server for users' AI assistants (docs/ai-assistants.md).
 * Bundled to dist-desktop/assistant-server.mjs and run by Stratum itself as
 * Node (ELECTRON_RUN_AS_NODE=1), with the arguments the app's Workspace →
 * AI assistants panel gives:
 *
 *   Stratum.exe <assistant-server.mjs> --user-data <profile> [--app <main.mjs>]
 *
 * (`--app` only for a development build, to start Stratum from its script.)
 *
 * Its tools are the public interface: keep names and inputs stable.
 */
import { assemble, type ToolGroup } from './assemble';
import { AppBackend, launchStratum } from './app-backend';
import { ServerContext } from './context';
import { referenceTools } from './reference';
import { inspectTools } from './tools/inspect';
import { operationTools } from './tools/operations';
import { workflowTools } from './tools/workflows';
import { workspaceTools } from './tools/workspace';

/** The tool groups users get; developer-only tools are left out. */
export const USER_TOOL_GROUPS: ToolGroup[] = [
  workspaceTools,
  inspectTools,
  operationTools,
  workflowTools,
  referenceTools,
];

export const APP_INSTRUCTIONS = `Stratum is the user's desktop workbench for test recordings (signals over time). Its workspace holds imported recordings, steps that derive signals, find segments (time intervals of a recording) and calculate values, listed chronologically in History.

These tools work in the user's open Stratum workspace (Stratum starts if it is closed). Every change appears in the Stratum window as a step in History and can be undone with undo or Ctrl+Z, like the user's own. Use show_in_app to point the user at a result.

Typical flow: stratum_status → list_recordings / list_history / search for IDs → derive, calculate_values or segment (use preview: true first when unsure) → read_samples, signal_statistics or plot to check → describe and edit_step to adjust. catalog lists every operation and its settings. Files are given by full path; nothing is overwritten unless asked.

What these tools return (names, values, samples, plot images) is sent to you, the assistant; keep reads to what the task needs.`;

export function createAppServer(options: {
  userData: string;
  version: string;
  launch: () => void;
  startTimeout?: number;
}) {
  const backend = new AppBackend(options);
  const context = new ServerContext('app', backend);
  const server = assemble(
    context,
    {
      name: 'stratum',
      version: options.version,
      instructions: APP_INSTRUCTIONS,
    },
    USER_TOOL_GROUPS,
  );
  return { server, context, backend };
}

/** Set by the bundle build (desktop/assistant.vite.config.ts). */
declare const __STRATUM_VERSION__: string | undefined;

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Runs the server on stdio (the bundle's entry point). */
export async function main() {
  // stdout carries protocol messages only.
  for (const method of ['log', 'info', 'debug', 'warn'] as const)
    console[method] = (...args: unknown[]) => console.error(...args);
  const userData = argument('user-data');
  if (!userData) {
    process.stderr.write('Usage: assistant-server --user-data <profile>\n');
    process.exit(2);
  }
  const appScript = argument('app');
  const { server } = createAppServer({
    userData,
    version:
      argument('version') ??
      (typeof __STRATUM_VERSION__ === 'string' ? __STRATUM_VERSION__ : '1'),
    launch: () => launchStratum(appScript),
  });
  await server.serve();
  process.exit(0);
}

if (process.argv.includes('--user-data')) void main();
