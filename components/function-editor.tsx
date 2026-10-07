'use client';

import { useEffect, useState } from 'react';
import { Eye, Hash, LoaderCircle, Scan, Waves } from 'lucide-react';
import { FUNCTIONS } from '@/lib/signal-functions';
import { operationLabels } from '@/lib/signal-explorer';
import {
  arithmeticUnit,
  isArithmetic,
  isBinaryOperation,
} from '@/lib/signal-arithmetic';
import {
  formatDuration,
  formatQuantity,
  parameterContext,
  parameterHint,
  parameterScale,
  rangeMidpoint,
} from '@/lib/parameter-scale';
import { VALUE_TAGS, valueReference } from '@/lib/plot-scratchpad';
import type { WorkflowIndex } from '@/lib/workflow-history';
import {
  statisticTime,
  statisticValue,
  VALUE_FUNCTIONS,
  valueSpec as findValueSpec,
  valueUnit,
  type ValueOperation,
  type ValueParameters,
  type ValueStatistics,
  type WorkflowStep,
} from '@/lib/workflow-types';
import type {
  DerivePreview,
  EngineRequest,
  EngineResponse,
  Operation,
  Plot,
  Project,
  SignalNode,
} from '@/lib/signal-types';
import ValueOperationPalette from './value-operation-palette';
import {
  OPERATION_FORMULAS,
  SIGNAL_FUNCTIONS,
  SignalOperationPalette,
} from './signal-operation-palette';
import ParameterControl from './parameter-control';
import PreviewLanes, { type PreviewTrace } from './preview-lanes';
import { RegionSelect, finite } from './region-controls';
import { formatValue } from './signal-chart';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount } from '@/lib/format-count';

export type FunctionDraft = {
  editingStepId?: string;
  kind: 'derive' | 'segment' | 'value';
  ids: string[];
  operation?: Operation | ValueOperation;
  parameter?: number;
  secondaryId?: string;
  /** Saved settings of a parameterised value calculation. */
  valueParameters?: ValueParameters;
};
type Request = (message: EngineRequest) => Promise<EngineResponse>;
type Range = [number, number];
/** Inputs offered by the preview chooser; every input is still processed. */
const PREVIEW_CHOICES = 100;
/** Inputs whose values are calculated ahead of creation. */
const VALUE_PREVIEW_LIMIT = 12;
/** Device-local memory of the last created operation; never workflow history. */
const LAST_OPERATION_KEY = {
  derive: 'stratum-last-derive-v1',
  value: 'stratum-last-value-v1',
} as const;
const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function initialOperation(kind: 'derive' | 'value') {
  try {
    const stored = window.localStorage.getItem(LAST_OPERATION_KEY[kind]);
    if (
      stored &&
      (kind === 'value'
        ? VALUE_FUNCTIONS.some((spec) => spec.operation === stored)
        : SIGNAL_FUNCTIONS.some((spec) => spec.operation === stored))
    )
      return stored;
  } catch {
    // Storage can be unavailable; fall back to the default below.
  }
  return kind === 'value' ? 'time-average' : 'smooth';
}

