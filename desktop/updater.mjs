// Background updates for the installed Windows app through electron-updater.
// The feed is written into resources/app-update.yml at packaging time (see
// desktop/package.mjs and docs/releasing.md). Updates download quietly; the
// user chooses when to restart, and an unapplied update installs on quit.
import { app, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Leave startup to the workspace before touching the network.
const STARTUP_DELAY_MS = 10_000;

/** Why this copy cannot update itself, or undefined when it can. */
function unsupportedReason() {
  if (!app.isPackaged)
    return 'Development runs do not update. Install Stratum with its installer to receive updates.';
  if (process.platform !== 'win32')
    return 'Automatic updates are available for the Windows installer only.';
  if (!existsSync(join(process.resourcesPath, 'app-update.yml')))
    return 'This build was packaged without an update feed.';
  // Only the NSIS installer can replace an installation; a copied folder
  // (the dir target) has no uninstaller beside the executable.
  if (
    !existsSync(
      join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`),
    )
  )
    return 'This portable copy does not update itself. Install Stratum with its installer to receive updates.';
  return undefined;
}

function show(options) {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

/**
 * `enabled` is false for smoke tests and the report mockup, which must never
 * reach the network or show update dialogs. `beforeInstall` finishes work
 * that must not race the installer (the automatic close-time backup).
 */
export function createUpdater({ enabled, beforeInstall }) {
  let updater;
  /** @type {'idle' | 'checking' | 'downloading' | 'ready'} */
  let state = 'idle';
  let readyVersion = '';
  let prompting = false;

  async function load() {
    if (updater) return updater;
    // electron-updater is CommonJS; its exports are the default import.
    const { autoUpdater } = (await import('electron-updater')).default;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      state = 'ready';
      readyVersion = info.version;
      void promptRestart();
    });
    autoUpdater.on('error', (error) => {
      if (state !== 'ready') state = 'idle';
      process.stderr.write(`Stratum update failed: ${error?.message}\n`);
    });
    updater = autoUpdater;
    return updater;
  }

  async function promptRestart() {
    if (prompting) return;
    prompting = true;
    const { response } = await show({
      type: 'info',
      title: 'Update ready',
      message: `Stratum ${readyVersion} is ready to install.`,
      detail:
        'Restart Stratum to finish updating. Your workspace is saved on this ' +
        'device and reopens afterwards.\n\nIf you choose Later, the update ' +
        'installs the next time you quit Stratum.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    prompting = false;
    if (response !== 0) return;
    // The installer starts at once, so back up first rather than on close.
    await beforeInstall?.().catch((error) =>
      process.stderr.write(`Backup before update failed: ${error}\n`),
    );
    setImmediate(() => updater.quitAndInstall(false, true));
  }

  async function check(interactive) {
    const reason = enabled
      ? unsupportedReason()
      : 'Updates are turned off for this run.';
    if (reason) {
      if (interactive)
        await show({
          type: 'info',
          title: 'Check for updates',
          message: 'This copy of Stratum cannot update automatically.',
          detail: reason,
        });
      return;
    }
    if (state === 'ready') {
      await promptRestart();
      return;
    }
    if (state !== 'idle') {
      if (interactive)
        await show({
          type: 'info',
          title: 'Check for updates',
          message:
            state === 'checking'
              ? 'Stratum is already checking for updates.'
              : 'An update is downloading in the background.',
          detail: 'You will be asked to restart when it is ready.',
        });
      return;
    }
    state = 'checking';
    try {
      const result = await (await load()).checkForUpdates();
      if (result?.isUpdateAvailable) {
        if (state === 'checking') state = 'downloading';
        // Failures are reported through the 'error' event.
        result.downloadPromise?.catch(() => undefined);
        if (interactive)
          await show({
            type: 'info',
            title: 'Update available',
            message: `Stratum ${result.updateInfo.version} is available.`,
            detail:
              'It is downloading in the background. You will be asked to ' +
              'restart when it is ready.',
          });
      } else {
        state = 'idle';
        if (interactive)
          await show({
            type: 'info',
            title: 'Check for updates',
            message: 'Stratum is up to date.',
            detail: `You have version ${app.getVersion()}.`,
          });
      }
    } catch (error) {
      state = 'idle';
      const message = error instanceof Error ? error.message : String(error);
      if (interactive)
        await show({
          type: 'error',
          title: 'Check for updates',
          message: 'Stratum could not check for updates.',
          detail: `${message}\n\nCheck the internet connection and try again.`,
        });
      else process.stderr.write(`Stratum update check failed: ${message}\n`);
    }
  }

  return {
    /** Checks quietly once the window has had time to load. */
    checkOnStartup() {
      if (enabled && !unsupportedReason())
        setTimeout(() => void check(false), STARTUP_DELAY_MS);
    },
    /** The Help menu's "Check for updates…": always reports an outcome. */
    checkNow: () => check(true),
  };
}
