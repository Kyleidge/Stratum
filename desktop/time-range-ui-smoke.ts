/** Exercise the real range picker before the workflow suite commits its first segments. */
export async function timeRangeUiSmoke(
  modal: HTMLElement,
  finalRanges: string,
) {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 35));
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(`Time range picker: ${message}`);
  };
  async function ready() {
    for (let i = 0; i < 300; i++) {
      if (modal.querySelector('.range-selection-surface')) return;
      await delay();
    }
    throw new Error('Time range picker plot did not load.');
  }
  const svg = () =>
    modal.querySelector<SVGSVGElement>('.range-plot-canvas .signal-chart svg')!;
  const surface = () =>
    modal.querySelector<SVGGElement>('.range-selection-surface')!;
  const pairs = () =>
    modal.querySelector<HTMLTextAreaElement>(
      '[aria-label="Time range pairs"]',
    )!;
  const values = () =>
    pairs()
      .value.split('\n')
      .filter(Boolean)
      .map((line) => line.split(',').map(Number));
  const bounds = () => [
    Number(svg().dataset.rangeStart),
    Number(svg().dataset.rangeEnd),
  ];
  async function click(label: string) {
    const control = [
      ...modal.querySelectorAll<HTMLButtonElement>('button'),
    ].find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute('aria-label') === label,
    );
    assert(control && !control.disabled, `Missing enabled ${label}`);
    control!.click();
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
  async function pointer(
    kind: string,
    value: number,
    target: Element = surface(),
  ) {
    const chart = svg(),
      rect = chart.getBoundingClientRect();
    const [start, end] = bounds();
    const left = Number(chart.dataset.plotLeft),
      right = Number(chart.dataset.plotRight);
    target.dispatchEvent(
      new PointerEvent(kind, {
        bubbles: true,
        cancelable: true,
        pointerId: 11,
        button: 0,
        clientX:
          rect.left +
          ((left + ((value - start) / (end - start)) * (right - left)) /
            chart.viewBox.baseVal.width) *
            rect.width,
        clientY: rect.top + rect.height * 0.5,
      }),
    );
    await delay();
  }
  async function drag(start: number, end: number, target?: Element) {
    await pointer('pointerdown', start, target);
    await pointer('pointermove', end);
    await pointer('pointerup', end);
  }
  function close(actual: number, expected: number) {
    assert(
      Math.abs(actual - expected) < 1e-7,
      `Expected ${expected}, received ${actual}`,
    );
  }
  await ready();
  const [start, end] = bounds(),
    width = end - start;
  const t = (fraction: number) => start + width * fraction;
  assert(
    !pairs().value,
    'New segments should start with no unrequested ranges.',
  );
  await drag(t(0.1), t(0.25));
  await drag(t(0.6), t(0.45));
  await drag(t(0.2), t(0.4));
  assert(
    values().length === 3,
    'Repeated drags must create three independent ranges, including overlaps.',
  );
  close(values()[1][0], t(0.45));
  close(values()[1][1], t(0.6));
  await click('Select range 1');
  await drag(
    t(0.175),
    t(0.225),
    modal.querySelector('[data-range-index="0"] .range-fill')!,
  );
  close(values()[0][0], t(0.15));
  close(values()[0][1], t(0.3));
  await drag(
    t(0.3),
    t(0.35),
    modal.querySelector('[data-range-index="0"] [data-range-edge="end"]')!,
  );
  await drag(
    t(0.15),
    t(0.12),
    modal.querySelector('[data-range-index="0"] [data-range-edge="start"]')!,
  );
  close(values()[0][0], t(0.12));
  close(values()[0][1], t(0.35));
  const saved = pairs().value;
  await pointer(
    'pointerdown',
    t(0.2),
    modal.querySelector('[data-range-index="0"] .range-fill')!,
  );
  await pointer('pointermove', t(0.3));
  surface().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
  await delay();
  await pointer('pointerup', t(0.3));
  assert(
    pairs().value === saved && modal.isConnected,
    'Escape must abandon the drag without dismissing the editor.',
  );
  surface().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    }),
  );
  await delay();
  close(values()[0][0], t(0.121));
  await click('Draw ranges');
  await pointer('pointerdown', t(0.7));
  await pointer('pointermove', t(0.9));
  await pointer('pointercancel', t(0.9));
  assert(
    values().length === 3,
    'Pointer cancellation must not save a partial range.',
  );
  await drag(t(0.8), t(0.8));
  assert(values().length === 3, 'A click must not create an empty range.');
  await click('Select range 2');
  await click('Zoom to range');
  await ready();
  assert(
    bounds()[1] - bounds()[0] < width / 2,
    'Zoom should narrow the plotted viewport.',
  );
  assert(
    pairs().value.split('\n').length === 3,
    'Zoom must preserve all ranges.',
  );
  await click('Fit');
  await ready();
  close(bounds()[0], start);
  close(bounds()[1], end);
  const precise = String(t(0.121) + 0.123456789);
  setValue(
    modal.querySelector<HTMLInputElement>('[aria-label="Range 1 start"]')!,
    precise,
  );
  await delay();
  assert(
    pairs().value.startsWith(precise),
    'Exact input times must retain their precision.',
  );
  const endInput = modal.querySelector<HTMLInputElement>(
    '[aria-label="Range 1 end"]',
  )!;
  setValue(endInput, precise);
  await delay();
  assert(
    [...modal.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Preview',
    )?.disabled,
    'Zero-length ranges must be rejected before preview.',
  );
  setValue(endInput, String(t(0.35)));
  await delay();
  await click('Remove range 2');
  assert(values().length === 2, 'Removing a range must retain its siblings.');
  setValue(pairs(), '');
  await delay();
  await click('Draw ranges');
  for (const line of finalRanges.split('\n')) {
    const [a, b] = line.split(',').map(Number);
    await drag(a, b);
  }
  assert(
    values().length === finalRanges.split('\n').length,
    'The final drawn ranges must be ready to commit.',
  );
}
