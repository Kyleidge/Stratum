'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UnitHint, UnitInput } from '@/components/unit-field';
import {
  compileFormula,
  FORMULA_FUNCTIONS,
  MAX_FORMULA_LENGTH,
} from '@/lib/formula';
import { formatCount } from '@/lib/format-count';
import { gridKey } from '@/lib/sample-grid';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { FormulaSettings } from '@/lib/signal-types';
import type { ParameterBindings } from '@/lib/workflow-types';
import {
  bindingFromDraft,
  draftFromBinding,
  valueSourceOptions,
  ValueSourceSelect,
} from './value-binding-control';

/**
 * A formula being edited. Letters and value names map to sources: a signal
 * (`signal:<id>`) or a step whose outputs are matched to each input by
 * sample grid (`step:<id>`); values use the value control's sources.
 */
export type FormulaDraft = {
  expression: string;
  unit: string;
  signals: Record<string, string>;
  values: Record<string, string>;
};

const reference = (sequence: number) =>
  `#${String(sequence + 1).padStart(3, '0')}`;

export function initialFormulaDraft(
  index: WorkflowIndex,
  inputUnit: string,
  saved?: {
    unit?: string;
    formula?: FormulaSettings;
    bindings?: ParameterBindings;
  },
): FormulaDraft {
  const source = (ids: string[]) => {
    if (ids.length === 1) return `signal:${ids[0]}`;
    const owner = index.owner.get(ids[0]);
    return owner &&
      owner.outputIds.length === ids.length &&
      owner.outputIds.every((id, position) => ids[position] === id)
      ? `step:${owner.id}`
      : `ids:${JSON.stringify(ids)}`;
  };
  return {
    expression: saved?.formula?.expression ?? 'A',
    unit: saved?.unit ?? inputUnit,
    signals: Object.fromEntries(
      Object.entries(saved?.formula?.signals ?? {}).map(([letter, ids]) => [
        letter,
        source(ids),
      ]),
    ),
    values: Object.fromEntries(
      Object.entries(saved?.bindings ?? {}).map(([name, binding]) => [
        name,
        draftFromBinding(index, binding).source,
      ]),
    ),
  };
}

/** The engine settings a draft describes, or why it is incomplete. */
export function formulaRequest(
  index: WorkflowIndex,
  draft: FormulaDraft,
):
  | { unit: string; formula: FormulaSettings; bindings?: ParameterBindings }
  | { problem: string } {
  let compiled;
  try {
    compiled = compileFormula(draft.expression);
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : 'Invalid formula.',
    };
  }
  const signals: Record<string, string[]> = {};
  for (const letter of compiled.signals.slice(1)) {
    const source = draft.signals[letter] ?? '';
    const [kind, ...rest] = source.split(':');
    const key = rest.join(':');
    const ids =
      kind === 'signal'
        ? [key]
        : kind === 'step'
          ? (index.steps
              .get(key)
              ?.outputIds.filter((id) => index.nodes.has(id)) ?? [])
          : kind === 'ids'
            ? (JSON.parse(key) as string[])
            : [];
    if (!ids.length || !ids.every((id) => index.nodes.has(id)))
      return { problem: `Choose a signal for ${letter}.` };
    signals[letter] = ids;
  }
  const bindings: ParameterBindings = {};
  for (const name of compiled.values) {
    const binding = bindingFromDraft(index, {
      source: draft.values[name] ?? '',
      factor: '1',
    });
    if (!binding) return { problem: `Choose a value for "${name}".` };
    bindings[name] = binding;
  }
  return {
    unit: draft.unit.trim(),
    formula: {
      expression: draft.expression,
      ...(Object.keys(signals).length ? { signals } : {}),
    },
    ...(Object.keys(bindings).length ? { bindings } : {}),
  };
}

