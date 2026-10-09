import { compileFormula, MAX_FORMULA_LENGTH } from './formula';
import { matchValue, type BindingContext } from './value-bindings';
import type {
  BoundValue,
  ParameterBindings,
  ScalarValue,
} from './workflow-types';

/** The variable that is each input value in a calculation from values. */
export const VALUE_INPUT = 'a';

/** One input's result: the number (null when unavailable) and its values. */
export type ValueMathResult = {
  input: ScalarValue;
  value: number | null;
  /** Each variable's number, for the variables whose values are available. */
  parameters: Record<string, number>;
  /** Every variable's value, `a` being the input. */
  bindings: Record<string, BoundValue>;
};

/** The input value of a calculation from values. */
export const calculatedInput = (value: ScalarValue): string | undefined =>
  value.operation === 'calculate'
    ? value.bindings?.[VALUE_INPUT]?.valueId
    : undefined;

/**
 * Check a calculation from values and evaluate it for each input value.
 * Other variables are matched to each input as settings taken from values
 * are: values of the input's segment first, then by lineage. Creation and
 * the dialog's preview both use this, so they always agree. A value that
 * is unavailable, or a result that is not finite, gives an unavailable
 * result rather than an error.
 */
export function valueMathResults(
  context: BindingContext,
  inputIds: string[],
  expression: string,
  bindings?: ParameterBindings,
): ValueMathResult[] {
  if (expression.length > MAX_FORMULA_LENGTH)
    throw new Error(
      `Formulas are limited to ${MAX_FORMULA_LENGTH} characters.`,
    );
  const formula = compileFormula(expression, 'values');
  const others = formula.values.filter((name) => name !== VALUE_INPUT);
  for (const name of Object.keys(bindings ?? {}))
    if (!others.includes(name))
      throw new Error(
        name === VALUE_INPUT
          ? 'a is each input value; it cannot also be chosen.'
          : `The formula does not use "${name}".`,
      );
  for (const name of others) {
    const binding = bindings?.[name];
    if (!binding?.valueIds.length)
      throw new Error(`Choose a value for "${name}".`);
    if (!Number.isFinite(binding.factor))
      throw new Error(`Enter a finite factor for "${name}".`);
  }
  if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
    throw new Error('Choose at least one unique value.');
  const label = (id: string) => context.label?.(id) ?? 'a value';
  return inputIds.map((id) => {
    const input = context.values.get(id);
    if (!input)
      throw new Error(
        'A value to calculate from no longer exists. Choose other values.',
      );
    const bound: Record<string, BoundValue> = {
      [VALUE_INPUT]: { valueId: input.id, factor: 1 },
    };
    const numbers: Record<string, number> = {};
    if (input.value !== null) numbers[VALUE_INPUT] = input.value;
    for (const name of others) {
      const binding = bindings![name];
      let value: ScalarValue;
      try {
        value = matchValue(
          context,
          binding,
          input.inputId,
          input.segmentId ?? '',
        );
      } catch (error) {
        throw new Error(
          `"${name}" for ${label(input.id)}: ${error instanceof Error ? error.message : 'no value matches.'}`,
        );
      }
      bound[name] = { valueId: value.id, factor: binding.factor };
      if (value.value !== null) {
        const number = binding.factor * value.value;
        if (Number.isFinite(number)) numbers[name] = number;
      }
    }
    const complete = formula.values.every((name) =>
      Object.hasOwn(numbers, name),
    );
    const result = complete
      ? formula.evaluate(
          [],
          formula.values.map((name) => numbers[name]),
        )
      : NaN;
    return {
      input,
      value: Number.isFinite(result) ? result : null,
      parameters: numbers,
      bindings: bound,
    };
  });
}
