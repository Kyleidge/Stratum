'use client';

import { useMemo, useState } from 'react';
import { Calculator, Eye } from 'lucide-react';
import {
  compileFormula,
  FORMULA_FUNCTIONS,
  MAX_FORMULA_LENGTH,
} from '@/lib/formula';
import { formatCount } from '@/lib/format-count';
import { formatQuantity } from '@/lib/parameter-scale';
import type { BindingContext } from '@/lib/value-bindings';
import {
  VALUE_INPUT,
  valueMathResults,
  type ValueMathResult,
} from '@/lib/value-math';
import type { WorkflowIndex } from '@/lib/workflow-history';
import { CALCULATE, type ParameterBindings } from '@/lib/workflow-types';
import {
  bindingFromDraft,
  draftFromBinding,
  valueSourceOptions,
  ValueSourceSelect,
} from './value-binding-control';
import NameField from './name-field';

/** A calculation from values being created or edited. */
export type ValueMathDraft = {
  editingStepId?: string;
  /** The input values; `a` is each of them. */
  ids: string[];
  expression?: string;
  unit?: string;
  /** The formula's other values, by name. */
  bindings?: ParameterBindings;
};

/** Rows calculated ahead of creation; Create calculates every input. */
const PREVIEW_LIMIT = 50;
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The formula's names, its bindings and the preview of the first inputs. */
function calculation(
  index: WorkflowIndex,
  context: BindingContext,
  ids: string[],
  expression: string,
  sources: Record<string, string>,
): {
  names: string[];
  bindings: ParameterBindings;
  results: ValueMathResult[];
  problem: string;
} {
  // The formula's other names, so each gets a value picker.
  let names: string[] = [];
  try {
    names = compileFormula(expression, 'values').values.filter(
      (name) => name !== VALUE_INPUT,
    );
  } catch {
    // Reported below with the full calculation.
  }
  const bindings: ParameterBindings = {};
  for (const name of names) {
    const binding = bindingFromDraft(index, {
      source: sources[name] ?? '',
      factor: '1',
    });
    if (binding) bindings[name] = binding;
  }
  try {
    const results = valueMathResults(
      context,
      ids.slice(0, PREVIEW_LIMIT),
      expression,
      Object.keys(bindings).length ? bindings : undefined,
    );
    return { names, bindings, results, problem: '' };
  } catch (caught) {
    return {
      names,
      bindings,
      results: [],
      problem: message(caught, 'Invalid formula.'),
    };
  }
}

/**
 * Calculate from values: a formula over calculated values, `a` being each
 * input value. The preview uses the engine's own calculation on the values
 * already saved, so it always matches what Create stores.
 */
