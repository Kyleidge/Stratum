'use client';

import { ArrowDownToLine, ArrowUpToLine, Clock3, Sigma } from 'lucide-react';
import { VALUE_FUNCTIONS, type ValueOperation } from '@/lib/workflow-types';
import OperationCards from './operation-cards';

const visuals = {
  'time-average': { icon: Clock3, hint: 'Weighted by elapsed time' },
  'sample-average': { icon: Sigma, hint: 'Equal weight for every sample' },
  minimum: { icon: ArrowDownToLine, hint: 'Lowest sample and its time' },
  maximum: { icon: ArrowUpToLine, hint: 'Highest sample and its time' },
};
const order: ValueOperation[] = [
  'time-average',
  'sample-average',
  'minimum',
  'maximum',
];

export default function ValueOperationPalette({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <OperationCards
      label="Value calculation"
      category="Values"
      value={value}
      disabled={disabled}
      onChange={onChange}
      items={order.map((operation) => {
        const spec = VALUE_FUNCTIONS.find(
          (item) => item.operation === operation,
        )!;
        const { icon: Icon, hint } = visuals[operation];
        return {
          value: operation,
          label: spec.name,
          visual: <Icon size={21} />,
          hint,
        };
      })}
    />
  );
}
