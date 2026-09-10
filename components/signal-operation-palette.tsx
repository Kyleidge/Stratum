'use client';

import { useState } from 'react';
import { Calculator, Clock3, SlidersHorizontal, Sigma } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { FUNCTIONS } from '@/lib/signal-functions';

export const SIGNAL_FUNCTIONS = FUNCTIONS.filter(
  (spec) => spec.operation !== 'segment' && spec.operation !== 'min-max',
);

const groups = [
  {
    name: 'Math',
    icon: Calculator,
    operations: [
      'add',
      'subtract',
      'multiply',
      'divide',
      'scale',
      'offset',
      'absolute',
    ],
  },
  {
    name: 'Filters',
    icon: SlidersHorizontal,
    operations: ['smooth', 'median', 'exponential', 'low-pass', 'high-pass'],
  },
  {
    name: 'Time',
    icon: Clock3,
    operations: ['zero-time', 'time-shift', 'resample'],
  },
  { name: 'Calculus', icon: Sigma, operations: ['derivative', 'integral'] },
];

export const OPERATION_FORMULAS: Record<string, string> = {
  add: 'A + B',
  subtract: 'A − B',
  multiply: 'A × B',
  divide: 'A ÷ B',
  scale: 'A × k',
  offset: 'A + k',
  absolute: '|A|',
  smooth: 'mean(A)',
  median: 'median(A)',
  exponential: 'α',
  'low-pass': 'low-pass',
  'high-pass': 'high-pass',
  'zero-time': 't → 0',
  'time-shift': 't + Δt',
  resample: 'Δt',
  derivative: 'dA / dt',
  integral: '∫ A dt',
};

export function SignalOperationPalette({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (operation: string) => void;
}) {
  const [group, setGroup] = useState(
    groups.find((item) => item.operations.includes(value))?.name ?? 'Math',
  );
  return (
    <Tabs
      value={group}
      onValueChange={(next) => setGroup(String(next))}
      className="signal-palette"
    >
      <TabsList
        aria-label="Operation categories"
        className="signal-palette-tabs"
      >
        {groups.map(({ name, icon: Icon }) => (
          <TabsTrigger key={name} value={name} disabled={disabled}>
            <Icon size={15} />
            {name}
          </TabsTrigger>
        ))}
      </TabsList>
      {groups.map(({ name, operations }) => (
        <TabsContent key={name} value={name}>
          <RadioGroup
            value={value}
            onValueChange={(next) => onChange(String(next))}
            disabled={disabled}
            aria-label={`${name} operations`}
            className="signal-palette-grid"
            data-category={name}
          >
            {operations.map((operation) => {
              const spec = SIGNAL_FUNCTIONS.find(
                (item) => item.operation === operation,
              )!;
              return (
                <label
                  key={operation}
                  className="signal-operation-card"
                  data-selected={value === operation || undefined}
                >
                  <span className="signal-operation-formula" aria-hidden="true">
                    {OPERATION_FORMULAS[operation]}
                  </span>
                  <span>{spec.name}</span>
                  <RadioGroupItem value={operation} aria-label={spec.name} />
                </label>
              );
            })}
          </RadioGroup>
        </TabsContent>
      ))}
    </Tabs>
  );
}
