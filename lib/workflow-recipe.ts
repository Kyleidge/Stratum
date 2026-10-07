import { FUNCTIONS } from './signal-functions';
import { isBinaryOperation } from './signal-arithmetic';
import { VALUE_FUNCTIONS, valueParameters, valueSpec } from './workflow-types';
import { BINDABLE_DERIVE, BINDABLE_VALUE } from './value-bindings';
import { compileFormula, MAX_FORMULA_LENGTH } from './formula';
import type {
  CheckDefinition,
  ParameterBindings,
  ValueBinding,
  ValueOperation,
  ValueParameters,
} from './workflow-types';
import type {
  EdgeTrigger,
  Operation,
  SegmentationDefinition,
  SegmentationScope,
} from './signal-types';
import type { TimeAnchor, TimeSettings } from './time-types';
import type { WorkflowCommand } from './workflow-lifecycle';
import {
  parseYaml,
  stringifyYaml,
  YamlError,
  type YamlMap,
  type YamlValue,
} from './workflow-yaml';
import {
  readTemplate,
  templateRefs,
  templateYaml,
  type ReportTemplate,
} from './workflow-report-template';

export const WORKFLOW_FORMAT = 'stratum-workflow';
export const WORKFLOW_VERSION = 1;
export const WORKFLOW_EXTENSION = '.stratum.yaml';
export const MAX_RECIPE_STEPS = 500;

/**
 * A reference is a channel alias or step ID, optionally with a 1-based output
 * position: `torque`, `sweeps` (every output) or `sweeps[2]`.
 */
export type RecipeRef = string;
export type TimeOrigin = 'recording' | 'recording-start' | 'input-start';
/** ID fields hold references until a run binds them. */
export type RecipeOperation =
  | {
      kind: 'derive';
      operation: Operation;
      inputs: RecipeRef[];
      /** Ignored (0) while `bindings.value` sets it from values. */
      parameter: number;
      with?: RecipeRef;
      bindings?: ParameterBindings;
      /** A formula's output unit, or a conversion's target unit. */
      unit?: string;
      /** A formula; `signals` holds each letter's references. */
      formula?: { expression: string; signals?: Record<string, RecipeRef[]> };
    }
  | {
      kind: 'segment';
      inputs: RecipeRef[];
      definition: SegmentationDefinition;
      independently: boolean;
      scope?: SegmentationScope;
      timeOrigin: TimeOrigin;
    }
  | {
      kind: 'value';
      operation: ValueOperation;
      inputs: RecipeRef[];
      /** Bound settings hold 0 until a run resolves `bindings`. */
      parameters?: ValueParameters;
      bindings?: ParameterBindings;
    }
  | { kind: 'time'; settings: TimeSettings };
export type RecipeStep = {
  id: string;
  name?: string;
  /** One label per output; `{n}`, `{input}` and `{item}` are replaced. */
  outputs?: string | (string | null)[];
  checks?: CheckDefinition[];
  onFail: 'continue' | 'stop';
  operation: RecipeOperation;
};
export type RecipeChannel = { alias: string; name: string; unit?: string };
export type WorkflowRecipe = {
  name: string;
  revision?: string;
  description?: string;
  item: { label: string; pattern?: string };
  channels: RecipeChannel[];
  steps: RecipeStep[];
  report?: ReportTemplate;
};

export class WorkflowFileError extends Error {
  constructor(
    message: string,
    readonly line = 0,
  ) {
    super(line > 0 ? `Line ${line}: ${message}` : message);
  }
}
/** A reference that cannot be resolved for one item; its step is skipped. */
export class BlockedReference extends Error {}

const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const REF = /^([a-z][a-z0-9-]{0,63})(?:\[([1-9][0-9]{0,5})\])?$/;

export function parseRef(ref: string): { name: string; position?: number } {
  const match = ref.match(REF);
  if (!match) throw new Error(`"${ref}" is not a valid reference.`);
  return {
    name: match[1],
    ...(match[2] ? { position: Number(match[2]) } : {}),
  };
}

export const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(?=[0-9])/, 'n-')
    .slice(0, 48)
    .replace(/-+$/, '') || 'step';

/** References to value steps whose results set this step's settings. */
export function bindingRefs(operation: RecipeOperation): RecipeRef[] {
  const bindings =
    operation.kind === 'segment'
      ? operation.definition.bindings
      : operation.kind === 'time'
        ? undefined
        : operation.bindings;
  return Object.values(bindings ?? {}).flatMap((binding) => binding.valueIds);
}

function refsOf(operation: RecipeOperation): RecipeRef[] {
  const triggers = (definition: SegmentationDefinition) =>
    definition.method === 'triggers'
      ? [definition.start.signalId, definition.end.signalId]
      : [];
  switch (operation.kind) {
    case 'derive':
      return [
        ...operation.inputs,
        ...(operation.with ? [operation.with] : []),
        ...Object.values(operation.formula?.signals ?? {}).flat(),
        ...bindingRefs(operation),
      ];
    case 'segment':
      return [
        ...operation.inputs,
        ...triggers(operation.definition),
        ...bindingRefs(operation),
      ];
    case 'value':
      return [...operation.inputs, ...bindingRefs(operation)];
    case 'time': {
      const settings = operation.settings;
      if (settings.kind === 'align')
        return settings.groups.flatMap((group) => [
          ...group.inputIds,
          ...[group.anchor, group.secondAnchor].flatMap((anchor) =>
            anchor?.kind === 'event' ? [anchor.trigger.signalId] : [],
          ),
        ]);
      return [
        ...settings.inputIds,
        ...(settings.kind === 'resample' && settings.grid.kind === 'reference'
          ? [settings.grid.signalId]
          : []),
      ];
    }
  }
}

/** Every reference in a step, including triggers and second inputs. */
export function stepRefs(step: RecipeStep): RecipeRef[] {
  return refsOf(step.operation);
}

// ---------------------------------------------------------------------------
// Reading a workflow file

