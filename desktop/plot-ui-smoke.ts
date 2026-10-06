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
        !item.closest('[data-closed]') &&
        (item.getAttribute('aria-label') === name ||
          item.textContent?.trim() === name),
    );
    assert(button, `Missing plot control: ${name}`);
    button!.click();
    await delay();
  }
  async function choose(label: string, value: string) {
    await click(label);
    await until(
      () => !!document.querySelector('.plot-select-popup [role="option"]'),
      'themed select options',
    );
    const popup = document.querySelector('.plot-select-popup')!;
    assert(
      getComputedStyle(popup).colorScheme === 'dark' &&
        getComputedStyle(popup).backgroundColor !== 'rgb(255, 255, 255)',
      'Plot selector is not using the dark popup theme.',
    );
    const option = [
      ...document.querySelectorAll<HTMLElement>(
        '.plot-select-popup [role="option"]',
      ),
    ].find((item) => item.dataset.plotOption === value);
    assert(option, `Missing compatible choice ${value}`);
    option!.click();
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
          rect.left +
          ((Number(svg.dataset.plotLeft) +
            (Number(svg.dataset.plotRight) - Number(svg.dataset.plotLeft)) *
              fraction) *
            rect.width) /
            width,
        clientY: rect.top + rect.height / 2,
      }),
    );
    await delay();
  }
  const fit = window();
  const axis = (unit: string) =>
    chart().querySelector<SVGGElement>(`[data-value-axis="unit:${unit}"]`)!;
  const limits = (unit: string) => [
    Number(axis(unit).dataset.axisMin),
    Number(axis(unit).dataset.axisMax),
  ];
  const same = (a: number[], b: number[]) =>
    a.every((value, i) => Math.abs(value - b[i]) < 1e-8);
  assert(
    chart().textContent?.includes('Motor speed (rpm)') &&
      chart().textContent?.includes('Torque (Nm)') &&
      chart().textContent?.includes('Time (s)'),
    'Automatic signal and time axis names are absent.',
  );
  async function wheelAt(unit: string, deltaY = -120) {
    const target =
      unit === 'time' ? chart().querySelector('[data-time-axis]')! : axis(unit);
    const area = target.getBoundingClientRect();
    target.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        clientX: area.left + area.width / 2,
        clientY: area.top + area.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
    await delay();
  }
  const holdY = () =>
    document.querySelector<HTMLButtonElement>(
      '[aria-label="Hold Y-axis scales"]',
    )!;
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'initial Y scales',
  );
  const heldSpeed = limits('rpm'),
    heldTorque = limits('Nm');
  await click('Hold Y-axis scales');
  assert(
    holdY().getAttribute('aria-pressed') === 'true' &&
      same(limits('rpm'), heldSpeed) &&
      same(limits('Nm'), heldTorque),
    'Holding Y changed the displayed limits or failed to activate.',
  );
  assert(
    readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY))[0].axes?.heldY,
    'Held Y scales were not saved.',
  );
  await click('Box zoom mode');
  await pointer('pointerdown', 0.1);
  await pointer('pointermove', 0.2);
  await pointer('pointerup', 0.2);
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'held zoom data',
  );
  await wheelAt('time');
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'held wheel data',
  );
  await click('Pan mode');
  await pointer('pointerdown', 0.5);
  await pointer('pointermove', 0.3);
  await pointer('pointerup', 0.3);
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'held pan data',
  );
  assert(
    same(limits('rpm'), heldSpeed) && same(limits('Nm'), heldTorque),
    'Time navigation changed held Y scales after detailed data arrived.',
  );
  await click('Stacked');
  assert(
    document.querySelectorAll('.scratchpad-canvas .signal-chart svg').length ===
      2 && same(limits('rpm'), heldSpeed),
    'Stacked panels lost their held Y scales.',
  );
  await click('Overlay');
  assert(
    document.querySelectorAll('.scratchpad-lane .signal-chart svg').length ===
      2 && same(limits('rpm'), heldSpeed),
    'Unit lanes lost their held Y scales.',
  );
  await click('Y axes');
  await click('Hold Y-axis scales');
  assert(
    holdY().getAttribute('aria-pressed') === 'false' &&
      !same(limits('rpm'), heldSpeed),
    'Releasing Hold Y did not resume autoscaling.',
  );
  await click('Previous plot view');
  assert(
    holdY().getAttribute('aria-pressed') === 'true' &&
      same(limits('rpm'), heldSpeed),
    'Previous view lost held Y limits.',
  );
  await click('Fit entire plot');
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'fit after holding Y',
  );
  assert(
    holdY().getAttribute('aria-pressed') === 'false',
    'Fit did not release held Y scales.',
  );
  const speedLimits = limits('rpm'),
    torqueLimits = limits('Nm');
  async function axisDrag(unit: string, cancel = false) {
    const target =
      unit === 'time' ? chart().querySelector('[data-time-axis]')! : axis(unit);
    const area = target.getBoundingClientRect(),
      svgRect = chart().getBoundingClientRect();
    const startX = area.left + area.width / 2,
      startY = area.top + area.height / 2;
    const x = startX + (unit === 'time' ? svgRect.width * 0.12 : 0),
      y = startY + (unit === 'time' ? 0 : svgRect.height * 0.12);
    for (const [type, clientX, clientY] of [
      ['pointerdown', startX, startY],
      ['pointermove', x, y],
    ] as const) {
      chart().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 8,
          button: 0,
          clientX,
          clientY,
        }),
      );
      await delay();
    }
    if (cancel) {
      chart().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await delay();
    }
    chart().dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 8,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
    await delay();
  }
  await axisDrag('Nm', true);
  assert(
    same(limits('Nm'), torqueLimits) && same(window(), fit),
    'Cancelling an axis drag changed the view.',
  );
  await axisDrag('Nm');
  assert(
    !same(limits('Nm'), torqueLimits) &&
      same(limits('rpm'), speedLimits) &&
      same(window(), fit),
    'Right-axis dragging did not pan independently.',
  );
  assert(
    Math.abs(
      limits('Nm')[1] - limits('Nm')[0] - (torqueLimits[1] - torqueLimits[0]),
    ) < 1e-8,
    'Axis panning changed scale.',
  );
  await click('Previous plot view');
  await axisDrag('rpm');
  assert(
    !same(limits('rpm'), speedLimits) && same(limits('Nm'), torqueLimits),
    'Left-axis drag affected the other axis.',
  );
  await click('Previous plot view');
  await axisDrag('time');
  assert(
    window()[0] < fit[0] &&
      Math.abs(window()[1] - window()[0] - (fit[1] - fit[0])) < 1e-8,
    'Time-axis pan did not move the full view.',
  );
  await click('Fit entire plot');
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'full-view samples after axis drag',
  );
  chart().blur();
  await wheelAt('Nm');
  assert(
    same(window(), fit) && same(limits('rpm'), speedLimits),
    'Right-axis scrolling changed time or the other unit.',
  );
  assert(
    limits('Nm')[1] - limits('Nm')[0] < torqueLimits[1] - torqueLimits[0],
    'Right-axis scrolling did not zoom torque.',
  );
  assert(
    readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY))[0].axes?.values?.[
      'unit:Nm'
    ].y,
    'Axis zoom was not persisted.',
  );
  await click('Previous plot view');
  assert(
    same(limits('Nm'), torqueLimits),
    'Previous view did not restore the Y scale.',
  );
  await wheelAt('rpm');
  assert(
    same(limits('Nm'), torqueLimits) &&
      same(window(), fit) &&
      !same(limits('rpm'), speedLimits),
    'Left-axis scrolling did not zoom independently.',
  );
  await click('Previous plot view');
  await wheelAt('time');
  assert(
    window()[1] - window()[0] < fit[1] - fit[0],
    'Time-axis scrolling did not zoom time.',
  );
  await click('Fit entire plot');
  // Double-click the right-hand axis to edit that unit, including its auto name.
  const rightAxis = axis('Nm').getBoundingClientRect();
  axis('Nm').dispatchEvent(
    new MouseEvent('dblclick', {
      clientX: rightAxis.left + rightAxis.width / 2,
      clientY: rightAxis.top + rightAxis.height / 2,
      bubbles: true,
    }),
  );
  await delay();
  assert(
    document.querySelector<HTMLElement>('[aria-label="Y axis"]')?.dataset
      .plotSelected === 'unit:Nm',
    'Right-axis double-click edited the wrong unit.',
  );
  setValue(
    document.querySelector<HTMLInputElement>('[aria-label="Y axis name"]')!,
    'Shaft torque (Nm)',
  );
  await delay();
  await click('Apply axes');
  assert(
    chart().textContent?.includes('Shaft torque (Nm)'),
    'Custom Y axis name was not displayed.',
  );
  await click('Plot axes and limits');
  setValue(
    document.querySelector<HTMLInputElement>('[aria-label="Time axis name"]')!,
    'Test time (s)',
  );
  await delay();
  await choose('Y axis', 'unit:Nm');
  setValue(
    document.querySelector<HTMLInputElement>('[aria-label="Y axis name"]')!,
    '',
  );
  await delay();
  await click('Apply axes');
  assert(
    chart().textContent?.includes('Torque (Nm)'),
    'Clearing the axis name did not restore automatic naming.',
  );
  assert(
    chart().textContent?.includes('Test time (s)'),
    'Switching Y axes discarded the pending time name.',
  );
  await click('Plot axes and limits');
  setValue(
    document.querySelector<HTMLInputElement>('[aria-label="Time axis name"]')!,
    '',
  );
  await delay();
  await click('Apply axes');
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
  await until(
    () => !document.querySelector('.scratchpad-axis-footer output'),
    'zoomed detail before live pan',
  );
  const before = window();
  const savedBeforePan = localStorage.getItem(PLOT_STORAGE_KEY);
  await pointer('pointerdown', 0.5);
  // Hold the gesture open: both edges must have curves before pointer release,
  // including across several live data refreshes.
  for (let i = 0; i < 8; i++) {
    await pointer('pointermove', 0.3 - i * 0.02);
    const paths = [
      ...chart().querySelectorAll<SVGPathElement>('g[clip-path] path'),
    ];
    assert(paths.length >= 2, 'Live pan lost comparison traces.');
    assert(
      paths.every((path) => {
        const bounds = path.getBBox();
        return (
          bounds.x <= Number(chart().dataset.plotLeft) + 1 &&
          bounds.x + bounds.width >= Number(chart().dataset.plotRight) - 1
        );
      }),
      'Panning left a newly exposed part of the curve blank.',
    );
    assert(
      localStorage.getItem(PLOT_STORAGE_KEY) === savedBeforePan,
      'Transient pan persisted intermediate views.',
    );
  }
  await pointer('pointerup', 0.16);
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
  const beforeAnnotation = window();
  const annotationX =
    Number(chart().dataset.plotLeft) +
    (Number(chart().dataset.plotRight) - Number(chart().dataset.plotLeft)) *
      0.4;
  chart().dispatchEvent(
    new MouseEvent('dblclick', {
      clientX:
        rect.left + (annotationX / chart().viewBox.baseVal.width) * rect.width,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }),
  );
  await delay();
  assert(
    same(window(), beforeAnnotation) &&
      Math.abs(
        Number(
          document.querySelector<HTMLInputElement>(
            '[aria-label="Annotation time"]',
          )?.value,
        ) -
          (beforeAnnotation[0] +
            (beforeAnnotation[1] - beforeAnnotation[0]) * 0.4),
      ) <
        (beforeAnnotation[1] - beforeAnnotation[0]) /
          (Number(chart().dataset.plotRight) -
            Number(chart().dataset.plotLeft)),
    'Double-click did not open an annotation at the pointer time (within one screen pixel).',
  );
  document
    .querySelector('[aria-label="Annotation time"]')!
    .closest('[role="dialog"]')!
    .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
    .click();
  await delay();
  chart().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
  );
  await delay();
  assert(same(window(), fit), 'Home did not fit the plot.');
  await click('Toggle measurement cursors');
  const input = (label: string) =>
    document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  setValue(input('Cursor A time'), '12.03');
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
  assert(
    document
      .querySelector('.plot-measurement-table thead')
      ?.textContent?.includes('A / time') &&
      document.querySelector('.plot-measurement-table tbody td small')
        ?.textContent === '12.030000 s',
    'Cursor statistics did not default to cursor time.',
  );
  const sampleToggle = document.querySelector<HTMLInputElement>(
    '.plot-measurements .plot-checkbox input',
  )!;
  sampleToggle.click();
  await delay();
  assert(
    document.querySelector('.plot-measurement-table tbody td small')
      ?.textContent === '12.000000 s',
    'Sample-time inspection did not show the actual sample time.',
  );
  sampleToggle.click();
  await delay();
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
  const logBefore = limits('rpm'),
    unaffectedTorque = limits('Nm'),
    logTime = window();
  await axisDrag('rpm');
  assert(
    Math.abs(
      limits('rpm')[1] / limits('rpm')[0] - logBefore[1] / logBefore[0],
    ) < 1e-6 &&
      !same(limits('rpm'), logBefore) &&
      same(limits('Nm'), unaffectedTorque),
    'Log-axis pan did not preserve ratios independently.',
  );
  await click('Previous plot view');
  await wheelAt('rpm');
  assert(
    Math.log(limits('rpm')[1] / limits('rpm')[0]) <
      Math.log(logBefore[1] / logBefore[0]) &&
      same(limits('Nm'), unaffectedTorque) &&
      same(window(), logTime),
    'Log-axis zoom affected another axis or failed.',
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
  // The annotation list below the plot resizes the chart; let it settle.
  await until(
    () => Math.abs(chart().clientHeight - chart().viewBox.baseVal.height) < 1,
    'annotation layout',
  );
  const stored = () => readPlotSheets(localStorage.getItem(PLOT_STORAGE_KEY));
  const noteLabel = () =>
    chart().querySelector<SVGTextElement>('.plot-annotation text')!;
  const noteLine = () =>
    chart().querySelector<SVGLineElement>('.plot-annotation line')!;
  const initialLabelY = noteLabel().y.baseVal[0].value;
  // Closing the dialog may still deliver a ResizeObserver update. Compare
  // time-axis fractions so a responsive width change is not a time change.
  const noteFraction = () =>
    (noteLine().x1.baseVal.value - Number(chart().dataset.plotLeft)) /
    (Number(chart().dataset.plotRight) - Number(chart().dataset.plotLeft));
  const initialNoteFraction = noteFraction();
  const annotationWindow = window();
  async function dragNote(deltaY: number, cancel?: 'escape' | 'pointer') {
    const svg = chart(),
      rect = noteLabel().getBoundingClientRect();
    const start = {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const emit = (
      target: Element,
      type: string,
      clientX: number,
      clientY: number,
    ) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 8,
          button: 0,
          clientX,
          clientY,
        }),
      );
    emit(noteLabel(), 'pointerdown', start.clientX, start.clientY);
    await delay();
    // A diagonal pointer movement must only affect label height.
    emit(svg, 'pointermove', start.clientX + 90, start.clientY + deltaY);
    await delay();
    if (cancel === 'escape') {
      svg.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
      await delay();
    } else if (cancel === 'pointer') {
      emit(svg, 'pointercancel', start.clientX + 90, start.clientY + deltaY);
      await delay();
    }
    emit(svg, 'pointerup', start.clientX + 90, start.clientY + deltaY);
    await delay();
  }
  await dragNote(85);
  const movedLabelY = noteLabel().y.baseVal[0].value;
  const labelPosition = stored()[0].annotations?.[0].labelPosition;
  assert(
    movedLabelY > initialLabelY + 40 &&
      typeof labelPosition === 'number' &&
      Math.abs(noteFraction() - initialNoteFraction) < 1e-7 &&
      stored()[0].annotations?.[0].time === 25 &&
      same(window(), annotationWindow),
    'Annotation drag moved time or viewport, or failed to save its label height.',
  );
  await dragNote(-45, 'escape');
  await dragNote(-45, 'pointer');
  assert(
    noteLabel().y.baseVal[0].value === movedLabelY &&
      stored()[0].annotations?.[0].labelPosition === labelPosition,
    'Cancelled annotation drag changed its saved position.',
  );
  await dragNote(0);
  assert(
    noteLabel().y.baseVal[0].value === movedLabelY &&
      stored()[0].annotations?.[0].time === 25,
    'Horizontal annotation drag changed its label or time.',
  );
  noteLabel().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await delay();
  assert(
    input('Annotation time').value === '25',
    'Editing a dragged annotation changed its time.',
  );
  await click('Save annotation');
  assert(
    stored()[0].annotations?.[0].labelPosition === labelPosition,
    'Saving annotation text reset its height.',
  );
  async function exportImage(format: string) {
    // An export in progress disables both formats until its file is ready.
    const item = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) =>
          entry.textContent?.includes(format) &&
          !entry.hasAttribute('data-disabled'),
      );
    // Narrow plots offer export from the "More plot tools" menu instead.
    const visibleExport = [
      ...document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Export plot"]',
      ),
    ].some((button) => button.offsetParent !== null);
    await click(visibleExport ? 'Export plot' : 'More plot tools');
    await until(() => !!item(), `${format} export menu`);
    item()!.click();
    await until(
      () => !document.querySelector('[role="menuitem"]'),
      `${format} delivery`,
    );
  }
  await exportImage('SVG');
  await exportImage('PNG');
  await wheelAt('Nm');
  const torqueBeforeReorder = limits('Nm');
  const original = stored()[0];
  await click('Move trace down Motor speed');
  assert(
    stored()[0].traces[1].id === original.traces[0].id,
    'Keyboard trace reordering failed.',
  );
  assert(
    same(limits('Nm'), torqueBeforeReorder),
    'Moving an axis to the left lost its unit-specific limits.',
  );
  // Real drag payload and drop path, distinct from workflow signal imports.
  const rows = [...document.querySelectorAll<HTMLElement>('.scratchpad-trace')];
  const transfer = new DataTransfer();
  rows[1].dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }),
  );
  assert(
    transfer.types.includes('application/x-stratum-plot-trace'),
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
      stored()[1].annotations?.[0].text === 'Review marker <safe>' &&
      stored()[1].annotations?.[0].labelPosition === labelPosition &&
      JSON.stringify(stored()[1].axes) === JSON.stringify(original.axes),
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
