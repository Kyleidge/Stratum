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
    const results = await window.webContents.executeJavaScript(`
    (async () => {
      const { createSignalWorker } = await import('/lib/create-signal-worker.ts');
      const worker = createSignalWorker();
      let requestId = 0;
      const send = request => new Promise((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message || 'Worker failed to load'));
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') return;
          if (data.type === 'error') reject(new Error(data.message));
          else resolve(data);
        };
        worker.postMessage({ ...request, requestId: ++requestId });
      });
      try {
        const { project } = await send({ type: 'init' });
        const nodes = project.nodes.filter(node => node.operation === 'bsfc');
        if (project.segments.length !== 3 || nodes.length !== 3) throw new Error('Expected three computed demo segments');
        const { plots } = await send({ type: 'view', ids: nodes.map(node => node.id) });
        const source = project.sources[0];
        const definition = {
          method: 'triggers', boundary: 'clip', minimumDuration: 0,
          start: { signalId: source.channels[0], edge: 'rising', threshold: 900, offset: -20 },
          end: { signalId: source.channels[0], edge: 'falling', threshold: 900, offset: 0 },
        };
        const { plan } = await send({ type: 'segment-preview', sourceId: source.id, definition, targetIds: source.channels });
        if (plan.ranges.length !== 3 || !plan.ranges[0].clipped || plan.ranges[0].start !== 0) throw new Error('Trigger preview or negative offset failed');
        const created = await send({ type: 'segment', sourceId: source.id, definition, targetIds: source.channels });
        if (created.project.segments.length !== 6 || created.project.nodes.length !== project.nodes.length + 12) throw new Error('Generic segmentation must create crops only');
        const { plan: windows } = await send({ type: 'segment-preview', sourceId: source.id, definition: { method: 'windows', boundary: 'clip', start: 0, end: 180, duration: 60, step: 60, includePartial: false }, targetIds: source.channels });
        if (windows.ranges.length !== 3) throw new Error('Window preview failed');
        const crops = created.project.segments.slice(-3).map(segment => segment.nodes[0]);
        const smooth = await send({ type: 'derive-many', parentIds: crops, operation: 'smooth', parameter: 5 });
        const smoothed = smooth.project.nodes.slice(-3);
        if (!smoothed.every((node, index) => node.parents[0] === crops[index] && node.batchId === smoothed[0].batchId)) throw new Error('Batch moving average lost independent parents');
        const extrema = await send({ type: 'derive-many', parentIds: smoothed.map(node => node.id), operation: 'min-max', parameter: 0 });
        const { plots: extremaPlots } = await send({ type: 'view', ids: extrema.project.nodes.slice(-3).map(node => node.id) });
        if (extremaPlots.length !== 3 || extremaPlots.some(plot => plot.summary.count !== 2 || !Number.isFinite(plot.summary.max))) throw new Error('Per-segment extrema failed');
        return { summaries: plots.map(plot => plot.summary), segments: plan.ranges.length, clipped: plan.ranges.filter(range => range.clipped).length };
      } finally { worker.terminate(); }
    })()
  `);
    const { summaries } = results;
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
      `Preview worker passed: ${requests[0]}\nThree segments computed: ${summaries.map((summary) => summary.weightedMean.toFixed(2)).join(', ')} g/kWh.\nIndependent moving-average and Min / Max batches passed.\n`,
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
