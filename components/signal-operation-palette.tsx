'use client';

import { useState } from 'react';
import {
  Calculator,
  ChartNoAxesColumnDecreasing,
  ChartNoAxesColumnIncreasing,
  ChartScatter,
  ChartSpline,
  Clock3,
  ListFilter,
  MoveHorizontal,
  SlidersHorizontal,
  Sigma,
  TimerReset,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import OperationCards from './operation-cards';
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
      'formula',
      'convert',
    ],
  },
  {
    name: 'Filters',
    icon: SlidersHorizontal,
    operations: [
      'smooth',
      'median',
      'exponential',
      'low-pass',
      'high-pass',
      'butterworth-low',
      'butterworth-high',
    ],
  },
  {
    name: 'Time',
    icon: Clock3,
    operations: ['zero-time', 'time-shift', 'resample'],
  },
  { name: 'Calculus', icon: Sigma, operations: ['derivative', 'integral'] },
];

export const OPERATION_FORMULAS: Partial<Record<string, string>> = {
  add: 'A + B',
  subtract: 'A − B',
  multiply: 'A × B',
  divide: 'A ÷ B',
  scale: 'A × k',
  offset: 'A + k',
  absolute: '|A|',
  formula: 'f(A, B…)',
  convert: 'A → unit',
  derivative: 'dA / dt',
  integral: '∫ A dt',
};

const OPERATION_ICONS: Partial<Record<string, LucideIcon>> = {
  smooth: Waves,
  median: ListFilter,
  exponential: ChartSpline,
  'low-pass': ChartNoAxesColumnDecreasing,
  'high-pass': ChartNoAxesColumnIncreasing,
  'butterworth-low': ChartNoAxesColumnDecreasing,
  'butterworth-high': ChartNoAxesColumnIncreasing,
  'zero-time': TimerReset,
  'time-shift': MoveHorizontal,
  resample: ChartScatter,
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
      onValueChange={(next) => {
        const chosen = groups.find((item) => item.name === String(next));
        if (!chosen) return;
        setGroup(chosen.name);
        // A category tab selects its first operation, so the settings and
        // preview always match the visible cards.
        if (!chosen.operations.includes(value)) onChange(chosen.operations[0]);
      }}
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
          <OperationCards
            value={value}
            onChange={onChange}
            disabled={disabled}
            label={`${name} operations`}
            category={name}
            items={operations.map((operation) => {
              const spec = SIGNAL_FUNCTIONS.find(
                (item) => item.operation === operation,
              )!;
              const Icon = OPERATION_ICONS[operation];
              return {
                value: operation,
                label: spec.name,
                visual: Icon ? (
                  <Icon size={18} />
                ) : (
                  OPERATION_FORMULAS[operation]
                ),
              };
            })}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