class Reader {
  constructor(private lines: WeakMap<object, number>) {}
  private last = 0;
  line(at?: object) {
    if (at && this.lines.has(at)) this.last = this.lines.get(at)!;
    return this.last;
  }
  fail(message: string, at?: object): never {
    throw new WorkflowFileError(message, this.line(at));
  }
  map(value: YamlValue | undefined, context: string): YamlMap {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      this.fail(`${context} must be a mapping.`);
    this.line(value);
    return value;
  }
  keys(map: YamlMap, allowed: string[], context: string) {
    for (const key of Object.keys(map))
      if (!allowed.includes(key))
        this.fail(
          `${context}: unknown setting "${key}". Expected ${allowed.join(', ')}.`,
          map,
        );
  }
  text(
    value: YamlValue | undefined,
    context: string,
    max: number,
    at?: object,
  ): string {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      this.fail(`${context} must be text of 1–${max} characters.`, at);
    return value;
  }
  optionalText(
    value: YamlValue | undefined,
    context: string,
    max: number,
    at?: object,
  ): string | undefined {
    return value === undefined || value === null
      ? undefined
      : this.text(value, context, max, at);
  }
  number(value: YamlValue | undefined, context: string, at?: object): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.fail(`${context} must be a finite number.`, at);
    return value;
  }
  optionalNumber(
    value: YamlValue | undefined,
    context: string,
    at?: object,
  ): number | undefined {
    return value === undefined || value === null
      ? undefined
      : this.number(value, context, at);
  }
  boolean(
    value: YamlValue | undefined,
    context: string,
    fallback: boolean,
    at?: object,
  ): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean')
      this.fail(`${context} must be true or false.`, at);
    return value;
  }
  choice<T extends string>(
    value: YamlValue | undefined,
    choices: readonly T[],
    context: string,
    fallback?: T,
    at?: object,
  ): T {
    if ((value === undefined || value === null) && fallback !== undefined)
      return fallback;
    if (typeof value !== 'string' || !choices.includes(value as T))
      this.fail(`${context} must be one of: ${choices.join(', ')}.`, at);
    return value as T;
  }
  ref(value: YamlValue | undefined, context: string, at?: object): RecipeRef {
    if (typeof value !== 'string' || !REF.test(value))
      this.fail(
        `${context} must reference a channel or step, such as torque or sweeps[2].`,
        at,
      );
    return value;
  }
  /**
   * A number, or `{ value: step, factor: k }` taking it from values (the
   * value step's references, held until a run binds them).
   */
  setting(
    value: YamlValue | undefined,
    context: string,
    at?: object,
  ): number | ValueBinding {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const map = this.map(value, context);
      this.keys(map, ['value', 'factor'], context);
      return {
        valueIds: this.refs(map.value, `${context} value`, map),
        factor: this.optionalNumber(map.factor, `${context} factor`, map) ?? 1,
      };
    }
    return this.number(value, context, at);
  }
  refs(
    value: YamlValue | undefined,
    context: string,
    at?: object,
  ): RecipeRef[] {
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || !list.length || list.length > 10_000)
      this.fail(`${context} must list at least one reference.`, at);
    this.line(list);
    return list.map((item) => this.ref(item, context, at));
  }
}

function readInputs(
  reader: Reader,
  map: YamlMap,
  context: string,
): RecipeRef[] {
  if (map.input !== undefined && map.inputs !== undefined)
    reader.fail(`${context}: use either input or inputs.`, map);
  return reader.refs(map.inputs ?? map.input, `${context} inputs`, map);
}

function readTrigger(
  reader: Reader,
  value: YamlValue | undefined,
  context: string,
  /** Receives settings taken from values; without it they are rejected. */
  bind?: (setting: 'threshold' | 'offset', binding: ValueBinding) => void,
): EdgeTrigger {
  const map = reader.map(value, context);
  reader.keys(
    map,
    ['signal', 'edge', 'threshold', 'offset', 'hysteresis', 'debounce'],
    context,
  );
  const noise = (setting: 'hysteresis' | 'debounce') => {
    const read = reader.optionalNumber(
      map[setting],
      `${context} ${setting}`,
      map,
    );
    if (read !== undefined && read < 0)
      reader.fail(`${context} ${setting} cannot be negative.`, map);
    return read ? { [setting]: read } : {};
  };
  const number = (setting: 'threshold' | 'offset', fallback?: number) => {
    const raw = map[setting];
    if (raw === undefined || raw === null) {
      if (fallback === undefined)
        reader.fail(`${context} ${setting} must be a finite number.`, map);
      return fallback;
    }
    const read = bind
      ? reader.setting(raw, `${context} ${setting}`, map)
      : reader.number(raw, `${context} ${setting}`, map);
    if (typeof read === 'number') return read;
    bind!(setting, read);
    return 0;
  };
  return {
    signalId: reader.ref(map.signal, `${context} signal`, map),
    edge: reader.choice(
      map.edge,
      ['rising', 'falling'],
      `${context} edge`,
      undefined,
      map,
    ),
    threshold: number('threshold'),
    offset: number('offset', 0),
    ...noise('hysteresis'),
    ...noise('debounce'),
  };
}

function readSegment(
  reader: Reader,
  map: YamlMap,
  context: string,
): RecipeOperation {
  reader.keys(
    map,
    [
      'input',
      'inputs',
      'ranges',
      'windows',
      'triggers',
      'boundary',
      'independently',
      'scope',
      'time-origin',
    ],
    context,
  );
  const methods = ['ranges', 'windows', 'triggers'].filter(
    (key) => map[key] !== undefined,
  );
  if (methods.length !== 1)
    reader.fail(
      `${context} needs exactly one of ranges, windows or triggers.`,
      map,
    );
  const boundary = reader.choice(
    map.boundary,
    ['clip', 'discard'],
    `${context} boundary`,
    'clip',
    map,
  );
  let definition: SegmentationDefinition;
  if (map.ranges !== undefined) {
    const ranges = map.ranges;
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1000)
      reader.fail(
        `${context} ranges must list 1–1,000 [start, end] pairs.`,
        map,
      );
    definition = {
      method: 'ranges',
      boundary,
      ranges: ranges.map((range) => {
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          typeof range[0] !== 'number' ||
          typeof range[1] !== 'number' ||
          !Number.isFinite(range[0]) ||
          !Number.isFinite(range[1]) ||
          range[1] <= range[0]
        )
          reader.fail(
            `${context}: each range needs a start and a later end.`,
            map,
          );
        return [range[0], range[1]] as [number, number];
      }),
    };
  } else if (map.windows !== undefined) {
    const windows = reader.map(map.windows, `${context} windows`);
    reader.keys(
      windows,
      ['start', 'end', 'duration', 'step', 'partial'],
      `${context} windows`,
    );
    definition = {
      method: 'windows',
      boundary,
      start: reader.number(windows.start, `${context} windows start`, windows),
      end: reader.number(windows.end, `${context} windows end`, windows),
      duration: reader.number(
        windows.duration,
        `${context} windows duration`,
        windows,
      ),
      step: reader.number(windows.step, `${context} windows step`, windows),
      includePartial: reader.boolean(
        windows.partial,
        `${context} windows partial`,
        false,
        windows,
      ),
    };
    if (
      definition.end <= definition.start ||
      definition.duration <= 0 ||
      definition.step <= 0
    )
      reader.fail(
        `${context}: windows need a later end and a positive duration and step.`,
        windows,
      );
  } else {
    const triggers = reader.map(map.triggers, `${context} triggers`);
    reader.keys(
      triggers,
      ['start', 'end', 'minimum-duration'],
      `${context} triggers`,
    );
    const minimum =
      reader.optionalNumber(
        triggers['minimum-duration'],
        `${context} minimum-duration`,
        triggers,
      ) ?? 0;
    if (minimum < 0)
      reader.fail(`${context}: minimum-duration cannot be negative.`, triggers);
    const bindings: ParameterBindings = {};
    definition = {
      method: 'triggers',
      boundary,
      start: readTrigger(
        reader,
        triggers.start,
        `${context} start trigger`,
        (setting, binding) => (bindings[`start.${setting}`] = binding),
      ),
      end: readTrigger(
        reader,
        triggers.end,
        `${context} end trigger`,
        (setting, binding) => (bindings[`end.${setting}`] = binding),
      ),
      minimumDuration: minimum,
      ...(Object.keys(bindings).length ? { bindings } : {}),
    };
  }
  const timeOrigin = reader.choice(
    map['time-origin'],
    ['recording', 'recording-start', 'input-start'],
    `${context} time-origin`,
    'recording',
    map,
  );
  if (definition.method === 'triggers' && timeOrigin !== 'recording')
    reader.fail(
      `${context}: time-origin applies to ranges and windows; trigger offsets are already relative.`,
      map,
    );
  const scope =
    map.scope === undefined || map.scope === null
      ? undefined
      : reader.choice(
          map.scope,
          ['file', 'signals'],
          `${context} scope`,
          undefined,
          map,
        );
  return {
    kind: 'segment',
    inputs: readInputs(reader, map, context),
    definition,
    independently: reader.boolean(
      map.independently,
      `${context} independently`,
      false,
      map,
    ),
    ...(scope ? { scope } : {}),
    timeOrigin,
  };
}

