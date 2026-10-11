// AI assistant access (docs/ai-assistants.md): off until the user turns it on
// in the Workspace dialog. While on, the assistant channel
// (assistant-pipe.mjs) forwards calls to the workbench, which answers them
// with its own engine requests (lib/assistant-host.ts), so an assistant's
// changes appear in History and can be undone.
import { app, ipcMain } from 'electron';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeFileAtomic } from './backup-files.mjs';
import { startAssistantPipe } from './assistant-pipe.mjs';
import { trusted } from './files.mjs';

export const ASSISTANT_SETTINGS_FILE = 'assistant-settings.json';

/**
 * How an MCP client starts Stratum's assistant server: this executable as
 * Node (a Windows GUI process has no stdin) running the bundled server, which
 * lives outside the asar archive so Node can load it.
 */
export function assistantCommand() {
  const main = fileURLToPath(new URL('./main.mjs', import.meta.url));
  const server = fileURLToPath(
    new URL('../dist-desktop/assistant-server.mjs', import.meta.url),
  ).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return {
    command: process.execPath,
    args: [
      server,
      '--user-data',
      app.getPath('userData'),
      ...(app.isPackaged ? [] : ['--app', main]),
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function registerAssistant({ getWindow }) {
  const userData = app.getPath('userData');
  const settingsPath = join(userData, ASSISTANT_SETTINGS_FILE);
  let settings = { enabled: false };
  let pipe;
  let connections = 0;
  let serial = 0;
  const waiting = new Map();
  let ready;
  let markReady;
  const resetReady = () => {
    ready = new Promise((resolve) => (markReady = resolve));
  };
  resetReady();

  const view = () => ({
    enabled: settings.enabled,
    connections,
    ...assistantCommand(),
  });
  const notify = () => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send('stratum:assistant-status', view());
  };
  const failAll = (message) => {
    for (const { reject } of waiting.values()) reject(new Error(message));
    waiting.clear();
  };

  /** Sends a call to the workbench and waits for its answer. */
  async function forward(call) {
    const window = getWindow();
    if (!window || window.isDestroyed())
      throw new Error('The Stratum window is closed.');
    if (call.method === 'show') {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The Stratum workspace is not ready.')),
          60_000,
        ),
      ),
    ]);
    const id = ++serial;
    return new Promise((resolveCall, reject) => {
      waiting.set(id, { resolve: resolveCall, reject });
      window.webContents.send('stratum:assistant-call', {
        id,
        method: call.method,
        params: call.params,
      });
    });
  }

  async function apply(enabled) {
    settings = { enabled };
    await writeFileAtomic(
      settingsPath,
      Buffer.from(JSON.stringify(settings, null, 2)),
    );
    if (enabled && !pipe)
      pipe = await startAssistantPipe({
        userData,
        forward,
        onConnections: (count) => {
          connections = count;
          notify();
        },
      });
    if (!enabled && pipe) {
      const open = pipe;
      pipe = undefined;
      await open.stop();
      failAll('AI assistant access was turned off.');
    }
    notify();
    return view();
  }

  const loaded = readJson(settingsPath, settings).then(async (value) => {
    if (value && typeof value === 'object' && value.enabled === true)
      await apply(true).catch((error) =>
        process.stderr.write(
          `Could not open the assistant channel: ${error}\n`,
        ),
      );
  });

  const handle = (channel, run) =>
    ipcMain.handle(`stratum:${channel}`, async (event, ...args) => {
      if (!trusted(event)) throw new Error('This page cannot do that.');
      await loaded;
      return run(...args);
    });
  handle('assistant-settings', () => view());
  handle('assistant-set', (enabled) => apply(enabled === true));
  ipcMain.on('stratum:assistant-ready', (event) => {
    if (trusted(event)) markReady();
  });
  ipcMain.on('stratum:assistant-reply', (event, id, reply) => {
    if (!trusted(event)) return;
    const call = waiting.get(id);
    if (!call) return;
    waiting.delete(id);
    if (reply && typeof reply.error === 'string')
      call.reject(new Error(reply.error));
    else call.resolve(reply?.result);
  });

  return {
    /** A new page must register its handler again. */
    attachWindow(window) {
      const lost = () => {
        resetReady();
        failAll('The Stratum window reloaded or closed.');
      };
      window.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) lost();
      });
      window.webContents.on('render-process-gone', lost);
      window.on('closed', lost);
    },
    async stop() {
      if (pipe) await pipe.stop().catch(() => {});
      pipe = undefined;
    },
  };
}
