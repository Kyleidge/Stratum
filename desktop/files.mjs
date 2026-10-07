// Native file bridge: dialogs, streamed reads/writes through opaque handles,
// and automatic backups. The renderer never names a path; it only receives
// handles for files the user picked or for the auto-backup folder they chose.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  backupFileName,
  partialPath,
  readJson,
  replaceFile,
  rotateBackups,
  safeFileName,
  writeFileAtomic,
} from './backup-files.mjs';

const KINDS = {
  workspace: {
    extension: 'stratum',
    open: ['stratum', 'stratus'],
    filters: [{ name: 'Stratum workspace backup', extensions: ['stratum'] }],
    openFilters: [
      { name: 'Stratum workspace backup', extensions: ['stratum', 'stratus'] },
    ],
  },
  csv: {
    extension: 'csv',
    open: ['csv'],
    filters: [{ name: 'CSV file', extensions: ['csv'] }],
    openFilters: [{ name: 'CSV file', extensions: ['csv'] }],
  },
};
const MAX_WRITE = 16 * 1024 * 1024;
const MAX_READ = 4 * 1024 * 1024;
const KEEP = 10;
const INTERVAL_MINUTES = 30;
/** How long a closing window waits for the renderer to start its backup. */
const START_TIMEOUT = 15000;
/** The longest a close waits for a backup before quitting regardless. */
const CLOSE_TIMEOUT = 10 * 60 * 1000;

/** Only the app's own top-level page may use the bridge. */
function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    return url.protocol === 'stratus:' && url.host === 'app';
  } catch {
    return false;
  }
}

/**
 * Registers the IPC handlers. `test` (native smoke runs only, which also use
 * a temporary profile) answers dialogs without showing them: saves go to
 * `test.dir`, opens take its newest matching file, and folders are created
 * inside the temporary profile.
 */
