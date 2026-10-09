import type { Operation, SegmentationDefinition } from './signal-types';

export type ValueOperation =
  | 'minimum'
  | 'maximum'
  | 'time-average'
  | 'sample-average'
  | 'rms'
  | 'standard-deviation'
  | 'peak-to-peak'
  | 'start-value'
  | 'end-value'
  | 'value-at'
  | 'area'
  | 'duration'
  | 'time-of-minimum'
  | 'time-of-maximum'
  | 'time-above'
  | 'time-below'
  | 'first-crossing'
  | 'crossing-count'
  /** Arithmetic over other values (`a` each input value); see CALCULATE. */
  | 'calculate';

/**
 * Numeric settings of a value calculation, by name: `threshold` (input unit),
 * `edge` (1 rising, −1 falling), `time` (seconds from the input's start), and
 * the crossing detector's optional `hysteresis` and `debounce`.
 */
export type ValueParameters = Record<string, number>;

/**
 * A setting taken from calculated values: `factor` × the matched value. One
 * value is shared by every input; several are matched to each input by
 * lineage (the value calculated from that input, or from a signal it came
 * from or that came from it).
 */
export type ValueBinding = { valueIds: string[]; factor: number };
/** Settings taken from values, by setting name. */
export type ParameterBindings = Record<string, ValueBinding>;
/** The value one saved output used for a setting. */
export type BoundValue = { valueId: string; factor: number };

export type ScalarValue = {
  id: string;
  sourceId: string;
  inputId: string;
  batchId: string;
  name: string;
  unit: string;
  operation: ValueOperation;
  /**
   * Settings of a parameterised calculation, such as its threshold. A
   * calculation from values holds each available variable's number here.
   */
  parameters?: ValueParameters;
  /**
   * Settings taken from other values. A calculation from values binds every
   * variable, `a` being its input value.
   */
  bindings?: Record<string, BoundValue>;
  /** A calculation from values: its formula (`a` is the input value). */
  expression?: string;
  /**
   * The input level a time result refers to (the extreme of a time of
   * minimum or maximum), so plots can mark it over its input.
   */
  level?: number;
  value: number | null;
  sampleCount: number;
  validDuration: number;
  start: number;
  end: number;
  timestamp?: number;
  createdAt: string;
  /** The file segment the value was calculated within. */
  segmentId?: string;
};

/** Chronological invocation record; explicit edits increment its revision. */
export type WorkflowStep = {
  timeSettings?: import('./time-types').TimeSettings;
  revision?: number;
  updatedAt?: string;
  name?: string;
  /** Import steps: the recording's file name, for the default step name. */
  fileName?: string;
  id: string;
  sourceId: string;
  sequence: number;
  createdAt: string;
  kind: 'import' | 'derive' | 'segment' | 'value' | 'regions';
  operation: Operation | ValueOperation | 'import' | 'regions' | 'segment';
  inputIds: string[];
  outputIds: string[];
  /**
   * Values whose results this step's settings use. A calculation from
   * values lists its input values in `inputIds` and the others here.
   */
  valueInputIds?: string[];
  /** A calculation from values: its formula. */
  expression?: string;
  parameters?: Record<string, number>;
  definition?: SegmentationDefinition;
  segmentationId?: string;
  /** Segment steps that find file segments: their `SegmentSet`. */
  segmentSetId?: string;
  /** The segments this step works within, as chosen. */
  within?: import('./signal-types').SegmentScope;
  /** The segments it actually used, for impact, lineage and Used by. */
  segmentInputIds?: string[];
  regionSetId?: string;
  /** Workflow run that produced this step, when created by a batch. */
  runId?: string;
  /** Recipe step this invocation was replayed from. */
  recipeStepId?: string;
  checks?: CheckDefinition[];
  /** Results for `checks`, evaluated against the step's current revision. */
  checkResults?: { revision: number; results: CheckResult[] };
};

export type CheckKind = 'count' | 'limits' | 'missing' | 'duration';
/** An expectation on a step's outputs. Limits are inclusive. */
export type CheckDefinition = {
  kind: CheckKind;
  min?: number;
  max?: number;
  /** Limits only: must equal the output unit exactly; never converted. */
  unit?: string;
  /** 1-based output positions; all outputs when omitted. */
  outputs?: number[];
  severity: 'warning' | 'fail';
  message?: string;
};
export type CheckStatus = 'pass' | 'warning' | 'fail';
export type CheckResult = {
  /** Index into the step's checks. */
  check: number;
  status: CheckStatus;
  outputId?: string;
  observed: number | null;
  message: string;
};

