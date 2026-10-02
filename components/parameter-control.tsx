'use client';

import { Slider } from '@/components/ui/slider';
import {
  sliderPosition,
  sliderValue,
  type ParameterScale,
} from '@/lib/parameter-scale';

const STEPS = 1000;

/**
 * An exact number field with a slider and presets for quick choices. The text
 * field keeps the typed value; the slider only proposes readable values.
 */
export default function ParameterControl({
  label,
  value,
  unit,
  scale,
  hint,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  unit?: string;
  scale?: ParameterScale;
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const numeric = Number(value);
  return (
    <div className="parameter-control">
      <label className="parameter-control-field">
        <span>{label}</span>
        <div className="number-field">
          <input
            aria-label={label}
            type="number"
            step="any"
            min={scale && !scale.log && scale.min >= 0 ? scale.min : undefined}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {unit && <small>{unit}</small>}
        </div>
      </label>
      {scale && (
        <div className="parameter-slider">
          <Slider
            thumbLabel={`${label} slider`}
            min={0}
            max={STEPS}
            step={1}
            disabled={disabled}
            value={Math.round(sliderPosition(numeric, scale) * STEPS)}
            onValueChange={(position) =>
              onChange(String(sliderValue(Number(position) / STEPS, scale)))
            }
          />
          <span aria-hidden="true">
            <small>{scale.min.toLocaleString('en-GB')}</small>
            <small>{scale.log ? 'log scale' : ''}</small>
            <small>{scale.max.toLocaleString('en-GB')}</small>
          </span>
        </div>
      )}
      {!!scale?.presets.length && (
        <fieldset className="parameter-presets" disabled={disabled}>
          <legend className="sr-only">{label} presets</legend>
          {scale.presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              title={preset.title}
              aria-pressed={numeric === preset.value}
              onClick={() => onChange(String(preset.value))}
            >
              {preset.label}
            </button>
          ))}
        </fieldset>
      )}
      {hint && <p className="parameter-hint">{hint}</p>}
    </div>
  );
}
