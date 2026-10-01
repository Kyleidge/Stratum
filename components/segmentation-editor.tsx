'use client';

import { useId, useState } from 'react';
import {
  Activity,
  Eye,
  GitBranch,
  Scissors,
  Timer,
  BetweenHorizontalStart,
} from 'lucide-react';
import OperationCards from './operation-cards';
import TimeRangePicker from './time-range-picker';
import type { SignalGraph } from '@/lib/signal-graph';
import {
  readTimeRanges,
  rangeFields,
  validTimeRange,
} from '@/lib/time-range-selection';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  Segment,
  SegmentationDefinition,
  SegmentationPlan,
  SegmentationScope,
  SegmentationOperation,
  SignalNode,
  Source,
  EngineRequest,
  EngineResponse,
} from '@/lib/signal-types';
import type { ExplorerEntry } from '@/lib/signal-explorer';

type TriggerForm = {
  signalId: string;
  edge: 'rising' | 'falling';
  threshold: string;
  offset: string;
};
type Props = {
  source: Source;
  nodes: SignalNode[];
  segments: Segment[];
  busy: boolean;
  selectedIds: string[];
  selectionKind?: ExplorerEntry['kind'];
  savedOperation?: SegmentationOperation;
  workflowMode?: boolean;
  applyLabel?: string;
  defaultRange?: [number, number];
  rangePlot?: {
    graph: SignalGraph;
    request: (message: EngineRequest) => Promise<EngineResponse>;
  };
  /** Workflow label for a signal; History and dialogs must name it alike. */
  signalLabel?: (id: string) => string;
  onPreview: (
    definition: SegmentationDefinition,
    targets: string[],
    independently: boolean,
    scope: SegmentationScope,
  ) => Promise<SegmentationPlan>;
  onCreate: (
    definition: SegmentationDefinition,
    targets: string[],
    independently: boolean,
    scope: SegmentationScope,
  ) => Promise<void>;
};

function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger className="workbench-select" aria-label={label}>
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
  );
}

function Numeric({
  label,
  value,
  unit = 's',
  onChange,
}: {
  label: string;
  value: string;
  unit?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="segment-numeric">
      <span className="field-label">{label}</span>
      <div className="number-field">
        <input
          aria-label={label}
          type="number"
          step="any"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>{unit}</span>
      </div>
    </label>
  );
}

function number(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error('Enter a finite number in every numeric field.');
  return Number(value);
}
const time = (value: number) => `${Number(value.toFixed(3))} s`;
const methods = [
  {
    value: 'ranges',
    label: 'Time ranges',
    visual: <BetweenHorizontalStart size={21} />,
    hint: 'Choose start and end times',
  },
  {
    value: 'windows',
    label: 'Windows',
    visual: <Timer size={21} />,
    hint: 'Split at regular intervals',
  },
  {
    value: 'triggers',
    label: 'Triggers',
    visual: <Activity size={21} />,
    hint: 'Follow signal crossings',
  },
];

