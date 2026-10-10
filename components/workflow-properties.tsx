'use client';

import { referenceClock } from '@/lib/time-types';
import { describeClock, formatOffset } from '@/lib/clock-time';
import { useEffect, useState } from 'react';
import {
  ArrowUpLeft,
  CopyPlus,
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
import {
  stepInputs,
  stepName,
  type WorkflowIndex,
} from '@/lib/workflow-history';
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
import WorkflowChecksPanel from './workflow-checks-panel';
import type {
  CheckDefinition,
  RunStatus,
  WorkflowBatch,
} from '@/lib/workflow-types';
import { STATUS_LABELS } from '@/lib/workflow-checks';
import { StatusIcon } from './workflow-batch-view';
import { formatValue } from './signal-chart';
import { formatCount } from '@/lib/format-count';

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

const BATCH_STATUSES: RunStatus[] = [
  'pass',
  'warning',
  'fail',
  'error',
  'none',
];
const dateTime = (iso?: string) => {
  const date = iso ? new Date(iso) : undefined;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
};

/** Details while batch results are open: the run as a whole, not one item. */
function BatchDetails({
  project,
  batch,
  onClose,
}: {
  project: Project;
  batch: WorkflowBatch;
  onClose: () => void;
}) {
  const recipe = project.workflowRecipes?.find(
    (item) => item.hash === batch.recipeHash,
  );
  const counts = new Map<RunStatus, number>();
  for (const run of batch.runs)
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const finished = batch.runs.reduce<string | undefined>(
    (latest, run) =>
      !latest || run.finishedAt > latest ? run.finishedAt : latest,
    undefined,
  );
  const state = {
    running: 'Running',
    complete: 'Complete',
    cancelled: 'Cancelled',
  }[batch.state];
  return (
    <section
      id="workflow-properties"
      className="workflow-properties"
      aria-label="Batch details"
    >
      <div className="workflow-inspector-bar">
        <strong>Details</strong>
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label="Close Details"
          title="Hide Details"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <header className="workflow-properties-heading">
        <span className="workflow-kind" data-kind="segment">
          <i />
          Batch · {state}
        </span>
        <div className="workflow-properties-title">
          <h2 title={batch.name}>{batch.name}</h2>
        </div>
      </header>
      <div className="workflow-properties-content">
        <section>
          <h3>Workflow</h3>
          <dl className="workflow-property-grid">
            <div>
              <dt>Name</dt>
              <dd title={recipe?.name}>{recipe?.name ?? batch.name}</dd>
            </div>
            {recipe?.revision && (
              <div>
                <dt>Revision</dt>
                <dd>{recipe.revision}</dd>
              </div>
            )}
            {batch.recipeHash && (
              <div>
                <dt>Hash</dt>
                <dd title={batch.recipeHash}>
                  <code>{batch.recipeHash.slice(0, 12)}</code>
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section>
          <h3>
            Items <span>{formatCount(batch.runs.length, 'item')}</span>
          </h3>
          <ul className="workflow-batch-statuses">
            {BATCH_STATUSES.filter((status) => counts.get(status)).map(
              (status) => (
                <li key={status} data-status={status}>
                  <StatusIcon status={status} size={13} decorative />
                  <span>{STATUS_LABELS[status]}</span>
                  <strong>{counts.get(status)!.toLocaleString()}</strong>
                </li>
              ),
            )}
            {!!batch.failures?.length && (
              <li data-status="error">
                <StatusIcon status="error" size={13} decorative />
                <span>Not imported</span>
                <strong>{batch.failures.length.toLocaleString()}</strong>
              </li>
            )}
          </ul>
          {!batch.runs.length && !batch.failures?.length && (
            <p className="workflow-muted">No items have finished yet.</p>
          )}
        </section>
        <section>
          <h3>Ran</h3>
          <dl className="workflow-property-grid">
            <div>
              <dt>Started</dt>
              <dd>{dateTime(batch.createdAt)}</dd>
            </div>
            {batch.state !== 'running' && (
              <div>
                <dt>Finished</dt>
                <dd>{dateTime(finished)}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </section>
  );
}

/** Details: what the selection is, where it came from, what uses it. */
export default function WorkflowProperties(props: WorkflowPropertiesProps) {
  return props.batch ? (
    <BatchDetails
      project={props.project}
      batch={props.batch}
      onClose={props.onClose}
    />
  ) : (
    <SelectionDetails {...props} />
  );
}

type WorkflowPropertiesProps = Parameters<typeof SelectionDetails>[0] & {
  /** Batch results are open: summarise the batch instead of the selection. */
  batch?: WorkflowBatch;
};

function SelectionDetails({
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
  onSetChecks,
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
  /** Replace a step's checks; rejected promises keep the form open. */
  onSetChecks?: (stepId: string, checks: CheckDefinition[]) => Promise<void>;
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
  const segmentEntry =
    selection.kind === 'output' ? index.segments.get(selection.id) : undefined;
  // The segment a signal or value was made within, and a step's scope.
  const withinSegment = node?.segmentId ?? value?.segmentId;
  const scope = selection.kind === 'step' ? step?.within : undefined;
  const scopeStep = scope
    ? [...index.steps.values()].find(
        (item) => item.segmentSetId === scope.setId,
      )
    : undefined;
  const signalId = node?.id ?? value?.inputId;
  const range = signalId ? graph.ranges.get(signalId) : undefined;
  const time = signalId ? graph.timeReferences.get(signalId) : undefined;
  const clock = referenceClock(time);
  // A step's segments are shown under Within, not as inputs.
  const inputs =
    selection.kind === 'output'
      ? index.inputs(selection.id)
      : step
        ? stepInputs(step).filter((id) => !index.segments.has(id))
        : [];
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
    : segmentEntry
      ? 'segment'
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
    const noun = item.segmentSetId ? 'segment' : 'output';
    return item.id === step?.id && selection.kind === 'step'
      ? formatCount(item.outputIds.length, noun)
      : ids.length === item.outputIds.length && ids.length > 1
        ? `All ${ids.length.toLocaleString()} ${noun}s`
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
        <strong>Details</strong>
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label="Close Details"
          title="Hide Details"
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
              ? `${STEP_KIND[step.kind]} step · ${reference(step)}`
              : 'Step'}
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
            {segmentEntry && (
              <>
                <div>
                  <dt>Start</dt>
                  <dd className="workflow-property-number">
                    {formatValue(segmentEntry.segment.start, 3)} s
                  </dd>
                </div>
                <div>
                  <dt>End</dt>
                  <dd
                    className="workflow-property-number"
                    title={
                      segmentEntry.segment.endInclusive
                        ? 'Includes the sample at its end (a recording or parent end).'
                        : 'Excludes the sample at its end, so adjacent segments never share one.'
                    }
                  >
                    {formatValue(segmentEntry.segment.end, 3)} s
                    {segmentEntry.segment.endInclusive ? ' (incl.)' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd className="workflow-property-number">
                    {formatValue(
                      segmentEntry.segment.end - segmentEntry.segment.start,
                      3,
                    )}{' '}
                    s
                  </dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>
                    {segmentEntry.set.sourceId
                      ? 'Recording time'
                      : 'Workspace time'}
                  </dd>
                </div>
                {segmentEntry.segment.boundary.startTrigger !== undefined && (
                  <div>
                    <dt>Crossings</dt>
                    <dd className="workflow-property-number">
                      {formatValue(
                        segmentEntry.segment.boundary.startTrigger,
                        3,
                      )}{' '}
                      and{' '}
                      {formatValue(
                        segmentEntry.segment.boundary.endTrigger ??
                          segmentEntry.segment.end,
                        3,
                      )}{' '}
                      s
                    </dd>
                  </div>
                )}
                {segmentEntry.segment.boundary.clipped && (
                  <div>
                    <dt>Clipped</dt>
                    <dd className="workflow-property-number">
                      Requested{' '}
                      {formatValue(
                        segmentEntry.segment.boundary.requestedStart,
                        3,
                      )}
                      –
                      {formatValue(
                        segmentEntry.segment.boundary.requestedEnd,
                        3,
                      )}{' '}
                      s
                    </dd>
                  </div>
                )}
              </>
            )}
            {withinSegment && (
              <div>
                <dt>Within</dt>
                <dd>
                  <button
                    className="workflow-property-link"
                    onClick={() => onFollow(withinSegment)}
                    title={index.label(withinSegment)}
                  >
                    {index.segmentLabel(withinSegment)}
                  </button>
                </dd>
              </div>
            )}
            {scope && (
              <div>
                <dt>Within</dt>
                <dd>
                  {scopeStep ? (
                    <button
                      className="workflow-property-link"
                      onClick={() => onStep(scopeStep.id)}
                      title={`${reference(scopeStep)} ${stepName(scopeStep)}`}
                    >
                      {scope.segmentIds
                        ? scope.segmentIds.length === 1
                          ? index.segmentLabel(scope.segmentIds[0])
                          : `${formatCount(scope.segmentIds.length, 'segment')} of ${reference(scopeStep)}`
                        : `All segments of ${reference(scopeStep)}`}
                    </button>
                  ) : (
                    'Unavailable segments'
                  )}
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
                {selection.kind === 'output' && (
                  <div>
                    <dt>Produced by</dt>
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
                )}
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
              {clock && (
                <div>
                  <dt>Clock</dt>
                  <dd
                    className="workflow-property-number"
                    title={`Clock time at ${formatValue(range[0], 3)} s; ${clock.undated ? 'the file gives times of day only' : formatOffset(clock.offset)}`}
                  >
                    {describeClock(clock, range[0])}
                  </dd>
                </div>
              )}
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
                All {inputs.length.toLocaleString()} inputs…
              </button>
            )}
          </section>
        )}
        {!!chain.length && (
          <section>
            <h3>
              Lineage <span>{formatCount(chain.length, 'step')}</span>
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
                  summary={`All ${chain.length.toLocaleString()} contributing steps`}
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
            <p className="workflow-muted">
              Nothing uses this yet. Try Derive, Segment or Value above.
            </p>
          ) : usedBy.length <= INLINE_ITEMS ? (
            <ul className="workflow-property-links">
              {usedBy.map(usedByItem)}
            </ul>
          ) : (
            <WorkflowList
              key={selection.id}
              items={usedBy}
              initialOpen
              summary={formatCount(usedBy.length, 'later step')}
            >
              {(visible) => (
                <ul className="workflow-property-links">
                  {visible.map(usedByItem)}
                </ul>
              )}
            </WorkflowList>
          )}
        </section>
        {step && onSetChecks && editable && (
          <WorkflowChecksPanel
            key={step.id}
            step={step}
            index={index}
            busy={busy}
            onSave={(checks) => onSetChecks(step.id, checks)}
          />
        )}
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
                All original signals…
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
              ? 'Change this step’s settings and recalculate what uses it'
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
          title="Open this step’s settings to make a new step beside it"
          onClick={() => onAction('duplicate')}
        >
          <CopyPlus size={13} />
          New version…
        </button>
        <button
          className="secondary-button workflow-danger"
          disabled={busy || !step}
          onClick={() => onAction('delete')}
        >
          <Trash2 size={13} />
          {step?.kind === 'import'
            ? 'Remove recording…'
            : step
              ? `Delete step ${reference(step)}…`
              : 'Delete…'}
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
