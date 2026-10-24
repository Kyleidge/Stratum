// Background updates for the installed Windows app through electron-updater.
// The feed is written into resources/app-update.yml at packaging time (see
// desktop/package.mjs and docs/releasing.md). Updates download quietly; the
// user chooses when to restart, and an unapplied update installs on quit.
// Help → Get Beta Updates (stored in userData/updates.json; on by default for
// a beta) also offers prerelease builds: the newest release, beta or stable.
//
// Help → Test a Pull Request… switches to a pull request's test build
// (desktop/test-builds.mjs) and then follows only that pull request's newer
// builds, until the user returns to regular updates (offered when it closes).
// updates.json records the choice as `pullRequest`: a number, or null after
// returning; a test build installed by hand follows its own pull request.
// Moving between the two may install a lower version; within one, only newer.
import { app, BrowserWindow, dialog, net, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildInfo } from './build-info.mjs';
import {
  TEST_BUILD_LABEL,
  age,
  feedRepository,
  listTestBuilds,
  pullRequestOfVersion,
  pullRequestState,
  raisedFormats,
  testBuildFeed,
} from './test-builds.mjs';

// Leave startup to the workspace before touching the network.
const STARTUP_DELAY_MS = 10_000;
// Later checks pick up builds published while Stratum stays open.
const CHECK_INTERVAL_MS = 60 * 60_000;
// Coming back to the window checks too, at most this often.
const FOCUS_CHECK_MS = 5 * 60_000;
// A dialog of command links stays readable up to about this many.
const LISTED_BUILDS = 8;

const settingsPath = () => join(app.getPath('userData'), 'updates.json');
const feedPath = () => join(process.resourcesPath, 'app-update.yml');

function readSettings() {
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    if (settings && typeof settings === 'object') return settings;
  } catch {
    // Missing or unreadable: follow the installed version.
  }
  return {};
}

