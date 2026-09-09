'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FileSpreadsheet,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  MousePointer2,
  Play,
  Plus,
  ScanLine,
  Scissors,
  Search,
  Settings2,
  Sigma,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Waves,
  X,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import SignalChart, { formatValue } from '@/components/signal-chart';
import SegmentationEditor, {
  SegmentProvenance,
} from '@/components/segmentation-editor';
import { createSignalWorker } from '@/lib/create-signal-worker';
import { segmentTraces } from '@/lib/segment-traces';
import SignalExplorer, { OperationHistory } from '@/components/signal-explorer';
import {
  buildExplorer,
  operationLabels,
  type ExplorerEntry,
} from '@/lib/signal-explorer';
import type {
  EngineRequest,
  EngineResponse,
  Operation,
  Plot,
  Point,
  Project,
  SignalNode,
} from '@/lib/signal-types';

type FunctionSpec = {
  operation: Operation | 'segment';
  name: string;
  category: string;
  description: string;
  parameter: string;
  defaultValue: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
};
const FUNCTIONS: FunctionSpec[] = [
  {
    operation: 'min-max',
    name: 'Min / Max',
    category: 'Calculation',
    description:
      'Find the minimum and maximum finite values, retaining their original timestamps as extrema samples. Missing samples are excluded.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'segment',
    name: 'Segment signals',
    category: 'Segmentation',
    description:
      'Create branches from signal crossings, explicit time ranges, or fixed-duration windows.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'smooth',
    name: 'Moving average',
    category: 'Filtering',
    description:
      'A trailing sample window reduces noise. Missing samples are excluded from the mean.',
    parameter: 'Window size',
    defaultValue: 25,
    unit: 'samples',
    min: 1,
    max: 100000,
    step: 1,
  },
  {
    operation: 'median',
    name: 'Median filter',
    category: 'Filtering',
    description:
      'Reject spikes with a trailing window of 1–1,001 samples. Uses available samples at the start and excludes missing values, filling gaps while the window has data.',
    parameter: 'Window size',
    defaultValue: 5,
    unit: 'samples',
    min: 1,
    max: 1001,
    step: 1,
  },
  {
    operation: 'exponential',
    name: 'Exponential smoothing',
    category: 'Filtering',
    description:
      'Weight each new sample by alpha (0 < alpha ≤ 1). Smaller values smooth more; 1 leaves values unchanged. Restarts after missing samples.',
    parameter: 'Smoothing factor',
    defaultValue: 0.2,
    unit: 'α',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    operation: 'low-pass',
    name: 'Low-pass RC filter',
    category: 'Filtering',
    description:
      'Reduce fast changes with a first-order RC filter using actual sample intervals. Starts at the input value and restarts after missing samples. Cutoff must be positive.',
    parameter: 'Cutoff frequency',
    defaultValue: 5,
    unit: 'Hz',
    min: 0,
  },
  {
    operation: 'high-pass',
    name: 'High-pass RC filter',
    category: 'Filtering',
    description:
      'Remove slow changes and DC offset with a first-order RC filter using actual sample intervals. Starts at zero and restarts after missing samples. Cutoff must be positive.',
    parameter: 'Cutoff frequency',
    defaultValue: 1,
    unit: 'Hz',
    min: 0,
  },
  {
    operation: 'scale',
    name: 'Scale signal',
    category: 'Calculation',
    description: 'Multiply every sample by a constant factor.',
    parameter: 'Scale factor',
    defaultValue: 1.1,
    unit: '×',
  },
  {
    operation: 'offset',
    name: 'Offset signal',
    category: 'Calculation',
    description: 'Add a constant to every sample in the selected signal.',
    parameter: 'Value offset',
    defaultValue: 10,
    unit: 'units',
  },
  {
    operation: 'absolute',
    name: 'Absolute value',
    category: 'Calculation',
    description:
      'Create the magnitude of each sample, retaining its time axis.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'derivative',
    name: 'Differentiate',
    category: 'Calculation',
    description:
      'First-order backward difference using actual sample times. The first sample is undefined.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'integral',
    name: 'Integrate',
    category: 'Calculation',
    description:
      'Cumulative trapezoidal integration. Missing intervals are skipped; output units include seconds.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'zero-time',
    name: 'Align to zero',
    category: 'Time manipulation',
    description:
      'Start the selected signal at t = 0. Source timestamps remain unchanged.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'time-shift',
    name: 'Shift time',
    category: 'Time manipulation',
    description:
      'Move the entire time axis by a fixed offset, including negative offsets.',
    parameter: 'Time offset',
    defaultValue: 5,
    unit: 's',
  },
  {
    operation: 'resample',
    name: 'Resample',
    category: 'Time manipulation',
    description:
      'Linear interpolation on a uniform grid. Gaps above 5 initial source intervals stay empty. Filter before downsampling.',
    parameter: 'Output rate',
    defaultValue: 50,
    unit: 'Hz',
  },
];
const empty: Project = { sources: [], nodes: [], segments: [] };
const segmentColors = ['#61d9b0', '#ac9cfa', '#edb477'];
function bytes(value: number) {
  return value > 1e9
    ? `${(value / 1e9).toFixed(2)} GB`
    : value > 1e6
      ? `${(value / 1e6).toFixed(2)} MB`
      : `${(value / 1e3).toFixed(0)} KB`;
}

