/**
 * In-memory workspace for the UI refresh mockup. It mirrors the seven-step
 * motor-test example in `workflow-example.ts` and supports the same kinds of
 * operations with plain arrays, so the mockup never touches the worker,
 * IndexedDB or the user's workspace. Every change returns a new workspace;
 * sample arrays are shared, never mutated.
 */

export type ValueFn = 'Time average' | 'Maximum' | 'Minimum';

export type Recipe =
  | { op: 'import'; file: string }
  | { op: 'smooth'; width: number }
  | { op: 'scale'; factor: number }
  | { op: 'offset'; amount: number }
  | { op: 'abs' }
  | { op: 'derivative' }
  | { op: 'multiply'; by: string }
  | { op: 'shift'; seconds: number }
  | { op: 'ranges'; ranges: [number, number][] }
  | { op: 'windows'; length: number }
  | { op: 'value'; fn: ValueFn };

export type MockStepKind = 'import' | 'derive' | 'segment' | 'value';

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
  fn: ValueFn;
  value: number;
  at?: number;
  samples: number;
  duration: number;
};

export type MockOutput = MockSignal | MockValue;

export type MockStep = {
  id: string;
  sequence: number;
  name: string;
  revision: number;
  inputs: string[];
  outputs: string[];
  recipe: Recipe;
};

export type Workspace = {
  steps: MockStep[];
  outputs: Map<string, MockOutput>;
  nextId: number;
};

type Draft =
  | Omit<MockSignal, 'id' | 'stepId'>
  | Omit<MockValue, 'id' | 'stepId'>;

export const stepKind = (step: MockStep): MockStepKind =>
  step.recipe.op === 'import'
    ? 'import'
    : step.recipe.op === 'ranges' || step.recipe.op === 'windows'
      ? 'segment'
      : step.recipe.op === 'value'
        ? 'value'
        : 'derive';

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

// Numerical helpers. Missing samples are NaN and stay missing.

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
    )
      if (Number.isFinite(v[j])) {
        sum += v[j];
        n++;
      }
    out[i] = Number.isFinite(v[i]) && n ? sum / n : NaN;
  }
  return out;
}

function derivative(t: Float64Array, v: Float64Array) {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(v.length - 1, i + 1);
    out[i] = b > a ? (v[b] - v[a]) / (t[b] - t[a]) : NaN;
  }
  return out;
}

/** Linear interpolation of (t, v) at `time`; NaN outside the samples. */
function interpolate(t: Float64Array, v: Float64Array, time: number) {
  const i = lowerBound(t, time);
  if (i < t.length && t[i] === time) return v[i];
  if (i === 0 || i >= t.length) return NaN;
  const ratio = (time - t[i - 1]) / (t[i] - t[i - 1]);
  return v[i - 1] + ratio * (v[i] - v[i - 1]);
}

function crop(
  t: Float64Array,
  v: Float64Array,
  start: number,
  end: number,
  inclusiveEnd: boolean,
) {
  const first = lowerBound(t, start - 1e-9);
  const last = inclusiveEnd
    ? lowerBound(t, end + 1e-9)
    : lowerBound(t, end - 1e-9);
  return { t: t.slice(first, last), v: v.slice(first, last) };
}

function reduce(t: Float64Array, v: Float64Array, fn: ValueFn) {
  let samples = 0;
  let area = 0;
  let duration = 0;
  let best = -1;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    samples++;
    if (
      best < 0 ||
      (fn === 'Maximum' && v[i] > v[best]) ||
      (fn === 'Minimum' && v[i] < v[best])
    )
      best = i;
    if (i > 0 && Number.isFinite(v[i - 1])) {
      area += ((v[i] + v[i - 1]) / 2) * (t[i] - t[i - 1]);
      duration += t[i] - t[i - 1];
    }
  }
  if (fn === 'Time average')
    return { value: duration > 0 ? area / duration : NaN, samples, duration };
  return {
    value: best < 0 ? NaN : v[best],
    at: best < 0 ? undefined : t[best],
    samples,
    duration,
  };
}

