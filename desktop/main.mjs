import {
  app,
  BrowserWindow,
  Menu,
  net,
  protocol,
  session,
  dialog,
} from 'electron';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
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
const uiSmoke = process.argv.includes('--ui-smoke');
const smoke = process.argv.includes('--smoke') || uiSmoke;
if (smoke)
  app.setPath(
    'userData',
    mkdtempSync(resolve(tmpdir(), 'stratus-native-smoke-')),
  );
// A running user app must not cause a smoke test to exit without testing.
const singleInstance = smoke || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window;
const downloads = [];
const downloaded = new Set();
if (smoke)
  setTimeout(
    () => {
      process.stderr.write('Desktop startup or integration test timed out.\n');
      app.exit(1);
    },
    uiSmoke ? 120000 : 60000,
  );

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
      backgroundThrottling: !smoke,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (!smoke) {
    let recovering = false;
    const recover = async (detail) => {
      if (recovering || window.isDestroyed()) return;
      recovering = true;
      const choice = await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Stratus workspace recovery',
        message: 'The workspace stopped responding or could not load.',
        detail: `${detail}\nThe last committed workspace is still saved.`,
        buttons: ['Reload workspace', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      recovering = false;
      if (choice.response === 0) window.webContents.reload();
      else app.quit();
    };
    window.webContents.on(
      'render-process-gone',
      (_event, details) => void recover(details.reason),
    );
    window.webContents.on(
      'did-fail-load',
      (_event, _code, description) => void recover(description),
    );
    window.on(
      'unresponsive',
      () => void recover('The interface is not responding.'),
    );
  }
  if (smoke) {
    window.webContents.on('console-message', async ({ message }) => {
      if (message.startsWith('TypeError') || message.startsWith('Error:'))
        process.stderr.write(`${message}\n`);
      if (message.startsWith('STRATUS_SMOKE_OK')) {
        process.stdout.write(`${message}\n`);
        if (uiSmoke) {
          try {
            await Promise.all(downloads);
            for (const name of [
              'Stratus-values-1.csv',
              'Stratus-values-40.csv',
              'Stratus-samples-1.csv',
              'Stratus-report-1.html',
              'Motor comparison.svg',
              'Motor comparison.png',
            ])
              assert.ok(
                downloaded.has(name),
                `Missing native download: ${name}`,
              );
            const contents = (name) =>
              readFileSync(resolve('outputs', name), 'utf8');
            assert.ok(
              contents('Motor comparison.svg').includes(
                'Review marker &lt;safe&gt;',
              ),
            );
            assert.equal(
              readFileSync(resolve('outputs', 'Motor comparison.png'))
                .subarray(1, 4)
                .toString(),
              'PNG',
            );
            assert.equal(
              contents('Stratus-values-1.csv').split('\r\n').length,
              2,
            );
            assert.equal(
              contents('Stratus-values-40.csv').split('\r\n').length,
              41,
            );
            const sampleLines = contents('Stratus-samples-1.csv')
              .trim()
              .split('\r\n');
            assert.ok(sampleLines.length > 2);
            for (const line of sampleLines.slice(1)) {
              const time = Number(line.split(',').at(-2));
              assert.ok(
                time >= 15 && time <= 20,
                'Nested export time outside selected signal',
              );
            }
            assert.ok(
              contents('Stratus-report-1.html').includes(
                'Contributing operation history',
              ),
            );
            const backupName = [...downloaded].find((name) =>
              name.endsWith('.stratus'),
            );
            assert.ok(backupName, 'Missing workspace backup download');
            const archive = contents(backupName).trimEnd().split('\n');
            const header = JSON.parse(archive[0]);
            assert.equal(header.format, 'stratus-workspace');
            assert.ok(header.project.workflowSteps.length >= 9);
            assert.equal(JSON.parse(archive.at(-1)).complete, true);
            process.stdout.write(
              'Native downloads verified: exact one-value and 40-value scopes, nested samples and standalone report.\n',
            );
          } catch (error) {
            process.stderr.write(
              `Export verification failed: ${error.message}\n`,
            );
            app.exit(1);
            return;
          }
          window.setContentSize(1540, 940);
          await new Promise((resolve) => setTimeout(resolve, 300));
          // Flush the hidden window's first frame before saving review images.
          await window.webContents.capturePage(undefined, { stayHidden: true });
          await new Promise((resolve) => setTimeout(resolve, 300));
          const verifyChartLayout = async () => {
            assert.ok(
              await window.webContents.executeJavaScript(`
                (() => {
                  const chart = document.querySelector('.scratchpad-canvas .signal-chart svg[data-fill-height]');
                  const height = chart.viewBox.baseVal.height;
                  const unit = chart.lastElementChild;
                  return Math.abs(chart.clientHeight - height) < 1 &&
                    Math.abs(chart.clientWidth - chart.viewBox.baseVal.width) < 1 &&
                    Number(unit.getAttribute('y')) > height - 20;
                })()
              `),
              'Resized plots must keep labels at the axis and preserve pointer coordinates',
            );
          };
          await verifyChartLayout();
          const output = resolve('outputs');
          mkdirSync(output, { recursive: true });
          writeFileSync(
            resolve(output, 'workflow-desktop.png'),
            (
              await window.webContents.capturePage(undefined, {
                stayHidden: true,
              })
            ).toPNG(),
          );
          window.setContentSize(860, 820);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await verifyChartLayout();
          writeFileSync(
            resolve(output, 'workflow-desktop-compact.png'),
            (
              await window.webContents.capturePage(undefined, {
                stayHidden: true,
              })
            ).toPNG(),
          );
          assert.ok(
            await window.webContents.executeJavaScript(`
            document.querySelector('.scratchpad-canvas').getBoundingClientRect().bottom < innerHeight
          `),
            'The compact viewport must expose the complete plot and summary',
          );
          await window.webContents.executeJavaScript(`
            [...document.querySelectorAll('[role="treeitem"][data-kind="output"]')]
              .find(row => row.title.includes('15–20 s'))?.click()
          `);
          await new Promise((resolve) => setTimeout(resolve, 300));
          writeFileSync(
            resolve(output, 'workflow-desktop-derived.png'),
            (
              await window.webContents.capturePage(undefined, {
                stayHidden: true,
              })
            ).toPNG(),
          );
        }
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
  try {
    await window.loadURL(
      `stratus://app/index.html${uiSmoke ? '?ui-smoke=1' : smoke ? '?smoke=1' : process.argv.includes('--refresh-example') ? '?refresh-example=1' : ''}`,
    );
  } catch (error) {
    // did-fail-load owns recovery in normal mode; do not exit underneath its dialog.
    if (smoke || window.isDestroyed()) throw error;
  }
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
      if (uiSmoke)
        session.defaultSession.on('will-download', (_event, item) => {
          const name = item.getFilename();
          const output = resolve('outputs');
          mkdirSync(output, { recursive: true });
          item.setSavePath(resolve(output, name));
          downloads.push(
            new Promise((resolveDownload) =>
              item.once('done', (_event, state) => {
                if (state === 'completed') downloaded.add(name);
                resolveDownload();
              }),
            ),
          );
        });
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
      if (!smoke)
        dialog.showErrorBox(
          'Stratus could not start',
          error instanceof Error ? error.message : String(error),
        );
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      app.exit(1);
    });
}
