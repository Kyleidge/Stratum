'use client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { isBinaryOperation } from '@/lib/signal-arithmetic';
import type { SignalGraph } from '@/lib/signal-graph';
import type {
  EngineRequest,
  Operation,
  Project,
  Source,
} from '@/lib/signal-types';
import type { Editor, TimeEditor } from '@/lib/workflow-editor';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { ValueOperation, WorkflowStep } from '@/lib/workflow-types';
import FunctionEditor from './function-editor';
import OperationInputs, { editImpact, editTitle } from './operation-inputs';
import SegmentationEditor from './segmentation-editor';
import ValueMathEditor from './value-math-editor';
import { withinOptions } from './within-control';

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

/**
 * The Derive, Segment, Value and Calculate from values dialog, for new steps
 * and for Edit, with its live preview and processing state.
 */
export default function WorkflowOperationDialog({
  editorOpen,
  editor,
  editorVersion,
  editorSource,
  engine,
  project,
  index,
  graph,
  dropNote,
  setDropNote,
  setEditor,
  setTimeEditor,
  perform,
}: {
  editorOpen: boolean;
  editor?: Editor;
  /** Remounts the dialog's content for each newly opened editor. */
  editorVersion: number;
  /** The recording the inputs belong to, or the workspace time scope. */
  editorSource?: Source;
  engine: SignalEngineState;
  project: Project;
  index: WorkflowIndex;
  graph: SignalGraph;
  /** Explains which signals a dropped or value target was turned into. */
  dropNote: string;
  setDropNote: (note: string) => void;
  setEditor: (next: Editor | undefined) => void;
  setTimeEditor: (next: TimeEditor) => void;
  perform: (
    message: EngineRequest,
    label: string,
    name?: string,
  ) => Promise<void>;
}) {
  const request = engine.request;
  return (
    <Dialog
      open={editorOpen}
      onOpenChange={(open) => {
        if (!open && !engine.busy) setEditor(undefined);
      }}
    >
      <DialogContent
        key={editorVersion}
        className="workflow-dialog workflow-range-dialog workflow-operation-dialog"
        showCloseButton={!engine.busy}
      >
        <DialogTitle>
          {editor?.editingStepId && index.steps.has(editor.editingStepId)
            ? editTitle(index.steps.get(editor.editingStepId)!)
            : editor?.kind === 'derive'
              ? 'New derived signal'
              : editor?.kind === 'segment'
                ? editor.segmentSet
                  ? 'Find segments'
                  : 'Segment signals'
                : editor?.kind === 'calculate'
                  ? 'Calculate from values'
                  : 'Calculate values'}
        </DialogTitle>
        {editor && editorSource && editor.segmentSet ? (
          // Segments belong to the recording, not to the signals shown.
          <OperationInputs
            label="Recording"
            items={[
              {
                id: editorSource.id || 'workspace',
                label: editorSource.id
                  ? editorSource.name
                  : 'Workspace time axis',
              },
            ]}
          />
        ) : (
          editor &&
          editorSource && (
            <OperationInputs
              items={editor.ids.map((id) => ({
                id,
                label: index.label(id),
                title:
                  `${reference(index.owner.get(id))} ${index.label(id)}`.trim(),
              }))}
            />
          )
        )}
        <DialogDescription>
          {editorOpen &&
          editor?.editingStepId &&
          index.steps.has(editor.editingStepId)
            ? editImpact(project, editor.editingStepId)
            : editor?.kind === 'segment'
              ? editor.segmentSet
                ? `Find time intervals of ${editorSource?.id === '' ? 'the workspace time axis' : (editorSource?.name ?? 'the recording')} using triggers, ranges or windows.`
                : 'Create signal segments using triggers, ranges or windows.'
              : editor?.kind === 'value'
                ? 'Reduce each input signal to a scalar value.'
                : editor?.kind === 'calculate'
                  ? 'Calculate a new value from each input value with a formula.'
                  : 'Apply a function to each input signal.'}
        </DialogDescription>
        {dropNote && (
          <p className="workflow-drop-note">
            {dropNote}
            {editor?.kind === 'value' &&
              !!editor.fromValues?.length &&
              !editor.editingStepId && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="workflow-link"
                    onClick={() =>
                      setEditor({
                        kind: 'calculate',
                        ids: editor.fromValues!,
                      })
                    }
                  >
                    Calculate from the values instead
                  </button>
                </>
              )}
          </p>
        )}
        {engine.busy && (
          <div className="workflow-processing">
            <output>{engine.status}</output>
            <button className="secondary-button" onClick={engine.cancel}>
              Cancel operation
            </button>
          </div>
        )}
        {editor && editorSource && (
          <>
            {editor.kind === 'calculate' ? (
              <ValueMathEditor
                editor={editor}
                index={index}
                busy={engine.busy}
                onSignals={
                  editor.editingStepId
                    ? undefined
                    : () => {
                        const values = editor.ids;
                        setEditor({
                          kind: 'value',
                          ids: [
                            ...new Set(
                              values.flatMap(
                                (id) => index.values.get(id)?.inputId ?? [],
                              ),
                            ),
                          ],
                          fromValues: values,
                        });
                        setDropNote(
                          `Using the input signal${values.length === 1 ? '' : 's'} of ${values.length === 1 ? index.label(values[0]) : `${values.length} values`}.`,
                        );
                      }
                }
                onApply={(expression, unit, bindings, name) =>
                  perform(
                    {
                      type: 'calculate-values',
                      inputIds: editor.ids,
                      operation: 'calculate',
                      expression,
                      unit,
                      ...(bindings ? { bindings } : {}),
                    },
                    'Calculating values…',
                    name,
                  )
                }
              />
            ) : editor.kind === 'segment' ? (
              <SegmentationEditor
                workflowMode
                rangePlot={{ graph, request }}
                signalLabel={(id) => index.label(id)}
                valueIndex={index}
                valueBefore={
                  editor.editingStepId
                    ? index.steps.get(editor.editingStepId)?.sequence
                    : undefined
                }
                applyLabel={
                  editor.editingStepId
                    ? 'Save changes and recalculate'
                    : undefined
                }
                defaultRange={(() => {
                  const id = editor.ids[0];
                  const bounds = graph.ranges.get(id);
                  const offset =
                    index.nodes.get(id)?.sourceId === ''
                      ? 0
                      : (graph.offsets.get(id) ?? 0);
                  return bounds
                    ? [bounds[0] - offset, bounds[1] - offset]
                    : undefined;
                })()}
                source={editorSource}
                nodes={project.nodes.filter(
                  (node) => node.sourceId === editorSource.id && !node.internal,
                )}
                segments={project.segments}
                selectedIds={editor.ids}
                selectionKind="collection"
                savedOperation={editor.savedSegment}
                fileSegments={
                  editor.segmentSet
                    ? {
                        options: withinOptions(
                          index,
                          editor.ids,
                          editor.editingStepId
                            ? index.steps.get(editor.editingStepId)?.sequence
                            : undefined,
                          editor.editingStepId,
                        ),
                        within: editor.within,
                      }
                    : undefined
                }
                busy={engine.busy}
                onPreview={async (
                  definition,
                  targetIds,
                  independently,
                  scope,
                  within,
                ) => {
                  // Live previews never block the dialog; a newer one
                  // supersedes any still queued in the worker.
                  const response = await request(
                    editor.segmentSet
                      ? {
                          type: 'segment-set-preview',
                          sourceId: editorSource.id,
                          definition,
                          ...(editorSource.id === '' && targetIds[0]
                            ? { referenceId: targetIds[0] }
                            : {}),
                          ...(within ? { within } : {}),
                          inspection: true,
                        }
                      : {
                          type: 'segment-preview',
                          sourceId: editorSource.id,
                          definition,
                          targetIds,
                          independently,
                          scope,
                          inspection: true,
                        },
                  );
                  if (response.type !== 'segment-plan')
                    throw new Error('Unexpected preview response.');
                  return response.plan;
                }}
                nameable={!editor.editingStepId}
                onCreate={(
                  definition,
                  targetIds,
                  independently,
                  scope,
                  within,
                  name,
                ) =>
                  editor.segmentSet
                    ? perform(
                        {
                          type: 'segment-set',
                          sourceId: editorSource.id,
                          definition,
                          ...(editorSource.id === '' &&
                          definition.method !== 'triggers' &&
                          targetIds[0]
                            ? { referenceId: targetIds[0] }
                            : {}),
                          ...(within ? { within } : {}),
                        },
                        'Finding segments…',
                        name,
                      )
                    : perform(
                        {
                          type: 'segment',
                          sourceId: editorSource.id,
                          definition,
                          targetIds,
                          independently,
                          scope,
                        },
                        'Creating derived segment signals…',
                        name,
                      )
                }
              />
            ) : (
              <FunctionEditor
                // Only Derive and Value steps reach this editor.
                editor={{
                  ...editor,
                  kind: editor.kind === 'derive' ? 'derive' : 'value',
                }}
                project={project}
                index={index}
                request={request}
                busy={engine.busy}
                onCompare={
                  editor.editingStepId
                    ? undefined
                    : () => {
                        const ids = editor.ids;
                        setEditor(undefined);
                        setTimeEditor({ ids, mode: 'combine' });
                      }
                }
                onApply={(
                  operation,
                  parameter,
                  secondaryId,
                  valueParameters,
                  bindings,
                  extra,
                  within,
                  name,
                ) => {
                  const scope = within ? { within } : {};
                  if (editor.kind === 'value')
                    return perform(
                      {
                        type: 'calculate-values',
                        inputIds: editor.ids,
                        operation: operation as ValueOperation,
                        ...(valueParameters
                          ? { parameters: valueParameters }
                          : {}),
                        ...(bindings ? { bindings } : {}),
                        ...scope,
                      },
                      'Calculating values…',
                      name,
                    );
                  if (isBinaryOperation(operation))
                    return perform(
                      {
                        type: 'region-function',
                        settings: {
                          sourceId: index.nodes.get(editor.ids[0])!.sourceId,
                          inputIds: editor.ids,
                          secondaryIds: [secondaryId],
                          operation,
                          parameter,
                          ...scope,
                        },
                      },
                      'Creating derived signals…',
                      name,
                    );
                  return perform(
                    {
                      type: 'derive-many',
                      parentIds: editor.ids,
                      operation: operation as Operation,
                      parameter,
                      ...(bindings ? { bindings } : {}),
                      ...extra,
                      ...scope,
                    },
                    'Creating derived signals…',
                    name,
                  );
                }}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