/** `none`: the item ran without problems but no check was evaluated. */
export type RunStatus = 'none' | 'pass' | 'warning' | 'fail' | 'error';
/** A problem found while replaying a workflow, separate from check results. */
export type RunFlag = {
  severity: 'warning' | 'error';
  recipeStepId?: string;
  message: string;
};
export type WorkflowRun = {
  id: string;
  batchId: string;
  itemId: string;
  fileName: string;
  sourceId: string;
  status: RunStatus;
  /** Recipe step ID → produced workflow step ID. */
  steps: Record<string, string>;
  flags: RunFlag[];
  /**
   * Recipe channel alias → column name used instead of the recipe's name for
   * this item, chosen in pre-flight. The saved workflow text is unchanged.
   */
  channelMap?: Record<string, string>;
  startedAt: string;
  finishedAt: string;
};
export type WorkflowBatch = {
  id: string;
  name: string;
  recipeHash: string;
  createdAt: string;
  state: 'running' | 'complete' | 'cancelled';
  runs: WorkflowRun[];
  /** Files that could not be imported, so nothing was published for them. */
  failures?: { name: string; message: string }[];
};
/** Exact workflow text used by batches, for provenance and re-runs. */
export type WorkflowRecipeRecord = {
  hash: string;
  name: string;
  revision?: string;
  text: string;
};

/**
 * Exact statistics behind every value calculation. Previews and created values
 * read the same record, so a preview always matches the value it creates.
 * Times are on the input's own axis; elapsed results subtract `start`.
 */
export type ValueStatistics = {
  inputId: string;
  /** Statistics within this file segment of the input. */
  segmentId?: string;
  sampleCount: number;
  validDuration: number;
  sampleAverage: number | null;
  timeAverage: number | null;
  minimum: number | null;
  maximum: number | null;
  /** First occurrence times; present only when a finite sample exists. */
  minimumTime?: number;
  maximumTime?: number;
  rms?: number | null;
  /** Sample standard deviation (n − 1); unavailable below two samples. */
  standardDeviation?: number | null;
  /** Trapezoidal area over valid intervals; unavailable without one. */
  integral?: number | null;
  startValue?: number | null;
  startTime?: number;
  endValue?: number | null;
  endTime?: number;
  /** The input's time bounds, which elapsed times and durations use. */
  start?: number;
  end?: number;
  /** A parameterised calculation evaluated in the same pass. */
  result?: {
    operation: ValueOperation;
    parameters: ValueParameters;
    value: number | null;
    timestamp?: number;
  };
};

export type ValueGroup = 'Level' | 'Spread' | 'Time' | 'Events' | 'Math';
/** What a value measures, which decides its unit. */
export type ValueResult = 'level' | 'area' | 'time' | 'count';
export type ValueParameter =
  | 'threshold'
  | 'edge'
  | 'time'
  | 'hysteresis'
  | 'debounce';
export type ValueFunctionSpec = {
  operation: ValueOperation;
  name: string;
  group: ValueGroup;
  result: ValueResult;
  /** Short tag for plot labels and tables, such as "avg". */
  tag: string;
  description: string;
  parameters?: ValueParameter[];
};

