'use client';

import { Pencil, ArrowUpLeft, GitBranch } from 'lucide-react';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { SignalGraph } from '@/lib/signal-graph';
import type { Project, SignalNode } from '@/lib/signal-types';
import type { WorkflowSelection } from './workflow-history';
import type { ToolbarAction } from './workflow-toolbar';
import { formatValue } from './signal-chart';

/** Metadata only: inspecting an output never evaluates or changes its inputs. */
export default function WorkflowProperties({
  project,
  index,
  graph,
  selection,
  originals,
  onFollow,
  onStep,
  onAction,
  busy,
}: {
  project: Project;
  index: WorkflowIndex;
  graph: SignalGraph;
  selection: WorkflowSelection;
  originals: SignalNode[];
  onFollow: (id: string) => void;
  onStep: (id: string) => void;
  onAction: (action: ToolbarAction) => void;
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
  const sourceIds = new Set(originals.map((original) => original.sourceId));
  if (step?.kind === 'import' && step.sourceId) sourceIds.add(step.sourceId);
  const sources = project.sources.filter((source) => sourceIds.has(source.id));
  const label =
    selection.kind === 'output'
      ? index.label(selection.id)
      : step
        ? stepName(step)
        : 'Selection';

  return (
    <aside className="workflow-properties" aria-label="Selection properties">
      <header className="workflow-properties-heading">
        <strong>Properties</strong>
        <button
          className="workflow-icon-button"
          title="Rename selection"
          aria-label="Rename selection"
          disabled={busy}
          onClick={() => onAction('rename')}
        >
          <Pencil size={13} />
        </button>
      </header>
      <div className="workflow-properties-content">
        <h2 title={label}>{label}</h2>
        <dl className="workflow-property-grid">
          <div>
            <dt>Type</dt>
            <dd>
              {selection.kind === 'output'
                ? index.kind(selection.id)
                : 'Operation'}
            </dd>
          </div>
          {node && (
            <div>
              <dt>Unit</dt>
              <dd>{node.unit || 'Unitless'}</dd>
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
                    #{String(step.sequence + 1).padStart(3, '0')}{' '}
                    {stepName(step)}
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
        {time && range && (
          <>
            <h3>{value ? 'Input time axis' : 'Time axis'}</h3>
            <dl className="workflow-property-grid">
              <div>
                <dt>Reference</dt>
                <dd>{time.name}</dd>
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
          </>
        )}
        {!!inputs.length && (
          <>
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
          </>
        )}
        {!!sources.length && (
          <>
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
          </>
        )}
        <div className="workflow-property-actions">
          {step && !['import', 'regions'].includes(step.kind) && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onAction('edit')}
            >
              <Pencil size={13} />
              Edit operation
            </button>
          )}
          <button
            className="workflow-property-link"
            onClick={() => onAction('lineage')}
          >
            <GitBranch size={13} />
            Trace lineage
          </button>
        </div>
      </div>
    </aside>
  );
}
