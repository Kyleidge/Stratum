/**
 * Static sample data for the UI refresh mockup. It mirrors the seven-step
 * motor-test example in `workflow-example.ts` with plain in-memory arrays, so
 * the mockup renders without the worker, IndexedDB or the user's workspace.
 */

export type MockStepKind = 'import' | 'derive' | 'segment' | 'value';
export type MockOutputKind = 'original' | 'derived' | 'value';

export type MockSignal = {
  kind: 'original' | 'derived';
  id: string;
  label: string;
  short: string;
  unit: string;
  stepId: string;
  inputs: string[];
  t: Float64Array;
  v: Float64Array;
};

export type MockValue = {
  kind: 'value';
  id: string;
  label: string;
  short: string;
  unit: string;
  stepId: string;
  inputs: string[];
  fn: 'Time average' | 'Maximum';
  value: number;
  at?: number;
  samples: number;
  duration: number;
};

export type MockOutput = MockSignal | MockValue;

export type MockStep = {
  id: string;
  sequence: number;
  kind: MockStepKind;
  name: string;
  summary: string;
  revision: number;
  inputs: string[];
  outputs: string[];
  settings: [string, string][];
};

const RATE = 10;
const COUNT = 1801;

function recording() {
  const t = new Float64Array(COUNT);
  const speed = new Float64Array(COUNT);
  const torque = new Float64Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const time = i / RATE;
    const run = Math.floor((time - 10) / 55);
    const local = time - 10 - run * 55;
    const active = run >= 0 && run < 3 && local < 40;
    t[i] = time;
    speed[i] = active ? 900 + 120 * local : 600;
    torque[i] = active
      ? 70 +
        20 * Math.sin((Math.PI * local) / 40) +
        run * 3 +
        3 * Math.sin(time * 19)
      : 3 + 0.3 * Math.sin(time * 7);
  }
  return { t, speed, torque };
}

