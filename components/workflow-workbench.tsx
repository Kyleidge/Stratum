'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  GitBranch,
  Hash,
  HelpCircle,
  LockKeyhole,
  PanelLeft,
  Search,
  Scissors,
  Waves,
  X,
  Undo2,
  Redo2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  Plot,
  Point,
  Project,
  SegmentationOperation,
} from '@/lib/signal-types';
import { segmentationOperation } from '@/lib/segmentation-operation';
import WorkflowHistory, { type WorkflowSelection } from './workflow-history';
import SignalChart, { formatValue } from './signal-chart';
import SegmentationEditor from './segmentation-editor';
import { RegionSelect, RegionNumber, finite } from './region-controls';
import WorkflowExport from './workflow-export';
import WorkflowManagement, {
  WorkflowManagementDialogs,
  type WorkflowManagementAction,
  type WorkflowManagementRequest,
} from './workflow-management';
import WorkflowStorage from './workflow-storage';
import WorkflowList from './workflow-list';
import { affectedOperations } from '@/lib/workflow-lifecycle';
import type { WorkflowCommand } from '@/lib/workflow-lifecycle';

const PAGE_SIZE = 30;
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
  const steps = useMemo(
    () =>
      (project.workflowSteps ?? []).filter(
        (step) => sourceId === 'all' || step.sourceId === source?.id,
      ),
    [project, source?.id, sourceId],
  );
  const [chosen, setChosen] = useState<WorkflowSelection | null>(null);
  const selection =
    chosen &&
    (sourceId === 'all'
      ? chosen.kind === 'step'
        ? index.steps.has(chosen.id)
        : index.nodes.has(chosen.id) || index.values.has(chosen.id)
      : (chosen.kind === 'step'
          ? index.steps.get(chosen.id)?.sourceId
          : (index.nodes.get(chosen.id)?.sourceId ??
            index.values.get(chosen.id)?.sourceId)) === source?.id)
      ? chosen
      : { kind: 'output' as const, id: source?.channels[0] ?? '' };
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
  const [past, setPast] = useState<WorkflowSelection[]>([]);
  const [view, setView] = useState('result');
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState(''),
    [sidebar, setSidebar] = useState('history');
  const [lineageRoot, setLineageRoot] = useState<string[] | null>(null);
  const lineage = useMemo(
    () => index.lineage(lineageRoot ?? []),
    [index, lineageRoot],
  );
  const lineageSteps = useMemo(
    () => new Set(lineage.steps.map((step) => step.id)),
    [lineage],
  );
  const shownSteps = lineageRoot
    ? steps.filter((item) => lineageSteps.has(item.id))
    : steps;
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
    setEditorOpen(!!next);
  }
  const [help, setHelp] = useState(false),
    [notice, setNotice] = useState('');
  const [tableQuery, setTableQuery] = useState(''),
    [page, setPage] = useState(0);
  const [catalogKind, setCatalogKind] = useState('all'),
    [catalogPage, setCatalogPage] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!engine.ready || !toolbar.current) return;
    const element = toolbar.current;
    const observer = new ResizeObserver(() =>
      main.current?.style.setProperty(
        '--workflow-toolbar-height',
        `${element.clientHeight + 16}px`,
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [engine.ready]);
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
  const catalog = useMemo(
    () =>
      steps
        .flatMap((item) => item.outputIds)
        .filter((id) => {
          const kind = index.kind(id);
          return (
            (catalogKind === 'all' || kind === catalogKind) &&
            `${index.label(id)} ${reference(index.owner.get(id))} ${index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? ''}`
              .toLowerCase()
              .includes(query.toLowerCase())
          );
        }),
    [steps, index, catalogKind, query],
  );
  const safeCatalogPage = Math.min(
    catalogPage,
    Math.max(0, Math.ceil(catalog.length / PAGE_SIZE) - 1),
  );
  const [plotState, setPlotState] = useState<{
    id: string;
    plot?: Plot;
    error?: string;
  }>();
  const plotId = activeNode?.id ?? activeValue?.inputId ?? '';
  const request = engine.request;
  useEffect(() => {
    if (!engine.ready || !plotId) return;
    let alive = true;
    void request({ type: 'view', ids: [plotId], inspection: true })
      .then((response) => {
        if (alive && response.type === 'plots')
          setPlotState({ id: plotId, plot: response.plots[0] });
      })
      .catch((error: Error) => {
        if (alive) setPlotState({ id: plotId, error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [request, engine.ready, plotId, project]);
  const plot = plotState?.id === plotId ? plotState.plot : undefined;
  const [showSamples, setShowSamples] = useState(false),
    [samplePage, setSamplePage] = useState(0);
  const [samples, setSamples] = useState<{
    id: string;
    page: number;
    rows: Point[];
    more: boolean;
  }>();
  useEffect(() => {
    if (!showSamples || !plotId) return;
    let alive = true;
    void request({
      type: 'rows',
      id: plotId,
      offset: samplePage * 100,
      inspection: true,
    })
      .then((response) => {
        if (alive && response.type === 'rows')
          setSamples({
            id: plotId,
            page: samplePage,
            rows: response.rows,
            more: response.hasMore,
          });
      })
      .catch((error: Error) => {
        if (alive) setPlotState({ id: plotId, error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [showSamples, plotId, samplePage, request, project]);

  function select(next: WorkflowSelection) {
    if (next.id !== selection.id || next.kind !== selection.kind)
      setPast((old) => [...old.slice(-99), selection]);
    setChosen(next);
    // Inspection never replaces an explicitly checked input collection.
    setView(next.kind === 'step' ? 'outputs' : 'result');
    setNotice('');
    setTableQuery('');
    setPage(0);
    setSamplePage(0);
    const owner =
      next.kind === 'output'
        ? index.owner.get(next.id)
        : index.steps.get(next.id);
    if (next.kind === 'output' && owner)
      setPage(Math.floor(owner.outputIds.indexOf(next.id) / PAGE_SIZE));
  }
  function follow(id: string) {
    if (
      (index.nodes.get(id)?.sourceId ?? index.values.get(id)?.sourceId) !==
      source?.id
    )
      setSourceId('all');
    setQuery('');
    setSidebar('history');
    setLineageRoot(null);
    select({ kind: 'output', id });
  }
  function selectStep(id: string) {
    if (index.steps.get(id)?.sourceId !== source?.id) setSourceId('all');
    setQuery('');
    setSidebar('history');
    setLineageRoot(null);
    select({ kind: 'step', id });
  }
  function switchSource(id: string) {
    setSourceId(id);
    setChosen(null);
    setView('result');
    setNotice('');
    setPast([]);
    setQuery('');
    setTableQuery('');
    setPage(0);
    setLineageRoot(null);
    setSamplePage(0);
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
    setSidebar('history');
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
    setNotice(
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
      setNotice(
        'Operation updated and dependent results recalculated. Undo restores the earlier version.',
      );
      return;
    }
    reveal(await engine.mutate(message, label));
  }
  async function manage(message: EngineRequest, label: string) {
    await engine.mutate(message, label);
    if (message.type === 'rename') {
      setNotice(label);
      return;
    }
    setInputs(null);
    setQuery('');
    setTableQuery('');
    setLineageRoot(null);
    setPast([]);
    setPage(0);
    setNotice(label);
    setChosen(null);
    setView('result');
  }
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
  const selectedLineage = index.lineage(
    selection.kind === 'output' ? [selection.id] : (step?.inputIds ?? []),
  );
  const immediateInputs =
    selection.kind === 'output'
      ? index.inputs(selection.id)
      : (step?.inputIds ?? []);
  const usedBy =
    selection.kind === 'output'
      ? (index.consumers.get(selection.id) ?? [])
      : [];
  const title =
    selection.kind === 'output'
      ? index.label(selection.id)
      : step
        ? stepName(step)
        : 'Your workflow';
  const allValues = step?.kind === 'value';
  const originalCount =
    sourceId === 'all'
      ? project.sources.reduce((sum, item) => sum + item.channels.length, 0)
      : (source?.channels.length ?? 0);
  const derivedCount = project.nodes.filter(
    (node) =>
      (sourceId === 'all' || node.sourceId === source?.id) &&
      node.operation !== 'raw',
  ).length;
  const valueCount = (project.values ?? []).filter(
    (value) => sourceId === 'all' || value.sourceId === source?.id,
  ).length;
  return (
    <div className="workflow-app">
      <header className="workflow-header">
        <button
          className="workflow-icon-button workflow-history-toggle"
          aria-label="Toggle operation history"
          aria-expanded={historyOpen}
          aria-controls="workflow-navigation"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <PanelLeft size={18} />
          History
        </button>
        <div className="workflow-brand">
          <Waves size={23} />
          <strong>
            Stratus<span>.</span>
          </strong>
          <span>Workflow</span>
        </div>
        {source && (
          <RegionSelect
            label="Recording"
            value={sourceId === 'all' ? 'all' : source.id}
            items={[
              { value: 'all', label: 'All recordings & workspace results' },
              ...project.sources.map((item) => ({
                value: item.id,
                label: `${item.name}${item.synthetic ? ' · Example' : ''}`,
              })),
            ]}
            onChange={switchSource}
          />
        )}
        <div className="workflow-header-actions">
          <WorkflowStorage
            disabled={engine.busy || !engine.ready}
            recordings={project.sources.length}
            request={request}
            restore={(file) =>
              manage({ type: 'restore-workspace', file }, 'Workspace restored.')
            }
            cancel={engine.cancel}
            example={openExample}
            exampleName={source?.synthetic ? source.name : undefined}
          />
          <button
            className="workflow-icon-button"
            aria-label="Undo last change"
            title="Undo last change (kept across restarts)"
            disabled={!engine.canUndo || engine.busy}
            onClick={() =>
              void manage({ type: 'undo' }, 'Undid last change.').catch(
                () => {},
              )
            }
          >
            <Undo2 size={17} />
          </button>
          <button
            className="workflow-icon-button"
            aria-label="Redo last change"
            title="Redo last change"
            disabled={!engine.canRedo || engine.busy}
            onClick={() =>
              void manage({ type: 'redo' }, 'Redid last change.').catch(
                () => {},
              )
            }
          >
            <Redo2 size={17} />
          </button>
          <span className="workflow-local">
            <LockKeyhole size={14} /> Local workspace
          </span>
          <button
            className="secondary-button"
            disabled={engine.busy || !engine.ready}
            onClick={() => file.current?.click()}
          >
            <ArrowDownToLine size={15} />
            Import CSV
          </button>
          <button
            className="workflow-link workflow-guide-button"
            aria-label="Workflow guide"
            onClick={() => setHelp(true)}
          >
            <HelpCircle size={18} />
            Guide
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
            if (selected.length)
              void (async () => {
                for (const file of selected)
                  await perform(
                    { type: 'import', file },
                    `Importing ${file.name}…`,
                  );
                if (selected.length > 1) setSourceId('all');
              })().catch(() => {});
          }}
        />
      </header>
      <div className="workflow-body">
        <aside
          id="workflow-navigation"
          className="workflow-sidebar"
          data-open={historyOpen}
        >
          <div className="workflow-sidebar-heading">
            <div>
              <strong>Operation history</strong>
              <small>{steps.length} steps · oldest first</small>
            </div>
            <GitBranch size={18} />
          </div>
          <Tabs value={sidebar} onValueChange={setSidebar}>
            <TabsList className="workflow-tabs">
              <TabsTrigger value="history">History tree</TabsTrigger>
              <TabsTrigger value="signals">Signals & values</TabsTrigger>
            </TabsList>
          </Tabs>
          <label className="workflow-search">
            <Search size={15} />
            <input
              aria-label="Search workflow"
              placeholder="Find a signal, value or step…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCatalogPage(0);
              }}
            />
            {query && (
              <button
                aria-label="Clear workflow search"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
          {lineageRoot && sidebar === 'history' && (
            <div className="workflow-filter">
              <span title={lineageSubject}>
                Lineage of <strong>{lineageSubject}</strong>
              </span>
              <button onClick={() => setLineageRoot(null)}>
                Show all steps <X size={12} />
              </button>
            </div>
          )}
          {sidebar === 'history' ? (
            <WorkflowHistory
              steps={shownSteps}
              index={index}
              query={query}
              selection={selection}
              busy={engine.busy}
              onAction={manageSelection}
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
          ) : (
            <>
              <RegionSelect
                label="Output type"
                value={catalogKind}
                items={[
                  'all',
                  'Original signal',
                  'Derived signal',
                  'Value',
                ].map((kind) => ({
                  value: kind,
                  label: kind === 'all' ? 'All signals and values' : kind,
                }))}
                onChange={(kind) => {
                  setCatalogKind(kind);
                  setCatalogPage(0);
                }}
              />
              <div className="workflow-catalog">
                {catalog
                  .slice(
                    safeCatalogPage * PAGE_SIZE,
                    (safeCatalogPage + 1) * PAGE_SIZE,
                  )
                  .map((id) => (
                    <button
                      key={id}
                      className="workflow-catalog-item"
                      data-selected={
                        selection.kind === 'output' && selection.id === id
                      }
                      onClick={() => select({ kind: 'output', id })}
                      title={index.label(id)}
                    >
                      <span>
                        {index.values.has(id) ? (
                          <Hash size={15} />
                        ) : index.nodes.get(id)?.operation === 'raw' ? (
                          <LockKeyhole size={15} />
                        ) : (
                          <Waves size={15} />
                        )}
                      </span>
                      <span>
                        <strong>{index.label(id)}</strong>
                        <small>
                          {reference(index.owner.get(id))} · {index.kind(id)}
                        </small>
                      </span>
                    </button>
                  ))}
                {!catalog.length && (
                  <p className="workflow-empty">No matching outputs.</p>
                )}
              </div>
              <Pager
                page={safeCatalogPage}
                count={catalog.length}
                size={PAGE_SIZE}
                onPage={setCatalogPage}
              />
            </>
          )}
          <div className="workflow-inventory">
            <span>
              <LockKeyhole size={13} />
              {originalCount} originals
            </span>
            <span>
              <Waves size={13} />
              {derivedCount} derived
            </span>
            <span>
              <Hash size={13} />
              {valueCount} values
            </span>
          </div>
        </aside>
        <main className="workflow-main" ref={main}>
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
                Import a recording to plot signals, derive results and calculate
                values. Your work is saved on this device.
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
                Explore a motor test: smooth and multiply signals, segment runs
                and compare values.
              </p>
              {engine.error && <p role="alert">{engine.error}</p>}
            </section>
          ) : (
            <>
              {source.exampleKey === WORKFLOW_EXAMPLE && (
                <details
                  className="workflow-example"
                  aria-label="Example workflow"
                >
                  <summary>Explore the motor-test example</summary>
                  <div>
                    <strong>Example · Three motor test runs</strong>
                    <p>
                      Follow the history from original measurements to math, run
                      segments and calculated values.
                    </p>
                  </div>
                  <div className="workflow-example-links">
                    {[
                      {
                        name: 'Plot derived signal',
                        step: steps.find(
                          (item) =>
                            item.operation === 'multiply' ||
                            item.operation === 'power',
                        ),
                        output: true,
                      },
                      {
                        name: 'Compare run averages',
                        step: steps.find(
                          (item) => item.operation === 'time-average',
                        ),
                      },
                      {
                        name: 'Explore a segmented segment',
                        step: steps.filter(
                          (item) => item.kind === 'segment',
                        )[1],
                      },
                    ].map((item) => (
                      <button
                        key={item.name}
                        className="workflow-link"
                        disabled={!item.step}
                        onClick={() => {
                          setInputs(null);
                          if (item.step) {
                            if (item.output) follow(item.step.outputIds[0]);
                            else selectStep(item.step.id);
                          }
                        }}
                      >
                        {item.name} <ArrowRight size={13} />
                      </button>
                    ))}
                  </div>
                </details>
              )}
              <div className="workflow-detail-heading">
                <div className="workflow-heading-top">
                  <button
                    className="workflow-icon-button"
                    disabled={!past.length}
                    aria-label="Back to previous selection"
                    onClick={() => {
                      const next = past.at(-1);
                      if (next) {
                        setPast((old) => old.slice(0, -1));
                        setChosen(next);
                        setView(next.kind === 'output' ? 'result' : 'outputs');
                        setNotice('');
                        setQuery('');
                        setTableQuery('');
                        setLineageRoot(null);
                        setPage(0);
                      }
                    }}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <span
                    className="workflow-type"
                    data-type={
                      activeValue
                        ? 'value'
                        : activeNode?.operation === 'raw'
                          ? 'original'
                          : 'derived'
                    }
                  >
                    {selection.kind === 'output'
                      ? index.kind(selection.id)
                      : 'Operation'}
                  </span>
                  {step && (
                    <button
                      className="workflow-link"
                      onClick={() => selectStep(step.id)}
                    >
                      {reference(step)} · {stepName(step)}
                      {(step.revision ?? 1) > 1 && (
                        <span title={`Updated ${step.updatedAt ?? ''}`}>
                          {' '}
                          · revision {step.revision}
                        </span>
                      )}
                    </button>
                  )}
                  {activeNode?.operation === 'raw' && (
                    <span className="workflow-muted">
                      <LockKeyhole size={13} />
                      Immutable
                    </span>
                  )}
                </div>
                <h1>{title}</h1>
                {step && (
                  <p className="workflow-subtitle">
                    {activeNode
                      ? (graph.timeReferences.get(activeNode.id)?.name ??
                        'Workspace')
                      : step.sourceId
                        ? project.sources.find(
                            (item) => item.id === step.sourceId,
                          )?.name
                        : 'Workspace results'}{' '}
                    ·{' '}
                    {activeNode
                      ? `${number(graph.ranges.get(activeNode.id)![0])}–${number(graph.ranges.get(activeNode.id)![1])} s · ${activeNode.unit}`
                      : activeValue
                        ? `${activeValue.unit} · calculated from one signal`
                        : `${step.outputIds.length} outputs${step.kind === 'regions' ? ' · saved ranges from the earlier workspace' : ''}`}
                  </p>
                )}
                {step && (
                  <WorkflowManagement
                    key={`${step.id}:${selection.id}`}
                    step={step}
                    outputId={
                      selection.kind === 'output' ? selection.id : undefined
                    }
                    busy={engine.busy}
                    onAction={(action) => manageSelection(selection, action)}
                  />
                )}
              </div>
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
                          (item) => item.id === activeNode?.sourceId,
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
                      setSidebar('history');
                    }}
                  >
                    Show lineage in tree <GitBranch size={14} />
                  </button>
                )}
              </section>
              <section
                className="workflow-next"
                ref={toolbar}
                aria-label="Next operation"
              >
                <div>
                  <button
                    className="workflow-link time-open"
                    disabled={engine.busy}
                    onClick={() => setTimeEditor({ ids: inputIds })}
                  >
                    Compare & align
                  </button>
                  <strong>
                    {inputIds.length
                      ? `${inputIds.length} signal${inputIds.length === 1 ? '' : 's'} ${inputs === null ? 'in view' : 'checked'}`
                      : activeValue
                        ? 'Value ready to use'
                        : 'Choose inputs for the next operation'}
                  </strong>
                  <small>
                    {inputs !== null && inputIds.length
                      ? 'Checked inputs stay selected while you explore.'
                      : inputIds.length === 1
                        ? 'Create signals with Derive or Segment; numbers with Calculate.'
                        : inputIds.length
                          ? 'Each selected signal is processed independently.'
                          : activeValue
                            ? 'Export this result or open its input to continue processing.'
                            : 'Choose an output below, or select a signal in the history.'}
                  </small>
                  {inputs !== null && inputIds.length > 0 && (
                    <WorkflowList
                      className="workflow-checked-inputs"
                      items={inputIds}
                      summary={`Review checked inputs (${inputIds.length})`}
                    >
                      {(visible) => (
                        <ul>
                          {visible.map((id) => (
                            <li key={id}>
                              <span>{index.label(id)}</span>
                              <button
                                className="workflow-icon-button"
                                aria-label={`Remove ${index.label(id)} from checked inputs`}
                                onClick={() =>
                                  setInputs(
                                    inputIds.filter((input) => input !== id),
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
                  )}
                  {activeNode && inputs !== null && (
                    <button
                      className="workflow-link"
                      onClick={() => setInputs(null)}
                    >
                      Use only this signal
                    </button>
                  )}
                </div>
                <div className="workflow-next-actions">
                  {activeValue && !inputIds.length ? (
                    <button
                      className="secondary-button"
                      onClick={() => follow(activeValue.inputId)}
                    >
                      Open input signal <ArrowRight size={15} />
                    </button>
                  ) : (
                    <>
                      <button
                        className="secondary-button"
                        disabled={!inputIds.length || engine.busy}
                        onClick={() =>
                          setEditor({ kind: 'derive', ids: inputIds })
                        }
                      >
                        <Waves size={15} />
                        Derive signal
                      </button>
                      <button
                        className="secondary-button"
                        disabled={!inputIds.length || engine.busy}
                        onClick={() =>
                          new Set(
                            inputIds.map((id) => index.nodes.get(id)?.sourceId),
                          ).size > 1
                            ? setTimeEditor({ ids: inputIds, mode: 'crop' })
                            : setEditor({ kind: 'segment', ids: inputIds })
                        }
                      >
                        <Scissors size={15} />
                        Segment
                      </button>
                      <button
                        className="secondary-button"
                        disabled={!inputIds.length || engine.busy}
                        onClick={() =>
                          setEditor({ kind: 'value', ids: inputIds })
                        }
                      >
                        <Hash size={15} />
                        Calculate value
                      </button>
                    </>
                  )}
                </div>
              </section>
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
              <Tabs
                className="workflow-inspector"
                value={plotId ? view : 'outputs'}
                onValueChange={setView}
              >
                <div className="workflow-view-toolbar">
                  <TabsList variant="line" aria-label="Inspect result">
                    <TabsTrigger value="result" disabled={!plotId}>
                      {activeValue ? 'Value & input' : 'Plot & samples'}
                    </TabsTrigger>
                    <TabsTrigger value="outputs">
                      Step outputs <span>{stepOutputs.length}</span>
                    </TabsTrigger>
                  </TabsList>
                  <button
                    className="secondary-button"
                    disabled={engine.busy || !stepOutputs.length}
                    onClick={() => setExportOpen(true)}
                  >
                    <Download size={16} /> Export / report
                  </button>
                </div>
                <TabsContent value="result">
                  {activeValue && (
                    <section
                      className="workflow-value-card"
                      aria-label="Calculated value"
                    >
                      <div>
                        <span>
                          {
                            VALUE_FUNCTIONS.find(
                              (spec) =>
                                spec.operation === activeValue.operation,
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
                  )}
                  {plotId && (
                    <section
                      className="workflow-chart-panel"
                      aria-label={
                        activeValue ? 'Value input signal' : 'Selected signal'
                      }
                    >
                      {activeValue && (
                        <div className="workflow-panel-heading">
                          <strong>Input signal</strong>
                          <button
                            className="workflow-link"
                            onClick={() => follow(activeValue.inputId)}
                          >
                            Open input <ArrowRight size={14} />
                          </button>
                        </div>
                      )}
                      {plot ? (
                        <SignalChart
                          traces={[
                            {
                              node: index.nodes.get(plotId)!,
                              plot,
                              label: index.label(plotId),
                            },
                          ]}
                          segments={[]}
                          range={graph.ranges.get(plotId)!}
                          onSegment={() => {}}
                          fluid
                        />
                      ) : (
                        <p className="workflow-empty">
                          {plotState?.id === plotId && plotState.error
                            ? plotState.error
                            : 'Loading signal…'}
                        </p>
                      )}
                      {plot && (
                        <div className="workflow-chart-stats">
                          <span>
                            {plot.summary.count.toLocaleString()} finite samples
                          </span>
                          <span>Min {number(plot.summary.min)}</span>
                          <span>Max {number(plot.summary.max)}</span>
                          <span>
                            Sample average {number(plot.summary.mean)}
                          </span>
                          <button
                            className="workflow-link"
                            onClick={() => setShowSamples((value) => !value)}
                          >
                            {showSamples ? 'Hide' : 'View'} samples
                          </button>
                        </div>
                      )}
                      {showSamples && (
                        <div className="workflow-samples">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Time (s)</TableHead>
                                <TableHead>
                                  Value ({index.nodes.get(plotId)?.unit})
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {samples?.id === plotId &&
                                samples.page === samplePage &&
                                samples.rows.map((point, i) => (
                                  <TableRow key={i}>
                                    <TableCell>{number(point[0])}</TableCell>
                                    <TableCell>{number(point[1])}</TableCell>
                                  </TableRow>
                                ))}
                            </TableBody>
                          </Table>
                          <div className="workflow-pager">
                            <button
                              aria-label="Previous samples"
                              disabled={!samplePage}
                              onClick={() => setSamplePage((page) => page - 1)}
                            >
                              <ChevronLeft size={16} />
                            </button>
                            <span>
                              Samples {samplePage * 100 + 1}–
                              {samplePage * 100 + (samples?.rows.length ?? 0)}
                            </span>
                            <button
                              aria-label="Next samples"
                              disabled={
                                samples?.id !== plotId ||
                                samples.page !== samplePage ||
                                !samples.more
                              }
                              onClick={() => setSamplePage((page) => page + 1)}
                            >
                              <ChevronRight size={16} />
                            </button>
                          </div>
                        </div>
                      )}
                    </section>
                  )}
                </TabsContent>
                <TabsContent value="outputs">
                  {step && (
                    <section className="workflow-output-panel">
                      <div className="workflow-panel-heading">
                        <div>
                          <strong>
                            {stepOutputs.length}{' '}
                            {allValues ? 'values' : 'signals'} ·{' '}
                            {reference(step)} {stepName(step)}
                          </strong>
                          <small>
                            {step.kind === 'regions'
                              ? 'Saved ranges are preserved. Create signal segments to continue.'
                              : allValues
                                ? 'Open a value to inspect it, or export the whole step.'
                                : 'Click a name to inspect. Check signals to use together.'}
                          </small>
                        </div>
                        <div className="workflow-panel-actions">
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
                                  {allValues ? 'Result' : 'Time interval (s)'}
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
                                                    (input) => input !== id,
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
                      {step.parameters && (
                        <details className="workflow-settings">
                          <summary>Saved settings</summary>
                          <dl>
                            {Object.entries(step.parameters).map(
                              ([key, value]) => (
                                <div key={key}>
                                  <dt>
                                    {key === 'value'
                                      ? SIGNAL_FUNCTIONS.find(
                                          (spec) =>
                                            spec.operation === step.operation,
                                        )?.parameter || 'Parameter'
                                      : key}
                                  </dt>
                                  <dd>{value}</dd>
                                </div>
                              ),
                            )}
                          </dl>
                        </details>
                      )}
                      {step.definition && (
                        <details className="workflow-settings">
                          <summary>Saved segmentation settings</summary>
                          <pre>
                            {JSON.stringify(
                              step.definition,
                              (key, value: unknown) =>
                                key === 'signalId' && typeof value === 'string'
                                  ? `${reference(index.owner.get(value))} ${index.label(value)}`
                                  : value,
                              2,
                            )}
                          </pre>
                        </details>
                      )}
                    </section>
                  )}
                </TabsContent>
              </Tabs>
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
            </>
          )}
        </main>
      </div>
      <footer className="workflow-status">
        {notice ? (
          <output className="workflow-notice">
            <Check size={14} />
            {notice}
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </output>
        ) : (
          <output>{engine.status}</output>
        )}
        {engine.busy ? (
          <button onClick={engine.cancel}>Cancel operation</button>
        ) : (
          <span>
            Originals stay unchanged · new operations append to history
          </span>
        )}
      </footer>
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
          className="workflow-dialog"
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
                ? 'Each time chunk becomes a derived signal. Existing inputs and history stay unchanged.'
                : editor?.kind === 'value'
                  ? 'Create one scalar value per selected signal. Results retain a link to their input.'
                  : 'Create new signals from the selected inputs. Existing signals stay unchanged.'}
          </DialogDescription>
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
          saved={timeEditor.saved}
          initialMode={timeEditor.mode}
          editing={!!timeEditor.editingId}
          busy={engine.busy}
          request={request}
          onCancel={engine.cancel}
          onClose={() => setTimeEditor(undefined)}
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
              setNotice(
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
              first. Expand a step for its outputs; use the output table for
              large batches. Arrow keys navigate the tree, Enter selects.
            </li>
            <li>
              <strong>Find the origin.</strong> Every output has a From link,
              full lineage, and links to later operations that use it. The
              signal index lists every output without nesting.
            </li>
            <li>
              <strong>Inspect and compare inputs.</strong> Open a name to view
              its plot or value. In Step outputs, check signals to process
              together. Checked inputs stay selected while you explore; Use only
              this signal replaces the batch with the signal in view.
            </li>
            <li>
              <strong>Take your results with you.</strong> Export / report
              offers samples, signal summaries, calculated values and a
              printable report. Choose the viewed output, checked signals or an
              entire step before downloading.
            </li>
            <li>
              <strong>Try another version.</strong> Repeat with new settings
              appends another operation. Earlier outputs and their descendants
              keep their original recipes.
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
