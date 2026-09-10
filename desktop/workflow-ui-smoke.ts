/** End-to-end checks against the actual native renderer and its worker. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowExport from '../components/workflow-export';
import type { EngineResponse, Project } from '../lib/signal-types';

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
      `Timed out: ${label}. ${document.querySelector('[role="alert"]')?.textContent ?? ''}`,
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
      () => document.querySelector<HTMLElement>('[role="dialog"]') ?? undefined,
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
  async function segment(ranges: string) {
    await click('Segment');
    const modal = await dialog();
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
    const tab = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((element) => element.textContent?.startsWith('Step outputs'));
    if (!tab) throw new Error('Output collection tab missing.');
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
  try {
    await until(() => button('Derive signal'), 'initial signal');
    assert(
      document
        .querySelector('.workflow-heading-top')
        ?.textContent?.includes('Original signal'),
      'Startup must expose an original signal.',
    );
    await click('Derive signal');
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
      document.querySelector('h1')?.textContent?.includes('15–20 s'),
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
    const chooser = valueModal.querySelector<HTMLButtonElement>(
      'button[aria-label="Value calculation"]',
    );
    assert(chooser, 'Value chooser missing.');
    chooser.click();
    await delay();
    (
      await until(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
            (option) => option.textContent?.trim() === 'Maximum',
          ),
        'maximum choice',
      )
    ).click();
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
    await exportFile({ scope: 'All outputs from #007 · 40 outputs' });
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
    setValue(search, 'Engine speed');
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
    // A queued request may resolve normally even after cancellation. The UI
    // must suppress delivery independently of the worker cancellation flag.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
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
      'STRATUS_SMOKE_OK: Workflow UI passed derivation, nested segmentation, scalar values, 40-member batches, pagination, lineage, keyboard navigation and original-signal recovery.',
    );
  } catch (error) {
    console.error(
      `STRATUS_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
