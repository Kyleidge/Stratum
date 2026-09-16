'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Layers3,
  LockKeyhole,
  Plus,
  Scissors,
  Sigma,
  Table2,
  Waves,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import SignalChart, { formatValue } from './signal-chart';
import RegionHistory from './region-history';
import RegionEditor from './region-editor';
import RegionFunctionEditor from './region-function-editor';
import { RegionSelect } from './region-controls';
import { useSignalEngine } from '@/hooks/use-signal-engine';
import {
  regionBindings,
  regionContains,
  regionHistory,
  type HistoryItem,
} from '@/lib/region-model';
import { SignalGraph } from '@/lib/signal-graph';
import { operationLabels } from '@/lib/signal-explorer';
import { REGION_EXAMPLES } from '@/lib/region-types';
import type { FunctionRun, RegionSet } from '@/lib/region-types';
import type { Operation, Plot, Point, Segment } from '@/lib/signal-types';

const colors = [
  '#61d9b0',
  '#ac9cfa',
  '#edb477',
  '#74b9fa',
  '#e787ac',
  '#b8d771',
];
export default function RegionWorkbench() {
  const engine = useSignalEngine(),
    { project } = engine;
  const [sourceId, setSourceId] = useState(''),
    [historyId, setHistoryId] = useState('');
  const [setId, setSetId] = useState(''),
    [regionId, setRegionId] = useState(''),
    [rawId, setRawId] = useState('');
  const [exampleKey, setExampleKey] = useState('');
  const [axis, setAxis] = useState('source'),
    [table, setTable] = useState('regions'),
    [page, setPage] = useState(0),
    [parentFilter, setParentFilter] = useState('');
  const [mode, setMode] = useState<'regions' | 'function'>('function');
  const [editor, setEditor] = useState<{
    nonce: number;
    operation: Operation;
    inputKey: string;
    regionSetId?: string;
    savedRun?: FunctionRun;
    savedSet?: RegionSet;
    parentId?: string;
    parentRegionId?: string;
  }>({ nonce: 0, operation: 'smooth', inputKey: '' });
  const [help, setHelp] = useState(false),
    [notice, setNotice] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const source =
    project.sources.find((item) => item.id === sourceId) ??
    project.sources.find(
      (item) => item.id === project.regionExamples?.[0]?.sourceId,
    ) ??
    project.sources[0];
  const sourceSets = (project.regionSets ?? []).filter(
    (item) => item.sourceId === source?.id,
  );
  const activeSet =
    sourceSets.find((item) => item.id === setId) ??
    (!setId ? sourceSets.at(-1) : undefined);
  const activeRegion = activeSet?.regions.find((item) => item.id === regionId);
  const run = project.functionRuns?.find((item) => item.id === historyId);
  const graph = useMemo(() => new SignalGraph(project), [project]);
  const bindings = useMemo(() => regionBindings(project), [project]);
  const history = useMemo(
    () => regionHistory(project, source?.id ?? ''),
    [project, source?.id],
  );
  const raw = source?.channels.map((id) => graph.find(id)) ?? [];
  const inputSteps = run
    ? history.filter((item) =>
        item.run?.outputs.some((output) =>
          [...run.inputIds, ...(run.secondaryIds ?? [])].includes(
            output.signalId,
          ),
        ),
      )
    : [];
  const selectedRaw = raw.find((node) => node.id === rawId) ?? raw[1] ?? raw[0];
  const regionIndex = useMemo(
    () =>
      new Map(
        (project.regionSets ?? []).flatMap((set) =>
          set.regions.map((region) => [region.id, region] as const),
        ),
      ),
    [project],
  );
  const scopeLabel = activeSet
    ? `${activeSet.name} v${activeSet.version}`
    : 'Full recording';
  const rows =
    activeSet?.regions.filter(
      (region) => !parentFilter || region.parentRegionId === parentFilter,
    ) ?? [];
  const pageSize = 25,
    pages = Math.max(
      1,
      Math.ceil(
        (table === 'results' ? (run?.outputs.length ?? 0) : rows.length) /
          pageSize,
      ),
    );
  const currentPage = Math.min(page, pages - 1),
    regionRows = rows.slice(
      currentPage * pageSize,
      (currentPage + 1) * pageSize,
    );
  const resultRows =
    run?.outputs.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ??
    [];
  const candidateIds = run
    ? run.operation === 'min-max'
      ? run.inputIds
      : run.outputs.map((output) => output.signalId)
    : selectedRaw
      ? [selectedRaw.id]
      : [];
  const chartIds = candidateIds
    .filter(
      (id) =>
        !activeRegion ||
        !bindings.has(id) ||
        regionContains(
          project,
          bindings.get(id)!,
          activeRegion.id,
          regionIndex,
        ) ||
        regionContains(
          project,
          activeRegion.id,
          bindings.get(id)!,
          regionIndex,
        ),
    )
    .slice(0, 6);
  const requestedIds = [
    ...new Set([
      ...chartIds,
      ...(table === 'results'
        ? resultRows.map((output) => output.signalId)
        : []),
    ]),
  ];
  const idsKey = requestedIds.join(',');
  const [plotState, setPlotState] = useState<{
    key: string;
    plots: Record<string, Plot>;
  }>({ key: '', plots: {} });
  const [plotError, setPlotError] = useState<{
    key: string;
    message: string;
  }>();
  const loading =
    !!idsKey && plotState.key !== idsKey && plotError?.key !== idsKey;
  const plots = plotState.plots;
  const request = engine.request;
  useEffect(() => {
    if (!idsKey || !engine.ready) return;
    let alive = true;
    void request({ type: 'view', ids: idsKey.split(',') })
      .then((response) => {
        if (alive && response.type === 'plots')
          setPlotState({
            key: idsKey,
            plots: Object.fromEntries(
              response.plots.map((plot) => [plot.id, plot]),
            ),
          });
      })
      .catch((caught: Error) => {
        if (alive) setPlotError({ key: idsKey, message: caught.message });
      });
    return () => {
      alive = false;
    };
  }, [idsKey, engine.ready, request]);
  const [samples, setSamples] = useState<{
    id: string;
    page: number;
    rows: Point[];
    more: boolean;
  }>();
  const dataId = chartIds[0] ?? '';
  useEffect(() => {
    if (table !== 'data' || !dataId) return;
    let alive = true;
    void request({ type: 'rows', id: dataId, offset: page * 100 })
      .then((response) => {
        if (alive && response.type === 'rows')
          setSamples({
            id: dataId,
            page,
            rows: response.rows,
            more: response.hasMore,
          });
      })
      .catch((caught: Error) => {
        if (alive) setPlotError({ key: idsKey, message: caught.message });
      });
    return () => {
      alive = false;
    };
  }, [dataId, page, table, request, idsKey]);
  function switchSource(id: string, next = project) {
    const s = next.sources.find((item) => item.id === id);
    if (!s) return;
    setSourceId(id);
    setHistoryId('');
    setSetId('');
    setRegionId('');
    setRawId(s.channels[1] ?? s.channels[0]);
    setPage(0);
    setParentFilter('');
    setAxis('source');
    setMode('function');
    setEditor((old) => ({
      nonce: old.nonce + 1,
      operation: 'smooth',
      inputKey: `signal:${s.channels[1] ?? s.channels[0]}`,
    }));
  }
  function showItem(item: HistoryItem) {
    setHistoryId(item.id);
    setRegionId('');
    setAxis('source');
    setPage(0);
    setParentFilter('');
    if (item.set) {
      setSourceId(item.set.sourceId);
      setSetId(item.set.id);
      setTable('regions');
      setMode('regions');
      setEditor((old) => ({
        ...old,
        nonce: old.nonce + 1,
        savedSet: item.set,
        savedRun: undefined,
        parentId: undefined,
        parentRegionId: undefined,
      }));
    }
    if (item.run) {
      setSourceId(item.run.sourceId);
      setSetId(item.run.regionSetId ?? 'none');
      setTable('results');
      setMode('function');
      setEditor((old) => ({
        nonce: old.nonce + 1,
        operation: item.run!.operation,
        inputKey: 'saved',
        savedRun: item.run,
      }));
    }
  }
  function chooseFunction(operation: Operation, within?: string) {
    setMode('function');
    setEditor((old) => ({
      nonce: old.nonce + 1,
      operation,
      inputKey: run ? `run:${run.id}` : `signal:${selectedRaw?.id ?? ''}`,
      regionSetId: within,
    }));
  }
  function segmentWithin(parentId?: string, parentRegionId?: string) {
    setMode('regions');
    setEditor((old) => ({
      nonce: old.nonce + 1,
      operation: 'smooth',
      inputKey: old.inputKey,
      parentId,
      parentRegionId,
    }));
  }
  async function example(key: string) {
    try {
      const next = await engine.mutate(
        { type: 'region-example', key },
        'Preparing worked example…',
      );
      const chosen = next.regionExamples?.find((item) => item.key === key);
      if (!chosen) return;
      switchSource(chosen.sourceId, next);
      setExampleKey(key);
      const set = next.regionSets!.find(
        (item) => item.id === chosen.regionSetId,
      )!;
      showItem({ id: set.id, sequence: set.sequence, set });
      setNotice(
        'Example ready. Select a function to inspect its inputs, or select a region to view it.',
      );
    } catch {
      /* The worker error is already visible. */
    }
  }
  async function importFile(input: File) {
    try {
      const next = await engine.mutate(
        { type: 'import', file: input },
        'Importing immutable recording…',
      );
      switchSource(next.sources.at(-1)!.id, next);
      setNotice(
        'Recording imported. Create regions or apply a function to an original signal.',
      );
    } catch {
      /* The worker error is already visible. */
    }
  }
  async function exportResults() {
    if (!run) return;
    try {
      const response = await request({
        type: 'export',
        ids: run.outputs.map((output) => output.signalId),
      });
      if (response.type === 'export') {
        const url = URL.createObjectURL(response.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Stratum_results.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (caught) {
      engine.setError(
        caught instanceof Error ? caught.message : 'Export failed.',
      );
    }
  }
  const offsetFor = (id: string) =>
    axis === 'signal'
      ? 0
      : (graph.offsets.get(id) ?? 0) +
        (axis === 'relative' ? (activeRegion?.start ?? 0) : 0);
  const units = [...new Set(chartIds.map((id) => graph.find(id).unit))].slice(
    0,
    3,
  );
  const primaryOffset =
    axis === 'signal'
      ? (graph.offsets.get(chartIds[0]) ?? 0)
      : axis === 'relative'
        ? -(activeRegion?.start ?? 0)
        : 0;
  const range: [number, number] = [
    (activeRegion?.start ?? source?.start ?? 0) + primaryOffset,
    (activeRegion?.end ?? source?.end ?? 180) + primaryOffset,
  ];
  const overlay: Segment[] = (!activeRegion ? regionRows : [activeRegion]).map(
    (region) => ({
      id: region.id,
      name: region.name,
      sourceId: source?.id ?? '',
      nodes: [],
      start: region.start + primaryOffset,
      end: region.end + primaryOffset,
    }),
  );
  const parentSet = sourceSets.find((set) => set.id === activeSet?.parentSetId);
  const samplesReady = samples?.id === dataId && samples.page === page;
  return (
    <div className="region-app">
      <header className="region-header">
        <div className="region-brand">
          <Layers3 size={22} />
          stratum.
        </div>
        <span className="region-path">
          Signal analysis <ChevronRight size={13} />
          <strong>{source?.name ?? 'Opening workspace'}</strong>
        </span>
        <span className="region-local">
          <LockKeyhole size={12} />
          Local workspace
        </span>
        <button className="subtle-button" onClick={() => setHelp(true)}>
          Workspace guide
        </button>
      </header>
      <div className="region-ribbon">
        <button
          onClick={() => file.current?.click()}
          disabled={engine.busy || !engine.ready}
        >
          <ArrowDownToLine size={17} />
          Import CSV
        </button>
        <span />
        <button onClick={() => segmentWithin()} disabled={!source}>
          <Scissors size={17} />
          Segment
        </button>
        <button onClick={() => chooseFunction('low-pass')} disabled={!source}>
          <Waves size={17} />
          Filter
        </button>
        <button onClick={() => chooseFunction('scale')} disabled={!source}>
          <Sigma size={17} />
          Calculate
        </button>
        <button onClick={() => chooseFunction('zero-time')} disabled={!source}>
          <Clock3 size={17} />
          Transform time
        </button>
        <button onClick={() => chooseFunction('min-max')} disabled={!source}>
          <Table2 size={17} />
          Min / Max
        </button>
        <small>
          Immutable signals · reusable regions · explicit processing scope
        </small>
      </div>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label="Import CSV recording"
        onChange={(event) => {
          const input = event.target.files?.[0];
          if (input) void importFile(input);
          event.target.value = '';
        }}
      />
      <div className="region-layout">
        <aside className="region-sidebar">
          <div className="region-panel-heading">
            FUNCTION HISTORY <span>{history.length}</span>
          </div>
          <div className="region-sidebar-controls">
            <RegionSelect
              label="Recording"
              value={source?.id ?? ''}
              items={project.sources.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              onChange={(id) => switchSource(id)}
            />
            <RegionSelect
              label="Worked examples"
              value={exampleKey}
              items={[
                { value: '', label: 'Choose an example…' },
                ...REGION_EXAMPLES.map((item) => ({
                  value: item.key,
                  label: item.name,
                })),
              ]}
              disabled={engine.busy || !engine.ready}
              onChange={(key) => {
                if (key) void example(key);
              }}
            />
          </div>
          <RegionHistory
            items={history}
            selectedId={historyId}
            onSelect={showItem}
            raw={raw}
            onRaw={(id) => {
              setRawId(id);
              setHistoryId('');
              setTable('regions');
            }}
          />
        </aside>
        <main className="region-centre">
          <div className="region-work-title">
            <div>
              <small>RECORDING CLOCK / {scopeLabel}</small>
              <h1>
                {run
                  ? operationLabels[run.operation]
                  : activeSet
                    ? activeSet.name
                    : 'Signal workspace'}
              </h1>
            </div>
            <span className="region-sample-count">
              {source?.rows.toLocaleString() ?? '—'} samples · {raw.length}{' '}
              original signals
            </span>
          </div>
          {(inputSteps.length > 0 || parentSet) && (
            <nav className="region-lineage" aria-label="Input operation links">
              <span>{run ? 'Inputs from' : 'Segmented within'}</span>
              {inputSteps.map((item) => (
                <button key={item.id} onClick={() => showItem(item)}>
                  {String(history.indexOf(item) + 1).padStart(2, '0')} ·{' '}
                  {operationLabels[item.run!.operation]}{' '}
                  <ChevronRight size={12} />
                </button>
              ))}
              {!run && parentSet && (
                <button
                  onClick={() =>
                    showItem({
                      id: parentSet.id,
                      sequence: parentSet.sequence,
                      set: parentSet,
                    })
                  }
                >
                  {parentSet.name} v{parentSet.version}{' '}
                  <ChevronRight size={12} />
                </button>
              )}
            </nav>
          )}
          {notice && (
            <output className="region-notice">
              <Check size={14} />
              {notice}
              <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
                <X size={13} />
              </button>
            </output>
          )}
          <div className="region-view-controls">
            <RegionSelect
              label="View region set"
              value={activeSet?.id ?? 'none'}
              items={[
                { value: 'none', label: 'Full recording' },
                ...sourceSets.map((set) => ({
                  value: set.id,
                  label: `${set.name} v${set.version} · ${set.regions.length} regions`,
                })),
              ]}
              onChange={(id) => {
                setSetId(id);
                setRegionId('');
                setAxis('source');
                setParentFilter('');
                setPage(0);
                setTable('regions');
              }}
            />
            {!run && (
              <RegionSelect
                label="Plot signal"
                value={selectedRaw?.id ?? ''}
                items={raw.map((node) => ({
                  value: node.id,
                  label: `${node.name} [${node.unit}]`,
                }))}
                onChange={setRawId}
              />
            )}
            <RegionSelect
              label="Display time axis"
              value={axis}
              items={[
                { value: 'source', label: 'Original recording time' },
                { value: 'signal', label: 'Signal’s transformed time' },
                ...(activeRegion
                  ? [
                      {
                        value: 'relative',
                        label: 'Relative to selected region',
                      },
                    ]
                  : []),
              ]}
              onChange={setAxis}
            />
            <button
              className="secondary-button"
              onClick={() => {
                setRegionId('');
                setAxis('source');
              }}
            >
              Full overview
            </button>
          </div>
          <div className="region-selection-note">
            {activeRegion
              ? `Viewing ${activeRegion.name} · ${formatValue(activeRegion.start, 3)}–${formatValue(activeRegion.end, 3)} s`
              : 'Viewing the full recording'}
            <span>View selection does not change processing scope</span>
          </div>
          <div className="region-charts">
            {candidateIds.length > 6 && !activeRegion && (
              <p className="region-hint">
                Showing the first 6 traces. Select a region row to inspect
                another result.
              </p>
            )}
            {units.map((unit) => (
              <SignalChart
                key={unit}
                traces={chartIds
                  .filter((id) => graph.find(id).unit === unit && plots[id])
                  .map((id, index) => ({
                    node: graph.find(id),
                    plot: plots[id],
                    offset: offsetFor(id),
                    label:
                      regionIndex.get(bindings.get(id) ?? '')?.name ??
                      graph.find(id).name,
                    color: colors[index % colors.length],
                  }))}
                segments={overlay}
                range={range}
                onSegment={(id) => {
                  setRegionId(id);
                }}
              />
            ))}
            {!chartIds.length && (
              <p className="region-hint">
                This result family has no output for the selected region. Choose
                Full overview or another function.
              </p>
            )}
            {loading && (
              <div className="region-computing">
                Evaluating visible signals in the worker…{' '}
                <button onClick={engine.cancel}>Cancel</button>
              </div>
            )}
          </div>
          <div className="region-table-panel">
            <div className="region-table-toolbar">
              <Tabs
                value={table}
                onValueChange={(value) => {
                  setTable(value);
                  setPage(0);
                }}
              >
                <TabsList>
                  <TabsTrigger value="regions">
                    Regions {activeSet?.regions.length ?? 0}
                  </TabsTrigger>
                  <TabsTrigger value="results" disabled={!run}>
                    Results {run?.outputs.length ?? 0}
                  </TabsTrigger>
                  <TabsTrigger value="data">Input samples</TabsTrigger>
                </TabsList>
              </Tabs>
              <div>
                {table === 'regions' && activeSet && (
                  <>
                    <button
                      onClick={() =>
                        segmentWithin(activeSet.id, activeRegion?.id)
                      }
                    >
                      <Scissors size={13} />
                      {activeRegion
                        ? 'Segment this region'
                        : 'Segment within set'}
                    </button>
                    <button
                      onClick={() => chooseFunction('smooth', activeSet.id)}
                    >
                      <Sigma size={13} />
                      Process regions
                    </button>
                  </>
                )}
                {table === 'results' && run && (
                  <button onClick={() => void exportResults()}>
                    <Download size={13} />
                    Export results
                  </button>
                )}
              </div>
            </div>
            {table === 'regions' ? (
              <>
                {parentSet && (
                  <div className="region-parent-filter">
                    <RegionSelect
                      label="Group / filter by parent"
                      value={parentFilter}
                      items={[
                        {
                          value: '',
                          label: `All ${parentSet.name} v${parentSet.version} parents`,
                        },
                        ...parentSet.regions.map((region) => ({
                          value: region.id,
                          label: region.name,
                        })),
                      ]}
                      onChange={(value) => {
                        setParentFilter(value);
                        setPage(0);
                      }}
                    />
                    <span>Children use their parent’s immutable version.</span>
                  </div>
                )}
                <div className="region-table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Region</TableHead>
                        <TableHead>Parent</TableHead>
                        <TableHead>Start (s)</TableHead>
                        <TableHead>End (s)</TableHead>
                        <TableHead>Duration (s)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {regionRows.map((region) => (
                        <TableRow
                          key={region.id}
                          data-state={
                            region.id === regionId ? 'selected' : undefined
                          }
                        >
                          <TableCell>
                            <button
                              className="region-table-link"
                              onClick={() => setRegionId(region.id)}
                            >
                              {region.name}
                            </button>
                          </TableCell>
                          <TableCell>
                            {regionIndex.get(region.parentRegionId ?? '')
                              ?.name ?? 'Recording'}
                          </TableCell>
                          <TableCell>{formatValue(region.start, 3)}</TableCell>
                          <TableCell>{formatValue(region.end, 3)}</TableCell>
                          <TableCell>
                            {formatValue(region.end - region.start, 3)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {!rows.length && (
                    <p className="region-empty">
                      Create a region set to mark reusable time intervals. No
                      signal copies are created.
                    </p>
                  )}
                </div>
              </>
            ) : table === 'results' ? (
              <div className="region-table-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Region / input</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Minimum</TableHead>
                      <TableHead>Maximum</TableHead>
                      {run?.operation !== 'min-max' && (
                        <TableHead>Mean</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resultRows.map((output) => {
                      const node = graph.find(output.signalId),
                        summary = plots[output.signalId]?.summary;
                      return (
                        <TableRow key={output.signalId}>
                          <TableCell>
                            <button
                              className="region-table-link"
                              onClick={() => {
                                if (output.regionId) {
                                  setRegionId(output.regionId);
                                  setSetId(run?.regionSetId ?? 'none');
                                } else setRegionId('');
                              }}
                            >
                              {regionIndex.get(output.regionId ?? '')?.name ??
                                'Full input'}
                              <small>{graph.find(output.inputId).name}</small>
                            </button>
                          </TableCell>
                          <TableCell>{node.unit}</TableCell>
                          <TableCell>
                            {formatValue(summary?.min ?? NaN, 3)}
                          </TableCell>
                          <TableCell>
                            {formatValue(summary?.max ?? NaN, 3)}
                          </TableCell>
                          {run?.operation !== 'min-max' && (
                            <TableCell>
                              {formatValue(
                                summary?.weightedMean ?? summary?.mean ?? NaN,
                                3,
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="region-table-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Input sample · full input extent</TableHead>
                      <TableHead>Signal time (s)</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {samplesReady &&
                      samples.rows.map(([time, value], index) => (
                        <TableRow key={index}>
                          <TableCell>{page * 100 + index + 1}</TableCell>
                          <TableCell>{formatValue(time, 5)}</TableCell>
                          <TableCell>{formatValue(value, 5)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="region-pagination">
              <span>
                {table === 'data'
                  ? `Samples ${page * 100 + 1}–${page * 100 + (samplesReady ? samples.rows.length : 0)}`
                  : `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, table === 'results' ? (run?.outputs.length ?? 0) : rows.length)} · ${table === 'results' ? 'result rows' : 'regions'}`}
              </span>
              <button
                aria-label="Previous table page"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                aria-label="Next table page"
                disabled={
                  table === 'data'
                    ? !samplesReady || !samples.more
                    : currentPage >= pages - 1
                }
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </main>
        <aside className="region-inspector">
          <div className="region-panel-heading">
            FUNCTION SETTINGS
            <button
              aria-label="Start a new function"
              onClick={() => chooseFunction('smooth')}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="region-inspector-scroll">
            {source &&
              (mode === 'regions' ? (
                <RegionEditor
                  key={`regions:${source.id}:${editor.nonce}`}
                  project={project}
                  source={source}
                  saved={editor.savedSet}
                  parentId={editor.parentId}
                  parentRegionId={editor.parentRegionId}
                  busy={engine.busy || !engine.ready}
                  onPreview={async (settings) => {
                    const response = await engine.preview({
                      type: 'region-preview',
                      settings,
                    });
                    if (response.type !== 'region-plan')
                      throw new Error('Unexpected preview response.');
                    return response.plan;
                  }}
                  onCreate={async (settings) => {
                    const next = await engine.mutate(
                      { type: 'region-create', settings },
                      'Creating region pointers…',
                    );
                    const set = next.regionSets!.at(-1)!;
                    showItem({ id: set.id, sequence: set.sequence, set });
                    setNotice(
                      `${set.regions.length} regions created · ${set.name} v${set.version}. Select a row to inspect it.`,
                    );
                  }}
                />
              ) : (
                <RegionFunctionEditor
                  key={`function:${source.id}:${editor.nonce}`}
                  project={project}
                  source={source}
                  operation={editor.operation}
                  inputKey={
                    editor.inputKey || `signal:${selectedRaw?.id ?? ''}`
                  }
                  regionSetId={editor.regionSetId}
                  saved={editor.savedRun}
                  busy={engine.busy || !engine.ready}
                  onApply={async (settings) => {
                    const next = await engine.mutate(
                      { type: 'region-function', settings },
                      'Creating scoped results…',
                    );
                    const run = next.functionRuns!.at(-1)!;
                    showItem({ id: run.id, sequence: run.sequence, run });
                    setNotice(
                      `${operationLabels[run.operation]} created · ${run.outputs.length} results${run.skipped ? ` · ${run.skipped} empty scopes excluded` : ''}.`,
                    );
                  }}
                />
              ))}
            {run && (
              <div className="region-provenance">
                <strong>Saved inputs</strong>
                {run.inputIds.slice(0, 8).map((id) => (
                  <div key={id}>{graph.find(id).name}</div>
                ))}
                {run.inputIds.length > 8 && (
                  <div>+ {run.inputIds.length - 8} inputs</div>
                )}
                {!!run.secondaryIds?.length && (
                  <>
                    <strong>Second inputs</strong>
                    {run.secondaryIds.slice(0, 8).map((id) => (
                      <div key={id}>{graph.find(id).name}</div>
                    ))}
                  </>
                )}
                {run.regionSetId && (
                  <button
                    onClick={() => {
                      const set = sourceSets.find(
                        (item) => item.id === run.regionSetId,
                      );
                      if (set)
                        showItem({ id: set.id, sequence: set.sequence, set });
                    }}
                  >
                    Regions:{' '}
                    {
                      sourceSets.find((item) => item.id === run.regionSetId)
                        ?.name
                    }{' '}
                    v
                    {
                      sourceSets.find((item) => item.id === run.regionSetId)
                        ?.version
                    }{' '}
                    →
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
      {(engine.error || plotError?.key === idsKey) && (
        <div className="region-error-banner" role="alert">
          {engine.error || plotError?.message}
          <button
            aria-label="Dismiss error"
            onClick={() => {
              engine.setError('');
              setPlotError(undefined);
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <footer className="region-footer">
        <span>
          <i />
          {engine.busy || loading ? engine.status : 'Ready · local processing'}
        </span>
        <span>
          {project.regionSets?.length ?? 0} region sets ·{' '}
          {project.functionRuns?.length ?? 0} functions · original data
          preserved
        </span>
        {(engine.busy || loading) && (
          <button onClick={engine.cancel}>Cancel processing</button>
        )}
      </footer>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="workbench-dialog">
          <DialogTitle>Signals, regions and function history</DialogTitle>
          <DialogDescription>
            Regions are time pointers on an immutable recording. Functions
            choose which signals to process within them.
          </DialogDescription>
          <ol className="region-help">
            <li>
              Choose a worked example, then select a function in the history to
              see its actual settings.
            </li>
            <li>
              Select a region row to view it. This never changes the processing
              scope.
            </li>
            <li>
              Use Segment within set or Segment this region to create child
              regions. Relative ranges start at each parent’s beginning.
            </li>
            <li>
              Use Process regions to apply a function independently within them.
              Existing filtered inputs retain their earlier history; the new
              function resets at each region start.
            </li>
            <li>
              Min / Max produces a result table. Select its rows to inspect the
              corresponding region.
            </li>
            <li>
              Revising region settings creates another version. Existing
              children and calculations stay attached to their original version.
            </li>
          </ol>
          <p className="region-hint">
            New intervals include the start and exclude the end, except at an
            inclusive recording boundary. Imported older regions retain their
            original endpoint rules. Regions may overlap; results stay separate.
            The prototype keeps data in local IndexedDB and processes it in a
            worker; multi-gigabyte throughput has not yet been benchmarked.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
