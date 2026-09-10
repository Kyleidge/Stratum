'use client';

import type { ReactNode } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

export type OperationCard = {
  value: string;
  label: string;
  visual: ReactNode;
  hint?: string;
};

export default function OperationCards({
  label,
  value,
  items,
  disabled,
  category,
  onChange,
}: {
  label: string;
  value: string;
  items: OperationCard[];
  disabled: boolean;
  category?: string;
  onChange: (value: string) => void;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(String(next))}
      disabled={disabled}
      aria-label={label}
      className="signal-palette-grid"
      data-category={category}
    >
      {items.map((item) => (
        <label
          key={item.value}
          className="signal-operation-card"
          data-selected={value === item.value || undefined}
        >
          <span className="signal-operation-formula" aria-hidden="true">
            {item.visual}
          </span>
          <span>{item.label}</span>
          {item.hint && (
            <small className="operation-card-hint">{item.hint}</small>
          )}
          <RadioGroupItem value={item.value} aria-label={item.label} />
        </label>
      ))}
    </RadioGroup>
  );
}