const trim = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Outputs of `recipe` applied to `inputs`, in input-major order. */
export function compute(
  ws: Workspace,
  recipe: Recipe,
  inputs: string[],
): Draft[] {
  const drafts: Draft[] = [];
  for (const id of inputs) {
    const input = ws.outputs.get(id);
    if (!input || input.kind === 'value') continue;
    const derived = (
      v: Float64Array,
      label: string,
      short: string,
      unit = input.unit,
      t = input.t,
    ) =>
      drafts.push({
        kind: 'derived',
        label,
        short,
        unit,
        inputs: recipe.op === 'multiply' ? [input.id, recipe.by] : [input.id],
        t,
        v,
      });
    switch (recipe.op) {
      case 'import':
        break;
      case 'smooth':
        derived(
          smooth(input.v, recipe.width),
          `${input.label} · smoothed`,
          `${input.short} smooth`,
        );
        break;
      case 'scale':
        derived(
          input.v.map((value) => value * recipe.factor),
          `${input.label} × ${trim(recipe.factor)}`,
          `${input.short} ×${trim(recipe.factor)}`,
        );
        break;
      case 'offset':
        derived(
          input.v.map((value) => value + recipe.amount),
          `${input.label} ${recipe.amount < 0 ? '−' : '+'} ${trim(Math.abs(recipe.amount))}`,
          `${input.short} offset`,
        );
        break;
      case 'abs':
        derived(input.v.map(Math.abs), `|${input.label}|`, `|${input.short}|`);
        break;
      case 'derivative':
        derived(
          derivative(input.t, input.v),
          `d/dt ${input.label}`,
          `d/dt ${input.short}`,
          `${input.unit}/s`,
        );
        break;
      case 'multiply': {
        const other = ws.outputs.get(recipe.by);
        if (!other || other.kind === 'value') break;
        // Evaluate on A's samples where B is defined: no invented history.
        const start = Math.max(input.t[0], other.t[0]);
        const end = Math.min(
          input.t[input.t.length - 1],
          other.t[other.t.length - 1],
        );
        const part = crop(input.t, input.v, start, end, true);
        derived(
          part.v.map(
            (value, i) => value * interpolate(other.t, other.v, part.t[i]),
          ),
          `${input.label} × ${other.label}`,
          `${input.short} × ${other.short}`,
          `${input.unit}·${other.unit}`,
          part.t,
        );
        break;
      }
      case 'shift':
        derived(
          input.v,
          `${input.label} · shifted ${trim(recipe.seconds)} s`,
          `${input.short} shifted`,
          input.unit,
          input.t.map((time) => time + recipe.seconds),
        );
        break;
      case 'ranges':
        for (const [start, end] of recipe.ranges) {
          const part = crop(input.t, input.v, start, end, true);
          if (part.t.length > 1)
            derived(
              part.v,
              `${trim(start)}–${trim(end)} s · ${input.label}`,
              `${trim(start)}–${trim(end)} s`,
              input.unit,
              part.t,
            );
        }
        break;
      case 'windows': {
        const last = input.t[input.t.length - 1];
        let n = 1;
        for (
          let start = input.t[0];
          start < last - 1e-9 && n <= 200;
          start += recipe.length, n++
        ) {
          const end = Math.min(last, start + recipe.length);
          const part = crop(input.t, input.v, start, end, end >= last);
          if (part.t.length > 1)
            derived(
              part.v,
              `Window ${n} · ${input.label}`,
              `Window ${n}`,
              input.unit,
              part.t,
            );
        }
        break;
      }
      case 'value': {
        const result = reduce(input.t, input.v, recipe.fn);
        const tag =
          recipe.fn === 'Time average'
            ? 'avg'
            : recipe.fn === 'Maximum'
              ? 'max'
              : 'min';
        drafts.push({
          kind: 'value',
          label: `${input.label} · ${recipe.fn}`,
          short: `${input.short} ${tag}`,
          unit: input.unit,
          inputs: [input.id],
          fn: recipe.fn,
          ...result,
        });
        break;
      }
    }
  }
  return drafts;
}

function copy(ws: Workspace): Workspace {
  return {
    steps: [...ws.steps],
    outputs: new Map(ws.outputs),
    nextId: ws.nextId,
  };
}

/** Appends one operation and its outputs atomically. */
export function apply(
  ws: Workspace,
  recipe: Recipe,
  inputs: string[],
  name: string,
) {
  const next = copy(ws);
  const drafts = compute(ws, recipe, inputs);
  const step: MockStep = {
    id: `s${next.nextId++}`,
    sequence: Math.max(0, ...ws.steps.map((item) => item.sequence)) + 1,
    name,
    revision: 1,
    inputs,
    outputs: [],
    recipe,
  };
  for (const draft of drafts) {
    const id = `o${next.nextId++}`;
    next.outputs.set(id, { ...draft, id, stepId: step.id } as MockOutput);
    step.outputs.push(id);
  }
  next.steps.push(step);
  return { ws: next, step };
}

