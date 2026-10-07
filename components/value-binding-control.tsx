'use client';

import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { BindingUnit } from '@/lib/value-bindings';
import type { ValueBinding } from '@/lib/workflow-types';
import { formatCount } from '@/lib/format-count';

/** A setting's source: `''` for a typed number, else chosen values. */
export type BindingDraft = { source: string; factor: string };
export const NUMBER_DRAFT: BindingDraft = { source: '', factor: '1' };

const reference = (sequence: number) =>
  `#${String(sequence + 1).padStart(3, '0')}`;

/**
 * Sources are a value step (`step:<id>`, every value matched to each input),
 * one value (`value:<id>`), or values saved by an earlier edit or workflow
 * file (`ids:<json>`).
 */
export function draftFromBinding(
  index: WorkflowIndex,
  binding?: ValueBinding,
): BindingDraft {
  if (!binding) return NUMBER_DRAFT;
  const factor = String(binding.factor);
  const ids = binding.valueIds;
  if (ids.length === 1) return { source: `value:${ids[0]}`, factor };
  const owner = index.owner.get(ids[0]);
  if (
    owner &&
    owner.outputIds.length === ids.length &&
    owner.outputIds.every((id, position) => ids[position] === id)
  )
    return { source: `step:${owner.id}`, factor };
  return { source: `ids:${JSON.stringify(ids)}`, factor };
}

/** The binding a draft describes; undefined for a number, null if incomplete. */
export function bindingFromDraft(
  index: WorkflowIndex,
  draft: BindingDraft,
): ValueBinding | undefined | null {
  if (!draft.source) return undefined;
  const factor = Number(draft.factor);
  if (!draft.factor.trim() || !Number.isFinite(factor)) return null;
  const [kind, ...rest] = draft.source.split(':');
  const key = rest.join(':');
  const valueIds =
    kind === 'step'
      ? (index.steps.get(key)?.outputIds ?? [])
      : kind === 'value'
        ? [key]
        : (JSON.parse(key) as string[]);
  return valueIds.length && valueIds.every((id) => index.values.has(id))
    ? { valueIds, factor }
    : null;
}

/**
 * A setting that is either typed (the `children` control) or taken from
 * calculated values, scaled by a factor. Values in another unit than the
 * setting needs are listed but disabled; nothing is converted.
 */
export default function ValueBindingControl({
  label,
  index,
  inputIds,
  draft,
  unit,
  inputUnit,
  resolved,
  disabled,
  onChange,
  children,
}: {
  label: string;
  index: WorkflowIndex;
  /** The inputs being processed; a step with a value for each is preferred. */
  inputIds: string[];
  draft: BindingDraft;
  unit: BindingUnit;
  /** The unit of the previewed input, for `unit: 'input'`. */
  inputUnit: string;
  /** What the binding gives the previewed input, such as "= −5 Nm". */
  resolved?: string;
  disabled: boolean;
  onChange: (draft: BindingDraft) => void;
  children: ReactNode;
}) {
  const expected = unit === 'seconds' ? 's' : unit === 'input' ? inputUnit : '';
  const usable = (valueUnit: string) =>
    unit === 'any' || valueUnit === expected;
  const steps = [...index.steps.values()]
    .filter((step) => step.kind === 'value')
    .sort((a, b) => b.sequence - a.sequence);
  const items: { value: string; label: string; disabled: boolean }[] = [];
  const groups = steps.map((step) => {
    const values = step.outputIds.flatMap((id) => index.values.get(id) ?? []);
    const options = [
      ...(values.length > 1
        ? [
            {
              value: `step:${step.id}`,
              label: `${reference(step.sequence)} ${stepName(step)} · each input's own (${formatCount(values.length, 'value')})`,
              disabled: !values.every((value) => usable(value.unit)),
            },
          ]
        : []),
      ...values.map((value) => ({
        value: `value:${value.id}`,
        label: `${reference(step.sequence)} ${index.label(value.id)}${value.unit ? ` [${value.unit}]` : ''}`,
        disabled: !usable(value.unit),
      })),
    ];
    items.push(...options);
    return { step, options };
  });
  if (draft.source.startsWith('ids:'))
    items.push({
      value: draft.source,
      label: `${formatCount((JSON.parse(draft.source.slice(4)) as string[]).length, 'saved value')}`,
      disabled: false,
    });
  const name = label.toLowerCase();
  return (
    <div className="value-binding-control">
      <fieldset className="segment-edge-toggle value-binding-mode">
        <legend className="field-label">{label} from</legend>
        <button
          type="button"
          aria-pressed={!draft.source}
          disabled={disabled}
          onClick={() => onChange({ ...draft, source: '' })}
        >
          A number
        </button>
        <button
          type="button"
          aria-pressed={!!draft.source}
          disabled={disabled || !items.some((item) => !item.disabled)}
          title={
            items.some((item) => !item.disabled)
              ? `Take the ${name} from a calculated value`
              : `Calculate a value${expected ? ` in ${expected}` : ''} first`
          }
          onClick={() => {
            // Prefer a step with a value calculated from each input, then
            // any step, then a single value.
            const covering = groups.find(
              ({ step, options }) =>
                !options[0]?.disabled &&
                inputIds.every((id) =>
                  step.outputIds.some(
                    (value) => index.values.get(value)?.inputId === id,
                  ),
                ),
            );
            const first =
              (covering &&
                (covering.step.outputIds.length > 1
                  ? `step:${covering.step.id}`
                  : `value:${covering.step.outputIds[0]}`)) ??
              items.find(
                (item) => !item.disabled && item.value.startsWith('step:'),
              )?.value ??
              items.find((item) => !item.disabled)?.value;
            if (first) onChange({ ...draft, source: first });
          }}
        >
          A value
        </button>
      </fieldset>
      {!draft.source ? (
        children
      ) : (
        <>
          <div className="parameter-control-field">
            <span>Value</span>
            <Select
              value={draft.source}
              items={items}
              disabled={disabled}
              onValueChange={(next) => {
                if (next) onChange({ ...draft, source: String(next) });
              }}
            >
              <SelectTrigger
                className="workbench-select"
                aria-label={`${label} value`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groups.map(({ step, options }) => (
                  <SelectGroup key={step.id}>
                    <SelectLabel>
                      {reference(step.sequence)} {stepName(step)}
                    </SelectLabel>
                    {options.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
                {draft.source.startsWith('ids:') && (
                  <SelectItem value={draft.source}>
                    {items.at(-1)!.label}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <label className="parameter-control-field">
            <span>Factor</span>
            <div className="number-field">
              <input
                aria-label={`${label} factor`}
                type="number"
                step="any"
                value={draft.factor}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...draft, factor: event.target.value })
                }
              />
              <small>×</small>
            </div>
          </label>
          <p className="parameter-hint">
            {resolved ??
              (draft.source.startsWith('value:')
                ? 'Every input uses this value.'
                : 'Each input uses the value calculated from it, or from a signal it came from.')}
            {expected && unit !== 'any'
              ? ` Values must be in ${expected}.`
              : ''}
          </p>
        </>
      )}
    </div>
  );
}