function readAnchor(
  reader: Reader,
  value: YamlValue | undefined,
  context: string,
): TimeAnchor {
  const map = reader.map(value, context);
  const kind = reader.choice(
    map.kind,
    ['point', 'start', 'event'],
    `${context} kind`,
    undefined,
    map,
  );
  if (kind === 'start') {
    reader.keys(map, ['kind'], context);
    return { kind };
  }
  if (kind === 'point') {
    reader.keys(map, ['kind', 'time'], context);
    return { kind, time: reader.number(map.time, `${context} time`, map) };
  }
  reader.keys(map, ['kind', 'trigger', 'occurrence'], context);
  const occurrence =
    reader.optionalNumber(map.occurrence, `${context} occurrence`, map) ?? 1;
  if (!Number.isSafeInteger(occurrence) || occurrence < 1)
    reader.fail(`${context} occurrence must be a positive whole number.`, map);
  return {
    kind,
    trigger: readTrigger(reader, map.trigger, `${context} trigger`),
    occurrence,
  };
}

function readTime(
  reader: Reader,
  map: YamlMap,
  context: string,
): RecipeOperation {
  const kinds = ['align', 'resample', 'combine', 'crop'] as const;
  const present = kinds.filter((kind) => map[kind] !== undefined);
  reader.keys(map, [...kinds], context);
  if (present.length !== 1)
    reader.fail(
      `${context} needs exactly one of align, resample, combine or crop.`,
      map,
    );
  const kind = present[0];
  const body = reader.map(map[kind], `${context} ${kind}`);
  const where = `${context} ${kind}`;
  let settings: TimeSettings;
  if (kind === 'crop') {
    reader.keys(body, ['inputs', 'input', 'start', 'end'], where);
    settings = {
      kind,
      inputIds: readInputs(reader, body, where),
      start: reader.number(body.start, `${where} start`, body),
      end: reader.number(body.end, `${where} end`, body),
    };
  } else if (kind === 'combine') {
    reader.keys(body, ['inputs', 'operator'], where);
    const inputs = reader.refs(body.inputs, `${where} inputs`, body);
    if (inputs.length !== 2) reader.fail(`${where} needs two inputs.`, body);
    settings = {
      kind,
      inputIds: [inputs[0], inputs[1]],
      operator: reader.choice(
        body.operator,
        ['difference', 'sum', 'product', 'ratio'],
        `${where} operator`,
        undefined,
        body,
      ),
    };
  } else if (kind === 'resample') {
    reader.keys(
      body,
      ['inputs', 'input', 'grid', 'interpolation', 'max-gap', 'filter'],
      where,
    );
    const grid = reader.map(body.grid, `${where} grid`);
    const gridKind = reader.choice(
      grid.kind,
      ['uniform', 'reference'],
      `${where} grid kind`,
      undefined,
      grid,
    );
    reader.keys(
      grid,
      gridKind === 'uniform'
        ? ['kind', 'start', 'end', 'rate']
        : ['kind', 'signal', 'start', 'end'],
      `${where} grid`,
    );
    const filter =
      body.filter === undefined || body.filter === null
        ? undefined
        : reader.map(body.filter, `${where} filter`);
    if (filter)
      reader.keys(filter, ['cutoff', 'half-width'], `${where} filter`);
    settings = {
      kind,
      inputIds: readInputs(reader, body, where),
      grid:
        gridKind === 'uniform'
          ? {
              kind: gridKind,
              start: reader.number(grid.start, `${where} grid start`, grid),
              end: reader.number(grid.end, `${where} grid end`, grid),
              rate: reader.number(grid.rate, `${where} grid rate`, grid),
            }
          : {
              kind: gridKind,
              signalId: reader.ref(grid.signal, `${where} grid signal`, grid),
              start: reader.number(grid.start, `${where} grid start`, grid),
              end: reader.number(grid.end, `${where} grid end`, grid),
            },
      interpolation: reader.choice(
        body.interpolation,
        ['linear', 'previous', 'nearest'],
        `${where} interpolation`,
        'linear',
        body,
      ),
      maxGap: reader.number(body['max-gap'], `${where} max-gap`, body),
      ...(filter
        ? {
            filter: {
              cutoff: reader.number(
                filter.cutoff,
                `${where} filter cutoff`,
                filter,
              ),
              halfWidth: reader.number(
                filter['half-width'],
                `${where} filter half-width`,
                filter,
              ),
            },
          }
        : {}),
    };
  } else {
    reader.keys(
      body,
      ['reference', 'target', 'second-target', 'groups'],
      where,
    );
    const reference = reader.map(body.reference, `${where} reference`);
    reader.keys(reference, ['name', 'kind'], `${where} reference`);
    const groups = body.groups;
    if (!Array.isArray(groups) || !groups.length || groups.length > 100)
      reader.fail(`${where} needs 1–100 groups.`, body);
    const secondTarget = reader.optionalNumber(
      body['second-target'],
      `${where} second-target`,
      body,
    );
    settings = {
      kind,
      reference: {
        id: '',
        name: reader.text(
          reference.name,
          `${where} reference name`,
          120,
          reference,
        ),
        kind: reader.choice(
          reference.kind,
          ['relative', 'absolute'],
          `${where} reference kind`,
          'relative',
          reference,
        ),
      },
      target: reader.number(body.target, `${where} target`, body),
      ...(secondTarget !== undefined ? { secondTarget } : {}),
      groups: groups.map((raw, index) => {
        const group = reader.map(raw, `${where} group ${index + 1}`);
        reader.keys(
          group,
          ['inputs', 'input', 'anchor', 'second-anchor'],
          `${where} group ${index + 1}`,
        );
        return {
          inputIds: readInputs(reader, group, `${where} group ${index + 1}`),
          anchor: readAnchor(
            reader,
            group.anchor,
            `${where} group ${index + 1} anchor`,
          ),
          ...(group['second-anchor'] !== undefined
            ? {
                secondAnchor: readAnchor(
                  reader,
                  group['second-anchor'],
                  `${where} group ${index + 1} second-anchor`,
                ),
              }
            : {}),
        };
      }),
    };
  }
  return { kind: 'time', settings };
}