/** Consumers of `ids`, directly or through later operations. */
export function dependents(ws: Workspace, stepId: string) {
  const removed = new Set(
    ws.steps.find((step) => step.id === stepId)?.outputs ?? [],
  );
  const found: MockStep[] = [];
  for (const step of ws.steps) {
    const uses = [
      ...step.inputs,
      ...(step.recipe.op === 'multiply' ? [step.recipe.by] : []),
    ];
    if (step.id !== stepId && uses.some((id) => removed.has(id))) {
      found.push(step);
      step.outputs.forEach((id) => removed.add(id));
    }
  }
  return found;
}

/** Removes an operation and every operation that depends on it. */
export function remove(ws: Workspace, stepId: string) {
  const doomed = new Set([stepId, ...dependents(ws, stepId).map((s) => s.id)]);
  const next = copy(ws);
  next.steps = ws.steps.filter((step) => !doomed.has(step.id));
  for (const step of ws.steps)
    if (doomed.has(step.id))
      step.outputs.forEach((id) => next.outputs.delete(id));
  return next;
}

/**
 * Replaces an operation's settings, then replays every dependent operation in
 * order. Output IDs and names are kept while the output count matches.
 */
export function edit(ws: Workspace, stepId: string, recipe: Recipe) {
  const next = copy(ws);
  const changed = new Set<string>();
  const start = next.steps.findIndex((step) => step.id === stepId);
  for (let i = start; i < next.steps.length; i++) {
    const step = i === start ? { ...next.steps[i], recipe } : next.steps[i];
    const uses = [
      ...step.inputs,
      ...(step.recipe.op === 'multiply' ? [step.recipe.by] : []),
    ];
    if (i !== start && !uses.some((id) => changed.has(id))) continue;
    const inputs = step.inputs.filter((id) => next.outputs.has(id));
    const drafts =
      step.recipe.op === 'multiply' && !next.outputs.has(step.recipe.by)
        ? []
        : compute(next, step.recipe, inputs);
    for (const id of step.outputs.slice(drafts.length)) {
      next.outputs.delete(id);
      changed.add(id);
    }
    const ids = drafts.map((_, k) => step.outputs[k] ?? `o${next.nextId++}`);
    drafts.forEach((draft, k) => {
      const previous = next.outputs.get(ids[k]);
      next.outputs.set(ids[k], {
        ...draft,
        id: ids[k],
        stepId: step.id,
        label: previous?.label ?? draft.label,
        short: previous?.short ?? draft.short,
      } as MockOutput);
      changed.add(ids[k]);
    });
    if (!ids.length) {
      next.steps.splice(i--, 1);
      continue;
    }
    next.steps[i] = {
      ...step,
      inputs,
      outputs: ids,
      revision: i === start ? step.revision + 1 : step.revision,
    };
  }
  return next;
}

export function duplicate(ws: Workspace, stepId: string) {
  const step = ws.steps.find((item) => item.id === stepId)!;
  return apply(ws, step.recipe, step.inputs, `${step.name} (copy)`);
}

export function rename(ws: Workspace, id: string, name: string) {
  const next = copy(ws);
  const output = next.outputs.get(id);
  if (output) next.outputs.set(id, { ...output, label: name });
  else
    next.steps = next.steps.map((step) =>
      step.id === id ? { ...step, name } : step,
    );
  return next;
}

/** Parses `Time,Name [unit],…` CSV text into a new recording operation. */
export function importCsv(ws: Workspace, file: string, text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) throw new Error('The file needs a header and rows.');
  const header = lines[0]
    .split(',')
    .map((cell) => cell.trim().replace(/^"|"$/g, ''));
  if (header.length < 2) throw new Error('Expected time plus a channel.');
  const rows = lines
    .slice(1, 200_001)
    .map((line) => line.split(',').map((cell) => Number.parseFloat(cell)))
    .filter((row) => Number.isFinite(row[0]));
  const t = Float64Array.from(rows, (row) => row[0]);
  for (let i = 1; i < t.length; i++)
    if (!(t[i] > t[i - 1])) throw new Error('Time must increase on every row.');
  const next = copy(ws);
  const step: MockStep = {
    id: `s${next.nextId++}`,
    sequence: Math.max(0, ...ws.steps.map((item) => item.sequence)) + 1,
    name: `Record ${file.replace(/\.csv$/i, '')}`,
    revision: 1,
    inputs: [],
    outputs: [],
    recipe: { op: 'import', file },
  };
  header.slice(1).forEach((cell, column) => {
    const match = /^(.*?)\s*[[(]([^\])]*)[\])]\s*$/.exec(cell);
    const label = (match?.[1] ?? cell) || `Channel ${column + 1}`;
    const id = `o${next.nextId++}`;
    next.outputs.set(id, {
      kind: 'original',
      id,
      label,
      short: label.slice(0, 14),
      unit: match?.[2] ?? '',
      stepId: step.id,
      inputs: [],
      t,
      v: Float64Array.from(rows, (row) =>
        Number.isFinite(row[column + 1]) ? row[column + 1] : NaN,
      ),
    });
    step.outputs.push(id);
  });
  next.steps.push(step);
  return { ws: next, step };
}

