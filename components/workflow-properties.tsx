'use client';

import { useEffect, useState } from 'react';
import {
  ArrowUpLeft,
  Copy,
  GitBranch,
  Hash,
  LockKeyhole,
  Pencil,
  Scissors,
  Settings2,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { SignalGraph } from '@/lib/signal-graph';
import type {
  EngineRequest,
  EngineResponse,
  Project,
  SignalNode,
} from '@/lib/signal-types';
import type { WorkflowSelection } from './workflow-history';
import type { ToolbarAction } from './workflow-toolbar';
import WorkflowList from './workflow-list';
import { formatValue } from './signal-chart';

/** Lists longer than this page through WorkflowList to bound the DOM. */
const INLINE_ITEMS = 8;
const reference = (step: WorkflowStep) =>
  `#${String(step.sequence + 1).padStart(3, '0')}`;
const STEP_KIND: Record<WorkflowStep['kind'], string> = {
  import: 'Import',
  derive: 'Derive',
  segment: 'Segment',
  value: 'Value',
  regions: 'Segment',
};
export const stepKindClass = (step: WorkflowStep) =>
  step.kind === 'regions' ? 'segment' : step.kind;

function StepIcon({ step, size = 12 }: { step: WorkflowStep; size?: number }) {
  const Icon =
    step.kind === 'value'
      ? Hash
      : step.kind === 'segment' || step.kind === 'regions'
        ? Scissors
        : step.kind === 'import'
          ? LockKeyhole
          : Waves;
  return <Icon size={size} />;
}

/** Right-hand inspector: what the selection is, where it came from, what uses it. */
export default function WorkflowProperties({
  project,
  index,
  graph,
  selection,
  lineage,
  usedBy,
  request,
  onFollow,
  onStep,
  onAction,
  onClose,
  busy,
}: {
  project: Project;
  index: WorkflowIndex;
  graph: SignalGraph;
  selection: WorkflowSelection;
  /** Contributing steps in creation order and their original signals. */
  lineage: {
    steps: WorkflowStep[];
    originals: SignalNode[];
    outputIds: ReadonlySet<string>;
  };
  usedBy: WorkflowStep[];
  request: (message: EngineRequest) => Promise<EngineResponse>;
  onFollow: (id: string) => void;
  onStep: (id: string) => void;
  onAction: (action: ToolbarAction) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const node =
    selection.kind === 'output' ? index.nodes.get(selection.id) : undefined;
  const value =
    selection.kind === 'output' ? index.values.get(selection.id) : undefined;
  const step =
    selection.kind === 'step'
      ? index.steps.get(selection.id)
      : index.owner.get(selection.id);
  const signalId = node?.id ?? value?.inputId;
  const range = signalId ? graph.ranges.get(signalId) : undefined;
  const time = signalId ? graph.timeReferences.get(signalId) : undefined;
  const inputs =
    selection.kind === 'output'
      ? index.inputs(selection.id)
      : (step?.inputIds ?? []);
  const sourceIds = new Set(lineage.originals.map((item) => item.sourceId));
  if (step?.kind === 'import' && step.sourceId) sourceIds.add(step.sourceId);
  const sources = project.sources.filter((source) => sourceIds.has(source.id));
  const label =
    selection.kind === 'output'
      ? index.label(selection.id)
      : step
        ? stepName(step)
        : 'Selection';
  const countId = node?.id;
  const [counted, setCounted] = useState<{
    id: string;
    project: Project;
    count?: number;
    error?: string;
  }>();
  useEffect(() => {
    if (!countId || busy) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request({ type: 'sample-count', id: countId, inspection: true })
        .then((response) => {
          if (
            alive &&
            response.type === 'sample-count' &&
            response.count !== null
          )
            setCounted({ id: countId, project, count: response.count });
        })
        .catch((error: unknown) => {
          if (alive)
            setCounted({
              id: countId,
              project,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to count samples.',
            });
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
      // Clear only this inspection lane; plots, measurements and edits continue.
      void request({ type: 'sample-count', id: null, inspection: true }).catch(
        () => {},
      );
    };
  }, [countId, project, request, busy]);
  const currentCount =
    counted && counted.id === countId && counted.project === project
      ? counted
      : undefined;
  const recording = project.sources.find(
    (source) => source.id === node?.sourceId,
  );
  const imported =
    step?.kind === 'import'
      ? project.sources.find((source) => source.id === step.sourceId)
      : undefined;
  const count =
    value?.sampleCount ??
    (node?.operation === 'raw' ? recording?.rows : currentCount?.count) ??
    (selection.kind === 'step' ? imported?.rows : undefined);
  const kind = selection.kind === 'output' ? index.kind(selection.id) : '';
  const kindKey = value
    ? 'value'
    : node?.operation === 'raw'
      ? 'original'
      : node
        ? 'derived'
        : step
          ? stepKindClass(step)
          : 'derive';
  const editable = !!step && !['import', 'regions'].includes(step.kind);
  // The selection's own operation closes the chain as its current step.
  const chain =
    step && !lineage.steps.some((item) => item.id === step.id)
      ? [...lineage.steps, step]
      : lineage.steps;
  const contributing = (item: WorkflowStep) => {
    const ids = item.outputIds.filter(
      (id) =>
        lineage.outputIds.has(id) ||
        (selection.kind === 'output' && id === selection.id),
    );
    return item.id === step?.id && selection.kind === 'step'
      ? `${item.outputIds.length} output${item.outputIds.length === 1 ? '' : 's'}`
      : ids.length === item.outputIds.length && ids.length > 1
        ? `All ${ids.length} outputs`
        : ids
            .slice(0, 3)
            .map((id) => index.label(id))
            .join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
  };
  const chainItem = (item: WorkflowStep) => (
    <li
      key={item.id}
      data-kind={stepKindClass(item)}
      data-current={item.id === step?.id}
    >
      <span className="workflow-lineage-node">
        <StepIcon step={item} size={11} />
      </span>
      <div>
        <button
          className="workflow-property-link"
          onClick={() => onStep(item.id)}
          title={`${reference(item)} ${stepName(item)}`}
        >
          <code>{reference(item)}</code> {stepName(item)}
        </button>
        <small>{contributing(item)}</small>
      </div>
    </li>
  );
  const usedByItem = (item: WorkflowStep) => (
    <li key={item.id}>
      <button
        className="workflow-property-link"
        onClick={() => onStep(item.id)}
        title={`${reference(item)} ${stepName(item)}`}
      >
        <code>{reference(item)}</code> {stepName(item)}
      </button>
    </li>
  );
  return (
    <section
      id="workflow-properties"
      className="workflow-properties"
      aria-label="Selection details"
    >
      <div className="workflow-inspector-bar">
        <strong>Inspector</strong>
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label="Close inspector"
          title="Hide the inspector"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <header className="workflow-properties-heading">
        <span className="workflow-kind" data-kind={kindKey}>
          <i />
          {selection.kind === 'output'
            ? kind
            : step
              ? `${STEP_KIND[step.kind]} operation · ${reference(step)}`
              : 'Operation'}
        </span>
        <div className="workflow-properties-title">
          <h2 title={label}>{label}</h2>
          <button
            className="workflow-icon-button workflow-quiet"
            title="Rename selection · F2"
            aria-label="Rename selection"
            disabled={busy}
            onClick={() => onAction('rename')}
          >
            <Pencil size={13} />
          </button>
        </div>
      </header>
      {value && (
        <div className="workflow-properties-hero">
          <strong>
            {value.value === null ? 'Unavailable' : formatValue(value.value, 3)}
          </strong>
          <small>{value.unit}</small>
        </div>
      )}
      <div className="workflow-properties-content">
        <section>
          <h3>Properties</h3>
          <dl className="workflow-property-grid">
            <div>
              <dt>Type</dt>
              <dd>{selection.kind === 'output' ? kind : 'Operation'}</dd>
            </div>
            {(node || value) && (
              <div>
                <dt>Unit</dt>
                <dd title={node?.unit || value?.unit || 'Unitless'}>
                  {node?.unit || value?.unit || 'Unitless'}
                </dd>
              </div>
            )}
            {(node || value || imported) && (
              <div>
                <dt>
                  {value
                    ? 'Input samples'
                    : selection.kind === 'step'
                      ? 'Samples / ch.'
                      : 'Samples'}
                </dt>
                <dd
                  className="workflow-property-number"
                  title={
                    currentCount?.error ??
                    (value
                      ? 'Finite input samples used to calculate this value.'
                      : 'Total samples in the full signal, including missing values.')
                  }
                >
                  {count?.toLocaleString() ??
                    (currentCount?.error ? 'Unavailable' : 'Counting…')}
                  {value && ' finite'}
                </dd>
              </div>
            )}
            {range && (
              <div>
                <dt>{value ? 'Input range' : 'Time range'}</dt>
                <dd
                  className="workflow-property-number"
                  title={`${range[0]}–${range[1]} s`}
                >
                  {formatValue(range[0], 3)}–{formatValue(range[1], 3)} s
                </dd>
              </div>
            )}
            {value?.timestamp !== undefined && (
              <div>
                <dt>First occurs</dt>
                <dd className="workflow-property-number">
                  {formatValue(value.timestamp, 3)} s
                </dd>
              </div>
            )}
            {step && (
              <>
                <div>
                  <dt>{selection.kind === 'step' ? 'Step' : 'Produced by'}</dt>
                  <dd>
                    <button
                      className="workflow-property-link"
                      onClick={() => onStep(step.id)}
                      title={stepName(step)}
                    >
                      {reference(step)} {stepName(step)}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{step.revision ?? 1}</dd>
                </div>
                {selection.kind === 'step' && (
                  <div>
                    <dt>Outputs</dt>
                    <dd>{step.outputIds.length.toLocaleString()}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </section>
        {time && range && (
          <section>
            <h3>{value ? 'Input time axis' : 'Time axis'}</h3>
            <dl className="workflow-property-grid">
              <div>
                <dt>Reference</dt>
                <dd title={time.name}>{time.name}</dd>
              </div>
              <div>
                <dt>Start</dt>
                <dd className="workflow-property-number">
                  {formatValue(range[0], 3)} s
                </dd>
              </div>
              <div>
                <dt>End</dt>
                <dd className="workflow-property-number">
                  {formatValue(range[1], 3)} s
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd className="workflow-property-number">
                  {formatValue(range[1] - range[0], 3)} s
                </dd>
              </div>
            </dl>
          </section>
        )}
        {!!inputs.length && (
          <section>
            <h3>
              Inputs <span>{inputs.length}</span>
            </h3>
            <ul className="workflow-property-links">
              {inputs.slice(0, 3).map((id) => (
                <li key={id}>
                  <button
                    className="workflow-property-link"
                    onClick={() => onFollow(id)}
                    title={index.label(id)}
                  >
                    <ArrowUpLeft size={12} />
                    <span>{index.label(id)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {inputs.length > 3 && (
              <button
                className="workflow-property-link"
                onClick={() => onAction('inputs')}
              >
                All {inputs.length} inputs…
              </button>
            )}
          </section>
        )}
        {!!chain.length && (
          <section>
            <h3>
              Lineage{' '}
              <span>
                {chain.length} {chain.length === 1 ? 'step' : 'steps'}
              </span>
            </h3>
            {chain.length <= INLINE_ITEMS ? (
              <ol className="workflow-lineage">{chain.map(chainItem)}</ol>
            ) : (
              <>
                <ol className="workflow-lineage">
                  {chain.slice(-INLINE_ITEMS).map(chainItem)}
                </ol>
                <WorkflowList
                  key={selection.id}
                  items={chain}
                  summary={`All ${chain.length} contributing steps`}
                >
                  {(visible) => (
                    <ol className="workflow-lineage">
                      {visible.map(chainItem)}
                    </ol>
                  )}
                </WorkflowList>
              </>
            )}
          </section>
        )}
        <section>
          <h3>Used by {!!usedBy.length && <span>{usedBy.length}</span>}</h3>
          {!usedBy.length ? (
            <p className="workflow-muted">No later operations use this yet.</p>
          ) : usedBy.length <= INLINE_ITEMS ? (
            <ul className="workflow-property-links">
              {usedBy.map(usedByItem)}
            </ul>
          ) : (
            <WorkflowList
              key={selection.id}
              items={usedBy}
              initialOpen
              summary={`${usedBy.length} later operations`}
            >
              {(visible) => (
                <ul className="workflow-property-links">
                  {visible.map(usedByItem)}
                </ul>
              )}
            </WorkflowList>
          )}
        </section>
        {!!sources.length && (
          <section>
            <h3>
              Source recordings <span>{sources.length}</span>
            </h3>
            <ul className="workflow-property-sources">
              {sources.slice(0, 3).map((source) => (
                <li key={source.id} title={source.name}>
                  {source.name}
                </li>
              ))}
            </ul>
            {sources.length > 3 && (
              <button
                className="workflow-property-link"
                onClick={() => onAction('inputs')}
              >
                All source signals…
              </button>
            )}
          </section>
        )}
      </div>
      <div className="workflow-property-actions">
        <button
          className="secondary-button"
          disabled={busy || !editable}
          title={
            editable
              ? 'Rebuild with new settings'
              : 'Recordings and saved ranges are immutable'
          }
          onClick={() => onAction('edit')}
        >
          <Settings2 size={13} />
          Edit settings
        </button>
        <button
          className="secondary-button"
          disabled={busy || !step || step.kind === 'import'}
          onClick={() => onAction('duplicate')}
        >
          <Copy size={13} />
          Duplicate
        </button>
        <button
          className="secondary-button workflow-danger"
          disabled={busy || !step}
          onClick={() => onAction('delete')}
        >
          <Trash2 size={13} />
          Delete
        </button>
        <button
          className="workflow-property-link"
          onClick={() => onAction('lineage')}
        >
          <GitBranch size={13} />
          Trace lineage in History
        </button>
      </div>
    </section>
  );
}