function Picker({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  items: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v);
      }}
      items={items}
    >
      <SelectTrigger aria-label={label} className="workbench-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Workbench() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(
    new Map<
      number,
      { resolve: (r: EngineResponse) => void; reject: (e: Error) => void }
    >(),
  );
  const sequence = useRef(0);
  const [project, setProject] = useState<Project>(empty);
  const [sourceId, setSourceId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [operationTargets, setOperationTargets] = useState<{
    id: string;
    ids: string[];
    label: string;
    kind?: ExplorerEntry['kind'];
    memberUnit?: 'signals' | 'segments';
  }>();
  const [scope, setScope] = useState('');
  const [tab, setTab] = useState('analysis');
  const [compare, setCompare] = useState(false);
  const [plots, setPlots] = useState<Record<string, Plot>>({});
  const [busy, setBusy] = useState(true);
  const [plotBusy, setPlotBusy] = useState(false);
  const [status, setStatus] = useState('Preparing local workspace…');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'import' | 'functions' | 'help' | null>(
    null,
  );
  const [query, setQuery] = useState('');

  const [operation, setOperation] = useState<Operation | 'segment'>('segment');
  const [parameter, setParameter] = useState('0');

  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Point[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [zoom, setZoom] = useState<[number, number] | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const source =
    project.sources.find((s) => s.id === sourceId) ?? project.sources[0];
  const selected =
    project.nodes.find((n) => n.id === selectedId) ??
    project.nodes.find((n) => n.id === source?.channels[0]);
  const sourceSegments = project.segments.filter(
    (s) => s.sourceId === source?.id,
  );
  const activeSegment = sourceSegments.find((s) => s.id === scope);
  const spec = FUNCTIONS.find((f) => f.operation === operation)!;
  const currentSummary = selected ? plots[selected.id]?.summary : undefined;
  const raw = project.nodes.filter(
    (n) => n.sourceId === source?.id && n.operation === 'raw',
  );

  const request = useCallback(
    (r: EngineRequest) =>
      new Promise<EngineResponse>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error('Signal engine is not ready.'));
          return;
        }
        const requestId = ++sequence.current;
        pending.current.set(requestId, { resolve, reject });
        worker.current.postMessage({ ...r, requestId });
      }),
    [],
  );
  useEffect(() => {
    const instance = createSignalWorker();
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<EngineResponse>) => {
      const r = event.data;
      if (r.type === 'progress') {
        setStatus(r.message);
        setProgress(r.progress);
        return;
      }
      const task = pending.current.get(r.requestId);
      pending.current.delete(r.requestId);
      if (r.type === 'error') task?.reject(new Error(r.message));
      else task?.resolve(r);
    };
    instance.onerror = () => {
      setError(
        'The local signal engine could not start. Reload the workspace to try again.',
      );
      setBusy(false);
      pending.current.forEach((p) =>
        p.reject(new Error('Signal engine stopped.')),
      );
      pending.current.clear();
    };
    void request({ type: 'init' })
      .then((r) => {
        if (r.type === 'project') {
          setProject(r.project);
          setStatus('Workspace restored · all changes saved locally');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
    const tasks = pending.current;
    return () => {
      instance.terminate();
      worker.current = null;
      tasks.forEach((p) => p.reject(new Error('Workspace closed.')));
      tasks.clear();
    };
  }, [request]);

  const chartNodes = (
    activeSegment
      ? activeSegment.nodes.map((id) => project.nodes.find((n) => n.id === id)!)
      : raw
  )
    .filter(Boolean)
    .slice(0, 3);
  if (selected && !chartNodes.some((n) => n.id === selected.id) && !compare)
    chartNodes[Math.min(2, chartNodes.length)] = selected;
  const ids = [
    ...new Set([
      ...chartNodes.map((n) => n.id),
      ...(selected ? [selected.id] : []),
      ...sourceSegments.flatMap((s) =>
        s.nodes.filter((id) => {
          const n = project.nodes.find((n) => n.id === id);
          return (
            compare ||
            n?.operation === 'power' ||
            n?.operation === 'bsfc' ||
            n?.unit === 'kg/h'
          );
        }),
      ),
    ]),
  ];
  const idsKey = ids.join(',');
  const zoomKey = zoom?.join(',') || '';
  useEffect(() => {
    if (!idsKey) return;
    let alive = true;
    const parsedRange = zoomKey
      ? (zoomKey.split(',').map(Number) as [number, number])
      : undefined;
    void request({ type: 'view', ids: idsKey.split(',') })
      .then((r) => {
        if (alive && r.type === 'plots') {
          setPlots(Object.fromEntries(r.plots.map((p) => [p.id, p])));
          setPlotBusy(false);
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e.message);
          setPlotBusy(false);
        }
      });
    // Full summaries stay cached; zoom requests refine only the visible plots.
    if (parsedRange)
      void request({
        type: 'view',
        ids: idsKey.split(',').slice(0, 3),
        range: parsedRange,
      })
        .then((r) => {
          if (alive && r.type === 'plots')
            setPlots((old) => ({
              ...old,
              ...Object.fromEntries(r.plots.map((p) => [p.id, p])),
            }));
        })
        .catch((e: Error) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [idsKey, zoomKey, project.nodes.length, request]);
  useEffect(() => {
    if (tab !== 'data' || !selected?.id) return;
    let alive = true;
    void request({ type: 'rows', id: selected.id, offset: page * 100 })
      .then((r) => {
        if (alive && r.type === 'rows') {
          setRows(r.rows);
          setHasMore(r.hasMore);
        }
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [tab, selected?.id, page, request]);

  async function mutate(r: EngineRequest, message: string) {
    setBusy(true);
    setError('');
    setStatus(message);
    setProgress(0);
    try {
      const result = await request(r);
      if (result.type === 'project') {
        setProject(result.project);
        if (r.type === 'import') {
          setOperationTargets(undefined);
          const s = result.project.sources.at(-1)!;
          setSourceId(s.id);
          setSelectedId(s.channels[0]);
          setScope('');
          setZoom(undefined);
        }
        if (r.type === 'derive' || r.type === 'derive-many') {
          const outputs = result.project.nodes.slice(project.nodes.length);
          selectNode(outputs[0], result.project);
          setTab('analysis');
          if (r.type === 'derive-many') {
            setOperationTargets({
              id: `operation:${outputs[0].batchId}`,
              ids: outputs.map((node) => node.id),
              label: `${operationLabels[r.operation]} · ${outputs.length} results`,
              kind: 'collection',
              memberUnit: operationTargets?.memberUnit,
            });
          }
        }
        if (r.type === 'segment') {
          const first = result.project.nodes[project.nodes.length];
          const model = buildExplorer(result.project, r.sourceId);
          const group =
            first &&
            [...model.entries.values()].find(
              (entry) =>
                (entry.kind === 'collection' ||
                  entry.kind === 'file-segment') &&
                entry.ids.includes(first.id),
            );
          if (first && group) {
            selectNode(first, result.project);
            setOperationTargets({
              id: group.id,
              ids: group.ids,
              label: group.label,
              kind: group.kind,
              memberUnit: group.memberUnit,
            });
          }
        }
        setStatus(
          r.type === 'segment'
            ? 'Segments created · source signals unchanged'
            : r.type === 'segment-metrics'
              ? 'Power and fuel metrics created · lineage saved'
              : r.type === 'derive' || r.type === 'derive-many'
                ? 'Derived signal created · lineage saved'
                : 'Recording imported · raw signals locked',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
      setStatus('Ready');
    } finally {
      setBusy(false);
    }
  }
  function chooseOperation(next: Operation | 'segment') {
    const fn = FUNCTIONS.find((f) => f.operation === next)!;
    setOperation(next);
    setParameter(String(fn.defaultValue));
    setDialog(null);
  }
  function selectNode(n: SignalNode, nextProject = project) {
    setOperationTargets(undefined);
    setSourceId(n.sourceId);
    let ancestor: SignalNode | undefined = n;
    let segmentId = '';
    const visited = new Set<string>();
    const byId = new Map(nextProject.nodes.map((node) => [node.id, node]));
    const byNode = new Map(
      nextProject.segments.flatMap((segment) =>
        segment.nodes.map((id) => [id, segment] as const),
      ),
    );
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      const segment = byNode.get(ancestor.id);
      if (segment) {
        segmentId = segment.id;
        break;
      }
      ancestor = byId.get(ancestor.parents[0]);
    }
    setScope(segmentId);
    setCompare(false);
    setSelectedId(n.id);
    setPage(0);
    setPlotBusy(n.id !== selected?.id);
    setZoom(undefined);
  }
  function selectSegment(id: string) {
    setOperationTargets(undefined);
    const s = sourceSegments.find((item) => item.id === id);
    setScope(id);
    setZoom(undefined);
    setCompare(false);
    if (s) {
      setSelectedId(s.nodes[0]);
      setPage(0);
    }
  }
  async function exportResults() {
    setError('');
    setBusy(true);
    setStatus('Preparing summary export…');
    try {
      const r = await request({
        type: 'export',
        ids: sourceSegments.length
          ? sourceSegments.flatMap((s) => s.nodes)
          : source?.channels || [],
      });
      if (r.type === 'export') {
        const url = URL.createObjectURL(r.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Stratus_analysis_summary.csv';
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus('Analysis summary exported');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  const range: [number, number] =
    zoom ??
    (compare
      ? [0, Math.max(1, ...sourceSegments.map((s) => s.end - s.start))]
      : [
          Math.min(
            activeSegment?.start ?? source?.start ?? 0,
            ...chartNodes
              .map((n) => plots[n.id]?.summary.start)
              .filter(
                (v): v is number => v !== undefined && Number.isFinite(v),
              ),
          ),
          Math.max(
            activeSegment?.end ?? source?.end ?? 180,
            ...chartNodes
              .map((n) => plots[n.id]?.summary.end)
              .filter(
                (v): v is number => v !== undefined && Number.isFinite(v),
              ),
          ),
        ]);

  return (
    <div className="workbench">
      <header className="app-header">
        <div className="brand">
          <Layers3 size={23} strokeWidth={1.7} />
          <span>
            stratus<span className="brand-period">.</span>
          </span>
          <span className="preview-label">PREVIEW</span>
        </div>
        <div className="header-project">
          <FolderOpen size={14} />
          <span>Engine development</span>
          <ChevronRight size={12} />
          <strong>Dyno analysis</strong>
        </div>
        <div className="header-right">
          <span className="local-badge">
            <i />
            Local workspace
          </span>
          <button
            className="icon-button"
            aria-label="Workspace help"
            onClick={() => setDialog('help')}
          >
            <CircleHelp size={17} />
          </button>
          <span className="avatar">EN</span>
        </div>
      </header>
      <div className="ribbon">
        <div className="ribbon-group">
          <button
            className="tool-button import-tool"
            onClick={() => setDialog('import')}
            disabled={busy}
          >
            <ArrowDownToLine />
            <span>Import data</span>
            <kbd>CSV</kbd>
          </button>
        </div>
        <div className="ribbon-group">
          <button
            className="tool-button"
            onClick={() => chooseOperation('smooth')}
          >
            <Waves />
            <span>Filter</span>
          </button>
          <button
            className="tool-button"
            onClick={() => chooseOperation('scale')}
          >
            <Sigma />
            <span>Calculate</span>
          </button>
          <button
            className={`tool-button ${operation === 'segment' ? 'tool-active' : ''}`}
            onClick={() => chooseOperation('segment')}
          >
            <Scissors />
            <span>Segment</span>
          </button>
          <button
            className="tool-button"
            onClick={() => chooseOperation('zero-time')}
          >
            <Clock3 />
            <span>Transform time</span>
          </button>
        </div>
        <div className="ribbon-group">
          <button
            className="tool-button"
            onClick={() => {
              setQuery('');
              setDialog('functions');
            }}
          >
            <FlaskConical />
            <span>Function library</span>
            <span className="count-badge">10</span>
          </button>
        </div>
        <div className="ribbon-end">
          <span>
            <LockKeyhole size={13} />
            Raw data is immutable
          </span>
          <button
            className="subtle-button"
            onClick={() => void exportResults()}
            disabled={busy || !source}
          >
            <ArrowUpRight size={15} />
            Export results
          </button>
        </div>
      </div>
      <div className="workspace-body">
        <aside className="signal-browser">
          <div className="panel-heading">
            <span>SIGNAL EXPLORER</span>
            <span className="count-badge">{project.nodes.length}</span>
            <button
              className="icon-button"
              aria-label="Import another recording"
              onClick={() => setDialog('import')}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="explorer-source-picker">
            <Picker
              label="Recording"
              value={source?.id || ''}
              items={project.sources.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              onChange={(id) => {
                const next = project.sources.find((item) => item.id === id);
                if (!next) return;
                setSourceId(id);
                setSelectedId(next.channels[0]);
                setOperationTargets(undefined);
                setScope('');
                setZoom(undefined);
                setPage(0);
              }}
            />
          </div>
          {source && (
            <SignalExplorer
              key={source.id}
              project={project}
              sourceId={source.id}
              selectedId={selected?.id || ''}
              collectionId={operationTargets?.id}
              onSelect={selectNode}
              onCollection={({ ids, label, id, kind, memberUnit }) => {
                const node = project.nodes.find((item) => item.id === ids[0]);
                if (node) selectNode(node);
                setOperationTargets({ ids, label, id, kind, memberUnit });
              }}
            />
          )}
          <div className="source-footer">
            <Database size={15} />
            <div>
              <strong>
                {bytes(
                  project.sources.reduce((total, s) => total + s.bytes, 0),
                )}{' '}
                stored locally
              </strong>
              <small>
                {project.sources.length} source
                {project.sources.length !== 1 ? 's' : ''} · original values
                preserved
              </small>
            </div>
            <LockKeyhole size={13} />
          </div>
        </aside>
        <main className="analysis-workspace">
          <div className="workspace-title">
            <div>
              <div className="eyebrow">WORKSPACE / ENGINE DEVELOPMENT</div>
              <h1>
                Dyno analysis <span>024</span>
              </h1>
            </div>
            <span className="demo-badge">
              <i />
              {source?.synthetic ? 'DEMO DATA' : 'LOCAL DATA'}
            </span>
          </div>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(String(value))}
            className="workspace-tabs"
          >
            <div className="view-tabs">
              <TabsList variant="line">
                <TabsTrigger value="analysis">
                  <Activity />
                  Analysis
                </TabsTrigger>
                <TabsTrigger value="data">
                  <Table2 />
                  Data table
                </TabsTrigger>
                <TabsTrigger value="lineage">
                  <GitBranch />
                  Operation history
                </TabsTrigger>
              </TabsList>
              <span className="sample-metadata">
                {source
                  ? `${source.channels.length} channels · ${formatValue(source.end - source.start, 0)} s`
                  : 'Loading recording…'}
              </span>
            </div>
            <TabsContent value="analysis" className="analysis-content">
              <div className="plot-toolbar">
                <div className="scope-buttons">
                  <button
                    className={!scope && !compare ? 'active' : ''}
                    onClick={() => {
                      setScope('');
                      setOperationTargets(undefined);
                      setCompare(false);
                      setZoom(undefined);
                      if (raw[0]) setSelectedId(raw[0].id);
                    }}
                  >
                    Full recording
                  </button>
                  <button
                    className={compare ? 'active' : ''}
                    disabled={!sourceSegments.length}
                    onClick={() => {
                      setCompare(true);
                      setOperationTargets(undefined);
                      setScope('');
                      setZoom(undefined);
                    }}
                  >
                    Compare segments
                  </button>
                  {activeSegment && (
                    <span className="active-scope">
                      {activeSegment.name}
                      <button
                        className="icon-button"
                        aria-label="Return to full recording"
                        onClick={() => {
                          setScope('');
                          setOperationTargets(undefined);
                          if (raw[0]) setSelectedId(raw[0].id);
                        }}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  )}
                </div>
                <div className="plot-controls">
                  <span title="Hover a plot to inspect values">
                    <MousePointer2 size={14} />
                  </span>
                  <button
                    className="icon-button"
                    aria-label="Zoom to middle half"
                    onClick={() => {
                      const span = range[1] - range[0];
                      setZoom([range[0] + span / 4, range[1] - span / 4]);
                    }}
                  >
                    <ScanLine size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Fit full time range"
                    onClick={() => setZoom(undefined)}
                  >
                    <Maximize2 size={15} />
                  </button>
                </div>
              </div>
              <div className="segment-ruler">
                <span>{compare ? 'ALIGNED TO START' : 'SEGMENTS'}</span>
                <div>
                  {sourceSegments.slice(-3).map((s, i) => (
                    <button
                      key={s.id}
                      style={{ color: segmentColors[i] }}
                      onClick={() => selectSegment(s.id)}
                    >
                      <i style={{ background: segmentColors[i] }} />
                      {s.name}
                      <small>
                        {formatValue(s.start, 1)}–{formatValue(s.end, 1)} s
                      </small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="charts">
                {chartNodes.map((node) => {
                  const traces = compare
                    ? segmentTraces(
                        node,
                        sourceSegments,
                        project.nodes,
                        plots,
                        segmentColors,
                      )
                    : plots[node.id]
                      ? [{ node, plot: plots[node.id] }]
                      : [];
                  return (
                    <SignalChart
                      key={node.id}
                      traces={traces}
                      segments={!compare && !scope ? sourceSegments : []}
                      range={range}
                      onSegment={selectSegment}
                    />
                  );
                })}
                {!chartNodes.length && (
                  <div className="loading-workspace">
                    <LoaderCircle className="spin" />
                    <strong>Preparing the dyno recording</strong>
                    <span>
                      Importing signals and calculating three engine ramps…
                    </span>
                  </div>
                )}
              </div>
              <div className="plot-footer">
                <span>
                  <span className="connected-dot" />
                  {plotBusy ? 'Updating plots…' : 'Synchronized time axes'}
                  <span className="separator">/</span>
                  {compare ? 'Relative time' : 'Time [s]'}
                </span>
                <span>
                  Min / max envelope <span className="separator">·</span> Hover
                  to inspect
                </span>
              </div>
              <div className="results-section">
                <div className="results-heading">
                  <span>
                    <Table2 size={15} />
                    Segment results{' '}
                    <span className="count-badge">{sourceSegments.length}</span>
                  </span>
                  <button
                    className="text-button"
                    disabled={busy || !sourceSegments.length}
                    onClick={() =>
                      void mutate(
                        {
                          type: 'segment-metrics',
                          ids: sourceSegments.map((segment) => segment.id),
                        },
                        'Calculating power and fuel metrics…',
                      )
                    }
                  >
                    <Sigma size={13} />
                    Power & fuel metrics
                  </button>
                </div>
                <Table className="results-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Segment</TableHead>
                      <TableHead>
                        Duration <small>s</small>
                      </TableHead>
                      <TableHead>
                        Peak power <small>kW</small>
                      </TableHead>
                      <TableHead>
                        Fuel used <small>g</small>
                      </TableHead>
                      <TableHead>
                        BSFC <small>g/kWh</small>
                      </TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sourceSegments.map((s, i) => {
                      const ns = s.nodes.map((id) =>
                        project.nodes.find((n) => n.id === id)!,
                      );
                      const p =
                        plots[ns.find((n) => n.operation === 'power')?.id || '']
                          ?.summary;
                      const f =
                        plots[ns.find((n) => n.unit === 'kg/h')?.id || '']
                          ?.summary;
                      return (
                        <TableRow
                          key={s.id}
                          data-state={scope === s.id ? 'selected' : undefined}
                        >
                          <TableCell>
                            <button
                              className="result-segment"
                              onClick={() => selectSegment(s.id)}
                            >
                              <i style={{ background: segmentColors[i % 3] }} />
                              {s.name}
                              <ChevronRight size={12} />
                            </button>
                          </TableCell>
                          <TableCell>
                            {formatValue(s.end - s.start, 2)}
                          </TableCell>
                          <TableCell>{formatValue(p?.max ?? NaN, 2)}</TableCell>
                          <TableCell>
                            {formatValue(f ? f.integral / 3.6 : NaN, 2)}
                          </TableCell>
                          <TableCell className="result-emphasis">
                            {formatValue(
                              plots[
                                ns.find((n) => n.operation === 'bsfc')?.id || ''
                              ]?.summary.weightedMean ?? NaN,
                              2,
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="computed-badge">
                              <Check size={12} />
                              {p
                                ? 'Computed'
                                : ns.some((n) => n.operation === 'power')
                                  ? 'Processing'
                                  : 'Segmented'}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {!sourceSegments.length && (
                  <div className="empty-results">
                    Create segments to compare duration, power, and fuel
                    consumption.
                  </div>
                )}
                <div className="results-note">
                  <GitBranch size={12} />
                  BSFC is weighted by energy. Fuel and power are integrated over
                  each segment.
                </div>
              </div>
            </TabsContent>
            <TabsContent value="data" className="data-content">
              <div className="data-title">
                <div>
                  <h2>{selected?.name}</h2>
                  <p>
                    Stored sample values ·{' '}
                    {selected?.operation === 'raw'
                      ? 'immutable source'
                      : 'evaluated derivation'}
                  </p>
                </div>
                <span className="count-badge">{selected?.unit}</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sample</TableHead>
                    <TableHead>Time [s]</TableHead>
                    <TableHead>
                      {selected?.name} [{selected?.unit}]
                    </TableHead>
                    <TableHead>Quality</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(([t, v], i) => (
                    <TableRow key={t}>
                      <TableCell className="muted">
                        {page * 100 + i + 1}
                      </TableCell>
                      <TableCell>{formatValue(t, 5)}</TableCell>
                      <TableCell>{formatValue(v, 6)}</TableCell>
                      <TableCell>
                        <span
                          className={
                            Number.isFinite(v) ? 'valid-value' : 'muted'
                          }
                        >
                          {Number.isFinite(v) ? 'Valid' : 'Missing'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="pagination">
                <span>
                  Samples {page * 100 + 1}–{page * 100 + rows.length}
                </span>
                <button
                  className="subtle-button"
                  disabled={!page}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ArrowLeft size={14} />
                  Previous
                </button>
                <button
                  className="subtle-button"
                  disabled={!hasMore}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ArrowRight size={14} />
                </button>
              </div>
            </TabsContent>
            <TabsContent value="lineage" className="lineage-content">
              <div className="data-title">
                <div>
                  <h2>Order of operations</h2>
                  <p>
                    Follow this signal from its source. Linked inputs open their
                    own histories.
                  </p>
                </div>
                <GitBranch size={20} />
              </div>
              {selected && (
                <OperationHistory
                  key={selected.id}
                  selected={selected}
                  project={project}
                  onSelect={selectNode}
                />
              )}
              <div className="lineage-explainer">
                <LockKeyhole size={17} />
                <div>
                  <strong>
                    Sources are immutable. Analysis is reproducible.
                  </strong>
                  <p>
                    Each operation records its inputs, parameters, and version.
                    New parameters create a new signal. Multi-input calculations
                    retain every parent.
                  </p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </main>
        <aside className="inspector">
          <div className="panel-heading">
            <span>FUNCTIONS & INSPECTOR</span>
            <Settings2 size={15} />
          </div>
          <div className="function-editor">
            <div className="function-label">
              <span className="function-icon">
                {operation === 'segment' ? (
                  <Scissors size={18} />
                ) : (
                  <Sigma size={19} />
                )}
              </span>
              <div>
                <small>{spec.category}</small>
                <h2>{spec.name}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Choose another function"
                onClick={() => setDialog('functions')}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            <p className="function-description">{spec.description}</p>
            {operationTargets && operation !== 'segment' && (
              <div className="operation-targets">
                <Layers3 size={15} />
                <div>
                  <strong>{operationTargets.label}</strong>
                  <small>
                    Apply independently to all {operationTargets.ids.length}{' '}
                    {operationTargets.memberUnit ?? 'signals'}. Each produces
                    its own result.
                  </small>
                </div>
                <button
                  className="icon-button"
                  aria-label="Use only the selected signal"
                  onClick={() => setOperationTargets(undefined)}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            {operation === 'segment' ? (
              source && (
                <SegmentationEditor
                  key={`${source.id}:${operationTargets?.id ?? selected?.id}`}
                  source={source}
                  nodes={project.nodes}
                  segments={sourceSegments}
                  busy={busy}
                  selectionKind={operationTargets?.kind}
                  selectedIds={
                    operationTargets?.ids ??
                    (selected ? [selected.id] : source.channels)
                  }
                  onPreview={async (
                    definition,
                    targetIds,
                    independently,
                    targetScope,
                  ) => {
                    setBusy(true);
                    setStatus('Previewing segment intervals…');
                    setProgress(0);
                    try {
                      const response = await request({
                        type: 'segment-preview',
                        sourceId: source.id,
                        definition,
                        targetIds,
                        independently,
                        scope: targetScope,
                      });
                      if (response.type !== 'segment-plan')
                        throw new Error('Unexpected preview response.');
                      setStatus(
                        `${response.plan.ranges.length} intervals previewed · no signals created`,
                      );
                      return response.plan;
                    } finally {
                      setBusy(false);
                    }
                  }}
                  onCreate={(
                    definition,
                    targetIds,
                    independently,
                    targetScope,
                  ) => {
                    void mutate(
                      {
                        type: 'segment',
                        sourceId: source.id,
                        definition,
                        targetIds,
                        independently,
                        scope: targetScope,
                      },
                      'Creating segment branches…',
                    );
                  }}
                />
              )
            ) : (
              <>
                {!operationTargets && (
                  <div className="field-label">Input signal</div>
                )}
                {!operationTargets && (
                  <Picker
                    label="Input signal"
                    value={selected?.id || ''}
                    onChange={(id) => {
                      const node = project.nodes.find((n) => n.id === id);
                      if (node) selectNode(node);
                    }}
                    items={project.nodes
                      .filter((n) => n.sourceId === source?.id)
                      .map((n) => ({
                        value: n.id,
                        label: `${n.name}${n.operation === 'raw' ? '' : ` · ${sourceSegments.find((s) => s.nodes.includes(n.id))?.name || n.operation}`}`,
                      }))}
                  />
                )}
                {spec.parameter && (
                  <>
                    <label className="field-label" htmlFor="function-parameter">
                      {spec.parameter}
                    </label>
                    <div className="number-field">
                      <input
                        id="function-parameter"
                        type="number"
                        value={parameter}
                        min={spec.min}
                        max={spec.max}
                        step={spec.step ?? 'any'}
                        onChange={(e) => setParameter(e.target.value)}
                      />
                      <span>{spec.unit}</span>
                    </div>
                  </>
                )}
                <div className="output-option">
                  <GitBranch size={15} />
                  <span>
                    Create{' '}
                    {operationTargets
                      ? `${operationTargets.ids.length} independent results`
                      : 'new derived signal'}
                  </span>
                  <Check size={14} />
                </div>
                <button
                  className="primary-button"
                  disabled={busy || !selected}
                  onClick={() => {
                    if (!selected) return;
                    if (spec.parameter && !parameter.trim()) {
                      setError('Enter all function parameters.');
                      return;
                    }
                    void mutate(
                      operationTargets
                        ? {
                            type: 'derive-many',
                            parentIds: operationTargets.ids,
                            operation,
                            parameter: Number(parameter),
                          }
                        : {
                            type: 'derive',
                            parentId: selected.id,
                            operation,
                            parameter: Number(parameter),
                          },
                      'Creating derived signal…',
                    );
                  }}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Play size={14} fill="currentColor" />
                  )}
                  {operationTargets
                    ? `Apply to ${operationTargets.ids.length} ${operationTargets.memberUnit ?? 'signals'}`
                    : 'Apply function'}
                </button>
              </>
            )}
          </div>
          {activeSegment && (
            <SegmentProvenance segment={activeSegment} nodes={project.nodes} />
          )}
          <div className="inspector-properties">
            <div className="section-heading">
              SIGNAL PROPERTIES
              <SlidersHorizontal size={13} />
            </div>
            <h3>
              <i
                className="signal-dot"
                style={{ background: selected?.color }}
              />
              {selected?.name || 'No signal selected'}
            </h3>
            <dl>
              <div>
                <dt>Type</dt>
                <dd>
                  {selected?.operation === 'raw' ? (
                    <>
                      <LockKeyhole size={11} />
                      Immutable raw
                    </>
                  ) : (
                    selected?.operation
                  )}
                </dd>
              </div>
              <div>
                <dt>Unit</dt>
                <dd>{selected?.unit}</dd>
              </div>
              <div>
                <dt>Valid samples</dt>
                <dd>{currentSummary?.count.toLocaleString() || '—'}</dd>
              </div>
              <div>
                <dt>Mean</dt>
                <dd>{formatValue(currentSummary?.mean ?? NaN, 2)}</dd>
              </div>
              <div>
                <dt>Minimum</dt>
                <dd>{formatValue(currentSummary?.min ?? NaN, 2)}</dd>
              </div>
              <div>
                <dt>Maximum</dt>
                <dd>{formatValue(currentSummary?.max ?? NaN, 2)}</dd>
              </div>
            </dl>
            <button className="text-button" onClick={() => setTab('lineage')}>
              <GitBranch size={13} />
              Inspect operation history
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="quick-functions">
            <div className="section-heading">QUICK FUNCTIONS</div>
            <button onClick={() => chooseOperation('min-max')}>
              <Sigma size={15} />
              <span>Min / Max</span>
              <ArrowUpRight size={13} />
            </button>
            <button onClick={() => chooseOperation('smooth')}>
              <Waves size={15} />
              <span>Moving average</span>
              <ArrowUpRight size={13} />
            </button>
            <button onClick={() => chooseOperation('zero-time')}>
              <Clock3 size={15} />
              <span>Align to zero</span>
              <ArrowUpRight size={13} />
            </button>
            <button onClick={() => chooseOperation('integral')}>
              <Sigma size={15} />
              <span>Integrate signal</span>
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="inspector-bottom">
            <Sparkles size={14} />
            <span>
              Build on any signal.
              <br />
              <strong>Your source stays untouched.</strong>
            </span>
          </div>
        </aside>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setError('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <footer className="status-bar">
        <span>
          {busy ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <span className="connected-dot" />
          )}
          {status}
          {busy && progress > 0 && <span>{progress.toFixed(0)}%</span>}
          {busy && (
            <button
              onClick={() =>
                worker.current?.postMessage({ type: 'cancel', requestId: 0 })
              }
            >
              Cancel
            </button>
          )}
        </span>
        <span>
          <GitBranch size={12} />
          {project.nodes.filter((n) => n.operation !== 'raw').length} derived
          signals<span className="separator">|</span>
          <Database size={12} />
          Local processing<span className="separator">|</span>Stratus 0.1
        </span>
      </footer>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="workbench-dialog">
          {dialog === 'import' ? (
            <>
              <DialogTitle>Import a recording</DialogTitle>
              <DialogDescription>
                CSV files stay on this device. Raw samples are stored as
                immutable signals.
              </DialogDescription>
              <button
                className="import-dropzone"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file && !busy) {
                    setDialog(null);
                    void mutate(
                      { type: 'import', file },
                      'Importing recording…',
                    );
                  }
                }}
              >
                <FileSpreadsheet size={34} />
                <strong>Choose a CSV file</strong>
                <span>or drop it here</span>
                <small>Chunked import · no full-file memory load</small>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="CSV file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setDialog(null);
                    void mutate(
                      { type: 'import', file },
                      'Importing recording…',
                    );
                  }
                  event.target.value = '';
                }}
              />
              <div className="csv-format">
                <strong>Expected format</strong>
                <code>
                  Time [s],Engine speed [rpm],Torque [Nm],Fuel flow [kg/h]
                  <br />
                  0.00,1500,210,8.4
                  <br />
                  0.01,1502,211,8.5
                </code>
                <p>
                  First column: increasing time in seconds. Use unit labels in
                  square brackets for automatic power and fuel calculations.
                  Empty cells remain missing. Duplicate or unsorted times are
                  rejected.
                </p>
              </div>
              <button
                className="subtle-button"
                disabled={busy}
                onClick={() => {
                  setDialog(null);
                  void mutate(
                    { type: 'demo' },
                    'Opening demonstration recording…',
                  );
                }}
              >
                <FlaskConical size={15} />
                Open the demo recording
              </button>
            </>
          ) : dialog === 'functions' ? (
            <>
              <DialogTitle>
                Function library{' '}
                <span className="count-badge">{FUNCTIONS.length}</span>
              </DialogTitle>
              <DialogDescription>
                Select a function, then configure it in the inspector. Every
                operation creates a traceable result.
              </DialogDescription>
              <label className="search-box library-search">
                <Search size={16} />
                <input
                  aria-label="Search functions"
                  placeholder="Search filtering, calculation, time…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="function-library">
                {[
                  'Segmentation',
                  'Filtering',
                  'Calculation',
                  'Time manipulation',
                ].map((category) => {
                  const functions = FUNCTIONS.filter(
                    (f) =>
                      f.category === category &&
                      `${f.name} ${f.category} ${f.description}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  );
                  return functions.length ? (
                    <div key={category}>
                      <h3>{category}</h3>
                      {functions.map((f) => (
                        <button
                          key={f.operation}
                          onClick={() => chooseOperation(f.operation)}
                        >
                          <span>
                            {f.name}
                            <small>{f.description}</small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </div>
                  ) : null;
                })}
                {!FUNCTIONS.some((f) =>
                  `${f.name} ${f.category} ${f.description}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                ) && (
                  <p className="empty-results">No functions match “{query}”.</p>
                )}
              </div>
              <p className="library-note">
                Use Power & fuel metrics above the results table for segments
                with rpm, Nm, and kg/h channels. Custom plugins are planned.
              </p>
            </>
          ) : (
            <>
              <DialogTitle>Stratus signal workbench</DialogTitle>
              <DialogDescription>
                An initial engineering workspace for reproducible time-series
                analysis.
              </DialogDescription>
              <ol className="help-steps">
                <li>
                  <strong>Import</strong> a CSV or explore the included
                  synthetic three-ramp recording.
                </li>
                <li>
                  <strong>Segment</strong> using independent start/end edge
                  triggers, signed offsets, manual ranges, or windows.
                </li>
                <li>
                  <strong>Process</strong> any source or derived signal. New
                  results appear in the explorer.
                </li>
                <li>
                  <strong>Compare</strong> segments on a relative time axis and
                  export their statistics.
                </li>
              </ol>
              <p className="help-note">
                This prototype stores numeric chunks in IndexedDB and evaluates
                them in a worker. Data persists on this device; clearing app
                storage removes it. Available disk quota still applies.
                Multi-gigabyte throughput has not yet been benchmarked.
              </p>
              <p className="help-note">
                The library currently includes {FUNCTIONS.length} operations.
                FFT, higher-order digital filters, native file formats, plugin
                execution, and project interchange are future work.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
