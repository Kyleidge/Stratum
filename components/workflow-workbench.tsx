'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, X } from 'lucide-react';
import { useSignalEngine } from '@/hooks/use-signal-engine';
import { useTheme } from '@/hooks/use-theme';
import { useMediaQuery, useStoredFlag } from '@/hooks/use-layout';
import { useReportWorkspace } from '@/hooks/use-report-workspace';
import { useWorkbenchShortcuts } from '@/hooks/use-workbench-shortcuts';
import { useWorkflowBatches } from '@/hooks/use-workflow-batches';
import { useRecordingImport } from '@/hooks/use-recording-import';
import { SignalGraph } from '@/lib/signal-graph';
import TimeWorkbench from './time-workbench';
import { workspaceTimeScope } from '@/lib/time-model';
import { stepInputs, stepName, WorkflowIndex } from '@/lib/workflow-history';
import { WORKFLOW_EXAMPLE } from '@/lib/workflow-example';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { EngineRequest, Project } from '@/lib/signal-types';
import { ACTIVE_LIMIT } from '@/lib/active-plot';
import { useActivePlot } from '@/hooks/use-active-plot';
import {
  reopenStep,
  type Editor,
  type TimeEditor,
} from '@/lib/workflow-editor';
import {
  readStoredSelection,
  storeSelection,
} from '@/lib/workflow-preferences';
import { withinFromSelection } from './within-control';
import type { WorkflowSelection } from './workflow-history';
import PlotScratchpad, { type PlotScratchpadHandle } from './plot-scratchpad';
import type { DockTab } from './workflow-dock';
import WorkflowStepDock from './workflow-step-dock';
import WorkflowCommands from './workflow-commands';
import WorkflowProperties from './workflow-properties';
import WorkflowPaneResizer from './workflow-pane-resizer';
import type { ToolbarAction } from './workflow-toolbar';
import WorkflowTopbar from './workflow-topbar';
import WorkflowSidebar from './workflow-sidebar';
import WorkflowValueTiles from './workflow-value-tiles';
import { PAGE_SIZE } from './workflow-outputs-panel';
import WorkflowStatusBar from './workflow-status-bar';
import WorkflowDetailDialog, {
  type DetailPanel,
} from './workflow-detail-dialog';
import WorkflowOperationDialog from './workflow-operation-dialog';
import {
  targetOutputs,
  targetSignals,
  type WorkflowTarget,
} from '@/lib/workflow-drag';
import { editImpact, editTitle } from './operation-inputs';
import WorkflowExport from './workflow-export';
import {
  WorkflowManagementDialogs,
  type WorkflowManagementAction,
  type WorkflowManagementRequest,
} from './workflow-management';
import DesktopAutoBackup from './desktop-auto-backup';
import {
  historyScope,
  itemsAcross,
  itemSelection,
  travelSelection,
} from '@/lib/workflow-navigation';
import type { WorkflowCommand } from '@/lib/workflow-lifecycle';
import ReportBuilderMockup from './report-builder-mockup';
import { reportTargetAssets } from '@/lib/report-data';
import WorkflowSaveDialog from './workflow-save-dialog';
import WorkflowImportDialog from './workflow-import-dialog';
import { isRecordingName, RECORDING_FORMAT_LIST } from '@/lib/formats/index';
import WorkflowRunDialog from './workflow-run-dialog';
import WorkflowBatchArea from './workflow-batch-area';
import { renderRunReport } from '@/lib/workflow-batch-report';
import { stepStatus } from '@/lib/workflow-checks';
import { formatCount } from '@/lib/format-count';
import { WorkflowAlert } from './workflow-alert';
import { WorkflowGuide } from './workflow-guide';
import { WorkflowNextSteps, WorkflowWelcome } from './workflow-welcome';
import {
  dismissTour,
  ExampleTour,
  exampleTourStops,
  tourDismissed,
} from './example-tour';
import type {
  CheckDefinition,
  WorkflowBatch,
  WorkflowRun,
} from '@/lib/workflow-types';

const INSPECTOR_STORAGE_KEY = 'stratum-inspector-open-v1';
const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