function rememberOperation(kind: 'derive' | 'value', operation: string) {
  try {
    window.localStorage.setItem(LAST_OPERATION_KEY[kind], operation);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

/**
 * The sample-grid identity the engine checks before combining two signals,
 * mirrored here only to group Input B choices. The engine still validates.
 */
function gridKey(nodes: ReadonlyMap<string, SignalNode>, id: string): string {
  const operations: [string, Record<string, number>][] = [];
  let node = nodes.get(id);
  while (node && node.operation !== 'raw') {
    if (node.timeRecipe?.kind === 'resample')
      return JSON.stringify([
        node.timeReference?.id,
        node.timeRecipe.grid,
        operations,
      ]);
    if (
      node.timeRecipe?.kind === 'align' ||
      node.timeRecipe?.kind === 'crop' ||
      node.operation === 'min-max'
    )
      return JSON.stringify([node.id, operations]);
    if (
      ['crop', 'resample', 'time-shift', 'zero-time'].includes(node.operation)
    ) {
      const last = operations.at(-1);
      if (node.operation === 'crop' && last?.[0] === 'crop') {
        const a = last[1],
          b = node.parameters;
        const end = Math.min(a.end, b.end);
        last[1] = {
          start: Math.max(a.start, b.start),
          end,
          endExclusive:
            (a.end === end && a.endExclusive === 1) ||
            (b.end === end && b.endExclusive === 1)
              ? 1
              : 0,
        };
      } else
        operations.push([
          node.operation,
          node.operation === 'crop'
            ? {
                ...node.parameters,
                endExclusive: node.parameters.endExclusive ?? 0,
              }
            : node.parameters,
        ]);
    }
    node = nodes.get(node.parents[0]);
  }
  return JSON.stringify([node?.sourceId, operations]);
}

export default function FunctionEditor({
  editor,
  project,
  index,
  request,
  busy,
  onApply,
  onCompare,
}: {
  editor: FunctionDraft;
  project: Project;
  index: WorkflowIndex;
  request: Request;
  busy: boolean;
  onApply: (
    operation: Operation | ValueOperation,
    parameter: number,
    secondaryId: string,
    valueParameters?: ValueParameters,
  ) => Promise<void>;
  /** Opens Compare & align for inputs from other recordings or time grids. */
  onCompare?: () => void;
}) {
  const values = editor.kind === 'value';
  const [operation, setOperation] = useState<string>(
    () =>
      editor.operation ??
      initialOperation(editor.kind === 'value' ? 'value' : 'derive'),
  );
  const [parameter, setParameter] = useState(() =>
    String(
      editor.parameter ??
        SIGNAL_FUNCTIONS.find((spec) => spec.operation === operation)
          ?.defaultValue ??
        0,
    ),
  );
  const [secondaryId, setSecondaryId] = useState(editor.secondaryId ?? '');
  const [previewId, setPreviewId] = useState(editor.ids[0]);
  const [error, setError] = useState('');
  // An untouched threshold follows the previewed input's range midpoint.
  const [valueForm, setValueForm] = useState<ValueForm>(() =>
    initialValueForm(editor.valueParameters),
  );
  const valueSpec = values ? findValueSpec(operation) : undefined;
  const spec = values
    ? undefined
    : (SIGNAL_FUNCTIONS.find((spec) => spec.operation === operation) ??
      FUNCTIONS.find((spec) => spec.operation === operation));
  const binary = isBinaryOperation(operation);
  const sourceId = index.nodes.get(editor.ids[0])?.sourceId;
  const inputGrids = new Set(editor.ids.map((id) => gridKey(index.nodes, id)));
  const secondInputs = project.nodes.filter(
    (node) =>
      node.sourceId === sourceId &&
      (!node.internal || node.id === editor.secondaryId) &&
      (isArithmetic(operation) ||
        (operation === 'power'
          ? node.unit.toLowerCase() === 'rpm'
          : node.unit.toLowerCase() === 'kw')),
  );
  const secondItem = (node: SignalNode) => ({
    value: node.id,
    label: `${reference(index.owner.get(node.id))} ${index.label(node.id)}${node.unit ? ` [${node.unit}]` : ''}`,
  });
  const compatible = secondInputs.filter(
    (node) =>
      inputGrids.size === 1 && inputGrids.has(gridKey(index.nodes, node.id)),
  );
  const otherGrid = secondInputs.filter((node) => !compatible.includes(node));
  let unit = '';
  let unitError = '';
  if (isArithmetic(operation) && secondaryId) {
    try {
      const secondUnit = index.nodes.get(secondaryId)?.unit ?? '';
      for (const id of editor.ids) {
        unit = arithmeticUnit(
          operation,
          index.nodes.get(id)?.unit ?? '',
          secondUnit,
        );
      }
      if (new Set(editor.ids.map((id) => index.nodes.get(id)?.unit)).size > 1)
        unit = 'varies by input';
    } catch (caught) {
      unitError = message(caught, 'Incompatible units.');
    }
  }
  const changeOperation = (next: string) => {
    setOperation(next);
    setParameter(
      String(
        SIGNAL_FUNCTIONS.find((item) => item.operation === next)
          ?.defaultValue ?? 0,
      ),
    );
    setError('');
  };

  // The previewed input's full-range plot feeds the value chart, slider
  // scales and hints.
  const [inputPlot, setInputPlot] = useState<{
    id: string;
    plot?: Plot;
    error?: string;
  }>();
  useEffect(() => {
    let alive = true;
    void request({ type: 'view', ids: [previewId] })
      .then((response) => {
        if (!alive) return;
        if (response.type !== 'plots' || !response.plots[0])
          throw new Error('No plot was returned for this signal.');
        setInputPlot({ id: previewId, plot: response.plots[0] });
      })
      .catch((caught: unknown) => {
        if (alive)
          setInputPlot({
            id: previewId,
            error: message(caught, 'Unable to load the input.'),
          });
      });
    return () => {
      alive = false;
    };
  }, [previewId, request]);
  const plot = inputPlot?.id === previewId ? inputPlot.plot : undefined;
  const plotError = inputPlot?.id === previewId ? inputPlot.error : undefined;
  const context = parameterContext(plot?.summary);
  const previewNode = index.nodes.get(previewId);
  const settings = valueSettings(
    valueSpec?.parameters ?? [],
    valueForm,
    rangeMidpoint(context.min, context.max),
  );
  const statistics = useValueStatistics(
    values ? editor.ids : [],
    request,
    valueSpec?.parameters?.length && settings.parameters
      ? { operation: valueSpec.operation, parameters: settings.parameters }
      : undefined,
  );
  const choices = editor.ids.slice(0, PREVIEW_CHOICES).map((id) => ({
    value: id,
    label: `${reference(index.owner.get(id))} ${index.label(id)}`.trim(),
  }));
  const parameterValue = spec?.parameter ? Number(parameter) : 0;
  const parameterReady =
    !spec?.parameter || (!!parameter.trim() && Number.isFinite(parameterValue));
  const ready =
    !values &&
    parameterReady &&
    (!binary || !!secondaryId) &&
    !unitError &&
    !!previewNode;
  const [zoom, setZoom] = useState<{ id: string; range: Range }>();
  const viewport = zoom?.id === previewId ? zoom.range : undefined;
  const derived = useDerivePreview({
    request,
    inputId: previewId,
    operation: operation as Operation,
    parameter: parameterValue,
    secondaryId: binary ? secondaryId : undefined,
    ready,
    viewport,
  });
  const waiting = !parameterReady
    ? `Enter a ${spec?.parameter.toLowerCase() || 'parameter'} to preview.`
    : binary && !secondaryId
      ? `Choose ${isArithmetic(operation) ? 'Input B' : 'the second input'} to preview the result.`
      : unitError || '';
  // Create stays disabled while the settings or their preview are invalid,
  // with the reason beside the button.
  const blocked = values
    ? settings.waiting ||
      (statistics.error ? `The preview failed: ${statistics.error}` : '')
    : waiting || (derived.error ? `The preview failed: ${derived.error}` : '');
  const blockedError = values
    ? !settings.waiting && !!statistics.error
    : !waiting && !!derived.error;
  const count = editor.ids.length;
  const create = editor.editingStepId
    ? 'Save changes and recalculate'
    : values
      ? `Create ${formatCount(count, 'value')}`
      : `Create ${formatCount(count, 'derived signal')}`;
  const focused = statistics.get(previewId);
  const summary = values
    ? `${formatCount(count, 'value')}${
        focused && valueSpec
          ? ` · ${count > 1 ? `${index.label(previewId)}: ` : ''}${valueText(focused, valueSpec.operation, previewNode?.unit)}`
          : ''
      }`
    : `${formatCount(count, 'derived signal')}${
        derived.summary?.count
          ? ` · ${formatQuantity(derived.summary.min, 4)} to ${formatQuantity(derived.summary.max, 4)}${derived.unit ? ` ${derived.unit}` : ''}${viewport ? ' in view' : ''}${count > 1 ? ` (preview of ${index.label(previewId)})` : ''}`
          : ''
      }`;
  return (
    <div className="operation-editor">
      <div className="operation-body">
        <div className="operation-layout">
          <fieldset className="workflow-function-editor" disabled={busy}>
            {values ? (
              <ValueOperationPalette
                value={operation}
                disabled={busy}
                onChange={changeOperation}
                results={valueResults(focused, previewNode?.unit)}
              />
            ) : (
              <SignalOperationPalette
                value={operation}
                disabled={busy}
                onChange={changeOperation}
              />
            )}
            <div className="signal-operation-settings">
              {!values ? (
                <div className="signal-settings-heading">
                  <strong>
                    {spec?.name ?? operationLabels[operation as Operation]}
                  </strong>
                  {OPERATION_FORMULAS[operation] && (
                    <code>{OPERATION_FORMULAS[operation]}</code>
                  )}
                </div>
              ) : (
                <div className="signal-settings-heading">
                  <strong>{valueSpec?.name}</strong>
                  <span className="value-output-count">
                    {formatCount(count, 'value')}
                  </span>
                </div>
              )}
              <p>
                {values
                  ? valueSpec?.description
                  : binary && !isArithmetic(operation)
                    ? operation === 'power'
                      ? 'Selected inputs must be torque [Nm]. Choose one speed [rpm] signal on the same sample grid.'
                      : 'Selected inputs must be fuel flow [kg/h]. Choose one power [kW] signal on the same sample grid.'
                    : spec?.description}
              </p>
              {values && (
                <p className="value-output-hint">
                  One result per input,{' '}
                  {valueSpec?.result === 'level'
                    ? 'in its original unit'
                    : valueSpec?.result === 'area'
                      ? 'in its unit × seconds'
                      : valueSpec?.result === 'time'
                        ? 'in seconds'
                        : 'as a count'}
                  . Missing samples are excluded.
                </p>
              )}
              {values && !!valueSpec?.parameters?.length && (
                <ValueSettings
                  parameters={valueSpec.parameters}
                  form={valueForm}
                  threshold={settings.threshold}
                  unit={previewNode?.unit ?? ''}
                  context={context}
                  disabled={busy}
                  onChange={setValueForm}
                />
              )}
              {binary && (
                <div className="signal-first-input">
                  <span>Input A</span>
                  <strong>
                    {count === 1
                      ? index.label(editor.ids[0])
                      : `Each of ${formatCount(count, 'input')}`}
                  </strong>
                </div>
              )}
              {spec?.parameter && (
                <ParameterControl
                  label={spec.parameter}
                  value={parameter}
                  unit={
                    operation === 'offset'
                      ? previewNode?.unit || spec.unit
                      : spec.unit
                  }
                  scale={parameterScale(operation, context)}
                  hint={parameterHint(
                    operation,
                    parameterValue,
                    context,
                    previewNode?.unit,
                  )}
                  disabled={busy}
                  onChange={setParameter}
                />
              )}
              {binary && (
                <SecondInput
                  label={
                    isArithmetic(operation)
                      ? 'Input B'
                      : operation === 'power'
                        ? 'Speed input'
                        : 'Power input'
                  }
                  value={secondaryId}
                  compatible={compatible.map(secondItem)}
                  otherGrid={otherGrid.map(secondItem)}
                  disabled={busy}
                  onChange={setSecondaryId}
                />
              )}
              {isArithmetic(operation) && (
                <p className="signal-math-hint">
                  B is combined with each A on the same sample times. Missing
                  samples stay missing.
                  {unit && !unitError ? ` Output unit: ${unit}.` : ''}
                </p>
              )}
              {isArithmetic(operation) && onCompare && (
                <p className="signal-math-hint">
                  Signals from another recording or time grid?{' '}
                  <button
                    type="button"
                    className="workflow-link"
                    onClick={onCompare}
                  >
                    Use Compare &amp; align
                  </button>
                </p>
              )}
              {unitError && (
                <p className="segment-error" role="alert">
                  {unitError}
                </p>
              )}
            </div>
          </fieldset>
          <section className="operation-preview" aria-label="Preview">
            {values ? (
              <ValuePreview
                ids={editor.ids}
                index={index}
                statistics={statistics}
                operation={operation as ValueOperation}
                parameters={settings.parameters}
                previewId={previewId}
                plot={plot}
                plotError={plotError}
                onPreview={setPreviewId}
              />
            ) : (
              <DerivedPreview
                index={index}
                inputId={previewId}
                choices={choices}
                total={count}
                onInput={setPreviewId}
                preview={derived}
                viewport={viewport}
                onZoom={(range) =>
                  setZoom(range ? { id: previewId, range } : undefined)
                }
                ready={ready}
                waiting={waiting}
              />
            )}
          </section>
        </div>
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
              data-error={blockedError || undefined}
            >
              {blocked}
            </span>
          ) : (
            summary
          )}
        </p>
        <button
          className="primary-button"
          disabled={busy || !!blocked}
          onClick={() => {
            setError('');
            void (async () => {
              try {
                await onApply(
                  operation as Operation | ValueOperation,
                  !values && spec?.parameter ? finite(parameter) : 0,
                  secondaryId,
                  values && valueSpec?.parameters?.length
                    ? settings.parameters
                    : undefined,
                );
                if (!editor.editingStepId)
                  rememberOperation(values ? 'value' : 'derive', operation);
              } catch (caught) {
                setError(message(caught, 'Operation failed.'));
              }
            })();
          }}
        >
          {values ? <Hash size={15} /> : <Waves size={15} />}
          {create}
        </button>
      </div>
    </div>
  );
}

