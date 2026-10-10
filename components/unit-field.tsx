'use client';
import {
  describeUnit,
  UNIT_GROUPS,
  UNSTATED_UNIT,
  unitSuggestions,
} from '@/lib/units';

/** One shared list of recognised units for every unit field in a dialog. */
export function UnitOptions({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {UNIT_GROUPS.flatMap((group) =>
        group.units.map((unit) => (
          <option key={`${group.family}:${unit}`} value={unit}>
            {group.family}
          </option>
        )),
      )}
    </datalist>
  );
}

/**
 * Says what a typed output unit is: its quantity, no unit, or a warning that
 * Stratum cannot convert a unit it does not recognise.
 */
export function UnitHint({ unit }: { unit: string }) {
  const label = unit.trim();
  const info = label ? describeUnit(label) : undefined;
  const suggestions = label && !info ? unitSuggestions(label) : [];
  return (
    <p className="parameter-hint unit-hint" data-known={!label || !!info}>
      {!label
        ? 'No unit.'
        : info
          ? `${info.quantity ?? 'A unit Stratum recognises'}${info.label !== label ? ` (${info.label})` : ''}.`
          : `Stratum does not recognise ${label}${suggestions.filter(Boolean).length ? ` (did you mean ${suggestions.filter(Boolean).join(' or ')}?)` : ''}, so it can never be converted.`}
    </p>
  );
}

export type UnitState = 'unstated' | 'none' | 'known' | 'custom' | 'unknown';

/** Whether a unit can be imported as it is, and why not. */
export function unitState(
  value: string,
  custom: ReadonlySet<string>,
): UnitState {
  const label = value.trim();
  if (value === UNSTATED_UNIT) return 'unstated';
  if (!label) return 'none';
  if (describeUnit(label)) return 'known';
  return custom.has(label) ? 'custom' : 'unknown';
}

/**
 * A unit for one signal (or every signal sharing a label): typed with
 * suggestions from the recognised units, set to No unit, or, for a label
 * Stratum does not recognise, kept as a custom unit that never converts.
 * `—` is an unstated unit and '' is no unit.
 */
export default function UnitField({
  value,
  custom,
  label,
  listId,
  onChange,
  onKeep,
}: {
  value: string;
  custom: ReadonlySet<string>;
  /** Accessible name, such as “Unit of Torque”. */
  label: string;
  listId: string;
  onChange: (value: string) => void;
  /** Keeps an unrecognised label as a custom unit. */
  onKeep: (label: string) => void;
}) {
  const state = unitState(value, custom);
  const text = value === UNSTATED_UNIT ? '' : value;
  const info = state === 'known' ? describeUnit(value) : undefined;
  const suggestions =
    state === 'unknown'
      ? unitSuggestions(value).filter((item) => item !== '')
      : [];
  return (
    <div className="unit-field" data-state={state}>
      <input
        type="text"
        value={text}
        list={listId}
        maxLength={40}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        aria-invalid={state === 'unstated' || state === 'unknown'}
        placeholder={state === 'none' ? 'No unit' : 'Unit'}
        onChange={(event) =>
          onChange(
            event.target.value.trim() ? event.target.value : UNSTATED_UNIT,
          )
        }
      />
      <small aria-live="polite">
        {state === 'known' && (info?.quantity ?? 'Recognised')}
        {state === 'none' && 'No unit'}
        {state === 'custom' && 'Custom unit · never converted'}
        {state === 'unstated' && (
          <span className="unit-field-problem">Needs a unit</span>
        )}
        {state === 'unknown' && (
          <span className="unit-field-problem">Not recognised</span>
        )}
        {suggestions.map((item) => (
          <button
            key={item}
            type="button"
            className="workflow-link"
            onClick={() => onChange(item)}
          >
            Use {item}
          </button>
        ))}
        {(state === 'unstated' || state === 'unknown') && (
          <button
            type="button"
            className="workflow-link"
            onClick={() => onChange('')}
          >
            No unit
          </button>
        )}
        {state === 'unknown' && (
          <button
            type="button"
            className="workflow-link"
            onClick={() => onKeep(value.trim())}
          >
            Keep as custom
          </button>
        )}
        {state === 'none' && (
          <button
            type="button"
            className="workflow-link"
            onClick={() => onChange(UNSTATED_UNIT)}
          >
            Change
          </button>
        )}
      </small>
    </div>
  );
}
