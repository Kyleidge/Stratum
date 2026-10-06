// Plot interaction benchmark: real (trusted) Chromium input against the
// production desktop renderer, served over HTTP with isolated storage.
//
//   pnpm desktop:build
//   node tests/plot-interaction-benchmark.mjs
//
// Playwright is not a project dependency. Install it outside the checkout and
// point PLAYWRIGHT at its module, e.g. PLAYWRIGHT=/path/node_modules/playwright/index.mjs.
// BENCH_SECONDS (default 900) sets the 100 kHz one-channel fixture length.
// BENCH_LABEL names the result file. BENCH_PROFILE reuses a browser profile and
// skips the import when it already holds the recording (same BENCH_PORT).
// BENCH_RAW=0 skips the recording's own scenarios; BENCH_DERIVED adds derived
// signals (see below). BENCH_DIST serves another renderer build.
// Results: outputs/plot-interaction-benchmark/<label>.json. See
// docs/plot-interaction.md for the metrics.
import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'outputs/plot-interaction-benchmark');
mkdirSync(output, { recursive: true });
const seconds = Number(process.env.BENCH_SECONDS ?? 900);
const label = process.env.BENCH_LABEL ?? `${seconds}s`;
const port = Number(process.env.BENCH_PORT ?? 4173);
const profile =
  process.env.BENCH_PROFILE ?? mkdtempSync(join(tmpdir(), 'stratum-plot-'));
const reuse = existsSync(join(profile, 'Default'));

// Deterministic 100 kHz CSV on disk: a 50 Hz carrier with slow amplitude
// modulation, noise and rare spikes so min/max envelopes have structure.
const csv = join(output, `${seconds}s-100kHz.csv`);
if (!existsSync(csv)) {
  const rate = 100000,
    rows = seconds * rate,
    fd = openSync(csv, 'w');
  let seed = 1;
  const noise = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  writeSync(fd, 'time,Vibration [g]\n');
  for (let start = 0; start < rows; start += 65536) {
    let text = '';
    for (let i = start; i < Math.min(rows, start + 65536); i++) {
      const t = i / rate;
      let v =
        (1 + 0.5 * Math.sin(2 * Math.PI * 0.05 * t)) *
          Math.sin(2 * Math.PI * 50 * t) +
        0.2 * noise();
      if (i % 1234567 === 0) v += 5;
      text += `${t.toFixed(5)},${v.toFixed(5)}\n`;
    }
    writeSync(fd, text);
  }
  closeSync(fd);
}

