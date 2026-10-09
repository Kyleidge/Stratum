import assert from 'node:assert/strict';
import { app, BrowserWindow, Menu, net, protocol } from 'electron';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../dist-desktop/', import.meta.url));
const output = fileURLToPath(new URL('../outputs/', import.meta.url));
app.setPath('userData', mkdtempSync(resolve(tmpdir(), 'stratum-report-data-')));
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stratum-report-data',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const timeout = setTimeout(() => {
  process.stderr.write('Integrated report workspace smoke test timed out.\n');
  app.exit(1);
}, 120000);
const pause = (ms = 70) => new Promise((done) => setTimeout(done, ms));

void app
  .whenReady()
  .then(async () => {
    // Like the app, use no menu bar; the default one also crashes Chromium's
    // headless Ozone platform.
    Menu.setApplicationMenu(null);
    mkdirSync(output, { recursive: true });
    protocol.handle('stratum-report-data', async (request) => {
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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
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
    let finishDownload;
    const downloaded = new Promise((done) => {
      finishDownload = done;
    });
    window.webContents.session.on('will-download', (_event, item) => {
      assert.ok(item.getFilename().endsWith('.pdf'));
      item.setSavePath(resolve(output, 'report-workspace.pdf'));
      item.once('done', (_done, state) => finishDownload(state));
    });
    const evaluate = async (fn, ...args) => {
      const value = await window.webContents.executeJavaScript(
        `(async () => { try { return await (${fn.toString()})(...${JSON.stringify(args)}); } catch (error) { return { __smokeError: error.message }; } })()`,
      );
      if (value?.__smokeError) throw new Error(value.__smokeError);
      return value;
    };
    const waitFor = async (fn, label) => {
      for (let attempt = 0; attempt < 240; attempt++) {
        if (await evaluate(fn)) return;
        await pause(50);
      }
      throw new Error(
        label +
          ' :: ' +
          (await evaluate(() => document.body.innerText.slice(-3500))),
      );
    };
    const click = async (label, scope = '') => {
      await evaluate(
        (label, scope) => {
          const button = [...document.querySelectorAll(scope + ' button')].find(
            (item) =>
              !item.closest('[hidden]') &&
              !item.closest('[data-closed]') &&
              !item.disabled &&
              item.getAttribute('aria-disabled') !== 'true' &&
              (item.getAttribute('aria-label') === label ||
                item.textContent.trim() === label),
          );
          if (!button) throw new Error('Missing available button: ' + label);
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
              !item.closest('[hidden]') &&
              (item.getAttribute('aria-label') === label ||
                item.closest('label')?.querySelector('span')?.textContent ===
                  label),
          );
          if (!field) throw new Error('Missing field: ' + label);
          if (field.readOnly || field.disabled)
            throw new Error('Field is not editable: ' + label);
          field.focus();
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
      await evaluate(() => document.activeElement?.blur());
      await pause();
    };
    const readProject = () =>
      evaluate(
        () =>
          new Promise((done, fail) => {
            const open = indexedDB.open('stratus-workbench-v1');
            open.onerror = () => fail(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const request = db
                .transaction('project')
                .objectStore('project')
                .get('current');
              request.onsuccess = () => {
                db.close();
                done(request.result);
              };
              request.onerror = () => {
                db.close();
                fail(request.error);
              };
            };
          }),
      );
    const blockCount = () =>
      evaluate(() => document.querySelectorAll('.rb-paper .rb-block').length);
    const reportsVisible = () =>
      !document.querySelector('#workflow-reports-workspace')?.hidden &&
      document.querySelector('#workflow-data-workspace')?.hidden;

    await window.loadURL('stratum-report-data://app/index.html');
    await waitFor(
      () =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.textContent.trim() === 'Explore the example recording' &&
            !button.disabled,
        ),
      'The main application did not load',
    );
    // Start on the example's default view rather than the example tour.
    await evaluate(() =>
      localStorage.setItem('stratum-example-tour-v1', 'dismissed'),
    );
    await click('Explore the example recording');
    await waitFor(
      () =>
        document.querySelector('.scratchpad-plot-title h1')?.textContent ===
          'Motor speed' &&
        !!document.querySelector('.scratchpad-canvas .signal-chart svg path') &&
        !document.querySelector('[aria-label="Add to report"]')?.disabled,
      'Real demonstration workflow did not load',
    );
    assert.ok(
      await evaluate(() => {
        const bar = document
          .querySelector('.workflow-topbar')
          .getBoundingClientRect();
        const middle = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return box.top + box.height / 2;
        };
        return (
          bar.height < 56 &&
          Math.abs(
            middle('.workflow-create-action') - middle('.workflow-brand'),
          ) < 4 &&
          Math.abs(middle('.workflow-workspaces') - middle('.workflow-brand')) <
            4
        );
      }),
      'The top bar must keep the workspace switcher and signal tools on one row',
    );
    const originalProject = await readProject();
    assert.equal(originalProject.workflowSteps.length, 7);
    const scalar = originalProject.values.find(
      (value) => originalProject.labels[value.id] === 'Run 1 · Average product',
    );
    assert.ok(scalar && Number.isFinite(scalar.value));
    // Reports show values in the value tiles' format (lib/report-format.ts).
    const shownValue =
      scalar.value !== 0 &&
      (Math.abs(scalar.value) < 0.01 || Math.abs(scalar.value) >= 1e12)
        ? Math.abs(scalar.value) >= 1e6 || Math.abs(scalar.value) < 1e-3
          ? scalar.value.toPrecision(4)
          : String(Number(scalar.value.toPrecision(6)))
        : scalar.value.toLocaleString('en-GB', {
            minimumFractionDigits: 3,
            maximumFractionDigits: 3,
          });
    await evaluate(() => {
      const outputs = document.querySelector('#plot-dock-outputs');
      if (outputs.getAttribute('aria-selected') !== 'true') outputs.click();
    });
    await pause();
    // A check box starts from the explicit checks, never the viewed signal.
    // History rows share the label, so target the Outputs table check box.
    await evaluate(() =>
      document
        .querySelector(
          '[role="checkbox"][aria-label="Check Torque as an input"]',
        )
        .click(),
    );
    await pause();
    assert.ok(
      await evaluate(
        () =>
          document
            .querySelector(
              '[role="checkbox"][aria-label="Check Torque as an input"]',
            )
            .getAttribute('aria-checked') === 'true' &&
          document
            .querySelector(
              '[role="checkbox"][aria-label="Check Motor speed as an input"]',
            )
            .getAttribute('aria-checked') === 'false',
      ),
      'The checked processing scope must differ from the inspected signal',
    );

    await click('Reports', '.workflow-workspaces');
    await waitFor(reportsVisible, 'Reports navigation did not open the canvas');
    assert.equal(
      await blockCount(),
      0,
      'The integrated report must start blank',
    );
    assert.ok(
      await evaluate(
        () =>
          !!document
            .querySelector('.workflow-action-toolbar')
            .closest('[hidden]') &&
          !!document.querySelector('#workflow-data-workspace[hidden]') &&
          !document
            .querySelector('[aria-label="Use light theme"]')
            .closest('[hidden]'),
      ),
      'Reports must hide signal tools while keeping the application theme',
    );
    const editorSurface = () =>
      evaluate(
        () =>
          getComputedStyle(document.querySelector('.rb-app')).backgroundColor,
      );
    const darkSurface = await editorSurface();
    await click('Use light theme');
    assert.equal(
      await editorSurface(),
      'rgb(252, 252, 251)',
      'The report editor must follow the light theme tokens',
    );
    await click('Use dark theme');
    assert.equal(await editorSurface(), darkSurface);
    await click('Data Inspector', '.workflow-workspaces');
    await click('Add to report', '.workflow-action-toolbar');
    await waitFor(
      () => !!document.querySelector('.rb-paper [data-block-type="plot"]'),
      'Inspected signal did not become a report snapshot',
    );
    // Adding stays in Data; the toast and the Reports badge lead there.
    await waitFor(
      () =>
        document
          .querySelector('.workflow-toast')
          ?.textContent.includes('Added to report') &&
        !document.querySelector('#workflow-data-workspace')?.hidden &&
        !!document.querySelector('.workflow-workspace-badge'),
      'Add to report must stay in Data and offer Open Reports',
    );
    await click('Open Reports', '.workflow-toast');
    await waitFor(reportsVisible, 'Open Reports did not show the report');
    assert.ok(
      await evaluate(() => {
        const block = document.querySelector(
          '.rb-paper [data-block-type="plot"]',
        );
        return (
          block.textContent.includes('Motor speed') &&
          block.textContent.includes('rpm') &&
          !!block.querySelector('path, polyline') &&
          document
            .querySelector('.rb-source-info')
            .textContent.includes('1 source output')
        );
      }),
      'Signal block must use the actual signal and retain exact provenance',
    );
    await setField('Report name', 'Motor test — workspace report');
    await setField('Height', 240);

    await setField('Report data type', 'values');
    await setField('Search report data', 'Run 1 · Average product');
    await evaluate(() =>
      document.querySelector('.rb-data-asset input[type="checkbox"]').click(),
    );
    await click('Add selected (1)');
    await waitFor(
      () => !!document.querySelector('.rb-paper [data-block-type="table"]'),
      'Selected scalar did not become a values table',
    );
    assert.ok(
      await evaluate((expected) => {
        const block = document.querySelector(
          '.rb-paper [data-block-type="table"]',
        );
        return (
          block.textContent.includes('Run 1 · Average product') &&
          block.textContent.includes(expected) &&
          !block.textContent.includes('Run 2') &&
          !block.textContent.includes('Run 3') &&
          document
            .querySelector('.rb-source-info')
            .textContent.includes('1 source output')
        );
      }, shownValue),
      'An individual scalar capture must match the engine and exclude siblings',
    );
    assert.ok(
      await evaluate((expected) => {
        const field = document.querySelector('[aria-label="Row 2, column 2"]');
        return field.readOnly && field.value === expected;
      }, shownValue),
      'Captured numerical cells must show the scalar in the app format',
    );
    await setField('Table title', 'Measured result');
    assert.ok(
      await evaluate(() =>
        document
          .querySelector('.rb-paper [data-block-type="table"]')
          .textContent.includes('Measured result'),
      ),
      'Captured tables must remain formattable',
    );

    await click('Data Inspector', '.workflow-workspaces');
    assert.equal(
      await evaluate(
        () => document.querySelector('.scratchpad-plot-title h1')?.textContent,
      ),
      'Motor speed',
    );
    assert.ok(
      await evaluate(
        () =>
          document
            .querySelector(
              '[role="checkbox"][aria-label="Check Torque as an input"]',
            )
            .getAttribute('aria-checked') === 'true' &&
          document
            .querySelector(
              '[role="checkbox"][aria-label="Check Motor speed as an input"]',
            )
            .getAttribute('aria-checked') === 'false',
      ),
      'Report captures must preserve the independent checked processing scope',
    );
    await click('Keep plot');
    await waitFor(
      () => !!document.querySelector('.scratchpad-tab-name'),
      'A saved plot was not created',
    );
    await waitFor(
      () =>
        !document.querySelector('[aria-label="Add plot to report"]')?.disabled,
      'Saved plot never became available to capture',
    );
    await click('Add plot to report');
    await waitFor(
      () => !!document.querySelector('.workflow-toast'),
      'Plot capture did not confirm with a toast',
    );
    await click('Open Reports', '.workflow-toast');
    await waitFor(reportsVisible, 'Open Reports did not show the report');
    await waitFor(
      () => !!document.querySelector('.rb-paper .rb-block image'),
      'Displayed plot did not become a rendered snapshot',
    );
    assert.ok(
      await evaluate(() =>
        document
          .querySelector('.rb-source-info')
          ?.textContent.includes('displayed plot snapshot'),
      ),
      'Displayed plot capture must identify its source',
    );
    await setField('Height', 240);
    assert.equal(
      await blockCount(),
      3,
      'All first-page snapshots must survive workspace switches',
    );
    assert.equal(
      await evaluate(
        () => document.querySelector('[aria-label="Report name"]').value,
      ),
      'Motor test — workspace report',
    );

    await click('Add page', '.rb-workspace');
    await click('Data', '.rb-tabs');
    await setField('Report data type', 'plot');
    await setField('Search report data', '');
    await click('Add Motor speed to report', '.rb-data-list');
    await waitFor(
      () => !!document.querySelector('.rb-paper .rb-block image'),
      'Saved plot library capture did not produce a snapshot',
    );
    await setField('Height', 240);

    // Carry the actual history row's drag payload through the workspace switch.
    const dropHistoryRow = async (title, kind = 'output') => {
      await click('Data Inspector', '.workflow-workspaces');
      // History mounts only the rows in view; search brings this one there.
      await setField('Search workflow', title);
      await evaluate(
        ([title, kind]) => {
          const row = [
            ...document.querySelectorAll(
              `[role="treeitem"][data-kind="${kind}"]`,
            ),
          ].find((item) => item.title === title);
          if (!row)
            throw new Error(
              'Missing the history row ' +
                title +
                ': ' +
                [...document.querySelectorAll('[role="treeitem"]')]
                  .map((item) => item.title)
                  .join(' / '),
            );
          const transfer = new DataTransfer();
          row.dispatchEvent(
            new DragEvent('dragstart', {
              bubbles: true,
              dataTransfer: transfer,
            }),
          );
          globalThis.reportSmokeDrag = transfer;
          const reports = [
            ...document.querySelectorAll('.workflow-workspaces button'),
          ].find((button) => button.textContent.trim() === 'Reports');
          reports.dispatchEvent(
            new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        },
        [title, kind],
      );
      await waitFor(
        reportsVisible,
        'Dragging over Reports did not open the report workspace',
      );
      await evaluate(() => {
        const paper = document.querySelector('.rb-paper');
        const box = paper.getBoundingClientRect();
        const scale = box.width / parseFloat(paper.style.width);
        paper.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: globalThis.reportSmokeDrag,
            clientX: box.left + 48 * scale,
            clientY: box.top + 320 * scale,
          }),
        );
        delete globalThis.reportSmokeDrag;
      });
    };
    // Segments are time intervals, not data: dropping a Segment step (its
    // one History row) adds nothing.
    await dropHistoryRow('Find the three runs', 'step');
    await pause(300);
    assert.equal(
      await blockCount(),
      1,
      'A dropped Segment step must not add a report block',
    );
    // One value of a three-value step is captured without its siblings.
    await dropHistoryRow('Run 2 · Average product');
    await waitFor(
      () => document.querySelectorAll('.rb-paper .rb-block').length === 2,
      'Individual history member drop did not add one exact snapshot',
    );
    assert.ok(
      await evaluate(() => {
        const paper = document.querySelector('.rb-paper').textContent;
        return (
          document
            .querySelector('.rb-source-info')
            ?.textContent.includes('1 source output') &&
          paper.includes('Run 2 · Average product') &&
          !paper.includes('Run 1 · Average product') &&
          !paper.includes('Run 3 · Average product')
        );
      }),
      'A dropped value must exclude the other values of its step',
    );
    assert.equal(
      await evaluate(
        () => document.querySelector('[aria-label="Height"]').value,
      ),
      '166',
      'The inspector must show the newly selected block dimensions',
    );
    await setField('Height', 240);
    assert.equal(
      await evaluate(
        () =>
          document.querySelector('.rb-paper .rb-block.is-selected').style
            .height,
      ),
      '240px',
      'Value snapshot dimensions must remain editable',
    );
    await click('Text', '.rb-quick-insert');
    await setField('Text content', 'Measured results — reviewed locally');
    await setField('Y position', 600);
    await setField('Font size', 22);
    await click('Bold');
    assert.ok(
      await evaluate(() =>
        [...document.querySelectorAll('.rb-paper .rb-block text')].some(
          (text) =>
            text.getAttribute('font-weight') === '700' &&
            text.textContent.includes('Measured results'),
        ),
      ),
      'Text formatting must reach the page',
    );

    await click('Data Inspector', '.workflow-workspaces');
    await click('Reports', '.workflow-workspaces');
    assert.equal(
      await blockCount(),
      3,
      'Returning to Reports must retain the current page and draft',
    );
    await click('Undo (Ctrl+Z)');
    assert.ok(
      await evaluate(() =>
        [...document.querySelectorAll('.rb-paper .rb-block text')].some(
          (text) =>
            text.getAttribute('font-weight') !== '700' &&
            text.textContent.includes('Measured results'),
        ),
      ),
      'Report undo must survive navigation',
    );
    await click('Redo (Ctrl+Shift+Z)');
    // Report shortcuts never reach the signal workflow's persistent Undo.
    const shortcut = (shiftKey) =>
      evaluate((shiftKey) => {
        const editor = document.querySelector('.rb-app');
        editor.focus();
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, shiftKey);
    const boldText = () =>
      evaluate(() =>
        [...document.querySelectorAll('.rb-paper .rb-block text')].some(
          (text) =>
            text.getAttribute('font-weight') === '700' &&
            text.textContent.includes('Measured results'),
        ),
      );
    await shortcut(false);
    await pause(150);
    assert.equal(await boldText(), false, 'Ctrl+Z must undo the report edit');
    await shortcut(true);
    await pause(150);
    assert.equal(await boldText(), true, 'Ctrl+Shift+Z must redo it');
    assert.deepEqual(
      await readProject(),
      originalProject,
      'Building reports and saving plot layouts must not mutate the signal project',
    );
    await click('Preview');
    assert.equal(
      await evaluate(
        () => document.querySelectorAll('.rb-preview-sheet').length,
      ),
      2,
    );
    await click('Export PDF');
    assert.equal(await downloaded, 'completed');
    const pdf = readFileSync(resolve(output, 'report-workspace.pdf'));
    const binary = pdf.toString('latin1');
    assert.ok(binary.startsWith('%PDF-1.4'));
    assert.equal([...binary.matchAll(/\/Type \/Page\b/g)].length, 2);
    assert.equal([...binary.matchAll(/\/Filter \/DCTDecode/g)].length, 2);
    assert.ok(pdf.byteLength > 20000);
    assert.deepEqual(
      externalRequests,
      [],
      'Reports and engine reads must stay local',
    );
    await click('Back to editor');
    await window.webContents.capturePage(undefined, { stayHidden: true });
    await pause(150);
    writeFileSync(
      resolve(output, 'report-workspace.png'),
      (
        await window.webContents.capturePage(undefined, { stayHidden: true })
      ).toPNG(),
    );
    process.stdout.write(
      'Report workspace passed: real signal and scalar capture, exact membership, saved/displayed plots, history drag/drop (a value without its siblings, a segment adding nothing), shared theme, formatting, draft + undo retention, isolated shortcuts, immutable engine metadata, and two-page PDF export.\n',
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
