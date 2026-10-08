import type {
  Operation,
  SegmentationDefinition,
  SignalNode,
} from './signal-types';
import type {
  BoundValue,
  ParameterBindings,
  ScalarValue,
  ValueBinding,
} from './workflow-types';

/** Which unit a bound value must have: the input's, seconds, or any. */
export type BindingUnit = 'input' | 'seconds' | 'any';

/** Derive operations whose single setting (`value`) can come from a value. */
export const BINDABLE_DERIVE: Partial<Record<Operation, BindingUnit>> = {
  offset: 'input',
  scale: 'any',
  'time-shift': 'seconds',
};
/** Value calculation settings that can come from a value. */
export const BINDABLE_VALUE: Record<string, BindingUnit> = {
  threshold: 'input',
  time: 'seconds',
};
/** Trigger settings that can come from a value, by binding key. */
export const BINDABLE_TRIGGER: Record<string, BindingUnit> = {
  'start.threshold': 'input',
  'end.threshold': 'input',
  'start.offset': 'seconds',
  'end.offset': 'seconds',
};

export type BindingContext = {
  values: ReadonlyMap<string, ScalarValue>;
  nodes: ReadonlyMap<string, SignalNode>;
  /** Display name of a value, for messages. */
  label?: (id: string) => string;
  /** File segments by ID, so values of enclosing segments also match. */
  segments?: ReadonlyMap<string, { segment: { parentId?: string } }>;
};

/** The ancestry of a signal along its first inputs, nearest first. */
function chain(nodes: BindingContext['nodes'], id: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (
    let current: string | undefined = id;
    current !== undefined && !seen.has(current);
    current = nodes.get(current)?.parents[0]
  ) {
    seen.add(current);
    ids.push(current);
  }
  return ids;
}

/**
 * The value a binding uses for one input. A single value is shared. Several
 * are matched by lineage: the value whose input is this input, or the
 * nearest one along its first-input ancestry in either direction (a value
 * calculated from a signal this input came from, or that came from it).
 */
export function matchValue(
  context: BindingContext,
  binding: ValueBinding,
  inputId: string,
): ScalarValue {
  const label = (id: string) => context.label?.(id) ?? 'a value';
  let candidates = binding.valueIds.map((id) => {
    const value = context.values.get(id);
    if (!value)
      throw new Error(
        'A value used in these settings no longer exists. Choose another value.',
      );
    return value;
  });
  if (!candidates.length) throw new Error('Choose a value for this setting.');
  if (candidates.length === 1) return candidates[0];
  const ancestry = chain(context.nodes, inputId);
  // Within a segment, values of that segment come first, then values of
  // entire signals; values of other segments never match.
  if (candidates.some((value) => value.segmentId)) {
    // The input's segment, then the segments that contain it, nearest first.
    const levels: string[] = [];
    for (
      let segment = ancestry
        .map((id) => context.nodes.get(id)?.segmentId)
        .find(Boolean);
      segment && !levels.includes(segment);
      segment = context.segments?.get(segment)?.segment.parentId
    )
      levels.push(segment);
    let same: ScalarValue[] = [];
    for (const level of levels) {
      same = candidates.filter((value) => value.segmentId === level);
      if (same.length) break;
    }
    const entire = candidates.filter((value) => !value.segmentId);
    candidates = same.length ? same : entire;
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length)
      throw new Error(
        `None of the chosen values was calculated within the segment of ${context.label?.(inputId) ?? 'this input'}. Choose values calculated within the same segments.`,
      );
  }
  let best: ScalarValue[] = [];
  let distance = Infinity;
  for (const value of candidates) {
    let found = ancestry.indexOf(value.inputId);
    if (found < 0) found = chain(context.nodes, value.inputId).indexOf(inputId);
    if (found < 0) continue;
    if (found < distance) {
      distance = found;
      best = [value];
    } else if (found === distance) best.push(value);
  }
  if (best.length === 1) return best[0];
  if (best.length > 1)
    throw new Error(
      `${label(best[0].id)} and ${label(best[1].id)} both match ${context.label?.(inputId) ?? 'this input'}. Choose one value.`,
    );
  throw new Error(
    `None of the chosen values was calculated from ${context.label?.(inputId) ?? 'this input'} or a signal related to it. Choose one value to share, or values calculated from each input.`,
  );
}

