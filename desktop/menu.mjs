// The desktop application menu: File, Edit, View and Help (About, licences,
// Check for updates…, Get Beta Updates). The workbench owns its own shortcuts (Ctrl+Z/Y/K/D,
// Alt+arrows, Escape), so Edit items show their usual keys without
// registering them: Chromium keeps handling copy/paste in fields exactly as
// it did with no menu, and no accelerator can swallow a workbench shortcut.
import { app, Menu, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const ICON = fileURLToPath(new URL('./icons/icon.png', import.meta.url));

/** Packaged builds ship the texts as resources; development uses the checkout. */
function documentPath(kind) {
  if (app.isPackaged)
    return join(
      process.resourcesPath,
      kind === 'licence' ? 'LICENSE.txt' : 'THIRD_PARTY_NOTICES.txt',
    );
  return kind === 'licence'
    ? join(repository, 'LICENSE')
    : join(repository, 'dist-desktop', 'THIRD_PARTY_NOTICES.txt');
}

async function openDocument(kind, window) {
  const path = documentPath(kind);
  const failure = existsSync(path)
    ? await shell.openPath(path)
    : `${path} is missing.`;
  if (failure) {
    const options = {
      type: 'error',
      title: 'Stratum',
      message: `Stratum could not open the ${kind === 'licence' ? 'licence' : 'third-party notices'}.`,
      detail: failure,
    };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
  }
}

async function showAbout(window) {
  const options = {
    type: 'info',
    title: 'About Stratum',
    icon: ICON,
    message: `Stratum ${app.getVersion()}`,
    detail:
      'Signal workflow workbench. Your recordings and workspace stay on ' +
      'this device.\n\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node.js ${process.versions.node}\n\n` +
      'Copyright (c) 2026 Kyle Webb. Released under the MIT licence.\n' +
      'Stratum includes open-source software listed in its third-party notices.',
    buttons: ['OK', 'Licence', 'Third-party notices'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (response === 1) await openDocument('licence', window);
  if (response === 2) await openDocument('notices', window);
}

/** Builds the menu around the updater from desktop/updater.mjs. */
export function applicationMenu({ updater }) {
  const shown = (role) => ({ role, registerAccelerator: false });
  return Menu.buildFromTemplate([
    { label: '&File', submenu: [{ role: 'quit' }] },
    {
      label: '&Edit',
      submenu: [
        shown('cut'),
        shown('copy'),
        shown('paste'),
        { type: 'separator' },
        shown('selectAll'),
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom', accelerator: 'CommandOrControl+0' },
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { role: 'zoomOut', accelerator: 'CommandOrControl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ]),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Check for &Updates…',
          click: () => void updater.checkNow(),
        },
        // Copies that cannot update (development, portable) omit the option.
        ...(updater.supported
          ? [
              {
                label: 'Get &Beta Updates',
                type: 'checkbox',
                checked: updater.betaUpdates(),
                click: (item) => void updater.setBetaUpdates(item.checked),
              },
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Third-party &Notices',
          click: (_item, window) => void openDocument('notices', window),
        },
        {
          label: '&About Stratum',
          click: (_item, window) => void showAbout(window),
        },
      ],
    },
  ]);
}
