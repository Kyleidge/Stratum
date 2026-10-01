'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { SignalGraph } from '@/lib/signal-graph';
import { WorkflowIndex } from '@/lib/workflow-history';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  Project,
} from '@/lib/signal-types';
import type { TimeAnchor, TimeReference, TimeSettings } from '@/lib/time-types';
import { RegionNumber, RegionSelect, finite } from './region-controls';
import SignalChart from './signal-chart';
import WorkflowList from './workflow-list';
import { TRACE_COLORS } from '@/lib/plot-scratchpad';

type Mode = 'overlay' | TimeSettings['kind'];
type AnchorForm = {
  mode: 'start' | 'point' | 'offset' | 'event';
  time: string;
  second: string;
  trigger: string;
  edge: 'rising' | 'falling';
  threshold: string;
  occurrence: string;
};
const blankAnchor = (): AnchorForm => ({
  mode: 'start',
  time: '0',
  second: '10',
  trigger: '',
  edge: 'rising',
  threshold: '0',
  occurrence: '1',
});

export default function TimeWorkbench({
  project,
  initialIds,
  inputNote,
  saved,
  initialMode = 'overlay',
  editing,
  busy,
  request,
  onApply,
  onClose,
  onCancel,
}: {
  project: Project;
  initialIds: string[];
  inputNote?: string;
  saved?: TimeSettings;
  initialMode?: Mode;
  editing?: boolean;
  busy: boolean;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  onApply: (settings: TimeSettings) => Promise<void>;
  onClose: () => void;
  onCancel: () => void;
}) {
  const graph = useMemo(() => new SignalGraph(project), [project]);
  const index = useMemo(() => new WorkflowIndex(project), [project]);
  const [mode, setMode] = useState<Mode>(saved?.kind ?? initialMode);
  const [ids, setIds] = useState<string[]>(
    saved
      ? saved.kind === 'align'
        ? saved.groups.flatMap((g) => g.inputIds)
        : saved.inputIds
      : initialIds,
  );
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [bySignal, setBySignal] = useState(
    saved?.kind === 'align' &&
      saved.groups.every((g) => g.inputIds.length === 1),
  );
  const groups = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const id of ids) {
      const key = bySignal ? id : graph.timeReferences.get(id)!.id;
      result.set(key, [...(result.get(key) ?? []), id]);
    }
    return [...result].map(([key, inputIds]) => ({ key, inputIds }));
  }, [ids, bySignal, graph]);
  const [anchors, setAnchors] = useState<Record<string, AnchorForm>>(() => {
    const result: Record<string, AnchorForm> = {};
    if (saved?.kind === 'align')
      for (const group of saved.groups) {
        const anchor = group.anchor;
        const key = saved.groups.every((g) => g.inputIds.length === 1)
          ? group.inputIds[0]
          : graph.timeReferences.get(group.inputIds[0])!.id;
        result[key] = {
          ...blankAnchor(),
          mode: anchor.kind === 'event' ? 'event' : anchor.kind,
          time: String(
            anchor.kind === 'point'
              ? anchor.time
              : anchor.kind === 'event'
                ? anchor.trigger.offset
                : 0,
          ),
          second: String(
            group.secondAnchor?.kind === 'point' ? group.secondAnchor.time : 10,
          ),
          ...(anchor.kind === 'event'
            ? {
                trigger: anchor.trigger.signalId,
                edge: anchor.trigger.edge,
                threshold: String(anchor.trigger.threshold),
                occurrence: String(anchor.occurrence),
              }
            : {}),
        };
      }
    return result;
  });
  const references = [
    ...new Map(
      [...graph.timeReferences.values()].map((ref) => [ref.id, ref]),
    ).values(),
  ];
  const [referenceId, setReferenceId] = useState(
    saved?.kind === 'align' ? saved.reference.id : 'new',
  );
  const [newReferenceId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(
    saved?.kind === 'align' ? saved.reference.name : 'Comparison time',
  );
  const [referenceKind, setReferenceKind] = useState<TimeReference['kind']>(
    saved?.kind === 'align' ? saved.reference.kind : 'relative',
  );
  const [target, setTarget] = useState(
    String(saved?.kind === 'align' ? saved.target : 0),
  );
  const [drift, setDrift] = useState(
    saved?.kind === 'align' && saved.secondTarget !== undefined,
  );
  const [secondTarget, setSecondTarget] = useState(
    String(saved?.kind === 'align' ? (saved.secondTarget ?? 10) : 10),
  );
  const bounds = ids.map((id) => graph.ranges.get(id)!);
  const overlap: [number, number] = bounds.length
    ? [
        Math.max(...bounds.map((r) => r[0])),
        Math.min(...bounds.map((r) => r[1])),
      ]
    : [0, 1];
  const [start, setStart] = useState(
    String(
      saved?.kind === 'resample'
        ? saved.grid.start
        : saved?.kind === 'crop'
          ? saved.start
          : overlap[0],
    ),
  );
  const [end, setEnd] = useState(
    String(
      saved?.kind === 'resample'
        ? saved.grid.end
        : saved?.kind === 'crop'
          ? saved.end
          : overlap[1],
    ),
  );
  const [gridKind, setGridKind] = useState<string>(
    saved?.kind === 'resample' ? saved.grid.kind : 'uniform',
  );
  const [gridSignal, setGridSignal] = useState(
    saved?.kind === 'resample' && saved.grid.kind === 'reference'
      ? saved.grid.signalId
      : (ids[0] ?? ''),
  );
  const [rate, setRate] = useState(
    String(
      saved?.kind === 'resample' && saved.grid.kind === 'uniform'
        ? saved.grid.rate
        : 20,
    ),
  );
  const [interpolation, setInterpolation] = useState<string>(
    saved?.kind === 'resample' ? saved.interpolation : 'linear',
  );
  const [gap, setGap] = useState(
    String(saved?.kind === 'resample' ? saved.maxGap : 1),
  );
  const [filter, setFilter] = useState(
    saved?.kind === 'resample' && !!saved.filter,
  );
  const [cutoff, setCutoff] = useState(
    String(saved?.kind === 'resample' ? (saved.filter?.cutoff ?? 8) : 8),
  );
  const [halfWidth, setHalfWidth] = useState(
    String(saved?.kind === 'resample' ? (saved.filter?.halfWidth ?? 32) : 32),
  );
  const [operator, setOperator] = useState<string>(
    saved?.kind === 'combine' ? saved.operator : 'difference',
  );
  const [plots, setPlots] = useState<{
    key: string;
    plots: Plot[];
    error?: string;
  }>();
  const plotIds = ids.slice(0, 8),
    plotKey = JSON.stringify(plotIds);
  useEffect(() => {
    if (mode !== 'overlay' || !ids.length) return;
    let alive = true;
    void request({ type: 'view', ids: JSON.parse(plotKey) as string[] })
      .then((response) => {
        if (alive && response.type === 'plots')
          setPlots({ key: plotKey, plots: response.plots });
      })
      .catch((caught: Error) => {
        if (alive) setPlots({ key: plotKey, plots: [], error: caught.message });
      });
    return () => {
      alive = false;
    };
  }, [mode, plotKey, request, project, ids.length]);
  const filtered = project.nodes.filter((node) =>
    `${index.label(node.id)} ${project.sources.find((s) => s.id === node.sourceId)?.name ?? 'Workspace'} ${node.unit}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 30) - 1),
  );
  const label = (id: string) =>
    `${project.sources.find((source) => source.id === graph.find(id).sourceId)?.name ?? 'Workspace'} · ${index.label(id)}`;
  const patchAnchor = (key: string, patch: Partial<AnchorForm>) =>
    setAnchors((old) => ({
      ...old,
      [key]: { ...(old[key] ?? blankAnchor()), ...patch },
    }));
  async function apply() {
    setError('');
    try {
      let settings: TimeSettings;
      if (mode === 'align') {
        const reference =
          references.find((ref) => ref.id === referenceId) ??
          (saved?.kind === 'align' && saved.reference.id === referenceId
            ? saved.reference
            : { id: newReferenceId, name: name.trim(), kind: referenceKind });
        settings = {
          kind: 'align',
          reference,
          target: finite(target),
          secondTarget: drift ? finite(secondTarget) : undefined,
          groups: groups.map((group) => {
            const form = anchors[group.key] ?? blankAnchor();
            const anchor: TimeAnchor =
              form.mode === 'event'
                ? {
                    kind: 'event',
                    trigger: {
                      signalId: form.trigger,
                      edge: form.edge,
                      threshold: finite(form.threshold),
                      offset: finite(form.time),
                    },
                    occurrence: finite(form.occurrence),
                  }
                : form.mode === 'start'
                  ? { kind: 'start' }
                  : {
                      kind: 'point',
                      time:
                        form.mode === 'offset'
                          ? finite(target) - finite(form.time)
                          : finite(form.time),
                    };
            return {
              inputIds: group.inputIds,
              anchor,
              secondAnchor: drift
                ? { kind: 'point' as const, time: finite(form.second) }
                : undefined,
            };
          }),
        };
      } else if (mode === 'resample')
        settings = {
          kind: 'resample',
          inputIds: ids,
          grid:
            gridKind === 'uniform'
              ? {
                  kind: 'uniform',
                  start: finite(start),
                  end: finite(end),
                  rate: finite(rate),
                }
              : {
                  kind: 'reference',
                  start: finite(start),
                  end: finite(end),
                  signalId: gridSignal,
                },
          interpolation: interpolation as Extract<
            TimeSettings,
            { kind: 'resample' }
          >['interpolation'],
          maxGap: finite(gap),
          filter: filter
            ? { cutoff: finite(cutoff), halfWidth: finite(halfWidth) }
            : undefined,
        };
      else if (mode === 'combine') {
        if (ids.length !== 2)
          throw new Error(
            'Choose exactly two signals. Their selection order sets A and B.',
          );
        settings = {
          kind: 'combine',
          inputIds: [ids[0], ids[1]],
          operator: operator as Extract<
            TimeSettings,
            { kind: 'combine' }
          >['operator'],
        };
      } else if (mode === 'crop')
        settings = {
          kind: 'crop',
          inputIds: ids,
          start: finite(start),
          end: finite(end),
        };
      else return;
      await onApply(settings);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to process signals.',
      );
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="workflow-dialog time-dialog"
        showCloseButton={!busy}
      >
        <DialogTitle>
          {editing ? 'Edit time operation' : 'Compare & align signals'}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? 'Saving rebuilds this operation and its dependent results. Undo restores the previous version.'
            : 'Choose signals from any source. Save alignment and resampling as reusable derived signals.'}
        </DialogDescription>
        {inputNote && <p className="workflow-drop-note">{inputNote}</p>}
        <fieldset disabled={busy} className="time-controls">
          <RegionSelect
            label="Time operation"
            value={mode}
            disabled={!!editing}
            onChange={(value) => {
              setMode(value as Mode);
              setError('');
            }}
            items={[
              { value: 'overlay', label: 'Overlay signals' },
              { value: 'align', label: 'Align time bases' },
              { value: 'resample', label: 'Resample to a shared grid' },
              { value: 'combine', label: 'Calculate between signals' },
              { value: 'crop', label: 'Crop comparison interval' },
            ]}
          />
          <details className="time-picker" open={ids.length === 0 || undefined}>
            <summary>
              {ids.length} selected signals · choose across sources
            </summary>
            <label className="region-field">
              <span>Find signals</span>
              <input
                aria-label="Find comparison signals"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div className="time-picker-actions">
              <button
                type="button"
                className="workflow-link"
                onClick={() =>
                  setIds([...new Set([...ids, ...filtered.map((n) => n.id)])])
                }
              >
                Select matching signals
              </button>
              <button
                type="button"
                className="workflow-link"
                onClick={() => setIds([])}
              >
                Clear selection
              </button>
            </div>
            {filtered.slice(safePage * 30, (safePage + 1) * 30).map((node) => (
              <label className="time-signal-choice" key={node.id}>
                <Checkbox
                  checked={ids.includes(node.id)}
                  onCheckedChange={(checked) =>
                    setIds((old) =>
                      checked
                        ? [...old, node.id]
                        : old.filter((id) => id !== node.id),
                    )
                  }
                />
                <span>
                  {label(node.id)}
                  <small>
                    {node.unit} · {graph.timeReferences.get(node.id)?.name} ·{' '}
                    {graph.ranges
                      .get(node.id)
                      ?.map((n) => Number(n.toFixed(5)))
                      .join(' to ')}{' '}
                    s
                  </small>
                </span>
              </label>
            ))}
            <div className="time-picker-actions">
              <button
                type="button"
                disabled={!safePage}
                onClick={() => setPage(safePage - 1)}
              >
                Previous
              </button>
              <span>
                Page {safePage + 1} of{' '}
                {Math.max(1, Math.ceil(filtered.length / 30))}
              </span>
              <button
                type="button"
                disabled={(safePage + 1) * 30 >= filtered.length}
                onClick={() => setPage(safePage + 1)}
              >
                Next
              </button>
            </div>
          </details>
          <WorkflowList items={ids} summary="Review selected inputs">
            {(visible) => (
              <ol>
                {visible.map((id) => (
                  <li key={id}>{label(id)}</li>
                ))}
              </ol>
            )}
          </WorkflowList>
          {mode === 'overlay' && (
            <>
              <p>
                Each trace keeps its own sample timestamps. Different units use
                separate plots on the same horizontal interval.
              </p>
              {new Set(ids.map((id) => graph.timeReferences.get(id)?.id)).size >
                1 && (
                <p className="time-advice">
                  These signals have different time references. This overlay
                  uses their current numeric times; align them before
                  interpreting events as simultaneous.
                </p>
              )}
              {ids.length > 8 && (
                <p>
                  Showing the first 8 selected signals. Narrow the selection to
                  inspect others.
                </p>
              )}
              {plots?.key !== plotKey ? (
                <p>Loading selected signals…</p>
              ) : plots.error ? (
                <p role="alert">{plots.error}</p>
              ) : (
                [...new Set(plotIds.map((id) => graph.find(id).unit))].map(
                  (unit) => (
                    <div key={unit}>
                      <div className="time-plot-unit">{unit || 'Value'}</div>
                      <SignalChart
                        fluid
                        heading={false}
                        height={190}
                        traces={plots.plots
                          .filter((p) => graph.find(p.id).unit === unit)
                          .map((plot, i) => ({
                            node: graph.find(plot.id),
                            plot,
                            label: label(plot.id),
                            color: TRACE_COLORS[i % TRACE_COLORS.length],
                          }))}
                        range={[
                          Math.min(
                            ...plotIds.map((id) => graph.ranges.get(id)![0]),
                          ),
                          Math.max(
                            ...plotIds.map((id) => graph.ranges.get(id)![1]),
                          ),
                        ]}
                        segments={[]}
                        onSegment={() => {}}
                      />
                      <ul className="time-legend">
                        {plotIds
                          .filter((id) => graph.find(id).unit === unit)
                          .map((id, i) => (
                            <li
                              key={id}
                              style={{
                                color: TRACE_COLORS[i % TRACE_COLORS.length],
                              }}
                            >
                              {label(id)}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ),
                )
              )}
            </>
          )}
          {mode === 'align' && (
            <>
              <RegionSelect
                label="Output time reference"
                value={referenceId}
                onChange={setReferenceId}
                items={[
                  { value: 'new', label: 'New comparison timeline' },
                  ...references.map((ref) => ({
                    value: ref.id,
                    label: ref.name,
                  })),
                  ...(saved?.kind === 'align' &&
                  !references.some((ref) => ref.id === saved.reference.id)
                    ? [
                        {
                          value: saved.reference.id,
                          label: saved.reference.name,
                        },
                      ]
                    : []),
                ]}
              />
              {referenceId === 'new' && (
                <div className="time-fields">
                  <label className="region-field">
                    <span>Timeline name</span>
                    <input
                      aria-label="Timeline name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <RegionSelect
                    label="Time meaning"
                    value={referenceKind}
                    onChange={(value) =>
                      setReferenceKind(value as TimeReference['kind'])
                    }
                    items={[
                      {
                        value: 'relative',
                        label: 'Seconds relative to an event',
                      },
                      {
                        value: 'absolute',
                        label: 'Absolute time · Unix seconds',
                      },
                    ]}
                  />
                </div>
              )}
              <RegionNumber
                label="First anchor maps to"
                value={target}
                onChange={setTarget}
              />
              <label className="time-check" htmlFor="time-by-signal">
                <Checkbox
                  id="time-by-signal"
                  checked={bySignal}
                  onCheckedChange={(value) => setBySignal(!!value)}
                />
                Align each signal separately (for repeated segments)
              </label>
              <label className="time-check" htmlFor="time-drift">
                <Checkbox
                  id="time-drift"
                  checked={drift}
                  onCheckedChange={(value) => setDrift(!!value)}
                />
                Correct clock rate using a second synchronization point
              </label>
              {drift && (
                <>
                  <RegionNumber
                    label="Second anchor maps to"
                    value={secondTarget}
                    onChange={setSecondTarget}
                  />
                  <p>
                    Clock correction changes elapsed time, rates and integrals.
                    Use known synchronization points.
                  </p>
                </>
              )}
              <WorkflowList
                items={groups}
                summary={`${groups.length} alignment groups · settings`}
                initialOpen
              >
                {(visible) =>
                  visible.map((group) => {
                    const form = anchors[group.key] ?? blankAnchor();
                    const patch = (value: Partial<AnchorForm>) =>
                      patchAnchor(group.key, value);
                    return (
                      <section className="time-group" key={group.key}>
                        <strong>
                          {bySignal
                            ? index.label(group.inputIds[0])
                            : graph.timeReferences.get(group.inputIds[0])
                                ?.name}{' '}
                          · {group.inputIds.length} signals
                        </strong>
                        <RegionSelect
                          label="Alignment method"
                          value={form.mode}
                          onChange={(value) =>
                            patch({ mode: value as AnchorForm['mode'] })
                          }
                          items={[
                            { value: 'start', label: 'Group start' },
                            { value: 'offset', label: 'Manual offset' },
                            { value: 'point', label: 'Selected timestamp' },
                            { value: 'event', label: 'Threshold event' },
                          ]}
                        />
                        {form.mode !== 'start' && (
                          <RegionNumber
                            label={
                              form.mode === 'offset'
                                ? 'Add time offset'
                                : form.mode === 'event'
                                  ? 'Event offset'
                                  : 'Input anchor time'
                            }
                            value={form.time}
                            onChange={(time) => patch({ time })}
                          />
                        )}
                        {form.mode === 'event' && (
                          <>
                            <RegionSelect
                              label="Event signal"
                              value={form.trigger}
                              onChange={(trigger) => patch({ trigger })}
                              items={[
                                { value: '', label: 'Choose signal' },
                                ...project.nodes
                                  .filter(
                                    (node) =>
                                      graph.timeReferences.get(node.id)?.id ===
                                      graph.timeReferences.get(
                                        group.inputIds[0],
                                      )?.id,
                                  )
                                  .map((node) => ({
                                    value: node.id,
                                    label: index.label(node.id),
                                  })),
                              ]}
                            />
                            <div className="time-fields">
                              <RegionSelect
                                label="Edge"
                                value={form.edge}
                                onChange={(edge) =>
                                  patch({ edge: edge as AnchorForm['edge'] })
                                }
                                items={[
                                  { value: 'rising', label: 'Rising' },
                                  { value: 'falling', label: 'Falling' },
                                ]}
                              />
                              <RegionNumber
                                label="Threshold"
                                value={form.threshold}
                                onChange={(threshold) => patch({ threshold })}
                                unit=""
                              />
                              <RegionNumber
                                label="Event occurrence"
                                value={form.occurrence}
                                onChange={(occurrence) => patch({ occurrence })}
                                unit=""
                              />
                            </div>
                          </>
                        )}
                        {drift && (
                          <RegionNumber
                            label="Second input anchor time"
                            value={form.second}
                            onChange={(second) => patch({ second })}
                          />
                        )}
                      </section>
                    );
                  })
                }
              </WorkflowList>
            </>
          )}
          {(mode === 'resample' || mode === 'crop') && (
            <>
              <div className="time-fields">
                <RegionNumber
                  label="Start time"
                  value={start}
                  onChange={setStart}
                />
                <RegionNumber label="End time" value={end} onChange={setEnd} />
              </div>
              <button
                className="workflow-link"
                type="button"
                onClick={() => {
                  setStart(String(overlap[0]));
                  setEnd(String(overlap[1]));
                }}
              >
                Use overlapping interval
              </button>
              {overlap[1] < overlap[0] && (
                <p className="time-advice">
                  No overlapping interval on the current axes. Align the signals
                  first.
                </p>
              )}
            </>
          )}
          {mode === 'resample' && (
            <>
              <RegionSelect
                label="Target grid"
                value={gridKind}
                onChange={setGridKind}
                items={[
                  { value: 'uniform', label: 'Uniform rate and shared start' },
                  { value: 'reference', label: 'Another signal’s timestamps' },
                ]}
              />
              {gridKind === 'uniform' ? (
                <RegionNumber
                  label="Output rate"
                  value={rate}
                  onChange={setRate}
                  unit="Hz"
                />
              ) : (
                <RegionSelect
                  label="Reference signal"
                  value={gridSignal}
                  onChange={setGridSignal}
                  items={[
                    { value: '', label: 'Choose signal' },
                    ...project.nodes.map((node) => ({
                      value: node.id,
                      label: label(node.id),
                    })),
                  ]}
                />
              )}
              <div className="time-fields">
                <RegionSelect
                  label="Interpolation"
                  value={interpolation}
                  onChange={setInterpolation}
                  items={[
                    {
                      value: 'linear',
                      label: 'Linear · continuous measurements',
                    },
                    {
                      value: 'previous',
                      label: 'Hold previous · states and commands',
                    },
                    { value: 'nearest', label: 'Nearest sample' },
                  ]}
                />
                <RegionNumber
                  label="Maximum interpolation gap"
                  value={gap}
                  onChange={setGap}
                />
              </div>
              <p>
                Outside the input interval and across longer gaps, output values
                stay missing. Sample timestamps come from the selected grid.
              </p>
              <label className="time-check" htmlFor="time-filter">
                <Checkbox
                  id="time-filter"
                  checked={filter}
                  onCheckedChange={(value) => setFilter(!!value)}
                />
                Apply anti-alias filter before resampling
              </label>
              <p className="time-advice">
                When reducing the rate of continuous measurements, enable
                filtering or use already filtered inputs. Filtering requires
                regularly spaced input and leaves unsupported edges missing.
              </p>
              {filter && (
                <div className="time-fields">
                  <RegionNumber
                    label="Filter cutoff"
                    value={cutoff}
                    onChange={setCutoff}
                    unit="Hz"
                  />
                  <RegionNumber
                    label="Filter half-width"
                    value={halfWidth}
                    onChange={setHalfWidth}
                    unit="samples"
                  />
                </div>
              )}
            </>
          )}
          {mode === 'combine' && (
            <>
              <p>
                A: {ids[0] ? label(ids[0]) : 'Select first signal'}
                <br />
                B: {ids[1] ? label(ids[1]) : 'Select second signal'}
              </p>
              <button
                type="button"
                className="workflow-link"
                disabled={ids.length !== 2}
                onClick={() => setIds([...ids].reverse())}
              >
                Swap A and B
              </button>
              <RegionSelect
                label="Calculation"
                value={operator}
                onChange={setOperator}
                items={[
                  { value: 'difference', label: 'A − B' },
                  { value: 'sum', label: 'A + B' },
                  { value: 'product', label: 'A × B' },
                  { value: 'ratio', label: 'A / B' },
                ]}
              />
              <p>
                Inputs must share a saved time reference and identical sample
                timestamps. Missing inputs and division by zero produce missing
                values.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="workflow-error">
              {error}
            </p>
          )}
          {mode !== 'overlay' && (
            <button
              type="button"
              className="primary-button"
              disabled={!ids.length || busy}
              onClick={() => void apply()}
            >
              {editing
                ? 'Save changes and recalculate'
                : 'Create derived signals'}
            </button>
          )}
        </fieldset>
        {busy && (
          <div className="workflow-processing">
            <output>Processing signals…</output>
            <button className="secondary-button" onClick={onCancel}>
              Cancel operation
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