/**
 * The number a binding gives one input, with the value it used. Units must
 * match exactly; nothing is converted.
 */
export function resolveBinding(
  context: BindingContext,
  binding: ValueBinding,
  inputId: string,
  unit: BindingUnit,
  setting: string,
  inputUnit = '',
): BoundValue & { number: number; value: ScalarValue } {
  if (!Number.isFinite(binding.factor))
    throw new Error(`Enter a finite factor for the ${setting}.`);
  const value = matchValue(context, binding, inputId);
  const name = context.label?.(value.id) ?? value.name;
  if (value.value === null)
    throw new Error(
      `${name} is unavailable, so it cannot set the ${setting}. Check the value or choose another.`,
    );
  const expected = unit === 'seconds' ? 's' : unit === 'input' ? inputUnit : '';
  if (unit !== 'any' && value.unit !== expected)
    throw new Error(
      `The ${setting} needs a value in ${expected || 'no unit'}; ${name} is in ${value.unit || 'no unit'}.`,
    );
  const number = binding.factor * value.value;
  if (!Number.isFinite(number))
    throw new Error(`The ${setting} from ${name} is not a finite number.`);
  return { valueId: value.id, factor: binding.factor, number, value };
}

/** Every value a set of bindings can use. */
export function bindingValueIds(bindings?: ParameterBindings): string[] {
  return [
    ...new Set(Object.values(bindings ?? {}).flatMap((item) => item.valueIds)),
  ];
}

/** The bindings a batch of saved outputs used, as one command's bindings. */
export function savedBindings(
  records: { bindings?: Record<string, BoundValue> }[],
): ParameterBindings | undefined {
  const result: ParameterBindings = {};
  for (const record of records)
    for (const [name, bound] of Object.entries(record.bindings ?? {})) {
      const binding = (result[name] ??= {
        valueIds: [],
        factor: bound.factor,
      });
      if (!binding.valueIds.includes(bound.valueId))
        binding.valueIds.push(bound.valueId);
    }
  return Object.keys(result).length ? result : undefined;
}

/** Valid, non-empty binding settings: known names and finite factors. */
export function validBindings(
  bindings: unknown,
  allowed: Record<string, BindingUnit>,
): bindings is ParameterBindings {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
    return false;
  const entries = Object.entries(bindings as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(
      ([name, item]) =>
        Object.hasOwn(allowed, name) &&
        !!item &&
        typeof item === 'object' &&
        Number.isFinite((item as ValueBinding).factor) &&
        Array.isArray((item as ValueBinding).valueIds) &&
        (item as ValueBinding).valueIds.length > 0 &&
        (item as ValueBinding).valueIds.every((id) => typeof id === 'string'),
    )
  );
}

/**
 * A trigger definition with its bound settings replaced by their results
 * for the trigger signals it names. Other definitions are unchanged.
 */
export function resolveTriggerBindings(
  context: BindingContext,
  definition: SegmentationDefinition,
): SegmentationDefinition {
  if (!definition.bindings) return definition;
  if (definition.method !== 'triggers')
    throw new Error('Only trigger settings can come from values.');
  const resolved = {
    ...definition,
    start: { ...definition.start },
    end: { ...definition.end },
  };
  for (const [key, binding] of Object.entries(definition.bindings)) {
    const unit = BINDABLE_TRIGGER[key];
    if (!unit) throw new Error(`"${key}" cannot come from a value.`);
    const [side, setting] = key.split('.') as [
      'start' | 'end',
      'threshold' | 'offset',
    ];
    const trigger = resolved[side];
    const signal = context.nodes.get(trigger.signalId);
    resolved[side][setting] = resolveBinding(
      context,
      binding,
      trigger.signalId,
      unit,
      `${side} ${setting}`,
      signal?.unit,
    ).number;
  }
  return resolved;
}