/** One-line description of an operation's settings. */
export function summary(ws: Workspace, step: MockStep) {
  const recipe = step.recipe;
  const count = `${step.inputs.length} input${step.inputs.length === 1 ? '' : 's'}`;
  switch (recipe.op) {
    case 'import':
      return `CSV · ${step.outputs.length} channel${step.outputs.length === 1 ? '' : 's'}`;
    case 'smooth':
      return `Moving average · ${recipe.width} samples`;
    case 'scale':
      return `Scale × ${trim(recipe.factor)}`;
    case 'offset':
      return `Offset ${recipe.amount < 0 ? '−' : '+'} ${trim(Math.abs(recipe.amount))}`;
    case 'abs':
      return 'Absolute value';
    case 'derivative':
      return 'Derivative d/dt';
    case 'multiply':
      return `A × ${ws.outputs.get(recipe.by)?.short ?? 'B'}`;
    case 'shift':
      return `Time shift ${trim(recipe.seconds)} s`;
    case 'ranges':
      return `${recipe.ranges.length} time range${recipe.ranges.length === 1 ? '' : 's'}`;
    case 'windows':
      return `${trim(recipe.length)} s windows`;
    case 'value':
      return `${recipe.fn} · ${count}`;
  }
}

/** Saved settings shown in the inspector and the Settings tab. */
export function settings(ws: Workspace, step: MockStep): [string, string][] {
  const recipe = step.recipe;
  const names = (ids: string[]) =>
    ids.map((id) => ws.outputs.get(id)?.label ?? 'Removed').join(', ');
  const inputs: [string, string] = [
    step.inputs.length === 1 ? 'Input' : 'Inputs',
    step.inputs.length > 3
      ? `${step.inputs.length} signals`
      : names(step.inputs),
  ];
  switch (recipe.op) {
    case 'import': {
      const first = ws.outputs.get(step.outputs[0]) as MockSignal | undefined;
      const rate =
        first && first.t.length > 1
          ? (first.t.length - 1) / (first.t[first.t.length - 1] - first.t[0])
          : NaN;
      return [
        ['File', recipe.file],
        ['Channels', names(step.outputs)],
        ['Samples', (first?.t.length ?? 0).toLocaleString('en-US')],
        ['Sample rate', Number.isFinite(rate) ? `${trim(rate)} Hz` : '—'],
      ];
    }
    case 'smooth':
      return [
        ['Function', 'Moving average'],
        ['Window', `${recipe.width} samples, centred`],
        inputs,
      ];
    case 'scale':
      return [['Function', `Scale × ${trim(recipe.factor)}`], inputs];
    case 'offset':
      return [['Function', `Offset + ${trim(recipe.amount)}`], inputs];
    case 'abs':
      return [['Function', 'Absolute value |A|'], inputs];
    case 'derivative':
      return [['Function', 'Central difference d/dt'], inputs];
    case 'multiply':
      return [
        ['Function', 'Multiply signals · A × B'],
        ['Input A', names(step.inputs)],
        ['Input B', names([recipe.by])],
      ];
    case 'shift':
      return [['Function', `Shift time by ${trim(recipe.seconds)} s`], inputs];
    case 'ranges':
      return [
        ['Method', 'Time ranges'],
        [
          'Ranges',
          recipe.ranges.map(([a, b]) => `${trim(a)}–${trim(b)} s`).join(', '),
        ],
        ['Outside data', 'Clip to available interval'],
        inputs,
      ];
    case 'windows':
      return [
        ['Method', 'Windows'],
        ['Window length', `${trim(recipe.length)} s`],
        ['Overlap', 'None'],
        inputs,
      ];
    case 'value':
      return [
        ['Function', recipe.fn],
        [
          'Definition',
          recipe.fn === 'Time average'
            ? 'Trapezoidal integral ÷ valid elapsed time'
            : 'Extreme finite sample and its first time',
        ],
        inputs,
      ];
  }
}

// The motor-test example, built with the same operations the UI offers.