export default function WorkflowWorkbench() {
  const engine = useSignalEngine('init-workflow');
  const [theme, setTheme] = useTheme();
  const { project } = engine;
  const index = useMemo(() => new WorkflowIndex(project), [project]);
  const graph = useMemo(() => new SignalGraph(project), [project]);
  const [sourceId, setSourceId] = useState('all');
  const [timeEditor, setTimeEditor] = useState<TimeEditor>();
  const { source, batches, scopeBatch, allScope, itemRun, steps, scopeSource } =
    useMemo(() => historyScope(project, sourceId), [project, sourceId]);
  const scopedStepIds = useMemo(
    () => new Set(steps.map((step) => step.id)),
    [steps],
  );
  const [chosen, setChosen] = useState<WorkflowSelection | null>(null);
  const selection =
    chosen &&
    scopedStepIds.has(
      chosen.kind === 'step'
        ? chosen.id
        : (index.owner.get(chosen.id)?.id ?? ''),
    )
      ? chosen
      : { kind: 'output' as const, id: scopeSource?.channels[0] ?? '' };
  const step =
    selection.kind === 'step'
      ? index.steps.get(selection.id)
      : index.owner.get(selection.id);
  const activeNode =
    selection.kind === 'output' ? index.nodes.get(selection.id) : undefined;
  const activeValue =
    selection.kind === 'output' ? index.values.get(selection.id) : undefined;
  const [inputs, setInputs] = useState<string[] | null>(null);
  const inputIds = (inputs ?? (activeNode ? [activeNode.id] : [])).filter(
    (id) => index.nodes.has(id),
  );
  const processingIds =
    inputs === null ? targetSignals(index, selection) : inputIds;
  // History marks only explicit checks, never the inspected item.
  const checkedSet = useMemo(
    () => new Set((inputs ?? []).filter((id) => index.nodes.has(id))),
    [inputs, index],
  );
  const [past, setPast] = useState<WorkflowSelection[]>([]);
  const [view, updateView] = useState('result');
  const [dockTab, setDockTab] = useState<DockTab>('outputs');
  const [dockOpen, setDockOpen] = useState(true);
  const [sampleChoice, setSampleChoice] = useState('');
  function setView(next: string) {
    updateView((current) => (current.startsWith('plot:') ? current : next));
  }
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [outputFilter, setOutputFilter] = useState<
    'all' | 'signals' | 'values'
  >('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // The inspector is a column on wide windows and a drawer on narrow ones.
  const narrow = useMediaQuery('(max-width: 1240px)');
  const [inspectorOpen, setInspectorOpen] = useStoredFlag(
    INSPECTOR_STORAGE_KEY,
    true,
  );
  const [inspectorDrawer, setInspectorDrawer] = useState(false);
  const inspectorShown = narrow ? inspectorDrawer : inspectorOpen;
  function toggleInspector() {
    if (narrow) setInspectorDrawer((open) => !open);
    else setInspectorOpen(!inspectorOpen);
  }
  // Stable: the React Compiler check wants its (stable) setters listed.
  const closeDrawers = useCallback(() => {
    setHistoryOpen(false);
    setInspectorDrawer(false);
  }, [setHistoryOpen, setInspectorDrawer]);
  const [lineageRoot, setLineageRoot] = useState<string[] | null>(null);
  const lineage = useMemo(
    () => index.lineage(lineageRoot ?? []),
    [index, lineageRoot],
  );
  const lineageSteps = useMemo(
    () => new Set(lineage.steps.map((step) => step.id)),
    [lineage],
  );
  const shownSteps = (
    lineageRoot ? steps.filter((item) => lineageSteps.has(item.id)) : steps
  ).filter((item) => !flaggedOnly || (stepStatus(item) ?? 'pass') !== 'pass');
  const lineageSubject =
    lineageRoot?.length === 1
      ? index.label(lineageRoot[0])
      : `${lineageRoot?.length ?? 0} outputs`;
  const [editor, setEditorState] = useState<Editor>();
  const [managementRequest, setManagementRequest] =
    useState<WorkflowManagementRequest>();
  const editorSource = editor
    ? (project.sources.find(
        (item) =>
          item.id ===
          (index.nodes.get(editor.ids[0]) ?? index.values.get(editor.ids[0]))
            ?.sourceId,
      ) ?? workspaceTimeScope(project, graph))
    : source;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  function setEditor(next: Editor | undefined) {
    if (next) {
      setEditorState(next);
      setEditorVersion((version) => version + 1);
    }
    if (!next) setDropNote('');
    setEditorOpen(!!next);
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [help, setHelp] = useState(false),
    [notice, setNotice] = useState(''),
    [changeNotice, setChangeNotice] = useState('');
  // A notice describing the latest change offers Undo in the status bar.
  const undoable = !!notice && notice === changeNotice;
  function announceChange(message: string) {
    setNotice(message);
    setChangeNotice(message);
  }
  const {
    batchPanel,
    setBatchPanel,
    runDialog,
    setRunDialog,
    batchProgress,
    reportJob,
    cancelReports,
    displayBatch,
    batchShown,
    canReport,
    openRunDialog,
    openWorkflowFile,
    openBatchExample,
    exportReports,
    exportSummary,
    runBatch,
    cancelBatch,
    itemInfo,
  } = useWorkflowBatches({
    project,
    index,
    engine,
    sourceId,
    scopeBatch,
    itemRun,
    setSourceId,
    onStart: () => {
      setChosen(null);
      setQuery('');
      setLineageRoot(null);
      setInputs(null);
    },
    setNotice,
    announceChange,
  });
  const [tableQuery, setTableQuery] = useState(''),
    [page, setPage] = useState(0);
  // Values within segments read best as a segment × input grid.
  const [valueLayout, setValueLayout] = useState<'segments' | 'list'>(
    'segments',
  );
  // Restore the last selection once the workspace opens, if it still exists.
  const selectionRestored = useRef(false);
  useEffect(() => {
    if (!engine.ready || selectionRestored.current) return;
    selectionRestored.current = true;
    const saved = readStoredSelection();
    if (
      !saved ||
      !(saved.kind === 'step'
        ? index.steps.has(saved.id)
        : index.owner.has(saved.id))
    )
      return;
    const owner =
      saved.kind === 'output' ? index.owner.get(saved.id) : undefined;
    queueMicrotask(() => {
      setChosen((current) => current ?? saved);
      if (owner)
        setPage(Math.floor(owner.outputIds.indexOf(saved.id) / PAGE_SIZE));
      setView(saved.kind === 'step' ? 'outputs' : 'result');
    });
  }, [engine.ready, index]);
  useEffect(() => {
    if (chosen) storeSelection(chosen);
  }, [chosen]);
  const file = useRef<HTMLInputElement>(null);
  const workflowInput = useRef<HTMLInputElement>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const plots = useRef<PlotScratchpadHandle>(null);
  const [dragged, setDragged] = useState<WorkflowTarget | null>(null);
  const [detailPanel, setDetailPanel] = useState<DetailPanel>();
  const [dropNote, setDropNote] = useState('');
  const {
    report,
    workspaceView,
    reportsShown,
    openDataInspector,
    openReports,
    reportToast,
    setReportToast,
    reportAdded,
    setReportSheets,
    readReport,
    addReportBlocks,
    reportOutputIds,
    reportWorkspace,
    addToReport,
  } = useReportWorkspace({
    project,
    index,
    selection,
    engine,
    closeDrawers,
    setNotice,
    onAdd: () => setDetailPanel(undefined),
  });
  const stepOutputs = step?.outputIds ?? [];
  const request = engine.request;

  function select(next: WorkflowSelection) {
    if (next.id !== selection.id || next.kind !== selection.kind)
      setPast((old) => [...old.slice(-99), selection]);
    setChosen(next);
    // Inspection never replaces an explicitly checked input collection.
    setView(next.kind === 'step' ? 'outputs' : 'result');
    if (next.kind === 'step') {
      setDockTab('outputs');
      setDockOpen(true);
    }
    setNotice('');
    setTableQuery('');
    setPage(0);
    const owner =
      next.kind === 'output'
        ? index.owner.get(next.id)
        : index.steps.get(next.id);
    if (next.kind === 'output' && owner)
      setPage(Math.floor(owner.outputIds.indexOf(next.id) / PAGE_SIZE));
  }
  /**
   * Checks or unchecks signals. A check box starts from the explicit checks
   * alone; `extend` (Ctrl/Shift+click) first keeps a viewed signal, as a
   * file list extends its selection. Unchecking the last one follows the
   * selection again.
   */
  function checkSignals(ids: string[], checked: boolean, extend = false) {
    const signals = new Set(ids.filter((id) => index.nodes.has(id)));
    if (!signals.size) return;
    const current = extend ? inputIds : [...checkedSet];
    const next = checked
      ? [...new Set([...current, ...signals])]
      : current.filter((id) => !signals.has(id));
    setInputs(next.length ? next : null);
  }
  function follow(id: string) {
    setDetailPanel(undefined);
    if (!scopedStepIds.has(index.owner.get(id)?.id ?? '')) setSourceId('all');
    setQuery('');
    setLineageRoot(null);
    select({ kind: 'output', id });
  }
  function selectStep(id: string) {
    setDetailPanel(undefined);
    if (!scopedStepIds.has(id)) setSourceId('all');
    setQuery('');
    setLineageRoot(null);
    select({ kind: 'step', id });
  }
  function switchSource(id: string) {
    setSourceId(id);
    setBatchPanel(true);
    setChosen(null);
    setView('result');
    setNotice('');
    setPast([]);
    setQuery('');
    setTableQuery('');
    setPage(0);
    setLineageRoot(null);
  }
  /** Opens the example recording; the tour starts unless it was closed. */
  async function openExample(
    refresh = false,
    tour = !refresh && !tourDismissed(),
  ) {
    const next = await engine.mutate(
      {
        type: 'demo-workflow',
        refresh,
        sourceId: refresh ? source?.id : undefined,
      },
      refresh
        ? 'Refreshing the example recording…'
        : 'Opening the example recording…',
    );
    const example = next.sources.find(
      (item) => item.exampleKey === WORKFLOW_EXAMPLE,
    );
    if (example) switchSource(example.id);
    const stops = exampleTourStops(next);
    if (tour && stops.length) {
      select(stops[0].target);
      setTour(0);
    } else
      setNotice(
        'Example ready. Follow its seven steps in History, or start the tour from the guide.',
      );
  }
  // The example tour only selects existing items; it never changes History.
  const [tour, setTour] = useState<number | null>(null);
  const tourStops = tour === null ? [] : exampleTourStops(project);
  function goTour(next: number) {
    const stop = tourStops[next];
    if (!stop) return;
    setTour(next);
    if (stop.target.kind === 'step') selectStep(stop.target.id);
    else follow(stop.target.id);
  }
  function closeTour() {
    dismissTour();
    setTour(null);
  }
  function startTour() {
    setHelp(false);
    const example = project.sources.find(
      (item) => item.exampleKey === WORKFLOW_EXAMPLE,
    );
    const stops = exampleTourStops(project);
    if (!example || !stops.length) {
      void openExample(false, true).catch(() => {});
      return;
    }
    switchSource(example.id);
    select(stops[0].target);
    setTour(0);
  }
  function reveal(next: Project) {
    const last = next.workflowSteps?.at(-1);
    if (!last) return;
    setSourceId(last.sourceId || 'all');
    setQuery('');
    setTableQuery('');
    setLineageRoot(null);
    setPage(0);
    setEditor(undefined);
    setPast((old) => [...old.slice(-99), selection]);
    setChosen(
      last.kind === 'import' || last.outputIds.length === 1
        ? { kind: 'output', id: last.outputIds[0] }
        : { kind: 'step', id: last.id },
    );
    setView(
      last.kind === 'import' || last.outputIds.length === 1
        ? 'result'
        : 'outputs',
    );
    setInputs(
      last.kind === 'import' ||
        last.kind === 'value' ||
        last.segmentSetId ||
        last.outputIds.length === 1
        ? null
        : last.outputIds,
    );
    announceChange(
      `${reference(last)} ${stepName(last)} created ${formatCount(last.outputIds.length, last.kind === 'value' ? 'value' : last.segmentSetId ? 'segment' : 'signal')}.`,
    );
  }
  async function perform(
    message: EngineRequest,
    label: string,
    /** A name chosen in a creation dialog; Edit keeps names. */
    name?: string,
  ) {
    if (editorOpen && editor?.editingStepId) {
      const editedId = editor.editingStepId;
      const updated = await engine.mutate(
        {
          type: 'edit-operation',
          stepId: editedId,
          command: message as WorkflowCommand,
        },
        'Rebuilding operation and dependent results…',
      );
      setEditor(undefined);
      setInputs(null);
      setQuery('');
      setLineageRoot(null);
      const outputs =
        updated.workflowSteps?.find((item) => item.id === editedId)
          ?.outputIds ?? [];
      const viewed =
        selection.kind === 'output' && outputs.includes(selection.id)
          ? selection.id
          : outputs.length === 1
            ? outputs[0]
            : undefined;
      setChosen(
        viewed
          ? { kind: 'output', id: viewed }
          : { kind: 'step', id: editedId },
      );
      setView(viewed ? 'result' : 'outputs');
      announceChange('Operation updated and dependent results recalculated.');
      return;
    }
    reveal(
      await engine.mutate(
        name?.trim()
          ? {
              type: 'create-named',
              command: message as WorkflowCommand,
              name: name.trim(),
            }
          : message,
        label,
      ),
    );
  }
  async function manage(
    message: EngineRequest,
    label: string,
    transfer?: Transferable[],
  ) {
    await engine.mutate(message, label, transfer);
    if (message.type === 'rename') {
      announceChange(label);
      return;
    }
    setInputs(null);
    setQuery('');
    setTableQuery('');
    setLineageRoot(null);
    setPast([]);
    setPage(0);
    announceChange(label);
    setChosen(null);
    setView('result');
  }
  const { importChoice, setImportChoice, importFiles } = useRecordingImport({
    project,
    engine,
    reveal,
    setSourceId,
    announceChange,
  });
  // ---------------------------------------------------------------------------
  // Batch workflows

  /** Scope History to one item and select its first flagged output. */
  function openItem(run: WorkflowRun, recipeStepId?: string, position = 0) {
    switchSource(run.sourceId);
    const target = itemSelection(index, run, recipeStepId, position);
    if (target) {
      setChosen(target);
      setView(target.kind === 'step' ? 'outputs' : 'result');
    }
  }
  /** Move to the previous or next item, keeping the same recipe step. */
  function stepItem(offset: -1 | 1) {
    if (!itemRun) return;
    const { batch, run } = itemRun;
    const next =
      batch.runs[batch.runs.findIndex((item) => item.id === run.id) + offset];
    if (!next) return;
    const owner =
      selection.kind === 'step'
        ? index.steps.get(selection.id)
        : index.owner.get(selection.id);
    const position =
      owner && selection.kind === 'output'
        ? owner.outputIds.indexOf(selection.id)
        : 0;
    openItem(next, owner?.recipeStepId, Math.max(0, position));
  }
  async function previewReport(batch: WorkflowBatch, run: WorkflowRun) {
    try {
      const document = await renderRunReport({ project, batch, run, request });
      // A read-only preview: the user's draft stays until they choose to
      // replace it, and Back returns to these batch results.
      report.current?.previewReport({
        report: document,
        label: `Item ${run.itemId}`,
        back: {
          label: 'Back to batch',
          run: () => {
            setBatchPanel(true);
            openDataInspector();
          },
        },
      });
      openReports();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The report could not be rendered.',
      );
    }
  }
  function plotAcross(recipeStepId: string, runs: WorkflowRun[]) {
    const { title, traces, note } = itemsAcross(index, recipeStepId, runs);
    setBatchPanel(false);
    plots.current?.createPlotFromTraces(title, traces, { zeroTime: true });
    if (note) setNotice(note);
  }
  async function setChecks(stepId: string, checks: CheckDefinition[]) {
    await engine.mutate(
      { type: 'set-checks', stepId, checks },
      'Saving checks…',
    );
    announceChange(
      checks.length ? 'Checks saved and evaluated.' : 'Checks removed.',
    );
  }
  /**
   * Undo/Redo names the action and keeps the affected step selected while it
   * exists; otherwise the current selection stays when it still exists.
   */
  async function travel(direction: 'undo' | 'redo') {
    const label = direction === 'undo' ? engine.undoLabel : engine.redoLabel;
    const verb = direction === 'undo' ? 'Undid' : 'Redid';
    const message = label ? `${verb}: ${label}` : `${verb} last change.`;
    const before = project;
    const after = await engine.mutate({ type: direction }, message);
    const { target, next } = travelSelection(before, after, direction, chosen);
    setInputs(null);
    setQuery('');
    setTableQuery('');
    setLineageRoot(null);
    setPast([]);
    setPage(0);
    setNotice(message);
    if (
      target &&
      next?.id === target.id &&
      !scopedStepIds.has(target.id) &&
      target.sourceId !== sourceId
    )
      setSourceId('all');
    setChosen(next);
    setView(next?.kind === 'step' ? 'outputs' : 'result');
  }
  function undo() {
    if (!engine.canUndo || engine.busy) return;
    void travel('undo').catch(() => {});
  }
  function redo() {
    if (!engine.canRedo || engine.busy) return;
    void travel('redo').catch(() => {});
  }
  useWorkbenchShortcuts({
    reportsShown,
    drawerOpen: historyOpen || inspectorDrawer,
    closeDrawers,
    canStepItem: !!itemRun && !engine.busy,
    stepItem,
    openPalette: () => setPaletteOpen(true),
    undo,
    redo,
  });
  function manageSelection(
    next: WorkflowSelection,
    action: WorkflowManagementAction,
  ) {
    if (engine.busy) return;
    const target =
      next.kind === 'step'
        ? index.steps.get(next.id)
        : index.owner.get(next.id);
    if (!target) return;
    select(next);
    if (action === 'edit' && !['import', 'regions'].includes(target.kind)) {
      repeat(true, target);
    } else if (action === 'duplicate') {
      if (target.kind !== 'import') repeat(false, target);
    } else {
      setManagementRequest({
        action: action === 'edit' ? 'rename' : action,
        step: target,
        outputId: next.kind === 'output' ? next.id : undefined,
      });
    }
  }
  function repeat(editing = false, stepToOpen = step) {
    setDropNote('');
    if (!stepToOpen || !source) return;
    const opened = reopenStep(
      project,
      index,
      graph,
      stepToOpen,
      source,
      inputIds,
      editing,
    );
    if (opened && 'time' in opened) setTimeEditor(opened.time);
    else if (opened) setEditor(opened.editor);
  }
  // Report capture reads the report editor's handle; processing and inspection
  // actions never do, so commands can be listed during render.
  function handleAction(action: ToolbarAction, dropped?: WorkflowTarget) {
    if (action !== 'report') return toolbarAction(action, dropped);
    if (engine.busy) return;
    setDragged(null);
    addToReport(reportTargetAssets(index, dropped ?? selection));
  }
  function toolbarAction(
    action: Exclude<ToolbarAction, 'report'>,
    dropped?: WorkflowTarget,
  ) {
    if (engine.busy) return;
    const target = dropped ?? selection;
    const signals = dropped ? targetSignals(index, target) : processingIds;
    const targetStep =
      target.kind === 'step'
        ? index.steps.get(target.id)
        : index.owner.get(target.id);
    const valueInputs = targetOutputs(index, target).filter((id) =>
      index.values.has(id),
    );
    // Values open Calculate from values; their signals stay one click away.
    const calculate =
      action === 'value' &&
      (dropped || inputs === null) &&
      valueInputs.length > 0 &&
      valueInputs.length === targetOutputs(index, target).length;
    const note =
      !calculate &&
      (dropped || inputs === null) &&
      valueInputs.length &&
      ['derive', 'segment', 'value', 'align'].includes(action)
        ? `Using the input signal${signals.length === 1 ? '' : 's'} of ${valueInputs.length === 1 ? index.label(valueInputs[0]) : `${valueInputs.length} values`}.`
        : '';
    setDropNote(note);
    if (dropped) {
      setSourceId('all');
      setQuery('');
      setLineageRoot(null);
      select(dropped);
      if (
        !calculate &&
        [
          'derive',
          'segment',
          'value',
          'align',
          'use-viewed',
          'checked',
        ].includes(action)
      )
        setInputs(signals);
      setDragged(null);
      if (note) setNotice(note);
    }
    if (calculate) setEditor({ kind: 'calculate', ids: valueInputs });
    else if (
      action === 'derive' ||
      action === 'value' ||
      action === 'segment'
    ) {
      if (!signals.length) return;
      if (
        action === 'segment' &&
        new Set(signals.map((id) => index.nodes.get(id)?.sourceId)).size > 1
      )
        setTimeEditor({ ids: signals, mode: 'crop' });
      else
        setEditor({
          kind: action,
          ids: signals,
          ...(action === 'segment' ? { segmentSet: {} } : {}),
          // A new Segment step nests only within one viewed segment.
          within:
            action === 'segment' && target.kind === 'step'
              ? undefined
              : withinFromSelection(index, target),
        });
    } else if (action === 'align') setTimeEditor({ ids: signals });
    else if (action === 'export') {
      if (dropped) setInputs(null);
      setExportOpen(true);
    } else if (action === 'use-viewed') setInputs(targetSignals(index, target));
    else if (
      action === 'checked' ||
      action === 'samples' ||
      action === 'inputs' ||
      action === 'used-by'
    )
      setDetailPanel(action);
    else if (action === 'lineage') {
      setLineageRoot(
        target.kind === 'output'
          ? [target.id]
          : [
              ...(targetStep ? stepInputs(targetStep) : []),
              ...(targetStep?.outputIds ?? []),
            ],
      );
      setQuery('');
    } else if (action === 'owner') {
      if (targetStep) selectStep(targetStep.id);
    } else if (action === 'back') {
      const previous = past.at(-1);
      if (previous) {
        setPast((old) => old.slice(0, -1));
        setChosen(previous);
        setSourceId('all');
        setView(previous.kind === 'output' ? 'result' : 'outputs');
        setQuery('');
        setTableQuery('');
        setLineageRoot(null);
        setPage(0);
      }
    } else manageSelection(target, action);
  }
  const activePlot = useActivePlot({ index, graph, selection, step, select });
  const traceColor = new Map(
    activePlot.traces.map((trace) => [trace.id, trace.color]),
  );
  const tileValues =
    step?.kind === 'value' && selection.kind === 'step'
      ? step.outputIds.slice(0, ACTIVE_LIMIT).flatMap((id) => {
          const value = index.values.get(id);
          return value ? [value] : [];
        })
      : [];
  const valueTiles =
    activeValue || tileValues.length ? (
      <WorkflowValueTiles
        activeValue={activeValue}
        tileValues={tileValues}
        traceColor={traceColor}
        index={index}
        select={select}
      />
    ) : null;
  const sampleChoices = activePlot.traces
    .map((trace) => trace.id)
    .filter((id) => index.nodes.has(id));
  const dockSampleId = sampleChoices.includes(sampleChoice)
    ? sampleChoice
    : (sampleChoices[0] ?? '');
  const selectedLineage = index.lineage(
    selection.kind === 'output' ? [selection.id] : step ? stepInputs(step) : [],
  );
  const usedBy = [
    ...new Map(
      targetOutputs(index, selection).flatMap((id) =>
        (index.consumers.get(id) ?? []).map(
          (consumer) => [consumer.id, consumer] as const,
        ),
      ),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const title =
    selection.kind === 'output'
      ? selection.id
        ? index.label(selection.id)
        : 'Empty workspace'
      : step
        ? stepName(step)
        : 'Your workflow';
  const allSegments = !!step?.segmentSetId;
  const countAll = allScope || !!scopeBatch;
  return (
    <div
      className="workflow-app"
      onDragOver={(event) => {
        if (!reportsShown && event.dataTransfer.types.includes('Files'))
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (reportsShown || !event.dataTransfer.files.length) return;
        const files = Array.from(event.dataTransfer.files);
        const workflow = files.find((item) => /\.ya?ml$/i.test(item.name));
        // Never let the browser navigate away to a dropped file.
        event.preventDefault();
        if (engine.busy || !engine.ready) return;
        // A workflow (with or without recordings) opens the Run dialog;
        // recordings alone are imported like the Import button.
        if (workflow)
          void openWorkflowFile(
            workflow,
            files.filter((item) => item !== workflow),
          );
        else {
          const recordings = files.filter((item) => isRecordingName(item.name));
          if (recordings.length) importFiles(recordings);
          else
            engine.setError(
              `${files[0].name} is not a recording Stratum can import. Drop ${RECORDING_FORMAT_LIST} files.`,
            );
        }
      }}
      data-workspace={workspaceView}
      data-history={historyOpen}
      data-inspector={inspectorOpen}
      data-inspector-drawer={inspectorDrawer}
    >
      <WorkflowTopbar
        project={project}
        index={index}
        engine={engine}
        theme={theme}
        setTheme={setTheme}
        source={source}
        sourceId={sourceId}
        scopeBatch={scopeBatch}
        allScope={allScope}
        batches={batches}
        switchSource={switchSource}
        selection={selection}
        dragged={dragged}
        setDragged={setDragged}
        processingIds={processingIds}
        checked={inputs !== null}
        hasPast={past.length > 0}
        setInputs={setInputs}
        handleAction={handleAction}
        undo={undo}
        redo={redo}
        reportsShown={reportsShown}
        reportAdded={reportAdded}
        reportWorkspace={reportWorkspace}
        openDataInspector={openDataInspector}
        openReports={openReports}
        addToReport={addToReport}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        inspectorShown={inspectorShown}
        toggleInspector={toggleInspector}
        setPaletteOpen={setPaletteOpen}
        setHelp={setHelp}
        setSaveOpen={setSaveOpen}
        storageOpen={storageOpen}
        setStorageOpen={setStorageOpen}
        file={file}
        workflowInput={workflowInput}
        importFiles={importFiles}
        openRunDialog={openRunDialog}
        openWorkflowFile={openWorkflowFile}
        openBatchExample={openBatchExample}
        openExample={openExample}
        manage={manage}
      />
      <div
        id="workflow-data-workspace"
        className="workflow-body"
        hidden={reportsShown}
      >
        <WorkflowSidebar
          project={project}
          index={index}
          busy={engine.busy}
          ready={engine.ready}
          historyOpen={historyOpen}
          steps={steps}
          shownSteps={shownSteps}
          sourceId={sourceId}
          selection={selection}
          select={select}
          query={query}
          setQuery={setQuery}
          setTableQuery={setTableQuery}
          outputFilter={outputFilter}
          setOutputFilter={setOutputFilter}
          flaggedOnly={flaggedOnly}
          setFlaggedOnly={setFlaggedOnly}
          lineageRoot={lineageRoot}
          lineageSubject={lineageSubject}
          setLineageRoot={setLineageRoot}
          lineage={lineage}
          selectedLineage={selectedLineage}
          inputs={inputs}
          inputIds={inputIds}
          checkedSet={checkedSet}
          checkSignals={checkSignals}
          setInputs={setInputs}
          toolbarAction={toolbarAction}
          handleAction={handleAction}
          manageSelection={manageSelection}
          setDragged={setDragged}
          plots={plots}
        />
        <WorkflowPaneResizer pane="history" />
        <div className="workflow-document">
          <main className="workflow-main" data-batch-view={batchShown}>
            {!engine.ready ? (
              <div className="workflow-empty">
                {engine.error ? (
                  <WorkflowAlert message={engine.error} ready={false} />
                ) : (
                  'Opening your workspace…'
                )}
              </div>
            ) : !source ? (
              <WorkflowWelcome
                busy={engine.busy}
                error={engine.error}
                onDismissError={() => engine.setError('')}
                onExample={() => void openExample().catch(() => {})}
                onImport={() => file.current?.click()}
                onBatchExample={openBatchExample}
              />
            ) : (
              <>
                {engine.error && (
                  <WorkflowAlert
                    message={engine.error}
                    onDismiss={() => engine.setError('')}
                    onCsvHelp={() => setHelp(true)}
                    className="workflow-main-alert"
                  />
                )}
                <WorkflowBatchArea
                  project={project}
                  busy={engine.busy}
                  displayBatch={displayBatch}
                  batchShown={batchShown}
                  batchPanel={batchPanel}
                  setBatchPanel={setBatchPanel}
                  batchProgress={batchProgress}
                  reportJob={reportJob}
                  canReport={canReport}
                  openItem={openItem}
                  cancelBatch={cancelBatch}
                  exportSummary={exportSummary}
                  exportReports={exportReports}
                  previewReport={previewReport}
                  plotAcross={plotAcross}
                  cancelReports={cancelReports}
                  itemRun={itemRun}
                  itemInfo={itemInfo}
                  stepItem={stepItem}
                  switchSource={switchSource}
                />
                {tour !== null && tourStops.length > 0 && (
                  <ExampleTour
                    stops={tourStops}
                    index={Math.min(tour, tourStops.length - 1)}
                    onGo={goTour}
                    onClose={closeTour}
                  />
                )}
                {(tour === null || !tourStops.length) &&
                  (project.workflowSteps ?? []).every(
                    (item) => item.kind === 'import',
                  ) && (
                    <WorkflowNextSteps
                      disabled={engine.busy || !engine.ready}
                      onAction={(action) => toolbarAction(action)}
                    />
                  )}
                <PlotScratchpad
                  ref={plots}
                  project={project}
                  graph={graph}
                  index={index}
                  active={activePlot}
                  selectedId={selection.kind === 'output' ? selection.id : ''}
                  checkedIds={inputs === null ? [] : inputIds}
                  view={view}
                  onView={updateView}
                  onReport={addReportBlocks}
                  onSheetsChange={setReportSheets}
                  onInspect={follow}
                  request={request}
                  busy={engine.busy}
                  onNotice={setNotice}
                  onDragEnd={() => setDragged(null)}
                  valueTiles={valueTiles}
                  dock={
                    step && (
                      <WorkflowStepDock
                        project={project}
                        index={index}
                        graph={graph}
                        step={step}
                        selection={selection}
                        busy={engine.busy}
                        ready={engine.ready}
                        request={request}
                        dockTab={dockTab}
                        setDockTab={setDockTab}
                        dockOpen={dockOpen}
                        setDockOpen={setDockOpen}
                        sampleChoices={sampleChoices}
                        dockSampleId={dockSampleId}
                        setSampleChoice={setSampleChoice}
                        tableQuery={tableQuery}
                        setTableQuery={setTableQuery}
                        page={page}
                        setPage={setPage}
                        valueLayout={valueLayout}
                        setValueLayout={setValueLayout}
                        checkedSet={checkedSet}
                        checkSignals={checkSignals}
                        setInputs={setInputs}
                        select={select}
                        follow={follow}
                        setDragged={setDragged}
                        setExportOpen={setExportOpen}
                        addToReport={addToReport}
                        repeat={(editing?: boolean) => repeat(editing)}
                      />
                    )
                  }
                />
              </>
            )}
          </main>
        </div>
        {engine.ready && (step || batchShown) && (
          <>
            <WorkflowPaneResizer pane="inspector" />
            <aside
              id="workflow-inspector"
              className="workflow-inspector"
              aria-label="Details"
            >
              <WorkflowProperties
                project={project}
                index={index}
                graph={graph}
                selection={selection}
                lineage={selectedLineage}
                usedBy={usedBy}
                request={request}
                onFollow={follow}
                onStep={selectStep}
                onAction={(action) => {
                  setInspectorDrawer(false);
                  handleAction(action);
                }}
                onClose={() => {
                  if (narrow) setInspectorDrawer(false);
                  else setInspectorOpen(false);
                }}
                onSetChecks={setChecks}
                busy={engine.busy}
                batch={batchShown ? displayBatch : undefined}
              />
            </aside>
          </>
        )}
      </div>
      {(historyOpen || inspectorDrawer) && !reportsShown && (
        <button
          className="workflow-scrim"
          aria-label="Close panel"
          tabIndex={-1}
          onClick={() => {
            setHistoryOpen(false);
            setInspectorDrawer(false);
          }}
        />
      )}
      <DesktopAutoBackup
        request={request}
        revision={engine.revision}
        recordings={project.sources.length}
        ready={engine.ready}
        status={engine.status}
        cancel={engine.cancel}
        onOpenWorkspace={() => setStorageOpen(true)}
      />
      {reportToast && !reportsShown && (
        <output key={reportToast.id} className="workflow-toast">
          <FilePlus2 size={15} />
          <span>
            {reportToast.added === 0
              ? 'Nothing was added to the report.'
              : reportToast.added === 1
                ? 'Added to report'
                : `Added ${formatCount(reportToast.added, 'snapshot')} to report`}
          </span>
          <button className="workflow-link" onClick={openReports}>
            Open Reports
          </button>
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label="Dismiss"
            onClick={() => setReportToast(undefined)}
          >
            <X size={14} />
          </button>
        </output>
      )}
      <WorkflowStatusBar
        project={project}
        index={index}
        engine={engine}
        hidden={reportsShown}
        title={title}
        notice={notice}
        setNotice={setNotice}
        undoable={undoable}
        undo={undo}
        dragged={dragged}
        activeNode={activeNode}
        activeValue={activeValue}
        outputCount={stepOutputs.length}
        allSegments={allSegments}
        countAll={countAll}
        source={source}
      />
      <div
        id="workflow-reports-workspace"
        className="workflow-reports-workspace"
        hidden={!reportsShown}
      >
        <ReportBuilderMockup ref={report} workspace={reportWorkspace} />
      </div>
      {saveOpen && (
        <WorkflowSaveDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          project={project}
          initialSourceId={
            itemRun?.run.sourceId ??
            (allScope || scopeBatch ? undefined : source?.id)
          }
          report={readReport}
          onRun={(text, name) => {
            setSaveOpen(false);
            void openRunDialog(text, name);
          }}
        />
      )}
      {importChoice && (
        <WorkflowImportDialog
          key={`${importChoice.file.name}:${importChoice.file.lastModified}`}
          fileName={importChoice.file.name}
          recording={importChoice.recording}
          onClose={(setup) => {
            importChoice.resolve(setup);
            setImportChoice(null);
          }}
        />
      )}
      {runDialog && (
        <WorkflowRunDialog
          key={runDialog.key}
          open
          onOpenChange={(open) => {
            if (!open) setRunDialog(null);
          }}
          project={project}
          initialText={runDialog.text}
          initialName={runDialog.name}
          initialItems={runDialog.items}
          onStart={(plan) => void runBatch(plan)}
        />
      )}
      <WorkflowDetailDialog
        detailPanel={detailPanel}
        setDetailPanel={setDetailPanel}
        project={project}
        index={index}
        request={request}
        busy={engine.busy}
        selection={selection}
        step={step}
        activeNode={activeNode}
        activeValue={activeValue}
        title={title}
        selectedLineage={selectedLineage}
        usedBy={usedBy}
        inputs={inputs}
        processingIds={processingIds}
        setInputs={setInputs}
        follow={follow}
        selectStep={selectStep}
        setLineageRoot={setLineageRoot}
        setQuery={setQuery}
        setExportOpen={setExportOpen}
        addToReport={addToReport}
        reportOutputIds={reportOutputIds}
      />
      {managementRequest && (
        <WorkflowManagementDialogs
          project={project}
          request={managementRequest}
          busy={engine.busy}
          onClose={() => setManagementRequest(undefined)}
          onDelete={(stepId) => {
            const target = index.steps.get(stepId);
            const removed =
              target?.kind === 'import'
                ? `Removed recording ${project.sources.find((item) => item.id === target.sourceId)?.name ?? ''}`
                : target
                  ? `Deleted ${reference(target)} ${stepName(target)}`
                  : 'Step deleted';
            return manage(
              { type: 'delete-operation', stepId },
              `${removed}. Undo is available.`,
            );
          }}
          onRename={(id, name) =>
            manage({ type: 'rename', id, name }, 'Name saved.')
          }
        />
      )}
      {/* Command palette: commands mirror the top bar; any step or output in
          scope can be opened by name. */}
      <WorkflowCommands
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        steps={steps}
        selectStep={selectStep}
        follow={follow}
        project={project}
        index={index}
        engine={engine}
        processingIds={processingIds}
        step={step}
        batches={batches}
        itemRun={!!itemRun}
        reportSelection={reportWorkspace.selectionIds}
        theme={theme}
        setTheme={setTheme}
        file={file}
        workflowInput={workflowInput}
        toolbarAction={toolbarAction}
        handleAction={handleAction}
        openRunDialog={openRunDialog}
        setSaveOpen={setSaveOpen}
        switchSource={switchSource}
        stepItem={stepItem}
        setExportOpen={setExportOpen}
        openReports={openReports}
        undo={undo}
        redo={redo}
        toggleInspector={toggleInspector}
        setHelp={setHelp}
      />
      <WorkflowExport
        open={exportOpen}
        onOpenChange={setExportOpen}
        project={project}
        viewedId={selection.kind === 'output' ? selection.id : undefined}
        checkedIds={inputs === null ? [] : inputIds}
        step={step}
        request={request}
        cancel={engine.cancel}
        onSaved={(filename, saved) =>
          setNotice(
            saved ? `Saved ${filename}` : `Download prepared: ${filename}`,
          )
        }
      />
      <WorkflowOperationDialog
        editorOpen={editorOpen}
        editor={editor}
        editorVersion={editorVersion}
        editorSource={editorSource}
        engine={engine}
        project={project}
        index={index}
        graph={graph}
        dropNote={dropNote}
        setDropNote={setDropNote}
        setEditor={setEditor}
        setTimeEditor={setTimeEditor}
        perform={perform}
      />
      {timeEditor && (
        <TimeWorkbench
          project={project}
          initialIds={timeEditor.ids}
          inputNote={dropNote}
          saved={timeEditor.saved}
          initialMode={timeEditor.mode}
          editing={
            timeEditor.editingId && index.steps.has(timeEditor.editingId)
              ? {
                  title: editTitle(index.steps.get(timeEditor.editingId)!),
                  impact: editImpact(project, timeEditor.editingId),
                }
              : undefined
          }
          busy={engine.busy}
          request={request}
          onCancel={engine.cancel}
          onClose={() => {
            setTimeEditor(undefined);
            setDropNote('');
          }}
          onApply={async (settings, name) => {
            const editingId = timeEditor.editingId;
            const next = await engine.mutate(
              editingId
                ? {
                    type: 'edit-operation',
                    stepId: editingId,
                    command: { type: 'time-operation', settings },
                  }
                : name?.trim()
                  ? {
                      type: 'create-named',
                      command: { type: 'time-operation', settings },
                      name: name.trim(),
                    }
                  : { type: 'time-operation', settings },
              'Processing time bases…',
            );
            setTimeEditor(undefined);
            if (editingId) {
              setSourceId('all');
              setChosen({ kind: 'step', id: editingId });
              setView('outputs');
              announceChange(
                'Time operation updated and dependent results recalculated.',
              );
            } else reveal(next);
          }}
        />
      )}
      <WorkflowGuide
        open={help}
        onOpenChange={setHelp}
        onStartTour={startTour}
        canStartTour={engine.ready && !engine.busy}
      />
    </div>
  );
}