export const VALUE_FUNCTIONS: ValueFunctionSpec[] = [
  {
    operation: 'time-average',
    name: 'Time average',
    group: 'Level',
    result: 'level',
    tag: 'avg',
    description:
      'Trapezoidal integral divided by valid elapsed time. Adjacent finite samples contribute; missing intervals are excluded. Requires a positive valid duration.',
  },
  {
    operation: 'sample-average',
    name: 'Sample average',
    group: 'Level',
    result: 'level',
    tag: 'mean',
    description:
      'Arithmetic mean of finite samples. Each sample has equal weight.',
  },
  {
    operation: 'minimum',
    name: 'Minimum',
    group: 'Level',
    result: 'level',
    tag: 'min',
    description: 'Lowest finite sample, with its first occurrence time.',
  },
  {
    operation: 'maximum',
    name: 'Maximum',
    group: 'Level',
    result: 'level',
    tag: 'max',
    description: 'Highest finite sample, with its first occurrence time.',
  },
  {
    operation: 'start-value',
    name: 'Start value',
    group: 'Level',
    result: 'level',
    tag: 'start',
    description: 'The first finite sample, with its time.',
  },
  {
    operation: 'end-value',
    name: 'End value',
    group: 'Level',
    result: 'level',
    tag: 'end',
    description: 'The last finite sample, with its time.',
  },
  {
    operation: 'value-at',
    name: 'Value at time',
    group: 'Level',
    result: 'level',
    tag: 'at',
    parameters: ['time'],
    description:
      "The signal at a time measured from the input's start, interpolated linearly between adjacent finite samples. Unavailable outside the input or inside a gap.",
  },
  {
    operation: 'rms',
    name: 'RMS',
    group: 'Spread',
    result: 'level',
    tag: 'rms',
    description:
      'Root mean square of finite samples. Each sample has equal weight.',
  },
  {
    operation: 'standard-deviation',
    name: 'Standard deviation',
    group: 'Spread',
    result: 'level',
    tag: 'σ',
    description:
      'Sample standard deviation (n − 1) of finite samples. Requires at least two samples.',
  },
  {
    operation: 'peak-to-peak',
    name: 'Peak to peak',
    group: 'Spread',
    result: 'level',
    tag: 'p-p',
    description: 'Maximum minus minimum of finite samples.',
  },
  {
    operation: 'area',
    name: 'Area (integral)',
    group: 'Spread',
    result: 'area',
    tag: '∫',
    description:
      'Trapezoidal integral over valid intervals; missing intervals are excluded. The unit includes seconds.',
  },
  {
    operation: 'duration',
    name: 'Duration',
    group: 'Time',
    result: 'time',
    tag: 'dur',
    description:
      "The input's length in seconds, from its start to its end. Useful for segments.",
  },
  {
    operation: 'time-of-minimum',
    name: 'Time of minimum',
    group: 'Time',
    result: 'time',
    tag: 't(min)',
    description:
      "Seconds from the input's start to the first lowest finite sample.",
  },
  {
    operation: 'time-of-maximum',
    name: 'Time of maximum',
    group: 'Time',
    result: 'time',
    tag: 't(max)',
    description:
      "Seconds from the input's start to the first highest finite sample.",
  },
  {
    operation: 'time-above',
    name: 'Time above',
    group: 'Time',
    result: 'time',
    tag: 't>',
    parameters: ['threshold'],
    description:
      'Total seconds strictly above a threshold, interpolating crossings linearly between adjacent finite samples. Missing intervals are excluded.',
  },
  {
    operation: 'time-below',
    name: 'Time below',
    group: 'Time',
    result: 'time',
    tag: 't<',
    parameters: ['threshold'],
    description:
      'Total seconds strictly below a threshold, interpolating crossings linearly between adjacent finite samples. Missing intervals are excluded.',
  },
  {
    operation: 'first-crossing',
    name: 'First crossing',
    group: 'Events',
    result: 'time',
    tag: 't×',
    parameters: ['threshold', 'edge', 'hysteresis', 'debounce'],
    description:
      "Seconds from the input's start to the first rising or falling crossing of a threshold, as segmentation triggers detect it. Unavailable when it never crosses.",
  },
  {
    operation: 'crossing-count',
    name: 'Crossing count',
    group: 'Events',
    result: 'count',
    tag: '#×',
    parameters: ['threshold', 'edge', 'hysteresis', 'debounce'],
    description:
      'The number of rising or falling crossings of a threshold. Missing samples break adjacency, so a gap never counts as a crossing. Hysteresis and debounce ignore chatter around the threshold.',
  },
];

/**
 * Arithmetic over values rather than a statistic of a signal, so it is not
 * listed with VALUE_FUNCTIONS. Its unit is chosen, never inferred.
 */
export const CALCULATE: ValueFunctionSpec = {
  operation: 'calculate',
  name: 'Calculate',
  group: 'Math',
  result: 'level',
  tag: '=',
  description:
    'A formula over calculated values: a is each input value, other lowercase names are values matched to it by segment and lineage. Unavailable when any value it uses is unavailable or the result is not finite.',
};

export const valueSpec = (operation: string) =>
  operation === 'calculate'
    ? CALCULATE
    : VALUE_FUNCTIONS.find((spec) => spec.operation === operation);

/** The unit of a value calculated from an input with `unit`. */
export function valueUnit(operation: ValueOperation, unit: string): string {
  switch (valueSpec(operation)?.result) {
    case 'area':
      return unit ? `${/[·×/]/.test(unit) ? `(${unit})` : unit}·s` : 's';
    case 'time':
      return 's';
    case 'count':
      return '';
    default:
      return unit;
  }
}