const dist = process.env.BENCH_DIST ?? join(root, 'dist-desktop');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const server = createServer((request, response) => {
  const path =
    normalize(
      decodeURIComponent(new URL(request.url, 'http://local').pathname),
    ).replace(/^[/\\]+/, '') || 'index.html';
  try {
    const body = readFileSync(join(dist, path));
    response.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(port);
const url = `http://localhost:${port}/`;
const results = {
  label,
  seconds,
  date: new Date().toISOString(),
  scenarios: {},
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: ['--disable-background-timer-throttling'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => log('page error', e.message));
page.on('console', (m) => m.type() === 'error' && log('console', m.text()));
await page.addInitScript(() => {
  const b = (window.__bench = {
    reqs: [],
    open: new Map(),
    frames: [],
    long: [],
    rec: false,
  });
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        const r = data && b.open.get(data.requestId);
        if (r && data.type !== 'progress') {
          r.end = performance.now();
          r.response = data.type;
          b.open.delete(data.requestId);
        }
      });
    }
    postMessage(message, ...rest) {
      if (message?.requestId) {
        const r = {
          id: message.requestId,
          type: message.type,
          start: performance.now(),
        };
        if (message.ranges)
          r.span = Object.values(message.ranges).map((x) => x[1] - x[0]);
        b.reqs.push(r);
        b.open.set(message.requestId, r);
      }
      return super.postMessage(message, ...rest);
    }
  };
  // Every third frame, count drawn line vertices inside the plot area: a
  // coarse placeholder (overview data while zoomed in) has few vertices.
  let n = 0;
  b.detail = [];
  const frame = (t) => {
    if (b.rec) {
      b.frames.push(t);
      if (++n % 3 === 0) {
        const svg = document.querySelector(
          '.scratchpad-canvas .signal-chart svg[role=application]',
        );
        const path =
          svg?.querySelector('g[clip-path] path') ??
          svg?.querySelector('path[d^="M"]');
        if (svg && path) {
          const left = +svg.dataset.plotLeft,
            right = +svg.dataset.plotRight;
          let count = 0;
          for (const m of path.getAttribute('d').matchAll(/[ML](-?[\d.]+),/g)) {
            const x = +m[1];
            if (x >= left && x <= right) count++;
          }
          b.detail.push(count);
        }
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (b.rec) b.long.push(e.duration);
  }).observe({ type: 'longtask', buffered: false });
});

const t0 = Date.now();
await page.goto(url);
const chart = '.scratchpad-canvas .signal-chart svg[role=application]';
if (!reuse) {
  await page.waitForSelector("input[type=file][accept='.csv,text/csv']", {
    state: 'attached',
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  const start = Date.now();
  await page.setInputFiles("input[type=file][accept='.csv,text/csv']", csv);
  await page.waitForFunction(
    () => /created 1 signals?\b/.test(document.body.innerText),
    null,
    { timeout: 30 * 60000, polling: 500 },
  );
  results.importMs = Date.now() - start;
  log('import', results.importMs, 'ms');
  await page.waitForSelector(chart, { timeout: 10 * 60000 });
  await settle();
  results.firstPlotAfterImportMs = Date.now() - start - results.importMs;
  // Reload: the cold "open workspace and draw" path the user sees each launch.
  await page.reload();
}
{
  const r0 = Date.now();
  await page.waitForSelector(chart, { timeout: 10 * 60000 });
  await page.waitForFunction(
    (sel) => {
      const p = document.querySelector(sel)?.querySelector('path[d^="M"]');
      return p && p.getAttribute('d').length > 1000;
    },
    chart,
    { timeout: 10 * 60000, polling: 50 },
  );
  await settle();
  results.coldOpenToPlotMs = Date.now() - r0;
  log('cold open → full plot', results.coldOpenToPlotMs, 'ms');
}

async function settle(quiet = 450, limit = 120000) {
  const start = Date.now();
  let since = Date.now();
  while (Date.now() - start < limit) {
    const busy = await page.evaluate(() => {
      const now = performance.now();
      return (
        [...window.__bench.open.values()].some((r) => r.type === 'view') ||
        window.__bench.reqs.some(
          (r) => r.type === 'view' && now - (r.end ?? now) < 50,
        )
      );
    });
    if (busy) since = Date.now();
    else if (Date.now() - since >= quiet) return Date.now() - start - quiet;
    await page.waitForTimeout(25);
  }
  throw new Error('plot never settled');
}
async function box() {
  const b = await page.locator(chart).boundingBox();
  const d = await page.locator(chart).evaluate((svg) => ({
    left: +svg.dataset.plotLeft,
    right: +svg.dataset.plotRight,
    w: svg.viewBox.baseVal.width,
  }));
  const xAt = (f) => b.x + ((d.left + (d.right - d.left) * f) * b.width) / d.w;
  return { xAt, y: b.y + b.height * 0.45 };
}
async function windowSpan() {
  return page
    .locator(chart)
    .evaluate((svg) => +svg.dataset.rangeEnd - +svg.dataset.rangeStart);
}
async function record(fn) {
  await page.evaluate(() => {
    const b = window.__bench;
    b.frames = [];
    b.detail = [];
    b.long = [];
    b.mark = performance.now();
    b.rec = true;
  });
  const startWall = Date.now();
  await fn();
  const inputEnd = await page.evaluate(() => performance.now());
  const settleMs = await settle();
  const data = await page.evaluate(
    ({ inputEnd }) => {
      const b = window.__bench;
      b.rec = false;
      const frames = b.frames.filter((t) => t <= inputEnd);
      const gaps = frames.slice(1).map((t, i) => t - frames[i]);
      const views = b.reqs.filter(
        (r) => r.type === 'view' && r.start >= b.mark && r.end,
      );
      return {
        gaps,
        long: b.long,
        detail: b.detail,
        views: views.map((r) => r.end - r.start),
      };
    },
    { inputEnd },
  );
  const q = (arr, p) => {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const r = (x) => Math.round(x * 10) / 10;
  return {
    inputMs: Date.now() - startWall - settleMs,
    frames: data.gaps.length,
    frameP50: r(q(data.gaps, 0.5)),
    frameP95: r(q(data.gaps, 0.95)),
    frameMax: r(Math.max(0, ...data.gaps)),
    slowFrames: data.gaps.filter((g) => g > 34).length,
    longTasks: data.long.length,
    longTaskTotal: r(data.long.reduce((a, b) => a + b, 0)),
    viewRequests: data.views.length,
    viewP50: r(q(data.views, 0.5)),
    viewMax: r(Math.max(0, ...data.views)),
    settleAfterInputMs: settleMs,
    // Full detail draws ~1,400+ on-screen vertices and the panning buffer
    // ~700+; fewer than 400 means coarse placeholder data is on screen.
    coarseFrames: r(
      data.detail.filter((c) => c < 400).length / (data.detail.length || 1),
    ),
    verticesP50: q(data.detail, 0.5),
    minVertices: Math.min(...data.detail),
    vertices: data.detail,
  };
}
async function focusChart() {
  await page.locator(chart).focus();
}
async function fit() {
  await focusChart();
  await page.keyboard.press('Home');
  await settle();
}
async function zoomTo(target) {
  await fit();
  await focusChart();
  while ((await windowSpan()) > target * 1.05) {
    await page.keyboard.press('Equal');
    await settle();
  }
}
async function wheelBurst(deltaY, count = 12) {
  await focusChart();
  const { xAt, y } = await box();
  await page.mouse.move(xAt(0.5), y);
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(40);
  }
}
async function drag(from, to, steps = 60, interval = 16) {
  const { xAt, y } = await box();
  await page.mouse.move(xAt(from), y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(xAt(from + ((to - from) * i) / steps), y);
    await page.waitForTimeout(interval);
  }
  await page.mouse.up();
}
async function hover(steps = 90) {
  const { xAt, y } = await box();
  for (let i = 0; i <= steps; i++) {
    await page.mouse.move(xAt(0.1 + (0.8 * i) / steps), y);
    await page.waitForTimeout(16);
  }
}
async function scenario(name, fn) {
  try {
    results.scenarios[name] = await record(fn);
    log(
      name,
      JSON.stringify({ ...results.scenarios[name], vertices: undefined }),
    );
  } catch (error) {
    results.scenarios[name] = { error: String(error) };
    log(name, 'FAILED', error.message);
  }
}

async function suite(prefix = '') {
  // Full-recording view.
  await fit();
  await scenario(`${prefix}hover-full`, () => hover());
  await scenario(`${prefix}wheel-in-full`, () => wheelBurst(-100));
  await scenario(`${prefix}wheel-out-to-full`, () => wheelBurst(100, 16));
  for (const [name, span] of [
    ['60s', 60],
    ['1s', 1],
    ['10ms', 0.01],
  ]) {
    await zoomTo(span);
    log(`window ${name}:`, await windowSpan(), 's');
    await scenario(`${prefix}drag-${name}`, () => drag(0.75, 0.25));
    await scenario(`${prefix}drag-long-${name}`, async () => {
      for (let i = 0; i < 3; i++) await drag(0.85, 0.15, 45);
    });
    await scenario(`${prefix}wheel-in-${name}`, () => wheelBurst(-100, 6));
    await scenario(`${prefix}wheel-out-${name}`, () => wheelBurst(100, 10));
    await scenario(`${prefix}keys-pan-${name}`, async () => {
      await focusChart();
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(60);
      }
    });
  }
  await fit();
  await scenario(`${prefix}drag-full`, () => drag(0.75, 0.25));
}
if (process.env.BENCH_RAW !== '0') await suite();

// BENCH_DERIVED=smooth:101,low-pass:50 derives each from the recording through
// the Derive dialog, times its first overview, then repeats the suite on it.
const FILTERS = {
  smooth: 'Moving average',
  median: 'Median filter',
  exponential: 'Exponential smoothing',
  'low-pass': 'Low-pass RC filter',
  'high-pass': 'High-pass RC filter',
};
for (const spec of (process.env.BENCH_DERIVED ?? '')
  .split(',')
  .filter(Boolean)) {
  const [kind, value] = spec.split(':');
  await page
    .locator('[role=treeitem][aria-label*="Original signal"]')
    .first()
    .click();
  await settle();
  await page.click("role=button[name='Derive signal']");
  await page
    .locator('[role=dialog] [role=tabpanel]')
    .getByText(FILTERS[kind], { exact: true })
    .first()
    .click();
  const field = page
    .locator(
      '[role=dialog] input:not([type=range]):not([type=radio]):not([type=checkbox])',
    )
    .first();
  await field.fill(value);
  await page.waitForTimeout(300);
  const before = await page.locator(chart).getAttribute('aria-label');
  const start = Date.now();
  await page.click('role=button[name=/^Create 1 derived signal/]');
  await page.waitForFunction(
    ({ selector, before }) =>
      document.querySelector(selector)?.getAttribute('aria-label') !== before,
    { selector: chart, before },
    { timeout: 30 * 60000, polling: 50 },
  );
  await page.waitForFunction(
    (selector) =>
      (document
        .querySelector(selector)
        ?.querySelector('g[clip-path] path')
        ?.getAttribute('d')?.length ?? 0) > 1000,
    chart,
    { timeout: 30 * 60000, polling: 50 },
  );
  await settle(450, 30 * 60000);
  results[`${spec} createToPlotMs`] = Date.now() - start;
  log(spec, 'create → overview drawn', results[`${spec} createToPlotMs`], 'ms');
  await suite(`${spec} `);
}

results.totalMs = Date.now() - t0;
writeFileSync(join(output, `${label}.json`), JSON.stringify(results, null, 2));
log('profile', profile);
await ctx.close();
server.close();
