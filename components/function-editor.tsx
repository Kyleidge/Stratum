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
} from '@/lib/parameter-scale';
import { VALUE_TAGS } from '@/lib/plot-scratchpad';
import type { WorkflowIndex } from '@/lib/workflow-history';
import {
  statisticValue,
  VALUE_FUNCTIONS,
  type ValueOperation,
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

export type FunctionDraft = {
  editingStepId?: string;
  kind: 'derive' | 'segment' | 'value';
  ids: string[];
  operation?: Operation | ValueOperation;
  parameter?: number;
  secondaryId?: string;
};
type Request = (message: EngineRequest) => Promise<EngineResponse>;
type Range = [number, number];
/** Inputs offered by the preview chooser; every input is still processed. */
const PREVIEW_CHOICES = 100;
/** Inputs whose values are calculated ahead of creation. */
const VALUE_PREVIEW_LIMIT = 12;
const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export default function FunctionEditor({
  editor,
  project,
  index,
  request,
  busy,
  onApply,
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
  ) => Promise<void>;
}) {
  const values = editor.kind === 'value';
  const [operation, setOperation] = useState<string>(
    editor.operation ?? (values ? 'time-average' : 'multiply'),
  );
  const [parameter, setParameter] = useState(
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
  const statistics = useValueStatistics(values ? editor.ids : [], request);
  const valueSpec = VALUE_FUNCTIONS.find(
    (spec) => spec.operation === operation,
  );
  const spec =
    SIGNAL_FUNCTIONS.find((spec) => spec.operation === operation) ??
    FUNCTIONS.find((spec) => spec.operation === operation);
  const binary = isBinaryOperation(operation);
  const sourceId = index.nodes.get(editor.ids[0])?.sourceId;
  const secondInputs = project.nodes.filter(
    (node) =>
      node.sourceId === sourceId &&
      (!node.internal || node.id === editor.secondaryId) &&
      (isArithmetic(operation) ||
        (operation === 'power'
          ? node.unit.toLowerCase() === 'rpm'
          : node.unit.toLowerCase() === 'kw')),
  );
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
  const create = editor.editingStepId
    ? 'Save changes and recalculate'
    : values
      ? `Create ${editor.ids.length} value${editor.ids.length === 1 ? '' : 's'}`
      : `Create ${editor.ids.length} derived signal${editor.ids.length === 1 ? '' : 's'}`;
  return (
    <div className="operation-editor">
      <div className="operation-layout">
        <fieldset className="workflow-function-editor" disabled={busy}>
          {values ? (
            <ValueOperationPalette
              value={operation}
              disabled={busy}
              onChange={changeOperation}
              results={valueResults(
                statistics.get(previewId),
                index.nodes.get(previewId)?.unit,
              )}
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
                  {editor.ids.length}{' '}
                  {editor.ids.length === 1 ? 'value' : 'values'}
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
                One result per input, in its original unit. Missing samples are
                excluded.
              </p>
            )}
            {binary && (
              <div className="signal-first-input">
                <span>Input A</span>
                <strong>
                  {editor.ids.length === 1
                    ? index.label(editor.ids[0])
                    : `Each of ${editor.ids.length} selected signals`}
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
              <RegionSelect
                label={
                  isArithmetic(operation)
                    ? 'Input B'
                    : operation === 'power'
                      ? 'Speed input'
                      : 'Power input'
                }
                value={secondaryId}
                items={[
                  { value: '', label: 'Choose the second input…' },
                  ...secondInputs.map((node) => ({
                    value: node.id,
                    label: `${reference(index.owner.get(node.id))} ${index.label(node.id)}${node.unit ? ` [${node.unit}]` : ''}`,
                  })),
                ]}
                disabled={busy}
                onChange={setSecondaryId}
              />
            )}
            {isArithmetic(operation) && (
              <p className="signal-math-hint">
                B is combined with each A. Inputs must share a recording, sample
                grid and time transformations. Missing samples stay missing.
                {unit && !unitError ? ` Output unit: ${unit}.` : ''}
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
              previewId={previewId}
              plot={plot}
              plotError={plotError}
              onPreview={setPreviewId}
            />
          ) : (
            <DerivedPreview
              key={previewId}
              request={request}
              index={index}
              inputId={previewId}
              choices={choices}
              total={editor.ids.length}
              onInput={setPreviewId}
              operation={operation as Operation}
              parameter={parameterValue}
              secondaryId={binary ? secondaryId : undefined}
              ready={ready}
              waiting={
                !parameterReady
                  ? `Enter a ${spec?.parameter.toLowerCase() ?? 'parameter'} to preview.`
                  : binary && !secondaryId
                    ? 'Choose Input B to preview the result.'
                    : unitError || ''
              }
            />
          )}
        </section>
      </div>
      {error && (
        <p className="segment-error" role="alert">
          {error}
        </p>
      )}
      <div className="operation-footer">
        <span>
          {editor.editingStepId
            ? 'Saving recalculates dependent results. Undo restores the previous version.'
            : values
              ? 'Values keep their input signal and unit.'
              : 'Inputs stay unchanged; each output records its recipe.'}
        </span>
        <button
          className="primary-button"
          disabled={busy || (binary && !secondaryId) || !!unitError}
          onClick={() => {
            setError('');
            void (async () => {
              try {
                await onApply(
                  operation as Operation | ValueOperation,
                  spec?.parameter ? finite(parameter) : 0,
                  secondaryId,
                );
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

/** Exact value statistics for the first inputs, computed once per dialog. */
function useValueStatistics(ids: string[], request: Request) {
  const [statistics, setStatistics] = useState<{
    key: string;
    items?: ValueStatistics[];
    error?: string;
  }>();
  const key = ids.length
    ? JSON.stringify(ids.slice(0, VALUE_PREVIEW_LIMIT))
    : '';
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const ids = JSON.parse(key) as string[];
    void request({ type: 'value-preview', ids, inspection: true })
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
    return () => {
      alive = false;
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
  return value === null
    ? 'Unavailable'
    : `${formatQuantity(value, 5)}${unit ? ` ${unit}` : ''}`;
}

function valueResults(statistics?: ValueStatistics, unit?: string) {
  if (!statistics) return undefined;
  return Object.fromEntries(
    VALUE_FUNCTIONS.map((spec) => [
      spec.operation,
      valueText(statistics, spec.operation, unit),
    ]),
  ) as Record<ValueOperation, string>;
}

function ValuePreview({
  ids,
  index,
  statistics,
  operation,
  previewId,
  plot,
  plotError,
  onPreview,
}: {
  ids: string[];
  index: WorkflowIndex;
  statistics: ReturnType<typeof useValueStatistics>;
  operation: ValueOperation;
  previewId: string;
  plot?: Plot;
  plotError?: string;
  onPreview: (id: string) => void;
}) {
  const node = index.nodes.get(previewId);
  const focused = statistics.get(previewId);
  const value = focused ? statisticValue(focused, operation) : null;
  const time =
    operation === 'minimum'
      ? focused?.minimumTime
      : operation === 'maximum'
        ? focused?.maximumTime
        : undefined;
  const traces: PreviewTrace[] = [];
  if (node && plot) {
    traces.push({
      node,
      plot,
      label: index.label(previewId),
      color: 'var(--primary)',
    });
    if (value !== null) {
      const start = plot.summary.start,
        end = plot.summary.end;
      traces.push({
        node: { ...node, id: `${node.id}:value`, operation: 'raw' },
        plot: {
          id: `${node.id}:value`,
          points: [
            [start, value],
            [end, value],
          ],
          summary: {
            count: 1,
            min: value,
            max: value,
            mean: value,
            integral: NaN,
            start,
            end,
          },
        },
        label: VALUE_FUNCTIONS.find((item) => item.operation === operation)!
          .name,
        color: 'var(--kind-value)',
        referenceLine: true,
        referenceLabel: `${VALUE_TAGS[operation]} ${formatQuantity(value, 4)}`,
        referenceTime: time,
      });
    }
  }
  const range: Range | undefined = plot
    ? [plot.summary.start, plot.summary.end]
    : undefined;
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
            ? 'No finite samples: this value will be stored as unavailable.'
            : `${focused.sampleCount.toLocaleString('en-GB')} valid samples over ${formatDuration(focused.validDuration)}${
                time !== undefined
                  ? ` · first ${operation === 'minimum' ? 'minimum' : 'maximum'} at ${formatValue(time, 3)} s`
                  : ''
              }.`}
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
  request,
  index,
  inputId,
  choices,
  total,
  onInput,
  operation,
  parameter,
  secondaryId,
  ready,
  waiting,
}: {
  request: Request;
  index: WorkflowIndex;
  inputId: string;
  choices: { value: string; label: string }[];
  total: number;
  onInput: (id: string) => void;
  operation: Operation;
  parameter: number;
  secondaryId?: string;
  ready: boolean;
  waiting: string;
}) {
  const [viewport, setViewport] = useState<Range>();
  const [result, setResult] = useState<{
    key: string;
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
            setResult({ key, preview: response.preview });
        })
        .catch((caught: unknown) => {
          if (alive)
            setResult({
              key,
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
  // Keep the last good plot while a new one is calculated, so tuning stays calm.
  const shown = ready ? (current?.preview ?? result?.preview) : undefined;
  const error = ready ? current?.error : undefined;
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
        {ready && !current && <PreviewBusy />}
        {viewport && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => setViewport(undefined)}
          >
            <Scan size={13} /> Fit
          </button>
        )}
      </div>
      <div
        className="operation-preview-plot"
        data-stale={!current || undefined}
      >
        {!ready ? (
          <output className="operation-preview-empty">{waiting}</output>
        ) : error ? (
          <output className="operation-preview-error">{error}</output>
        ) : shown && range ? (
          <PreviewLanes traces={traces} range={range} onZoom={setViewport} />
        ) : (
          <output className="operation-preview-empty">
            Calculating preview…
          </output>
        )}
      </div>
      {shown && summary && !error && (
        <p className="operation-preview-summary">
          {summary.count
            ? `${viewport ? 'In view' : 'Output'}: ${formatQuantity(summary.min, 4)} to ${formatQuantity(summary.max, 4)}${shown.node.unit ? ` ${shown.node.unit}` : ''} · mean ${formatQuantity(summary.mean, 4)} · ${summary.count.toLocaleString('en-GB')} valid samples.`
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