export default function SegmentationEditor({
  source,
  nodes,
  segments,
  busy,
  selectedIds,
  selectionKind,
  savedOperation,
  workflowMode = false,
  applyLabel,
  defaultRange,
  rangePlot,
  signalLabel,
  onPreview,
  onCreate,
}: Props) {
  const partialId = useId();
  const saved = savedOperation?.definition;
  const savedTriggers = saved?.method === 'triggers' ? saved : undefined;
  const savedWindows = saved?.method === 'windows' ? saved : undefined;
  const formTrigger = (
    trigger: NonNullable<typeof savedTriggers>['start'],
  ): TriggerForm => ({
    signalId: trigger.signalId,
    edge: trigger.edge,
    threshold: String(trigger.threshold),
    offset: String(trigger.offset),
  });
  const [method, setMethod] = useState<SegmentationDefinition['method']>(
    saved?.method ?? (workflowMode ? 'ranges' : 'triggers'),
  );
  const [start, setStart] = useState<TriggerForm>(
    savedTriggers
      ? formTrigger(savedTriggers.start)
      : {
          signalId:
            workflowMode || selectionKind === 'collection'
              ? selectedIds[0]
              : source.channels[0],
          edge: 'rising',
          threshold: '900',
          offset: '-20',
        },
  );
  const [end, setEnd] = useState<TriggerForm>(
    savedTriggers
      ? formTrigger(savedTriggers.end)
      : {
          signalId:
            workflowMode || selectionKind === 'collection'
              ? selectedIds[0]
              : source.channels[0],
          edge: 'falling',
          threshold: '900',
          offset: '0',
        },
  );
  const [minimum, setMinimum] = useState(
    String(savedTriggers?.minimumDuration ?? 0),
  );
  const [ranges, setRanges] = useState(
    saved?.method === 'ranges'
      ? saved.ranges.map((range) => range.join(', ')).join('\n')
      : rangePlot
        ? ''
        : `${defaultRange?.[0] ?? source.start}, ${defaultRange?.[1] ?? Math.min(source.end, source.start + 30)}`,
  );
  const [windowStart, setWindowStart] = useState(
    String(savedWindows?.start ?? defaultRange?.[0] ?? source.start),
  );
  const [windowEnd, setWindowEnd] = useState(
    String(savedWindows?.end ?? defaultRange?.[1] ?? source.end),
  );
  const [duration, setDuration] = useState(
    String(savedWindows?.duration ?? 30),
  );
  const [step, setStep] = useState(String(savedWindows?.step ?? 30));
  const [partial, setPartial] = useState(savedWindows?.includePartial ?? false);
  const [boundary, setBoundary] = useState<'clip' | 'discard'>(
    saved?.boundary ?? 'clip',
  );
  const [target, setTarget] = useState(
    savedOperation
      ? savedOperation.scope === 'file'
        ? 'file'
        : 'selection'
      : workflowMode || selectionKind === 'collection'
        ? 'selection'
        : 'file',
  );
  const [preview, setPreview] = useState<{
    key: string;
    plan: SegmentationPlan;
  }>();
  const [error, setError] = useState('');
  const key = JSON.stringify([
    method,
    start,
    end,
    minimum,
    ranges,
    windowStart,
    windowEnd,
    duration,
    step,
    partial,
    boundary,
    target,
    selectedIds,
    selectionKind,
  ]);
  const plan = preview?.key === key ? preview.plan : undefined;
  const rangeRows = rangeFields(ranges);
  const invalidRanges =
    method === 'ranges' &&
    (!rangeRows.length ||
      rangeRows.length > 1000 ||
      rangeRows.some((fields) => !validTimeRange(fields)));
  const signals = nodes
    .filter((node) => node.sourceId === source.id)
    .map((node) => ({
      value: node.id,
      label: `${signalLabel ? signalLabel(node.id) : `${node.name} · ${segments.find((segment) => segment.nodes.includes(node.id))?.name ?? node.operation}`} [${node.unit}]`,
    }));
  function definition(): SegmentationDefinition {
    if (method === 'triggers')
      return {
        method,
        boundary,
        start: {
          ...start,
          threshold: number(start.threshold),
          offset: number(start.offset),
        },
        end: {
          ...end,
          threshold: number(end.threshold),
          offset: number(end.offset),
        },
        minimumDuration: number(minimum),
      };
    if (method === 'windows')
      return {
        method,
        boundary,
        start: number(windowStart),
        end: number(windowEnd),
        duration: number(duration),
        step: number(step),
        includePartial: partial,
      };
    return {
      method,
      boundary,
      ranges: readTimeRanges(ranges),
    };
  }
  async function run(previewOnly: boolean) {
    setError('');
    try {
      const config = definition();
      const targets =
        target === 'selection'
          ? selectedIds
          : target === 'file'
            ? source.channels
            : [target];
      const independently =
        target === 'selection' &&
        targets.length > 1 &&
        (savedOperation?.independently ?? selectionKind === 'collection');
      const scope: SegmentationScope = target === 'file' ? 'file' : 'signals';
      if (previewOnly)
        setPreview({
          key,
          plan: await onPreview(config, targets, independently, scope),
        });
      else await onCreate(config, targets, independently, scope);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to segment this recording.',
      );
    }
  }
  function triggerEditor(
    label: string,
    trigger: TriggerForm,
    update: (value: TriggerForm) => void,
  ) {
    const unit = nodes.find((node) => node.id === trigger.signalId)?.unit ?? '';
    return (
      <fieldset className="trigger-card">
        <legend>
          {workflowMode ? `${label} boundary` : `${label} BOUNDARY`}
        </legend>
        {workflowMode && <div className="field-label">Signal</div>}
        <Choice
          label={`${label} trigger signal`}
          value={trigger.signalId}
          items={signals}
          onChange={(signalId) => update({ ...trigger, signalId })}
        />
        <div className="field-label">Crossing</div>
        <Choice
          label={`${label} edge`}
          value={trigger.edge}
          items={[
            { value: 'rising', label: '↗ Rising above' },
            { value: 'falling', label: '↘ Falling below' },
          ]}
          onChange={(edge) => {
            if (edge === 'rising' || edge === 'falling')
              update({ ...trigger, edge });
          }}
        />
        <div className="segment-field-pair">
          <Numeric
            label={`${label} threshold`}
            value={trigger.threshold}
            unit={unit}
            onChange={(threshold) => update({ ...trigger, threshold })}
          />
          <Numeric
            label={`${label} offset`}
            value={trigger.offset}
            onChange={(offset) => update({ ...trigger, offset })}
          />
        </div>
      </fieldset>
    );
  }
  function targetEditor() {
    return (
      <div className="segment-target-setting">
        <div className="field-label">Segment target</div>
        <Choice
          label="Segment target"
          value={target}
          items={[
            {
              value: 'file',
              label: `Entire file · ${source.channels.length} original signals`,
            },
            {
              value: 'selection',
              label:
                selectedIds.length > 1
                  ? `Selected ${selectedIds.length} signals`
                  : 'Single signal · selected output',
            },
            ...signals,
          ]}
          onChange={setTarget}
        />
      </div>
    );
  }
  const scopeHint = (
    <p className="input-hint segmentation-scope-hint">
      {target === 'file'
        ? 'Each interval becomes a file segment containing every original signal, with shared start and end boundaries.'
        : workflowMode
          ? target === 'selection' && selectedIds.length > 1
            ? 'Each selected signal is segmented independently. A trigger on the first signal follows the matching signal in each branch.'
            : 'Each interval creates a new signal from this input.'
          : 'Creates signal segments beneath their input signals. Other channels keep their existing history.'}
    </p>
  );
  return (
    <fieldset
      className={`segmentation-editor${workflowMode ? ' workflow-segmentation-editor' : ''}`}
      disabled={busy}
    >
      {!workflowMode && (
        <>
          {targetEditor()}
          {scopeHint}
        </>
      )}
      {workflowMode ? (
        <OperationCards
          label="Segmentation method"
          category="Segments"
          value={method}
          items={methods}
          disabled={busy}
          onChange={(value) => {
            if (
              value === 'ranges' ||
              value === 'windows' ||
              value === 'triggers'
            )
              setMethod(value);
            setError('');
          }}
        />
      ) : (
        <>
          <div className="field-label">Method</div>
          <Choice
            label="Segmentation method"
            value={method}
            items={[
              { value: 'triggers', label: 'Signal edge triggers' },
              { value: 'ranges', label: 'Manual time ranges' },
              { value: 'windows', label: 'Fixed-duration windows' },
            ]}
            onChange={(value) => {
              if (
                value === 'triggers' ||
                value === 'ranges' ||
                value === 'windows'
              )
                setMethod(value);
            }}
          />
        </>
      )}
      <div
        className={
          workflowMode
            ? 'signal-operation-settings segment-method-settings'
            : undefined
        }
      >
        {workflowMode && (
          <div className="signal-settings-heading">
            <strong>
              {methods.find((item) => item.value === method)!.label}
            </strong>
            <span className="segment-time-reference">
              {source.id === '' ? 'Workspace time' : 'Recording time'} · seconds
            </span>
          </div>
        )}
        {method === 'triggers' && (
          <>
            <div className={workflowMode ? 'segment-trigger-grid' : undefined}>
              {triggerEditor('Start', start, setStart)}
              {triggerEditor('End', end, setEnd)}
            </div>
            <Numeric
              label="Minimum output duration"
              value={minimum}
              onChange={setMinimum}
            />
            <p className="input-hint">
              The first start pairs with the next later end. Offsets apply after
              pairing; negative values include earlier data. Missing trigger
              samples break a pair. Filter a signal explicitly if needed.
            </p>
          </>
        )}
        {method === 'ranges' &&
          (rangePlot ? (
            <TimeRangePicker
              graph={rangePlot.graph}
              label={signalLabel}
              request={rangePlot.request}
              ids={
                target === 'selection'
                  ? selectedIds
                  : target === 'file'
                    ? source.channels
                    : [target]
              }
              value={ranges}
              onChange={setRanges}
              busy={busy}
            />
          ) : (
            <>
              <label className="field-label" htmlFor="segment-ranges">
                {workflowMode
                  ? 'Start, end · one range per line'
                  : 'Start, end — seconds, one range per line'}
              </label>
              <Textarea
                id="segment-ranges"
                className="segment-ranges"
                rows={4}
                value={ranges}
                onChange={(event) => setRanges(event.target.value)}
              />
              <p className="input-hint">
                Use recording time. Overlapping intervals are allowed.
              </p>
            </>
          ))}
        {method === 'windows' && (
          <>
            <div className="segment-field-pair">
              <Numeric
                label="Range start"
                value={windowStart}
                onChange={setWindowStart}
              />
              <Numeric
                label="Range end"
                value={windowEnd}
                onChange={setWindowEnd}
              />
            </div>
            <div className="segment-field-pair">
              <Numeric
                label="Window duration"
                value={duration}
                onChange={setDuration}
              />
              <Numeric
                label="Step between starts"
                value={step}
                onChange={setStep}
              />
            </div>
            <label className="segment-checkbox" htmlFor={partialId}>
              <Checkbox
                id={partialId}
                checked={partial}
                disabled={busy}
                onCheckedChange={setPartial}
              />
              Include a shorter final window
            </label>
            <p className="input-hint">
              A step shorter than the duration creates overlapping windows.
            </p>
          </>
        )}
      </div>
      <div
        className={
          workflowMode
            ? 'signal-operation-settings segment-scope-settings'
            : undefined
        }
      >
        {workflowMode && (
          <div className="signal-settings-heading">
            <strong>Scope & boundaries</strong>
          </div>
        )}
        <div className={workflowMode ? 'segment-scope-grid' : undefined}>
          {workflowMode && targetEditor()}
          <div>
            <div className="field-label">Outside available data</div>
            <Choice
              label="Recording boundary policy"
              value={boundary}
              items={[
                { value: 'clip', label: 'Clip to available interval' },
                { value: 'discard', label: 'Discard incomplete interval' },
              ]}
              onChange={(value) => {
                if (value === 'clip' || value === 'discard') setBoundary(value);
              }}
            />
          </div>
        </div>
        {workflowMode && scopeHint}
        {!workflowMode &&
          target === 'selection' &&
          selectedIds.length > 1 &&
          selectionKind === 'collection' && (
            <p className="input-hint">
              Each member is segmented separately. A trigger using the first
              member follows the corresponding member in each branch.
            </p>
          )}
      </div>
      <div className="segment-preview" aria-live="polite" data-empty={!plan}>
        {plan ? (
          <>
            <strong>
              {plan.ranges.length}{' '}
              {target === 'file' ? 'file segments' : 'signal segments'} ·{' '}
              {plan.ranges.filter((range) => range.clipped).length} clipped
            </strong>
            <small>
              {plan.skipped} excluded · {plan.incomplete} unpaired starts
            </small>
            {!plan.ranges.length && (
              <p className="input-hint">
                {method === 'triggers'
                  ? 'No complete crossing pairs. Check that the start signal crosses the threshold, then the end signal crosses later. Starting above a threshold is not a rising crossing. Try a manual range to verify the target.'
                  : 'No intervals contain data. Check the recording times, window duration, and boundary policy.'}
              </p>
            )}
            <ol>
              {plan.ranges.map((range, index) => (
                <li
                  key={index}
                  title={`${range.inputId ? `${signalLabel ? signalLabel(range.inputId) : nodes.find((node) => node.id === range.inputId)?.name} · ` : ''}Requested ${time(range.requestedStart)} to ${time(range.requestedEnd)}`}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <code>
                    {range.inputId && (
                      <small>
                        Member {selectedIds.indexOf(range.inputId) + 1} ·{' '}
                      </small>
                    )}
                    {time(range.start)} → {time(range.end)}
                  </code>
                  {range.clipped && <span>clip</span>}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <small>
            <Eye size={16} /> Preview to check the segment count and boundaries.
          </small>
        )}
      </div>
      {error && (
        <p className="segment-error" role="alert">
          {error}
        </p>
      )}
      <div className="segment-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void run(true)}
          disabled={invalidRanges}
        >
          <Eye size={14} />
          Preview
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void run(false)}
          disabled={invalidRanges}
        >
          <Scissors size={14} />
          {applyLabel ??
            (savedOperation
              ? 'Create revised segments'
              : target === 'file'
                ? 'Create file segments'
                : 'Create signal segments')}
        </button>
      </div>
      {!workflowMode && (
        <p className="input-hint">
          <GitBranch size={12} />{' '}
          {applyLabel
            ? 'Saving updates this operation and recalculates its dependent results. Undo restores the previous version.'
            : savedOperation
              ? 'Revised settings create a new Segment operation. Existing segments retain their original settings.'
              : 'Creates immutable crop recipes. Calculations remain separate steps.'}
        </p>
      )}
    </fieldset>
  );
}

export function SegmentProvenance({
  segment,
  nodes,
}: {
  segment: Segment;
  nodes: SignalNode[];
}) {
  const recipe = segment.definition;
  const offset = (value: number) => `${value >= 0 ? '+' : ''}${time(value)}`;
  function triggerText(trigger: {
    signalId: string;
    edge: string;
    threshold: number;
    offset: number;
  }) {
    const signal = nodes.find((node) => node.id === trigger.signalId);
    return `${signal?.name ?? 'Signal'} ${trigger.edge === 'rising' ? 'rises above' : 'falls below'} ${trigger.threshold} ${signal?.unit ?? ''}; offset ${offset(trigger.offset)}`;
  }
  return (
    <div className="segment-provenance">
      <div className="section-heading">SAVED SEGMENT RECIPE</div>
      <p>
        <strong>{segment.name}</strong> · {time(segment.start)} →{' '}
        {time(segment.end)} (recording time)
      </p>
      {segment.scope && (
        <p>
          {segment.scope === 'file'
            ? 'Entire file · shared boundaries across every original signal.'
            : 'Signal-only segmentation · selected input signals.'}
        </p>
      )}
      {recipe?.method === 'triggers' ? (
        <>
          <p>Start: {triggerText(recipe.start)}</p>
          <p>End: {triggerText(recipe.end)}</p>
          <p>
            Minimum output duration {time(recipe.minimumDuration)}. Crossings at{' '}
            {time(segment.boundary?.startTrigger ?? segment.start)} and{' '}
            {time(segment.boundary?.endTrigger ?? segment.end)}.
          </p>
        </>
      ) : recipe?.method === 'windows' ? (
        <p>
          Window {time(recipe.duration)} · step {time(recipe.step)} ·{' '}
          {recipe.includePartial ? 'includes' : 'excludes'} shorter final
          windows.
        </p>
      ) : recipe?.method === 'ranges' ? (
        <p>Explicit time range.</p>
      ) : (
        <p>
          Legacy segmentation definition, retained from the earlier prototype.
        </p>
      )}
      {recipe && (
        <p>
          Boundary policy: {recipe.boundary === 'clip' ? 'clip' : 'discard'}.{' '}
          {segment.boundary?.clipped
            ? `Clipped from requested ${time(segment.boundary.requestedStart)} → ${time(segment.boundary.requestedEnd)}.`
            : 'Full requested interval retained.'}
        </p>
      )}
    </div>
  );
}
