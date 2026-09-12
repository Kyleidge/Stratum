/** Interaction checks run inside the native workflow suite's saved comparison. */
import { PLOT_STORAGE_KEY, readPlotSheets } from '../lib/plot-scratchpad';

export async function plotUiSmoke() {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 45));
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  async function until(read: () => boolean, label: string) {
    for (let i = 0; i < 200; i++) {
      if (read()) return;
      await delay();
    }
    throw new Error(`Plot check timed out: ${label}`);
  }
  async function click(name: string) {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find(
      (item) =>
        !item.disabled &&
        (item.getAttribute('aria-label') === name ||
          item.textContent?.trim() === name),
    );
    assert(button, `Missing plot control: ${name}`);
    button!.click();
    await delay();
  }
  function setValue(element: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const chart = () =>
    document.querySelector<SVGSVGElement>(
      '.scratchpad-canvas .signal-chart svg',
    )!;
  const window = () => [
    Number(chart().dataset.rangeStart),
    Number(chart().dataset.rangeEnd),
  ];
  async function pointer(type: string, fraction: number) {
    const svg = chart(),
      rect = svg.getBoundingClientRect();
    const width = svg.viewBox.baseVal.width;
    svg.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 3,
        button: 0,
        clientX:
          rect.left + ((70 + (width - 98) * fraction) * rect.width) / width,
        clientY: rect.top + rect.height / 2,
      }),
    );
    await delay();
  }
  const fit = window();
  assert(
    ![...document.querySelectorAll('[role="tab"]')].some((tab) =>
      tab.textContent?.includes('Step outputs'),
    ),
    'Step outputs remains a separate tab.',
  );
  await click('Box zoom mode');
  await pointer('pointerdown', 0.25);
  await pointer('pointermove', 0.75);
  await pointer('pointerup', 0.75);
  assert(
    Math.abs((window()[1] - window()[0]) / (fit[1] - fit[0]) - 0.5) < 0.01,
    'Box zoom did not select the dragged interval.',
  );
  await click('Pan mode');
  const before = window();
  await pointer('pointerdown', 0.5);
  await pointer('pointermove', 0.3);
  await pointer('pointerup', 0.3);
  assert(window()[0] > before[0], 'Drag pan did not move the time window.');
  await click('Previous plot view');
  assert(
    Math.abs(window()[0] - before[0]) < 1e-6,
    'Previous view lost the pan origin.',
  );
  const cancelled = window();
  await pointer('pointerdown', 0.5);
  await pointer('pointermove', 0.7);
  chart().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
  await delay();
  await pointer('pointerup', 0.7);
  assert(window()[0] === cancelled[0], 'Escape committed a cancelled pan.');
  chart().focus();
  const rect = chart().getBoundingClientRect();
  chart().dispatchEvent(
    new WheelEvent('wheel', {
      deltaY: -120,
      clientX: rect.left + rect.width / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
  await delay();
  assert(
    window()[1] - window()[0] < cancelled[1] - cancelled[0],
    'Focused wheel zoom did not zoom.',
  );
  chart().dispatchEvent(
    new MouseEvent('dblclick', {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }),
  );
  await delay();
  assert(
    window()[0] === fit[0] && window()[1] === fit[1],
    'Double-click did not fit.',
  );
  await click('Toggle measurement cursors');
  const input = (label: string) =>
    document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  setValue(input('Cursor A time'), '12');
  await delay();
  setValue(input('Cursor B time'), '20');
  await delay();
  await until(
    () =>
      document.querySelector('.plot-measurements output')?.textContent ===
      '2 traces',
    'exact cursor measurements',
  );
  assert(
    document.querySelectorAll('.plot-measurement-table tbody tr').length === 2,
    'Measurement rows are missing.',
  );
  assert(
    !document
      .querySelector('.plot-measurement-table tbody')
      ?.textContent?.includes('…'),
    'Measurement values are still pending.',
  );
  await pointer('pointerdown', 0.2);
  await pointer('pointermove', 0.23);
  await pointer('pointerup', 0.23);
  assert(
    Number(input('Cursor B time').value) > 20,
    'Dragging the nearest cursor did not change B.',
  );
  await click('Toggle measurement cursors');
  await click('Plot axes and limits');
  const axes = [
    ...document.querySelectorAll<HTMLInputElement>('.plot-limit-grid input'),
  ];
  setValue(axes[0], '10');
  await delay();
  setValue(axes[1], '30');
  await delay();
  setValue(axes[2], '100');
  await delay();
  setValue(axes[3], '10');
  await delay();
  await click('Apply axes');
  assert(
    document.querySelector('[role="dialog"] [role="alert"]'),
    'Invalid Y limits were accepted.',
  );
  setValue(axes[2], '0');
  await delay();
  setValue(axes[3], '7000');
  await delay();
  await click('Apply axes');
  assert(
    Math.abs(window()[0] - 10) < 1e-6 && Math.abs(window()[1] - 30) < 1e-6,
    'Explicit time limits were ignored.',
  );
  await click('Fit entire plot');
  await click('Plot axes and limits');
  const logLimits = [
    ...document.querySelectorAll<HTMLInputElement>('.plot-limit-grid input'),
  ];
  setValue(logLimits[2], '1');
  await delay();
  setValue(logLimits[3], '7000');
  await delay();
  document.querySelector<HTMLInputElement>('.plot-checkbox input')!.click();
  await delay();
  await click('Apply axes');
  assert(
    chart().textContent?.includes('Log Y'),
    'Logarithmic scaling did not activate.',
  );
  const axisRect = chart().getBoundingClientRect();
  chart().dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      clientX: axisRect.left + 5,
      clientY: axisRect.top + axisRect.height / 2,
    }),
  );
  await delay();
  assert(
    document.querySelector('[role="dialog"]'),
    'Double-clicking an axis did not open limits.',
  );
  document.querySelector<HTMLInputElement>('.plot-checkbox input')!.click();
  await delay();
  const autoLimits = [
    ...document.querySelectorAll<HTMLInputElement>('.plot-limit-grid input'),
  ];
  setValue(autoLimits[2], '');
  await delay();
  setValue(autoLimits[3], '');
  await delay();
  await click('Apply axes');
  await click('Fit entire plot');
  await click('Add plot annotation');
  setValue(input('Annotation time'), '25');
  await delay();
  setValue(input('Annotation text'), 'Review marker <safe>');
  await delay();
  await click('Save annotation');
  assert(
    chart()
      .querySelector('.plot-annotation')
      ?.textContent?.includes('Review marker'),
    'Annotation marker is missing.',
  );
  await click('Export plot SVG');
  await click('Export plot PNG');
  await until(
    () =>
      !document.querySelector<HTMLButtonElement>(
        '[aria-label="Export plot PNG"]',
      )?.disabled,
    'PNG delivery',
  );
  const stored = () => readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY));
  const original = stored()[0];
  await click('Move trace down Motor speed');
  assert(
    stored()[0].traces[1].id === original.traces[0].id,
    'Keyboard trace reordering failed.',
  );
  // Real drag payload and drop path, distinct from workflow signal imports.
  const rows = [...document.querySelectorAll<HTMLElement>('.scratchpad-trace')];
  const transfer = new DataTransfer();
  rows[1].dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }),
  );
  assert(
    transfer.types.includes('application/x-stratus-plot-trace'),
    'Trace reorder payload is absent.',
  );
  rows[0].dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }),
  );
  await delay();
  assert(
    stored()[0].traces[0].id === original.traces[0].id,
    'Trace drag did not restore the order.',
  );
  await click('Duplicate plot');
  assert(
    stored().length === 2 &&
      stored()[1].annotations?.[0].text === 'Review marker <safe>',
    'Duplicate did not preserve annotations.',
  );
  await click('Move plot tab left');
  assert(stored()[0].id !== original.id, 'Tab move failed.');
  await click('Move plot tab right');
  const tabs = [
    ...document.querySelectorAll<HTMLElement>(
      '[aria-label="Plot tabs"] [role="tab"]',
    ),
  ].slice(1);
  const tabTransfer = new DataTransfer();
  tabs[1].dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, dataTransfer: tabTransfer }),
  );
  tabs[0].dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: tabTransfer,
    }),
  );
  await delay();
  assert(
    stored()[0].id !== original.id,
    'Dragging a plot tab did not reorder it.',
  );
  await click('Move plot tab right');
  await click(`Close plot ${stored()[1].name}`);
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent?.includes('Motor comparison'),
  )!;
  tab.click();
  await delay();
  assert(stored().length === 1, 'Closing a duplicate affected the original.');
  await click('Fit entire plot');
}