export default function ValueMathEditor({
  editor,
  index,
  busy,
  onApply,
  onSignals,
}: {
  editor: ValueMathDraft;
  index: WorkflowIndex;
  busy: boolean;
  onApply: (
    expression: string,
    unit: string,
    bindings?: ParameterBindings,
    /** A name chosen for a new step (`chosenNames`). */
    name?: string,
  ) => Promise<void>;
  /** Opens Calculate values for the inputs' signals instead. */
  onSignals?: () => void;
}) {
  const first = index.values.get(editor.ids[0]);
  const [expression, setExpression] = useState(
    editor.expression ?? VALUE_INPUT,
  );
  const [unit, setUnit] = useState(editor.unit ?? first?.unit ?? '');
  // Sources for the formula's other names, as the value pickers use them.
  const [sources, setSources] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(editor.bindings ?? {}).map(([name, binding]) => [
        name,
        draftFromBinding(index, binding).source,
      ]),
    ),
  );
  const [focusedId, setFocusedId] = useState(editor.ids[0]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  // When editing, only values calculated before the step can be used.
  const before = editor.editingStepId
    ? index.steps.get(editor.editingStepId)?.sequence
    : undefined;
  const options = valueSourceOptions(index, () => true, '', before);
  const context = useMemo<BindingContext>(
    () => ({
      values: index.values,
      nodes: index.nodes,
      segments: index.segments,
      label: (id) => index.label(id),
    }),
    [index],
  );
  const { names, bindings, results, problem } = useMemo(
    () => calculation(index, context, editor.ids, expression, sources),
    [context, editor.ids, expression, index, sources],
  );
  const count = editor.ids.length;
  const focused =
    results.find((result) => result.input.id === focusedId) ?? results[0];
  const shownUnit = unit.trim();
  const quantity = (value: number | null, suffix: string) =>
    value === null
      ? 'Unavailable'
      : `${formatQuantity(value, 6)}${suffix ? ` ${suffix}` : ''}`;
  const uses = (result: ValueMathResult) =>
    Object.entries(result.bindings)
      .map(([name, bound]) => {
        const value = index.values.get(bound.valueId);
        return `${name} = ${quantity(
          Object.hasOwn(result.parameters, name)
            ? result.parameters[name]
            : null,
          value?.unit ?? '',
        )}`;
      })
      .join(', ');
  const create = editor.editingStepId
    ? 'Save changes and recalculate'
    : `Create ${formatCount(count, 'value')}`;
  const summary = focused
    ? `${formatCount(count, 'value')} · ${count > 1 ? `${index.label(focused.input.id)}: ` : ''}${quantity(focused.value, shownUnit)}`
    : formatCount(count, 'value');
  return (
    <div className="operation-editor">
      <div className="operation-body">
        <div className="operation-layout">
          <fieldset className="workflow-function-editor" disabled={busy}>
            <div className="signal-operation-settings">
              <div className="signal-settings-heading">
                <strong>Calculate from values</strong>
                <span className="value-output-count">
                  {formatCount(count, 'value')}
                </span>
              </div>
              <p>
                One result per input value, kept with its segment. Use numbers,
                + − * / ^ and functions such as min, max, abs and sqrt.
              </p>
              <div className="formula-settings">
                <label className="parameter-control-field formula-expression">
                  <span>Formula</span>
                  <div className="number-field">
                    <input
                      aria-label="Formula"
                      spellCheck={false}
                      maxLength={MAX_FORMULA_LENGTH}
                      value={expression}
                      placeholder="a / 3.6"
                      disabled={busy}
                      onChange={(event) => setExpression(event.target.value)}
                    />
                  </div>
                </label>
                <p className="parameter-hint">
                  a is each input value
                  {names.length
                    ? `; ${names.join(', ')} ${names.length === 1 ? 'is a value' : 'are values'}, matched to it by segment and lineage`
                    : ''}
                  . For example <code>a / 12</code> or <code>b / a</code>.
                </p>
                <label className="parameter-control-field">
                  <span>Output unit</span>
                  <div className="number-field">
                    <input
                      aria-label="Output unit"
                      maxLength={40}
                      value={unit}
                      placeholder="none"
                      disabled={busy}
                      onChange={(event) => setUnit(event.target.value)}
                    />
                  </div>
                </label>
                {names.map((name) => (
                  <div key={name} className="parameter-control-field">
                    <span>Value {name}</span>
                    <ValueSourceSelect
                      label={`Value ${name}`}
                      value={sources[name] ?? ''}
                      groups={options.groups}
                      items={[
                        {
                          value: '',
                          label: 'Choose a value…',
                          disabled: false,
                        },
                        ...options.items,
                      ]}
                      disabled={busy}
                      onChange={(source) =>
                        setSources((current) => ({
                          ...current,
                          [name]: source,
                        }))
                      }
                    />
                  </div>
                ))}
                {problem && (
                  <p className="segment-error" role="alert">
                    {problem}
                  </p>
                )}
                <details className="formula-help">
                  <summary>Functions and operators</summary>
                  <p className="parameter-hint">
                    + − * / % ^ and comparisons &lt; &lt;= &gt; &gt;= == != (1
                    or 0). Functions: {FORMULA_FUNCTIONS.join(', ')}; constant
                    pi. A value that is unavailable, or a result that is not a
                    finite number, is stored as unavailable.
                  </p>
                </details>
              </div>
              {!editor.editingStepId && (
                <NameField
                  value={name}
                  onChange={setName}
                  kind="value"
                  count={count}
                  placeholder={
                    count === 1 && focused
                      ? `Calculate ${expression.trim()} · ${index.label(focused.input.id)}`
                      : undefined
                  }
                  disabled={busy}
                />
              )}
              {onSignals && (
                <p className="signal-math-hint">
                  Want a statistic of their signals instead?{' '}
                  <button
                    type="button"
                    className="workflow-link"
                    onClick={onSignals}
                  >
                    Calculate from the input signals
                  </button>
                </p>
              )}
            </div>
          </fieldset>
          <section className="operation-preview" aria-label="Preview">
            <div className="operation-preview-heading">
              <strong>
                <Eye size={14} /> Preview
              </strong>
              <span className="operation-preview-subject">
                {focused ? index.label(focused.input.id) : ''}
              </span>
            </div>
            {focused && (
              <p className="operation-preview-summary">
                {focused.value === null
                  ? `Unavailable: ${uses(focused)}.`
                  : `${quantity(focused.value, shownUnit)} from ${uses(focused)}.`}
              </p>
            )}
            <div className="value-preview-table value-math-preview">
              <table>
                <thead>
                  <tr>
                    <th>Input value</th>
                    <th>Uses</th>
                    <th>{CALCULATE.tag}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr
                      key={result.input.id}
                      data-selected={result === focused || undefined}
                    >
                      <td>
                        <button
                          type="button"
                          className="value-preview-row"
                          aria-pressed={result === focused}
                          title={index.label(result.input.id)}
                          onClick={() => setFocusedId(result.input.id)}
                        >
                          {index.label(result.input.id)}
                        </button>
                      </td>
                      <td title={uses(result)}>{uses(result)}</td>
                      <td>{quantity(result.value, shownUnit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!results.length && (
                <p className="input-hint">
                  {problem
                    ? 'The preview appears when the settings are complete.'
                    : 'Enter a formula to preview.'}
                </p>
              )}
              {count > PREVIEW_LIMIT && !!results.length && (
                <p className="input-hint">
                  Showing {PREVIEW_LIMIT} of {count} inputs. Create calculates
                  all of them.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="operation-footer">
        <p className="operation-footer-summary" aria-live="polite">
          {error ? (
            <span className="operation-footer-reason" role="alert" data-error>
              {error}
            </span>
          ) : problem ? (
            <span className="operation-footer-reason" data-error>
              {problem}
            </span>
          ) : (
            summary
          )}
        </p>
        <button
          className="primary-button"
          disabled={busy || !!problem}
          onClick={() => {
            setError('');
            void onApply(
              expression,
              shownUnit,
              Object.keys(bindings).length ? bindings : undefined,
              editor.editingStepId ? undefined : name,
            ).catch((caught: unknown) =>
              setError(message(caught, 'Calculation failed.')),
            );
          }}
        >
          <Calculator size={15} />
          {create}
        </button>
      </div>
    </div>
  );
}