function motorTest() {
  const count = 1801;
  const t = new Float64Array(count);
  const speed = new Float64Array(count);
  const torque = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const time = i / 10;
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

function example(): Workspace {
  const { t, speed, torque } = motorTest();
  let ws: Workspace = { steps: [], outputs: new Map(), nextId: 1 };
  const outputs = new Map<string, MockOutput>([
    [
      'speed',
      {
        kind: 'original',
        id: 'speed',
        label: 'Motor speed',
        short: 'Speed',
        unit: 'rpm',
        stepId: 's1',
        inputs: [],
        t,
        v: speed,
      },
    ],
    [
      'torque',
      {
        kind: 'original',
        id: 'torque',
        label: 'Torque',
        short: 'Torque',
        unit: 'Nm',
        stepId: 's1',
        inputs: [],
        t,
        v: torque,
      },
    ],
  ]);
  ws = {
    steps: [
      {
        id: 's1',
        sequence: 1,
        name: 'Record motor speed and torque',
        revision: 1,
        inputs: [],
        outputs: ['speed', 'torque'],
        recipe: { op: 'import', file: 'Motor test · three runs.csv' },
      },
    ],
    outputs,
    nextId: 100,
  };
  // Named outputs keep the example's stable IDs and labels.
  const add = (
    id: string,
    recipe: Recipe,
    inputs: string[],
    name: string,
    labels: [string, string, string][],
    revision = 1,
  ) => {
    const result = apply(ws, recipe, inputs, name);
    const next = copy(result.ws);
    const step = { ...result.step, id, revision, outputs: [] as string[] };
    result.step.outputs.forEach((generated, k) => {
      const output = next.outputs.get(generated)!;
      next.outputs.delete(generated);
      const [key, label, short] = labels[k];
      next.outputs.set(key, { ...output, id: key, stepId: id, label, short });
      step.outputs.push(key);
    });
    next.steps[next.steps.length - 1] = step;
    ws = next;
  };
  add('s2', { op: 'smooth', width: 5 }, ['torque'], 'Smooth measured torque', [
    ['smooth', 'Smoothed torque', 'Smoothed'],
  ]);
  add(
    's3',
    { op: 'multiply', by: 'speed' },
    ['smooth'],
    'Multiply torque and speed',
    [['product', 'Torque × speed', 'Product']],
  );
  add(
    's4',
    {
      op: 'ranges',
      ranges: [
        [10, 50],
        [65, 105],
        [120, 160],
      ],
    },
    ['product'],
    'Split the product into three runs',
    [1, 2, 3].map((n) => [`run${n}`, `Run ${n} · Torque × speed`, `Run ${n}`]),
    2,
  );
  add(
    's5',
    { op: 'value', fn: 'Time average' },
    ['run1', 'run2', 'run3'],
    'Compare average product by run',
    [1, 2, 3].map((n) => [
      `avg${n}`,
      `Run ${n} · Average product`,
      `Run ${n} avg`,
    ]),
  );
  add(
    's6',
    { op: 'windows', length: 20 },
    ['run2'],
    'Split Run 2 into two windows',
    [
      ['half1', 'Run 2 · First half · Torque × speed', 'First half'],
      ['half2', 'Run 2 · Second half · Torque × speed', 'Second half'],
    ],
  );
  add(
    's7',
    { op: 'value', fn: 'Maximum' },
    ['half1', 'half2'],
    'Compare peak product within Run 2',
    [
      ['peak1', 'Run 2 · First half · Peak product', 'First half peak'],
      ['peak2', 'Run 2 · Second half · Peak product', 'Second half peak'],
    ],
  );
  return ws;
}

export const EXAMPLE = example();

export const stepRef = (step: MockStep) =>
  `#${String(step.sequence).padStart(3, '0')}`;

export function stepOf(ws: Workspace, id: string) {
  const output = ws.outputs.get(id);
  return ws.steps.find((step) => step.id === (output?.stepId ?? id));
}

/** Every output that contributes to `ids`, including the outputs themselves. */
export function ancestry(ws: Workspace, ids: string[]) {
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const output = ws.outputs.get(id);
    if (output) stack.push(...output.inputs);
  }
  return seen;
}

export function usedBy(ws: Workspace, ids: string[]) {
  return ws.steps.filter((step) =>
    [
      ...step.inputs,
      ...(step.recipe.op === 'multiply' ? [step.recipe.by] : []),
    ].some((id) => ids.includes(id)),
  );
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
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : digits,
  });
}

/** Full-precision value for properties and tables. */
export const formatExact = (value: number) =>
  Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 3 })
    : '—';
