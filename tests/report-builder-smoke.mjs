import assert from 'node:assert/strict';
import { app, BrowserWindow, net, protocol } from 'electron';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../dist-desktop/', import.meta.url));
const output = fileURLToPath(new URL('../outputs/', import.meta.url));
app.setPath(
  'userData',
  mkdtempSync(resolve(tmpdir(), 'stratum-report-smoke-')),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stratum-report',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const timeout = setTimeout(() => {
  process.stderr.write('Report builder smoke test timed out.\n');
  app.exit(1);
}, 120000);
const pause = (ms = 80) => new Promise((done) => setTimeout(done, ms));

void app
  .whenReady()
  .then(async () => {
    mkdirSync(output, { recursive: true });
    protocol.handle('stratum-report', async (request) => {
      const url = new URL(request.url);
      const target = resolve(root, '.' + decodeURIComponent(url.pathname));
      const rel = relative(root, target);
      if (
        url.host !== 'app' ||
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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
      );
      return new Response(response.body, { status: response.status, headers });
    });
    const window = new BrowserWindow({
      width: 1540,
      height: 1040,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const externalRequests = [];
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        externalRequests.push(details.url);
        callback({ cancel: true });
      },
    );
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    let completeDownload;
    let completeSample;
    let exportCount = 0;
    const sampleDownloaded = new Promise((done) => {
      completeSample = done;
    });
    const downloaded = new Promise((done) => {
      completeDownload = done;
    });
    window.webContents.session.on('will-download', (_event, item) => {
      assert.ok(
        item.getFilename().endsWith('.pdf'),
        'Export must create a PDF download',
      );
      const sample = exportCount++ > 0;
      item.setSavePath(
        resolve(
          output,
          sample ? 'report-builder-example.pdf' : 'report-builder.pdf',
        ),
      );
      item.once('done', (_doneEvent, state) =>
        (sample ? completeSample : completeDownload)(state),
      );
    });
    const evaluate = (fn, ...args) =>
      window.webContents.executeJavaScript(
        `(${fn.toString()})(...${JSON.stringify(args)})`,
      );
    const waitFor = async (fn, message) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await evaluate(fn)) return;
        await pause(50);
      }
      throw new Error(
        message +
          ' :: ' +
          (await evaluate(() => ({
            toast: document.querySelector('.rb-toast')?.textContent,
            blocks: document.querySelectorAll('.rb-block').length,
            images: [...document.querySelectorAll('.rb-block image')].map(
              (image) => image.getAttribute('href')?.slice(0, 70),
            ),
          })).then(JSON.stringify)),
      );
    };
    const click = async (label, scope = '') => {
      await evaluate(
        (label, scope) => {
          const button = [...document.querySelectorAll(scope + ' button')].find(
            (item) =>
              item.getAttribute('aria-label') === label ||
              item.textContent.trim() === label,
          );
          if (!button || button.disabled)
            throw new Error('Missing available button: ' + label);
          button.click();
        },
        label,
        scope,
      );
      await pause();
    };
    const setField = async (label, value) => {
      await evaluate(
        (label, value) => {
          const field = [
            ...document.querySelectorAll('input, textarea, select'),
          ].find(
            (item) =>
              item.getAttribute('aria-label') === label ||
              item.closest('label')?.querySelector('span')?.textContent ===
                label,
          );
          if (!field) throw new Error('Missing field: ' + label);
          const prototype =
            field instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : field instanceof HTMLSelectElement
                ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
            field,
            String(value),
          );
          field.dispatchEvent(
            new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
              bubbles: true,
            }),
          );
        },
        label,
        value,
      );
      await pause();
    };
    const blockCount = () =>
      evaluate(() => document.querySelectorAll('.rb-paper .rb-block').length);
    const key = async (keyCode, modifiers = []) => {
      window.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode,
        modifiers,
      });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await pause();
    };
    const pointerDrag = async (selector, dx, dy) => {
      const point = await evaluate((selector) => {
        const element = document.querySelector(selector);
        element.scrollIntoView({ block: 'nearest' });
        const box = element.getBoundingClientRect();
        const paper = document.querySelector('.rb-paper');
        return {
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2),
          scale:
            paper.getBoundingClientRect().width / parseFloat(paper.style.width),
        };
      }, selector);
      window.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        x: point.x,
        y: point.y,
      });
      await pause();
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(point.x + dx * point.scale),
        y: Math.round(point.y + dy * point.scale),
      });
      await pause();
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        x: Math.round(point.x + dx * point.scale),
        y: Math.round(point.y + dy * point.scale),
      });
      await pause();
      assert.ok(
        await evaluate(() => !document.querySelector('.rb-paper.is-arranging')),
        'Pointer release must finish the ' + selector + ' gesture',
      );
    };

    await window.loadURL('stratum-report://app/index.html?report-mockup=1');
    await waitFor(
      () => !!document.querySelector('.rb-app'),
      'Report mockup did not load',
    );
    await click('New blank report');
    assert.equal(await blockCount(), 0);
    await click('Text', '.rb-quick-insert');
    await setField('Text content', 'Résumé α — report smoke test');
    await setField('Font size', 22);
    await click('Bold');
    assert.ok(
      await evaluate(() =>
        [...document.querySelectorAll('.rb-block text')].some(
          (text) =>
            text.getAttribute('font-weight') === '700' &&
            text.textContent.includes('Résumé'),
        ),
      ),
      'Text formatting must reach canvas SVG',
    );
    // Focus the textarea first: a subsequent pointer selection must move keyboard focus.
    await evaluate(() =>
      document.querySelector('[aria-label="Text content"]').focus(),
    );
    const original = await evaluate(() => {
      const block = document.querySelector('.rb-block');
      return {
        x: parseFloat(block.style.left),
        y: parseFloat(block.style.top),
        width: parseFloat(block.style.width),
        height: parseFloat(block.style.height),
      };
    });
    await pointerDrag('.rb-block', 80, 48);
    assert.ok(
      await evaluate((original) => {
        const block = document.querySelector('.rb-block');
        return (
          parseFloat(block.style.left) >= original.x + 72 &&
          parseFloat(block.style.top) >= original.y + 40 &&
          document.activeElement === block
        );
      }, original),
      'Native pointer movement must move and focus the block',
    );
    await pointerDrag('.rb-resize-handle', 64, 40);
    assert.ok(
      await evaluate((original) => {
        const block = document.querySelector('.rb-block');
        return (
          parseFloat(block.style.width) >= original.width + 56 &&
          parseFloat(block.style.height) >= original.height + 32
        );
      }, original),
      'Native resize must change dimensions at the canvas scale',
    );
    await click('Undo (Ctrl+Z)');
    assert.equal(
      await evaluate(() =>
        parseFloat(document.querySelector('.rb-block').style.width),
      ),
      original.width,
      'One undo must revert the complete resize',
    );
    await click('Undo (Ctrl+Z)');
    assert.equal(
      await evaluate(() =>
        parseFloat(document.querySelector('.rb-block').style.left),
      ),
      original.x,
      'One more undo must revert the complete move',
    );

    // Exercise the real React drag/drop handlers with an HTML DataTransfer payload.
    await evaluate(() => {
      const paper = document.querySelector('.rb-paper');
      const box = paper.getBoundingClientRect();
      const scale = box.width / parseFloat(paper.style.width);
      const transfer = new DataTransfer();
      const asset = document.querySelector('.rb-plot-asset');
      asset.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }),
      );
      paper.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      paper.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: box.left + 80 * scale,
          clientY: box.top + 280 * scale,
        }),
      );
    });
    await waitFor(
      () => document.querySelectorAll('.rb-block').length === 2,
      'Plot drag/drop did not insert a block',
    );
    assert.equal(
      await evaluate(
        () =>
          document.querySelector('.rb-block[data-block-type="plot"]').style.top,
      ),
      '280px',
    );
    await click('Image', '.rb-quick-insert');
    await setField('X position', 48);
    await setField('Y position', 610);
    await evaluate(async () => {
      const decode = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        'decode',
      ).value;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        await new Promise((done) => setTimeout(done, 250));
        HTMLImageElement.prototype.decode = decode;
      };
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 40;
      const context = canvas.getContext('2d');
      context.fillStyle = '#287eaa';
      context.fillRect(0, 0, 80, 40);
      const blob = await new Promise((done) =>
        canvas.toBlob(done, 'image/png'),
      );
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([blob], 'local-smoke.png', { type: 'image/png' }),
      );
      const input = document.querySelector(
        '[aria-label="Upload report image"]',
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await setField('Report name', 'Edited during image upload');
    await waitFor(
      () =>
        [...document.querySelectorAll('.rb-block image')].some((image) =>
          image.getAttribute('href')?.startsWith('data:image/png'),
        ),
      'Local image upload did not appear',
    );
    await setField('Width', 160);
    await setField('Height', 100);
    await setField('X position', 410);
    await setField('Y position', 610);
    assert.equal(
      await evaluate(
        () => document.querySelector('[aria-label="Report name"]').value,
      ),
      'Edited during image upload',
      'An asynchronous upload must preserve newer edits',
    );
    // Upload adds a separate image unless explicitly replacing the selected block.
    assert.equal(await blockCount(), 4);
    await click('Table', '.rb-quick-insert');
    await setField('X position', 48);
    await setField('Y position', 850);
    await setField('Row 2, column 2', '123.45');
    assert.ok(
      await evaluate(() =>
        document
          .querySelector('.rb-block[data-block-type="table"]')
          .textContent.includes('123.45'),
      ),
    );
    await evaluate(() =>
      document.querySelector('.rb-block[data-block-type="table"]').focus(),
    );
    await key('Delete');
    assert.equal(await blockCount(), 4);
    await key('z', ['control']);
    assert.equal(
      await blockCount(),
      5,
      'Keyboard undo must restore the deleted table',
    );
    await click('Add page', '.rb-workspace');
    assert.equal(await blockCount(), 0);
    await click('Text', '.rb-quick-insert');
    await setField('Text content', 'SECOND PAGE — independent content');
    await click('Deselect block');
    await click('Delete this page');
    assert.equal(
      await evaluate(
        () => document.querySelectorAll('.rb-page-thumbnail').length,
      ),
      1,
    );
    await click('Undo (Ctrl+Z)');
    assert.equal(
      await evaluate(
        () => document.querySelectorAll('.rb-page-thumbnail').length,
      ),
      2,
      'Undo must restore the second page',
    );
    await click('Preview');
    assert.equal(
      await evaluate(
        () => document.querySelectorAll('.rb-preview-sheet').length,
      ),
      2,
    );
    assert.ok(
      await evaluate(() =>
        document
          .querySelectorAll('.rb-preview-sheet')[1]
          .textContent.includes('SECOND PAGE'),
      ),
    );
    await click('Export PDF');
    assert.equal(await downloaded, 'completed');
    const pdf = readFileSync(resolve(output, 'report-builder.pdf'));
    const binary = pdf.toString('latin1');
    assert.ok(binary.startsWith('%PDF-1.4'));
    assert.equal([...binary.matchAll(/\/Type \/Page\b/g)].length, 2);
    assert.equal([...binary.matchAll(/\/Filter \/DCTDecode/g)].length, 2);
    assert.ok(
      pdf.includes(Buffer.from([255, 216, 255])),
      'PDF must contain actual JPEG image data',
    );
    assert.match(binary, /\/MediaBox \[0 0 595\.5 842\.25\]/);
    assert.ok(pdf.byteLength > 20000, 'PDF must contain rendered report pages');
    const xref = Number(binary.match(/startxref\n(\d+)\n/)[1]);
    assert.equal(
      binary.slice(xref, xref + 4),
      'xref',
      'PDF xref must use byte offsets',
    );

    await click('Back to editor');
    await evaluate(() =>
      [...document.querySelectorAll('.rb-tabs button')]
        .find((button) => button.textContent.trim() === 'Insert')
        .click(),
    );
    await pause();
    await click('Load sample report ↗');
    while (
      await evaluate(
        () => parseInt(document.querySelector('.rb-zoom').textContent, 10) > 65,
      )
    )
      await click('Zoom out');
    if (await evaluate(() => !!document.querySelector('.rb-toast')))
      await click('Dismiss notification');
    const samplePlotPoint = await evaluate(() => {
      const plot = document.querySelector('.rb-block[data-block-type="plot"]');
      const box = plot.getBoundingClientRect();
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
      };
    });
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      ...samplePlotPoint,
    });
    await pause();
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...samplePlotPoint,
    });
    await pause();
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...samplePlotPoint,
    });
    await waitFor(
      () =>
        !!document.querySelector(
          '.rb-block[data-block-type="plot"].is-selected',
        ),
      'Sample plot must be selected for the review screenshot',
    );
    await pause(300);
    await window.webContents.capturePage(undefined, { stayHidden: true });
    await pause(200);
    writeFileSync(
      resolve(output, 'report-builder-mockup.png'),
      (
        await window.webContents.capturePage(undefined, { stayHidden: true })
      ).toPNG(),
    );
    await click('Export PDF');
    assert.equal(await sampleDownloaded, 'completed');
    assert.ok(
      readFileSync(resolve(output, 'report-builder-example.pdf')).byteLength >
        20000,
    );
    assert.deepEqual(
      externalRequests,
      [],
      'Report editing/export must stay local',
    );
    assert.deepEqual(
      await evaluate(async () =>
        (await indexedDB.databases()).map((database) => database.name),
      ),
      [],
      'Report mockup must not open workspace storage',
    );
    process.stdout.write(
      'Report mockup passed: native move/resize + undo, drag/drop, local upload, text/table formatting, keyboard deletion, pages + preview, two-page PDF download, and isolated local storage.\n',
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
