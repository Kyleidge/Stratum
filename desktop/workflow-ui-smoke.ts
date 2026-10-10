/** End-to-end checks against the actual native renderer and its worker. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowExport from '../components/workflow-export';
import WorkflowList from '../components/workflow-list';
import type { EngineResponse, Project } from '../lib/signal-types';
import { PLOT_STORAGE_KEY, readPlotSheets } from '../lib/plot-scratchpad';
import { plotUiSmoke } from './plot-ui-smoke';
import { timeRangeUiSmoke } from './time-range-ui-smoke';

export async function workflowUiSmoke() {
  // Hidden smoke windows run no rendering frames, so programmatic scrolling
  // (History revealing its selection) never fires the scroll event a visible
  // window would. Deliver it whenever the History scroll position changed.
  const scrolled = new WeakMap<Element, number>();
  function deliverScroll() {
    const tree = document.querySelector('[role="tree"]');
    if (tree && scrolled.get(tree) !== tree.scrollTop) {
      scrolled.set(tree, tree.scrollTop);
      tree.dispatchEvent(new Event('scroll'));
    }
  }
  const delay = () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        deliverScroll();
        setTimeout(resolve, 0);
      }, 30),
    );
  async function until<T>(
    read: () => T | undefined | false,
    label: string,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < 12000) {
      const result = read();
      if (result) return result;
      await delay();
    }
    throw new Error(
      `Timed out: ${label}. ${document.querySelector('[role="alert"]')?.textContent ?? ''} Controls: ${[...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((item) => `${item.getAttribute('aria-label')}:${item.disabled}`).join(', ')}. Status: ${document.querySelector('.workflow-status')?.textContent}. Dialog: ${document.querySelector('[role="dialog"][data-open] .operation-footer')?.textContent ?? 'none'}. Screen: ${document.body.innerText.slice(0, 1500)}`,
    );
  }
  const button = (text: string, root: Document | HTMLElement = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        (button.textContent?.trim() === text ||
          button.getAttribute('aria-label') === text) &&
        !button.disabled &&
        !button.closest('[data-closed]') &&
        button.getAttribute('aria-disabled') !== 'true',
    );
  async function menuAction(text: string) {
    if (
      !document.querySelector('[data-slot="dropdown-menu-content"][data-open]')
    ) {
      button('More actions for the selection')!.click();
      await delay();
    }
    const item = await until(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-slot="dropdown-menu-content"][data-open] [role="menuitem"]',
          ),
        ].find(
          (item) =>
            item.textContent?.trim() === text &&
            !item.hasAttribute('data-disabled'),
        ),
      `menu action ${text}`,
    );
    item.click();
    await delay();
  }
  async function click(text: string, root: Document | HTMLElement = document) {
    if (
      root === document &&
      [
        'Export data…',
        'Inputs and original signals',
        'Show lineage in History',
        'Used by later steps',
        'Open producing step',
        'Back to previous selection',
        'View samples',
      ].includes(text) &&
      !button(text)
    ) {
      await menuAction(text);
      return;
    }
    (await until(() => button(text, root), `button ${text}`)).click();
    await delay();
  }
  /** Apply to is named by its visible text, which follows the selection. */
  async function clickInputScope() {
    const scope = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.workflow-input-scope:not(:disabled)',
        ) ?? undefined,
      'Apply to',
    );
    scope.click();
    await delay();
  }
  async function dialog() {
    return until(
      () =>
        document.querySelector<HTMLElement>('[role="dialog"][data-open]') ??
        undefined,
      'dialog',
    );
  }
  /** Delimited text opens its import setup; accept the suggested columns. */
  async function confirmImport() {
    const setup = await until(
      () =>
        document.querySelector<HTMLElement>(
          '.workflow-import-dialog[data-open]',
        ) ?? undefined,
      'import setup',
    );
    await click('Import 1 recording', setup);
    await until(
      () => !setup.isConnected || !setup.hasAttribute('data-open'),
      'import setup closed',
    );
  }
  async function settled() {
    await until(
      () =>
        !document.querySelector('[role="dialog"]') &&
        !!document.querySelector('.workflow-notice'),
      'saved operation',
    );
    await delay();
  }
  function setValue(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  let checkedSegmentMethods = false;
  /** The step a creation notice names, and how many outputs it made. */
  function createdStep() {
    const text = document.querySelector('.workflow-notice')?.textContent ?? '';
    const match = /^(#\d{3}) .* created ([\d,]+) /.exec(text);
    assert(match, `Unexpected creation notice: ${text}`);
    return { ref: match[1], count: Number(match[2].replaceAll(',', '')) };
  }
  /** Within's segment check boxes: "All N segments", then each segment. */
  function withinAll(modal: HTMLElement) {
    const label = modal.querySelector<HTMLElement>(
      '.within-segments > label.segment-checkbox',
    );
    return label
      ? {
          text: label.textContent?.trim() ?? '',
          box: label.querySelector<HTMLElement>('[role="checkbox"]')!,
        }
      : undefined;
  }
  function withinChoices(modal: HTMLElement) {
    return [
      ...modal.querySelectorAll<HTMLElement>('.within-segment-list li'),
    ].map((item) => ({
      name: item.querySelector('label > span:not([role])')?.textContent ?? '',
      box: item.querySelector<HTMLElement>('[role="checkbox"]')!,
    }));
  }
  const withinText = (modal: HTMLElement) =>
    modal
      .querySelector('button[aria-label="Within"] [data-slot="select-value"]')
      ?.textContent?.trim() ?? '';
  /** The segments checked in Within's per-segment list. */
  const withinChosen = (modal: HTMLElement) =>
    withinChoices(modal)
      .filter((item) => item.box.getAttribute('aria-checked') === 'true')
      .map((item) => item.name)
      .join();
  /** Describes Within and the create button for failure messages. */
  const withinState = (modal: HTMLElement) =>
    `Within "${withinText(modal)}", ${withinAll(modal)?.text ?? 'no segments'} ${withinAll(modal)?.box.getAttribute('aria-checked')}, chosen "${withinChosen(modal)}", footer "${modal.querySelector('.operation-footer')?.textContent}"`;
  /** Finds segments by time ranges; returns the new Segment step. */
  async function segment(ranges: string) {
    await click('Segment');
    const modal = await dialog();
    assert(
      modal.querySelector('h2')?.textContent === 'Find segments' &&
        modal.querySelector('.operation-inputs-label')?.textContent ===
          'Recording' &&
        modal.querySelectorAll('.operation-input-chip').length === 1,
      'Segment must find segments of the recording, not of signals.',
    );
    let pickedOnPlot = false;
    if (!checkedSegmentMethods) {
      assert(
        withinText(modal) === 'Entire recording' && !withinAll(modal),
        'New top-level segments must search the entire recording.',
      );
      assert(
        modal.querySelectorAll('[role="radio"]').length === 3,
        'Segment methods should be directly selectable cards.',
      );
      const initialRanges =
        modal.querySelector<HTMLTextAreaElement>('textarea')!.value;
      modal
        .querySelector<HTMLElement>('[role="radio"][aria-label="Windows"]')!
        .click();
      await delay();
      for (const [label, value] of [
        ['Range start', '12'],
        ['Range end', '22'],
        ['Window duration', '5'],
        ['Step between starts', '5'],
      ]) {
        setValue(
          modal.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          )!,
          value,
        );
        await delay();
      }
      // Segment previews update automatically as settings change.
      await until(
        () =>
          modal
            .querySelector('.segment-preview strong')
            ?.textContent?.startsWith('2 segments · 0 clipped'),
        'window card preview',
      );
      await until(
        () =>
          modal.querySelectorAll('.segment-plot .segment-band').length === 2,
        'window plot bands',
      );
      modal
        .querySelector<HTMLElement>('[role="radio"][aria-label="Triggers"]')!
        .click();
      // The window plan must clear before the debounced trigger preview
      // arrives; a slow runner may take more than one delay to render.
      await until(
        () => !modal.querySelector('.segment-preview strong'),
        'Switching methods kept a stale preview',
      );
      for (const [label, value] of [
        ['Start threshold', '1000'],
        ['End threshold', '1000'],
        ['Start offset', '0'],
        ['End offset', '0'],
      ]) {
        setValue(
          modal.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          )!,
          value,
        );
        await delay();
      }
      await until(
        () =>
          modal
            .querySelector('.segment-preview strong')
            ?.textContent?.startsWith('3 segments'),
        'trigger card preview',
      );
      await until(
        () =>
          modal.querySelectorAll('.segment-plot [data-threshold]').length === 2,
        'trigger plot thresholds',
      );
      modal
        .querySelector<HTMLElement>('[role="radio"][aria-label="Windows"]')!
        .click();
      await delay();
      assert(
        modal.querySelector<HTMLInputElement>(
          'input[aria-label="Window duration"]',
        )?.value === '5',
        'Switching methods lost window settings.',
      );
      modal
        .querySelector<HTMLElement>('[role="radio"][aria-label="Time ranges"]')!
        .click();
      await delay();
      assert(
        modal.querySelector<HTMLTextAreaElement>('textarea')?.value ===
          initialRanges,
        'Switching methods lost manual ranges.',
      );
      checkedSegmentMethods = true;
      await timeRangeUiSmoke(modal, ranges);
      pickedOnPlot = true;
    }
    const textarea = modal.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Manual ranges were not the default.');
    if (!pickedOnPlot) setValue(textarea, ranges);
    await delay();
    const count = ranges.split('\n').length;
    if (count > 30) {
      assert(
        modal.querySelectorAll('.range-list tbody tr').length === 30,
        'Exact range rows must stay paged for large batches.',
      );
      await click('Next ranges', modal);
      assert(
        modal.querySelector('[aria-label="Range 31 start"]'),
        'The next range page must expose later members.',
      );
    }
    await until(
      () =>
        modal
          .querySelector('.segment-preview strong')
          ?.textContent?.startsWith(`${count} segments · 0 clipped`),
      'segment preview',
    );
    await click('Create segments', modal);
    await settled();
    const created = createdStep();
    assert(
      created.count === count &&
        document.querySelector('.workflow-status-selection')?.textContent ===
          'Time range segments',
      'Creating segments did not select its Segment step.',
    );
    return created.ref;
  }
  const searchBox = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Search workflow"]',
    )!;
  /** History's row for a step, found by searching for its reference. */
  async function stepRow(ref: string) {
    setValue(searchBox(), ref);
    await delay();
    return until(() => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          '.workflow-tree-row[data-kind="step"]',
        ),
      ];
      return rows.length === 1 && rows[0];
    }, `step row ${ref}`);
  }
  /** A step row's revision and output count, such as "v2 · 3 segments". */
  async function stepSummary(ref: string) {
    const text = (await stepRow(ref)).querySelector('small')?.textContent;
    setValue(searchBox(), '');
    await delay();
    return text;
  }
  /** Selects a step's output by its position in the Outputs table. */
  async function openStepOutput(ref: string, position: number) {
    (await stepRow(ref)).click();
    await delay();
    setValue(searchBox(), '');
    await delay();
    await outputsTab();
    (
      await until(
        () =>
          document.querySelectorAll<HTMLButtonElement>('.workflow-output-name')[
            position
          ],
        `output ${position + 1} of ${ref}`,
      )
    ).click();
    await delay();
  }
  async function uncheckAll() {
    if (button('Uncheck all signals')) await click('Uncheck all signals');
  }
  const details = () =>
    document.querySelector<HTMLElement>(
      '#workflow-inspector .workflow-properties',
    )!;
  const detailTerm = (term: string) =>
    [...details().querySelectorAll('dt')].find(
      (item) => item.textContent === term,
    )?.nextElementSibling;
  const detail = (term: string) => detailTerm(term)?.textContent ?? undefined;
  const detailLink = (term: string) =>
    detailTerm(term)?.querySelector<HTMLButtonElement>('button') ?? undefined;
  /** Shaded segment bands in the first Active plot frame. */
  const plotBands = () => [
    ...(document
      .querySelector('.scratchpad-canvas .signal-chart svg')
      ?.querySelectorAll('.chart-segment') ?? []),
  ];
  const selectedBand = () =>
    plotBands().find((band) => band.hasAttribute('data-selected'));
  /**
   * A selected segment: its Segment step's single History row (segments are
   * not listed), the plot chooser naming it, Details with its times, and the
   * plot of its signals zoomed to its shaded band.
   */
  async function checkSegmentSelection(name: string, duration?: number) {
    const row = selectedHistoryRow();
    assert(
      row.getAttribute('data-kind') === 'step' &&
        !row.hasAttribute('aria-expanded') &&
        / segments?$/.test(row.querySelector('small')?.textContent ?? '') &&
        !document.querySelector(
          '.workflow-tree-row[data-kind="output"] .workflow-icon.segment',
        ),
      `History did not show ${name} by its Segment step: ${row.getAttribute('aria-label')}.`,
    );
    await until(
      () =>
        document
          .querySelector('.scratchpad-segment-select')
          ?.textContent?.startsWith(`${name} · `),
      `plot chooser naming ${name}`,
    );
    await until(
      () => details().querySelector('h2')?.textContent?.startsWith(name),
      `Details of ${name}`,
    );
    assert(
      ['Start', 'End', 'Duration'].every((term) => detail(term)) &&
        (duration === undefined ||
          Math.abs(Number.parseFloat(detail('Duration')!) - duration) < 0.01),
      `Details did not show the times of ${name}: ${details().textContent}`,
    );
    await until(
      () =>
        selectedBand() &&
        !document
          .querySelector('.scratchpad-axis-footer')
          ?.textContent?.includes('100%'),
      `plot zoomed to ${name}`,
    );
  }
  /** The example finds three runs, then works within them. */
  async function exampleSegments() {
    assert(
      (await stepSummary('Find the three runs')) === '3 segments',
      'The example must find three run segments.',
    );
    await openSegment('Find the three runs', 'Run 2');
    await checkSegmentSelection('Run 2');
    assert(
      detail('Crossings') && plotBands().length === 3,
      'The example runs must come from speed triggers.',
    );
    // The plot chooser shows every segment, aligned segments, or one.
    async function chooseSegments(text: string) {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Segments to plot"]',
        )!
        .click();
      await delay();
      (
        await until(
          () =>
            [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
              (option) => option.textContent?.trim().startsWith(text),
            ),
          `segment choice ${text}`,
        )
      ).click();
      await delay();
    }
    await chooseSegments('Aligned from start');
    await until(
      () =>
        document.querySelectorAll('.aligned-segments-legend button').length ===
          3 &&
        document.querySelector('.aligned-segments .signal-chart svg') &&
        selectedHistoryRow().getAttribute('data-kind') === 'step',
      'segments aligned from their starts',
    );
    await chooseSegments('All 3 segments');
    await until(
      () => plotBands().length === 3 && !selectedBand(),
      'every segment over the recording',
    );
    await chooseSegments('Run 2 · ');
    await checkSegmentSelection('Run 2');
    // Value while viewing a segment works within it.
    await click('Calculate value');
    const modal = await dialog();
    assert(
      withinText(modal).includes('Find the three runs · 3 segments') &&
        withinAll(modal)?.box.getAttribute('aria-checked') === 'false' &&
        withinChosen(modal) === 'Run 2' &&
        button('Create up to 1 value', modal),
      `Value did not default Within to the viewed segment: ${withinState(modal)}.`,
    );
    await click('Close', modal);
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close segment value editor',
    );
    await openSegment('Split Run 2 into two halves', 'Run 2 · First half');
    await checkSegmentSelection('Run 2 · First half', 20);
    await openOutput('Run 2 · Average product');
    (
      await until(
        () =>
          detailLink('Within')?.textContent === 'Run 2' && detailLink('Within'),
        'value Within link',
      )
    ).click();
    await until(
      () =>
        document.querySelector('.workflow-status-selection')?.textContent ===
        'Run 2',
      'follow a value to its segment',
    );
  }
  async function openFirstOutput() {
    await outputsTab();
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>('.workflow-output-name') ??
          undefined,
        'output',
      )
    ).click();
    await delay();
  }
  async function outputsTab() {
    const tab = await until(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
          (element) => element.textContent?.trim() === 'Active',
        ),
      'Active tab',
    );
    tab.click();
    await delay();
    const outputs = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.plot-output-dock #plot-dock-outputs',
        ) ?? undefined,
      'operation outputs dock',
    );
    if (outputs.getAttribute('aria-selected') !== 'true') {
      outputs.click();
      await delay();
    }
    assert(
      document.querySelector('.plot-dock-body .workflow-output-panel'),
      'Active must dock the operation outputs below the plot.',
    );
  }
  /** Operation dialogs offer their choices as radio cards. */
  async function chooseCard(label: string) {
    (await dialog())
      .querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`)!
      .click();
    await delay();
  }
  /** Compare & align names its Create button after the output count. */
  async function createTimeResult() {
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[role="dialog"][data-open] .operation-footer .primary-button:not(:disabled)',
          ) ?? undefined,
        'Compare & align create button',
      )
    ).click();
    await delay();
  }
  async function choose(label: string, text: string) {
    const chooser = (await dialog()).querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!chooser) throw new Error(`Missing chooser ${label}`);
    chooser.click();
    await delay();
    (
      await until(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
            (option) => option.textContent?.trim() === text,
          ),
        text,
      )
    ).click();
    await delay();
  }
  /** Chooses an Export data radio card by its group and value. */
  async function pick(name: string, value: string) {
    const input = (await dialog()).querySelector<HTMLInputElement>(
      `input[type="radio"][name="${name}"][value="${value}"]`,
    );
    if (!input) throw new Error(`Missing export choice ${name}=${value}`);
    input.click();
    await delay();
  }
  async function exportFile(options?: {
    scope?: 'viewed' | 'checked' | 'step';
    report?: boolean;
  }) {
    await click('Export data…');
    if (options?.scope) await pick('export-scope', options.scope);
    if (options?.report) await pick('export-format', 'report');
    // Samples CSV goes through the native Save dialog on the desktop.
    const exportDialog = await dialog();
    await click(
      button('Save file…', exportDialog) ? 'Save file…' : 'Download file',
      exportDialog,
    );
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'download prepared',
    );
    await delay();
  }
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  const outputRow = (name: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.workflow-tree-row[data-kind="output"]',
      ),
    ].find((row) => row.title === name);
  /** Filters History to an output by name, selects it and clears the filter. */
  /** Selects a segment through its step's Outputs table. */
  async function openSegment(step: string, name: string) {
    (await stepRow(step)).click();
    await delay();
    setValue(searchBox(), '');
    await delay();
    await outputsTab();
    (
      await until(
        () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              '.workflow-output-name',
            ),
          ].find((item) => item.title === name),
        `segment ${name}`,
      )
    ).click();
    await delay();
  }
  async function openOutput(name: string) {
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search workflow"]',
    )!;
    setValue(search, name);
    // Outputs within segments have no History row: their step's one row
    // matches, and the Outputs table selects the output.
    const found = await until(
      () =>
        outputRow(name) ??
        (document.querySelectorAll('.workflow-tree-row').length === 1 &&
          document.querySelector<HTMLElement>(
            '.workflow-tree-row[data-kind="step"]',
          )) ??
        undefined,
      `output ${name}`,
    );
    found.click();
    await delay();
    setValue(search, '');
    await delay();
    if (found.getAttribute('data-kind') === 'step') {
      await outputsTab();
      (
        await until(
          () =>
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                '.workflow-output-name',
              ),
            ].find((item) => item.title === name),
          `output ${name} in its step`,
        )
      ).click();
      await delay();
    }
  }
  /** The viewed member's row in the Outputs table (members within segments
   * have no History row). */
  async function memberRow() {
    const find = () =>
      document.querySelector<HTMLElement>(
        '.workflow-output-table tr[data-state="selected"]',
      ) ?? undefined;
    // A saved plot tab hides the dock; Active shows it again.
    if (!find())
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((tab) => tab.textContent?.trim() === 'Active')
        ?.click();
    return until(find, 'the viewed member in the Outputs table');
  }
  /** Checks only the viewed member, through the Outputs table. */
  async function checkOnlyMember() {
    const uncheck = [
      ...document.querySelectorAll<HTMLButtonElement>('.workflow-link'),
    ].find((item) => item.textContent?.trim() === 'Uncheck all');
    if (uncheck && !uncheck.disabled) uncheck.click();
    await delay();
    (await memberRow())
      .querySelector<HTMLElement>('[aria-label^="Check "]')!
      .click();
    await delay();
  }
  function selectedHistoryRow() {
    const row = document.querySelector<HTMLElement>(
      '.workflow-tree-row[aria-selected="true"]',
    );
    assert(
      row,
      `Selected history item is missing: ${document.querySelector('.workflow-status-selection')?.textContent}; rows ${[...document.querySelectorAll<HTMLElement>('.workflow-tree-row')].map((item) => item.title).join(' / ')}`,
    );
    return row;
  }
  async function dragItem(row: HTMLElement, target: HTMLElement) {
    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
    assert(
      dataTransfer.types.includes('application/x-stratum-workflow'),
      'History drag has no structured payload.',
    );
    await delay();
    target.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
    );
    row.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer }),
    );
    await delay();
  }
  async function closePlot() {
    document
      .querySelector<HTMLButtonElement>('[aria-label^="Close plot "]')!
      .click();
    await delay();
    document
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss closed plot"]')
      ?.click();
    await delay();
  }
  async function contextAction(
    row: HTMLElement,
    label: string,
    keyboard = false,
  ) {
    row.focus();
    if (keyboard) {
      row.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      const bounds = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: bounds.left + 24,
          clientY: bounds.top + bounds.height / 2,
        }),
      );
    }
    const menu = await until(
      () => document.querySelector<HTMLElement>('[role="menu"]') ?? undefined,
      'history context menu',
    );
    const item = [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.trim().startsWith(label));
    assert(item, `Missing history action: ${label}`);
    item.click();
    await until(() => !menu.isConnected, 'closed history context menu');
    await delay();
  }
  async function resizePanes() {
    const canvas = document.querySelector('.scratchpad-canvas');
    for (const [pane, direction] of [
      ['history', 1],
      ['inspector', -1],
    ] as const) {
      const splitter = document.querySelector<HTMLElement>(
        `.workflow-${pane}-resizer`,
      );
      assert(splitter, `Missing ${pane} resize handle.`);
      const target = document.getElementById(
        splitter.getAttribute('aria-controls')!,
      );
      assert(target, `Missing ${pane} controlled pane.`);
      const width = () => target.getBoundingClientRect().width;
      const initial = width();
      const rect = splitter.getBoundingClientRect();
      const start = rect.left + rect.width / 2;
      function pointer(type: string, delta = 0) {
        splitter!.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 71,
            button: 0,
            clientX: start + delta * direction,
            clientY: rect.top + rect.height / 2,
          }),
        );
      }
      function key(value: string) {
        splitter!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      pointer('pointerdown');
      pointer('pointermove', 90);
      await until(
        () => Math.abs(width() - initial - 90) < 1,
        `${pane} drag resize`,
      );
      pointer('pointerup', 90);
      const storageKey = `stratus-${pane}-width-v1`;
      assert(
        Math.abs(Number(localStorage.getItem(storageKey)) - initial - 90) < 1,
        `${pane} width was not saved.`,
      );
      key(direction === 1 ? 'ArrowLeft' : 'ArrowRight');
      await until(
        () => Math.abs(width() - initial - 80) < 1,
        `${pane} keyboard resize`,
      );
      pointer('pointerdown');
      pointer('pointermove', -60);
      key('Escape');
      await until(
        () => Math.abs(width() - initial - 80) < 1,
        `${pane} cancelled resize`,
      );
      key('End');
      await delay();
      assert(
        width() <= Number(splitter.getAttribute('aria-valuemax')) + 1 &&
          document.querySelector('.workflow-main')!.getBoundingClientRect()
            .width >= 350,
        `${pane} resize crowded out the plot.`,
      );
      key('Home');
      await until(
        () =>
          Math.abs(width() - Number(splitter.getAttribute('aria-valuemin'))) <
          1,
        `${pane} minimum width`,
      );
      splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await until(() => Math.abs(width() - initial) < 1, `${pane} reset width`);
      assert(
        document.querySelector('.scratchpad-canvas') === canvas,
        'Resizing remounted the active plot.',
      );
    }
  }
  /** Ctrl+K finds outputs by name; the top bar trigger opens the same palette. */
  async function commandPalette() {
    async function openByName(query: string, label: string, keyboard: boolean) {
      if (keyboard)
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      else await click('Search or run a command');
      const palette = await dialog();
      const input = palette.querySelector<HTMLInputElement>(
        'input[aria-label="Search steps, outputs and commands"]',
      );
      assert(input, 'Command palette search is missing.');
      setValue(input, query);
      (
        await until(
          () =>
            [...palette.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
              (item) =>
                item.querySelector('.workflow-palette-label')?.textContent ===
                label,
            ),
          `palette result ${label}`,
        )
      ).click();
      await until(
        () =>
          !document.querySelector('[role="dialog"]') &&
          document.querySelector('.workflow-status-selection')?.textContent ===
            label,
        `palette opened ${label}`,
      );
    }
    await openByName('torque smoothed', 'Smoothed torque', true);
    await openByName('motor speed', 'Motor speed', false);
  }
  async function selectionDetails() {
    const sidebar = document.getElementById('workflow-navigation')!;
    const inspector = document.getElementById('workflow-inspector');
    const details = inspector?.querySelector<HTMLElement>(
      '.workflow-properties',
    );
    const tree = sidebar.querySelector<HTMLElement>('[role="tree"]')!;
    assert(details, 'Selection details must be in the inspector.');
    const plot = () =>
      document.querySelector('.workflow-main')!.getBoundingClientRect();
    assert(
      !sidebar.querySelector('.workflow-properties') &&
        inspector!.getBoundingClientRect().left >= plot().right - 1 &&
        tree.getBoundingClientRect().bottom > innerHeight - 120,
      'The inspector must sit right of the plot, leaving History its height.',
    );
    const plotWidth = plot().width;
    const selectSignal = (name: string) => {
      const row = [
        ...tree.querySelectorAll<HTMLElement>('[data-kind="output"]'),
      ].find((item) => item.title === name);
      assert(row, `Missing signal for selection details: ${name}`);
      row.click();
    };
    await click('Toggle Details');
    selectSignal('Torque');
    await delay();
    assert(
      document
        .querySelector('.workflow-app')
        ?.getAttribute('data-inspector') === 'false' &&
        getComputedStyle(inspector!).display === 'none' &&
        plot().width > plotWidth + 200 &&
        localStorage.getItem('stratum-inspector-open-v1') === 'false',
      'Hiding the inspector must persist and give its width to the plot.',
    );
    await click('Toggle Details');
    assert(
      details.querySelector('h2')?.textContent === 'Torque' &&
        details.textContent?.includes('Nm') &&
        Math.abs(plot().width - plotWidth) < 1,
      'The inspector must follow the selection and restore its column.',
    );
    await until(
      () =>
        [...details.querySelectorAll('dt')].find(
          (term) => term.textContent === 'Samples',
        )?.nextElementSibling?.textContent === (1801).toLocaleString(),
      'full sample count in the inspector',
    );
    assert(
      ['Source recordings', 'Time axis', 'Lineage', 'Used by'].every((text) =>
        details.textContent?.includes(text),
      ),
      'The inspector must show complete metadata, lineage and later uses.',
    );
    details
      .querySelector<HTMLButtonElement>('.workflow-property-link')!
      .click();
    await delay();
    assert(
      details.textContent?.includes('Import step · #001') &&
        selectedHistoryRow().dataset.kind === 'step',
      'Following the producing operation must select it.',
    );
    selectSignal('Motor speed');
    await delay();
  }
  try {
    await until(
      () => button('Explore the example recording') || button('Derive signal'),
      'workspace startup',
    );
    // Start on the example's default view rather than the example tour.
    localStorage.setItem('stratum-example-tour-v1', 'dismissed');
    if (button('Explore the example recording'))
      await click('Explore the example recording');
    await until(() => button('Derive signal'), 'initial signal');
    await until(
      () => document.querySelector('.scratchpad-canvas .signal-chart svg'),
      'active plot',
    );
    await resizePanes();
    await selectionDetails();
    await commandPalette();
    // Ctrl+click checks History signals for processing without changing
    // inspection; the checked bar opens the value editor for all of them.
    const viewedRow = selectedHistoryRow().title;
    const checkedRows = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.workflow-tree-row[data-kind="output"][aria-checked="true"]',
        ),
      ].map((row) => row.title);
    (
      await until(() => outputRow('Torque'), 'torque row to check')
    ).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await delay();
    assert(
      selectedHistoryRow().title === viewedRow &&
        checkedRows().length === 2 &&
        checkedRows().includes('Torque') &&
        checkedRows().includes(viewedRow),
      'Ctrl+click must check the viewed and clicked signals, keeping inspection.',
    );
    await click('Calculate values for the checked signals');
    const checkedValueModal = await dialog();
    assert(
      button('Create 2 values', checkedValueModal),
      'History checks did not reach the value editor.',
    );
    await click('Close', checkedValueModal);
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close checked value editor',
    );
    await click('Uncheck all signals');
    assert(
      !checkedRows().length &&
        !document.querySelector('.workflow-checked-bar') &&
        selectedHistoryRow().title === viewedRow,
      'Unchecking all must follow the selection again.',
    );
    await click('Keep plot');
    const plotTab = () =>
      document.querySelector('[aria-label="Plot tabs"] [aria-selected="true"]');
    assert(
      plotTab()?.textContent?.includes('Motor speed'),
      'Keep plot did not open a named tab.',
    );
    const signalRow = (name: string) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.workflow-tree-row[data-kind="output"]',
        ),
      ].find((row) => row.title === name);
    const selectionBeforePlot = selectedHistoryRow().title;
    await contextAction(
      (await until(() => signalRow('Torque'), 'torque context target'))!,
      'Create plot',
      true,
    );
    await until(() => button('Hide trace Torque'), 'context plot of Torque');
    assert(
      selectedHistoryRow().title === selectionBeforePlot &&
        document.querySelectorAll('.scratchpad-trace').length === 1,
      'Create plot must use the context target and preserve inspection.',
    );
    await closePlot();
    document
      .querySelector<HTMLElement>('.scratchpad-tab-name')!
      .closest<HTMLButtonElement>('[role="tab"]')!
      .click();
    await delay();
    (await until(() => signalRow('Torque'), 'torque row')).click();
    await delay();
    assert(
      plotTab()?.textContent?.includes('Motor speed'),
      'Inspecting another signal replaced a saved plot.',
    );
    await dragItem(
      signalRow('Torque')!,
      document.querySelector<HTMLElement>('.scratchpad-canvas')!,
    );
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 2,
      'multiple Y axes for mixed units',
    );
    assert(
      document.querySelectorAll('.scratchpad-lane .signal-chart svg').length ===
        2 &&
        document.querySelectorAll('.scratchpad-canvas [data-time-axis]')
          .length === 1,
      'Mixed units should default to lanes that share one time axis.',
    );
    await click('Y axes');
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
          .length === 1 &&
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 2,
      'explicit independent Y axes',
    );
    await click(
      'Motor speed',
      document.querySelector<HTMLElement>('.scratchpad-plot-toolbar')!,
    );
    const rename = await dialog();
    setValue(
      rename.querySelector<HTMLInputElement>('input[aria-label="Plot name"]')!,
      'Motor comparison',
    );
    await delay();
    await click('Save name', rename);
    await until(
      () => plotTab()?.textContent?.includes('Motor comparison'),
      'renamed plot tab',
    );
    const hide = document.querySelector<HTMLButtonElement>(
      '[aria-label="Hide trace Torque"]',
    )!;
    hide.click();
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 1,
      'hidden trace',
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Show trace Torque"]')!
      .click();
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 2,
      'restored trace',
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
      .click();
    await until(
      () =>
        document
          .querySelector('.scratchpad-axis-footer')
          ?.textContent?.includes('200%'),
      'plot zoom',
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Pan plot right"]')!
      .click();
    await delay();
    document
      .querySelector<HTMLButtonElement>('[aria-label="Fit entire plot"]')!
      .click();
    await delay();
    assert(
      document
        .querySelector('.scratchpad-axis-footer')
        ?.textContent?.includes('100%'),
      'Fit did not reset the time window.',
    );
    await plotUiSmoke();
    const stored = readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY));
    assert(
      stored.length === 1 &&
        stored[0].name === 'Motor comparison' &&
        stored[0].traces.length === 2,
      'Plot layout was not saved locally.',
    );
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Close plot Motor comparison"]',
      )!
      .click();
    await delay();
    assert(
      document.querySelector('.scratchpad-plot-title h1')?.textContent ===
        'Torque',
      'Active did not follow the latest selection.',
    );
    await click('Reopen');
    assert(
      plotTab()?.textContent?.includes('Motor comparison'),
      'Closed plot could not be reopened.',
    );
    await click('Add signals');
    const signalPicker = await dialog();
    setValue(
      signalPicker.querySelector<HTMLInputElement>(
        '[aria-label="Search plot signals"]',
      )!,
      'Smoothed torque',
    );
    await delay();
    assert(
      signalPicker.querySelectorAll('.scratchpad-choices label').length === 1,
      'Plot signal search did not filter choices.',
    );
    signalPicker.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click();
    await delay();
    await click('Apply signals', signalPicker);
    await until(
      () => document.querySelectorAll('.scratchpad-trace').length === 3,
      'picker trace added',
    );
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 2 &&
        document.querySelector('[data-value-axis="unit:Nm"] .plot-axis-title')
          ?.textContent === 'Nm',
      'Same-unit traces did not share an automatically named axis.',
    );
    // A same-unit trace can move onto another independently scaled Y axis.
    [...document.querySelectorAll<HTMLButtonElement>('.scratchpad-trace-name')]
      .find(
        (item) =>
          item.querySelector('strong')?.textContent === 'Smoothed torque',
      )!
      .click();
    await click('Add Y axis', await dialog());
    const assigned = readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY))[0];
    const extraAxis = assigned.traces.find((trace) =>
      trace.axisId?.startsWith('axis:'),
    )?.axisId;
    assert(
      extraAxis && assigned.axes?.values?.[extraAxis].unit === 'Nm',
      'Add Y axis did not assign a compatible separate scale.',
    );
    await click('Trace Y axis');
    await until(
      () => document.querySelector('.plot-select-popup [role="option"]'),
      'axis choices',
    );
    const axisChoices = [
      ...document.querySelectorAll<HTMLElement>(
        '.plot-select-popup [role="option"]',
      ),
    ];
    assert(
      axisChoices.length === 2 &&
        axisChoices.every((item) => item.dataset.plotOption !== 'unit:rpm'),
      'Axis chooser offered incompatible units.',
    );
    axisChoices.find((item) => item.dataset.plotOption === extraAxis)!.click();
    await delay();
    await click('Done');
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 3,
      'separate axes with identical units',
    );
    assert(
      document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
        .length === 1,
      'Same-unit extra axis split the plot.',
    );
    // Move it back, then remove the unused extra axis through the axes dialog.
    [...document.querySelectorAll<HTMLButtonElement>('.scratchpad-trace-name')]
      .find(
        (item) =>
          item.querySelector('strong')?.textContent === 'Smoothed torque',
      )!
      .click();
    await dialog();
    await click('Trace Y axis');
    (
      await until(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.plot-select-popup [role="option"]',
            ),
          ].find((item) => item.dataset.plotOption === 'unit:Nm'),
        'automatic Nm axis',
      )
    ).click();
    await delay();
    await click('Done');
    await click('Plot axes and limits');
    await click('Y axis');
    (
      await until(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.plot-select-popup [role="option"]',
            ),
          ].find((item) => item.dataset.plotOption === extraAxis),
        'extra axis editor',
      )
    ).click();
    await delay();
    await click('Remove Y axis');
    await click('Apply axes');
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 2,
      'removed unused axis',
    );
    await click('Add signals');
    const thirdUnitPicker = await dialog();
    setValue(
      thirdUnitPicker.querySelector<HTMLInputElement>(
        '[aria-label="Search plot signals"]',
      )!,
      'Torque × speed',
    );
    await delay();
    thirdUnitPicker
      .querySelector<HTMLButtonElement>('[role="checkbox"]')!
      .click();
    await delay();
    await click('Apply signals', thirdUnitPicker);
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [data-value-axis]')
          .length === 3,
      'third independent Y axis',
    );
    assert(
      document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
        .length === 1,
      'A third unit split the plot.',
    );
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Close plot Motor comparison"]',
      )!
      .click();
    await delay();
    document
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss closed plot"]')!
      .click();
    (await until(() => signalRow('Motor speed'), 'speed row')).click();
    await delay();
    assert(
      document
        .querySelector('.workflow-properties')
        ?.textContent?.includes('Original signal'),
      'Startup must expose an original signal.',
    );
    assert(
      !document.body.innerText.includes('Saved region ranges'),
      'The new example contains legacy-only ranges.',
    );
    assert(
      !document.querySelector('.workflow-example'),
      'Example banner is still visible.',
    );
    assert(
      !document.querySelector('.workflow-detail-heading'),
      'Selected signal details remain below the plot.',
    );
    assert(
      !document.querySelector('.workflow-header [aria-label="Recording"]'),
      'Recording selector remains in the header.',
    );
    assert(
      document.querySelectorAll('.workflow-action-toolbar button').length ===
        8 &&
        document.querySelectorAll('.workflow-create-action').length === 4 &&
        !!document.querySelector(
          '.workflow-action-toolbar [aria-label="Add to report"]',
        ),
      'The top bar must hold four operations, Apply to, Add to report, Export data and More actions.',
    );
    assert(
      !document.querySelector(
        '.workflow-action-toolbar [data-action="delete"]',
      ) &&
        !document.querySelector(
          '.workflow-action-toolbar [data-action="rename"]',
        ),
      'Occasional management actions still crowd the toolbar.',
    );
    const moreTrigger = button('More actions for the selection')!;
    moreTrigger.focus();
    moreTrigger.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
    const keyboardMenu = await until(
      () =>
        document.querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-content"][data-open]',
        ) ?? undefined,
      'keyboard inspection menu',
    );
    assert(
      keyboardMenu.textContent?.includes('View samples') &&
        keyboardMenu.textContent?.includes('Export data…'),
      'Inspection and export actions are not discoverable.',
    );
    keyboardMenu.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(
      () =>
        !document.querySelector(
          '[data-slot="dropdown-menu-content"][data-open]',
        ),
      'close inspection menu with Escape',
    );
    const beforeDrag = selectedHistoryRow().title;
    const cancelledDrag = new DataTransfer();
    const torqueRow = signalRow('Torque')!;
    torqueRow.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: cancelledDrag,
      }),
    );
    await delay();
    assert(
      selectedHistoryRow().title === beforeDrag,
      'Starting a drag changed the inspected signal.',
    );
    assert(
      document
        .querySelector('[data-action="derive"]')
        ?.getAttribute('data-drop') === 'accept',
      'Accepting tools were not highlighted.',
    );
    assert(
      document
        .querySelector('[data-action="more"]')
        ?.getAttribute('data-drop') === 'accept',
      'Inspection menu did not advertise drop support.',
    );
    moreTrigger.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: cancelledDrag,
      }),
    );
    await until(
      () =>
        document.querySelector(
          '[data-slot="dropdown-menu-content"][data-open]',
        ),
      'inspection menu opens during a drag',
    );
    assert(
      document
        .querySelector('[data-action="back"]')
        ?.getAttribute('data-drop') === 'reject',
      'Navigation accepts an invalid input drop.',
    );
    torqueRow.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: cancelledDrag }),
    );
    await until(
      () =>
        !document.querySelector(
          '[data-slot="dropdown-menu-content"][data-open]',
        ),
      'cancelled drag closes its inspection menu',
    );
    await delay();
    assert(
      !document.querySelector('.workflow-action-toolbar [data-drop]'),
      'Cancelled drag left target highlights.',
    );
    await click('New plot');
    const destination = document.querySelector<HTMLElement>(
      '[aria-label="Plot tabs"] [aria-selected="true"]',
    )!;
    await click('New plot');
    await dragItem(signalRow('Torque')!, destination);
    await until(
      () => document.querySelectorAll('.scratchpad-trace').length === 1,
      'drop onto inactive named tab',
    );
    assert(
      document.querySelector(
        '[aria-label="Plot tabs"] [aria-selected="true"]',
      ) === destination,
      'Drop did not activate its destination tab.',
    );
    const raw = localStorage.getItem(PLOT_STORAGE_KEY);
    await dragItem(
      signalRow('Torque')!,
      document.querySelector<HTMLElement>('.scratchpad-canvas')!,
    );
    assert(
      localStorage.getItem(PLOT_STORAGE_KEY) === raw,
      'Repeated drops duplicated a trace.',
    );
    const invalid = new DataTransfer();
    invalid.setData(
      'application/x-stratum-workflow',
      JSON.stringify({ kind: 'output', id: 'foreign' }),
    );
    document.querySelector('[data-action="derive"]')!.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: invalid,
      }),
    );
    await delay();
    assert(
      !document.querySelector('[role="dialog"][data-open]'),
      'Unknown drag target opened an editor.',
    );
    await closePlot();
    document
      .querySelector<HTMLElement>('[aria-label="Plot tabs"] [title="Plot 2"]')!
      .click();
    await delay();
    await closePlot();
    // Return to the first original for the independent operation lifecycle checks.
    await click('Workspace');
    await click('Refresh this example', await dialog());
    await until(
      () => document.querySelector('[role="alertdialog"]'),
      'refresh confirmation',
    );
    await click('Keep current example');
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'cancel example refresh',
    );
    await click('Refresh this example', await dialog());
    await click('Refresh example');
    await settled();
    assert(
      document.querySelector('.workflow-inventory')?.textContent ===
        '2 original signals2 derived signals5 values',
      'Refreshing did not restore the complete example.',
    );
    await exampleSegments();
    await openOutput('Motor speed');
    await click('Derive signal');
    const mathModal = await dialog();
    // Derive opens on the last-used operation; the Math tab selects Add.
    await click('Math', mathModal);
    mathModal
      .querySelector<HTMLElement>(
        '[role="radio"][aria-label="Multiply signals"]',
      )!
      .click();
    await delay();
    // The previous category's panel unmounts after its exit transition.
    await until(
      () => mathModal.querySelectorAll('[role="radio"]').length === 9,
      'nine compact Math operation cards',
    );
    assert(
      !mathModal.textContent?.includes('Brake power') &&
        !mathModal.textContent?.includes('Specific fuel consumption'),
      'New operations still offer domain-specific calculations.',
    );
    assert(
      !button('Create 1 derived signal', mathModal),
      'Binary math must require Input B.',
    );
    await choose('Input B', '#001 Motor speed [rpm]');
    await click('Create 1 derived signal', mathModal);
    await settled();
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        'Motor speed × Motor speed',
      'The palette did not create the selected two-input operation.',
    );
    const mathOutput = selectedHistoryRow();
    mathOutput.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const doubleClickEdit = await dialog();
    assert(
      doubleClickEdit
        .querySelector('[aria-label="Input B"]')
        ?.textContent?.includes('Motor speed'),
      'Double-clicking an output did not open its saved operation.',
    );
    await click('Close', doubleClickEdit);
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close double-click editor',
    );
    const disclosure = document.querySelector<HTMLElement>(
      '.workflow-tree-row[data-kind="step"] .workflow-disclosure',
    )!;
    disclosure.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await delay();
    assert(
      !document.querySelector('[role="dialog"]'),
      'Double-clicking disclosure opened an editor.',
    );
    // A one-output step is a single History row; target it while another
    // signal stays selected.
    await openOutput('Motor speed');
    setValue(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search workflow"]',
      )!,
      'Motor speed × Motor speed',
    );
    const mathStep = await until(
      () => outputRow('Motor speed × Motor speed'),
      'single-output math step row',
    );
    assert(
      mathStep.dataset.merged === 'true' &&
        mathStep.getAttribute('aria-selected') === 'false',
      'Expected an unselected operation for context targeting.',
    );
    await contextAction(mathStep, 'Edit settings');
    const mathEdit = await dialog();
    assert(
      mathEdit
        .querySelector('[aria-label="Input B"]')
        ?.textContent?.includes('Motor speed'),
      'Editing lost the second operand.',
    );
    mathEdit
      .querySelector<HTMLElement>(
        '[role="radio"][aria-label="Subtract signals"]',
      )!
      .click();
    await delay();
    await click('Save changes and recalculate', mathEdit);
    await settled();
    setValue(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search workflow"]',
      )!,
      '',
    );
    await delay();
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        'Motor speed − Motor speed',
      'Changing the math operation did not update its output.',
    );
    await historyAction('Undo');
    await historyAction('Undo');
    await click('Derive signal');
    await click('Filters', await dialog());
    (await dialog())
      .querySelector<HTMLElement>(
        '[role="radio"][aria-label="Moving average"]',
      )!
      .click();
    await delay();
    await click('Create 1 derived signal', await dialog());
    await settled();
    assert(
      selectedHistoryRow()
        .getAttribute('aria-label')
        ?.includes('Derived signal'),
      'Derived output was not selected.',
    );
    const smoothedSpeed = document.querySelector(
      '.workflow-status-selection',
    )!.textContent!;
    // Segments are time intervals of the recording, found here by ranges
    // drawn on the plot of the viewed signal.
    const rangesRef = await segment('12, 51\n70, 109\n128, 167');
    await outputsTab();
    assert(
      document.querySelectorAll('.workflow-output-name').length === 3 &&
        [...document.querySelectorAll('.workflow-output-table th')].some(
          (cell) => cell.textContent === 'Segment',
        ) &&
        !document.querySelector('.workflow-output-table .workflow-check-cell'),
      'A Segment step must list three segments without input check boxes.',
    );
    assert(
      (await stepSummary(rangesRef)) === '3 segments',
      'History did not count the step’s segments.',
    );
    await until(
      () => plotBands().length === 3 && !selectedBand(),
      'segment bands over the recording',
    );
    await openFirstOutput();
    await checkSegmentSelection('Segment 01', 39);
    await exportFile({ scope: 'step' });
    // A segment is not a signal: dropping it on a plot adds no trace.
    const plotsBeforeDrop = localStorage.getItem(PLOT_STORAGE_KEY);
    await dragItem(
      selectedHistoryRow(),
      document.querySelector<HTMLElement>('.scratchpad-canvas')!,
    );
    await until(
      () =>
        document
          .querySelector('.workflow-notice')
          ?.textContent?.startsWith('This operation has no plottable outputs.'),
      'segment drop notice',
    );
    assert(
      localStorage.getItem(PLOT_STORAGE_KEY) === plotsBeforeDrop &&
        plotBands().length === 3,
      'Dropping a segment on a plot changed it.',
    );
    // Derive while viewing a segment works within that segment, for the
    // recording's signals.
    await openStepOutput(rangesRef, 1);
    await checkSegmentSelection('Segment 02', 39);
    await click('Derive signal');
    let withinModal = await dialog();
    assert(
      withinText(withinModal).includes(`${rangesRef} Time range segments`) &&
        withinAll(withinModal)?.box.getAttribute('aria-checked') === 'false' &&
        withinChosen(withinModal) === 'Segment 02',
      `Derive did not default Within to the viewed segment: ${withinState(withinModal)}.`,
    );
    await click('Create up to 2 derived signals', withinModal);
    await settled();
    const deriveOne = createdStep();
    assert(
      deriveOne.count === 2 &&
        [...document.querySelectorAll('.workflow-output-name')].every((item) =>
          item.textContent?.startsWith('Segment 02 · '),
        ),
      'Deriving within one segment must name one signal per input.',
    );
    await uncheckAll();
    // Segment again while viewing a segment: nested windows within it, in
    // seconds from the parent's start.
    await openStepOutput(rangesRef, 1);
    await click('Segment');
    withinModal = await dialog();
    assert(
      withinText(withinModal).includes(`${rangesRef} Time range segments`) &&
        withinChosen(withinModal) === 'Segment 02',
      `Segment did not nest within the viewed segment: ${withinState(withinModal)}.`,
    );
    await chooseCard('Windows');
    assert(
      !withinModal.querySelector('.segment-plot') &&
        withinModal.querySelector(
          'input[aria-label="From (after parent start)"]',
        ),
      'Nested windows must be relative to each parent.',
    );
    for (const [label, value] of [
      ['From (after parent start)', '0'],
      ['To (after parent start)', '20'],
      ['Window duration', '10'],
      ['Step between starts', '10'],
    ]) {
      setValue(
        withinModal.querySelector<HTMLInputElement>(
          `input[aria-label="${label}"]`,
        )!,
        value,
      );
      await delay();
    }
    await until(
      () =>
        withinModal
          .querySelector('.segment-preview strong')
          ?.textContent?.startsWith('2 segments · 0 clipped'),
      'nested window preview',
    );
    await click('Create segments', withinModal);
    await settled();
    const nestedRef = createdStep().ref;
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        'Nested window segments' && detail('Within') === 'Segment 02',
      'The nested Segment step lost its Within scope.',
    );
    await openFirstOutput();
    await checkSegmentSelection('Segment 02.01', 10);
    // Values within all segments: one per segment for each input.
    await openOutput(smoothedSpeed);
    await click('Calculate value');
    withinModal = await dialog();
    assert(
      withinText(withinModal) === 'Entire signal' &&
        button('Create 1 value', withinModal),
      `Values start on the entire signal: ${withinState(withinModal)}.`,
    );
    await choose('Within', `${rangesRef} Time range segments · 3 segments`);
    assert(
      withinAll(withinModal)?.text === 'All 3 segments' &&
        withinAll(withinModal)?.box.getAttribute('aria-checked') === 'true',
      `Choosing a Segment step must work within all of its segments: ${withinState(withinModal)}.`,
    );
    await click('Create up to 3 values', withinModal);
    await settled();
    const valuesAll = createdStep();
    // Values within segments show as a segment × input grid, or a list.
    const gridRows = () => [
      ...document.querySelectorAll<HTMLElement>(
        '.segment-value-table tbody tr',
      ),
    ];
    const segmentNames = ['Segment 01', 'Segment 02', 'Segment 03'];
    assert(
      valuesAll.count === 3 &&
        gridRows()
          .map((row) => row.querySelector('td')?.textContent)
          .join() === segmentNames.join() &&
        gridRows().every((row, i) =>
          row
            .querySelector<HTMLElement>('.workflow-output-name')
            ?.title.includes(segmentNames[i]),
        ),
      `Values within segments must be a grid by segment: ${gridRows()
        .map((row) => row.textContent)
        .join(' / ')}.`,
    );
    await click('List');
    assert(
      !document.querySelector('.segment-value-table') &&
        segmentNames.every((name) =>
          [...document.querySelectorAll('.workflow-output-name')].some((item) =>
            item.textContent?.includes(name),
          ),
        ),
      'Values within segments must name their segment.',
    );
    await click('By segment');
    await until(() => gridRows().length === 3, 'segment value grid');
    // A value within a segment links to it from Details.
    await openFirstOutput();
    (
      await until(
        () =>
          detailLink('Within')?.textContent === 'Segment 01' &&
          detailLink('Within'),
        'value Within link',
      )
    ).click();
    await until(
      () =>
        document
          .querySelector('.workflow-status-selection')
          ?.textContent?.startsWith('Segment 01 · '),
      'follow a value to its segment',
    );
    // Derived signals within chosen segments.
    await openOutput(smoothedSpeed);
    await click('Derive signal');
    withinModal = await dialog();
    await click('Math', withinModal);
    withinModal
      .querySelector<HTMLElement>('[role="radio"][aria-label="Scale signal"]')!
      .click();
    await delay();
    setValue(
      withinModal.querySelector<HTMLInputElement>(
        'input[aria-label="Scale factor"]',
      )!,
      '2',
    );
    await delay();
    await choose('Within', `${rangesRef} Time range segments · 3 segments`);
    withinAll(withinModal)!.box.click();
    await until(
      () => withinChoices(withinModal).length === 3,
      'per-segment check boxes',
    );
    withinChoices(withinModal)[2].box.click();
    await delay();
    assert(
      withinModal
        .querySelector('.within-segment-list summary')
        ?.textContent?.includes('2 segments chosen'),
      'Unchecking a segment did not update the chosen count.',
    );
    await click('Create up to 2 derived signals', withinModal);
    await settled();
    const deriveChosen = createdStep();
    assert(
      deriveChosen.count === 2 &&
        document.querySelectorAll('.workflow-output-name').length === 2,
      'Deriving within chosen segments created the wrong outputs.',
    );
    await openFirstOutput();
    assert(
      document
        .querySelector('.workflow-input-scope')
        ?.textContent?.includes('2 checked'),
      'Inspecting a member silently replaced the checked batch.',
    );
    // The member has no History row of its own; the toolbar inspects it.
    await menuAction('View samples');
    const contextSamples = await dialog();
    await until(
      () => contextSamples.querySelectorAll('tbody tr').length > 0,
      'context menu samples',
    );
    await click('Close', contextSamples);
    assert(
      document
        .querySelector('.workflow-input-scope')
        ?.textContent?.includes('2 checked'),
      'Context inspection changed checked processing inputs.',
    );
    await clickInputScope();
    const scopeModal = await dialog();
    assert(
      scopeModal.querySelectorAll('.workflow-input-review li').length === 2,
      'Input review does not match the toolbar count.',
    );
    await click('Follow selection', scopeModal);
    assert(
      document
        .querySelector('.workflow-input-scope')
        ?.getAttribute('data-checked') === 'false' &&
        document
          .querySelector('.workflow-input-scope')
          ?.textContent?.includes(
            (await memberRow())
              .querySelector('.workflow-output-name')!
              .getAttribute('title')!,
          ),
      'Follow selection did not return to the viewed member.',
    );
    // Explicitly empty input scope disables creation rather than falling back silently.
    await clickInputScope();
    const emptyScope = await dialog();
    emptyScope
      .querySelector<HTMLButtonElement>('[aria-label^="Remove "]')!
      .click();
    await delay();
    await click('Close', emptyScope);
    assert(
      document
        .querySelector('[data-action="derive"]')
        ?.getAttribute('aria-disabled') === 'true',
      'An empty scope silently enabled processing.',
    );
    await clickInputScope();
    await click('Follow selection', await dialog());
    assert(
      button('Derive signal'),
      'Empty input scope cannot return to the current selection.',
    );
    await checkOnlyMember();
    // A signal within a segment brings its siblings, to compare segments.
    await dragItem(await memberRow(), button('New plot')!);
    setValue(searchBox(), '');
    await until(
      () => document.querySelectorAll('.scratchpad-trace').length === 2,
      'both within-segment traces',
    );
    const zeroButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Align trace starts at zero"]',
    )!;
    assert(zeroButton, 'Elapsed-time control missing.');
    zeroButton.click();
    await until(
      () =>
        readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY)).at(-1)?.zeroTime,
      'saved elapsed-time alignment',
    );
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas [clip-path] path[d]')
          .length === 2,
      'complete segment overlay',
    );
    assert(
      [
        ...document.querySelectorAll('.scratchpad-canvas [clip-path] path[d]'),
      ].every((path) =>
        path
          .getAttribute('d')
          ?.startsWith(
            `M${Number(path.closest('svg')?.getAttribute('data-plot-left')).toFixed(2)},`,
          ),
      ),
      'Segments did not share the zero origin.',
    );
    await closePlot();
    // A processing tool receives this member, without adding its siblings.
    await dragItem(
      await memberRow(),
      document.querySelector<HTMLElement>('[data-action="value"]')!,
    );
    const memberModal = await dialog();
    assert(
      button('Create 1 value', memberModal),
      'Segment drop kept stale checked siblings.',
    );
    await click('Close', memberModal);
    await checkOnlyMember();
    await exportFile();
    await click('Calculate value');
    await click('Create 1 value', await dialog());
    await settled();
    assert(
      document.querySelector('.workflow-value-card strong')?.textContent &&
        !document
          .querySelector('.workflow-value-card strong')
          ?.textContent?.includes('Unavailable'),
      'Time average did not produce a scalar.',
    );
    await click('Derive signal');
    const scalarInputModal = await dialog();
    assert(
      scalarInputModal
        .querySelector('.workflow-drop-note')
        ?.textContent?.includes('input signal'),
      'Value processing did not explain its input signal.',
    );
    await click('Close', scalarInputModal);
    for (const action of ['derive', 'segment', 'value', 'align']) {
      await dragItem(
        selectedHistoryRow(),
        document.querySelector<HTMLElement>(`[data-action="${action}"]`)!,
      );
      const dropModal = await dialog();
      if (action === 'value') {
        // Values open Calculate from values, one click from their signals.
        assert(
          dropModal.querySelector('input[aria-label="Formula"]'),
          'Value drop onto value did not open Calculate from values.',
        );
        await click('Calculate from the input signals', dropModal);
        const signalModal = await until(
          () =>
            document
              .querySelector('[role="dialog"][data-open] .workflow-drop-note')
              ?.textContent?.includes('input signal')
              ? document.querySelector<HTMLElement>(
                  '[role="dialog"][data-open]',
                )!
              : undefined,
          'value statistics of the input signals',
        );
        await click('Close', signalModal);
        continue;
      }
      assert(
        dropModal
          .querySelector('.workflow-drop-note')
          ?.textContent?.includes('input signal'),
        `Value drop onto ${action} did not explain the input conversion.`,
      );
      await click('Close', dropModal);
    }
    await contextAction(selectedHistoryRow(), 'Create plot');
    await until(
      () =>
        document.querySelector(
          '.scratchpad-canvas path[stroke-dasharray="6 4"]',
        ),
      'scalar reference line',
    );
    assert(
      document
        .querySelector('.scratchpad-trace-name small')
        ?.textContent?.includes('Scalar value'),
      'Value plot used its parent in place of its value.',
    );
    await closePlot();
    await dragItem(
      selectedHistoryRow(),
      document.querySelector<HTMLElement>('[data-action="more"]')!,
    );
    await menuAction('View samples');
    const samplesModal = await dialog();
    await until(
      () => samplesModal.querySelectorAll('tbody tr').length > 0,
      'value input samples from toolbar',
    );
    assert(
      samplesModal.textContent?.includes('input to'),
      'Value sample source is ambiguous.',
    );
    await click('Close', samplesModal);
    await click('Show lineage in History');
    assert(
      document.querySelector('.workflow-filter'),
      'Lineage filter was not applied.',
    );
    await click('Inputs and original signals');
    const provenance = document.querySelector<HTMLButtonElement>(
      '.workflow-input-link button',
    );
    assert(provenance, 'A value has no direct input link.');
    provenance.click();
    await delay();
    assert(
      button('Segment'),
      'Following a scalar input did not return to a reusable signal.',
    );
    await outputsTab();
    await click('New version…');
    const repeatModal = await dialog();
    // New version restores the saved scope: chosen segments of the step.
    assert(
      withinText(repeatModal).includes(`${rangesRef} Time range segments`) &&
        withinAll(repeatModal)?.box.getAttribute('aria-checked') === 'false' &&
        withinChosen(repeatModal) === 'Segment 01,Segment 02' &&
        repeatModal.querySelector<HTMLInputElement>(
          'input[aria-label="Scale factor"]',
        )?.value === '2',
      `New version did not restore the saved segments and settings: ${withinState(repeatModal)}.`,
    );
    (
      repeatModal.querySelector<HTMLButtonElement>(
        '[data-slot="dialog-close"]',
      ) ??
      repeatModal.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    )?.click();
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close repeat dialog',
    );
    // Value while viewing a Segment step works within all of its segments.
    await uncheckAll();
    (await stepRow(rangesRef)).click();
    await delay();
    setValue(searchBox(), '');
    await delay();
    await click('Calculate value');
    withinModal = await dialog();
    assert(
      withinText(withinModal).includes(`${rangesRef} Time range segments`) &&
        withinAll(withinModal)?.box.getAttribute('aria-checked') === 'true' &&
        button('Create up to 6 values', withinModal),
      `Value did not default Within to the viewed Segment step: ${withinState(withinModal)}.`,
    );
    await click('Close', withinModal);
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close Segment step value editor',
    );
    // Editing the Segment step to find fewer segments recalculates every
    // step within them; outputs of removed segments go with them.
    await contextAction(await stepRow(rangesRef), 'Edit settings');
    const segmentEdit = await dialog();
    assert(
      // The two later steps within it (Scale and its value) are counted.
      [deriveOne.ref, nestedRef, valuesAll.ref, 'and 2 more steps'].every(
        (text) => segmentEdit.textContent?.includes(text),
      ),
      `Segment edit omitted dependent steps: ${segmentEdit.querySelector('[data-slot="dialog-description"]')?.textContent}`,
    );
    setValue(
      segmentEdit.querySelector<HTMLTextAreaElement>(
        '[aria-label="Time range pairs"]',
      )!,
      '12, 51\n70, 109',
    );
    await until(
      () =>
        segmentEdit
          .querySelector('.segment-preview strong')
          ?.textContent?.startsWith('2 segments · 0 clipped'),
      'edited segment preview',
    );
    await click('Save changes and recalculate', segmentEdit);
    await settled();
    setValue(searchBox(), '');
    async function counts() {
      return [
        await stepSummary(rangesRef),
        await stepSummary(valuesAll.ref),
        await stepSummary(deriveOne.ref),
        await stepSummary(deriveChosen.ref),
        await stepSummary(nestedRef),
      ].join(', ');
    }
    const edited =
      'v2 · 2 segments, v2 · 2 values, v2 · 2 signals, v2 · 2 signals, v2 · 2 segments';
    assert(
      (await counts()) === edited,
      `Editing segments did not recalculate the steps within them: ${await counts()}.`,
    );
    await historyAction('Undo');
    assert(
      (await counts()) ===
        '3 segments, 3 values, 2 signals, 2 signals, 2 segments',
      `Undo did not restore the three segments: ${await counts()}.`,
    );
    await historyAction('Redo');
    assert(
      (await counts()) === edited,
      `Redo did not reapply the edit: ${await counts()}.`,
    );
    // Deleting a Segment step deletes every step that works within it.
    await contextAction(await stepRow(rangesRef), 'Delete step');
    const segmentImpact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'segment delete impact',
    );
    await click('Delete 6 steps', segmentImpact);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'segment delete committed',
    );
    for (const ref of [rangesRef, nestedRef, valuesAll.ref, deriveChosen.ref]) {
      setValue(searchBox(), ref);
      await delay();
      assert(
        !document.querySelector('.workflow-tree-row[data-kind="step"]'),
        `Deleting the Segment step kept ${ref}.`,
      );
    }
    setValue(searchBox(), '');
    await historyAction('Undo');
    assert(
      (await counts()) === edited,
      `Undo did not restore the deleted steps: ${await counts()}.`,
    );
    // Triggers find segments where a signal crosses its thresholds.
    await openOutput('Motor speed');
    await uncheckAll();
    await click('Segment');
    withinModal = await dialog();
    await chooseCard('Triggers');
    for (const [label, value] of [
      ['Start threshold', '1000'],
      ['End threshold', '1000'],
      ['Start offset', '0'],
      ['End offset', '0'],
    ]) {
      setValue(
        withinModal.querySelector<HTMLInputElement>(
          `input[aria-label="${label}"]`,
        )!,
        value,
      );
      await delay();
    }
    await until(
      () =>
        withinModal
          .querySelector('.segment-preview strong')
          ?.textContent?.startsWith('3 segments · 0 clipped'),
      'trigger segment preview',
    );
    await click('Create segments', withinModal);
    await settled();
    const triggers = createdStep();
    assert(
      triggers.count === 3 &&
        document.querySelector('.workflow-status-selection')?.textContent ===
          'Trigger segments',
      'Trigger segments were not created.',
    );
    await openFirstOutput();
    await checkSegmentSelection('Segment 01');
    assert(
      detail('Crossings') &&
        document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
          .length === 1,
      'A trigger segment must show its crossings over its trigger signal.',
    );
    await outputsTab();
    await click('New version…');
    const triggerRepeat = await dialog();
    assert(
      triggerRepeat
        .querySelector('[role="radio"][aria-label="Triggers"]')
        ?.getAttribute('aria-checked') === 'true' &&
        triggerRepeat.querySelector<HTMLInputElement>(
          'input[aria-label="Start threshold"]',
        )?.value === '1000' &&
        withinText(triggerRepeat) === 'Entire recording' &&
        button('Create segments', triggerRepeat),
      'New version did not restore the saved triggers.',
    );
    triggerRepeat
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click();
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close trigger repeat dialog',
    );
    // Exercise a large batch through the UI; a single operation owns every
    // member. Exact ranges stay paged in the dialog.
    await openOutput('Motor speed');
    const manyRef = await segment(
      Array.from({ length: 40 }, () => '15, 16').join('\n'),
    );
    await outputsTab();
    assert(
      document.querySelectorAll('.workflow-output-name').length === 30 &&
        !document.querySelector('.workflow-output-table .workflow-check-cell'),
      'Segment outputs are not bounded to one page.',
    );
    await openOutput('Motor speed');
    await click('Derive signal');
    withinModal = await dialog();
    await choose('Within', `${manyRef} Time range segments · 40 segments`);
    assert(
      withinAll(withinModal)?.text === 'All 40 segments',
      'Within did not offer all 40 segments.',
    );
    await click('Create up to 40 derived signals', withinModal);
    await settled();
    assert(
      createdStep().count === 40,
      'Deriving within 40 segments lost members.',
    );
    assert(
      document
        .querySelector('.workflow-input-scope')
        ?.textContent?.includes('40 checked'),
      'Batch processing selection lost members.',
    );
    assert(
      document.querySelectorAll('.workflow-output-name').length === 30,
      'Output table is not bounded to one page.',
    );
    await contextAction(selectedHistoryRow(), 'Create plot');
    await until(
      () =>
        readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY)).at(-1)?.traces
          .length === 40,
      'complete large plot batch',
    );
    assert(
      document
        .querySelector('.workflow-input-scope')
        ?.textContent?.includes('40 checked'),
      'Create plot changed checked processing inputs.',
    );
    await until(
      () => document.querySelector('.scratchpad-canvas svg'),
      'large overlay',
    );
    assert(
      document.querySelectorAll('.scratchpad-trace').length === 30,
      'Trace controls are not paged.',
    );
    assert(
      document.querySelectorAll('.scratchpad-canvas [clip-path] path').length <=
        8,
      'Large overlays flood the SVG with per-signal elements.',
    );
    await click('Stacked');
    await until(
      () => document.querySelectorAll('.scratchpad-stack svg').length === 8,
      'bounded stacked plots',
    );
    await click('Next plots');
    assert(
      document
        .querySelector('[aria-label="Stacked plot pages"]')
        ?.textContent?.includes('9–16 of 40'),
      'Stacked comparison pages cannot be reached.',
    );
    // A step within segments is one History row; its members are chosen on
    // the plot or in the Outputs table.
    const derivedRow = selectedHistoryRow();
    assert(
      derivedRow.getAttribute('data-kind') === 'step' &&
        derivedRow.querySelector('small')?.textContent === '40 signals' &&
        !derivedRow.hasAttribute('aria-expanded'),
      'A step within segments must be one History row.',
    );
    await closePlot();
    await outputsTab();
    await click('Calculate value');
    const valueModal = await dialog();
    // Values open on the last-used calculation; Level holds the averages
    // and extremes as directly selectable cards.
    await click('Level', valueModal);
    await until(
      () => valueModal.querySelectorAll('[role="radio"]').length === 7,
      'seven Level value cards',
    );
    valueModal
      .querySelector<HTMLElement>(
        '[role="radio"][aria-label="Sample average"]',
      )!
      .click();
    await delay();
    assert(
      valueModal
        .querySelector('.signal-operation-settings')
        ?.textContent?.includes('Each sample has equal weight'),
      'Sample-average card did not update the explanation.',
    );
    valueModal
      .querySelector<HTMLElement>('[role="radio"][aria-label="Maximum"]')!
      .click();
    await delay();
    await click('Create 40 values', valueModal);
    await settled();
    // Values of signals that are each within one segment (no Within on the
    // step) open as a list, which pages every member.
    await until(
      () =>
        document.querySelectorAll('.workflow-output-name').length === 30 ||
        undefined,
      'value list',
    );
    assert(
      !document.querySelector('.segment-value-table'),
      'Only steps within segments open as a grid by segment.',
    );
    assert(
      document.querySelectorAll('.workflow-output-name').length === 30,
      'Value batch membership was lost.',
    );
    const next = document.querySelector<HTMLButtonElement>(
      '.workflow-main button[aria-label="Next outputs"]',
    );
    assert(next && !next.disabled, 'Large output batch cannot be paged.');
    next.click();
    await delay();
    assert(
      document.querySelectorAll('.workflow-output-name').length === 10,
      'Second output page is incorrect.',
    );
    await openFirstOutput();
    // A member of a step within segments is shown by its step's one row.
    assert(
      document
        .querySelector('.workflow-properties .workflow-kind')
        ?.textContent?.includes('Value') &&
        selectedHistoryRow().getAttribute('data-kind') === 'step',
      'A late batch member cannot be selected.',
    );
    await exportFile();
    await exportFile({ scope: 'step' });
    await exportFile({ report: true });
    await click('Show lineage in History');
    assert(
      !document
        .querySelector('.workflow-filter')
        ?.textContent?.includes('undefined'),
      'Invalid lineage state.',
    );
    // Every contributing operation is reachable with the tree keyboard controls.
    const tree = document.querySelector<HTMLElement>('[role="tree"]');
    assert(tree, 'History tree is missing.');
    const selected = tree.querySelector<HTMLElement>('[aria-selected="true"]');
    assert(selected, 'Selected late output is buried outside the tree.');
    selected.focus();
    selected.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    await until(
      () => document.activeElement?.getAttribute('data-row') === '0',
      'tree Home key',
    );
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await until(
      () => document.activeElement?.getAttribute('data-row') !== '0',
      'tree End key',
    );
    await click('Show all steps');
    await click('Collapse all');
    assert(
      document.querySelectorAll('[role="treeitem"][aria-level="2"]').length <=
        5,
      'Collapse all did not collapse unrelated output lists.',
    );
    assert(
      document.querySelector('[role="treeitem"][aria-selected="true"]'),
      'Collapse all buried the selected output.',
    );
    await click('Expand all');
    await click('Signals');
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search workflow"]',
    );
    assert(search, 'History search missing.');
    setValue(search, 'Motor speed');
    await delay();
    assert(
      outputRow('Motor speed') &&
        !document.querySelector('.workflow-tree-row[data-step-kind="value"]'),
      'The Signals filter must find signals and hide value steps.',
    );
    outputRow('Motor speed')!.click();
    await delay();
    assert(
      document
        .querySelector('.workflow-properties')
        ?.textContent?.includes('Original signal'),
      'Original signal was lost after downstream processing.',
    );
    await click('All');
    setValue(search, '');
    await delay();
    // Everyday management must work through the actual dialogs and worker.
    await click('Derive signal');
    await click('Math', await dialog());
    (await dialog())
      .querySelector<HTMLElement>('[role="radio"][aria-label="Scale signal"]')!
      .click();
    await delay();
    let managementModal = await dialog();
    setValue(
      managementModal.querySelector<HTMLInputElement>(
        'input[aria-label="Scale factor"]',
      )!,
      '2',
    );
    await delay();
    await click('Create 1 derived signal', managementModal);
    await settled();
    // A one-output step's single row names its signal.
    await contextAction(selectedHistoryRow(), 'Rename signal', true);
    managementModal = await dialog();
    setValue(
      managementModal.querySelector<HTMLInputElement>(
        'input[aria-label="Display name"]',
      )!,
      'Reviewed speed',
    );
    await delay();
    await click('Save name', managementModal);
    await settled();
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        'Reviewed speed',
      'Rename lost the selected output.',
    );
    await click('Calculate value');
    // Value remembers the last calculation; this check uses a time average.
    const averageModal = await dialog();
    await click('Level', averageModal);
    (
      await until(
        () =>
          averageModal.querySelector<HTMLElement>(
            '[role="radio"][aria-label="Time average"]',
          ) ?? undefined,
        'time average card',
      )
    ).click();
    await delay();
    await click('Create 1 value', averageModal);
    await settled();
    const initialValue = Number.parseFloat(
      document
        .querySelector('.workflow-value-card strong')
        ?.textContent?.replaceAll(',', '') ?? 'NaN',
    );
    await click('Inputs and original signals');
    document
      .querySelector<HTMLButtonElement>('.workflow-input-link button')!
      .click();
    await delay();
    selectedHistoryRow().dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    managementModal = await dialog();
    assert(
      // Exactly one dependent step (the value) is named in the impact.
      /Saving recalculates #\d+ (?:(?! and ).)+\. Original signals/.test(
        managementModal.textContent ?? '',
      ),
      'Edit omitted downstream impact.',
    );
    setValue(
      managementModal.querySelector<HTMLInputElement>(
        'input[aria-label="Scale factor"]',
      )!,
      '3',
    );
    await delay();
    await click('Save changes and recalculate', managementModal);
    await settled();
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        'Reviewed speed',
      'Editing lost the output alias.',
    );
    await contextAction(selectedHistoryRow(), 'Delete step');
    let impact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'delete impact',
    );
    assert(
      impact.textContent?.includes('2 steps'),
      'Delete failed to include the dependent value.',
    );
    await click('Cancel', impact);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'cancel deletion',
    );
    await contextAction(selectedHistoryRow(), 'Delete step', true);
    impact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'delete impact again',
    );
    await click('Delete 2 steps', impact);
    await until(
      () =>
        !document.querySelector('[role="alertdialog"]') &&
        document.querySelector('.workflow-status-selection')?.textContent !==
          'Reviewed speed',
      'delete committed',
    );
    async function historyAction(label: string) {
      label += ' last change';
      (
        await until(
          () =>
            document.querySelector<HTMLButtonElement>(
              `button[aria-label="${label}"]:not(:disabled)`,
            ) ?? undefined,
          label,
        )
      ).click();
      await delay();
      await until(
        () =>
          document
            .querySelector('.workflow-notice')
            ?.textContent?.startsWith(
              label.startsWith('Undo') ? 'Undid' : 'Redid',
            ),
        `${label} settled`,
      );
    }
    await historyAction('Undo');
    setValue(search, 'Reviewed speed');
    await until(
      () => outputRow('Reviewed speed'),
      'undo restores named signal',
    );
    await historyAction('Redo');
    setValue(search, 'Reviewed speed');
    await delay();
    assert(
      !outputRow('Reviewed speed'),
      'Redo did not remove the restored signal.',
    );
    await historyAction('Undo');
    setValue(search, 'Reviewed speed');
    await delay();
    await until(
      () => outputRow('Reviewed speed'),
      'second undo restores signal',
    );
    // The filtered tree finds the dependent scalar wherever it was created.
    const lastValue = [
      ...document.querySelectorAll<HTMLElement>(
        '.workflow-tree-row[data-kind="output"]',
      ),
    ].find((item) => item.textContent?.includes('Time average'));
    assert(lastValue, 'Dependent value is missing after Undo.');
    lastValue.click();
    await until(
      () => document.querySelector('.workflow-value-card strong') ?? undefined,
      'restored value',
    );
    const revisedValue = Number.parseFloat(
      document
        .querySelector('.workflow-value-card strong')
        ?.textContent?.replaceAll(',', '') ?? 'NaN',
    );
    assert(
      Number.isFinite(initialValue) &&
        Math.abs(revisedValue / initialValue - 1.5) < 0.002,
      `Editing did not refresh the dependent value in the UI: ${initialValue} → ${revisedValue}, ${document.querySelector('.workflow-status-selection')?.textContent}.`,
    );
    await click('Workspace');
    managementModal = await dialog();
    await click('Save workspace backup…', managementModal);
    await until(
      () =>
        managementModal
          .querySelector('output')
          ?.textContent?.includes('Backup saved to'),
      'workspace backup',
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File(['invalid archive'], 'invalid.stratus'));
    const backupInput = managementModal.querySelector<HTMLInputElement>(
      'input[aria-label="Workspace backup file"]',
    )!;
    backupInput.files = transfer.files;
    backupInput.dispatchEvent(new Event('change', { bubbles: true }));
    impact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'restore confirmation',
    );
    await click('Restore and replace', impact);
    await until(
      () => impact.querySelector('[role="alert"]')?.textContent,
      'invalid archive error remains visible',
    );
    await click('Keep current workspace', impact);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'keep workspace',
    );
    managementModal
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click();
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close workspace',
    );
    assert(
      Number.parseFloat(
        document
          .querySelector('.workflow-value-card strong')
          ?.textContent?.replaceAll(',', '') ?? 'NaN',
      ) === revisedValue,
      'Invalid restore changed the visible workspace.',
    );
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')
      ?.click();
    await delay();
    await openOutput('Motor speed');
    // Leave a representative view for the optional native screenshot.
    await click('Segment');
    const lastModal = await dialog();
    const close = lastModal.querySelector<HTMLButtonElement>(
      '[data-slot="dialog-close"]',
    );
    close?.click();
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'close final dialog',
    );
    // An ordinary large step lists a preview in History, with its full
    // membership one link away: a recording with 40 channels.
    const wideFile = new DataTransfer();
    wideFile.items.add(
      new File(
        [
          [
            ['t', ...Array.from({ length: 40 }, (_, k) => `wide-${k + 1} [V]`)],
            ...[0, 1, 2].map((t) => [
              t,
              ...Array.from({ length: 40 }, () => t),
            ]),
          ]
            .map((row) => row.join(','))
            .join('\n'),
        ],
        'Wide.csv',
      ),
    );
    const wideImport = document.querySelector<HTMLInputElement>(
      'input[aria-label="Import recordings"]',
    )!;
    wideImport.files = wideFile.files;
    wideImport.dispatchEvent(new Event('change', { bubbles: true }));
    await confirmImport();
    await until(
      () =>
        [...document.querySelectorAll<HTMLElement>('[data-kind="more"]')].some(
          (row) => row.title === 'View all 40 outputs',
        ),
      'wide recording imported',
    );
    await settled();
    const wideTree = document.querySelector<HTMLElement>('[role="tree"]')!;
    // Full membership of an ordinary large step stays in the sidebar and
    // preserves the current inspection.
    const allOutputs = () =>
      [...wideTree.querySelectorAll<HTMLElement>('[data-kind="more"]')].at(-1);
    const moreOutputs = await until(allOutputs, 'full output tree link');
    assert(
      moreOutputs.title === 'View all 40 outputs',
      'The large operation must offer its complete membership.',
    );
    const previousScroll = wideTree.scrollTop;
    const previousRows = wideTree.textContent;
    const previousSelection = document.querySelector(
      '.workflow-status-selection',
    )?.textContent;
    const previousInputs = document.querySelector(
      '.workflow-input-scope',
    )?.textContent;
    moreOutputs.click();
    await delay();
    assert(
      wideTree.getAttribute('aria-label') === 'Step outputs' &&
        wideTree.querySelectorAll('[data-kind="step"]').length === 1 &&
        !allOutputs(),
      'View all must show only the operation and its full output tree.',
    );
    assert(
      document.querySelector('.workflow-status-selection')?.textContent ===
        previousSelection &&
        document.querySelector('.workflow-input-scope')?.textContent ===
          previousInputs,
      'Opening the output tree changed the inspection, plot or processing inputs.',
    );
    await click('Back to history');
    assert(
      wideTree.textContent === previousRows &&
        Math.abs(wideTree.scrollTop - previousScroll) < 1 &&
        document.activeElement === allOutputs(),
      'Returning lost the history rows, scroll position or keyboard focus.',
    );
    allOutputs()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await delay();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await until(
      () => document.activeElement?.getAttribute('aria-posinset') === '40',
      'last member in the full output tree',
    );
    assert(
      document.activeElement?.getAttribute('aria-setsize') === '40' &&
        wideTree.querySelectorAll('[data-kind="output"]').length < 40,
      'The focused tree must expose every member while keeping mounted rows bounded.',
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await delay();
    assert(
      wideTree.getAttribute('aria-label') === 'Step outputs' &&
        document.activeElement?.getAttribute('aria-selected') === 'true',
      'Selecting a late member must keep the focused output tree open.',
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await delay();
    assert(
      !button('Back to history') && document.activeElement === allOutputs(),
      'Escape must return keyboard focus to the history link.',
    );

    // Cross-file processing through the real worker and dialogs.
    const timeFiles = new DataTransfer();
    timeFiles.items.add(
      new File(['t,time-a [V]\n10,0\n11,2\n12,4'], 'Time A.csv'),
    );
    timeFiles.items.add(
      new File(['t,time-b [V]\n100,1\n100.5,2\n101,3\n102,5'], 'Time B.csv'),
    );
    const timeImport = document.querySelector<HTMLInputElement>(
      'input[aria-label="Import recordings"]',
    )!;
    timeImport.files = timeFiles.files;
    timeImport.dispatchEvent(new Event('change', { bubbles: true }));
    await confirmImport();
    await confirmImport();
    await until(
      () =>
        document.body.textContent?.includes('time-a') &&
        document.body.textContent?.includes('time-b'),
      'both time sources imported',
    );
    await click('Compare & align');
    const picker = (await dialog()).querySelector<HTMLDetailsElement>(
      '.time-picker',
    )!;
    if (!picker.open) picker.querySelector('summary')!.click();
    setValue(
      (await dialog()).querySelector<HTMLInputElement>(
        'input[aria-label="Find comparison signals"]',
      )!,
      'time-',
    );
    await delay();
    await click('Select matching signals', await dialog());
    // Compare & align opens on Align.
    await createTimeResult();
    await settled();
    await click('Compare & align');
    await until(
      () => document.querySelector('.time-dialog .signal-chart svg'),
      'cross-file overlay',
    );
    await chooseCard('Same sample times');
    setValue(
      (await dialog()).querySelector<HTMLInputElement>(
        'input[aria-label="Output rate"]',
      )!,
      '2',
    );
    await delay();
    await createTimeResult();
    await settled();
    await click('Compare & align');
    await chooseCard('Calculate A and B');
    await createTimeResult();
    await settled();
    await click('Calculate value');
    await click('Create 1 value', await dialog());
    await settled();
    assert(
      Math.abs(
        Number.parseFloat(
          document.querySelector('.workflow-value-card strong')?.textContent ??
            'NaN',
        ),
      ) === 1,
      'Cross-file difference did not produce the expected constant value.',
    );
    await openOutput('Motor speed');
    // A queued request may resolve normally even after cancellation. The UI
    // must suppress delivery independently of the worker cancellation flag.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(
      createElement(WorkflowList<number>, {
        items: Array.from({ length: 5000 }, (_, i) => i),
        summary: 'Large lineage test',
        // oxlint-disable-next-line react/no-children-prop -- This .ts harness invokes the component's render prop without JSX.
        children: (items) =>
          createElement(
            'ol',
            null,
            items.map((item) =>
              createElement('li', { key: item }, `Step ${item + 1}`),
            ),
          ),
      }),
    );
    await until(
      () => host.querySelector('summary') ?? undefined,
      'large list fixture',
    );
    assert(!host.querySelector('li'), 'Closed lineage rendered hidden rows.');
    host.querySelector('summary')!.click();
    await until(
      () => host.querySelectorAll('li').length === 30,
      'bounded open lineage',
    );
    await click('Next', host);
    assert(
      host.querySelector('li')?.textContent === 'Step 31',
      'Lineage paging lost members.',
    );
    const exportProject: Project = {
      sources: [],
      segments: [],
      nodes: [
        {
          id: 'cancel-input',
          sourceId: 'test-source',
          name: 'Queued export',
          unit: 'V',
          parents: [],
          operation: 'raw',
          parameters: {},
          createdAt: '2026-09-10T00:00:00Z',
          version: 1,
          color: '#61d9b0',
        },
      ],
    };
    let resolveExport: ((response: EngineResponse) => void) | undefined;
    let savedCancelledExport = false,
      cancelledExport = false;
    root.render(
      createElement(WorkflowExport, {
        open: true,
        onOpenChange: () => {},
        project: exportProject,
        viewedId: 'cancel-input',
        checkedIds: [],
        request: () =>
          new Promise<EngineResponse>((resolve) => {
            resolveExport = resolve;
          }),
        cancel: () => {
          cancelledExport = true;
        },
        onSaved: () => {
          savedCancelledExport = true;
        },
      }),
    );
    await click('Save file…', await dialog());
    // On the desktop the request follows the native Save dialog; cancel only
    // once it is queued, which is the case this check covers.
    await until(() => resolveExport, 'queued export request');
    await click('Cancel export', await dialog());
    assert(
      resolveExport && cancelledExport,
      'Export cancellation did not reach the pending request.',
    );
    resolveExport({
      type: 'export',
      requestId: 1,
      blob: new Blob(['should not download']),
    });
    await until(
      () =>
        document
          .querySelector('[role="dialog"] [role="alert"]')
          ?.textContent?.includes('Export cancelled'),
      'cancelled export result',
    );
    assert(
      !savedCancelledExport,
      'A cancelled queued export still downloaded.',
    );
    root.unmount();
    host.remove();
    console.info(
      'STRATUM_SMOKE_OK: Workflow UI passed the compact labeled toolbar, keyboard inspection menu, checked-input review, context actions, signal/value drag-and-drop (segments add no plot traces), zero-time alignment, complete paged comparisons, toolbar input selection, segments found by drawn ranges, windows and triggers with History, Details and plot bands, nested segments, derived signals and values within all, one or chosen segments, Segment edits that recalculate the steps within them, Segment deletion with its dependants, editing with dependent recalculation, deletion confirmation, Undo/Redo, rename, backup, invalid restore recovery, scalar values, 40-segment and 40-member batches, pagination, lineage and keyboard navigation.',
    );
  } catch (error) {
    console.error(
      `STRATUM_SMOKE_FAILED: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}
