import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.setPath('userData', mkdtempSync(join(tmpdir(), 'stratus-preview-smoke-')));

const origin = 'http://localhost:3000';
const timeout = setTimeout(() => {
  process.stderr.write('Preview worker integration timed out.\n');
  app.exit(1);
}, 45000);

// Use actual Chromium origin checks and Vite's HTTP-transformed modules, with
// isolated, non-persistent storage. No app window or user dataset is touched.
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `stratus-preview-test-${Date.now()}`,
      },
    });
    const requests = [];
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: [`${origin}/*worker_file*`] },
      (details, callback) => {
        requests.push(details.url);
        callback({});
      },
    );
    // Navigate to a served source document to establish the real HTTP origin
    // without mounting a second workbench that races the test's initial import.
    await window.loadURL(`${origin}/lib/create-signal-worker.ts`);
    const summaries = await window.webContents.executeJavaScript(`
    (async () => {
      const { createSignalWorker } = await import('/lib/create-signal-worker.ts');
      const worker = createSignalWorker();
      try {
        return await new Promise((resolve, reject) => {
          worker.onerror = event => reject(new Error(event.message || 'Worker failed to load'));
          worker.onmessage = ({ data }) => {
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'project') {
              const nodes = data.project.nodes.filter(node => node.operation === 'bsfc');
              if (data.project.segments.length !== 3 || nodes.length !== 3) {
                reject(new Error('Expected three computed demo ramps'));
                return;
              }
              worker.postMessage({ type: 'view', ids: nodes.map(node => node.id), requestId: 2 });
            }
            if (data.type === 'plots') resolve(data.plots.map(plot => plot.summary));
          };
          worker.postMessage({ type: 'init', requestId: 1 });
        });
      } finally { worker.terminate(); }
    })()
  `);
    assert.equal(summaries.length, 3);
    assert.ok(
      summaries.every(
        (summary) =>
          Number.isFinite(summary.weightedMean) && summary.count > 3000,
      ),
    );
    assert.ok(requests.length > 0, 'Expected an HTTP worker script request');
    assert.ok(requests.every((url) => new URL(url).origin === origin));
    process.stdout.write(
      `Preview worker passed: ${requests[0]}\nThree ramps computed: ${summaries.map((summary) => summary.weightedMean.toFixed(2)).join(', ')} g/kWh.\n`,
    );
    clearTimeout(timeout);
    window.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    clearTimeout(timeout);
    app.exit(1);
  });