/** Input B choices: the same sample grid first; others need Compare & align. */
function SecondInput({
  label,
  value,
  compatible,
  otherGrid,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  compatible: { value: string; label: string }[];
  otherGrid: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const placeholder = { value: '', label: 'Choose the second input…' };
  return (
    <label className="region-field">
      <span>{label}</span>
      <Select
        value={value}
        items={[placeholder, ...compatible, ...otherGrid]}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger className="workbench-select" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{placeholder.label}</SelectItem>
          <SelectGroup>
            <SelectLabel>
              {compatible.length
                ? 'Same time grid'
                : 'No signals share this time grid'}
            </SelectLabel>
            {compatible.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {otherGrid.length > 0 && (
            <SelectGroup>
              <SelectLabel>
                Different time grid · use Compare & align
              </SelectLabel>
              {otherGrid.map((item) => (
                <SelectItem key={item.value} value={item.value} disabled>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </label>
  );
}

/** Debounced engine preview of an unsaved derived signal for one input. */
function useDerivePreview({
  request,
  inputId,
  operation,
  parameter,
  secondaryId,
  ready,
  viewport,
}: {
  request: Request;
  inputId: string;
  operation: Operation;
  parameter: number;
  secondaryId?: string;
  ready: boolean;
  viewport?: Range;
}) {
  const [result, setResult] = useState<{
    key: string;
    inputId: string;
    preview?: DerivePreview;
    error?: string;
  }>();
  const key = ready
    ? JSON.stringify([inputId, operation, parameter, secondaryId, viewport])
    : '';
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const [id, operation, parameter, secondaryId, range] = JSON.parse(key) as [
      string,
      Operation,
      number,
      string | undefined,
      Range | undefined,
    ];
    // Debounced so slider drags send one request per pause, not per pixel.
    const timer = setTimeout(() => {
      void request({
        type: 'derive-preview',
        inputId: id,
        operation,
        parameter,
        secondaryId,
        range,
        inspection: true,
      })
        .then((response) => {
          if (alive && response.type === 'derive-preview')
            setResult({ key, inputId: id, preview: response.preview });
        })
        .catch((caught: unknown) => {
          if (alive)
            setResult({
              key,
              inputId: id,
              error: message(caught, 'This result could not be previewed.'),
            });
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, request]);
  const current = result?.key === key ? result : undefined;
  // Keep the last good plot of this input while a new one is calculated, so
  // tuning stays calm.
  const shown = ready
    ? (current?.preview ??
      (result?.inputId === inputId ? result.preview : undefined))
    : undefined;
  return {
    shown,
    secondaryId,
    error: ready ? current?.error : undefined,
    busy: ready && !current,
    summary: current?.error ? undefined : shown?.plot.summary,
    unit: shown?.node.unit,
  };
}

type ValueForm = {
  /** Typed threshold; undefined follows the input's range midpoint. */
  threshold?: string;
  edge: 1 | -1;
  time: string;
};
function initialValueForm(parameters?: ValueParameters): ValueForm {
  return {
    ...(parameters?.threshold !== undefined
      ? { threshold: String(parameters.threshold) }
      : {}),
    edge: parameters?.edge === -1 ? -1 : 1,
    time: String(parameters?.time ?? 0),
  };
}
/** The settings a value calculation needs, or why they are incomplete. */
function valueSettings(
  needed: readonly string[],
  form: ValueForm,
  midpoint?: number,
): { parameters?: ValueParameters; threshold: string; waiting: string } {
  const threshold =
    form.threshold ?? (midpoint !== undefined ? String(midpoint) : '');
  const parameters: ValueParameters = {};
  for (const name of needed) {
    if (name === 'edge') parameters.edge = form.edge;
    else if (name === 'time') {
      const time = Number(form.time);
      if (!form.time.trim() || !Number.isFinite(time) || time < 0)
        return {
          threshold,
          waiting: "Enter a time of 0 s or later from the input's start.",
        };
      parameters.time = time;
    } else {
      const level = Number(threshold);
      if (!threshold.trim() || !Number.isFinite(level))
        return { threshold, waiting: 'Enter a threshold to preview.' };
      parameters.threshold = level;
    }
  }
  return { parameters, threshold, waiting: '' };
}

/** Threshold, edge and time settings of a parameterised value. */
function ValueSettings({
  parameters,
  form,
  threshold,
  unit,
  context,
  disabled,
  onChange,
}: {
  parameters: readonly string[];
  form: ValueForm;
  threshold: string;
  unit: string;
  context: ReturnType<typeof parameterContext>;
  disabled: boolean;
  onChange: (form: ValueForm) => void;
}) {
  return (
    <>
      {parameters.includes('edge') && (
        <fieldset className="segment-edge-toggle">
          <legend className="field-label">Crossing</legend>
          {([1, -1] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              aria-pressed={form.edge === edge}
              disabled={disabled}
              onClick={() => onChange({ ...form, edge })}
            >
              {edge === 1 ? '↗ Rising above' : '↘ Falling below'}
            </button>
          ))}
        </fieldset>
      )}
      {parameters.includes('threshold') && (
        <ParameterControl
          label="Threshold"
          value={threshold}
          unit={unit}
          scale={parameterScale('value-threshold', context)}
          disabled={disabled}
          onChange={(next) => onChange({ ...form, threshold: next })}
        />
      )}
      {parameters.includes('time') && (
        <ParameterControl
          label="Time from start"
          value={form.time}
          unit="s"
          scale={parameterScale('value-time', context)}
          disabled={disabled}
          onChange={(time) => onChange({ ...form, time })}
        />
      )}
    </>
  );
}

/**
 * Exact value statistics for the first inputs. Parameterless calculations
 * share one request per dialog; a parameterised one is evaluated with its
 * settings, debounced while they change.
 */
function useValueStatistics(
  ids: string[],
  request: Request,
  calculation?: { operation: ValueOperation; parameters: ValueParameters },
) {
  const [statistics, setStatistics] = useState<{
    key: string;
    items?: ValueStatistics[];
    error?: string;
  }>();
  const key = ids.length
    ? JSON.stringify([ids.slice(0, VALUE_PREVIEW_LIMIT), calculation ?? null])
    : '';
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const [ids, calculation] = JSON.parse(key) as [
      string[],
      { operation: ValueOperation; parameters: ValueParameters } | null,
    ];
    const timer = setTimeout(
      () => {
        void request({
          type: 'value-preview',
          ids,
          ...calculation,
          inspection: true,
        })
          .then((response) => {
            if (alive && response.type === 'value-preview')
              setStatistics({ key, items: response.statistics });
          })
          .catch((caught: unknown) => {
            if (alive)
              setStatistics({
                key,
                error: message(caught, 'Values could not be previewed.'),
              });
          });
      },
      calculation ? 200 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, request]);
  const map = new Map<string, ValueStatistics>();
  if (statistics?.key === key)
    for (const item of statistics.items ?? []) map.set(item.inputId, item);
  return Object.assign(map, {
    error: statistics?.key === key ? statistics.error : undefined,
    loading: statistics?.key !== key,
  });
}

function valueText(
  statistics: ValueStatistics,
  operation: ValueOperation,
  unit = '',
) {
  const value = statisticValue(statistics, operation);
  const shown = valueUnit(operation, unit);
  return value === null
    ? 'Unavailable'
    : `${formatQuantity(value, 5)}${shown ? ` ${shown}` : ''}`;
}

function valueResults(statistics?: ValueStatistics, unit?: string) {
  if (!statistics) return undefined;
  return Object.fromEntries(
    VALUE_FUNCTIONS.flatMap((spec) =>
      // Parameterised results are shown only for the settings being edited.
      spec.parameters?.length && statistics.result?.operation !== spec.operation
        ? []
        : [[spec.operation, valueText(statistics, spec.operation, unit)]],
    ),
  ) as Partial<Record<ValueOperation, string>>;
}

function ValuePreview({
  ids,
  index,
  statistics,
  operation,
  parameters,
  previewId,
  plot,
  plotError,
  onPreview,
}: {
  ids: string[];
  index: WorkflowIndex;
  statistics: ReturnType<typeof useValueStatistics>;
  operation: ValueOperation;
  parameters?: ValueParameters;
  previewId: string;
  plot?: Plot;
  plotError?: string;
  onPreview: (id: string) => void;
}) {
  const node = index.nodes.get(previewId);
  const focused = statistics.get(previewId);
  const value = focused ? statisticValue(focused, operation) : null;
  const time = focused ? statisticTime(focused, operation) : undefined;
  const spec = findValueSpec(operation);
  const traces: PreviewTrace[] = [];
  if (node && plot) {
    traces.push({
      node,
      plot,
      label: index.label(previewId),
      color: 'var(--primary)',
    });
    const reference = focused
      ? valueReference(
          {
            operation,
            value,
            unit: valueUnit(operation, node.unit),
            parameters,
            level:
              operation === 'time-of-minimum'
                ? (focused.minimum ?? undefined)
                : operation === 'time-of-maximum'
                  ? (focused.maximum ?? undefined)
                  : undefined,
          },
          node.unit,
          (number) => formatQuantity(number, 4),
        )
      : undefined;
    if (reference && Number.isFinite(reference.y)) {
      const start = plot.summary.start,
        end = plot.summary.end,
        y = reference.y;
      traces.push({
        node: {
          ...node,
          id: `${node.id}:value`,
          operation: 'raw',
          unit: reference.unit,
        },
        plot: {
          id: `${node.id}:value`,
          points: [
            [start, y],
            [end, y],
          ],
          summary: {
            count: 1,
            min: y,
            max: y,
            mean: y,
            integral: NaN,
            start,
            end,
          },
        },
        label: spec?.name ?? operation,
        color: 'var(--kind-value)',
        referenceLine: true,
        referenceLabel: reference.label,
        referenceTime: time,
      });
    }
  }
  const range: Range | undefined = plot
    ? [plot.summary.start, plot.summary.end]
    : undefined;
  const event =
    time === undefined
      ? ''
      : operation === 'minimum' || operation === 'time-of-minimum'
        ? ` · first minimum at ${formatValue(time, 3)} s`
        : operation === 'maximum' || operation === 'time-of-maximum'
          ? ` · first maximum at ${formatValue(time, 3)} s`
          : operation === 'first-crossing'
            ? ` · crosses at ${formatValue(time, 3)} s`
            : ` · at ${formatValue(time, 3)} s`;
  return (
    <>
      <div className="operation-preview-heading">
        <strong>
          <Eye size={14} /> Preview
        </strong>
        <span className="operation-preview-subject">
          {index.label(previewId)}
        </span>
        {statistics.loading && <PreviewBusy />}
      </div>
      <div className="operation-preview-plot">
        {traces.length && range && range[1] >= range[0] ? (
          <PreviewLanes traces={traces} range={range} height={210} />
        ) : (
          <output className="operation-preview-empty">
            {plotError ??
              (plot ? 'This input has no samples.' : 'Loading input…')}
          </output>
        )}
      </div>
      {focused && (
        <p className="operation-preview-summary">
          {value === null
            ? focused.sampleCount
              ? `${formatCount(focused.sampleCount, 'valid sample')}, but this value is unavailable for these settings; it will be stored as unavailable.`
              : 'No finite samples: this value will be stored as unavailable.'
            : `${formatCount(focused.sampleCount, 'valid sample')} over ${formatDuration(focused.validDuration)}${event}.`}
        </p>
      )}
      {statistics.error && (
        <output className="operation-preview-error">{statistics.error}</output>
      )}
      <div className="value-preview-table">
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>{VALUE_TAGS[operation]}</th>
            </tr>
          </thead>
          <tbody>
            {ids.slice(0, VALUE_PREVIEW_LIMIT).map((id) => {
              const item = statistics.get(id);
              return (
                <tr key={id} data-selected={id === previewId || undefined}>
                  <td>
                    <button
                      type="button"
                      className="value-preview-row"
                      aria-pressed={id === previewId}
                      onClick={() => onPreview(id)}
                    >
                      {index.label(id)}
                    </button>
                  </td>
                  <td>
                    {item
                      ? valueText(item, operation, index.nodes.get(id)?.unit)
                      : '…'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {ids.length > VALUE_PREVIEW_LIMIT && (
          <p className="input-hint">
            Showing {VALUE_PREVIEW_LIMIT} of {ids.length} inputs. Create
            calculates all of them.
          </p>
        )}
      </div>
    </>
  );
}

function DerivedPreview({
  index,
  inputId,
  choices,
  total,
  onInput,
  preview,
  viewport,
  onZoom,
  ready,
  waiting,
}: {
  index: WorkflowIndex;
  inputId: string;
  choices: { value: string; label: string }[];
  total: number;
  onInput: (id: string) => void;
  preview: ReturnType<typeof useDerivePreview>;
  viewport?: Range;
  onZoom: (range?: Range) => void;
  ready: boolean;
  waiting: string;
}) {
  const { shown, error, secondaryId } = preview;
  const traces: PreviewTrace[] = [];
  if (shown) {
    const ids = [inputId, ...(secondaryId ? [secondaryId] : [])];
    shown.inputs.forEach((plot, position) => {
      const node = index.nodes.get(ids[position]);
      if (node)
        traces.push({
          node,
          plot,
          label: `${position ? 'B' : secondaryId ? 'A' : 'Input'} · ${index.label(node.id)}`,
          color: position ? 'var(--series-2)' : 'var(--ink-3)',
          width: 1.2,
        });
    });
    traces.push({
      node: shown.node,
      plot: shown.plot,
      label: `Result · ${shown.node.name}`,
      color: 'var(--primary)',
      width: 1.8,
    });
  }
  const range = viewport ?? shown?.domain;
  const summary = shown?.plot.summary;
  return (
    <>
      <div className="operation-preview-heading">
        <strong>
          <Eye size={14} /> Preview
        </strong>
        {choices.length > 1 ? (
          <RegionSelect
            label="Preview input"
            value={inputId}
            items={choices}
            onChange={onInput}
          />
        ) : (
          <span className="operation-preview-subject">
            {index.label(inputId)}
          </span>
        )}
        {preview.busy && <PreviewBusy />}
        {viewport && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onZoom(undefined)}
          >
            <Scan size={13} /> Fit
          </button>
        )}
      </div>
      <div
        className="operation-preview-plot"
        data-stale={preview.busy || undefined}
      >
        {!ready ? (
          <output className="operation-preview-empty">{waiting}</output>
        ) : error ? (
          <output className="operation-preview-error">{error}</output>
        ) : shown && range ? (
          <PreviewLanes traces={traces} range={range} onZoom={onZoom} />
        ) : (
          <output className="operation-preview-empty">
            Calculating preview…
          </output>
        )}
      </div>
      {shown && summary && !error && (
        <p className="operation-preview-summary">
          {summary.count
            ? `${viewport ? 'In view' : 'Output'}: ${formatQuantity(summary.min, 4)} to ${formatQuantity(summary.max, 4)}${shown.node.unit ? ` ${shown.node.unit}` : ''} · mean ${formatQuantity(summary.mean, 4)} · ${formatCount(summary.count, 'valid sample')}.`
            : 'No valid output samples in view.'}{' '}
          {total > 1 && `Previewing 1 of ${total} inputs; all are created.`}
        </p>
      )}
      <p className="input-hint operation-preview-help">
        Drag across the plot to zoom; double-click to fit. Nothing is saved
        until you create the result.
      </p>
    </>
  );
}

function PreviewBusy() {
  return (
    <output className="operation-preview-busy">
      <LoaderCircle size={13} /> Updating
    </output>
  );
}