function smooth(v: Float64Array, width: number) {
  const out = new Float64Array(v.length);
  const half = Math.floor(width / 2);
  for (let i = 0; i < v.length; i++) {
    let sum = 0;
    let n = 0;
    for (
      let j = Math.max(0, i - half);
      j <= Math.min(v.length - 1, i + half);
      j++
    ) {
      sum += v[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function crop(t: Float64Array, v: Float64Array, start: number, end: number) {
  const first = lowerBound(t, start - 1e-9);
  const last = lowerBound(t, end + 1e-9);
  return { t: t.slice(first, last), v: v.slice(first, last) };
}

function timeAverage(t: Float64Array, v: Float64Array) {
  let area = 0;
  for (let i = 1; i < t.length; i++)
    area += ((v[i] + v[i - 1]) / 2) * (t[i] - t[i - 1]);
  const duration = t[t.length - 1] - t[0];
  return { value: area / duration, duration };
}

function maximum(t: Float64Array, v: Float64Array) {
  let best = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
  return { value: v[best], at: t[best], duration: t[t.length - 1] - t[0] };
}

/** First index whose time is not below `time`. */
export function lowerBound(t: Float64Array, time: number) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildWorkspace() {
  const { t, speed, torque } = recording();
  const smoothed = smooth(torque, 5);
  const product = smoothed.map((value, i) => value * speed[i]);
  const outputs = new Map<string, MockOutput>();
  const signal = (
    kind: MockSignal['kind'],
    id: string,
    label: string,
    short: string,
    unit: string,
    stepId: string,
    inputs: string[],
    data: { t: Float64Array; v: Float64Array },
  ) =>
    outputs.set(id, {
      kind,
      id,
      label,
      short,
      unit,
      stepId,
      inputs,
      ...data,
    });

  signal('original', 'speed', 'Motor speed', 'Speed', 'rpm', 's1', [], {
    t,
    v: speed,
  });
  signal('original', 'torque', 'Torque', 'Torque', 'Nm', 's1', [], {
    t,
    v: torque,
  });
  signal(
    'derived',
    'smooth',
    'Smoothed torque',
    'Smoothed',
    'Nm',
    's2',
    ['torque'],
    { t, v: smoothed },
  );
  signal(
    'derived',
    'product',
    'Torque × speed',
    'Product',
    'Nm·rpm',
    's3',
    ['smooth', 'speed'],
    { t, v: product },
  );

  const runs: [number, number][] = [
    [10, 50],
    [65, 105],
    [120, 160],
  ];
  runs.forEach(([start, end], index) =>
    signal(
      'derived',
      `run${index + 1}`,
      `Run ${index + 1} · Torque × speed`,
      `Run ${index + 1}`,
      'Nm·rpm',
      's4',
      ['product'],
      crop(t, product, start, end),
    ),
  );
  for (let index = 0; index < 3; index++) {
    const run = outputs.get(`run${index + 1}`) as MockSignal;
    const { value, duration } = timeAverage(run.t, run.v);
    outputs.set(`avg${index + 1}`, {
      kind: 'value',
      id: `avg${index + 1}`,
      label: `Run ${index + 1} · Average product`,
      short: `Run ${index + 1} avg`,
      unit: 'Nm·rpm',
      stepId: 's5',
      inputs: [run.id],
      fn: 'Time average',
      value,
      samples: run.t.length,
      duration,
    });
  }
  const run2 = outputs.get('run2') as MockSignal;
  const halves: [string, string, number, number][] = [
    ['half1', 'First half', 65, 85],
    ['half2', 'Second half', 85, 105],
  ];
  for (const [id, name, start, end] of halves)
    signal(
      'derived',
      id,
      `Run 2 · ${name} · Torque × speed`,
      name,
      'Nm·rpm',
      's6',
      ['run2'],
      crop(run2.t, run2.v, start, end),
    );
  halves.forEach(([id, name], index) => {
    const half = outputs.get(id) as MockSignal;
    const { value, at, duration } = maximum(half.t, half.v);
    outputs.set(`peak${index + 1}`, {
      kind: 'value',
      id: `peak${index + 1}`,
      label: `Run 2 · ${name} · Peak product`,
      short: `${name} peak`,
      unit: 'Nm·rpm',
      stepId: 's7',
      inputs: [id],
      fn: 'Maximum',
      value,
      at,
      samples: half.t.length,
      duration,
    });
  });

  const steps: MockStep[] = [
    {
      id: 's1',
      sequence: 1,
      kind: 'import',
      name: 'Record motor speed and torque',
      summary: 'CSV · 2 channels',
      revision: 1,
      inputs: [],
      outputs: ['speed', 'torque'],
      settings: [
        ['File', 'Motor test · three runs.csv'],
        ['Channels', 'Motor speed, Torque'],
        ['Sample rate', '10 Hz'],
        ['Samples', COUNT.toLocaleString('en-US')],
      ],
    },
    {
      id: 's2',
      sequence: 2,
      kind: 'derive',
      name: 'Smooth measured torque',
      summary: 'Moving average · 5 samples',
      revision: 1,
      inputs: ['torque'],
      outputs: ['smooth'],
      settings: [
        ['Function', 'Moving average'],
        ['Window', '5 samples, centred'],
        ['Missing samples', 'Stay missing'],
      ],
    },
    {
      id: 's3',
      sequence: 3,
      kind: 'derive',
      name: 'Multiply torque and speed',
      summary: 'A × B',
      revision: 1,
      inputs: ['smooth', 'speed'],
      outputs: ['product'],
      settings: [
        ['Function', 'Multiply signals · A × B'],
        ['Input A', 'Smoothed torque'],
        ['Input B', 'Motor speed'],
        ['Output unit', 'Nm·rpm'],
      ],
    },
    {
      id: 's4',
      sequence: 4,
      kind: 'segment',
      name: 'Split the product into three runs',
      summary: '3 time ranges',
      revision: 2,
      inputs: ['product'],
      outputs: ['run1', 'run2', 'run3'],
      settings: [
        ['Method', 'Time ranges'],
        ['Ranges', '10–50 s, 65–105 s, 120–160 s'],
        ['Outside data', 'Clip to available interval'],
      ],
    },
    {
      id: 's5',
      sequence: 5,
      kind: 'value',
      name: 'Compare average product by run',
      summary: 'Time average · 3 inputs',
      revision: 1,
      inputs: ['run1', 'run2', 'run3'],
      outputs: ['avg1', 'avg2', 'avg3'],
      settings: [
        ['Function', 'Time average'],
        ['Definition', 'Trapezoidal integral ÷ valid elapsed time'],
        ['Missing intervals', 'Excluded'],
      ],
    },
    {
      id: 's6',
      sequence: 6,
      kind: 'segment',
      name: 'Split Run 2 into two windows',
      summary: '20 s windows',
      revision: 1,
      inputs: ['run2'],
      outputs: ['half1', 'half2'],
      settings: [
        ['Method', 'Windows'],
        ['Window length', '20 s'],
        ['Overlap', 'None'],
      ],
    },
    {
      id: 's7',
      sequence: 7,
      kind: 'value',
      name: 'Compare peak product within Run 2',
      summary: 'Maximum · 2 inputs',
      revision: 1,
      inputs: ['half1', 'half2'],
      outputs: ['peak1', 'peak2'],
      settings: [
        ['Function', 'Maximum'],
        ['Reports', 'Value and first occurrence time'],
      ],
    },
  ];
  return { steps, outputs };
}

export const MOCK = buildWorkspace();

export const stepRef = (step: MockStep) =>
  `#${String(step.sequence).padStart(3, '0')}`;

export function stepOf(id: string) {
  const output = MOCK.outputs.get(id);
  return MOCK.steps.find((step) => step.id === (output?.stepId ?? id));
}

/** Every output that contributes to `ids`, including the outputs themselves. */
export function ancestry(ids: string[]) {
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const output = MOCK.outputs.get(id);
    if (output) stack.push(...output.inputs);
  }
  return seen;
}

export function usedBy(id: string) {
  return MOCK.steps.filter((step) => step.inputs.includes(id));
}

/**
 * The 1/2/5 × 10ⁿ step whose tick count is nearest `target`, with at least
 * three ticks. With `expand`, ticks are counted on the domain rounded outward
 * to whole steps, and ties prefer the tighter domain.
 */
function tickStep(min: number, max: number, target: number, expand: boolean) {
  const magnitude =
    10 ** Math.floor(Math.log10((max - min) / Math.max(1, target - 1)));
  let step = magnitude;
  let best = [Infinity, Infinity];
  for (const factor of [0.5, 1, 2, 5, 10, 20]) {
    const candidate = factor * magnitude;
    const first = expand
      ? Math.floor(min / candidate + 1e-9)
      : Math.ceil(min / candidate - 1e-9);
    const last = expand
      ? Math.ceil(max / candidate - 1e-9)
      : Math.floor(max / candidate + 1e-9);
    const count = last - first + 1;
    const score = [
      Math.abs(count - target) + (count < 3 ? 100 : 0),
      expand ? (last - first) * candidate : -candidate,
    ];
    if (score[0] < best[0] || (score[0] === best[0] && score[1] < best[1])) {
      best = score;
      step = candidate;
    }
  }
  return step;
}

function padded(min: number, max: number) {
  if (max > min) return [min, max];
  const pad = Math.abs(min) * 0.1 || 1;
  return [min - pad, max + pad];
}

/** Round-number ticks inside [min, max], about `target` of them. */
export function niceTicks(low: number, high: number, target = 6) {
  const [min, max] = padded(low, high);
  const step = tickStep(min, max, target, false);
  const ticks: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let i = first; i * step <= max + step * 1e-9; i++)
    ticks.push(i === 0 ? 0 : i * step);
  return { ticks, step };
}

/** Expands [min, max] outward so the first and last ticks are the axis ends. */
export function niceDomain(low: number, high: number, target = 5) {
  const [min, max] = padded(low, high);
  const step = tickStep(min, max, target, true);
  const first = Math.floor(min / step + 1e-9);
  const last = Math.max(first + 1, Math.ceil(max / step - 1e-9));
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(i === 0 ? 0 : i * step);
  return { lo: first * step, hi: last * step, ticks, step };
}

export function formatTick(value: number, step: number) {
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact display value: one decimal from 1,000 upward, else `digits`. */
export function formatNumber(value: number, digits = 3) {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : digits,
  });
}

/** Full-precision value for properties and tables. */
export const formatExact = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 3 });
