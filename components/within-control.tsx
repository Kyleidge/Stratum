'use client';

import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount } from '@/lib/format-count';
import { segmentInterval } from '@/lib/file-segments';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import { stepReference } from '@/lib/workflow-lifecycle';
import type { SegmentScope, SegmentSet } from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';
import WorkflowList from './workflow-list';

export type WithinOption = { step: WorkflowStep; set: SegmentSet };

/**
 * Segment steps whose segments apply to every input: the same recording (or
 * workspace time axis). When editing, only steps before `before` qualify.
 */
export function withinOptions(
  index: WorkflowIndex,
  inputIds: string[],
  before?: number,
  exclude?: string,
): WithinOption[] {
  const sources = new Set(
    inputIds.map((id) => index.nodes.get(id)?.sourceId ?? '\0'),
  );
  if (sources.size !== 1) return [];
  const [sourceId] = sources;
  return [...index.steps.values()]
    .filter(
      (step) =>
        step.segmentSetId &&
        step.id !== exclude &&
        (before === undefined || step.sequence < before),
    )
    .sort((a, b) => b.sequence - a.sequence)
    .flatMap((step) => {
      const set = index.project.segmentSets?.find(
        (item) => item.id === step.segmentSetId,
      );
      return set && set.sourceId === sourceId ? [{ step, set }] : [];
    });
}

/** Default scope for a dialog opened from a segment or a segment step. */
export function withinFromSelection(
  index: WorkflowIndex,
  selection: { kind: 'step' | 'output'; id: string },
): SegmentScope | undefined {
  if (selection.kind === 'output') {
    const entry = index.segments.get(selection.id);
    return entry
      ? { setId: entry.set.id, segmentIds: [selection.id] }
      : undefined;
  }
  const step = index.steps.get(selection.id);
  return step?.segmentSetId ? { setId: step.segmentSetId } : undefined;
}

/**
 * "Within": the entire signal, every segment of a Segment step, or chosen
 * segments of it. Long segment lists are paged.
 */
export default function WithinControl({
  index,
  options,
  value,
  onChange,
  entire = 'Entire signal',
  hint,
  disabled,
}: {
  index: WorkflowIndex;
  options: WithinOption[];
  value?: SegmentScope;
  onChange: (value?: SegmentScope) => void;
  entire?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const allId = useId();
  const chosen = options.find((option) => option.set.id === value?.setId);
  const items = [
    { value: '', label: entire },
    ...options.map(({ step, set }) => ({
      value: set.id,
      label: `${stepReference(step)} ${stepName(step)} · ${formatCount(set.segments.length, 'segment')}`,
    })),
  ];
  // A saved scope whose step is no longer offered still shows what it was.
  if (value && !chosen)
    items.push({ value: value.setId, label: 'Unavailable segments' });
  const picked = new Set(value?.segmentIds ?? []);
  return (
    <div className="within-control">
      <label className="region-field">
        <span>Within</span>
        <Select
          value={value?.setId ?? ''}
          items={items}
          disabled={disabled || (!options.length && !value)}
          onValueChange={(next) => {
            if (next === null) return;
            onChange(next ? { setId: String(next) } : undefined);
          }}
        >
          <SelectTrigger className="workbench-select" aria-label="Within">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {chosen && value && (
        <div className="within-segments">
          <label className="segment-checkbox" htmlFor={allId}>
            <Checkbox
              id={allId}
              checked={!value.segmentIds}
              disabled={disabled}
              onCheckedChange={(all) =>
                onChange(
                  all
                    ? { setId: value.setId }
                    : {
                        setId: value.setId,
                        segmentIds: chosen.set.segments.map((s) => s.id),
                      },
                )
              }
            />
            All {formatCount(chosen.set.segments.length, 'segment')}
          </label>
          {value.segmentIds && (
            <WorkflowList
              className="within-segment-list"
              items={chosen.set.segments}
              initialOpen
              summary={`${formatCount(picked.size, 'segment')} chosen`}
            >
              {(page) => (
                <ul>
                  {page.map((segment) => (
                    <li key={segment.id}>
                      <label className="segment-checkbox">
                        <Checkbox
                          checked={picked.has(segment.id)}
                          disabled={
                            disabled ||
                            (picked.size === 1 && picked.has(segment.id))
                          }
                          onCheckedChange={(on) =>
                            onChange({
                              setId: value.setId,
                              segmentIds: chosen.set.segments
                                .map((item) => item.id)
                                .filter((id) =>
                                  id === segment.id ? on : picked.has(id),
                                ),
                            })
                          }
                        />
                        <span>{index.segmentLabel(segment.id)}</span>
                        <small>{segmentInterval(segment)}</small>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </WorkflowList>
          )}
        </div>
      )}
      {hint && <p className="input-hint">{hint}</p>}
      {!options.length && !value && (
        <p className="input-hint">
          Use Segment to find time intervals of this recording, then work within
          them here.
        </p>
      )}
    </div>
  );
}
