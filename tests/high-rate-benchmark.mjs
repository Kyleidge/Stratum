// Run after pnpm desktop:build: pnpm exec electron tests/high-rate-benchmark.mjs
// BENCH_REPEATS defaults to 2. BENCH_CASES selects seconds x channels.
// BENCH_YIELD=scheduler runs an isolated scheduling diagnostic.
import assert from 'node:assert/strict';
import { app, BrowserWindow, net, protocol } from 'electron';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
// Optional diagnostic changes only the worker response served by this harness.
// It never rewrites the application source or production build on disk.
const variant = process.env.BENCH_YIELD ?? 'baseline';
assert.ok(['baseline', 'scheduler'].includes(variant));
const output = resolve(
  root,
  `outputs/high-rate-benchmark${variant === 'baseline' ? '' : `-${variant}`}`,
);
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), 'stratus-high-rate-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
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
const assets = resolve(root, 'dist-desktop/assets');
const workers = readdirSync(assets).filter((name) =>
  /^signal\.worker-.*\.js$/.test(name),
);
assert.equal(workers.length, 1, 'Build the desktop renderer first');
let workerSource = readFileSync(resolve(assets, workers[0]), 'utf8');
if (variant === 'scheduler') {
  const pattern = /new Promise\(([A-Za-z_$][\w$]*)=>setTimeout\(\1,0\)\)/g;
  assert.equal(
    [...workerSource.matchAll(pattern)].length,
    3,
    'Update the diagnostic replacement for this worker build',
  );
  workerSource = workerSource.replace(pattern, 'globalThis.scheduler.yield()');
}
const cases = (process.env.BENCH_CASES ?? '1x1,10x1,60x1,10x4,60x4')
  .split(',')
  .map((entry) => {
    assert.match(entry, /^\d+x\d+$/);
    const [seconds, channels] = entry.split('x').map(Number);
    assert.ok(seconds > 0 && seconds <= 60 && channels > 0 && channels <= 4);
    return { seconds, channels, rate: 100000, rows: seconds * 100000 };
  });
