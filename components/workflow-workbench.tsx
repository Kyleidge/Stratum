'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Download,
  ScanLine,
  Scissors,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  GitBranch,
  Hash,
  HelpCircle,
  LockKeyhole,
  PanelLeft,
  PanelRight,
  Moon,
  Search,
  Sun,
  Waves,
  X,
  Undo2,
  Redo2,
  Play,
  FolderOpen,
  Save,
  ListChecks,
  AlertTriangle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSignalEngine } from '@/hooks/use-signal-engine';
import { useTheme } from '@/hooks/use-theme';
import { useMediaQuery, useStoredFlag } from '@/hooks/use-layout';
import { SignalGraph } from '@/lib/signal-graph';
import TimeWorkbench from './time-workbench';
import type { TimeSettings } from '@/lib/time-types';
import { workspaceTimeScope } from '@/lib/time-model';
import { stepName, WorkflowIndex } from '@/lib/workflow-history';
import { FUNCTIONS } from '@/lib/signal-functions';
import { operationLabels } from '@/lib/signal-explorer';
import ValueOperationPalette from './value-operation-palette';
import {
  isArithmetic,
  isBinaryOperation,
  arithmeticUnit,
} from '@/lib/signal-arithmetic';
import {
  SignalOperationPalette,
  SIGNAL_FUNCTIONS,
  OPERATION_FORMULAS,
} from './signal-operation-palette';
import { VALUE_FUNCTIONS } from '@/lib/workflow-types';
import { WORKFLOW_EXAMPLE } from '@/lib/workflow-example';
import type { ValueOperation, WorkflowStep } from '@/lib/workflow-types';
import type {
  EngineRequest,
  Operation,
  Project,
  SegmentationOperation,
} from '@/lib/signal-types';
import { segmentationOperation } from '@/lib/segmentation-operation';
import WorkflowHistory, { type WorkflowSelection } from './workflow-history';
import { formatValue } from './signal-chart';
import PlotScratchpad, {
  SignalSamples,
  type ActivePlot,
  type PlotScratchpadHandle,
} from './plot-scratchpad';
import WorkflowDock, { type DockTab } from './workflow-dock';
import WorkflowCommandPalette, {
  type PaletteCommand,
  type PaletteTarget,
} from './workflow-command-palette';
import { TRACE_COLORS } from '@/lib/plot-scratchpad';
import WorkflowProperties from './workflow-properties';
import WorkflowPaneResizer from './workflow-pane-resizer';
import WorkflowToolbar, { type ToolbarAction } from './workflow-toolbar';
import {
  readWorkflowDrag,
  startWorkflowDrag,
  targetOutputs,
  targetSignals,
  WORKFLOW_DRAG_TYPE,
  type WorkflowTarget,
} from '@/lib/workflow-drag';
import SegmentationEditor from './segmentation-editor';
import { RegionSelect, RegionNumber, finite } from './region-controls';
import WorkflowExport from './workflow-export';
import {
  WorkflowManagementDialogs,
  type WorkflowManagementAction,
  type WorkflowManagementRequest,
} from './workflow-management';
import WorkflowStorage from './workflow-storage';
import WorkflowList from './workflow-list';
import { affectedOperations } from '@/lib/workflow-lifecycle';
import type { WorkflowCommand } from '@/lib/workflow-lifecycle';
import ReportBuilderMockup from './report-builder-mockup';
import {
  reportAssets,
  reportTargetAssets,
  resolveReportAssets,
} from '@/lib/report-data';
import { captureReportPlot } from '@/lib/report-plot';
import type { PlotSheet } from '@/lib/plot-scratchpad';
import type { ReportBlock } from '@/lib/report-mockup';
import type {
  ReportBuilderHandle,
  ReportWorkspace,
} from '@/lib/report-integration';
import WorkflowSaveDialog from './workflow-save-dialog';
import WorkflowRunDialog, {
  prepareItems,
  type BatchPlan,
} from './workflow-run-dialog';
import WorkflowBatchView, {
  StatusIcon,
  type BatchProgress,
} from './workflow-batch-view';
import WorkflowItemBar from './workflow-item-bar';
import {
  batchSummaryCsv,
  downloadBlob,
  runForSource,
  type PreflightItem,
} from '@/lib/workflow-batch';
import {
  batchRecipe,
  chooseFolder,
  exportRunReports,
  renderRunReport,
} from '@/lib/workflow-batch-report';
import {
  currentResults,
  liveRunStatus,
  runEdited,
  runProblems,
  stepStatus,
} from '@/lib/workflow-checks';
import { YAML_LIMITS } from '@/lib/workflow-yaml';
import {
  componentFiles,
  EOL_WORKFLOW,
  EOL_WORKFLOW_NAME,
} from '@/lib/eol-example';
import type {
  CheckDefinition,
  WorkflowBatch,
  WorkflowRun,
} from '@/lib/workflow-types';

const PAGE_SIZE = 30;
/** Outputs of one operation drawn together on the Active plot. */
const ACTIVE_LIMIT = 8;
const INSPECTOR_STORAGE_KEY = 'stratum-inspector-open-v1';
const number = (value: number) => formatValue(value, 3);
const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
type Editor = {
  editingStepId?: string;
  kind: 'derive' | 'segment' | 'value';
  ids: string[];
  operation?: Operation | ValueOperation;
  parameter?: number;
  secondaryId?: string;
  savedSegment?: SegmentationOperation;
};

