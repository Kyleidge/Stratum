'use client';
import {
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Download,
  FilePlus2,
  Search,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { visibleInput } from '@/lib/file-segments';
import { formatCount } from '@/lib/format-count';
import { reportTargetAssets } from '@/lib/report-data';
import type { SignalGraph } from '@/lib/signal-graph';
import type { Project } from '@/lib/signal-types';
import { calculatedInput } from '@/lib/value-math';
import { startWorkflowDrag, type WorkflowTarget } from '@/lib/workflow-drag';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import SegmentValueTable, { segmentGridFits } from './segment-value-table';
import { formatValue } from './signal-chart';
import type { WorkflowSelection } from './workflow-history';

export const PAGE_SIZE = 30;
const number = (value: number) => formatValue(value, 3);
const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

/**
 * The dock's Outputs tab: a step's outputs with export, report and New
 * version actions, as a By segment grid or a searchable, paged table whose
 * Input column ticks only explicit inputs.
 */
export default function WorkflowOutputsPanel({
  project,
  index,
  graph,
  step,
  selection,
  busy,
  ready,
  tableQuery,
  setTableQuery,
  page,
  setPage,
  valueLayout,
  setValueLayout,
  checkedSet,
  checkSignals,
  setInputs,
  select,
  follow,
  setDragged,
  setExportOpen,
  addToReport,
  repeat,
}: {
  project: Project;
  index: WorkflowIndex;
  graph: SignalGraph;
  step: WorkflowStep;
  selection: WorkflowSelection;
  busy: boolean;
  ready: boolean;
  tableQuery: string;
  setTableQuery: (query: string) => void;
  page: number;
  setPage: (page: number) => void;
  /** Values within segments read best as a segment × input grid. */
  valueLayout: 'segments' | 'list';
  setValueLayout: (layout: 'segments' | 'list') => void;
  checkedSet: ReadonlySet<string>;
  checkSignals: (ids: string[], checked: boolean, extend?: boolean) => void;
  setInputs: (ids: string[] | null) => void;
  select: (next: WorkflowSelection) => void;
  follow: (id: string) => void;
  setDragged: (target: WorkflowTarget | null) => void;
  setExportOpen: (open: boolean) => void;
  addToReport: (ids: string[]) => void;
  /** Opens this step's settings to make a new step beside it. */
  repeat: () => void;
}) {
  const stepOutputs = step.outputIds;
  const allValues = step.kind === 'value';
  const allSegments = !!step.segmentSetId;
  const filteredOutputs = stepOutputs.filter((id) =>
    `${index.label(id)} ${index.kind(id)} ${index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? ''}`
      .toLowerCase()
      .includes(tableQuery.toLowerCase()),
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(filteredOutputs.length / PAGE_SIZE) - 1),
  );
  const outputPage = filteredOutputs.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );
  return (
    <section className="workflow-output-panel">
      <div className="workflow-panel-heading">
        <div>
          <strong>
            {formatCount(
              stepOutputs.length,
              allValues ? 'value' : allSegments ? 'segment' : 'signal',
            )}
          </strong>
        </div>
        <div className="workflow-panel-actions">
          <button
            className="secondary-button"
            disabled={busy || !stepOutputs.length}
            onClick={() => setExportOpen(true)}
          >
            <Download size={15} /> Export data…
          </button>
          <button
            className="secondary-button"
            disabled={busy || !ready || !stepOutputs.length}
            title="Add this step's outputs to your report"
            onClick={() =>
              addToReport(
                reportTargetAssets(index, {
                  kind: 'step',
                  id: step.id,
                }),
              )
            }
          >
            <FilePlus2 size={15} /> Add to report
          </button>
          {step.kind !== 'import' && (
            <button
              className="secondary-button"
              disabled={busy}
              title="Open this step's settings to make a new step beside it"
              onClick={() => repeat()}
            >
              <CopyPlus size={15} />
              {step.kind === 'regions'
                ? 'Create signal segments'
                : 'New version…'}
            </button>
          )}
        </div>
      </div>
      {segmentGridFits(index, step) && (
        <fieldset className="workflow-layout-toggle" aria-label="Value layout">
          <button
            type="button"
            aria-pressed={valueLayout === 'segments'}
            onClick={() => setValueLayout('segments')}
          >
            By segment
          </button>
          <button
            type="button"
            aria-pressed={valueLayout === 'list'}
            onClick={() => setValueLayout('list')}
          >
            List
          </button>
        </fieldset>
      )}
      {valueLayout === 'segments' && segmentGridFits(index, step) ? (
        <SegmentValueTable
          index={index}
          step={step}
          selectedId={selection.kind === 'output' ? selection.id : undefined}
          onSelect={(id) => select({ kind: 'output', id })}
        />
      ) : step.kind === 'regions' ? (
        <div className="workflow-saved-ranges">
          {project.regionSets
            ?.find((set) => set.id === step.regionSetId)
            ?.regions.slice(0, 30)
            .map((region) => (
              <span key={region.id}>
                {region.name}: {number(region.start)}–{number(region.end)} s
              </span>
            ))}
        </div>
      ) : (
        <>
          <div className="workflow-table-tools">
            <label className="workflow-search">
              <Search size={14} />
              <input
                aria-label="Search this operation's outputs"
                placeholder="Find an output in this step…"
                value={tableQuery}
                onChange={(event) => {
                  setTableQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            {tableQuery && (
              <button
                className="workflow-link"
                onClick={() => {
                  setTableQuery('');
                  setPage(0);
                }}
              >
                Show all outputs in this step
              </button>
            )}
            {!allValues && !allSegments && (
              <>
                <button
                  className="workflow-link"
                  onClick={() =>
                    setInputs(
                      filteredOutputs.filter((id) => index.nodes.has(id)),
                    )
                  }
                >
                  Check all{' '}
                  {formatCount(
                    filteredOutputs.filter((id) => index.nodes.has(id)).length,
                    tableQuery ? 'matching signal' : 'signal',
                  )}{' '}
                  as inputs
                </button>
                <button
                  className="workflow-link"
                  disabled={!checkedSet.size}
                  onClick={() => setInputs(null)}
                >
                  Uncheck all
                </button>
              </>
            )}
          </div>
          <Table className="workflow-output-table">
            <TableHeader>
              <TableRow>
                {!allValues && !allSegments && (
                  <TableHead
                    className="workflow-check-cell"
                    title="Checked signals are the inputs for Derive, Segment and Value"
                  >
                    Input
                  </TableHead>
                )}
                <TableHead>
                  {allValues ? 'Value' : allSegments ? 'Segment' : 'Signal'}
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Made from</TableHead>
                <TableHead>
                  {allValues ? 'Result' : 'Time interval (s)'}
                </TableHead>
                <TableHead>Unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outputPage.map((id) => {
                const node = index.nodes.get(id),
                  value = index.values.get(id),
                  segment = index.segments.get(id);
                // Outputs within segments read hidden
                // crops; name the signal cropped.
                const parent = node
                  ? visibleInput(index.nodes, node.parents[0])
                  : ((value && calculatedInput(value)) ??
                    value?.inputId ??
                    segment?.segment.parentId ??
                    index.inputs(id)[0]);
                const bounds: [number, number] | undefined = segment
                  ? [segment.segment.start, segment.segment.end]
                  : node && graph.ranges.get(node.id);
                return (
                  <TableRow
                    key={id}
                    draggable
                    onDragStart={(event) => {
                      const target = {
                        kind: 'output' as const,
                        id,
                      };
                      startWorkflowDrag(
                        event.dataTransfer,
                        target,
                        index.label(id),
                      );
                      setDragged(target);
                    }}
                    onDragEnd={() => setDragged(null)}
                    onDoubleClick={() => select({ kind: 'output', id })}
                    data-state={
                      selection.kind === 'output' && selection.id === id
                        ? 'selected'
                        : undefined
                    }
                  >
                    {!allValues && !allSegments && (
                      <TableCell>
                        {/* Ticks only explicit inputs, as History does. */}
                        {node && (
                          <Checkbox
                            aria-label={`Check ${index.label(id)} as an input`}
                            checked={checkedSet.has(id)}
                            onCheckedChange={(checked) =>
                              checkSignals([id], checked)
                            }
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <button
                        className="workflow-output-name"
                        title={index.label(id)}
                        onClick={() => select({ kind: 'output', id })}
                      >
                        {index.label(id)}
                      </button>
                      {selection.kind === 'output' && selection.id === id && (
                        <span
                          className="workflow-in-view"
                          title={
                            node
                              ? 'Shown on the plot. Without checked inputs, Apply to uses this signal.'
                              : 'Shown on the plot'
                          }
                        >
                          in view
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className="workflow-type"
                        data-type={
                          value
                            ? 'value'
                            : segment
                              ? 'segment'
                              : node?.operation === 'raw'
                                ? 'original'
                                : 'derived'
                        }
                      >
                        {index.kind(id)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {parent ? (
                        <button
                          className="workflow-input-ref"
                          title={index.label(parent)}
                          onClick={() => follow(parent)}
                        >
                          {reference(index.owner.get(parent))}{' '}
                          {index.label(parent)}
                        </button>
                      ) : (
                        <span className="workflow-muted">
                          Original recording
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="workflow-number">
                      {value
                        ? value.value === null
                          ? 'Unavailable'
                          : number(value.value)
                        : bounds
                          ? `${number(bounds[0])}–${number(bounds[1])}`
                          : '—'}
                    </TableCell>
                    <TableCell>
                      {segment ? 's' : (node?.unit ?? value?.unit)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!filteredOutputs.length && (
            <p className="workflow-empty">No matching outputs in this step.</p>
          )}
          <Pager
            page={safePage}
            count={filteredOutputs.length}
            size={PAGE_SIZE}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}

function Pager({
  page,
  count,
  size,
  onPage,
}: {
  page: number;
  count: number;
  size: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="workflow-pager">
      <span>
        {count
          ? `${page * size + 1}–${Math.min(count, (page + 1) * size)} of ${count}`
          : '0 outputs'}
      </span>
      <button
        aria-label="Previous outputs"
        disabled={!page}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        aria-label="Next outputs"
        disabled={(page + 1) * size >= count}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