/** Why this copy cannot update itself, or undefined when it can. */
function unsupportedReason() {
  if (!app.isPackaged)
    return 'Development runs do not update. Install Stratum with its installer to receive updates.';
  if (process.platform !== 'win32')
    return 'Automatic updates are available for the Windows installer only.';
  if (!existsSync(feedPath()))
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

const short = (commit) => commit.slice(0, 7);
const fetchJson = (url, init) => net.fetch(url, init);

function formatWarning(raised, change) {
  if (!raised.length) return '';
  const list = raised
    .map(({ name, from, to }) => `${name} format from version ${from} to ${to}`)
    .join(', the ');
  return `\n\n${change} the ${list}. ${
    raised.some(({ format }) => format === 'workspace')
      ? 'Once a build opens your workspace in the newer format, builds without this change refuse to open it until it is released'
      : 'Files saved in the newer format open only in builds with this change'
  }, so going back may mean restoring a backup made before switching.`;
}

/**
 * `enabled` is false for smoke tests and the report mockup, which must never
 * reach the network or show update dialogs. `beforeInstall` finishes work
 * that must not race the installer (the automatic close-time backup);
 * `autoBackups` says whether automatic backups are on.
 */
export function createUpdater({ enabled, beforeInstall, autoBackups }) {
  let updater;
  /** @type {'idle' | 'checking' | 'downloading' | 'ready'} */
  let state = 'idle';
  let readyVersion = '';
  let prompting = false;
  let settings;
  let lastCheck = 0;
  // Pull requests whose closing was already reported this session.
  const reportedClosed = new Set();

  const supported = enabled && !unsupportedReason();
  const repository = supported
    ? feedRepository(readFileSync(feedPath(), 'utf8'))
    : undefined;
  const running = pullRequestOfVersion(app.getVersion());

  const current = () => (settings ??= readSettings());
  const beta = () =>
    typeof current().beta === 'boolean'
      ? current().beta
      : app.getVersion().includes('-');
  /** The pull request this copy follows, or undefined for regular updates. */
  function followed() {
    const { pullRequest } = current();
    if (pullRequest === null) return undefined;
    if (Number.isSafeInteger(pullRequest?.number)) return pullRequest.number;
    return running;
  }

  async function save(changes) {
    settings = { ...current(), ...changes };
    await writeFile(
      settingsPath(),
      `${JSON.stringify(settings, null, 2)}\n`,
    ).catch((error) =>
      process.stderr.write(`Could not save update settings: ${error}\n`),
    );
  }

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

  /** Points the updater at the followed pull request or the regular feed. */
  function configure(client, pullRequest) {
    if (pullRequest) {
      client.setFeedURL({
        provider: 'generic',
        url: testBuildFeed(repository, pullRequest),
      });
      client.channel = 'latest';
    } else {
      if (repository) client.setFeedURL({ provider: 'github', ...repository });
      client.allowPrerelease = beta();
      // An explicit channel keeps a test build's own channel (`pr`) out of
      // the GitHub feed's choice, and stops a stable copy taking whatever
      // release is newest. Generic feeds have only latest.yml.
      client.channel = repository && beta() ? 'beta' : 'latest';
    }
    // Setting the channel allows downgrades; allow them only between tracks.
    client.allowDowngrade = running !== pullRequest;
  }

  async function promptRestart() {
    if (prompting) return;
    prompting = true;
    const pullRequest = pullRequestOfVersion(readyVersion);
    const { response } = await show({
      type: 'info',
      title: 'Update ready',
      message: pullRequest
        ? `The test build of pull request #${pullRequest} (${readyVersion}) is ready to install.`
        : `Stratum ${readyVersion} is ready to install.`,
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

  /** A followed pull request's build is gone: offer regular updates. */
  async function buildMissing(pullRequest, interactive) {
    let status;
    try {
      status = await pullRequestState(repository, fetchJson, pullRequest);
    } catch {
      status = undefined;
    }
    // An open pull request's build may be mid-replacement, and an unknown
    // state is no reason to interrupt; quiet checks try again later.
    if (status !== 'merged' && status !== 'closed' && !interactive) return;
    if (!interactive && reportedClosed.has(pullRequest)) return;
    reportedClosed.add(pullRequest);
    await returnToRegular(
      status === 'merged'
        ? `Pull request #${pullRequest} was merged.`
        : status === 'closed'
          ? `Pull request #${pullRequest} was closed.`
          : `Pull request #${pullRequest} has no test build right now.`,
      status === 'merged'
        ? 'Its changes reach beta updates a few minutes after merging.'
        : status === 'open'
          ? `Its test build is being replaced, or the pull request lost its ${TEST_BUILD_LABEL} label.`
          : undefined,
    );
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
      // Hourly checks leave the restart to Help or quitting.
      if (interactive) await promptRestart();
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
    lastCheck = Date.now();
    const pullRequest = repository ? followed() : undefined;
    try {
      const client = await load();
      configure(client, pullRequest);
      const result = await client.checkForUpdates();
      if (result?.isUpdateAvailable) {
        if (state === 'checking') state = 'downloading';
        // Failures are reported through the 'error' event.
        result.downloadPromise?.catch(() => undefined);
        if (interactive)
          await show({
            type: 'info',
            title: 'Update available',
            message: pullRequestOfVersion(result.updateInfo.version)
              ? `A test build of pull request #${pullRequestOfVersion(result.updateInfo.version)} (${result.updateInfo.version}) is available.`
              : `Stratum ${result.updateInfo.version} is available.`,
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
            detail: pullRequest
              ? `You have the newest test build of pull request #${pullRequest} (${app.getVersion()}). Help → Test a Pull Request… returns to regular updates.`
              : `You have version ${app.getVersion()}.` +
                (beta() ? ' Beta updates are on.' : ''),
          });
      }
    } catch (error) {
      state = 'idle';
      if (pullRequest && error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
        return buildMissing(pullRequest, interactive);
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

  /** Whether a switch can start now; explains why not otherwise. */
  async function ready(title) {
    if (state === 'checking' || state === 'downloading') {
      await show({
        type: 'info',
        title,
        message: 'Stratum is checking for or downloading an update.',
        detail: 'Try again when it has finished.',
      });
      return false;
    }
    return true;
  }

  /** Stops following a pull request and installs the regular build. */
  async function returnToRegular(message, reason) {
    const title = 'Return to regular updates';
    if (!(await ready(title))) return;
    const pullRequest = followed();
    const raised = raisedFormats(
      current().pullRequest?.returnFormats,
      buildInfo().formats,
    );
    const { response } = await show({
      type: raised.length ? 'warning' : 'question',
      title,
      message: message ?? 'Return to regular updates?',
      detail:
        (reason ? `${reason}\n\n` : '') +
        `Stratum stops following pull request #${pullRequest} and installs ` +
        `the newest ${beta() ? 'beta or release' : 'release'}, even if it is ` +
        'older than this test build.' +
        formatWarning(raised, 'This test build raised'),
      buttons: ['Return to regular updates', 'Keep this build'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    await save({ pullRequest: null });
    // A test build downloaded but not installed is replaced by this one.
    if (state === 'ready') state = 'idle';
    await check(true);
  }

  /** Confirms and starts following one pull request's test build. */
  async function install(build) {
    const title = 'Test a pull request';
    const raised = raisedFormats(buildInfo().formats, build.formats);
    const { response } = await show({
      type: raised.length ? 'warning' : 'question',
      title,
      message: `Install the test build of pull request #${build.pullRequest}?`,
      detail:
        `${build.title}\n${build.branch} at ${short(build.commit)}, built ` +
        `${age(build.builtAt)} (version ${build.version}).\n\n` +
        'A test build holds changes that have not been merged. While you ' +
        'test it, Stratum updates only to newer builds of this pull ' +
        'request. Help → Test a Pull Request… returns to regular updates, ' +
        'and Stratum offers to when the pull request closes.' +
        formatWarning(raised, 'This build raises') +
        '\n\n' +
        (autoBackups?.()
          ? 'Stratum backs up your workspace automatically before restarting into it.'
          : 'Automatic backups are off: save a backup first (Workspace → Save workspace backup…).'),
      buttons: ['Install test build', 'Open pull request', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1 && build.url) {
      await shell.openExternal(build.url);
      return;
    }
    if (response !== 0) return;
    if (!(await ready(title))) return;
    const previous = current().pullRequest;
    await save({
      pullRequest: {
        number: build.pullRequest,
        title: build.title,
        // The regular build's formats, kept across switches between pull
        // requests, for the warning when returning.
        returnFormats:
          previous?.returnFormats ??
          (running ? undefined : buildInfo().formats),
      },
    });
    if (state === 'ready') state = 'idle';
    await check(true);
  }

  /** Help → Test a Pull Request…: lists test builds to switch to. */
  async function chooseTestBuild() {
    const title = 'Test a pull request';
    if (!repository) {
      await show({
        type: 'info',
        title,
        message: 'This copy of Stratum cannot install test builds.',
        detail:
          unsupportedReason() ??
          (enabled
            ? 'Its update feed is not a GitHub repository.'
            : 'Updates are turned off for this run.'),
      });
      return;
    }
    if (!(await ready(title))) return;
    let builds;
    try {
      builds = await listTestBuilds(repository, fetchJson);
    } catch (error) {
      await show({
        type: 'error',
        title,
        message: 'Stratum could not list the test builds.',
        detail: `${error instanceof Error ? error.message : String(error)}\n\nCheck the internet connection and try again.`,
      });
      return;
    }
    const pullRequest = followed();
    const listed = builds.slice(0, LISTED_BUILDS);
    const buttons = listed.map((build) => {
      const installed = build.version === app.getVersion();
      const raised = raisedFormats(buildInfo().formats, build.formats);
      return (
        `#${build.pullRequest}  ${build.title}` +
        (installed ? ' (installed)' : '') +
        `\n${build.branch} at ${short(build.commit)}, built ${age(build.builtAt)}` +
        (raised.length ? ', new file formats' : '')
      );
    });
    if (pullRequest) buttons.push('Return to regular updates');
    buttons.push('Cancel');
    const { response } = await show({
      type: 'question',
      title,
      message: listed.length
        ? 'Choose a pull request to test'
        : 'No pull requests have test builds',
      detail:
        (pullRequest
          ? `You are testing pull request #${pullRequest}.\n\n`
          : '') +
        (listed.length
          ? 'Stratum installs its newest build, then updates to newer builds of it.'
          : `Add the ${TEST_BUILD_LABEL} label to a pull request on GitHub; its build appears here a few minutes later.`) +
        (builds.length > listed.length
          ? ` Showing the ${listed.length} newest of ${builds.length}.`
          : ''),
      buttons,
      cancelId: buttons.length - 1,
      // Windows shows each build as a command link with a second line.
      noLink: false,
    });
    if (response < listed.length) await install(listed[response]);
    else if (pullRequest && response === listed.length) await returnToRegular();
  }

  return {
    /** Whether this copy updates itself (and shows the beta option). */
    supported,
    /** Whether Help offers pull request test builds. */
    testBuilds: !!repository,
    /**
     * Checks quietly once the window has had time to load, then hourly and
     * when Stratum comes back to the front after a while.
     */
    checkOnStartup() {
      if (!supported) return;
      setTimeout(() => {
        void check(false);
        setInterval(() => void check(false), CHECK_INTERVAL_MS).unref();
        app.on('browser-window-focus', () => {
          if (Date.now() - lastCheck >= FOCUS_CHECK_MS) void check(false);
        });
      }, STARTUP_DELAY_MS);
    },
    /** The Help menu's "Check for updates…": always reports an outcome. */
    checkNow: () => check(true),
    betaUpdates: beta,
    /** Help → Get Beta Updates; turning it on checks at once. */
    async setBetaUpdates(on) {
      await save({ beta: on });
      if (on) await check(true);
    },
    chooseTestBuild,
  };
}