function readChecks(
  reader: Reader,
  value: YamlValue | undefined,
  context: string,
): CheckDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 50)
    reader.fail(`${context} checks must be a list of at most 50.`);
  return value.map((raw, index) => {
    const where = `${context} check ${index + 1}`;
    const map = reader.map(raw, where);
    const kinds = ['count', 'limits', 'missing', 'duration'] as const;
    reader.keys(map, [...kinds, 'severity', 'message', 'outputs'], where);
    const present = kinds.filter((kind) => map[kind] !== undefined);
    if (present.length !== 1)
      reader.fail(
        `${where} needs exactly one of count, limits, missing or duration.`,
        map,
      );
    const kind = present[0];
    reader.keys(map, [kind, 'severity', 'message', 'outputs'], where);
    const check: CheckDefinition = {
      kind,
      severity: reader.choice(
        map.severity,
        ['warning', 'fail'],
        `${where} severity`,
        'fail',
        map,
      ),
    };
    const body = map[kind];
    if (kind === 'count' && typeof body === 'number') {
      check.min = check.max = body;
    } else {
      const limits = reader.map(body, `${where} ${kind}`);
      reader.keys(
        limits,
        kind === 'limits' ? ['min', 'max', 'unit'] : ['min', 'max'],
        `${where} ${kind}`,
      );
      check.min = reader.optionalNumber(limits.min, `${where} min`, limits);
      check.max = reader.optionalNumber(limits.max, `${where} max`, limits);
      if (kind === 'limits')
        check.unit = reader.optionalText(
          limits.unit,
          `${where} unit`,
          60,
          limits,
        );
      if (check.unit === undefined) delete check.unit;
    }
    if (check.min === undefined && check.max === undefined)
      reader.fail(`${where} needs a min or max.`, map);
    if (check.min === undefined) delete check.min;
    if (check.max === undefined) delete check.max;
    if (
      check.min !== undefined &&
      check.max !== undefined &&
      check.min > check.max
    )
      reader.fail(`${where}: min cannot exceed max.`, map);
    if (
      kind === 'count' &&
      [check.min, check.max].some(
        (limit) =>
          limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0),
      )
    )
      reader.fail(`${where}: counts must be whole numbers.`, map);
    if (
      kind === 'missing' &&
      [check.min, check.max].some(
        (limit) => limit !== undefined && (limit < 0 || limit > 1),
      )
    )
      reader.fail(`${where}: missing is a fraction between 0 and 1.`, map);
    if (map.message !== undefined)
      check.message = reader.text(map.message, `${where} message`, 300, map);
    if (map.outputs !== undefined) {
      if (kind === 'count')
        reader.fail(`${where}: count checks apply to the whole step.`, map);
      const outputs = map.outputs;
      if (
        !Array.isArray(outputs) ||
        !outputs.length ||
        outputs.length > 1000 ||
        !outputs.every(
          (item) =>
            typeof item === 'number' && Number.isSafeInteger(item) && item >= 1,
        )
      )
        reader.fail(
          `${where} outputs must list positions such as [1, 3].`,
          map,
        );
      check.outputs = [...new Set(outputs as number[])];
    }
    return check;
  });
}

/** Checks that make sense for a step's kind of output. */
export function checkAllowed(
  kind: CheckDefinition['kind'],
  outputs: 'signals' | 'values',
): boolean {
  return kind === 'count' || kind === 'limits' || outputs === 'signals';
}

/** A formula derive: expression, unit, other signals and values by name. */
function readFormula(
  reader: Reader,
  body: YamlMap,
  context: string,
): RecipeOperation {
  reader.keys(
    body,
    ['function', 'input', 'inputs', 'expression', 'unit', 'signals', 'values'],
    context,
  );
  const expression = reader.text(
    body.expression,
    `${context} expression`,
    MAX_FORMULA_LENGTH,
    body,
  );
  let formula;
  try {
    formula = compileFormula(expression);
  } catch (error) {
    reader.fail(
      `${context} expression: ${error instanceof Error ? error.message : 'invalid formula'}.`,
      body,
    );
  }
  const named = (key: 'signals' | 'values', expected: string[]) => {
    const raw = body[key];
    const map =
      raw === undefined || raw === null
        ? {}
        : reader.map(raw, `${context} ${key}`);
    reader.keys(map, expected, `${context} ${key}`);
    for (const name of expected)
      if (map[name] === undefined || map[name] === null)
        reader.fail(
          `${context}: the formula uses ${name}; list it under ${key}.`,
          body,
        );
    return Object.fromEntries(
      expected.map((name) => [
        name,
        reader.refs(map[name], `${context} ${key} ${name}`, map),
      ]),
    );
  };
  const signals = named('signals', formula.signals.slice(1));
  const values = named('values', formula.values);
  return {
    kind: 'derive',
    operation: 'formula',
    inputs: readInputs(reader, body, context),
    parameter: 0,
    unit: reader.optionalText(body.unit, `${context} unit`, 40, body) ?? '',
    formula: {
      expression,
      ...(Object.keys(signals).length ? { signals } : {}),
    },
    ...(formula.values.length
      ? {
          bindings: Object.fromEntries(
            Object.entries(values).map(([name, refs]) => [
              name,
              { valueIds: refs, factor: 1 },
            ]),
          ),
        }
      : {}),
  };
}

