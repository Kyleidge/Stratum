'use client';
import type { RefObject } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  HelpCircle,
  ListChecks,
  Moon,
  PanelLeft,
  PanelRight,
  Play,
  Redo2,
  Save,
  Search,
  Sun,
  Undo2,
  Waves,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { formatCount } from '@/lib/format-count';
import { RECORDING_ACCEPT } from '@/lib/formats/index';
import type { ReportWorkspace } from '@/lib/report-integration';
import type { EngineRequest, Project, Source } from '@/lib/signal-types';
import type { Theme } from '@/lib/theme';
import { liveRunStatus } from '@/lib/workflow-checks';
import { WORKFLOW_DRAG_TYPE, type WorkflowTarget } from '@/lib/workflow-drag';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowBatch } from '@/lib/workflow-types';
import { StatusIcon } from './workflow-batch-view';
import type { WorkflowSelection } from './workflow-history';
import WorkflowStorage from './workflow-storage';
import WorkflowToolbar, { type ToolbarAction } from './workflow-toolbar';

/**
 * The one top bar: History and Details toggles, the Data | Reports switch,
 * the recording scope, Undo/Redo, the operations with their Apply to scope,
 * search, Import and its workflow menu, Workspace, theme and guide.
 */
export default function WorkflowTopbar({
  project,
  index,
  engine,
  theme,
  setTheme,
  source,
  sourceId,
  scopeBatch,
  allScope,
  batches,
  switchSource,
  selection,
  dragged,
  setDragged,
  processingIds,
  checked,
  hasPast,
  setInputs,
  handleAction,
  undo,
  redo,
  reportsShown,
  reportAdded,
  reportWorkspace,
  openDataInspector,
  openReports,
  addToReport,
  historyOpen,
  setHistoryOpen,
  inspectorShown,
  toggleInspector,
  setPaletteOpen,
  setHelp,
  setSaveOpen,
  storageOpen,
  setStorageOpen,
  file,
  workflowInput,
  importFiles,
  openRunDialog,
  openWorkflowFile,
  openBatchExample,
  openExample,
  manage,
}: {
  project: Project;
  index: WorkflowIndex;
  engine: SignalEngineState;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** The recording in scope, or the first one. */
  source?: Source;
  sourceId: string;
  scopeBatch?: WorkflowBatch;
  allScope: boolean;
  batches: WorkflowBatch[];
  switchSource: (id: string) => void;
  selection: WorkflowSelection;
  dragged: WorkflowTarget | null;
  setDragged: (target: WorkflowTarget | null) => void;
  processingIds: string[];
  /** Whether the processing inputs are explicit checks. */
  checked: boolean;
  hasPast: boolean;
  setInputs: (ids: string[] | null) => void;
  handleAction: (action: ToolbarAction, dropped?: WorkflowTarget) => void;
  undo: () => void;
  redo: () => void;
  reportsShown: boolean;
  /** Snapshots added to the report since Reports was last opened. */
  reportAdded: number;
  reportWorkspace: ReportWorkspace;
  openDataInspector: () => void;
  openReports: () => void;
  addToReport: (ids: string[], open?: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (update: (open: boolean) => boolean) => void;
  inspectorShown: boolean;
  toggleInspector: () => void;
  setPaletteOpen: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  setSaveOpen: (open: boolean) => void;
  storageOpen: boolean;
  setStorageOpen: (open: boolean) => void;
  file: RefObject<HTMLInputElement | null>;
  workflowInput: RefObject<HTMLInputElement | null>;
  importFiles: (selected: File[]) => void;
  openRunDialog: () => Promise<void>;
  openWorkflowFile: (file: File) => Promise<void>;
  openBatchExample: () => void;
  openExample: (refresh?: boolean) => Promise<void>;
  manage: (
    message: EngineRequest,
    label: string,
    transfer?: Transferable[],
  ) => Promise<void>;
}) {
  const runStatuses = new Map(
    batches.flatMap((batch) =>
      batch.runs.map(
        (run) => [run.sourceId, liveRunStatus(run, index.steps)] as const,
      ),
    ),
  );
  return (
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
          title="Data Inspector: signals, steps and plots"
          aria-current={reportsShown ? undefined : 'page'}
          aria-controls="workflow-data-workspace"
          onClick={openDataInspector}
        >
          <Waves />
          <span>Data</span>
        </button>
        <button
          type="button"
          aria-label={
            reportAdded
              ? `Reports, ${formatCount(reportAdded, 'new snapshot')}`
              : 'Reports'
          }
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
              true,
            );
          }}
        >
          <FileText />
          <span>Reports</span>
          {!!reportAdded && (
            <span className="workflow-workspace-badge" aria-hidden>
              {reportAdded > 99 ? '99+' : reportAdded}
            </span>
          )}
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
            <DropdownMenuContent className="workflow-scope-popup" align="start">
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
          title={
            engine.undoLabel
              ? `Undo: ${engine.undoLabel} · Ctrl+Z`
              : 'Undo last change · Ctrl+Z (kept across restarts)'
          }
          disabled={!engine.canUndo || engine.busy}
          onClick={() => undo()}
        >
          <Undo2 size={16} />
        </button>
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label="Redo last change"
          title={
            engine.redoLabel
              ? `Redo: ${engine.redoLabel} · Ctrl+Y`
              : 'Redo last change · Ctrl+Y'
          }
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
          checked={checked}
          hasPast={hasPast}
          busy={engine.busy || !engine.ready}
          empty={!project.sources.length}
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
            aria-label="Import recordings"
            title="Import recordings: CSV, MDF, TDMS, MAT, WAV or Excel"
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
                  aria-label="More import options"
                  title="Workflows: run one on many recordings, open or save one"
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
              <DropdownMenuItem onClick={() => workflowInput.current?.click()}>
                <FolderOpen size={14} /> Open a workflow file…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!project.sources.length}
                onClick={() => setSaveOpen(true)}
              >
                <Save size={14} /> Save this recording&apos;s workflow…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openBatchExample}>
                <ListChecks size={14} /> Try the batch example (8 motors)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <WorkflowStorage
            open={storageOpen}
            onOpenChange={setStorageOpen}
            disabled={engine.busy || !engine.ready}
            recordings={project.sources.length}
            request={engine.request}
            restore={(file, transfer) =>
              manage(
                { type: 'restore-workspace', file },
                'Workspace restored.',
                transfer,
              )
            }
            cancel={engine.cancel}
            example={openExample}
            exampleName={source?.synthetic ? source.name : undefined}
            onOpenWorkflow={(chosen) => void openWorkflowFile(chosen)}
          />
        </div>
        <button
          className="workflow-icon-button workflow-quiet workflow-theme-toggle"
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
          aria-label="Toggle Details"
          aria-expanded={inspectorShown}
          aria-controls="workflow-inspector"
          title="Show or hide Details"
          hidden={reportsShown}
          onClick={toggleInspector}
        >
          <PanelRight size={16} />
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept={RECORDING_ACCEPT}
        multiple
        className="sr-only"
        aria-label="Import recordings"
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
  );
}
