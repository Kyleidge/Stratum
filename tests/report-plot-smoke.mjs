import assert from 'node:assert/strict';
import { app, BrowserWindow, Menu } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
app.setPath('userData', mkdtempSync(resolve(tmpdir(), 'stratum-report-plot-')));
const timeout = setTimeout(() => {
  process.stderr.write('Saved plot report capture test timed out.\n');
  app.exit(1);
}, 90000);
let server;

async function fixture(moduleUrl, styles) {
  for (const url of styles) await import(url);
  const { captureReportPlot } = await import(moduleUrl);
  const expect = (value, message) => {
    if (!value) throw new Error(message);
  };
  const same = (actual, expected, message) =>
    expect(JSON.stringify(actual) === JSON.stringify(expected), message);
  const rejects = async (task, pattern) => {
    try {
      await task();
    } catch (error) {
      expect(
        pattern.test(error.message),
        'Unexpected rejection: ' + error.message,
      );
      return;
    }
    throw new Error('Expected capture to reject');
  };
  const source = (id, start, end, channels) => ({
    id,
    name: id + '.csv',
    start,
    end,
    channels,
    rows: 4,
    chunks: 1,
    bytes: 100,
    synthetic: false,
    chunkRanges: [[start, end]],
  });
  const node = (id, sourceId, unit) => ({
    id,
    sourceId,
    name: id + ' <signal>',
    unit,
    parents: [],
    operation: 'raw',
    parameters: {},
    channel: 0,
    color: '#dd3355',
    createdAt: '2026-01-01',
    version: 1,
  });
  const project = {
    sources: [
      source('A', 10, 20, ['a', 'hidden']),
      source('B', 100, 120, ['b']),
    ],
    nodes: [
      node('a', 'A', 'Nm'),
      node('b', 'B', 'V'),
      node('hidden', 'A', 'Nm'),
    ],
    segments: [],
    values: [
      {
        id: 'value',
        sourceId: 'A',
        inputId: 'a',
        batchId: 'batch',
        name: 'Average',
        unit: 'Nm',
        operation: 'time-average',
        value: 7,
        sampleCount: 4,
        validDuration: 6,
        start: 12,
        end: 18,
        createdAt: '2026-01-01',
      },
    ],
  };
  const sheet = {
    id: 'plot:fixture',
    name: 'Saved <comparison>',
    layout: 'overlay',
    grid: false,
    window: [0.25, 0.75],
    traces: [
      { id: 'a', visible: true, color: '#dd3355', style: 'step', width: 3 },
      { id: 'hidden', visible: false, color: '#ffffff' },
      { id: 'b', visible: true, color: '#3366dd', style: 'points', width: 2 },
    ],
    axes: {
      timeLabel: 'Test clock',
      values: {
        'unit:Nm': { y: [0, 10], label: 'Torque axis' },
        'unit:V': { y: [1, 100], log: true, label: 'Voltage axis' },
      },
    },
    annotations: [
      {
        id: 'a-note',
        time: 15,
        clockId: 'A',
        text: 'A <annotation>',
        labelPosition: 0.25,
      },
      {
        id: 'b-note',
        time: 110,
        clockId: 'B',
        text: 'B annotation',
        labelPosition: 0.7,
      },
    ],
  };
  const original = JSON.stringify({ project, sheet });
  const reads = [];
  const request = async (message) => {
    expect(
      message.type === 'view' && !('inspection' in message),
      'Capture must use independent view reads',
    );
    reads.push(structuredClone(message));
    return {
      type: 'plots',
      requestId: reads.length,
      plots: message.ids.map((id) => {
        const [start, end] = message.ranges[id];
        return {
          id,
          points: [
            [start, 1],
            [(start + end) / 2, 4],
            [end, 2],
          ],
          summary: {
            count: 3,
            min: 1,
            max: 4,
            mean: 2.5,
            integral: 2.5 * (end - start),
            start,
            end,
          },
        };
      }),
    };
  };
  const parse = (block) =>
    new DOMParser().parseFromString(block.plotSnapshot.svg, 'image/svg+xml');
  // Trace colours are styles (theme tokens), inlined as concrete colours.
  const tracePath = (svg) =>
    [...svg.querySelectorAll('path')].find(
      (path) => path.style.stroke === 'rgb(221, 51, 85)',
    );
  const multi = await captureReportPlot(project, sheet, request);
  expect(
    multi.length === 2,
    'Different clocks must produce independent panels',
  );
  same(reads[0].ids, ['a', 'b'], 'Hidden traces must not be evaluated');
  same(
    reads[0].ranges,
    { a: [12.5, 17.5], b: [105, 115] },
    'Saved viewport must use each clock extent',
  );
  const a = parse(multi[0]),
    b = parse(multi[1]);
  expect(
    a.querySelector('[data-range-start="12.5"][data-range-end="17.5"]'),
    'First panel must retain its viewport',
  );
  expect(
    a.querySelector(
      '[data-value-axis="unit:Nm"][data-axis-min="0"][data-axis-max="10"]',
    ),
    'Manual Y range must survive',
  );
  expect(
    b.querySelector('[data-value-axis="unit:V"][data-axis-log="true"]'),
    'Logarithmic Y range must survive',
  );
  expect(
    a.documentElement.textContent.includes('A <annotation>') &&
      !a.documentElement.textContent.includes('B annotation'),
    'Annotations must stay on their own clock',
  );
  expect(
    b.documentElement.textContent.includes('B annotation') &&
      !b.documentElement.textContent.includes('A <annotation>'),
    'Second clock annotation must survive',
  );
  expect(
    tracePath(a)?.getAttribute('stroke-width') === '3',
    'Custom trace color and weight must survive',
  );
  expect(!a.querySelector('.chart-grid'), 'Hidden grid must remain hidden');
  same(
    multi[0].source.outputIds,
    ['a'],
    'Panel provenance must name its exact outputs',
  );
  same(
    multi[0].source.sourceNames,
    ['A.csv'],
    'Panel provenance must name its source',
  );
  expect(
    a.documentElement.textContent.includes('Test clock'),
    'Custom time label must survive',
  );
  for (const block of multi) {
    const image = new Image();
    image.src =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(block.plotSnapshot.svg);
    await image.decode();
    expect(image.naturalWidth > 0, 'Snapshot must be independently renderable');
  }

  reads.length = 0;
  const elapsed = await captureReportPlot(
    project,
    {
      ...sheet,
      zeroTime: true,
      annotations: [
        { id: 'elapsed', clockId: 'elapsed', time: 8, text: 'Elapsed marker' },
      ],
    },
    request,
  );
  expect(
    elapsed.length === 1,
    'Explicit elapsed alignment must permit overlay',
  );
  same(
    reads[0].ranges,
    { a: [15, 25], b: [105, 115] },
    'Display window must translate through each zero-time offset',
  );
  expect(
    parse(elapsed[0]).querySelector(
      '[data-range-start="5"][data-range-end="15"]',
    ),
    'Overlay display axis must remain elapsed',
  );
  expect(
    parse(elapsed[0]).documentElement.textContent.includes('Elapsed marker'),
    'Elapsed annotations must survive',
  );
  // Overlays split different units into lanes on one time axis by default.
  const lanes = parse(elapsed[0]).documentElement;
  expect(
    lanes.querySelectorAll('svg').length === 2 &&
      lanes.querySelectorAll('[data-time-axis]').length === 1 &&
      lanes.querySelectorAll('svg [data-value-axis]').length === 2,
    'Mixed units must capture as lanes sharing the lowest lane time axis',
  );
  const independent = await captureReportPlot(
    project,
    { ...sheet, zeroTime: true, layout: 'axes', annotations: [] },
    request,
  );
  const axesChart = parse(independent[0]).documentElement;
  expect(
    independent.length === 1 &&
      axesChart.querySelectorAll('svg').length === 1 &&
      axesChart.querySelector('[data-value-axis="unit:Nm"]') &&
      axesChart.querySelector('[data-value-axis="unit:V"]'),
    'Independent Y axes must capture both units in one chart',
  );
  expect(
    /^#[0-9a-f]{6}$/i.test(independent[0].fill) &&
      parse(independent[0]).querySelector('rect')?.getAttribute('fill') ===
        independent[0].fill,
    'Snapshot frames must use the captured plot surface',
  );

  reads.length = 0;
  const held = await captureReportPlot(
    project,
    {
      ...sheet,
      traces: [sheet.traces[0]],
      layout: 'stacked',
      axes: {
        heldY: { ['trace:' + JSON.stringify(['a', 'unit:Nm'])]: [0, 100] },
      },
    },
    request,
  );
  expect(
    parse(held[0]).querySelector('[data-axis-min="0"][data-axis-max="100"]'),
    'Held stacked scale must use its stable trace ID',
  );
  expect(
    reads.length === 1,
    'Existing valid held scales need no extra overview read',
  );

  const overviewRequest = async (message) => {
    const result = await request(message);
    for (const plot of result.plots) {
      const extent = project.sources.find(
        (item) =>
          item.id ===
          project.nodes.find((item) => item.id === plot.id)?.sourceId,
      );
      if (
        extent &&
        message.ranges[plot.id][0] === extent.start &&
        message.ranges[plot.id][1] === extent.end
      ) {
        plot.summary.max = 1000;
        plot.points[1][1] = 1000;
      }
    }
    return result;
  };
  const missingHeldSheet = {
    ...sheet,
    traces: [sheet.traces[0]],
    layout: 'stacked',
    axes: { heldY: {} },
  };
  reads.length = 0;
  const missingHeld = await captureReportPlot(
    project,
    missingHeldSheet,
    overviewRequest,
  );
  same(
    reads.map((read) => read.ranges),
    [{ a: [12.5, 17.5] }, { a: [10, 20] }],
    'A new held trace must read viewport and full-signal overview separately',
  );
  const missingAxis = parse(missingHeld[0]).querySelector(
    '[data-value-axis="unit:Nm"]',
  );
  const fallbackRange = [
    Number(missingAxis.getAttribute('data-axis-min')),
    Number(missingAxis.getAttribute('data-axis-max')),
  ];
  expect(
    fallbackRange[1] > 1000,
    'A new held trace must retain the full-signal scale outside the viewport',
  );
  const explicitFallback = await captureReportPlot(
    project,
    { ...missingHeldSheet, axes: { y: fallbackRange } },
    overviewRequest,
  );
  same(
    tracePath(parse(missingHeld[0])).getAttribute('d'),
    tracePath(parse(explicitFallback[0])).getAttribute('d'),
    'Overview statistics must never replace the windowed drawing points',
  );

  reads.length = 0;
  const newAxis = await captureReportPlot(
    project,
    {
      ...sheet,
      traces: [{ ...sheet.traces[0], axisId: 'axis:extra' }],
      axes: {
        heldY: { 'unit:Nm': [0, 10] },
        values: { 'axis:extra': { unit: 'Nm' } },
      },
    },
    overviewRequest,
  );
  expect(
    Number(
      parse(newAxis[0])
        .querySelector('[data-value-axis="axis:extra"]')
        .getAttribute('data-axis-max'),
    ) > 1000,
    'A newly assigned overlay axis must retain the full-signal scale while Hold Y is enabled',
  );
  expect(
    reads.length === 2,
    'Only the missing held axis requires an overview read',
  );
  const invalidLog = await captureReportPlot(
    project,
    {
      ...sheet,
      traces: [sheet.traces[0]],
      axes: {
        heldY: { 'unit:Nm': [0, 10] },
        values: { 'unit:Nm': { log: true } },
      },
    },
    overviewRequest,
  );
  expect(
    parse(invalidLog[0]).querySelector(
      '[data-axis-log="true"][data-axis-max="1100"]',
    ),
    'A held range invalidated by log scaling must fall back to full positive overview data',
  );

  reads.length = 0;
  const duringOverview = new AbortController();
  await rejects(
    () =>
      captureReportPlot(
        project,
        missingHeldSheet,
        async (message) => {
          const result = await overviewRequest(message);
          if (reads.length === 2) duringOverview.abort();
          return result;
        },
        duringOverview.signal,
      ),
    /cancelled/,
  );
  expect(
    reads.length === 2,
    'Cancellation after an overview read must stop before rendering',
  );
  reads.length = 0;
  const scalar = await captureReportPlot(
    project,
    { ...sheet, traces: [{ id: 'value', visible: true, color: '#aaaaaa' }] },
    request,
  );
  expect(
    reads.length === 0 && scalar.length === 1,
    'Scalar reference lines must not request signal data',
  );
  same(
    scalar[0].source.outputIds,
    ['value'],
    'Scalar provenance must retain the scalar output ID',
  );
  const labelled = await captureReportPlot(
    project,
    {
      ...sheet,
      traces: [
        sheet.traces[0],
        { id: 'value', visible: true, color: '#aaaaaa' },
      ],
    },
    request,
  );
  expect(
    labelled.length === 1 &&
      parse(labelled[0]).querySelector('.chart-reference-label')
        ?.textContent === 'avg 7.0',
    'Values must keep their direct reference-line label',
  );
  reads.length = 0;

  const cancelled = new AbortController();
  cancelled.abort();
  await rejects(
    () => captureReportPlot(project, sheet, request, cancelled.signal),
    /cancelled/,
  );
  expect(reads.length === 0, 'Already cancelled capture must not read');
  const during = new AbortController();
  await rejects(
    () =>
      captureReportPlot(
        project,
        sheet,
        async (message) => {
          const result = await request(message);
          during.abort();
          return result;
        },
        during.signal,
      ),
    /cancelled/,
  );
  await rejects(
    () =>
      captureReportPlot(
        project,
        { ...sheet, traces: Array.from({ length: 31 }, () => sheet.traces[0]) },
        request,
      ),
    /up to 30/,
  );
  await rejects(
    () =>
      captureReportPlot(
        project,
        {
          ...sheet,
          traces: [{ id: 'missing', visible: true, color: '#ffffff' }],
        },
        request,
      ),
    /no longer exists/,
  );
  await rejects(
    () =>
      captureReportPlot(project, sheet, async () => ({
        type: 'plots',
        plots: [],
        requestId: 1,
      })),
    /could not be evaluated/,
  );
  expect(
    JSON.stringify({ project, sheet }) === original,
    'Capture must not mutate saved settings or project metadata',
  );
  expect(
    !document.querySelector('.plot-scratchpad'),
    'Temporary capture DOM must always be removed',
  );
  expect(
    (await indexedDB.databases()).length === 0,
    'Capture must not open workspace storage',
  );
  return {
    panels: multi.length,
    zeroTimePanels: elapsed.length,
    independentSvg: true,
  };
}

