'use client';

import { hasNameToken } from '@/lib/output-names';

/**
 * The optional name a creation dialog gives its step or outputs; the engine
 * applies it with `chosenNames`. Edit uses Rename instead.
 */
export default function NameField({
  value,
  onChange,
  kind,
  count,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Segment steps name the step; signals and values name each output. */
  kind: 'signal' | 'value' | 'segments';
  /** How many outputs the step creates (at most, within segments). */
  count: number;
  /** The automatic name, when there is one to show. */
  placeholder?: string;
  disabled?: boolean;
}) {
  const name = value.trim() || 'Name';
  const hint =
    kind === 'segments'
      ? 'Names the step; its segments stay numbered.'
      : count <= 1
        ? 'Leave blank for an automatic name. You can rename it later.'
        : hasNameToken(value)
          ? '{input} is each output’s input, {segment} its segment and {n} its number.'
          : `Each output is named “${kind === 'value' ? `${name} · input` : `input · ${name}`}”, and the step “${name}”. Use {input}, {segment} or {n} to arrange it.`;
  return (
    <div className="name-field">
      <label className="parameter-control-field">
        <span>{kind === 'segments' ? 'Step name' : 'Name'}</span>
        <div className="number-field">
          <input
            aria-label={kind === 'segments' ? 'Step name' : 'Name'}
            maxLength={160}
            value={value}
            placeholder={placeholder || 'Automatic'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      </label>
      <p className="parameter-hint">{hint}</p>
    </div>
  );
}