export default function WorkflowWorkbench() {
  const engine = useSignalEngine('init-workflow');
  const [theme, setTheme] = useTheme();
  const { project } = engine;
  const index = useMemo(() => new WorkflowIndex(project), [project]);
  const graph = useMemo(() => new SignalGraph(project), [project]);
  const [sourceId, setSourceId] = useState('all');
  const [timeEditor, setTimeEditor] = useState<{
    ids: string[];
    saved?: TimeSettings;
    editingId?: string;
    mode?: 'crop';
  }>();
  const source =
    project.sources.find((item) => item.id === sourceId) ?? project.sources[0];
  // History scope: everything, one batch's items, or one recording (with the
  // workspace-scope outputs its batch item produced).
  const batches = project.workflowBatches ?? [];
  const scopeBatch = sourceId.startsWith('batch:')
    ? batches.find((batch) => `batch:${batch.id}` === sourceId)
    : undefined;
  const allScope =
    sourceId === 'all' || (sourceId.startsWith('batch:') && !scopeBatch);
  const itemRun =
    !scopeBatch && !allScope ? runForSource(project, source?.id) : undefined;
  const itemRunId = itemRun?.run.id;
  const steps = useMemo(() => {
    const all = project.workflowSteps ?? [];
    if (scopeBatch) {
      const runs = new Set(scopeBatch.runs.map((run) => run.id));
      return all.filter((step) => !!step.runId && runs.has(step.runId));
    }
    if (allScope) return all;
    return all.filter(
      (step) =>
        step.sourceId === source?.id ||
        (!!itemRunId && step.runId === itemRunId),
    );
  }, [project, source?.id, scopeBatch, allScope, itemRunId]);
  const scopedStepIds = useMemo(
    () => new Set(steps.map((step) => step.id)),
    [steps],
  );
  const scopeSource = scopeBatch
    ? (project.sources.find(
        (item) => item.id === scopeBatch.runs[0]?.sourceId,
      ) ?? source)
    : source;
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
        (item) => item.id === index.nodes.get(editor.ids[0])?.sourceId,
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
  // Batch workflows: dialogs, live progress and report export.
  const [batchPanel, setBatchPanel] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [runDialog, setRunDialog] = useState<{
    key: number;
    text?: string;
    name?: string;
    items: PreflightItem[];
  } | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress>();
  const batchStop = useRef(false);
  const [reportJob, setReportJob] = useState<{
    done: number;
    total: number;
    item: string;
  }>();
  const reportAbort = useRef<AbortController | null>(null);
  const runDialogKey = useRef(0);
  const [help, setHelp] = useState(false),
    [notice, setNotice] = useState(''),
    [changeNotice, setChangeNotice] = useState('');
  // A notice describing the latest change offers Undo in the status bar.
  const undoable = !!notice && notice === changeNotice;
  function announceChange(message: string) {
    setNotice(message);
    setChangeNotice(message);
  }
  const [tableQuery, setTableQuery] = useState(''),
    [page, setPage] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const workflowInput = useRef<HTMLInputElement>(null);
  const plots = useRef<PlotScratchpadHandle>(null);
  const report = useRef<ReportBuilderHandle>(null);
  // Both workspaces stay mounted; switching only changes which one is shown.
  const [workspaceView, setWorkspaceView] = useState<'data' | 'reports'>(
    'data',
  );
  const reportsShown = workspaceView === 'reports';
  const [reportSheets, setReportSheets] = useState<PlotSheet[]>([]);
  const openDataInspector = useCallback(() => setWorkspaceView('data'), []);
  const openReports = useCallback(() => {
    setWorkspaceView('reports');
    setHistoryOpen(false);
    setInspectorDrawer(false);
  }, []);
  // Stable, so the Save dialog reads the latest draft without re-extracting each render.
  const readReport = useCallback(() => report.current?.getReport(), []);
  const addReportBlocks = useCallback(
    (blocks: ReportBlock[]) => {
      report.current?.addBlocks(blocks);
      openReports();
    },
    [openReports],
  );
  const [dragged, setDragged] = useState<WorkflowTarget | null>(null);
  const [detailPanel, setDetailPanel] = useState<
    'inputs' | 'used-by' | 'checked' | 'samples'
  >();
  const [dropNote, setDropNote] = useState('');
  const stepOutputs = step?.outputIds ?? [];
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
  const sampleIds = targetSignals(index, selection);
  const sampleId = sampleIds.length === 1 ? sampleIds[0] : '';
  const request = engine.request;
  const reportLibrary = useMemo(
    () => reportAssets(project, reportSheets),
    [project, reportSheets],
  );
  const reportRevision = useMemo(
    () => ({ project, sheets: reportSheets }),
    [project, reportSheets],
  );
  function reportOutputIds(ids: string[]) {
    return ids.flatMap((id) =>
      index.nodes.has(id)
        ? [`signal:${id}`]
        : index.values.has(id)
          ? [`value:${id}`]
          : [],
    );
  }
  const reportWorkspace: ReportWorkspace = {
    assets: reportLibrary,
    selectionIds: reportTargetAssets(index, selection),
    busy: engine.busy || !engine.ready,
    revision: reportRevision,
    resolveAssets: (ids, signal) =>
      resolveReportAssets(
        project,
        reportSheets,
        ids,
        request,
        (sheet, signal) => captureReportPlot(project, sheet, request, signal),
        signal,
      ),
    resolveDrop: (raw) => {
      const target = readWorkflowDrag(raw, index);
      return target ? reportTargetAssets(index, target) : [];
    },
  };
  function addToReport(ids: string[]) {
    if (!ids.length || engine.busy || !engine.ready) return;
    openReports();
    setDetailPanel(undefined);
    void report.current?.addAssets(ids);
  }

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
  async function openExample(refresh = false) {
    const next = await engine.mutate(
      {
        type: 'demo-workflow',
        refresh,
        sourceId: refresh ? source?.id : undefined,
      },
      refresh ? 'Refreshing example workflow…' : 'Opening example workflow…',
    );
    const example = next.sources.find(
      (item) => item.exampleKey === WORKFLOW_EXAMPLE,
    );
    if (example) switchSource(example.id);
    setNotice(
      'Example ready. Follow the seven steps in History, or explore the results below.',
    );
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
        last.outputIds.length === 1
        ? null
        : last.outputIds,
    );
    announceChange(
      `${reference(last)} ${stepName(last)} created ${last.outputIds.length} ${last.kind === 'value' ? 'values' : 'signals'}.`,
    );
  }
  async function perform(message: EngineRequest, label: string) {
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
    reveal(await engine.mutate(message, label));
  }
  async function manage(message: EngineRequest, label: string) {
    await engine.mutate(message, label);
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
    if (message.type === 'undo' || message.type === 'redo') setNotice(label);
    else announceChange(label);
    setChosen(null);
    setView('result');
  }
  // ---------------------------------------------------------------------------
  // Batch workflows

  function importFiles(selected: File[]) {
    if (!selected.length) return;
    void (async () => {
      for (const item of selected)
        await perform(
          { type: 'import', file: item },
          `Importing ${item.name}…`,
        );
      if (selected.length > 1) setSourceId('all');
    })().catch(() => {});
  }
  async function openRunDialog(
    text?: string,
    name?: string,
    files: File[] = [],
  ) {
    const items = await prepareItems(text, files);
    runDialogKey.current++;
    setRunDialog({ key: runDialogKey.current, text, name, items });
  }
  async function openWorkflowFile(file: File, recordings: File[] = []) {
    if (file.size > YAML_LIMITS.bytes) {
      setNotice('Workflow files are limited to 8 MiB.');
      return;
    }
    await openRunDialog(await file.text(), file.name, recordings);
  }
  function openBatchExample() {
    void openRunDialog(EOL_WORKFLOW, EOL_WORKFLOW_NAME, componentFiles());
  }
  async function exportReports(
    snapshot: Project,
    batch: WorkflowBatch,
    runs: WorkflowRun[],
    mode: 'zip' | 'folder' = 'zip',
  ) {
    if (reportAbort.current || !runs.length) return;
    let folder;
    if (mode === 'folder') {
      try {
        folder = await chooseFolder();
      } catch {
        return; // The folder picker was dismissed.
      }
    }
    const controller = new AbortController();
    reportAbort.current = controller;
    setReportJob({ done: 0, total: runs.length, item: runs[0].itemId });
    try {
      const result = await exportRunReports({
        project: snapshot,
        batch,
        runs,
        request,
        folder,
        signal: controller.signal,
        progress: (done, total, item) => setReportJob({ done, total, item }),
      });
      if (result.zip) downloadBlob(result.zip, `${batch.name} · reports.zip`);
      setNotice(
        `${result.written} ${result.written === 1 ? 'report' : 'reports'} ${folder ? 'saved to the chosen folder' : 'downloaded as a ZIP'}.`,
      );
    } catch (error) {
      setNotice(
        controller.signal.aborted
          ? 'Report export cancelled. Nothing was downloaded.'
          : error instanceof Error
            ? error.message
            : 'Reports could not be exported.',
      );
    } finally {
      reportAbort.current = null;
      setReportJob(undefined);
    }
  }
  function exportSummary(snapshot: Project, batch: WorkflowBatch) {
    downloadBlob(
      new Blob([batchSummaryCsv(snapshot, batch)], { type: 'text/csv' }),
      `${batch.name} · summary.csv`,
    );
  }
  async function runBatch(plan: BatchPlan) {
    setRunDialog(null);
    if (engine.busy) return;
    const batchId = crypto.randomUUID();
    const failures: { name: string; message: string }[] = [];
    let cancelled = false;
    batchStop.current = false;
    setBatchProgress({
      batchId,
      name: plan.batchName,
      startedAt: new Date().toISOString(),
      done: 0,
      total: plan.items.length,
      current: plan.items[0]?.name ?? '',
      failures: [],
    });
    setSourceId(`batch:${batchId}`);
    setBatchPanel(true);
    setChosen(null);
    setQuery('');
    setLineageRoot(null);
    setInputs(null);
    await engine.sequence(
      plan.items.map((item) => ({
        type: 'run-workflow' as const,
        recipe: plan.recipeText,
        batchId,
        batchName: plan.batchName,
        itemId: item.itemId,
        file: item.file,
        sourceId: item.sourceId,
      })),
      plan.items.map(
        (item, position) =>
          `Processing ${item.itemId} · ${position + 1} of ${plan.items.length}`,
      ),
      (position, result) => {
        if (result.error) {
          if (batchStop.current || /cancelled/i.test(result.error.message)) {
            cancelled = true;
            return false;
          }
          failures.push({
            name: plan.items[position].name,
            message: result.error.message,
          });
        }
        setBatchProgress(
          (old) =>
            old && {
              ...old,
              done: position + 1,
              current: plan.items[position + 1]?.name ?? '',
              failures: [...failures],
            },
        );
        if (batchStop.current) {
          cancelled = true;
          return false;
        }
      },
    );
    let finished: Project | undefined;
    try {
      finished = await engine.mutate(
        {
          type: 'finish-batch',
          batchId,
          state: cancelled ? 'cancelled' : 'complete',
          failures,
        },
        'Finishing batch…',
      );
    } catch {
      finished = undefined;
    }
    setBatchProgress(undefined);
    const batch = finished?.workflowBatches?.find(
      (item) => item.id === batchId,
    );
    if (!finished || !batch) {
      setSourceId('all');
      setNotice(
        cancelled
          ? 'Batch cancelled before any recording was processed. Nothing was added.'
          : `No recordings were processed. ${failures[0] ? `${failures[0].name}: ${failures[0].message}` : ''}`,
      );
      return;
    }
    const steps = new Map(
      (finished.workflowSteps ?? []).map((item) => [item.id, item]),
    );
    const flagged = batch.runs.filter(
      (run) => liveRunStatus(run, steps) !== 'pass',
    ).length;
    announceChange(
      `${cancelled ? 'Batch cancelled · ' : ''}${batch.runs.length} ${batch.runs.length === 1 ? 'recording' : 'recordings'} processed · ${flagged} flagged${failures.length ? ` · ${failures.length} not imported` : ''}.`,
    );
    if (plan.exportSummary) exportSummary(finished, batch);
    if (plan.exportReports && !cancelled)
      await exportReports(finished, batch, batch.runs);
  }
  function cancelBatch() {
    batchStop.current = true;
    engine.cancel();
  }
  /** Scope History to one item and select its first flagged output. */
  function openItem(run: WorkflowRun, recipeStepId?: string, position = 0) {
    switchSource(run.sourceId);
    const runSteps = Object.entries(run.steps).flatMap(([recipeId, id]) => {
      const item = index.steps.get(id);
      return item ? [[recipeId, item] as const] : [];
    });
    let target: WorkflowSelection | undefined;
    const kept = runSteps.find(([recipeId]) => recipeId === recipeStepId)?.[1];
    if (kept)
      target = kept.outputIds.length
        ? {
            kind: 'output',
            id: kept.outputIds[Math.min(position, kept.outputIds.length - 1)],
          }
        : { kind: 'step', id: kept.id };
    if (!target)
      for (const [, item] of runSteps) {
        const status = stepStatus(item);
        if (status && status !== 'pass') {
          const failing = currentResults(item).find(
            (result) => result.status !== 'pass' && result.outputId,
          );
          target = failing?.outputId
            ? { kind: 'output', id: failing.outputId }
            : { kind: 'step', id: item.id };
          break;
        }
      }
    const last = runSteps.at(-1)?.[1];
    if (!target && last) target = { kind: 'step', id: last.id };
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
      report.current?.loadReport(document);
      openReports();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The report could not be rendered.',
      );
    }
  }
  function plotAcross(
    batch: WorkflowBatch,
    recipeStepId: string,
    runs: WorkflowRun[],
  ) {
    const traces = runs.flatMap((run) => {
      const item = index.steps.get(run.steps[recipeStepId] ?? '');
      return item
        ? item.outputIds
            .filter((id) => index.nodes.has(id))
            .map((id) => ({ id, label: `${run.itemId} · ${index.label(id)}` }))
        : [];
    });
    const first = runs
      .map((run) => index.steps.get(run.steps[recipeStepId] ?? ''))
      .find(Boolean);
    setBatchPanel(false);
    plots.current?.createPlotFromTraces(
      `${first ? stepName(first) : recipeStepId} · ${runs.length} items`,
      traces,
      { zeroTime: true },
    );
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
  function undo() {
    if (!engine.canUndo || engine.busy) return;
    void manage({ type: 'undo' }, 'Undid last change.').catch(() => {});
  }
  function redo() {
    if (!engine.canRedo || engine.busy) return;
    void manage({ type: 'redo' }, 'Redid last change.').catch(() => {});
  }
  // Ctrl+Z / Ctrl+Y outside text fields and dialogs, with the latest handlers.
  // Reports owns its keyboard: its Undo never changes the signal workflow.
  const shortcuts = useRef<(event: KeyboardEvent) => void>(undefined);
  useEffect(() => {
    shortcuts.current = (event) => {
      if (reportsShown) return;
      if (
        event.key === 'Escape' &&
        (historyOpen || inspectorDrawer) &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        setHistoryOpen(false);
        setInspectorDrawer(false);
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        itemRun &&
        !engine.busy &&
        !(
          event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]')
        ) &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        event.preventDefault();
        stepItem(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
          return;
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (key !== 'z' && key !== 'y') return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      event.preventDefault();
      if (key === 'y' || event.shiftKey) redo();
      else undo();
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcuts.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
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
    const step = stepToOpen;
    if (!step || !source) return;
    if (step.timeSettings) {
      setTimeEditor({
        ids: step.inputIds,
        saved: step.timeSettings,
        editingId: editing ? step.id : undefined,
      });
      return;
    }
    const open = (next: Editor) =>
      setEditor({ ...next, editingStepId: editing ? step.id : undefined });
    const nodeIds = step.inputIds.filter((id) => index.nodes.has(id));
    if (step.kind === 'segment') {
      const saved = step.segmentationId
        ? segmentationOperation(project, step.segmentationId)
        : undefined;
      const targets = saved?.targetIds ?? [
        ...new Set(
          step.outputIds.flatMap(
            (id) => index.nodes.get(id)?.parents.slice(0, 1) ?? [],
          ),
        ),
      ];
      const cropRanges: [number, number][] = step.outputIds.flatMap((id) => {
        const node = index.nodes.get(id);
        return node?.operation === 'crop'
          ? [
              [
                node.parameters.start -
                  (graph.offsets.get(node.parents[0]) ?? 0),
                node.parameters.end - (graph.offsets.get(node.parents[0]) ?? 0),
              ] as [number, number],
            ]
          : [];
      });
      open({
        kind: 'segment',
        ids: targets,
        savedSegment: saved ?? {
          id: step.id,
          sourceId: source.id,
          definition: {
            method: 'ranges',
            boundary: 'clip',
            ranges: cropRanges,
          },
          targetIds: targets,
          independently: targets.length > 1,
          scope: 'signals',
          segmentIds: [],
        },
      });
    } else if (step.kind === 'regions') {
      const set = project.regionSets?.find(
        (item) => item.id === step.regionSetId,
      );
      if (!set) return;
      open({
        kind: 'segment',
        ids: inputIds.length ? inputIds : source.channels,
        savedSegment: {
          id: step.id,
          sourceId: source.id,
          definition: {
            method: 'ranges',
            boundary: 'clip',
            ranges: set.regions.map((region) => [region.start, region.end]),
          },
          targetIds: inputIds.length ? inputIds : source.channels,
          independently: true,
          scope: 'signals',
          segmentIds: [],
        },
      });
    } else if (step.kind === 'derive' || step.kind === 'value') {
      const binary = isBinaryOperation(step.operation);
      const parents = step.outputIds.flatMap(
        (id) => index.nodes.get(id)?.parents.slice(0, 1) ?? [],
      );
      const second = [
        ...new Set(
          step.outputIds.flatMap(
            (id) => index.nodes.get(id)?.parents.slice(1, 2) ?? [],
          ),
        ),
      ];
      open({
        kind: step.kind,
        ids: binary ? [...new Set(parents)] : nodeIds,
        operation: step.operation as Operation | ValueOperation,
        parameter: step.parameters?.value,
        secondaryId: second.length === 1 ? second[0] : '',
      });
    }
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
    const note =
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
    if (action === 'derive' || action === 'value' || action === 'segment') {
      if (!signals.length) return;
      if (
        action === 'segment' &&
        new Set(signals.map((id) => index.nodes.get(id)?.sourceId)).size > 1
      )
        setTimeEditor({ ids: signals, mode: 'crop' });
      else setEditor({ kind: action, ids: signals });
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
          : [...(targetStep?.inputIds ?? []), ...(targetStep?.outputIds ?? [])],
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
  // Active plots the selection: a signal, a value over its input, or up to
  // ACTIVE_LIMIT outputs of an operation. Colours follow each output's position
  // in its operation, so a member keeps its colour alone or with siblings.
  const selectionKind = selection.kind,
    selectionId = selection.id;
  const activePlot = useMemo<ActivePlot>(() => {
    const key = `${selectionKind}:${selectionId}`;
    const colorOf = (id: string, ids: string[]) => {
      const owners = new Set(ids.map((item) => index.owner.get(item)?.id));
      const owner = index.owner.get(id);
      const slot =
        owners.size === 1 && owner
          ? owner.outputIds.indexOf(id)
          : ids.indexOf(id);
      return TRACE_COLORS[Math.max(0, slot) % TRACE_COLORS.length];
    };
    const withInputs = (valueIds: string[]) => {
      const inputs = [
        ...new Set(
          valueIds.flatMap((id) => {
            const input = index.values.get(id)?.inputId;
            return input && index.nodes.has(input) ? [input] : [];
          }),
        ),
      ];
      const colors = new Map(inputs.map((id) => [id, colorOf(id, inputs)]));
      return [
        ...inputs.map((id) => ({ id, color: colors.get(id)! })),
        ...valueIds.map((id) => ({
          id,
          color:
            colors.get(index.values.get(id)?.inputId ?? '') ?? TRACE_COLORS[0],
        })),
      ];
    };
    if (selectionKind === 'output') {
      const title = index.label(selectionId);
      return {
        key,
        title,
        traces: index.values.has(selectionId)
          ? withInputs([selectionId])
          : index.nodes.has(selectionId)
            ? [{ id: selectionId, color: colorOf(selectionId, [selectionId]) }]
            : [],
      };
    }
    const owner = index.steps.get(selectionId);
    if (!owner) return { key, title: 'Your workflow', traces: [] };
    const values = owner.outputIds.filter((id) => index.values.has(id));
    const signals = owner.outputIds.filter((id) => index.nodes.has(id));
    const members = values.length ? values : signals;
    const shown = members.slice(0, ACTIVE_LIMIT);
    return {
      key,
      title: stepName(owner),
      traces: values.length
        ? withInputs(shown)
        : shown.map((id) => ({ id, color: colorOf(id, shown) })),
      note:
        members.length > shown.length
          ? `Showing ${shown.length} of ${members.length} outputs. Create a plot from History to compare all of them.`
          : undefined,
    };
  }, [selectionKind, selectionId, index]);
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
  const valueTiles = activeValue ? (
    <section className="workflow-value-card" aria-label="Calculated value">
      <div>
        <span>
          {
            VALUE_FUNCTIONS.find(
              (spec) => spec.operation === activeValue.operation,
            )?.name
          }
        </span>
        <strong>
          {activeValue.value === null
            ? 'Unavailable'
            : number(activeValue.value)}{' '}
          <small>{activeValue.unit}</small>
        </strong>
      </div>
      <p>
        {activeValue.value === null
          ? 'No finite result. Time averages require adjacent finite samples with positive elapsed time.'
          : `${activeValue.sampleCount.toLocaleString()} finite samples · ${number(activeValue.validDuration)} s of valid intervals${activeValue.timestamp !== undefined ? ` · first occurs at ${number(activeValue.timestamp)} s` : ''}`}
      </p>
      <p>
        {
          VALUE_FUNCTIONS.find(
            (spec) => spec.operation === activeValue.operation,
          )?.description
        }
      </p>
    </section>
  ) : tileValues.length ? (
    <div className="workflow-value-tiles" aria-label="Calculated values">
      {tileValues.map((value) => (
        <button
          key={value.id}
          className="workflow-value-tile"
          onClick={() => select({ kind: 'output', id: value.id })}
          title={`Open ${index.label(value.id)}`}
        >
          <span>
            <i style={{ background: traceColor.get(value.id) }} />
            {index.label(value.id)}
          </span>
          <strong>
            {value.value === null ? 'Unavailable' : number(value.value)}{' '}
            <small>{value.unit}</small>
          </strong>
          <em>
            {VALUE_FUNCTIONS.find((spec) => spec.operation === value.operation)
              ?.name ?? 'Value'}
            {value.timestamp !== undefined
              ? ` · at ${number(value.timestamp)} s`
              : ` · ${value.sampleCount.toLocaleString()} samples`}
          </em>
        </button>
      ))}
    </div>
  ) : null;
  const sampleChoices = activePlot.traces
    .map((trace) => trace.id)
    .filter((id) => index.nodes.has(id));
  const dockSampleId = sampleChoices.includes(sampleChoice)
    ? sampleChoice
    : (sampleChoices[0] ?? '');
  // Command palette: commands mirror the top bar; any step or output in scope
  // can be opened by name.
  const paletteCommands: PaletteCommand[] = [
    ...(
      [
        ['derive', 'Derive signal…', Waves],
        ['segment', 'Segment…', Scissors],
        ['value', 'Calculate value…', Hash],
        ['align', 'Compare & align…', ScanLine],
      ] as const
    ).map(([action, label, icon]) => ({
      id: `command:${action}`,
      label,
      hint: `Apply to ${processingIds.length === 1 ? index.label(processingIds[0]) : `${processingIds.length} signals`}`,
      icon,
      disabled: engine.busy || !engine.ready || !processingIds.length,
      run: () => toolbarAction(action),
    })),
    {
      id: 'command:import',
      label: 'Import CSV…',
      icon: ArrowDownToLine,
      disabled: engine.busy || !engine.ready,
      run: () => file.current?.click(),
    },
    {
      id: 'command:run-workflow',
      label: 'Run a workflow on recordings…',
      hint: 'Process many files with saved steps and checks',
      icon: Play,
      disabled: engine.busy || !engine.ready,
      run: () => void openRunDialog(),
    },
    {
      id: 'command:open-workflow',
      label: 'Open a workflow file…',
      icon: FolderOpen,
      disabled: engine.busy || !engine.ready,
      run: () => workflowInput.current?.click(),
    },
    {
      id: 'command:save-workflow',
      label: 'Save workflow…',
      hint: 'Steps, checks and report layout as a .stratum.yaml file',
      icon: Save,
      disabled: engine.busy || !project.sources.length,
      run: () => setSaveOpen(true),
    },
    ...batches.slice(-5).map((batch) => ({
      id: `command:batch:${batch.id}`,
      label: `Open batch results · ${batch.name}`,
      hint: `${batch.runs.length} items`,
      icon: ListChecks,
      run: () => switchSource(`batch:${batch.id}`),
    })),
    ...(itemRun
      ? [
          {
            id: 'command:next-item',
            label: 'Next batch item',
            shortcut: 'Alt →',
            icon: ChevronRight,
            run: () => stepItem(1),
          },
          {
            id: 'command:previous-item',
            label: 'Previous batch item',
            shortcut: 'Alt ←',
            icon: ChevronLeft,
            run: () => stepItem(-1),
          },
        ]
      : []),
    {
      id: 'command:export',
      label: 'Export / report…',
      icon: Download,
      disabled: !step?.outputIds.length,
      run: () => setExportOpen(true),
    },
    {
      id: 'command:report',
      label: 'Add to report',
      hint: 'Capture the viewed output or operation',
      icon: FilePlus2,
      disabled:
        engine.busy || !engine.ready || !reportWorkspace.selectionIds.length,
      run: () => handleAction('report'),
    },
    {
      id: 'command:reports',
      label: 'Open Reports',
      icon: FileText,
      run: openReports,
    },
    {
      id: 'command:undo',
      label: 'Undo last change',
      shortcut: 'Ctrl Z',
      icon: Undo2,
      disabled: !engine.canUndo || engine.busy,
      run: undo,
    },
    {
      id: 'command:redo',
      label: 'Redo last change',
      shortcut: 'Ctrl Y',
      icon: Redo2,
      disabled: !engine.canRedo || engine.busy,
      run: redo,
    },
    {
      id: 'command:theme',
      label: theme === 'dark' ? 'Use light theme' : 'Use dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'command:inspector',
      label: 'Show or hide the inspector',
      icon: PanelRight,
      run: toggleInspector,
    },
    {
      id: 'command:guide',
      label: 'Open the workflow guide',
      icon: HelpCircle,
      run: () => setHelp(true),
    },
  ];
  const paletteTargets = (): PaletteTarget[] =>
    steps.flatMap((item) => [
      {
        id: `step:${item.id}`,
        label: `${reference(item)} ${stepName(item)}`,
        hint: `Operation · ${item.outputIds.length} output${item.outputIds.length === 1 ? '' : 's'}`,
        icon:
          item.kind === 'value'
            ? Hash
            : item.kind === 'segment' || item.kind === 'regions'
              ? Scissors
              : item.kind === 'import'
                ? LockKeyhole
                : Waves,
        run: () => selectStep(item.id),
      },
      ...item.outputIds.map((id) => ({
        id: `output:${id}`,
        label: index.label(id),
        hint: `${index.kind(id)} · ${reference(item)}`,
        icon: index.values.has(id)
          ? Hash
          : index.nodes.get(id)?.operation === 'raw'
            ? LockKeyhole
            : Waves,
        run: () => follow(id),
      })),
    ]);
  const selectedLineage = index.lineage(
    selection.kind === 'output' ? [selection.id] : (step?.inputIds ?? []),
  );
  const immediateInputs =
    selection.kind === 'output'
      ? index.inputs(selection.id)
      : (step?.inputIds ?? []);
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
  const allValues = step?.kind === 'value';
  const countAll = allScope || !!scopeBatch;
  const originalCount = countAll
    ? project.sources.reduce((sum, item) => sum + item.channels.length, 0)
    : (source?.channels.length ?? 0);
  const derivedCount = project.nodes.filter(
    (node) =>
      (countAll || node.sourceId === source?.id) && node.operation !== 'raw',
  ).length;
  const valueCount = (project.values ?? []).filter(
    (value) => countAll || value.sourceId === source?.id,
  ).length;
  // Until its first item commits, a starting batch is shown from its progress.
  const displayBatch: WorkflowBatch | undefined =
    scopeBatch ??
    (batchProgress && sourceId === `batch:${batchProgress.batchId}`
      ? {
          id: batchProgress.batchId,
          name: batchProgress.name,
          recipeHash: '',
          createdAt: batchProgress.startedAt,
          state: 'running',
          runs: [],
        }
      : undefined);
  const batchShown = !!displayBatch && batchPanel;
  const itemBatch = itemRun?.batch;
  const itemLabel = useMemo(() => {
    if (!itemBatch) return 'Item';
    try {
      return batchRecipe(project, itemBatch).recipe.item.label;
    } catch {
      return 'Item';
    }
  }, [project, itemBatch]);
  const itemInfo = itemRun && {
    label: itemLabel,
    status: liveRunStatus(itemRun.run, index.steps),
    problems: runProblems(itemRun.run, index.steps),
    edited: runEdited(itemRun.run, index.steps),
  };
  const canReport = (batch: WorkflowBatch) => {
    try {
      return !!batchRecipe(project, batch).recipe.report;
    } catch {
      return false;
    }
  };
  const runStatuses = new Map(
    batches.flatMap((batch) =>
      batch.runs.map(
        (run) => [run.sourceId, liveRunStatus(run, index.steps)] as const,
      ),
    ),
  );
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
        else importFiles(files.filter((item) => /\.csv$/i.test(item.name)));
      }}
      data-workspace={workspaceView}
      data-history={historyOpen}
      data-inspector={inspectorOpen}
      data-inspector-drawer={inspectorDrawer}
    >
      <header className="workflow-topbar">
        <button
          className="workflow-icon-button workflow-quiet workflow-history-toggle"
          aria-label="Toggle operation history"
          aria-expanded={historyOpen}
          aria-controls="workflow-navigation"
          hidden={reportsShown}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <PanelLeft size={17} />
        </button>
        <div className="workflow-brand">
          <Waves size={18} />
          <strong>Stratum</strong>
        </div>
        <nav className="workflow-workspaces" aria-label="Workspace">
          <button
            type="button"
            aria-label="Data Inspector"
            title="Data Inspector: signals, operations and plots"
            aria-current={reportsShown ? undefined : 'page'}
            aria-controls="workflow-data-workspace"
            onClick={openDataInspector}
          >
            <Waves />
            <span>Data Inspector</span>
          </button>
          <button
            type="button"
            aria-label="Reports"
            title="Reports: compose and export a PDF. Drop a History item here to add it."
            aria-current={reportsShown ? 'page' : undefined}
            aria-controls="workflow-reports-workspace"
            data-drop={dragged && !engine.busy ? 'accept' : undefined}
            onClick={openReports}
            onDragOver={(event) => {
              if (
                !engine.busy &&
                event.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                openReports();
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragged(null);
              addToReport(
                reportWorkspace.resolveDrop(
                  event.dataTransfer.getData(WORKFLOW_DRAG_TYPE),
                ),
              );
            }}
          >
            <FileText />
            <span>Reports</span>
          </button>
        </nav>
        {/* Signal controls stay mounted in Reports so their state is kept. */}
        <div className="workflow-topbar-data" hidden={reportsShown}>
          {source && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="workflow-scope-menu"
                    aria-label="Recordings shown in History"
                    title="Recordings shown in History"
                  />
                }
              >
                {scopeBatch ? (
                  <ListChecks size={14} />
                ) : (
                  <FileSpreadsheet size={14} />
                )}
                <span>
                  {scopeBatch
                    ? `Batch · ${scopeBatch.name}`
                    : allScope
                      ? 'All recordings & results'
                      : `${source.name}${source.synthetic ? ' · Example' : ''}`}
                </span>
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="workflow-scope-popup"
                align="start"
              >
                <DropdownMenuRadioGroup
                  value={scopeBatch ? sourceId : allScope ? 'all' : source.id}
                  onValueChange={(value: string) => switchSource(value)}
                >
                  <DropdownMenuRadioItem value="all" closeOnClick>
                    All recordings & results
                  </DropdownMenuRadioItem>
                  {!!batches.length && <DropdownMenuSeparator />}
                  {batches.map((batch) => (
                    <DropdownMenuRadioItem
                      key={batch.id}
                      value={`batch:${batch.id}`}
                      closeOnClick
                    >
                      <ListChecks size={13} />
                      Batch · {batch.name} · {batch.runs.length}{' '}
                      {batch.runs.length === 1 ? 'item' : 'items'}
                    </DropdownMenuRadioItem>
                  ))}
                  {!!batches.length && <DropdownMenuSeparator />}
                  {project.sources.map((item) => {
                    const status = runStatuses.get(item.id);
                    return (
                      <DropdownMenuRadioItem
                        key={item.id}
                        value={item.id}
                        closeOnClick
                      >
                        {status && <StatusIcon status={status} size={12} />}
                        {item.name}
                        {item.synthetic ? ' · Example' : ''}
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="workflow-divider" />
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label="Undo last change"
            title="Undo last change · Ctrl+Z (kept across restarts)"
            disabled={!engine.canUndo || engine.busy}
            onClick={() => undo()}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label="Redo last change"
            title="Redo last change · Ctrl+Y"
            disabled={!engine.canRedo || engine.busy}
            onClick={() => redo()}
          >
            <Redo2 size={16} />
          </button>
          <span className="workflow-divider" />
          <WorkflowToolbar
            selection={selection}
            dragged={dragged}
            index={index}
            inputIds={processingIds}
            checked={inputs !== null}
            hasPast={past.length > 0}
            busy={engine.busy || !engine.ready}
            onAction={handleAction}
            onClearChecked={() => setInputs(null)}
            onDragEnd={() => setDragged(null)}
          />
        </div>
        <div className="workflow-topbar-end">
          <div className="workflow-topbar-data" hidden={reportsShown}>
            <button
              className="workflow-search-trigger"
              aria-label="Search or run a command"
              title="Search steps and outputs, or run a command · Ctrl+K"
              onClick={() => setPaletteOpen(true)}
            >
              <Search size={14} />
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="secondary-button workflow-import-button"
              aria-label="Import CSV"
              title="Import CSV recordings"
              disabled={engine.busy || !engine.ready}
              onClick={() => file.current?.click()}
            >
              <ArrowDownToLine size={14} />
              <span>Import</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="secondary-button workflow-import-more"
                    aria-label="Workflow and batch options"
                    title="Run a workflow on many recordings"
                    disabled={engine.busy || !engine.ready}
                  />
                }
              >
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="workflow-scope-popup">
                <DropdownMenuItem onClick={() => void openRunDialog()}>
                  <Play size={14} /> Run a workflow on recordings…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => workflowInput.current?.click()}
                >
                  <FolderOpen size={14} /> Open a workflow file…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!project.sources.length}
                  onClick={() => setSaveOpen(true)}
                >
                  <Save size={14} /> Save a recording&apos;s workflow…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={openBatchExample}>
                  <ListChecks size={14} /> Try the batch example (8 motors)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <WorkflowStorage
              disabled={engine.busy || !engine.ready}
              recordings={project.sources.length}
              request={request}
              restore={(file) =>
                manage(
                  { type: 'restore-workspace', file },
                  'Workspace restored.',
                )
              }
              cancel={engine.cancel}
              example={openExample}
              exampleName={source?.synthetic ? source.name : undefined}
              onSaveWorkflow={() => setSaveOpen(true)}
              onOpenWorkflow={(chosen) => void openWorkflowFile(chosen)}
              onBatchExample={openBatchExample}
            />
          </div>
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            title="Switch between light and dark themes"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            className="workflow-icon-button workflow-quiet"
            aria-label="Workflow guide"
            title="Guide and shortcuts"
            onClick={() => setHelp(true)}
          >
            <HelpCircle size={16} />
          </button>
          <button
            className="workflow-icon-button workflow-quiet workflow-inspector-toggle"
            aria-label="Toggle inspector"
            aria-expanded={inspectorShown}
            aria-controls="workflow-inspector"
            title="Show or hide the inspector"
            hidden={reportsShown}
            onClick={toggleInspector}
          >
            <PanelRight size={16} />
          </button>
        </div>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          multiple
          className="sr-only"
          aria-label="Import CSV recording"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = '';
            importFiles(selected);
          }}
        />
        <input
          ref={workflowInput}
          type="file"
          accept=".yaml,.yml,application/yaml"
          className="sr-only"
          aria-label="Open workflow file"
          onChange={(event) => {
            const chosenFile = event.target.files?.[0];
            event.target.value = '';
            if (chosenFile) void openWorkflowFile(chosenFile);
          }}
        />
      </header>
      <div
        id="workflow-data-workspace"
        className="workflow-body"
        hidden={reportsShown}
      >
        <aside
          id="workflow-navigation"
          className="workflow-sidebar"
          aria-label="Operation history"
          data-open={historyOpen}
        >
          <div className="workflow-sidebar-heading">
            <strong>History</strong>
            <small title="Chronological order · oldest first">
              {steps.length} {steps.length === 1 ? 'step' : 'steps'} · oldest
              first
            </small>
          </div>
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
              title="Show only operations with failed or warning checks"
              onClick={() => setFlaggedOnly((on) => !on)}
            >
              <AlertTriangle size={11} /> Flagged
            </button>
          </fieldset>
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
            onDragSelection={setDragged}
            steps={shownSteps}
            index={index}
            query={query}
            outputKind={outputFilter}
            selection={selection}
            lineageOutputs={selectedLineage.outputIds}
            busy={engine.busy}
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
          <p className="workflow-rail-hint">
            <i /> Contributes to the selection · drag outputs onto a plot or
            command
          </p>
        </aside>
        <WorkflowPaneResizer pane="history" />
        <div className="workflow-document">
          <main className="workflow-main" data-batch-view={batchShown}>
            {!engine.ready ? (
              <div className="workflow-empty">
                {engine.error || 'Opening your workflow…'}
                {engine.error && (
                  <button
                    className="secondary-button"
                    onClick={() => location.reload()}
                  >
                    Reload workspace
                  </button>
                )}
              </div>
            ) : !source ? (
              <section className="workflow-empty-workspace">
                <Waves size={32} />
                <h1>Start a workflow</h1>
                <p>
                  Import a recording to plot signals, derive results and
                  calculate values. Your work is saved on this device.
                </p>
                <button
                  className="primary-button"
                  disabled={engine.busy}
                  onClick={() => file.current?.click()}
                >
                  Import CSV
                </button>
                <button
                  className="workflow-link"
                  disabled={engine.busy}
                  onClick={() => void openExample().catch(() => {})}
                >
                  Open example workflow
                </button>
                <p>
                  Explore a motor test: smooth and multiply signals, segment
                  runs and compare values.
                </p>
                {engine.error && <p role="alert">{engine.error}</p>}
              </section>
            ) : (
              <>
                {displayBatch && batchShown && (
                  <WorkflowBatchView
                    project={project}
                    batch={displayBatch}
                    progress={batchProgress}
                    busy={engine.busy || !!reportJob}
                    canReport={canReport(displayBatch)}
                    onOpen={(run) => openItem(run)}
                    onClose={() => setBatchPanel(false)}
                    onCancel={cancelBatch}
                    onExportSummary={() => exportSummary(project, displayBatch)}
                    onExportReports={(runs, mode) =>
                      void exportReports(project, displayBatch, runs, mode)
                    }
                    onPreviewReport={(run) =>
                      void previewReport(displayBatch, run)
                    }
                    onPlotAcross={(recipeStepId, runs) =>
                      plotAcross(displayBatch, recipeStepId, runs)
                    }
                    reportJob={reportJob}
                    onCancelReports={() => reportAbort.current?.abort()}
                  />
                )}
                {displayBatch && !batchPanel && (
                  <section className="workflow-item-bar" aria-label="Batch">
                    <ListChecks size={14} />
                    <span className="workflow-item-bar-name">
                      <strong>{displayBatch.name}</strong>
                      <small>
                        {displayBatch.runs.length}{' '}
                        {displayBatch.runs.length === 1 ? 'item' : 'items'} in
                        History
                      </small>
                    </span>
                    <span className="workflow-item-bar-problem" />
                    <button
                      className="secondary-button"
                      onClick={() => setBatchPanel(true)}
                    >
                      <ListChecks size={14} /> Batch results
                    </button>
                  </section>
                )}
                {itemRun && itemInfo && (
                  <WorkflowItemBar
                    batch={itemRun.batch}
                    run={itemRun.run}
                    itemLabel={itemInfo.label}
                    status={itemInfo.status}
                    problems={itemInfo.problems}
                    edited={itemInfo.edited}
                    onStep={stepItem}
                    onBatch={() => switchSource(`batch:${itemRun.batch.id}`)}
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
                      <WorkflowDock
                        tab={dockTab}
                        onTab={setDockTab}
                        open={dockOpen}
                        onOpen={setDockOpen}
                        outputCount={stepOutputs.length}
                        context={
                          dockTab === 'samples' && dockSampleId
                            ? `Exact samples · ${index.label(dockSampleId)}`
                            : `${reference(step)} ${stepName(step)}`
                        }
                      >
                        {dockTab === 'outputs' ? (
                          <section className="workflow-output-panel">
                            <div className="workflow-panel-heading">
                              <div>
                                <strong>
                                  {stepOutputs.length}{' '}
                                  {allValues ? 'values' : 'signals'} ·{' '}
                                  {reference(step)} {stepName(step)}
                                </strong>
                              </div>
                              <div className="workflow-panel-actions">
                                <button
                                  className="secondary-button"
                                  disabled={engine.busy || !stepOutputs.length}
                                  onClick={() => setExportOpen(true)}
                                >
                                  <ArrowDownToLine size={15} /> Export / report
                                </button>
                                <button
                                  className="secondary-button"
                                  disabled={
                                    engine.busy ||
                                    !engine.ready ||
                                    !stepOutputs.length
                                  }
                                  title="Add this operation's outputs to Reports"
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
                                    disabled={engine.busy}
                                    onClick={() => repeat()}
                                  >
                                    {step.kind === 'regions'
                                      ? 'Create signal segments'
                                      : 'Repeat with new settings'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {step.kind === 'regions' ? (
                              <div className="workflow-saved-ranges">
                                {project.regionSets
                                  ?.find((set) => set.id === step.regionSetId)
                                  ?.regions.slice(0, 30)
                                  .map((region) => (
                                    <span key={region.id}>
                                      {region.name}: {number(region.start)}–
                                      {number(region.end)} s
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
                                  {!allValues && (
                                    <>
                                      <button
                                        className="workflow-link"
                                        onClick={() =>
                                          setInputs(
                                            filteredOutputs.filter((id) =>
                                              index.nodes.has(id),
                                            ),
                                          )
                                        }
                                      >
                                        Select all {filteredOutputs.length}
                                        {tableQuery ? ' matching' : ''} signals
                                      </button>
                                      <button
                                        className="workflow-link"
                                        disabled={!inputIds.length}
                                        onClick={() => setInputs([])}
                                      >
                                        Clear selection
                                      </button>
                                    </>
                                  )}
                                </div>
                                <Table className="workflow-output-table">
                                  <TableHeader>
                                    <TableRow>
                                      {!allValues && (
                                        <TableHead className="workflow-check-cell">
                                          Use
                                        </TableHead>
                                      )}
                                      <TableHead>
                                        {allValues ? 'Value' : 'Signal'}
                                      </TableHead>
                                      <TableHead>Type</TableHead>
                                      <TableHead>Input</TableHead>
                                      <TableHead>
                                        {allValues
                                          ? 'Result'
                                          : 'Time interval (s)'}
                                      </TableHead>
                                      <TableHead>Unit</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {outputPage.map((id) => {
                                      const node = index.nodes.get(id),
                                        value = index.values.get(id);
                                      const parent =
                                        node?.parents[0] ?? value?.inputId;
                                      const bounds =
                                        node && graph.ranges.get(node.id);
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
                                          onDoubleClick={() =>
                                            select({ kind: 'output', id })
                                          }
                                          data-state={
                                            selection.kind === 'output' &&
                                            selection.id === id
                                              ? 'selected'
                                              : undefined
                                          }
                                        >
                                          {!allValues && (
                                            <TableCell>
                                              <Checkbox
                                                aria-label={`Use ${index.label(id)} as input`}
                                                checked={inputIds.includes(id)}
                                                onCheckedChange={(checked) =>
                                                  setInputs(
                                                    checked
                                                      ? [
                                                          ...new Set([
                                                            ...inputIds,
                                                            id,
                                                          ]),
                                                        ]
                                                      : inputIds.filter(
                                                          (input) =>
                                                            input !== id,
                                                        ),
                                                  )
                                                }
                                              />
                                            </TableCell>
                                          )}
                                          <TableCell>
                                            <button
                                              className="workflow-output-name"
                                              title={index.label(id)}
                                              onClick={() =>
                                                select({ kind: 'output', id })
                                              }
                                            >
                                              {index.label(id)}
                                            </button>
                                          </TableCell>
                                          <TableCell>
                                            <span
                                              className="workflow-type"
                                              data-type={
                                                value
                                                  ? 'value'
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
                                                {reference(
                                                  index.owner.get(parent),
                                                )}{' '}
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
                                            {node?.unit ?? value?.unit}
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                                {!filteredOutputs.length && (
                                  <p className="workflow-empty">
                                    No matching outputs in this step.
                                  </p>
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
                        ) : dockTab === 'samples' ? (
                          <section className="workflow-dock-samples">
                            {sampleChoices.length > 1 && (
                              <RegionSelect
                                label="Signal"
                                value={dockSampleId}
                                items={sampleChoices.map((id) => ({
                                  value: id,
                                  label: index.label(id),
                                }))}
                                onChange={setSampleChoice}
                              />
                            )}
                            {dockSampleId ? (
                              <SignalSamples
                                key={dockSampleId}
                                id={dockSampleId}
                                project={project}
                                unit={index.nodes.get(dockSampleId)?.unit ?? ''}
                                request={request}
                                onExport={() => setExportOpen(true)}
                                busy={engine.busy}
                              />
                            ) : (
                              <p className="workflow-empty">
                                This selection has no signal samples.
                              </p>
                            )}
                          </section>
                        ) : (
                          <section className="workflow-dock-settings">
                            <dl className="workflow-property-grid">
                              <div>
                                <dt>Operation</dt>
                                <dd>
                                  {reference(step)} {stepName(step)}
                                </dd>
                              </div>
                              {(step.kind === 'derive' ||
                                step.kind === 'value') && (
                                <div>
                                  <dt>Function</dt>
                                  <dd>
                                    {VALUE_FUNCTIONS.find(
                                      (spec) =>
                                        spec.operation === step.operation,
                                    )?.name ??
                                      SIGNAL_FUNCTIONS.find(
                                        (spec) =>
                                          spec.operation === step.operation,
                                      )?.name ??
                                      operationLabels[
                                        step.operation as Operation
                                      ] ??
                                      step.operation}
                                  </dd>
                                </div>
                              )}
                              <div>
                                <dt>Inputs</dt>
                                <dd>{step.inputIds.length.toLocaleString()}</dd>
                              </div>
                              <div>
                                <dt>Revision</dt>
                                <dd>{step.revision ?? 1}</dd>
                              </div>
                            </dl>
                            {step.parameters && (
                              <section className="workflow-settings">
                                <h3>Parameters</h3>
                                <dl>
                                  {Object.entries(step.parameters).map(
                                    ([key, value]) => (
                                      <div key={key}>
                                        <dt>
                                          {key === 'value'
                                            ? SIGNAL_FUNCTIONS.find(
                                                (spec) =>
                                                  spec.operation ===
                                                  step.operation,
                                              )?.parameter || 'Parameter'
                                            : key}
                                        </dt>
                                        <dd>{value}</dd>
                                      </div>
                                    ),
                                  )}
                                </dl>
                              </section>
                            )}
                            {step.definition && (
                              <section className="workflow-settings">
                                <h3>Segmentation</h3>
                                <pre>
                                  {JSON.stringify(
                                    step.definition,
                                    (key, value: unknown) =>
                                      key === 'signalId' &&
                                      typeof value === 'string'
                                        ? `${reference(index.owner.get(value))} ${index.label(value)}`
                                        : value,
                                    2,
                                  )}
                                </pre>
                              </section>
                            )}

                            {step.kind === 'import' ? (
                              <p className="workflow-muted">
                                Original recordings are immutable. Import the
                                file again to add another recording.
                              </p>
                            ) : (
                              <div className="workflow-panel-actions">
                                {step.kind !== 'regions' && (
                                  <button
                                    className="secondary-button"
                                    disabled={engine.busy}
                                    onClick={() => repeat(true)}
                                  >
                                    Edit settings
                                  </button>
                                )}
                                <button
                                  className="secondary-button"
                                  disabled={engine.busy}
                                  onClick={() => repeat()}
                                >
                                  {step.kind === 'regions'
                                    ? 'Create signal segments'
                                    : 'Repeat with new settings'}
                                </button>
                              </div>
                            )}
                          </section>
                        )}
                      </WorkflowDock>
                    )
                  }
                />
                {engine.error && (
                  <div className="workflow-error" role="alert">
                    {engine.error}
                    <button
                      className="workflow-link"
                      onClick={() => location.reload()}
                    >
                      Reload workspace
                    </button>
                    <button
                      aria-label="Dismiss error"
                      onClick={() => engine.setError('')}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
        {engine.ready && step && (
          <>
            <WorkflowPaneResizer pane="inspector" />
            <aside
              id="workflow-inspector"
              className="workflow-inspector"
              aria-label="Inspector"
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
      <footer className="workflow-status" hidden={reportsShown}>
        <span className="workflow-status-selection" title={title}>
          {title}
        </span>
        <output
          className={notice ? 'workflow-notice' : undefined}
          aria-live="polite"
        >
          {dragged
            ? `Dragging ${dragged.kind === 'step' ? stepName(index.steps.get(dragged.id)!) : index.label(dragged.id)} · drop on a plot or highlighted tool`
            : notice ||
              (engine.busy
                ? engine.status
                : activeNode
                  ? 'Ready'
                  : activeValue
                    ? 'Ready'
                    : `${stepOutputs.length} outputs`)}
          {notice && undoable && engine.canUndo && !engine.busy && (
            <button className="workflow-notice-undo" onClick={() => undo()}>
              Undo
            </button>
          )}
          {notice && (
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          )}
        </output>
        <span className="workflow-inventory">
          <span>
            <LockKeyhole size={12} />
            {originalCount} originals
          </span>
          <span>
            <Waves size={12} />
            {derivedCount} derived
          </span>
          <span>
            <Hash size={12} />
            {valueCount} values
          </span>
        </span>
        {engine.busy ? (
          <button onClick={engine.cancel}>Cancel operation</button>
        ) : (
          <span>
            <LockKeyhole size={12} /> Saved locally
          </span>
        )}
      </footer>
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
                ? 'Processing inputs'
                : detailPanel === 'used-by'
                  ? 'Used by later operations'
                  : 'Inputs and originals'}
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
              busy={engine.busy}
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
                            item.id ===
                            (activeNode?.sourceId ?? step?.sourceId),
                        )?.name
                      }{' '}
                      · original recording
                    </span>
                  )}
                  {immediateInputs.length > 4 && (
                    <WorkflowList
                      items={immediateInputs}
                      summary={`All ${immediateInputs.length} inputs`}
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
                    summary={`Trace to originals · ${selectedLineage.steps.length} steps`}
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
                              <span>{ancestor.outputIds.length} outputs</span>
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
                              ...(step?.inputIds ?? []),
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
                    summary={`Used by ${usedBy.length} later operation${usedBy.length === 1 ? '' : 's'}`}
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
              {!usedBy.length && <p>No later operations use this output.</p>}
            </>
          )}
          {detailPanel === 'checked' && (
            <>
              <WorkflowList
                items={processingIds}
                initialOpen
                summary={`${processingIds.length} input signals`}
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
                            setInputs(
                              processingIds.filter((item) => item !== id),
                            )
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
                  disabled={engine.busy || !processingIds.length}
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
      {managementRequest && (
        <WorkflowManagementDialogs
          project={project}
          request={managementRequest}
          busy={engine.busy}
          onClose={() => setManagementRequest(undefined)}
          onDelete={(stepId) =>
            manage(
              { type: 'delete-operation', stepId },
              'Operation removed. Undo is available.',
            )
          }
          onRename={(id, name) =>
            manage({ type: 'rename', id, name }, 'Name saved.')
          }
        />
      )}
      <WorkflowCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={paletteCommands}
        targets={paletteTargets}
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
        onSaved={(filename) => setNotice(`Download prepared: ${filename}`)}
      />
      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!open && !engine.busy) setEditor(undefined);
        }}
      >
        <DialogContent
          key={editorVersion}
          className={`workflow-dialog${editor?.kind === 'segment' ? ' workflow-range-dialog' : ''}`}
          showCloseButton={!engine.busy}
        >
          <DialogTitle>
            {editor?.editingStepId
              ? 'Edit operation settings'
              : editor?.kind === 'derive'
                ? 'New derived signal'
                : editor?.kind === 'segment'
                  ? 'Segment signals'
                  : 'Calculate values'}
          </DialogTitle>
          <DialogDescription>
            {editorOpen &&
            editor?.editingStepId &&
            index.steps.has(editor.editingStepId)
              ? `Saving replaces this operation and recalculates ${affectedOperations(project, editor.editingStepId).length - 1} dependent operations. Originals stay unchanged. Undo restores the previous version. Changes that cannot safely rebuild every dependent result are rejected.`
              : editor?.kind === 'segment'
                ? 'Create signal segments using triggers, ranges or windows.'
                : editor?.kind === 'value'
                  ? 'Reduce each input signal to a scalar value.'
                  : 'Apply a function to each input signal.'}
          </DialogDescription>
          {dropNote && <p className="workflow-drop-note">{dropNote}</p>}
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
              <WorkflowList
                className="workflow-editor-inputs"
                items={editor.ids}
                summary={`${editor.ids.length} input signal${editor.ids.length === 1 ? '' : 's'} · review selection`}
              >
                {(visible) => (
                  <ul>
                    {visible.map((id) => (
                      <li key={id}>
                        {reference(index.owner.get(id))} {index.label(id)}
                      </li>
                    ))}
                  </ul>
                )}
              </WorkflowList>
              {editor.kind === 'segment' ? (
                <SegmentationEditor
                  workflowMode
                  rangePlot={{ graph, request }}
                  signalLabel={(id) => index.label(id)}
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
                    (node) => node.sourceId === editorSource.id,
                  )}
                  segments={project.segments}
                  selectedIds={editor.ids}
                  selectionKind="collection"
                  savedOperation={editor.savedSegment}
                  busy={engine.busy}
                  onPreview={async (
                    definition,
                    targetIds,
                    independently,
                    scope,
                  ) => {
                    const response = await engine.preview({
                      type: 'segment-preview',
                      sourceId: editorSource.id,
                      definition,
                      targetIds,
                      independently,
                      scope,
                    });
                    if (response.type !== 'segment-plan')
                      throw new Error('Unexpected preview response.');
                    return response.plan;
                  }}
                  onCreate={(definition, targetIds, independently, scope) =>
                    perform(
                      {
                        type: 'segment',
                        sourceId: editorSource.id,
                        definition,
                        targetIds,
                        independently,
                        scope,
                      },
                      'Creating derived segment signals…',
                    )
                  }
                />
              ) : (
                <FunctionEditor
                  editor={editor}
                  project={project}
                  index={index}
                  busy={engine.busy}
                  onApply={(operation, parameter, secondaryId) => {
                    if (editor.kind === 'value')
                      return perform(
                        {
                          type: 'calculate-values',
                          inputIds: editor.ids,
                          operation: operation as ValueOperation,
                        },
                        'Calculating values…',
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
                          },
                        },
                        'Creating derived signals…',
                      );
                    return perform(
                      {
                        type: 'derive-many',
                        parentIds: editor.ids,
                        operation: operation as Operation,
                        parameter,
                      },
                      'Creating derived signals…',
                    );
                  }}
                />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {timeEditor && (
        <TimeWorkbench
          project={project}
          initialIds={timeEditor.ids}
          inputNote={dropNote}
          saved={timeEditor.saved}
          initialMode={timeEditor.mode}
          editing={!!timeEditor.editingId}
          busy={engine.busy}
          request={request}
          onCancel={engine.cancel}
          onClose={() => {
            setTimeEditor(undefined);
            setDropNote('');
          }}
          onApply={async (settings) => {
            const editingId = timeEditor.editingId;
            const next = await engine.mutate(
              editingId
                ? {
                    type: 'edit-operation',
                    stepId: editingId,
                    command: { type: 'time-operation', settings },
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
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="workflow-dialog">
          <DialogTitle>Build a signal workflow</DialogTitle>
          <DialogDescription>
            Every operation records its inputs and creates new outputs.
          </DialogDescription>
          <ol className="workflow-guide">
            <li>
              <strong>Start with an original.</strong> Import a CSV, or use the
              included synthetic recording. Originals are locked.
            </li>
            <li>
              <strong>Derive or segment.</strong> Select a signal, then choose
              an operation. Every segment is a derived signal, ready for further
              processing or segmentation.
            </li>
            <li>
              <strong>Calculate a value.</strong> Minimum, maximum and averages
              create scalar results. A time average weights by elapsed time; a
              sample average weights each sample equally.
            </li>
            <li>
              <strong>Follow the history.</strong> Numbered steps stay oldest
              first, coloured by kind. Filter with the search field and the All,
              Signals and Values chips; a dot marks outputs that feed the
              selection. Arrow keys navigate the tree, Enter selects.
            </li>
            <li>
              <strong>Find the origin.</strong> The inspector on the right shows
              properties, the lineage back to the original recordings and the
              operations that use the selection, with Edit, Duplicate and
              Delete. Right-click a History item for the same actions.
            </li>
            <li>
              <strong>Choose what to process.</strong> Apply to, beside the
              operations, shows their inputs: the item in view, or signals you
              check in the operation outputs. Checked inputs stay selected while
              you explore; clear them to follow the selection again.
            </li>
            <li>
              <strong>Build a plot.</strong> Drag a signal onto the canvas or a
              named plot tab. Drag a segment to compare every segment from its
              operation; use Δt to align their starts at zero. Values become
              reference lines. Drops on processing tools select the dragged
              member or batch; values use their input signals.
            </li>
            <li>
              <strong>Take your results with you.</strong> Export / report
              offers samples, signal summaries, calculated values and a
              printable report. Choose the viewed output, checked signals or an
              entire step before downloading.
            </li>
            <li>
              <strong>Compose a report.</strong> Choose Reports in the top bar
              for a page canvas with your signals, values and saved plots. Add
              the viewed item with Report, from a History item&apos;s menu or
              from a plot. Captures are snapshots; switching to Data Inspector
              keeps your draft until the app reloads. Format the pages and
              export a PDF.
            </li>
            <li>
              <strong>Try another version.</strong> Repeat with new settings
              appends another operation. Earlier outputs and their descendants
              keep their original recipes. Ctrl+Z and Ctrl+Y undo and redo
              changes, also after a restart.
            </li>
          </ol>
        </DialogContent>
      </Dialog>
    </div>
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

function FunctionEditor({
  editor,
  project,
  index,
  busy,
  onApply,
}: {
  editor: Editor;
  project: Project;
  index: WorkflowIndex;
  busy: boolean;
  onApply: (
    operation: Operation | ValueOperation,
    parameter: number,
    secondaryId: string,
  ) => Promise<void>;
}) {
  const [operation, setOperation] = useState<string>(
    editor.operation ?? (editor.kind === 'value' ? 'time-average' : 'multiply'),
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
  const [error, setError] = useState('');
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
      unitError =
        caught instanceof Error ? caught.message : 'Incompatible units.';
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
  return (
    <fieldset className="workflow-function-editor" disabled={busy}>
      {editor.kind === 'value' ? (
        <ValueOperationPalette
          value={operation}
          disabled={busy}
          onChange={changeOperation}
        />
      ) : (
        <SignalOperationPalette
          value={operation}
          disabled={busy}
          onChange={changeOperation}
        />
      )}
      <div className="signal-operation-settings">
        {editor.kind === 'derive' ? (
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
              {editor.ids.length} {editor.ids.length === 1 ? 'value' : 'values'}
            </span>
          </div>
        )}
        <p>
          {editor.kind === 'value'
            ? valueSpec?.description
            : binary && !isArithmetic(operation)
              ? operation === 'power'
                ? 'Selected inputs must be torque [Nm]. Choose one speed [rpm] signal on the same sample grid.'
                : 'Selected inputs must be fuel flow [kg/h]. Choose one power [kW] signal on the same sample grid.'
              : spec?.description}
        </p>
        {editor.kind === 'value' && (
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
          <RegionNumber
            label={spec.parameter}
            value={parameter}
            unit={spec.unit}
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
      {error && (
        <p className="segment-error" role="alert">
          {error}
        </p>
      )}
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
            } catch (error) {
              setError(
                error instanceof Error ? error.message : 'Operation failed.',
              );
            }
          })();
        }}
      >
        {editor.kind === 'value' ? <Hash size={15} /> : <Waves size={15} />}
        {editor.editingStepId
          ? 'Save changes and recalculate'
          : editor.kind === 'value'
            ? `Create ${editor.ids.length} value${editor.ids.length === 1 ? '' : 's'}`
            : `Create ${editor.ids.length} derived signal${editor.ids.length === 1 ? '' : 's'}`}
      </button>
    </fieldset>
  );
}
