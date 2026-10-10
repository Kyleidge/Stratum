'use client';
import { useMemo, useState } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { ChevronDown } from 'lucide-react';
import {
  describeUnit,
  UNIT_GROUPS,
  UNSTATED_UNIT,
  unitSuggestions,
} from '@/lib/units';

type UnitItem = { label: string; family: string };
type UnitGroup = { value: string; items: UnitItem[] };
const GROUPS: UnitGroup[] = UNIT_GROUPS.map((group) => ({
  value: group.family,
  items: group.units.map((label) => ({ label, family: group.family })),
}));

/** Units whose label or quantity contains the query, by quantity. */
function matchingGroups(query: string): UnitGroup[] {
  const text = query.trim().toLowerCase();
  if (!text) return GROUPS;
  return GROUPS.flatMap((group) => {
    if (group.value.toLowerCase().includes(text)) return [group];
    const items = group.items.filter((item) =>
      item.label.toLowerCase().includes(text),
    );
    return items.length ? [{ ...group, items }] : [];
  });
}

/**
 * A unit label typed freely or picked from the recognised units, grouped by
 * quantity in a scrolling list. It only names a unit; nothing is converted.
 * Opening the list shows every unit until the user types to filter it.
 */
export function UnitInput({
  value,
  label,
  placeholder = 'Unit',
  invalid,
  disabled,
  onChange,
}: {
  value: string;
  /** Accessible name, such as “Unit of Torque in the file”. */
  label: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState(false);
  const filtered = useMemo(
    () => matchingGroups(typed ? value : ''),
    [typed, value],
  );
  return (
    <Autocomplete.Root
      items={GROUPS}
      filteredItems={filtered}
      value={value}
      openOnInputClick
      disabled={disabled}
      itemToStringValue={(item: UnitItem) => item.label}
      onOpenChange={(open, details) => {
        // Typing opens a filtered list; clicking opens every unit.
        if (!open || details.reason !== 'input-change') setTyped(false);
      }}
      onValueChange={(next, details) => {
        if (details.reason === 'input-change') setTyped(true);
        onChange(next);
      }}
    >
      <div className="unit-input">
        <Autocomplete.Input
          aria-label={label}
          aria-invalid={invalid}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
        />
        <Autocomplete.Trigger
          className="unit-input-trigger"
          aria-label={`Choose ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        >
          <ChevronDown size={14} aria-hidden />
        </Autocomplete.Trigger>
      </div>
      <Autocomplete.Portal>
        <Autocomplete.Positioner
          className="isolate z-50"
          sideOffset={4}
          align="start"
        >
          <Autocomplete.Popup className="unit-input-popup">
            <Autocomplete.Empty className="unit-input-empty">
              No recognised unit matches. Type the unit if it is not listed.
            </Autocomplete.Empty>
            <Autocomplete.List className="unit-input-list">
              {(group: UnitGroup) => (
                <Autocomplete.Group
                  key={group.value}
                  items={group.items}
                  className="unit-input-group"
                >
                  <Autocomplete.GroupLabel className="unit-input-group-label">
                    {group.value}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: UnitItem) => (
                      <Autocomplete.Item
                        key={`${item.family}:${item.label}`}
                        value={item}
                        className="unit-input-item"
                      >
                        {item.label}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
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
 * The unit a file's values are in, for one signal (or every signal sharing
 * a label): typed or picked from the recognised units, set to No unit, or,
 * for a label Stratum does not recognise, kept as a custom unit. It names
 * the unit only; converting is a Derive step after importing. `—` is an
 * unstated unit and '' is no unit.
 */
export default function UnitField({
  value,
  custom,
  label,
  onChange,
  onKeep,
}: {
  value: string;
  custom: ReadonlySet<string>;
  /** Accessible name, such as “Unit of Torque”. */
  label: string;
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
      <UnitInput
        value={text}
        label={label}
        invalid={state === 'unstated' || state === 'unknown'}
        placeholder={state === 'none' ? 'No unit' : 'Unit in the file'}
        onChange={(next) => onChange(next.trim() ? next : UNSTATED_UNIT)}
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
