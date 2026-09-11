/** End-to-end checks against the actual native renderer and its worker. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowExport from '../components/workflow-export';
import WorkflowList from '../components/workflow-list';
import type { EngineResponse, Project } from '../lib/signal-types';
import { PLOT_STORAGE_KEY, readPlotSheets } from '../lib/plot-scratchpad';

export async function workflowUiSmoke() {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
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
      `Timed out: ${label}. ${document.querySelector('[role="alert"]')?.textContent ?? ''} Controls: ${[...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((item) => `${item.getAttribute('aria-label')}:${item.disabled}`).join(', ')}. Status: ${document.querySelector('.workflow-status')?.textContent}. Screen: ${document.body.innerText.slice(0, 1500)}`,
    );
  }
  const button = (text: string, root: Document | HTMLElement = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === text && !button.disabled,
    );
  async function click(text: string, root: Document | HTMLElement = document) {
    (await until(() => button(text, root), `button ${text}`)).click();
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
  async function segment(ranges: string) {
    await click('Segment');
    const modal = await dialog();
    if (!checkedSegmentMethods) {
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
      await click('Preview', modal);
      await until(
        () =>
          modal
            .querySelector('.segment-preview strong')
            ?.textContent?.startsWith('2 signal segments'),
        'window card preview',
      );
      modal
        .querySelector<HTMLElement>('[role="radio"][aria-label="Triggers"]')!
        .click();
      await delay();
      assert(
        !modal.querySelector('.segment-preview strong'),
        'Switching methods kept a stale preview.',
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
      await click('Preview', modal);
      await until(
        () =>
          modal
            .querySelector('.segment-preview strong')
            ?.textContent?.startsWith('3 signal segments'),
        'trigger card preview',
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
    }
    const textarea = modal.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Manual ranges were not the default.');
    setValue(textarea, ranges);
    await delay();
    await click('Preview', modal);
    await until(
      () => modal.querySelector('.segment-preview strong') ?? undefined,
      'segment preview',
    );
    await click('Create signal segments', modal);
    await settled();
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
          (element) => element.textContent?.trim().includes('Step outputs'),
        ),
      'Step outputs tab',
    );
    tab.click();
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
  async function exportFile(options?: { scope?: string; report?: boolean }) {
    await click('Export / report');
    if (options?.scope) await choose('Include', options.scope);
    if (options?.report) await choose('File format', 'Printable report (HTML)');
    await click('Download file', await dialog());
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'download prepared',
    );
    await delay();
  }
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  function selectedHistoryRow() {
    const row = document.querySelector<HTMLElement>(
      '.workflow-tree-row[aria-selected="true"]',
    );
    assert(row, 'Selected history item is missing.');
    return row;
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
    await delay();
  }
  try {
    await until(
      () => button('Open example workflow') || button('Derive signal'),
      'workspace startup',
    );
    if (button('Open example workflow')) await click('Open example workflow');
    await until(() => button('Derive signal'), 'initial signal');
    await until(
      () => document.querySelector('.scratchpad-canvas .signal-chart svg'),
      'active plot',
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
    (await until(() => signalRow('Torque'), 'torque row')).click();
    await delay();
    assert(
      plotTab()?.textContent?.includes('Motor speed'),
      'Inspecting another signal replaced a saved plot.',
    );
    await click('Add to this plot');
    await until(
      () => document.querySelectorAll('.scratchpad-stack svg').length === 2,
      'separate axes for mixed units',
    );
    assert(
      button('Overlay') === undefined,
      'Mixed units were allowed on one value axis.',
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
        document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
          .length === 1,
      'hidden trace',
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Show trace Torque"]')!
      .click();
    await until(
      () =>
        document.querySelectorAll('.scratchpad-canvas .signal-chart svg')
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
      document.querySelector('.scratchpad-plot-title strong')?.textContent ===
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
        .querySelector('.workflow-heading-top')
        ?.textContent?.includes('Original signal'),
      'Startup must expose an original signal.',
    );
    assert(
      !document.body.innerText.includes('Saved region ranges'),
      'The new example contains legacy-only ranges.',
    );
    const exampleGuide =
      document.querySelector<HTMLDetailsElement>('.workflow-example')!;
    exampleGuide.querySelector('summary')!.click();
    await delay();
    await click('Compare run averages');
    assert(
      document.querySelectorAll('.workflow-output-name').length === 3,
      'Example should expose three run averages.',
    );
    await click('Explore a segmented segment');
    assert(
      document.querySelectorAll('.workflow-output-name').length === 2,
      'Nested segmentation should expose two signals.',
    );
    await click('Plot derived signal');
    await until(
      () =>
        document.querySelector('.workflow-detail-heading h1')?.textContent ===
        'Torque × speed',
      'example product',
    );
    exampleGuide.querySelector('summary')!.click();
    await delay();
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
        '2 originals7 derived5 values',
      'Refreshing did not restore the complete example.',
    );
    await click('Signals & values');
    document
      .querySelector<HTMLButtonElement>('.workflow-catalog-item')!
      .click();
    await delay();
    await click('History tree');
    await click('Derive signal');
    const mathModal = await dialog();
    assert(
      mathModal.querySelectorAll('[role="radio"]').length === 7,
      'Math should show seven compact operation cards.',
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
      document.querySelector('.workflow-detail-heading h1')?.textContent ===
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
    const mathStep = [
      ...document.querySelectorAll<HTMLElement>(
        '.workflow-tree-row[data-kind="step"]',
      ),
    ].at(-1)!;
    assert(
      mathStep.getAttribute('aria-selected') === 'false',
      'Expected an unselected operation for context targeting.',
    );
    const disclosure = mathStep.querySelector('button')!;
    disclosure.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await delay();
    assert(
      !document.querySelector('[role="dialog"]'),
      'Double-clicking disclosure opened an editor.',
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
    assert(
      document.querySelector('.workflow-detail-heading h1')?.textContent ===
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
      document
        .querySelector('.workflow-heading-top')
        ?.textContent?.includes('Derived signal'),
      'Derived output was not selected.',
    );
    await segment('12, 51\n70, 109\n128, 167');
    assert(
      document.querySelectorAll('.workflow-output-name').length === 3,
      'A segment batch did not expose three individual signals.',
    );
    await openFirstOutput();
    assert(
      document.querySelector('.workflow-next strong')?.textContent ===
        '3 signals checked',
      'Inspecting a member silently replaced the checked batch.',
    );
    await click('Use only this signal');
    await segment('15, 20');
    assert(
      document
        .querySelector('.workflow-detail-heading h1')
        ?.textContent?.includes('15–20 s'),
      'Nested segment interval was not exposed.',
    );
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
    assert(
      !button('Derive signal') && !button('Segment'),
      'Scalar values were offered as signal inputs.',
    );
    await click('Show lineage in tree');
    assert(
      document.querySelector('.workflow-filter'),
      'Lineage filter was not applied.',
    );
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
    await click('Repeat with new settings');
    const repeatModal = await dialog();
    assert(
      repeatModal.querySelector('textarea')?.value.includes('15, 20'),
      'Repeat did not restore exact saved ranges.',
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
    // Exercise a large batch through the UI; a single operation owns every member.
    await segment(Array.from({ length: 40 }, () => '15, 16').join('\n'));
    assert(
      document.querySelector('.workflow-next strong')?.textContent ===
        '40 signals checked',
      'Batch processing selection lost members.',
    );
    assert(
      document.querySelectorAll('.workflow-output-name').length === 30,
      'Output table is not bounded to one page.',
    );
    await click('Calculate value');
    const valueModal = await dialog();
    assert(
      valueModal.querySelectorAll('[role="radio"]').length === 4,
      'Value calculations should be directly selectable cards.',
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
    assert(
      document
        .querySelector('.workflow-heading-top')
        ?.textContent?.includes('Value'),
      'A late batch member cannot be selected.',
    );
    await exportFile();
    await exportFile({ scope: 'All outputs from #013 · 40 outputs' });
    await exportFile({ report: true });
    await click('Show lineage in tree');
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
    await click('Compact history');
    assert(
      document.querySelectorAll('[role="treeitem"][aria-level="2"]').length <=
        5,
      'Compact history did not collapse unrelated output lists.',
    );
    assert(
      document.querySelector('[role="treeitem"][aria-selected="true"]'),
      'Compact history buried the selected output.',
    );
    await click('Show outputs');
    await click('Signals & values');
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search workflow"]',
    );
    assert(search, 'Signal index search missing.');
    setValue(search, 'Motor speed');
    await delay();
    assert(
      document.querySelector('.workflow-catalog-item'),
      'Signals are not findable outside history.',
    );
    document
      .querySelector<HTMLButtonElement>('.workflow-catalog-item')!
      .click();
    await delay();
    assert(
      document
        .querySelector('.workflow-heading-top')
        ?.textContent?.includes('Original signal'),
      'Original signal was lost after downstream processing.',
    );
    await click('History tree');
    // Everyday management must work through the actual dialogs and worker.
    await click('Derive signal');
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
    await contextAction(selectedHistoryRow(), 'Rename output', true);
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
      document.querySelector('.workflow-detail-heading h1')?.textContent ===
        'Reviewed speed',
      'Rename lost the selected output.',
    );
    await click('Calculate value');
    await click('Create 1 value', await dialog());
    await settled();
    const initialValue = Number.parseFloat(
      document
        .querySelector('.workflow-value-card strong')
        ?.textContent?.replaceAll(',', '') ?? 'NaN',
    );
    document
      .querySelector<HTMLButtonElement>('.workflow-input-link button')!
      .click();
    await delay();
    selectedHistoryRow().dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    managementModal = await dialog();
    assert(
      managementModal.textContent?.includes('1 dependent operation'),
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
      document.querySelector('.workflow-detail-heading h1')?.textContent ===
        'Reviewed speed',
      'Editing lost the output alias.',
    );
    await contextAction(selectedHistoryRow(), 'Delete operation');
    let impact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'delete impact',
    );
    assert(
      impact.textContent?.includes('2 operations'),
      'Delete failed to include the dependent value.',
    );
    await click('Keep operation', impact);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'cancel deletion',
    );
    await click('Delete operation');
    impact = await until(
      () =>
        document.querySelector<HTMLElement>('[role="alertdialog"]') ??
        undefined,
      'delete impact again',
    );
    await click('Delete listed operations', impact);
    await until(
      () =>
        !document.querySelector('[role="alertdialog"]') &&
        document.querySelector('.workflow-detail-heading h1')?.textContent !==
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
            ?.textContent?.includes(
              label.startsWith('Undo')
                ? 'Undid last change'
                : 'Redid last change',
            ),
        `${label} settled`,
      );
    }
    await historyAction('Undo');
    await click('Signals & values');
    setValue(search, 'Reviewed speed');
    await until(
      () => document.querySelector('.workflow-catalog-item') ?? undefined,
      'undo restores named signal',
    );
    await historyAction('Redo');
    setValue(search, 'Reviewed speed');
    await delay();
    assert(
      !document.querySelector('.workflow-catalog-item'),
      'Redo did not remove the restored signal.',
    );
    await historyAction('Undo');
    setValue(search, 'Reviewed speed');
    await delay();
    await until(
      () => document.querySelector('.workflow-catalog-item') ?? undefined,
      'second undo restores signal',
    );
    // The flat index finds the dependent scalar outside the virtualized tree viewport.
    const lastValue = [
      ...document.querySelectorAll<HTMLElement>('.workflow-catalog-item'),
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
      `Editing did not refresh the dependent value in the UI: ${initialValue} → ${revisedValue}, ${document.querySelector('.workflow-detail-heading h1')?.textContent}.`,
    );
    await click('Workspace');
    managementModal = await dialog();
    await click('Download workspace backup', managementModal);
    await until(
      () =>
        managementModal
          .querySelector('output')
          ?.textContent?.includes('Backup download prepared'),
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
    await click('Signals & values');
    setValue(search, 'Motor speed');
    await delay();
    document
      .querySelector<HTMLButtonElement>('.workflow-catalog-item')!
      .click();
    await delay();
    await click('History tree');
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
    // Cross-file processing through the real worker and dialogs.
    const timeFiles = new DataTransfer();
    timeFiles.items.add(
      new File(['t,time-a [V]\n10,0\n11,2\n12,4'], 'Time A.csv'),
    );
    timeFiles.items.add(
      new File(['t,time-b [V]\n100,1\n100.5,2\n101,3\n102,5'], 'Time B.csv'),
    );
    const timeImport = document.querySelector<HTMLInputElement>(
      'input[aria-label="Import CSV recording"]',
    )!;
    timeImport.files = timeFiles.files;
    timeImport.dispatchEvent(new Event('change', { bubbles: true }));
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
    await choose('Time operation', 'Align time bases');
    await click('Create derived signals', await dialog());
    await settled();
    await click('Compare & align');
    await until(
      () => document.querySelector('.time-dialog .signal-chart svg'),
      'cross-file overlay',
    );
    await choose('Time operation', 'Resample to a shared grid');
    setValue(
      (await dialog()).querySelector<HTMLInputElement>(
        'input[aria-label="Output rate"]',
      )!,
      '2',
    );
    await delay();
    await click('Create derived signals', await dialog());
    await settled();
    await click('Compare & align');
    await choose('Time operation', 'Calculate between signals');
    await click('Create derived signals', await dialog());
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
    await click('Signals & values');
    setValue(search, 'Motor speed');
    await delay();
    document
      .querySelector<HTMLButtonElement>('.workflow-catalog-item')!
      .click();
    await delay();
    await click('History tree');
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
    await click('Download file', await dialog());
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
      'STRATUS_SMOKE_OK: Workflow UI passed editing with dependent recalculation, deletion confirmation, Undo/Redo, rename, backup, invalid restore recovery, nested segmentation, scalar values, 40-member batches, pagination, lineage and keyboard navigation.',
    );
  } catch (error) {
    console.error(
      `STRATUS_SMOKE_FAILED: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}
