'use client';
import type { RefObject } from 'react';
import {
  AlertTriangle,
  ChartLine,
  Hash,
  ListChecks,
  Search,
  Waves,
  X,
} from 'lucide-react';
import { formatCount } from '@/lib/format-count';
import type { Project } from '@/lib/signal-types';
import type { WorkflowTarget } from '@/lib/workflow-drag';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { PlotScratchpadHandle } from './plot-scratchpad';
import WorkflowHistory, {
  type CheckedAction,
  type WorkflowSelection,
} from './workflow-history';
import type { WorkflowManagementAction } from './workflow-management';
import type { ToolbarAction } from './workflow-toolbar';

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

/**
 * The History pane: search, output filters, the lineage filter, the
 * chronological tree and, below it, the checked inputs bar.
 */
export default function WorkflowSidebar({
  project,
  index,
  busy,
  ready,
  historyOpen,
  steps,
  shownSteps,
  sourceId,
  selection,
  select,
  query,
  setQuery,
  setTableQuery,
  outputFilter,
  setOutputFilter,
  flaggedOnly,
  setFlaggedOnly,
  lineageRoot,
  lineageSubject,
  setLineageRoot,
  lineage,
  selectedLineage,
  inputs,
  inputIds,
  checkedSet,
  checkSignals,
  setInputs,
  toolbarAction,
  handleAction,
  manageSelection,
  setDragged,
  plots,
}: {
  project: Project;
  index: WorkflowIndex;
  busy: boolean;
  ready: boolean;
  historyOpen: boolean;
  /** Steps in the recording scope. */
  steps: WorkflowStep[];
  /** Steps after the lineage and Flagged filters. */
  shownSteps: WorkflowStep[];
  sourceId: string;
  selection: WorkflowSelection;
  select: (next: WorkflowSelection) => void;
  query: string;
  setQuery: (query: string) => void;
  setTableQuery: (query: string) => void;
  outputFilter: 'all' | 'signals' | 'values';
  setOutputFilter: (kind: 'all' | 'signals' | 'values') => void;
  flaggedOnly: boolean;
  setFlaggedOnly: (update: (on: boolean) => boolean) => void;
  lineageRoot: string[] | null;
  lineageSubject: string;
  setLineageRoot: (root: string[] | null) => void;
  /** The lineage of `lineageRoot`, which filters the tree. */
  lineage: { outputIds: ReadonlySet<string> };
  /** The lineage of the selection, marked in the tree. */
  selectedLineage: { outputIds: ReadonlySet<string> };
  inputs: string[] | null;
  inputIds: string[];
  checkedSet: ReadonlySet<string>;
  checkSignals: (ids: string[], checked: boolean, extend?: boolean) => void;
  setInputs: (ids: string[] | null) => void;
  toolbarAction: (action: CheckedAction) => void;
  handleAction: (action: ToolbarAction, dropped?: WorkflowTarget) => void;
  manageSelection: (
    next: WorkflowSelection,
    action: WorkflowManagementAction,
  ) => void;
  setDragged: (target: WorkflowTarget | null) => void;
  plots: RefObject<PlotScratchpadHandle | null>;
}) {
  return (
    <aside
      id="workflow-navigation"
      className="workflow-sidebar"
      aria-label="Operation history"
      data-open={historyOpen}
    >
      <div className="workflow-sidebar-heading">
        <strong>History</strong>
        {!!project.workflowSteps?.length && (
          <small title="Chronological order · oldest first">
            {formatCount(steps.length, 'step')} · oldest first
          </small>
        )}
      </div>
      {/* Search and filters appear once there is something to filter. */}
      {!!project.workflowSteps?.length && (
        <label className="workflow-search">
          <Search size={14} />
          <input
            aria-label="Search workflow"
            placeholder="Filter steps and outputs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              aria-label="Clear workflow search"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </label>
      )}
      {!!project.workflowSteps?.length && (
        <fieldset className="workflow-chips">
          <legend className="sr-only">Output type</legend>
          {(
            [
              ['all', 'All'],
              ['signals', 'Signals'],
              ['values', 'Values'],
            ] as const
          ).map(([kind, text]) => (
            <button
              key={kind}
              aria-pressed={outputFilter === kind}
              onClick={() => setOutputFilter(kind)}
            >
              {text}
            </button>
          ))}
          <button
            aria-pressed={flaggedOnly}
            title="Show only steps with failed or warning checks"
            onClick={() => setFlaggedOnly((on) => !on)}
          >
            <AlertTriangle size={11} /> Flagged
          </button>
        </fieldset>
      )}
      {lineageRoot && (
        <div className="workflow-filter">
          <span title={lineageSubject}>
            Lineage of <strong>{lineageSubject}</strong>
          </span>
          <button onClick={() => setLineageRoot(null)}>
            Show all steps <X size={12} />
          </button>
        </div>
      )}
      <WorkflowHistory
        key={JSON.stringify([sourceId, lineageRoot])}
        checkedIds={checkedSet}
        onCheck={checkSignals}
        workspaceEmpty={!project.workflowSteps?.length}
        onProcessChecked={(action) => toolbarAction(action)}
        onDragSelection={setDragged}
        steps={shownSteps}
        index={index}
        query={query}
        outputKind={outputFilter}
        selection={selection}
        lineageOutputs={selectedLineage.outputIds}
        busy={busy}
        onAction={manageSelection}
        onInspect={(target, action) => handleAction(action, target)}
        onCreatePlot={(target) => plots.current?.createPlot(target)}
        contributingOutputs={lineageRoot ? lineage.outputIds : undefined}
        onSelect={(next) => {
          select(next);
          if (next.kind === 'step' && query) {
            const item = index.steps.get(next.id)!;
            const matchesName =
              `${reference(item)} ${item.sequence + 1} ${stepName(item)}`
                .toLowerCase()
                .includes(query.trim().toLowerCase());
            if (!matchesName) setTableQuery(query);
          }
        }}
      />
      {/* Below the tree, so it never shifts rows during Ctrl+click. */}
      {inputs !== null && (
        <fieldset className="workflow-checked-bar">
          <legend className="sr-only">Checked processing inputs</legend>
          <ListChecks size={13} />
          <span
            title={`${formatCount(inputIds.length, 'signal')} checked as inputs`}
          >
            <strong>{inputIds.length.toLocaleString()}</strong> checked
          </span>
          <button
            aria-label="Calculate values for the checked signals"
            title="Calculate a value for each checked signal"
            disabled={busy || !ready || !inputIds.length}
            onClick={() => toolbarAction('value')}
          >
            <Hash size={12} /> Value…
          </button>
          <button
            aria-label="Derive signals from the checked signals"
            title="Derive a signal from each checked signal"
            disabled={busy || !ready || !inputIds.length}
            onClick={() => toolbarAction('derive')}
          >
            <Waves size={12} /> Derive…
          </button>
          <button
            className="workflow-checked-plot"
            aria-label="Plot the checked signals together"
            title="Plot the checked signals together, from any recording"
            disabled={!inputIds.length}
            onClick={() =>
              plots.current?.createPlotFromTraces(
                'Checked signals',
                inputIds.map((id) => ({ id })),
              )
            }
          >
            <ChartLine size={13} />
          </button>
          <button
            className="workflow-checked-clear"
            aria-label="Uncheck all signals"
            title="Uncheck all and follow the selection"
            disabled={busy}
            onClick={() => setInputs(null)}
          >
            <X size={12} />
          </button>
        </fieldset>
      )}
    </aside>
  );
}