/** Default and validated settings for a value calculation. */
export function valueParameters(
  operation: ValueOperation,
  parameters: ValueParameters = {},
): ValueParameters {
  const spec = valueSpec(operation);
  if (!spec) throw new Error('Choose a supported value calculation.');
  const result: ValueParameters = {};
  for (const name of spec.parameters ?? []) {
    const value = parameters[name];
    if (name === 'edge') {
      const edge = value ?? 1;
      if (edge !== 1 && edge !== -1)
        throw new Error('Choose a rising or falling edge.');
      result.edge = edge;
    } else if (name === 'hysteresis' || name === 'debounce') {
      // Optional noise settings: zero is the default and is not stored.
      if (value === undefined || value === 0) continue;
      if (!Number.isFinite(value) || value < 0)
        throw new Error(
          `${name === 'hysteresis' ? 'Hysteresis' : 'Debounce'} must be zero or positive.`,
        );
      result[name] = value;
    } else if (name === 'time') {
      const time = value ?? 0;
      if (!Number.isFinite(time) || time < 0)
        throw new Error(
          "Enter a time of 0 s or later, measured from the input's start.",
        );
      result.time = time;
    } else {
      if (value === undefined || !Number.isFinite(value))
        throw new Error('Enter a finite threshold.');
      result.threshold = value;
    }
  }
  for (const name of Object.keys(parameters))
    if (!spec.parameters?.includes(name as ValueParameter))
      throw new Error(`${spec.name} has no "${name}" setting.`);
  return result;
}

/** "Time above 1500 rpm" — a calculation and its settings, for names. */
export function valueTitle(
  operation: ValueOperation,
  parameters: ValueParameters = {},
  unit = '',
  /** A calculation from values: its formula. */
  expression?: string,
): string {
  if (operation === 'calculate')
    return expression ? `Calculate ${expression}` : CALCULATE.name;
  const spec = valueSpec(operation);
  const name = spec?.name ?? operation;
  const quantity = (value: number, suffix: string) =>
    `${Number(value.toPrecision(6))}${suffix ? ` ${suffix}` : ''}`;
  const edge = parameters.edge === -1 ? 'falling' : 'rising';
  switch (operation) {
    case 'value-at':
      return parameters.time === undefined
        ? name
        : `Value at ${quantity(parameters.time, 's')}`;
    case 'time-above':
    case 'time-below':
      return parameters.threshold === undefined
        ? name
        : `${name} ${quantity(parameters.threshold, unit)}`;
    case 'first-crossing':
      return parameters.threshold === undefined
        ? name
        : `First ${edge} crossing of ${quantity(parameters.threshold, unit)}`;
    case 'crossing-count':
      return parameters.threshold === undefined
        ? name
        : `${edge[0].toUpperCase()}${edge.slice(1)} crossings of ${quantity(parameters.threshold, unit)}`;
    default:
      return name;
  }
}

/**
 * The value an operation stores, from statistics of its input. Elapsed
 * results are measured from the input's start; a parameterised calculation
 * reads the `result` evaluated with the same statistics.
 */
export function statisticValue(
  statistics: ValueStatistics,
  operation: ValueOperation,
): number | null {
  const elapsed = (time: number | undefined) =>
    time === undefined || statistics.start === undefined
      ? null
      : time - statistics.start;
  switch (operation) {
    case 'minimum':
      return statistics.minimum;
    case 'maximum':
      return statistics.maximum;
    case 'sample-average':
      return statistics.sampleAverage;
    case 'time-average':
      return statistics.timeAverage;
    case 'rms':
      return statistics.rms ?? null;
    case 'standard-deviation':
      return statistics.standardDeviation ?? null;
    case 'peak-to-peak':
      return statistics.minimum === null || statistics.maximum === null
        ? null
        : statistics.maximum - statistics.minimum;
    case 'start-value':
      return statistics.startValue ?? null;
    case 'end-value':
      return statistics.endValue ?? null;
    case 'area':
      return statistics.integral ?? null;
    case 'duration':
      return statistics.start === undefined || statistics.end === undefined
        ? null
        : statistics.end - statistics.start;
    case 'time-of-minimum':
      return elapsed(statistics.minimumTime);
    case 'time-of-maximum':
      return elapsed(statistics.maximumTime);
    default:
      return statistics.result?.operation === operation
        ? statistics.result.value
        : null;
  }
}

/** The time a value refers to on its input's axis, for plot markers. */
export function statisticTime(
  statistics: ValueStatistics,
  operation: ValueOperation,
): number | undefined {
  switch (operation) {
    case 'minimum':
    case 'time-of-minimum':
      return statistics.minimumTime;
    case 'maximum':
    case 'time-of-maximum':
      return statistics.maximumTime;
    case 'start-value':
      return statistics.startTime;
    case 'end-value':
      return statistics.endTime;
    default:
      return statistics.result?.operation === operation
        ? statistics.result.timestamp
        : undefined;
  }
}
