'use client';

import { useEffect, useEffectEvent, useId, useState } from 'react';
import {
  Activity,
  Eye,
  GitBranch,
  LoaderCircle,
  Scissors,
  Timer,
  BetweenHorizontalStart,
} from 'lucide-react';
import OperationCards from './operation-cards';
import TimeRangePicker from './time-range-picker';
import SegmentPlot, { type PlotThreshold } from './segment-plot';
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
import WithinControl, { type WithinOption } from './within-control';
import NameField from './name-field';
import type {
  Segment,
  SegmentationDefinition,
  SegmentationPlan,
  SegmentationScope,
  SegmentationOperation,
  SegmentScope,
  SignalNode,
  Source,
  EngineRequest,
  EngineResponse,
} from '@/lib/signal-types';
import type { ExplorerEntry } from '@/lib/signal-explorer';
import { formatCount } from '@/lib/format-count';
import { rangeMidpoint } from '@/lib/parameter-scale';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { ParameterBindings } from '@/lib/workflow-types';
import { BINDABLE_TRIGGER, matchValue } from '@/lib/value-bindings';
import ValueBindingControl, {
  NUMBER_DRAFT,
  bindingFromDraft,
  draftFromBinding,
  type BindingDraft,
} from './value-binding-control';

type TriggerForm = {
  signalId: string;
  edge: 'rising' | 'falling';
  threshold: string;
  offset: string;
  /** Optional noise rejection; blank means none. */
  hysteresis?: string;
  debounce?: string;
  /** Threshold and offset taken from values instead of typed numbers. */
  bound?: Partial<Record<'threshold' | 'offset', BindingDraft>>;
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
  /** Offers trigger settings taken from calculated values. */
  valueIndex?: WorkflowIndex;
  /** The sequence of the step being edited; later values are not offered. */
  valueBefore?: number;
  /**
   * File segments: the step finds time intervals of the whole recording.
   * `options` are earlier Segment steps to search within (nesting).
   */
  fileSegments?: { options: WithinOption[]; within?: SegmentScope };
  onPreview: (
    definition: SegmentationDefinition,
    targets: string[],
    independently: boolean,
    scope: SegmentationScope,
    within?: SegmentScope,
  ) => Promise<SegmentationPlan>;
  onCreate: (
    definition: SegmentationDefinition,
    targets: string[],
    independently: boolean,
    scope: SegmentationScope,
    within?: SegmentScope,
    /** A name chosen for a new step (`chosenNames`). */
    name?: string,
  ) => Promise<void>;
  /** Offer a name for the new step; Edit uses Rename instead. */
  nameable?: boolean;
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
const seconds = (value: number) => String(Number(value.toFixed(3)));
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
  valueIndex,
  valueBefore,
  fileSegments,
  onPreview,
  onCreate,
  nameable = false,
}: Props) {
  const partialId = useId();
  const [name, setName] = useState('');
  const [within, setWithin] = useState(fileSegments?.within);
  const parents = fileSegments?.options.find(
    (option) => option.set.id === within?.setId,
  )?.set.segments;
  // Nested ranges and windows are seconds from each parent's start.
  const nested = !!within;
  const longestParent = Math.max(
    0,
    ...(parents ?? []).map((segment) => segment.end - segment.start),
  );
  const saved = savedOperation?.definition;
  const savedTriggers = saved?.method === 'triggers' ? saved : undefined;
  const savedWindows = saved?.method === 'windows' ? saved : undefined;
  const formTrigger = (
    trigger: NonNullable<typeof savedTriggers>['start'],
    side: 'start' | 'end',
  ): TriggerForm => {
    const binding = (setting: 'threshold' | 'offset') =>
      valueIndex && savedTriggers?.bindings?.[`${side}.${setting}`]
        ? {
            [setting]: draftFromBinding(
              valueIndex,
              savedTriggers.bindings[`${side}.${setting}`],
            ),
          }
        : {};
    const bound = { ...binding('threshold'), ...binding('offset') };
    return {
      signalId: trigger.signalId,
      edge: trigger.edge,
      threshold: String(trigger.threshold),
      offset: String(trigger.offset),
      ...(trigger.hysteresis ? { hysteresis: String(trigger.hysteresis) } : {}),
      ...(trigger.debounce ? { debounce: String(trigger.debounce) } : {}),
      ...(Object.keys(bound).length ? { bound } : {}),
    };
  };
  const [method, setMethod] = useState<SegmentationDefinition['method']>(
    saved?.method ?? (workflowMode ? 'ranges' : 'triggers'),
  );
  const [start, setStart] = useState<TriggerForm>(
    savedTriggers
      ? formTrigger(savedTriggers.start, 'start')
      : {
          signalId:
            workflowMode || selectionKind === 'collection'
              ? selectedIds[0]
              : source.channels[0],
          edge: 'rising',
          threshold: '900',
          offset: workflowMode ? '0' : '-20',
        },
  );
  const [end, setEnd] = useState<TriggerForm>(
    savedTriggers
      ? formTrigger(savedTriggers.end, 'end')
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
  // New workflow triggers start halfway through their signal's range until
  // the threshold is edited. Saved trigger settings are always kept.
  const autoDefaults = workflowMode && !savedTriggers && !!rangePlot;
  const [autoThreshold, setAutoThreshold] = useState({
    start: autoDefaults,
    end: autoDefaults,
  });
  const [midpoints, setMidpoints] = useState<Record<string, number | null>>({});
  const midpointIds = [
    ...new Set([
      ...(autoThreshold.start ? [start.signalId] : []),
      ...(autoThreshold.end ? [end.signalId] : []),
    ]),
  ].filter((id) => !(id in midpoints));
  const midpointKey = rangePlot ? JSON.stringify(midpointIds) : '[]';
  const plotRequest = rangePlot?.request;
  useEffect(() => {
    const ids = JSON.parse(midpointKey) as string[];
    if (!ids.length || !plotRequest) return;
    let alive = true;
    for (const id of ids)
      void plotRequest({ type: 'view', ids: [id] })
        .then((response) => {
          const summary =
            response.type === 'plots' ? response.plots[0]?.summary : undefined;
          const value = summary?.count
            ? rangeMidpoint(summary.min, summary.max)
            : undefined;
          if (alive) setMidpoints((old) => ({ ...old, [id]: value ?? null }));
        })
        .catch(() => {
          if (alive) setMidpoints((old) => ({ ...old, [id]: null }));
        });
    return () => {
      alive = false;
    };
  }, [midpointKey, plotRequest]);
  const automatic = (form: TriggerForm, auto: boolean): TriggerForm => {
    if (!auto) return form;
    const value = midpoints[form.signalId];
    return {
      ...form,
      threshold:
        value === undefined
          ? ''
          : value === null
            ? form.threshold
            : String(value),
    };
  };
  const startForm = automatic(start, autoThreshold.start);
  const endForm = automatic(end, autoThreshold.end);
  const findingThreshold =
    (autoThreshold.start && midpoints[start.signalId] === undefined) ||
    (autoThreshold.end && midpoints[end.signalId] === undefined);
  const editTrigger =
    (boundary: 'start' | 'end') =>
    (next: TriggerForm): void => {
      const form = boundary === 'start' ? startForm : endForm;
      if (next.threshold !== form.threshold)
        setAutoThreshold((old) => ({ ...old, [boundary]: false }));
      (boundary === 'start' ? setStart : setEnd)(next);
    };
  const [minimum, setMinimum] = useState(
    String(savedTriggers?.minimumDuration ?? 0),
  );
  // Nested ranges and windows start at each parent's start.
  const [ranges, setRanges] = useState(
    saved?.method === 'ranges'
      ? saved.ranges.map((range) => range.join(', ')).join('\n')
      : nested
        ? `0, ${seconds(Math.min(longestParent, 5) || 1)}`
        : rangePlot
          ? ''
          : `${defaultRange?.[0] ?? source.start}, ${defaultRange?.[1] ?? Math.min(source.end, source.start + 30)}`,
  );
  const [windowStart, setWindowStart] = useState(
    String(
      savedWindows?.start ?? (nested ? 0 : (defaultRange?.[0] ?? source.start)),
    ),
  );
  const [windowEnd, setWindowEnd] = useState(
    savedWindows
      ? String(savedWindows.end)
      : nested
        ? seconds(longestParent || 1)
        : String(defaultRange?.[1] ?? source.end),
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
    plan?: SegmentationPlan;
    error?: string;
  }>();
  // The last successful plan keeps plot bands steady while a new one runs.
  const [lastPlan, setLastPlan] = useState<{
    method: SegmentationDefinition['method'];
    plan: SegmentationPlan;
  }>();
  const [error, setError] = useState('');
  const key = JSON.stringify([
    method,
    startForm,
    endForm,
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
    within,
  ]);
  const currentPreview = preview?.key === key ? preview : undefined;
  const plan = currentPreview?.plan;
  // Workflow dialogs preview automatically; earlier workspaces keep a button.
  const autoPreview = workflowMode;
  const rangeRows = rangeFields(ranges);
  const invalidRanges =
    method === 'ranges' &&
    (!rangeRows.length ||
      rangeRows.length > 1000 ||
      rangeRows.some((fields) => !validTimeRange(fields)));
  const pendingThreshold = method === 'triggers' && findingThreshold;
  const signals = nodes
    .filter((node) => node.sourceId === source.id)
    .map((node) => ({
      value: node.id,
      label: `${signalLabel ? signalLabel(node.id) : `${node.name} · ${segments.find((segment) => segment.nodes.includes(node.id))?.name ?? node.operation}`} [${node.unit}]`,
    }));
  function definition(): SegmentationDefinition {
    if (method === 'triggers') {
      const bindings: ParameterBindings = {};
      // A bound setting is saved as its result; the engine resolves it.
      const trigger = (side: 'start' | 'end', form: TriggerForm) => {
        const setting = (name: 'threshold' | 'offset') => {
          const draft = form.bound?.[name];
          if (!draft?.source || !valueIndex) return number(form[name]);
          const binding = bindingFromDraft(valueIndex, draft);
          if (!binding)
            throw new Error(
              `Choose a value and a finite factor for the ${side} ${name}.`,
            );
          bindings[`${side}.${name}`] = binding;
          return 0;
        };
        const noise = (name: 'hysteresis' | 'debounce') => {
          const text = form[name]?.trim();
          if (!text) return {};
          const value = number(text);
          if (value < 0)
            throw new Error(
              `The ${side} ${name} must be zero or more, or blank.`,
            );
          return value > 0 ? { [name]: value } : {};
        };
        return {
          signalId: form.signalId,
          edge: form.edge,
          threshold: setting('threshold'),
          offset: setting('offset'),
          ...noise('hysteresis'),
          ...noise('debounce'),
        };
      };
      return {
        method,
        boundary,
        start: trigger('start', startForm),
        end: trigger('end', endForm),
        minimumDuration: number(minimum),
        ...(Object.keys(bindings).length ? { bindings } : {}),
      };
    }
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
  const targets =
    target === 'selection'
      ? selectedIds
      : target === 'file'
        ? source.channels
        : [target];
  function request(): [
    SegmentationDefinition,
    string[],
    boolean,
    SegmentationScope,
    SegmentScope | undefined,
  ] {
    if (fileSegments)
      return [definition(), selectedIds, false, 'signals', within];
    const independently =
      target === 'selection' &&
      targets.length > 1 &&
      (savedOperation?.independently ?? selectionKind === 'collection');
    const scope: SegmentationScope = target === 'file' ? 'file' : 'signals';
    return [definition(), targets, independently, scope, undefined];
  }
  function changeWithin(next?: SegmentScope) {
    const wasNested = nested;
    setWithin(next);
    setError('');
    if (!!next === wasNested) return;
    // Switching between absolute and parent-relative times resets the times.
    const longest = next
      ? Math.max(
          0,
          ...(fileSegments?.options
            .find((option) => option.set.id === next.setId)
            ?.set.segments.map((segment) => segment.end - segment.start) ?? []),
        )
      : 0;
    if (next) {
      setRanges(`0, ${seconds(Math.min(longest, 5) || 1)}`);
      setWindowStart('0');
      setWindowEnd(seconds(longest || 1));
    } else {
      setRanges(
        rangePlot
          ? ''
          : `${defaultRange?.[0] ?? source.start}, ${defaultRange?.[1] ?? Math.min(source.end, source.start + 30)}`,
      );
      setWindowStart(String(defaultRange?.[0] ?? source.start));
      setWindowEnd(String(defaultRange?.[1] ?? source.end));
    }
  }
  async function run(previewOnly: boolean) {
    setError('');
    try {
      const settings = request();
      if (previewOnly) setPreview({ key, plan: await onPreview(...settings) });
      else await onCreate(...settings, nameable ? name : undefined);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to segment this recording.',
      );
    }
  }
  const refreshPreview = useEffectEvent(
    async (requestKey: string, current: () => boolean) => {
      const planned = method;
      try {
        const plan = await onPreview(...request());
        if (!current()) return;
        setPreview({ key: requestKey, plan });
        setLastPlan({ method: planned, plan });
      } catch (caught) {
        // A newer preview supersedes this one; its cancellation is not news.
        if (!current()) return;
        setPreview({
          key: requestKey,
          error:
            caught instanceof Error
              ? caught.message
              : 'These settings could not be previewed.',
        });
      }
    },
  );
  useEffect(() => {
    if (!autoPreview || invalidRanges || pendingThreshold) return;
    let current = true;
    // Debounced so typing and dragging produce one preview per pause.
    const timer = setTimeout(
      () => void refreshPreview(key, () => current),
      300,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [autoPreview, invalidRanges, pendingThreshold, key]);
  const bandPlan =
    plan ?? (lastPlan?.method === method ? lastPlan.plan : undefined);
  /** What a bound trigger setting gives its trigger signal, if known. */
  const boundNumber = (
    trigger: TriggerForm,
    name: 'threshold' | 'offset',
  ): number | undefined => {
    const draft = trigger.bound?.[name];
    if (!draft?.source || !valueIndex) return undefined;
    const binding = bindingFromDraft(valueIndex, draft);
    if (!binding) return undefined;
    try {
      const value = matchValue(valueIndex, binding, trigger.signalId).value;
      return value === null ? undefined : binding.factor * value;
    } catch {
      return undefined;
    }
  };
  const thresholdLine = (
    boundary: 'start' | 'end',
    trigger: TriggerForm,
  ): PlotThreshold => ({
    boundary,
    signalId: trigger.signalId,
    value: trigger.bound?.threshold?.source
      ? (boundNumber(trigger, 'threshold') ?? NaN)
      : trigger.threshold.trim()
        ? Number(trigger.threshold)
        : NaN,
    edge: trigger.edge,
    // Dragging the line types the new threshold, replacing a bound value.
    onChange: (value) =>
      editTrigger(boundary)({
        ...trigger,
        threshold: String(value),
        bound: { ...trigger.bound, threshold: NUMBER_DRAFT },
      }),
  });
  const windowSpan: [number, number] | undefined =
    windowStart.trim() &&
    windowEnd.trim() &&
    Number(windowEnd) > Number(windowStart)
      ? [Number(windowStart), Number(windowEnd)]
      : undefined;
  const savedNoise = !!(
    savedTriggers &&
    [savedTriggers.start, savedTriggers.end].some(
      (trigger) => trigger.hysteresis || trigger.debounce,
    )
  );
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
        {workflowMode ? (
          <fieldset className="segment-edge-toggle">
            <legend className="field-label">Crossing</legend>
            {(['rising', 'falling'] as const).map((edge) => (
              <button
                key={edge}
                type="button"
                aria-pressed={trigger.edge === edge}
                aria-label={`${label} ${edge === 'rising' ? 'rising above' : 'falling below'}`}
                onClick={() => update({ ...trigger, edge })}
              >
                {edge === 'rising' ? '↗ Rising above' : '↘ Falling below'}
              </button>
            ))}
          </fieldset>
        ) : (
          <>
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
          </>
        )}
        {valueIndex ? (
          (['threshold', 'offset'] as const).map((name) => {
            const resolved = boundNumber(trigger, name);
            return (
              <ValueBindingControl
                key={name}
                label={`${label} ${name}`}
                index={valueIndex}
                inputIds={[trigger.signalId]}
                before={valueBefore}
                draft={trigger.bound?.[name] ?? NUMBER_DRAFT}
                unit={BINDABLE_TRIGGER[`start.${name}`]}
                inputUnit={unit}
                resolved={
                  resolved === undefined
                    ? undefined
                    : `Uses ${Number(resolved.toPrecision(6))} ${name === 'offset' ? 's' : unit}.`.replace(
                        / \.$/,
                        '.',
                      )
                }
                disabled={busy}
                onChange={(draft) =>
                  update({
                    ...trigger,
                    bound: { ...trigger.bound, [name]: draft },
                  })
                }
              >
                <Numeric
                  label={`${label} ${name}`}
                  value={trigger[name]}
                  unit={name === 'offset' ? 's' : unit}
                  onChange={(value) => update({ ...trigger, [name]: value })}
                />
              </ValueBindingControl>
            );
          })
        ) : (
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
        )}
        {workflowMode && (
          <details
            className="segment-noise"
            // Constant per dialog: open when the saved trigger used it.
            open={savedNoise}
          >
            <summary>Ignore chatter</summary>
            <div className="segment-field-pair">
              <Numeric
                label={`${label} hysteresis`}
                value={trigger.hysteresis ?? ''}
                unit={unit}
                onChange={(hysteresis) => update({ ...trigger, hysteresis })}
              />
              <Numeric
                label={`${label} debounce`}
                value={trigger.debounce ?? ''}
                onChange={(debounce) => update({ ...trigger, debounce })}
              />
            </div>
            <p className="input-hint">
              Hysteresis: after a crossing, the signal must return this far past
              the threshold before the next one counts. Debounce: a crossing
              counts only if the signal stays crossed this long.
            </p>
          </details>
        )}
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
              label: `Whole recording · ${formatCount(source.channels.length, 'original signal')}`,
            },
            {
              value: 'selection',
              label:
                selectedIds.length > 1
                  ? `Selected ${formatCount(selectedIds.length, 'signal')}`
                  : 'Single signal · selected output',
            },
            ...signals,
          ]}
          onChange={setTarget}
        />
      </div>
    );
  }
  const scopeHint = fileSegments ? (
    <p className="input-hint segmentation-scope-hint">
      {nested
        ? 'Searches each parent segment separately. Ranges and windows are seconds from each parent’s start; triggers use recording time.'
        : 'Segments are time intervals of the whole recording, not signals. Choose them later with Within when you derive signals or calculate values.'}
    </p>
  ) : (
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
  const createLabel =
    applyLabel ??
    (fileSegments
      ? 'Create segments'
      : savedOperation
        ? 'Create revised segments'
        : target === 'file'
          ? 'Create file segments'
          : 'Create signal segments');
  // Segment numbers restart per member when members are segmented separately,
  // matching the names the engine gives new segments.
  const planNumbers = new Map<string, number>();
  const rangeNumbers =
    plan?.ranges.map((range) => {
      const key = range.parentId ?? range.inputId ?? '';
      const number = (planNumbers.get(key) ?? 0) + 1;
      planNumbers.set(key, number);
      return number;
    }) ?? [];
  const parentName = (id?: string) =>
    id
      ? `${valueIndex?.segmentLabel(id) ?? parents?.find((segment) => segment.id === id)?.name ?? 'Segment'}.`
      : '';
  const clipped = plan?.ranges.filter((range) => range.clipped).length ?? 0;
  const blocked = invalidRanges
    ? 'Add a valid time range to create segments.'
    : currentPreview?.error
      ? `The preview failed: ${currentPreview.error}`
      : plan && !plan.ranges.length
        ? 'No segments match these settings yet.'
        : '';
  const footerSummary = pendingThreshold
    ? 'Finding a starting threshold…'
    : plan
      ? `${formatCount(plan.ranges.length, 'segment')} · ${seconds(Math.min(...plan.ranges.map((range) => range.start)))}–${seconds(Math.max(...plan.ranges.map((range) => range.end)))} s · ${clipped} clipped`
      : 'Updating the segment preview…';
  const body = (
    <>
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
              {nested && method !== 'triggers'
                ? 'Seconds from each parent’s start'
                : `${source.id === '' ? 'Workspace time' : 'Recording time'} · seconds`}
            </span>
          </div>
        )}
        {method === 'triggers' && (
          <>
            {rangePlot && (
              <SegmentPlot
                graph={rangePlot.graph}
                request={rangePlot.request}
                label={
                  signalLabel ??
                  ((id) => rangePlot.graph.nodes.get(id)?.name ?? id)
                }
                ids={[...new Set([start.signalId, end.signalId])].filter((id) =>
                  rangePlot.graph.nodes.has(id),
                )}
                busy={busy}
                ranges={bandPlan?.ranges}
                thresholds={[
                  thresholdLine('start', startForm),
                  thresholdLine('end', endForm),
                ]}
                help="Drag a threshold line up or down. Shaded bands are the segments these settings create; triangles mark the crossings."
              />
            )}
            <div className={workflowMode ? 'segment-trigger-grid' : undefined}>
              {triggerEditor('Start', startForm, editTrigger('start'))}
              {triggerEditor('End', endForm, editTrigger('end'))}
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
          (rangePlot && !nested ? (
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
                {nested
                  ? 'Start, end · seconds from each parent’s start, one range per line'
                  : workflowMode
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
                {nested
                  ? `Parent segments last up to ${seconds(longestParent)} s. Overlapping intervals are allowed.`
                  : 'Use recording time. Overlapping intervals are allowed.'}
              </p>
            </>
          ))}
        {method === 'windows' && (
          <>
            {rangePlot && !nested && (
              <SegmentPlot
                graph={rangePlot.graph}
                request={rangePlot.request}
                label={
                  signalLabel ??
                  ((id) => rangePlot.graph.nodes.get(id)?.name ?? id)
                }
                ids={targets.filter((id) => rangePlot.graph.nodes.has(id))}
                busy={busy}
                ranges={bandPlan?.ranges}
                span={
                  windowSpan
                    ? {
                        range: windowSpan,
                        onChange: ([a, b]) => {
                          setWindowStart(String(a));
                          setWindowEnd(String(b));
                        },
                      }
                    : undefined
                }
                help="Drag the highlighted range, or either edge, to choose where windows start and stop. Bands show each window."
              />
            )}
            <div className="segment-field-pair">
              <Numeric
                label={nested ? 'From (after parent start)' : 'Range start'}
                value={windowStart}
                onChange={setWindowStart}
              />
              <Numeric
                label={nested ? 'To (after parent start)' : 'Range end'}
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
            {workflowMode && (
              <div className="segment-quick-actions">
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={step === duration}
                  onClick={() => setStep(duration)}
                >
                  Back to back
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={Number(step) === Number(duration) / 2}
                  disabled={!(Number(duration) > 0)}
                  onClick={() => setStep(String(Number(duration) / 2))}
                >
                  50 % overlap
                </button>
                {defaultRange && !nested && (
                  <button
                    type="button"
                    className="secondary-button"
                    aria-pressed={
                      Number(windowStart) === defaultRange[0] &&
                      Number(windowEnd) === defaultRange[1]
                    }
                    onClick={() => {
                      setWindowStart(String(defaultRange[0]));
                      setWindowEnd(String(defaultRange[1]));
                    }}
                  >
                    Whole signal
                  </button>
                )}
              </div>
            )}
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
          {fileSegments && valueIndex ? (
            <WithinControl
              index={valueIndex}
              options={fileSegments.options}
              value={within}
              onChange={changeWithin}
              entire="Entire recording"
              disabled={busy}
            />
          ) : (
            workflowMode && targetEditor()
          )}
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
        {nameable && (
          <NameField
            value={name}
            onChange={setName}
            kind="segments"
            count={1}
            disabled={busy}
          />
        )}
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
      <div
        className="segment-preview"
        aria-live="polite"
        data-empty={!plan && !autoPreview}
      >
        {plan ? (
          <>
            <strong>
              {formatCount(
                plan.ranges.length,
                fileSegments
                  ? 'segment'
                  : `${target === 'file' ? 'file' : 'signal'} segment`,
              )}{' '}
              · {clipped} clipped
            </strong>
            <small>
              {plan.skipped} excluded ·{' '}
              {formatCount(plan.incomplete, 'unpaired start')}
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
                  <span>
                    {parentName(range.parentId)}
                    {String(rangeNumbers[index]).padStart(2, '0')}
                  </span>
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
        ) : autoPreview && currentPreview?.error ? (
          <small className="segment-preview-error">
            {currentPreview.error}
          </small>
        ) : autoPreview ? (
          <small>
            {invalidRanges ? (
              <>
                <Eye size={16} /> Add a valid range to preview segments.
              </>
            ) : pendingThreshold ? (
              <>
                <LoaderCircle size={16} className="segment-preview-spinner" />
                Finding a starting threshold from the signal’s range…
              </>
            ) : (
              <>
                <LoaderCircle size={16} className="segment-preview-spinner" />
                Updating the segment preview…
              </>
            )}
          </small>
        ) : (
          <small>
            <Eye size={16} /> Preview to check the segment count and boundaries.
          </small>
        )}
      </div>
    </>
  );
  if (workflowMode)
    return (
      <div className="segmentation-editor workflow-segmentation-editor">
        <div className="operation-body">
          <fieldset className="segmentation-fields" disabled={busy}>
            {body}
          </fieldset>
        </div>
        <div className="operation-footer">
          <p className="operation-footer-summary" aria-live="polite">
            {error ? (
              <span className="operation-footer-reason" role="alert" data-error>
                {error}
              </span>
            ) : blocked ? (
              <span
                className="operation-footer-reason"
                data-error={
                  (!invalidRanges && !!currentPreview?.error) || undefined
                }
              >
                {blocked}
              </span>
            ) : (
              footerSummary
            )}
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={() => void run(false)}
            disabled={busy || !!blocked || pendingThreshold}
          >
            <Scissors size={14} />
            {createLabel}
          </button>
        </div>
      </div>
    );
  return (
    <fieldset className="segmentation-editor" disabled={busy}>
      {body}
      {error && (
        <p className="segment-error" role="alert">
          {error}
        </p>
      )}
      <div className="segment-actions">
        {!autoPreview && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void run(true)}
            disabled={invalidRanges}
          >
            <Eye size={14} />
            Preview
          </button>
        )}
        <button
          className="primary-button"
          type="button"
          onClick={() => void run(false)}
          disabled={invalidRanges}
        >
          <Scissors size={14} />
          {createLabel}
        </button>
      </div>
      <p className="input-hint">
        <GitBranch size={12} />{' '}
        {applyLabel
          ? 'Saving updates this operation and recalculates its dependent results. Undo restores the previous version.'
          : savedOperation
            ? 'Revised settings create a new Segment operation. Existing segments retain their original settings.'
            : 'Creates immutable crop recipes. Calculations remain separate steps.'}
      </p>
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