const repeats = Number(process.env.BENCH_REPEATS ?? 2);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
const report = {
  variant,
  date: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  environment: {
    platform: process.platform,
    release: release(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    versions: process.versions,
  },
  runs: [],
};

// A disk-backed File, as selected by the user. Avoid a giant in-memory CSV string.
function fixture(config) {
  const path = resolve(output, `${config.seconds}s-${config.channels}ch.csv`);
  const fd = openSync(path, 'w');
  try {
    writeSync(
      fd,
      `time,${Array.from({ length: config.channels }, (_, c) => `Channel ${c + 1} [V]`).join(',')}\n`,
    );
    for (let start = 0; start < config.rows; start += 16384) {
      const lines = [];
      for (let i = start; i < Math.min(start + 16384, config.rows); i++) {
        const values = Array.from({ length: config.channels }, (_, c) =>
          (
            Math.sin((2 * Math.PI * (i % 100)) / 100 + c * 0.2) +
            0.1 * Math.sin((2 * Math.PI * (i % 17)) / 17)
          ).toFixed(6),
        );
        lines.push(`${(i / config.rate).toFixed(5)},${values.join(',')}\n`);
      }
      writeSync(fd, lines.join(''));
    }
  } finally {
    closeSync(fd);
  }
  return path;
}

// This function runs in sandboxed Chromium and talks to the production worker.
async function benchmark(config) {
  const timings = [];
  let worker;
  let serial = 0;
  const pending = new Map();
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  function startWorker() {
    worker = new Worker('/worker.js');
    worker.onerror = (event) => {
      for (const request of pending.values())
        request.reject(new Error(event.message));
      pending.clear();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') return;
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      if (data.type === 'error') request.reject(new Error(data.message));
      else request.resolve(data);
    };
  }
  const send = (request) =>
    new Promise((resolveRequest, reject) => {
      const requestId = ++serial;
      pending.set(requestId, { resolve: resolveRequest, reject });
      worker.postMessage({ ...request, requestId });
    });
  async function timed(name, request, validate = () => {}, expectedError) {
    const gaps = [];
    let previous = performance.now();
    const pulse = setInterval(() => {
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
    }, 20);
    const start = performance.now();
    let response;
    let constraint;
    try {
      response = await send(request);
    } catch (error) {
      if (!expectedError?.test(error.message)) throw error;
      constraint = error.message;
    } finally {
      clearInterval(pulse);
    }
    const ms = performance.now() - start;
    if (!constraint) validate(response);
    const result = {
      name,
      ms,
      maxHeartbeatGapMs: gaps.length ? Math.max(...gaps) : null,
      ...(constraint ? { constraint } : {}),
    };
    timings.push(result);
    console.log(`BENCH_STEP ${JSON.stringify(result)}`);
    return response;
  }
  const plotsValid = (response, count, rows) => {
    check(
      response.type === 'plots' && response.plots.length === count,
      'Wrong plot count',
    );
    for (const plot of response.plots) {
      check(
        plot.summary.count === rows,
        `Wrong sample count: ${plot.summary.count}, expected ${rows}`,
      );
      check(
        Number.isFinite(plot.summary.min) && Number.isFinite(plot.summary.max),
        'Invalid extrema',
      );
      check(plot.points.length <= 3502, 'Envelope is unbounded');
    }
  };
  startWorker();
  try {
    await send({ type: 'init-workflow' });
    const imported = await timed('import', {
      type: 'import',
      file: document.querySelector('input').files[0],
    });
    const source = imported.project.sources.at(-1);
    check(
      source.rows === config.rows && source.channels.length === config.channels,
      'Import count mismatch',
    );
    const ids = source.channels;
    const id = ids[0];
    // Clear engine caches, while deliberately retaining the OS disk cache.
    worker.terminate();
    startWorker();
    await timed('reopen', { type: 'init-workflow' });
    const first = await timed('full-first', { type: 'view', ids }, (r) =>
      plotsValid(r, ids.length, config.rows),
    );
    await timed('full-cached', { type: 'view', ids }, (r) =>
      plotsValid(r, ids.length, config.rows),
    );
    for (let i = 0; i < 3; i++) {
      const startIndex = Math.floor(config.rows / 2) + i * 2000;
      const range = [
        startIndex / config.rate,
        (startIndex + 1000) / config.rate,
      ];
      await timed(
        `zoom-${i + 1}`,
        {
          type: 'view',
          ids,
          ranges: Object.fromEntries(ids.map((input) => [input, range])),
        },
        (r) => plotsValid(r, ids.length, 1001),
      );
    }
    for (let i = 0; i < 3; i++) {
      const startIndex = Math.floor(config.rows / 2) + i * 100;
      const a = startIndex / config.rate,
        b = (startIndex + 1000) / config.rate;
      await timed(
        `cursors-${i + 1}`,
        {
          type: 'measure-plot',
          items: ids.map((input) => ({ id: input, a, b })),
        },
        (r) => {
          check(
            r.measurements.length === ids.length,
            'Wrong measurement count',
          );
          for (const value of r.measurements)
            check(
              value.count === 1001 &&
                value.a[0] === a &&
                value.b[0] === b &&
                Number.isFinite(value.rms),
              'Cursor sample mismatch',
            );
        },
      );
    }
    const smoothed = await timed('smooth-create', {
      type: 'derive-many',
      parentIds: [id],
      operation: 'smooth',
      parameter: 101,
    });
    const smoothId = smoothed.project.nodes.at(-1).id;
    await timed('smooth-full', { type: 'view', ids: [smoothId] }, (r) =>
      plotsValid(r, 1, config.rows),
    );
    const scaled = await timed('scale-create', {
      type: 'derive-many',
      parentIds: [smoothId],
      operation: 'scale',
      parameter: 2,
    });
    const scaleId = scaled.project.nodes.at(-1).id;
    await timed('smooth-scale-full', { type: 'view', ids: [scaleId] }, (r) =>
      plotsValid(r, 1, config.rows),
    );
    await timed(
      'mean-all-channels',
      { type: 'calculate-values', inputIds: ids, operation: 'sample-average' },
      (r) => {
        const values = r.project.values.slice(-ids.length);
        check(values.length === ids.length, 'Missing scalar values');
        values.forEach((value, index) => {
          check(
            value.sampleCount === config.rows,
            'Scalar sample count mismatch',
          );
          check(
            Math.abs(value.value - first.plots[index].summary.mean) < 1e-9,
            'Scalar disagrees with full plot',
          );
        });
      },
    );
    await timed(
      'trigger-preview-one-channel',
      {
        type: 'segment-preview',
        sourceId: source.id,
        targetIds: [id],
        scope: 'signals',
        definition: {
          method: 'triggers',
          boundary: 'clip',
          minimumDuration: 0,
          start: { signalId: id, edge: 'rising', threshold: 0.5, offset: 0 },
          end: { signalId: id, edge: 'falling', threshold: 0.5, offset: 0 },
        },
      },
      (r) => check(r.plan.ranges.length > 0, 'No triggers found'),
      /over 10,000 signals|More than 1,000 segments/,
    );
    const cancelId = serial + 1;
    const cancelled = send({ type: 'view', ids, range: [0.123, 0.133] }).then(
      () => 'completed',
      (error) => {
        check(/cancelled/i.test(error.message), error.message);
        return 'cancelled';
      },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    const cancelStart = performance.now();
    worker.postMessage({ type: 'cancel', requestIds: [cancelId] });
    const outcome = await cancelled;
    timings.push({
      name: 'cancel-ack',
      ms: performance.now() - cancelStart,
      outcome,
    });
    await send({ type: 'view', ids: [id], range: [0, 0.01] });
    return {
      timings,
      plotPointCounts: first.plots.map((p) => p.points.length),
      sourceBytes: source.bytes,
      storage: await navigator.storage.estimate(),
    };
  } finally {
    worker.terminate();
  }
}

const timeout = setTimeout(
  () => {
    process.stderr.write('Benchmark exceeded 20 minutes.\n');
    app.exit(1);
  },
  20 * 60 * 1000,
);
async function main() {
  await app.whenReady();
  protocol.handle('stratus', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'benchmark')
      return new Response('Not found', { status: 404 });
    if (url.pathname === '/worker.js') {
      if (variant === 'baseline')
        return net.fetch(pathToFileURL(resolve(assets, workers[0])).toString());
      return new Response(workerSource, {
        headers: { 'Content-Type': 'text/javascript' },
      });
    }
    if (url.pathname === '/')
      return new Response(
        '<!doctype html><title>Signal benchmark</title><input type="file">',
        { headers: { 'Content-Type': 'text/html' } },
      );
    return new Response('Not found', { status: 404 });
  });
  for (const config of cases) {
    process.stdout.write(
      `Generating ${config.seconds}s x ${config.channels} channels\n`,
    );
    const path = fixture(config);
    for (let repeat = 1; repeat <= repeats; repeat++) {
      process.stdout.write(`CASE ${JSON.stringify({ ...config, repeat })}\n`);
      // Clear only this run's temporary profile between disk-backed cases.
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.on('console-message', ({ message }) => {
        if (message.startsWith('BENCH_STEP '))
          process.stdout.write(`${message}\n`);
      });
      window.webContents.on('render-process-gone', (_event, details) => {
        process.stderr.write(`Renderer failed: ${details.reason}\n`);
        app.exit(1);
      });
      await window.webContents.session.clearStorageData({
        storages: ['indexdb'],
      });
      await window.loadURL('stratus://benchmark/');
      window.webContents.debugger.attach('1.3');
      const { root: documentRoot } =
        await window.webContents.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await window.webContents.debugger.sendCommand(
        'DOM.querySelector',
        { nodeId: documentRoot.nodeId, selector: 'input' },
      );
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
        nodeId,
        files: [path],
      });
      window.webContents.debugger.detach();
      let peakWorkingSetMiB = 0;
      const sampleMemory = () => {
        peakWorkingSetMiB = Math.max(
          peakWorkingSetMiB,
          app
            .getAppMetrics()
            .reduce((sum, item) => sum + item.memory.workingSetSize / 1024, 0),
        );
      };
      sampleMemory();
      const memoryTimer = setInterval(sampleMemory, 100);
      let result;
      try {
        result = await window.webContents.executeJavaScript(
          `(${benchmark.toString()})(${JSON.stringify(config)})`,
        );
      } finally {
        clearInterval(memoryTimer);
      }
      report.runs.push({
        ...config,
        repeat,
        csvBytes: statSync(path).size,
        peakWorkingSetMiB,
        ...result,
      });
      writeFileSync(
        resolve(output, 'results.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      window.destroy();
    }
  }
  process.stdout.write(`Results: ${resolve(output, 'results.json')}\n`);
  clearTimeout(timeout);
  app.exit(0);
}
void main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  clearTimeout(timeout);
  app.exit(1);
});
