import { app, BrowserWindow, Menu, net, protocol, session } from 'electron';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

app.setName('Stratus');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stratus',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const root = fileURLToPath(new URL('../dist-desktop/', import.meta.url));
const smoke = process.argv.includes('--smoke');
if (smoke)
  app.setPath(
    'userData',
    mkdtempSync(resolve(tmpdir(), 'stratus-native-smoke-')),
  );
// A running user app must not cause a smoke test to exit without testing.
const singleInstance = smoke || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window;
if (smoke)
  setTimeout(() => {
    process.stderr.write('Desktop startup or integration test timed out.\n');
    app.exit(1);
  }, 60000);

async function createWindow() {
  window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 820,
    minHeight: 720,
    show: !smoke,
    backgroundColor: '#13191d',
    title: 'Stratus · Signal Workbench',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (smoke) {
    window.webContents.on('console-message', ({ message }) => {
      if (message.startsWith('STRATUS_SMOKE_OK')) {
        process.stdout.write(`${message}\n`);
        app.exit(0);
      }
      if (message.startsWith('STRATUS_SMOKE_FAILED')) {
        process.stderr.write(`${message}\n`);
        app.exit(1);
      }
    });
    window.webContents.on('did-fail-load', (_event, code, description) => {
      process.stderr.write(`Desktop load failed: ${code} ${description}\n`);
      app.exit(1);
    });
  }
  await window.loadURL(`stratus://app/index.html${smoke ? '?smoke=1' : ''}`);
}

if (singleInstance) {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  void app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      protocol.handle('stratus', async (request) => {
        const url = new URL(request.url);
        if (url.host !== 'app')
          return new Response('Not found', { status: 404 });
        let pathname;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return new Response('Invalid path', { status: 400 });
        }
        const target = resolve(root, `.${pathname}`);
        const rel = relative(root, target);
        if (
          rel.startsWith('..') ||
          isAbsolute(rel) ||
          !['.html', '.js', '.css', '.woff2', '.svg', '.png', '.ico'].includes(
            extname(target),
          )
        )
          return new Response('Not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(target).toString());
        const headers = new Headers(response.headers);
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      });
      await createWindow();
      app.on('activate', () => {
        if (!BrowserWindow.getAllWindows().length) void createWindow();
      });
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
      });
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      app.exit(1);
    });
}