/** Expression, output unit, and a source for each signal and value. */
export default function FormulaSettingsPanel({
  index,
  inputIds,
  previewId,
  before,
  draft,
  disabled,
  onChange,
}: {
  index: WorkflowIndex;
  inputIds: string[];
  previewId: string;
  /** The sequence of the step being edited; later values are not offered. */
  before?: number;
  draft: FormulaDraft;
  disabled: boolean;
  onChange: (draft: FormulaDraft) => void;
}) {
  let compiled: ReturnType<typeof compileFormula> | undefined;
  let problem = '';
  try {
    compiled = compileFormula(draft.expression);
  } catch (error) {
    problem = error instanceof Error ? error.message : 'Invalid formula.';
  }
  const grid = gridKey(index.nodes, previewId);
  const grids = new Set(inputIds.map((id) => gridKey(index.nodes, id)));
  const sameGrid = [...index.nodes.values()].filter(
    (node) =>
      !node.internal &&
      !inputIds.includes(node.id) &&
      gridKey(index.nodes, node.id) === grid,
  );
  // Steps with a signal on every input's grid, matched per input.
  const matching = [...index.steps.values()]
    .filter((step) => {
      const outputs = step.outputIds.filter((id) => index.nodes.has(id));
      if (outputs.length < 2) return false;
      const available = new Set(outputs.map((id) => gridKey(index.nodes, id)));
      return [...grids].every((key) => available.has(key));
    })
    .sort((a, b) => b.sequence - a.sequence);
  const label = (id: string) =>
    `${index.owner.get(id) ? `${reference(index.owner.get(id)!.sequence)} ` : ''}${index.label(id)}${index.nodes.get(id)?.unit ? ` [${index.nodes.get(id)!.unit}]` : ''}`;
  const signalItems = [
    { value: '', label: 'Choose a signal…' },
    ...matching.map((step) => ({
      value: `step:${step.id}`,
      label: `${reference(step.sequence)} ${stepName(step)} · each input's own`,
    })),
    ...sameGrid.map((node) => ({
      value: `signal:${node.id}`,
      label: label(node.id),
    })),
  ];
  const values = valueSourceOptions(index, () => true, '', before);
  return (
    <div className="formula-settings">
      <label className="parameter-control-field formula-expression">
        <span>Formula</span>
        <div className="number-field">
          <input
            aria-label="Formula"
            spellCheck={false}
            maxLength={MAX_FORMULA_LENGTH}
            value={draft.expression}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, expression: event.target.value })
            }
          />
        </div>
      </label>
      <p
        className={problem ? 'segment-error' : 'parameter-hint'}
        role={problem ? 'alert' : undefined}
      >
        {problem ||
          `A is each input${compiled && compiled.signals.length > 1 ? `; ${compiled.signals.slice(1).join(', ')} ${compiled.signals.length === 2 ? 'is a signal' : 'are signals'} on the same sample grid` : ''}${compiled?.values.length ? `; ${compiled.values.join(', ')} ${compiled.values.length === 1 ? 'is a value' : 'are values'}` : ''}. Missing samples stay missing.`}
      </p>
      <div className="parameter-control-field">
        <span>Output unit</span>
        <UnitInput
          label="Output unit"
          value={draft.unit}
          disabled={disabled}
          placeholder="none"
          onChange={(unit) => onChange({ ...draft, unit })}
        />
      </div>
      <UnitHint unit={draft.unit} />
      {compiled?.signals.slice(1).map((letter) => (
        <div key={letter} className="parameter-control-field">
          <span>Signal {letter}</span>
          <Select
            value={draft.signals[letter] ?? ''}
            items={signalItems}
            disabled={disabled}
            onValueChange={(next) => {
              if (next !== null)
                onChange({
                  ...draft,
                  signals: { ...draft.signals, [letter]: String(next) },
                });
            }}
          >
            <SelectTrigger
              className="workbench-select"
              aria-label={`Signal ${letter}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Choose a signal…</SelectItem>
              {matching.length > 0 && (
                <SelectGroup>
                  <SelectLabel>
                    Matched to each input by sample grid
                  </SelectLabel>
                  {matching.map((step) => (
                    <SelectItem key={step.id} value={`step:${step.id}`}>
                      {reference(step.sequence)} {stepName(step)} ·{' '}
                      {formatCount(step.outputIds.length, 'signal')}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel>
                  {sameGrid.length
                    ? 'Same sample grid'
                    : 'No other signal shares this sample grid'}
                </SelectLabel>
                {sameGrid.map((node) => (
                  <SelectItem key={node.id} value={`signal:${node.id}`}>
                    {label(node.id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ))}
      {compiled?.values.map((name) => (
        <div key={name} className="parameter-control-field">
          <span>Value {name}</span>
          <ValueSourceSelect
            label={`Value ${name}`}
            value={draft.values[name] ?? ''}
            groups={values.groups}
            items={[
              { value: '', label: 'Choose a value…', disabled: false },
              ...values.items,
            ]}
            disabled={disabled}
            onChange={(source) =>
              onChange({
                ...draft,
                values: { ...draft.values, [name]: source },
              })
            }
          />
        </div>
      ))}
      <details className="formula-help">
        <summary>Functions and operators</summary>
        <p className="parameter-hint">
          + − * / % ^ and comparisons &lt; &lt;= &gt; &gt;= == != (1 or 0).
          Functions: {FORMULA_FUNCTIONS.join(', ')}; constant pi. For example{' '}
          <code>A * B / 9549</code> or <code>if(A &gt; limit, 1, 0)</code>.
        </p>
      </details>
    </div>
  );
}