void app
  .whenReady()
  .then(async () => {
    // Like the app, use no menu bar; the default one also crashes Chromium's
    // headless Ozone platform.
    Menu.setApplicationMenu(null);
    server = await createServer({
      configFile: resolve(root, 'desktop/vite.config.ts'),
      plugins: [
        {
          name: 'report-plot-fixture',
          configureServer(vite) {
            vite.middlewares.use(
              '/report-plot-fixture.html',
              (_request, response, next) => {
                void vite
                  .transformIndexHtml(
                    '/report-plot-fixture.html',
                    '<!doctype html><html><head><title>Report plot fixture</title></head><body></body></html>',
                  )
                  .then((html) => {
                    response.setHeader('Content-Type', 'text/html');
                    response.end(html);
                  })
                  .catch(next);
              },
            );
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0, open: false },
      logLevel: 'error',
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    const moduleUrl =
      origin +
      '/@fs/' +
      resolve(root, 'lib/report-plot.tsx').replaceAll('\\', '/');
    const styles = ['globals.css', 'workflow.css'].map(
      (file) =>
        origin + '/@fs/' + resolve(root, 'app', file).replaceAll('\\', '/'),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await window.loadURL(origin + '/report-plot-fixture.html');
    const results = await window.webContents.executeJavaScript(
      `(${fixture.toString()})(${JSON.stringify(moduleUrl)}, ${JSON.stringify(styles)})`,
    );
    assert.deepEqual(results, {
      panels: 2,
      zeroTimePanels: 1,
      independentSvg: true,
    });
    window.destroy();
    await server.close();
    clearTimeout(timeout);
    process.stdout.write(
      'Saved report plots passed: independent clocks, viewport offsets, hidden traces, unit lanes, independent Y axes, manual/log/held axes, styles, annotations, value labels, SVG decoding, scalar provenance, cancellation, bounds, and no workspace mutation.\n',
    );
    app.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    await server?.close();
    clearTimeout(timeout);
    app.exit(1);
  });