function readStep(reader: Reader, raw: YamlValue, index: number): RecipeStep {
  const map = reader.map(raw, `Step ${index + 1}`);
  const id = map.id;
  if (typeof id !== 'string' || !SLUG.test(id))
    reader.fail(
      `Step ${index + 1} needs an id of lowercase letters, digits and dashes.`,
      map,
    );
  const context = `Step "${id}"`;
  const kinds = ['derive', 'segment', 'value', 'time'] as const;
  const present = kinds.filter((kind) => map[kind] !== undefined);
  if (present.length !== 1)
    reader.fail(
      `${context} needs exactly one of derive, segment, value or time.`,
      map,
    );
  reader.keys(
    map,
    ['id', 'name', 'outputs', 'checks', 'on-fail', present[0]],
    context,
  );
  const body = reader.map(map[present[0]], `${context} ${present[0]}`);
  let operation: RecipeOperation;
  if (present[0] === 'derive' && body.function === 'formula')
    operation = readFormula(reader, body, context);
  else if (present[0] === 'derive' && body.function === 'convert') {
    reader.keys(body, ['function', 'input', 'inputs', 'unit'], context);
    operation = {
      kind: 'derive',
      operation: 'convert',
      inputs: readInputs(reader, body, context),
      parameter: 0,
      unit: reader.text(body.unit, `${context} unit`, 40, body),
    };
  } else if (present[0] === 'derive') {
    reader.keys(
      body,
      ['function', 'input', 'inputs', 'parameter', 'with'],
      context,
    );
    const name = body.function;
    const spec = FUNCTIONS.find(
      (item) => item.operation === name && item.operation !== 'segment',
    );
    if (!spec)
      reader.fail(
        `${context}: unknown function ${JSON.stringify(name)}. Use one of ${FUNCTIONS.filter(
          (item) => item.operation !== 'segment',
        )
          .map((item) => item.operation)
          .join(', ')}.`,
        body,
      );
    const binary = isBinaryOperation(spec.operation);
    if (binary !== (body.with !== undefined))
      reader.fail(
        binary
          ? `${context}: ${spec.operation} needs a second input in "with".`
          : `${context}: ${spec.operation} takes one input; remove "with".`,
        body,
      );
    const setting =
      body.parameter === undefined || body.parameter === null
        ? spec.defaultValue
        : BINDABLE_DERIVE[spec.operation as Operation]
          ? reader.setting(body.parameter, `${context} parameter`, body)
          : reader.number(body.parameter, `${context} parameter`, body);
    const parameter = typeof setting === 'number' ? setting : 0;
    if (
      typeof setting === 'number' &&
      ((spec.min !== undefined && parameter < spec.min) ||
        (spec.max !== undefined && parameter > spec.max))
    )
      reader.fail(
        `${context}: ${spec.parameter || 'parameter'} must be ${spec.min ?? '-∞'}–${spec.max ?? '∞'}.`,
        body,
      );
    operation = {
      kind: 'derive',
      operation: spec.operation as Operation,
      inputs: readInputs(reader, body, context),
      parameter,
      ...(binary
        ? { with: reader.ref(body.with, `${context} with`, body) }
        : {}),
      ...(typeof setting === 'number' ? {} : { bindings: { value: setting } }),
    };
  } else if (present[0] === 'segment') {
    operation = readSegment(reader, body, context);
  } else if (present[0] === 'value') {
    const function_ = reader.choice(
      body.function,
      VALUE_FUNCTIONS.map((item) => item.operation),
      `${context} function`,
      undefined,
      body,
    );
    const settings = valueSpec(function_)?.parameters ?? [];
    reader.keys(body, ['function', 'input', 'inputs', ...settings], context);
    const raw: ValueParameters = {};
    const bindings: ParameterBindings = {};
    for (const name of settings) {
      if (body[name] === undefined || body[name] === null) continue;
      if (name === 'edge') {
        raw.edge =
          reader.choice(
            body.edge,
            ['rising', 'falling'] as const,
            `${context} edge`,
            undefined,
            body,
          ) === 'falling'
            ? -1
            : 1;
        continue;
      }
      const setting = BINDABLE_VALUE[name]
        ? reader.setting(body[name], `${context} ${name}`, body)
        : reader.number(body[name], `${context} ${name}`, body);
      // A bound setting holds 0 until a run resolves its value.
      raw[name] = typeof setting === 'number' ? setting : 0;
      if (typeof setting !== 'number') bindings[name] = setting;
    }
    let parameters: ValueParameters;
    try {
      parameters = valueParameters(function_, raw);
    } catch (error) {
      reader.fail(
        `${context}: ${error instanceof Error ? error.message : 'invalid settings.'}`,
        body,
      );
    }
    operation = {
      kind: 'value',
      operation: function_,
      inputs: readInputs(reader, body, context),
      ...(settings.length ? { parameters } : {}),
      ...(Object.keys(bindings).length ? { bindings } : {}),
    };
  } else operation = readTime(reader, body, context);
  let outputs: RecipeStep['outputs'];
  if (typeof map.outputs === 'string')
    outputs = reader.text(map.outputs, `${context} outputs`, 160, map);
  else if (Array.isArray(map.outputs)) {
    if (map.outputs.length > 10_000)
      reader.fail(`${context} lists too many output names.`, map);
    outputs = map.outputs.map((item) =>
      item === null
        ? null
        : reader.text(item, `${context} output name`, 160, map),
    );
  } else if (map.outputs !== undefined && map.outputs !== null)
    reader.fail(`${context} outputs must be a name or a list of names.`, map);
  const checks = readChecks(reader, map.checks, context);
  if (checks)
    for (const check of checks)
      if (
        !checkAllowed(
          check.kind,
          operation.kind === 'value' ? 'values' : 'signals',
        )
      )
        reader.fail(
          `${context}: ${check.kind} checks apply to signals, not values.`,
          map,
        );
  return {
    id,
    ...(map.name !== undefined && map.name !== null
      ? { name: reader.text(map.name, `${context} name`, 160, map) }
      : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    ...(checks?.length ? { checks } : {}),
    onFail: reader.choice(
      map['on-fail'],
      ['continue', 'stop'],
      `${context} on-fail`,
      'continue',
      map,
    ),
    operation,
  };
}

/** Parse and validate a workflow file. Errors name the offending line. */
export function parseWorkflow(text: string): WorkflowRecipe {
  let document;
  try {
    document = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError)
      throw new WorkflowFileError(
        error.message.replace(/^Line \d+: /, ''),
        error.line,
      );
    throw error;
  }
  const reader: Reader = new Reader(document.lines);
  const root = reader.map(document.value ?? undefined, 'The workflow file');
  if (root.format !== WORKFLOW_FORMAT)
    reader.fail(
      'This is not a Stratum workflow. The file must start with "format: stratum-workflow".',
      root,
    );
  const version = root.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version))
    reader.fail('The workflow needs a whole-number version.', root);
  if (version > WORKFLOW_VERSION)
    reader.fail(
      `This workflow was made by a newer Stratum (version ${version}). Update Stratum to open it.`,
      root,
    );
  if (version < 1) reader.fail('Unsupported workflow version.', root);
  reader.keys(
    root,
    [
      'format',
      'version',
      'name',
      'revision',
      'description',
      'item',
      'input',
      'steps',
      'report',
    ],
    'The workflow',
  );
  const item =
    root.item === undefined || root.item === null
      ? {}
      : reader.map(root.item, 'item');
  reader.keys(item, ['label', 'id'], 'item');
  let pattern: string | undefined;
  if (item.id !== undefined && item.id !== null) {
    const id = reader.map(item.id, 'item id');
    reader.keys(id, ['from', 'pattern'], 'item id');
    reader.choice(id.from, ['file-name'], 'item id from', 'file-name', id);
    pattern = reader.optionalText(id.pattern, 'item id pattern', 200, id);
    if (pattern !== undefined)
      try {
        new RegExp(pattern, 'u');
      } catch {
        reader.fail(
          'The item id pattern is not a valid regular expression.',
          id,
        );
      }
  }
  const input = reader.map(root.input, 'input');
  reader.keys(input, ['channels'], 'input');
  const rawChannels = reader.map(input.channels, 'input channels');
  const channels = Object.entries(rawChannels).map(([alias, value]) => {
    if (!SLUG.test(alias))
      reader.fail(
        `Channel alias "${alias}" must use lowercase letters, digits and dashes.`,
        rawChannels,
      );
    const channel =
      typeof value === 'string'
        ? { name: value }
        : reader.map(value, `Channel "${alias}"`);
    reader.keys(channel, ['name', 'unit'], `Channel "${alias}"`);
    const unit = channel.unit;
    if (
      unit !== undefined &&
      unit !== null &&
      (typeof unit !== 'string' || unit.length > 60)
    )
      reader.fail(`Channel "${alias}" unit must be text.`, rawChannels);
    return {
      alias,
      name: reader.text(
        channel.name,
        `Channel "${alias}" name`,
        255,
        rawChannels,
      ),
      ...(typeof unit === 'string' ? { unit } : {}),
    };
  });
  if (!channels.length)
    reader.fail('The workflow needs at least one input channel.', input);
  const rawSteps = root.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length)
    reader.fail('The workflow needs a list of steps.', root);
  if (rawSteps.length > MAX_RECIPE_STEPS)
    reader.fail(`Workflows are limited to ${MAX_RECIPE_STEPS} steps.`, root);
  const steps = rawSteps.map((raw, index) => readStep(reader, raw, index));
  const stepAt = (index: number) => {
    const raw = rawSteps[index];
    return raw && typeof raw === 'object' ? raw : undefined;
  };
  // References must point to earlier steps or channels; IDs share one namespace.
  const known = new Map<string, 'channel' | number>(
    channels.map((channel) => [channel.alias, 'channel']),
  );
  for (const [index, step] of steps.entries()) {
    if (known.has(step.id))
      reader.fail(`The id "${step.id}" is used more than once.`, stepAt(index));
    const bound = new Set(bindingRefs(step.operation));
    for (const ref of stepRefs(step)) {
      const { name, position } = parseRef(ref);
      const target = known.get(name);
      if (target === undefined)
        reader.fail(
          `Step "${step.id}" uses "${name}", which is not a channel or an earlier step.`,
          stepAt(index),
        );
      if (target === 'channel' && position !== undefined)
        reader.fail(
          `Step "${step.id}": channel "${name}" has one signal; remove [${position}].`,
          stepAt(index),
        );
      const isValue =
        typeof target === 'number' && steps[target].operation.kind === 'value';
      if (bound.has(ref) && !isValue)
        reader.fail(
          `Step "${step.id}" takes a setting from "${name}", which is not a value step.`,
          stepAt(index),
        );
      if (!bound.has(ref) && isValue)
        reader.fail(
          `Step "${step.id}" cannot process values from "${name}"; use signals.`,
          stepAt(index),
        );
    }
    known.set(step.id, index);
  }
  let report: ReportTemplate | undefined;
  if (root.report !== undefined && root.report !== null) {
    report = readTemplate(root.report, (message, at) =>
      reader.fail(message, at),
    );
    for (const ref of templateRefs(report)) {
      let name = '';
      try {
        name = parseRef(ref).name;
      } catch {
        reader.fail(
          `The report uses an invalid reference "${ref}".`,
          root.report as object,
        );
      }
      if (!known.has(name))
        reader.fail(
          `The report uses "${name}", which is not a channel or step.`,
          root.report as object,
        );
    }
  }
  return {
    name: reader.text(root.name, 'The workflow name', 160, root),
    ...(root.revision !== undefined && root.revision !== null
      ? { revision: reader.text(root.revision, 'revision', 60, root) }
      : {}),
    ...(root.description !== undefined && root.description !== null
      ? {
          description: reader.text(root.description, 'description', 4000, root),
        }
      : {}),
    item: {
      label: reader.optionalText(item.label, 'item label', 60, item) ?? 'Item',
      ...(pattern !== undefined ? { pattern } : {}),
    },
    channels,
    steps,
    ...(report ? { report } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writing a workflow file

const inputYaml = (refs: RecipeRef[]): YamlMap =>
  refs.length === 1 ? { input: refs[0] } : { inputs: refs };

/** A value-bound setting: `{ value: step, factor: k }`. */
function bindingYaml(binding: ValueBinding): YamlMap {
  return {
    value:
      binding.valueIds.length === 1 ? binding.valueIds[0] : binding.valueIds,
    ...(binding.factor !== 1 ? { factor: binding.factor } : {}),
  };
}
function triggerYaml(
  trigger: EdgeTrigger,
  bindings: Partial<Record<'threshold' | 'offset', ValueBinding>> = {},
): YamlMap {
  return {
    signal: trigger.signalId,
    edge: trigger.edge,
    threshold: bindings.threshold
      ? bindingYaml(bindings.threshold)
      : trigger.threshold,
    ...(bindings.offset
      ? { offset: bindingYaml(bindings.offset) }
      : trigger.offset
        ? { offset: trigger.offset }
        : {}),
    ...(trigger.hysteresis ? { hysteresis: trigger.hysteresis } : {}),
    ...(trigger.debounce ? { debounce: trigger.debounce } : {}),
  };
}

function anchorYaml(anchor: TimeAnchor): YamlMap {
  return anchor.kind === 'event'
    ? {
        kind: anchor.kind,
        trigger: triggerYaml(anchor.trigger),
        occurrence: anchor.occurrence,
      }
    : anchor.kind === 'point'
      ? { kind: anchor.kind, time: anchor.time }
      : { kind: anchor.kind };
}

function operationYaml(operation: RecipeOperation): [string, YamlMap] {
  switch (operation.kind) {
    case 'derive': {
      const refs = (list: RecipeRef[]) => (list.length === 1 ? list[0] : list);
      if (operation.operation === 'formula' && operation.formula)
        return [
          'derive',
          {
            function: 'formula',
            ...inputYaml(operation.inputs),
            expression: operation.formula.expression,
            ...(operation.unit ? { unit: operation.unit } : {}),
            ...(operation.formula.signals
              ? {
                  signals: Object.fromEntries(
                    Object.entries(operation.formula.signals).map(
                      ([letter, list]) => [letter, refs(list)],
                    ),
                  ),
                }
              : {}),
            ...(operation.bindings
              ? {
                  values: Object.fromEntries(
                    Object.entries(operation.bindings).map(
                      ([name, binding]) => [name, refs(binding.valueIds)],
                    ),
                  ),
                }
              : {}),
          },
        ];
      if (operation.operation === 'convert')
        return [
          'derive',
          {
            function: 'convert',
            ...inputYaml(operation.inputs),
            unit: operation.unit ?? '',
          },
        ];
      const spec = FUNCTIONS.find(
        (item) => item.operation === operation.operation,
      );
      return [
        'derive',
        {
          function: operation.operation,
          ...inputYaml(operation.inputs),
          ...(operation.with ? { with: operation.with } : {}),
          ...(operation.bindings?.value
            ? { parameter: bindingYaml(operation.bindings.value) }
            : spec?.parameter && !operation.with
              ? { parameter: operation.parameter }
              : {}),
        },
      ];
    }
    case 'value': {
      const parameters = operation.parameters ?? {};
      const bound = operation.bindings ?? {};
      const setting = (name: string) =>
        bound[name]
          ? { [name]: bindingYaml(bound[name]) }
          : parameters[name] !== undefined
            ? { [name]: parameters[name] }
            : {};
      return [
        'value',
        {
          function: operation.operation,
          ...inputYaml(operation.inputs),
          ...setting('threshold'),
          ...(parameters.edge !== undefined
            ? { edge: parameters.edge === -1 ? 'falling' : 'rising' }
            : {}),
          ...setting('time'),
          ...setting('hysteresis'),
          ...setting('debounce'),
        },
      ];
    }
    case 'segment': {
      const definition = operation.definition;
      const method: YamlMap =
        definition.method === 'ranges'
          ? { ranges: definition.ranges }
          : definition.method === 'windows'
            ? {
                windows: {
                  start: definition.start,
                  end: definition.end,
                  duration: definition.duration,
                  step: definition.step,
                  partial: definition.includePartial,
                },
              }
            : {
                triggers: {
                  start: triggerYaml(definition.start, {
                    threshold: definition.bindings?.['start.threshold'],
                    offset: definition.bindings?.['start.offset'],
                  }),
                  end: triggerYaml(definition.end, {
                    threshold: definition.bindings?.['end.threshold'],
                    offset: definition.bindings?.['end.offset'],
                  }),
                  ...(definition.minimumDuration
                    ? { 'minimum-duration': definition.minimumDuration }
                    : {}),
                },
              };
      return [
        'segment',
        {
          ...inputYaml(operation.inputs),
          ...method,
          boundary: definition.boundary,
          ...(operation.independently ? { independently: true } : {}),
          ...(operation.scope === 'file' ? { scope: 'file' } : {}),
          ...(operation.timeOrigin !== 'recording'
            ? { 'time-origin': operation.timeOrigin }
            : {}),
        },
      ];
    }
    case 'time': {
      const settings = operation.settings;
      let body: YamlMap;
      if (settings.kind === 'crop')
        body = {
          inputs: settings.inputIds,
          start: settings.start,
          end: settings.end,
        };
      else if (settings.kind === 'combine')
        body = { inputs: [...settings.inputIds], operator: settings.operator };
      else if (settings.kind === 'resample')
        body = {
          inputs: settings.inputIds,
          grid:
            settings.grid.kind === 'uniform'
              ? { ...settings.grid }
              : {
                  kind: settings.grid.kind,
                  signal: settings.grid.signalId,
                  start: settings.grid.start,
                  end: settings.grid.end,
                },
          interpolation: settings.interpolation,
          'max-gap': settings.maxGap,
          ...(settings.filter
            ? {
                filter: {
                  cutoff: settings.filter.cutoff,
                  'half-width': settings.filter.halfWidth,
                },
              }
            : {}),
        };
      else
        body = {
          reference: {
            name: settings.reference.name,
            kind: settings.reference.kind,
          },
          target: settings.target,
          ...(settings.secondTarget !== undefined
            ? { 'second-target': settings.secondTarget }
            : {}),
          groups: settings.groups.map((group) => ({
            inputs: group.inputIds,
            anchor: anchorYaml(group.anchor),
            ...(group.secondAnchor
              ? { 'second-anchor': anchorYaml(group.secondAnchor) }
              : {}),
          })),
        };
      return ['time', { [settings.kind]: body }];
    }
  }
}

function checkYaml(check: CheckDefinition): YamlMap {
  const limits: YamlMap = {};
  if (check.min !== undefined) limits.min = check.min;
  if (check.max !== undefined) limits.max = check.max;
  if (check.unit !== undefined) limits.unit = check.unit;
  return {
    [check.kind]:
      check.kind === 'count' &&
      check.min === check.max &&
      check.min !== undefined
        ? check.min
        : limits,
    ...(check.outputs ? { outputs: check.outputs } : {}),
    severity: check.severity,
    ...(check.message ? { message: check.message } : {}),
  };
}

export function recipeYaml(recipe: WorkflowRecipe): YamlMap {
  return {
    format: WORKFLOW_FORMAT,
    version: WORKFLOW_VERSION,
    name: recipe.name,
    ...(recipe.revision ? { revision: recipe.revision } : {}),
    ...(recipe.description ? { description: recipe.description } : {}),
    item: {
      label: recipe.item.label,
      ...(recipe.item.pattern
        ? { id: { from: 'file-name', pattern: recipe.item.pattern } }
        : {}),
    },
    input: {
      channels: Object.fromEntries(
        recipe.channels.map((channel) => [
          channel.alias,
          {
            name: channel.name,
            ...(channel.unit !== undefined ? { unit: channel.unit } : {}),
          },
        ]),
      ),
    },
    steps: recipe.steps.map((step) => {
      const [key, body] = operationYaml(step.operation);
      return {
        id: step.id,
        ...(step.name ? { name: step.name } : {}),
        [key]: body,
        ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
        ...(step.checks?.length ? { checks: step.checks.map(checkYaml) } : {}),
        ...(step.onFail === 'stop' ? { 'on-fail': 'stop' } : {}),
      };
    }),
    ...(recipe.report ? { report: templateYaml(recipe.report) } : {}),
  };
}

export function serializeWorkflow(recipe: WorkflowRecipe): string {
  return stringifyYaml(recipeYaml(recipe), {
    comments: [
      `Stratum workflow · ${recipe.name}`,
      'Inputs bind by CSV column name. Steps refer to channels and earlier steps',
      'by id; step[2] is the second output of a step. Open it in Stratum with',
      'Import → Open a workflow file…, or edit it in any text editor.',
    ],
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** SHA-256 of the validated recipe; comments and layout do not change it. */
export async function recipeHash(recipe: WorkflowRecipe): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(recipeYaml(recipe)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// ---------------------------------------------------------------------------
// Binding a recipe to one recording

/** CSV header parsing shared with the importer: "Torque [Nm]" → name and unit. */
export { headerChannel } from './formats/recording';

const comparable = (text: string) => text.trim().toLowerCase();

/**
 * The table of a multi-group file (MDF, TDMS …) that binds the most recipe
 * channels; the first wins a tie. A batch item processes one recording.
 */
export function bestTable(
  recipe: Pick<WorkflowRecipe, 'channels'>,
  tables: { channels: { name: string; unit: string }[] }[],
  mapping: Readonly<Record<string, string>> = {},
): number {
  let best = 0;
  let bound = -1;
  tables.forEach((table, index) => {
    const count = bindChannels(recipe, table.channels, mapping).filter(
      (binding) => !binding.problem,
    ).length;
    if (count > bound) [best, bound] = [index, count];
  });
  return best;
}

export type ChannelBinding = {
  alias: string;
  /** Index into the recording's channels, or -1 when missing. */
  channel: number;
  problem?: string;
};

/**
 * Match aliases to channels by name, then check units. Case is ignored.
 * `mapping` (alias → column name) binds a channel to a differently named
 * column for one item, without changing the workflow.
 */
export function bindChannels(
  recipe: Pick<WorkflowRecipe, 'channels'>,
  channels: { name: string; unit: string }[],
  mapping: Readonly<Record<string, string>> = {},
): ChannelBinding[] {
  return recipe.channels.map((channel) => {
    const mapped = Object.hasOwn(mapping, channel.alias)
      ? mapping[channel.alias]
      : undefined;
    const name = mapped ?? channel.name;
    const matches = channels.flatMap((item, index) =>
      comparable(item.name) === comparable(name) ? [index] : [],
    );
    if (!matches.length)
      return {
        alias: channel.alias,
        channel: -1,
        problem: mapped
          ? `Column "${mapped}", chosen for "${channel.name}", is missing.`
          : `Missing channel "${channel.name}${channel.unit ? ` [${channel.unit}]` : ''}".`,
      };
    if (matches.length > 1)
      return {
        alias: channel.alias,
        channel: -1,
        problem: `More than one channel is named "${name}".`,
      };
    const found = channels[matches[0]];
    if (channel.unit !== undefined && found.unit !== channel.unit)
      return {
        alias: channel.alias,
        channel: matches[0],
        problem: `"${name}" is in ${found.unit}, but the workflow expects ${channel.unit}.`,
      };
    return { alias: channel.alias, channel: matches[0] };
  });
}

/** The item ID from a file name: the `id` group, else the first group or match. */
export function itemIdFromFileName(
  recipe: Pick<WorkflowRecipe, 'item'>,
  fileName: string,
): string {
  const base = fileName.replace(/\.[^.]*$/, '').slice(0, 255);
  if (!recipe.item.pattern) return base;
  const match = base.match(new RegExp(recipe.item.pattern, 'u'));
  return (match?.groups?.id ?? match?.[1] ?? match?.[0] ?? base).trim() || base;
}

export type BindContext = {
  /** Output IDs of an alias or earlier step; throws BlockedReference. */
  resolve: (ref: RecipeRef) => string[];
  sourceOf: (id: string) => string;
  /** Segmentation-clock start of a signal, for `input-start`. */
  clockStart: (id: string) => number;
  recordingStart: number;
  newId: () => string;
};

export function createResolver(
  aliases: ReadonlyMap<string, string>,
  outputs: ReadonlyMap<string, string[]>,
): (ref: RecipeRef) => string[] {
  return (ref) => {
    const { name, position } = parseRef(ref);
    const alias = aliases.get(name);
    if (alias) return [alias];
    const list = outputs.get(name);
    if (!list)
      throw new BlockedReference(`"${name}" was not created for this item.`);
    if (position === undefined) {
      if (!list.length) throw new BlockedReference(`"${name}" has no outputs.`);
      return [...list];
    }
    if (position > list.length)
      throw new BlockedReference(
        `"${ref}" needs ${position} outputs, but this item has ${list.length}.`,
      );
    return [list[position - 1]];
  };
}

/** The engine command that replays a recipe step for one item. */
export function stepCommand(
  step: RecipeStep,
  context: BindContext,
): WorkflowCommand {
  const many = (refs: RecipeRef[]) => {
    const ids = refs.flatMap((ref) => context.resolve(ref));
    if (new Set(ids).size !== ids.length)
      throw new BlockedReference(
        `Step "${step.id}" lists the same signal twice.`,
      );
    return ids;
  };
  const one = (ref: RecipeRef) => {
    const ids = context.resolve(ref);
    if (ids.length !== 1)
      throw new BlockedReference(
        `"${ref}" has ${ids.length} outputs here; choose one, such as ${ref}[1].`,
      );
    return ids[0];
  };
  const trigger = (item: EdgeTrigger): EdgeTrigger => ({
    ...item,
    signalId: one(item.signalId),
  });
  const bound = (bindings?: ParameterBindings) =>
    bindings
      ? {
          bindings: Object.fromEntries(
            Object.entries(bindings).map(([name, binding]) => [
              name,
              {
                valueIds: binding.valueIds.flatMap((ref) =>
                  context.resolve(ref),
                ),
                factor: binding.factor,
              },
            ]),
          ),
        }
      : {};
  const operation = step.operation;
  switch (operation.kind) {
    case 'derive': {
      const inputIds = many(operation.inputs);
      if (operation.with)
        return {
          type: 'region-function',
          settings: {
            sourceId: context.sourceOf(inputIds[0]),
            operation: operation.operation,
            parameter: operation.parameter,
            inputIds,
            secondaryIds: [one(operation.with)],
          },
        };
      return {
        type: 'derive-many',
        parentIds: inputIds,
        operation: operation.operation,
        parameter: operation.parameter,
        ...bound(operation.bindings),
        ...(operation.unit !== undefined ? { unit: operation.unit } : {}),
        ...(operation.formula
          ? {
              formula: {
                expression: operation.formula.expression,
                ...(operation.formula.signals
                  ? {
                      signals: Object.fromEntries(
                        Object.entries(operation.formula.signals).map(
                          ([letter, refs]) => [
                            letter,
                            refs.flatMap((ref) => context.resolve(ref)),
                          ],
                        ),
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      };
    }
    case 'value':
      return {
        type: 'calculate-values',
        inputIds: many(operation.inputs),
        operation: operation.operation,
        ...(operation.parameters
          ? { parameters: { ...operation.parameters } }
          : {}),
        ...bound(operation.bindings),
      };
    case 'segment': {
      const targetIds = many(operation.inputs);
      let shift = 0;
      if (operation.timeOrigin === 'recording-start')
        shift = context.recordingStart;
      else if (operation.timeOrigin === 'input-start') {
        if (targetIds.length !== 1)
          throw new BlockedReference(
            `Step "${step.id}" measures time from its input's start, so it needs exactly one input; this item has ${targetIds.length}.`,
          );
        shift = context.clockStart(targetIds[0]);
      }
      const source = operation.definition;
      const definition: SegmentationDefinition =
        source.method === 'triggers'
          ? {
              ...source,
              start: trigger(source.start),
              end: trigger(source.end),
              ...bound(source.bindings),
            }
          : source.method === 'ranges'
            ? {
                ...source,
                ranges: source.ranges.map(
                  ([start, end]) =>
                    [start + shift, end + shift] as [number, number],
                ),
              }
            : {
                ...source,
                start: source.start + shift,
                end: source.end + shift,
              };
      return {
        type: 'segment',
        sourceId: context.sourceOf(targetIds[0]),
        definition,
        targetIds,
        independently: operation.independently,
        ...(operation.scope ? { scope: operation.scope } : {}),
      };
    }
    case 'time': {
      const settings = structuredClone(operation.settings);
      if (settings.kind === 'align') {
        settings.reference.id = context.newId();
        for (const group of settings.groups) {
          group.inputIds = many(group.inputIds);
          for (const anchor of [group.anchor, group.secondAnchor])
            if (anchor?.kind === 'event')
              anchor.trigger = trigger(anchor.trigger);
        }
      } else if (settings.kind === 'combine')
        settings.inputIds = [
          one(settings.inputIds[0]),
          one(settings.inputIds[1]),
        ];
      else {
        settings.inputIds = many(settings.inputIds);
        if (settings.kind === 'resample' && settings.grid.kind === 'reference')
          settings.grid.signalId = one(settings.grid.signalId);
      }
      return { type: 'time-operation', settings };
    }
  }
}

/** Labels for a step's outputs, or undefined to keep the engine's names. */
export function outputLabels(
  step: RecipeStep,
  count: number,
  item: string,
  inputLabel: (position: number) => string,
): (string | undefined)[] {
  const fill = (template: string, position: number) =>
    template
      .replaceAll('{n}', String(position + 1))
      .replaceAll('{item}', item)
      .replaceAll('{input}', inputLabel(position))
      .slice(0, 160)
      .trim();
  return Array.from({ length: count }, (_, position) => {
    const template = Array.isArray(step.outputs)
      ? step.outputs[position]
      : step.outputs;
    return template ? fill(template, position) || undefined : undefined;
  });
}
