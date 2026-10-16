'use client';
import { ArrowRight, FilePlus2, GitBranch, LockKeyhole, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { formatCount } from '@/lib/format-count';
import type { Project, SignalNode } from '@/lib/signal-types';
import {
  stepInputs,
  stepName,
  type WorkflowIndex,
} from '@/lib/workflow-history';
import type { ScalarValue, WorkflowStep } from '@/lib/workflow-types';
import { SignalSamples } from './plot-scratchpad';
import { targetSignals } from '@/lib/workflow-drag';
import type { WorkflowSelection } from './workflow-history';
import WorkflowList from './workflow-list';

/** Panels the toolbar opens over the workspace. */
export type DetailPanel = 'inputs' | 'used-by' | 'checked' | 'samples';

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

/**
 * The selection's samples, inputs and original signals, later steps that use
 * it, or the Apply to inputs, in one dialog.
 */
export default function WorkflowDetailDialog({
  detailPanel,
  setDetailPanel,
  project,
  index,
  request,
  busy,
  selection,
  step,
  activeNode,
  activeValue,
  title,
  selectedLineage,
  usedBy,
  inputs,
  processingIds,
  setInputs,
  follow,
  selectStep,
  setLineageRoot,
  setQuery,
  setExportOpen,
  addToReport,
  reportOutputIds,
}: {
  detailPanel?: DetailPanel;
  setDetailPanel: (panel: DetailPanel | undefined) => void;
  project: Project;
  index: WorkflowIndex;
  request: SignalEngineState['request'];
  busy: boolean;
  selection: WorkflowSelection;
  step?: WorkflowStep;
  activeNode?: SignalNode;
  activeValue?: ScalarValue;
  /** The selection's name. */
  title: string;
  selectedLineage: ReturnType<WorkflowIndex['lineage']>;
  usedBy: WorkflowStep[];
  inputs: string[] | null;
  processingIds: string[];
  setInputs: (ids: string[] | null) => void;
  follow: (id: string) => void;
  selectStep: (id: string) => void;
  setLineageRoot: (root: string[] | null) => void;
  setQuery: (query: string) => void;
  setExportOpen: (open: boolean) => void;
  addToReport: (ids: string[]) => void;
  reportOutputIds: (ids: string[]) => string[];
}) {
  const sampleIds = targetSignals(index, selection);
  const sampleId = sampleIds.length === 1 ? sampleIds[0] : '';
  const immediateInputs =
    selection.kind === 'output'
      ? index.inputs(selection.id)
      : step
        ? stepInputs(step)
        : [];
  return (
    <Dialog
      open={!!detailPanel}
      onOpenChange={(open) => {
        if (!open) setDetailPanel(undefined);
      }}
    >
      <DialogContent className="workflow-dialog">
        <DialogTitle>
          {detailPanel === 'samples'
            ? 'Signal samples'
            : detailPanel === 'checked'
              ? 'Apply to'
              : detailPanel === 'used-by'
                ? 'Used by later steps'
                : 'Inputs and original signals'}
        </DialogTitle>
        <DialogDescription>
          {detailPanel === 'checked'
            ? 'Checked inputs stay selected while you browse. Drops on processing tools replace this scope.'
            : detailPanel === 'samples'
              ? `Samples of ${index.label(sampleId)}${activeValue ? ` · input to ${title}` : ''}`
              : title}
        </DialogDescription>
        {detailPanel === 'samples' && sampleId && (
          <SignalSamples
            key={sampleId}
            id={sampleId}
            project={project}
            unit={index.nodes.get(sampleId)?.unit ?? ''}
            request={request}
            onExport={() => {
              setDetailPanel(undefined);
              setExportOpen(true);
            }}
            busy={busy}
          />
        )}
        {detailPanel === 'inputs' && (
          <>
            {' '}
            <section
              className="workflow-provenance"
              aria-label="Origin and immediate inputs"
            >
              <div>
                <span className="workflow-caption">
                  {immediateInputs.length ? 'From' : 'Origin'}
                </span>
                {immediateInputs.length ? (
                  immediateInputs.slice(0, 4).map((id, position) => (
                    <span className="workflow-input-link" key={id}>
                      <button
                        onClick={() => follow(id)}
                        title={index.label(id)}
                      >
                        {reference(index.owner.get(id))} {index.label(id)}
                      </button>
                      {activeNode?.operation === 'crop' && position > 0 && (
                        <small>boundary trigger</small>
                      )}
                    </span>
                  ))
                ) : (
                  <span>
                    {
                      project.sources.find(
                        (item) =>
                          item.id === (activeNode?.sourceId ?? step?.sourceId),
                      )?.name
                    }{' '}
                    · original recording
                  </span>
                )}
                {immediateInputs.length > 4 && (
                  <WorkflowList
                    items={immediateInputs}
                    summary={`All ${formatCount(immediateInputs.length, 'input')}`}
                  >
                    {(visible) => (
                      <div className="workflow-link-list">
                        {visible.map((id) => (
                          <button key={id} onClick={() => follow(id)}>
                            {reference(index.owner.get(id))} {index.label(id)}
                          </button>
                        ))}
                      </div>
                    )}
                  </WorkflowList>
                )}
              </div>
              {step?.kind !== 'import' && !!selectedLineage.steps.length && (
                <WorkflowList
                  key={selection.id}
                  className="workflow-lineage-details"
                  items={selectedLineage.steps}
                  summary={`Trace to original signals · ${formatCount(selectedLineage.steps.length, 'step')}`}
                >
                  {(visible) => (
                    <>
                      <p>All contributing branches, in creation order.</p>
                      <ol>
                        {visible.map((ancestor) => (
                          <li key={ancestor.id}>
                            <button onClick={() => selectStep(ancestor.id)}>
                              {reference(ancestor)} {stepName(ancestor)}
                            </button>
                            <span>
                              {formatCount(ancestor.outputIds.length, 'output')}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <WorkflowList
                        items={selectedLineage.originals}
                        summary={`${selectedLineage.originals.length} original signals`}
                      >
                        {(originals) => (
                          <div className="workflow-link-list">
                            {originals.map((node) => (
                              <button
                                key={node.id}
                                onClick={() => follow(node.id)}
                              >
                                <LockKeyhole size={12} />
                                {node.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </WorkflowList>
                    </>
                  )}
                </WorkflowList>
              )}
              {step?.kind !== 'import' && (
                <button
                  className="workflow-link workflow-lineage-toggle"
                  onClick={() => {
                    setLineageRoot(
                      selection.kind === 'output'
                        ? [selection.id]
                        : [
                            ...(step ? stepInputs(step) : []),
                            ...(step?.outputIds ?? []),
                          ],
                    );
                    setQuery('');
                  }}
                >
                  Show lineage in tree <GitBranch size={14} />
                </button>
              )}
            </section>
          </>
        )}
        {detailPanel === 'used-by' && (
          <>
            {' '}
            {!!usedBy.length && (
              <section className="workflow-used-by">
                <WorkflowList
                  items={usedBy}
                  summary={`Used by ${formatCount(usedBy.length, 'later step')}`}
                >
                  {(visible) => (
                    <div>
                      {visible.map((consumer) => (
                        <button
                          className="workflow-link"
                          key={consumer.id}
                          onClick={() => selectStep(consumer.id)}
                        >
                          {reference(consumer)} {stepName(consumer)}{' '}
                          <ArrowRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                </WorkflowList>
              </section>
            )}
            {!usedBy.length && (
              <p>Nothing uses this yet. Try Derive, Segment or Value above.</p>
            )}
          </>
        )}
        {detailPanel === 'checked' && (
          <>
            <WorkflowList
              items={processingIds}
              initialOpen
              summary={formatCount(processingIds.length, 'input signal')}
            >
              {(visible) => (
                <ul className="workflow-input-review">
                  {visible.map((id) => (
                    <li key={id}>
                      <button
                        className="workflow-link"
                        onClick={() => {
                          follow(id);
                          setDetailPanel(undefined);
                        }}
                      >
                        {index.label(id)}
                      </button>
                      <button
                        className="workflow-icon-button"
                        aria-label={`Remove ${index.label(id)} from checked inputs`}
                        onClick={() =>
                          setInputs(processingIds.filter((item) => item !== id))
                        }
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </WorkflowList>
            <div className="workflow-scope-actions">
              <button
                className="secondary-button"
                disabled={busy || !processingIds.length}
                onClick={() => addToReport(reportOutputIds(processingIds))}
              >
                <FilePlus2 size={15} />
                {inputs === null
                  ? 'Add input signals to report'
                  : 'Add checked signals to report'}
              </button>
              <button
                className="secondary-button"
                disabled={!sampleIds.length}
                onClick={() => {
                  setInputs(sampleIds);
                  setDetailPanel(undefined);
                }}
              >
                {selection.kind === 'step'
                  ? 'Use this operation’s signals'
                  : activeValue
                    ? 'Use this value’s input'
                    : 'Use only this signal'}
              </button>
              <button
                className="workflow-link"
                disabled={inputs === null}
                onClick={() => {
                  setInputs(null);
                  setDetailPanel(undefined);
                }}
              >
                Follow selection
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