export function registerDesktopFiles({ test } = {}) {
  const handles = new Map();
  const settingsPath = join(app.getPath('userData'), 'desktop-settings.json');
  let settings = { autoBackup: { folder: null } };
  const loaded = readJson(settingsPath, settings).then((value) => {
    if (value && typeof value === 'object' && value.autoBackup)
      settings = value;
  });
  let saving = Promise.resolve();
  const persist = () =>
    (saving = saving
      .then(() =>
        writeFileAtomic(
          settingsPath,
          Buffer.from(JSON.stringify(settings, null, 2)),
        ),
      )
      .catch((error) =>
        process.stderr.write(`Could not save desktop settings: ${error}\n`),
      ));
  const auto = () => settings.autoBackup;
  const view = () => ({
    folder: auto().folder ?? null,
    keep: KEEP,
    intervalMinutes: INTERVAL_MINUTES,
    last: auto().last ?? null,
    notice: auto().notice ?? null,
  });
  // The renderer's latest committed revision and recording count.
  let current;
  let lastAttempt = Date.now();
  let running = false;
  let pending;
  let serial = 0;

  const handle = (channel, run) =>
    ipcMain.handle(`stratum:${channel}`, async (event, ...args) => {
      if (!trusted(event)) throw new Error('This page cannot use files.');
      await loaded;
      return run(event, ...args);
    });
  const owned = (event, id, mode) => {
    const item = handles.get(id);
    if (!item || item.owner !== event.sender.id || item.mode !== mode)
      throw new Error('That file is no longer open.');
    return item;
  };
  const parent = (event) => BrowserWindow.fromWebContents(event.sender);

  async function openWrite(owner, path, automatic = false) {
    await mkdir(dirname(path), { recursive: true });
    const temp = partialPath(path);
    const file = await open(temp, 'wx');
    const id = randomBytes(16).toString('hex');
    handles.set(id, { mode: 'write', file, path, temp, owner, automatic });
    return { handle: id, name: basename(path), path };
  }
  async function release(id, commit) {
    const item = handles.get(id);
    if (!item) return;
    handles.delete(id);
    if (item.mode === 'read') {
      await item.file.close().catch(() => {});
      return;
    }
    if (!commit) {
      await item.file.close().catch(() => {});
      await rm(item.temp, { force: true });
      return;
    }
    try {
      await item.file.sync();
      await item.file.close();
      await replaceFile(item.temp, item.path);
    } catch (error) {
      await item.file.close().catch(() => {});
      await rm(item.temp, { force: true });
      throw error;
    }
    test?.saved?.(basename(item.path), item.automatic);
  }
  /** Abandons every handle a page owns (it closed, crashed or reloaded). */
  const releaseOwner = (owner) =>
    Promise.all(
      [...handles]
        .filter(([, item]) => item.owner === owner)
        .map(([id]) => release(id, false)),
    );
  app.on('web-contents-created', (_event, contents) => {
    const owner = contents.id;
    contents.on('destroyed', () => void releaseOwner(owner));
    contents.on('render-process-gone', () => void releaseOwner(owner));
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument)
        void releaseOwner(owner);
    });
  });

  handle('save-file', async (event, options) => {
    const kind = KINDS[options?.kind];
    if (!kind) throw new Error('Unknown file type.');
    const name = safeFileName(options.defaultName, kind.extension);
    let path;
    if (test) {
      await mkdir(test.dir, { recursive: true });
      path = join(test.dir, name);
    } else {
      const result = await dialog.showSaveDialog(parent(event), {
        title: typeof options.title === 'string' ? options.title : undefined,
        defaultPath: join(
          auto().lastDirectory ?? app.getPath('documents'),
          name,
        ),
        filters: kind.filters,
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (result.canceled || !result.filePath) return null;
      path = result.filePath;
      if (!extname(path)) path += `.${kind.extension}`;
      auto().lastDirectory = dirname(path);
      void persist();
    }
    return openWrite(event.sender.id, path);
  });
  handle('open-file', async (event, options) => {
    const kind = KINDS[options?.kind];
    if (!kind) throw new Error('Unknown file type.');
    let path;
    if (test) {
      const names = (await readdir(test.dir).catch(() => [])).filter((name) =>
        kind.open.includes(extname(name).slice(1).toLowerCase()),
      );
      const dated = await Promise.all(
        names.map(async (name) => ({
          name,
          time: (await stat(join(test.dir, name))).mtimeMs,
        })),
      );
      const newest = dated.sort((a, b) => b.time - a.time)[0];
      if (!newest) return null;
      path = join(test.dir, newest.name);
    } else {
      const result = await dialog.showOpenDialog(parent(event), {
        title: typeof options.title === 'string' ? options.title : undefined,
        defaultPath: auto().lastDirectory ?? app.getPath('documents'),
        filters: kind.openFilters,
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
      auto().lastDirectory = dirname(path);
      void persist();
    }
    const file = await open(path, 'r');
    const { size } = await file.stat();
    const id = randomBytes(16).toString('hex');
    handles.set(id, {
      mode: 'read',
      file,
      path,
      position: 0,
      owner: event.sender.id,
    });
    return { handle: id, name: basename(path), path, size };
  });
  handle('write', async (event, id, bytes) => {
    const item = owned(event, id, 'write');
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_WRITE)
      throw new Error('Invalid file data.');
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await item.file.write(
        bytes,
        offset,
        bytes.length - offset,
      );
      offset += bytesWritten;
    }
  });
  handle('read', async (event, id, length) => {
    const item = owned(event, id, 'read');
    const size = Math.min(MAX_READ, Math.max(1, Math.floor(Number(length))));
    if (!Number.isFinite(size)) throw new Error('Invalid read length.');
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await item.file.read(buffer, 0, size, item.position);
    item.position += bytesRead;
    return buffer.subarray(0, bytesRead);
  });
  handle('finish', async (event, id) => {
    const item = handles.get(id);
    if (!item || item.owner !== event.sender.id)
      throw new Error('That file is no longer open.');
    await release(id, true);
  });
  handle('abort', async (event, id) => {
    const item = handles.get(id);
    if (item && item.owner === event.sender.id) await release(id, false);
  });

  // ---- Automatic backups --------------------------------------------------
  handle('auto-backup-settings', () => view());
  handle('auto-backup-choose', async (event) => {
    let folder;
    if (test) folder = join(app.getPath('userData'), 'auto-backups');
    else {
      const result = await dialog.showOpenDialog(parent(event), {
        title: 'Choose a folder for automatic backups',
        defaultPath: auto().folder ?? app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return view();
      folder = result.filePaths[0];
    }
    await mkdir(folder, { recursive: true });
    auto().folder = folder;
    // Back up the current state at the next opportunity.
    delete auto().lastRevision;
    await persist();
    return view();
  });
  handle('auto-backup-disable', async () => {
    auto().folder = null;
    await persist();
    return view();
  });
  handle('auto-backup-open-folder', async () => {
    if (auto().folder) await shell.openPath(auto().folder);
  });
  handle('auto-backup-begin', async (event) => {
    const folder = auto().folder;
    if (!folder) throw new Error('Choose a folder for automatic backups.');
    await mkdir(folder, { recursive: true });
    running = true;
    lastAttempt = Date.now();
    if (pending) pending.started = true;
    try {
      const taken = new Set(await readdir(folder));
      return await openWrite(
        event.sender.id,
        join(folder, backupFileName(new Date(), taken)),
        true,
      );
    } catch (error) {
      running = false;
      throw error;
    }
  });
  handle('auto-backup-report', async (_event, result) => {
    running = false;
    // A request that already timed out or was skipped keeps its outcome.
    if (result?.id !== undefined && pending?.id !== result.id && !result.ok)
      return view();
    const reason =
      pending && pending.id === result?.id ? pending.reason : 'manual';
    const outcome = {
      ok: !!result?.ok,
      time: new Date().toISOString(),
      reason,
      ...(typeof result?.file === 'string' ? { file: result.file } : {}),
      ...(result?.ok
        ? {}
        : {
            error:
              typeof result?.error === 'string'
                ? result.error.slice(0, 500)
                : 'The backup did not finish.',
          }),
    };
    await record(outcome, result?.ok ? result.revision : undefined);
    if (pending && pending.id === result?.id) pending.resolve();
    return view();
  });
  handle('auto-backup-dismiss', async () => {
    delete auto().notice;
    await persist();
  });
  ipcMain.on('stratum:auto-backup-changed', (event, revision, recordings) => {
    if (!trusted(event)) return;
    if (Number.isSafeInteger(revision) && Number.isSafeInteger(recordings))
      current = { revision, recordings };
  });

  async function record(outcome, revision) {
    auto().last = outcome;
    if (outcome.ok) {
      if (Number.isSafeInteger(revision)) auto().lastRevision = revision;
      delete auto().notice;
      const active = new Set([...handles.values()].map((item) => item.temp));
      if (auto().folder)
        await rotateBackups(auto().folder, KEEP, active).catch((error) =>
          process.stderr.write(`Backup rotation failed: ${error}\n`),
        );
    } else if (outcome.reason !== 'manual') auto().notice = outcome;
    await persist();
  }
  const needsBackup = () =>
    !!auto().folder &&
    !!current &&
    current.recordings > 0 &&
    current.revision !== auto().lastRevision;

  /** Asks the page for a backup; resolves when it reports or times out. */
  function requestBackup(window, reason) {
    const id = ++serial;
    let entry;
    const promise = new Promise((resolve) => {
      const timers = [];
      const done = () => {
        timers.forEach(clearTimeout);
        if (pending?.id === id) pending = undefined;
        resolve();
      };
      entry = { id, reason, started: false, resolve: done };
      pending = entry;
      const fail = (error) => {
        running = false;
        void record(
          { ok: false, time: new Date().toISOString(), reason, error },
          undefined,
        ).finally(done);
      };
      timers.push(
        setTimeout(() => {
          if (pending?.id === id && !pending.started)
            fail('The app did not respond to the backup request.');
        }, START_TIMEOUT),
        setTimeout(
          () => {
            if (pending?.id === id)
              fail('The backup took too long and was abandoned.');
          },
          reason === 'close' ? CLOSE_TIMEOUT : 60 * 60 * 1000,
        ),
      );
      window.webContents.send('stratum:auto-backup-request', { id, reason });
    });
    entry.promise = promise;
    return promise;
  }

  /** Backs up on close and periodically while there are changes. */
  function attachWindow(window) {
    let allowClose = false,
      closing = false,
      responsive = true,
      asking = false;
    window.on('unresponsive', () => (responsive = false));
    window.on('responsive', () => (responsive = true));
    const quitNow = async () => {
      allowClose = true;
      await releaseOwner(window.webContents.id);
      if (!window.isDestroyed()) window.close();
    };
    window.on('close', (event) => {
      if (allowClose) return;
      if (
        !needsBackup() ||
        !responsive ||
        window.webContents.isCrashed() ||
        window.webContents.isLoading()
      )
        return;
      event.preventDefault();
      if (closing) {
        if (asking) return;
        asking = true;
        void dialog
          .showMessageBox(window, {
            type: 'question',
            title: 'Automatic backup',
            message: 'Stratum is saving an automatic backup.',
            detail:
              'Quit now to discard this backup. Earlier backups and the workspace saved on this device are unchanged.',
            buttons: ['Keep waiting', 'Quit without backup'],
            defaultId: 0,
            cancelId: 0,
          })
          .then(async ({ response }) => {
            asking = false;
            if (response !== 1 || allowClose) return;
            await record(
              {
                ok: false,
                time: new Date().toISOString(),
                reason: 'close',
                error: 'Skipped when quitting.',
              },
              undefined,
            );
            await quitNow();
          });
        return;
      }
      closing = true;
      window.setProgressBar(2, { mode: 'indeterminate' });
      // A periodic backup already under way covers the close.
      const wait = pending?.promise ?? requestBackup(window, 'close');
      void wait.then(() => {
        if (window.isDestroyed()) return;
        window.setProgressBar(-1);
        void quitNow();
      });
    });
    const timer = setInterval(() => {
      if (
        window.isDestroyed() ||
        closing ||
        running ||
        pending ||
        !responsive ||
        !needsBackup() ||
        Date.now() - lastAttempt < INTERVAL_MINUTES * 60 * 1000
      )
        return;
      lastAttempt = Date.now();
      void requestBackup(window, 'interval');
    }, 60 * 1000);
    timer.unref?.();
    window.on('closed', () => clearInterval(timer));
  }
  return { attachWindow };
}
