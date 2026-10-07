'use client';

import { useState } from 'react';
import {
  Activity,
  AlarmClock,
  ArrowDownToLine,
  ArrowUpToLine,
  ChartNoAxesCombined,
  Clock3,
  Crosshair,
  Hash,
  MoveHorizontal,
  MoveVertical,
  Ruler,
  Sigma,
  SquareSigma,
  StepBack,
  StepForward,
  Timer,
  TimerOff,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  VALUE_FUNCTIONS,
  type ValueGroup,
  type ValueOperation,
} from '@/lib/workflow-types';
import OperationCards from './operation-cards';

const visuals: Record<ValueOperation, { icon: LucideIcon; hint: string }> = {
  'time-average': { icon: Clock3, hint: 'Weighted by elapsed time' },
  'sample-average': { icon: Sigma, hint: 'Equal weight for every sample' },
  minimum: { icon: ArrowDownToLine, hint: 'Lowest sample and its time' },
  maximum: { icon: ArrowUpToLine, hint: 'Highest sample and its time' },
  'start-value': { icon: StepBack, hint: 'First valid sample' },
  'end-value': { icon: StepForward, hint: 'Last valid sample' },
  'value-at': { icon: Crosshair, hint: 'At a time from the start' },
  rms: { icon: Activity, hint: 'Root mean square' },
  'standard-deviation': { icon: ChartNoAxesCombined, hint: 'Spread, n − 1' },
  'peak-to-peak': { icon: MoveVertical, hint: 'Maximum − minimum' },
  area: { icon: SquareSigma, hint: 'Area under the signal' },
  duration: { icon: Ruler, hint: 'Length of the input' },
  'time-of-minimum': { icon: AlarmClock, hint: 'Seconds to the minimum' },
  'time-of-maximum': { icon: Timer, hint: 'Seconds to the maximum' },
  'time-above': { icon: TrendingUp, hint: 'Seconds above a threshold' },
  'time-below': { icon: TimerOff, hint: 'Seconds below a threshold' },
  'first-crossing': { icon: MoveHorizontal, hint: 'Seconds to a crossing' },
  'crossing-count': { icon: Hash, hint: 'Crossings of a threshold' },
};
const groups: ValueGroup[] = ['Level', 'Spread', 'Time', 'Events'];

export default function ValueOperationPalette({
  value,
  disabled,
  results,
  onChange,
}: {
  value: string;
  disabled: boolean;
  /** Previewed result of each calculation for the focused input. */
  results?: Partial<Record<ValueOperation, string>>;
  onChange: (value: string) => void;
}) {
  const [group, setGroup] = useState<ValueGroup>(
    VALUE_FUNCTIONS.find((spec) => spec.operation === value)?.group ?? 'Level',
  );
  return (
    <Tabs
      value={group}
      onValueChange={(next) => {
        const chosen = groups.find((item) => item === String(next));
        if (!chosen) return;
        setGroup(chosen);
        // A tab selects its first calculation, so the settings and preview
        // always match the visible cards.
        const members = VALUE_FUNCTIONS.filter((spec) => spec.group === chosen);
        if (!members.some((spec) => spec.operation === value))
          onChange(members[0].operation);
      }}
      className="signal-palette"
    >
      <TabsList aria-label="Value categories" className="signal-palette-tabs">
        {groups.map((name) => (
          <TabsTrigger key={name} value={name} disabled={disabled}>
            {name}
          </TabsTrigger>
        ))}
      </TabsList>
      {groups.map((name) => (
        <TabsContent key={name} value={name}>
          <OperationCards
            label={`${name} values`}
            category="Values"
            value={value}
            disabled={disabled}
            onChange={onChange}
            items={VALUE_FUNCTIONS.filter((spec) => spec.group === name).map(
              (spec) => {
                const { icon: Icon, hint } = visuals[spec.operation];
                return {
                  value: spec.operation,
                  label: spec.name,
                  visual: <Icon size={21} />,
                  hint,
                  detail: results?.[spec.operation],
                };
              },
            )}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
