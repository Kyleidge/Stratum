'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlignHorizontalJustifyStart,
  Calculator,
  ChartScatter,
  Crop,
  Eye,
  Layers,
  LoaderCircle,
  Waves,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCount } from '@/lib/format-count';
import NameField from './name-field';
import { SignalGraph } from '@/lib/signal-graph';
import { WorkflowIndex } from '@/lib/workflow-history';
import type {
  EngineRequest,
  EngineResponse,
  Plot,
  Project,
} from '@/lib/signal-types';
import type { TimeAnchor, TimeReference, TimeSettings } from '@/lib/time-types';
import { referenceClock } from '@/lib/time-types';
import { alignedReference, groupClock } from '@/lib/time-model';
import { describeClock } from '@/lib/clock-time';
import { RegionNumber, RegionSelect, finite } from './region-controls';
import OperationCards from './operation-cards';
import OperationInputs from './operation-inputs';
import PreviewLanes, { type PreviewTrace } from './preview-lanes';
import WorkflowList from './workflow-list';
import { randomId } from '@/lib/random-id';

type Mode = 'overlay' | TimeSettings['kind'];
type AnchorForm = {
  mode: 'start' | 'clock' | 'point' | 'offset' | 'event';
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

/** Plain-language choices; the default creates aligned signals. */
const MODES: {
  value: Mode;
  label: string;
  hint: string;
  visual: ReactNode;
}[] = [
  {
    value: 'align',
    label: 'Align',
    hint: 'Line up start times or events',
    visual: <AlignHorizontalJustifyStart size={20} />,
  },
  {
    value: 'resample',
    label: 'Same sample times',
    hint: 'Resample onto one time grid',
    visual: <ChartScatter size={20} />,
  },
  {
    value: 'combine',
    label: 'Calculate A and B',
    hint: 'A − B, A + B, A × B or A / B',
    visual: <Calculator size={20} />,
  },
  {
    value: 'crop',
    label: 'Cut to interval',
    hint: 'Keep one shared time window',
    visual: <Crop size={20} />,
  },
  {
    value: 'overlay',
    label: 'Overlay only',
    hint: 'Look without saving',
    visual: <Layers size={20} />,
  },
];
const PLOT_LIMIT = 8;

export default function TimeWorkbench({
  project,
  initialIds,
  inputNote,
  saved,
  initialMode = 'align',
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
  /** Edit title and impact text naming the step and its dependents. */
  editing?: { title: string; impact: string };
  busy: boolean;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  /** `name`: a name chosen for a new step (`chosenNames`). */
  onApply: (settings: TimeSettings, name?: string) => Promise<void>;
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
  const [stepName, setStepName] = useState('');
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
  // Recordings that each know their clock time line up by it by default.
  const clockDefault =
    !bySignal &&
    groups.length > 1 &&
    groups.every((group) =>
      referenceClock(graph.timeReferences.get(group.inputIds[0])),
    );
  const fallbackAnchor = (): AnchorForm => ({
    ...blankAnchor(),
    mode: clockDefault ? 'clock' : 'start',
  });
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
  const [newReferenceId] = useState(() => randomId());
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
  const plotIds = ids.slice(0, PLOT_LIMIT),
    plotKey = JSON.stringify(plotIds);
  useEffect(() => {
    const plotIds = JSON.parse(plotKey) as string[];
    if (!plotIds.length) return;
    let alive = true;
    void request({ type: 'view', ids: plotIds })
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
  }, [plotKey, request, project]);
  const sourceName = (id: string) =>
    project.sources.find((source) => source.id === graph.find(id).sourceId)
      ?.name ?? 'Workspace';
  // Name the recording only when the chosen signals come from several.
  const severalRecordings =
    new Set(ids.map((id) => graph.find(id).sourceId)).size > 1;
  const label = (id: string) =>
    severalRecordings
      ? `${sourceName(id)} · ${index.label(id)}`
      : index.label(id);
  const filtered = project.nodes.filter((node) =>
    `${index.label(node.id)} ${sourceName(node.id)} ${node.unit}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 30) - 1),
  );
  const patchAnchor = (key: string, patch: Partial<AnchorForm>) =>
    setAnchors((old) => ({
      ...old,
      [key]: { ...(old[key] ?? fallbackAnchor()), ...patch },
    }));
  const byClock = groups.some(
    (group) => (anchors[group.key] ?? fallbackAnchor()).mode === 'clock',
  );
  /** The saved settings; throws a plain reason while they are incomplete. */
  function build(): TimeSettings | undefined {
    if (!ids.length) throw new Error('Choose at least one signal.');
    if (mode === 'align') {
      const reference =
        references.find((ref) => ref.id === referenceId) ??
        (saved?.kind === 'align' && saved.reference.id === referenceId
          ? saved.reference
          : {
              id: newReferenceId,
              name: name.trim(),
              kind: byClock ? 'absolute' : referenceKind,
            });
      if (!reference.name) throw new Error('Name the new timeline.');
      return {
        kind: 'align',
        reference,
        target: finite(target),
        secondTarget: drift ? finite(secondTarget) : undefined,
        groups: groups.map((group) => {
          const form = anchors[group.key] ?? fallbackAnchor();
          if (form.mode === 'event' && !form.trigger)
            throw new Error(
              'Choose the signal whose crossing marks the event.',
            );
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
              : form.mode === 'start' || form.mode === 'clock'
                ? { kind: form.mode }
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
    }
    if (mode === 'resample') {
      if (gridKind === 'reference' && !gridSignal)
        throw new Error('Choose the signal whose sample times to use.');
      return {
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
    }
    if (mode === 'combine') {
      if (ids.length !== 2)
        throw new Error(
          'Choose exactly two signals. Their order sets A and B.',
        );
      return {
        kind: 'combine',
        inputIds: [ids[0], ids[1]],
        operator: operator as Extract<
          TimeSettings,
          { kind: 'combine' }
        >['operator'],
      };
    }
    if (mode === 'crop')
      return {
        kind: 'crop',
        inputIds: ids,
        start: finite(start),
        end: finite(end),
      };
    return undefined;
  }
  let settings: TimeSettings | undefined;
  let blocked = '';
  try {
    settings = build();
  } catch (caught) {
    blocked =
      caught instanceof Error ? caught.message : 'Complete the settings.';
  }
  async function apply() {
    setError('');
    try {
      const next = build();
      if (next) await onApply(next, editing ? undefined : stepName);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to process signals.',
      );
    }
  }
  const outputs = mode === 'combine' ? 1 : ids.length;
  const operatorSymbol =
    { difference: 'A − B', sum: 'A + B', product: 'A × B', ratio: 'A / B' }[
      operator
    ] ?? operator;
  const timelineName =
    referenceId === 'new'
      ? name.trim()
      : (references.find((ref) => ref.id === referenceId)?.name ??
        (saved?.kind === 'align' ? saved.reference.name : ''));
  const summary =
    mode === 'overlay'
      ? 'Overlay only: nothing is saved. Choose Align to create signals.'
      : mode === 'align'
        ? `${formatCount(outputs, 'aligned signal')} on “${timelineName}”`
        : mode === 'resample'
          ? `${formatCount(outputs, 'resampled signal')} · ${start}–${end} s${gridKind === 'uniform' ? ` at ${rate} Hz` : ''}`
          : mode === 'combine'
            ? `1 signal: ${operatorSymbol}`
            : `${formatCount(outputs, 'cut signal')} · ${start}–${end} s`;
  const differentClocks =
    new Set(ids.map((id) => graph.timeReferences.get(id)?.id)).size > 1;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="workflow-dialog workflow-range-dialog workflow-operation-dialog time-dialog"
        showCloseButton={!busy}
      >
        <DialogTitle>{editing?.title ?? 'Compare & align'}</DialogTitle>
        <OperationInputs
          items={ids.map((id) => ({
            id,
            label: label(id),
            title: `${sourceName(id)} · ${index.label(id)}`,
          }))}
          empty="No signals yet. Choose them below."
          onRemove={
            busy
              ? undefined
              : (id) => setIds((old) => old.filter((item) => item !== id))
          }
        />
        <DialogDescription>
          {editing?.impact ??
            'Line up signals from different recordings or time grids, then save the result as new signals. Inputs stay unchanged.'}
        </DialogDescription>
        {inputNote && <p className="workflow-drop-note">{inputNote}</p>}
        <div className="operation-editor">
          <div className="operation-body">
            <div className="operation-layout">
              <fieldset
                disabled={busy}
                className="workflow-function-editor time-controls"
              >
                <OperationCards
                  label="Comparison"
                  category="Compare"
                  value={mode}
                  items={MODES}
                  disabled={busy || !!editing}
                  onChange={(value) => {
                    setMode(value as Mode);
                    setError('');
                  }}
                />
                <details
                  className="time-picker"
                  open={ids.length === 0 || undefined}
                >
                  <summary>
                    {formatCount(ids.length, 'signal')} chosen · add signals
                    from any recording
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
                        setIds([
                          ...new Set([...ids, ...filtered.map((n) => n.id)]),
                        ])
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
                  {filtered
                    .slice(safePage * 30, (safePage + 1) * 30)
                    .map((node) => (
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
                          {index.label(node.id)}
                          <small>
                            {sourceName(node.id)} · {node.unit || 'no unit'} ·{' '}
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
                <div className="signal-operation-settings">
                  <div className="signal-settings-heading">
                    <strong>
                      {MODES.find((item) => item.value === mode)?.label}
                    </strong>
                  </div>
                  {mode === 'overlay' && (
                    <p>
                      Each signal keeps its own sample times. Different units
                      get their own lane on the same time axis. Nothing is
                      saved.
                    </p>
                  )}
                  {mode === 'align' && (
                    <AlignSettings
                      {...{
                        project,
                        graph,
                        index,
                        saved,
                        references,
                        referenceId,
                        setReferenceId,
                        name,
                        setName,
                        referenceKind,
                        setReferenceKind,
                        target,
                        setTarget,
                        bySignal,
                        setBySignal,
                        drift,
                        setDrift,
                        secondTarget,
                        setSecondTarget,
                        groups,
                        anchors,
                        patchAnchor,
                        fallbackAnchor,
                        byClock,
                      }}
                    />
                  )}
                  {(mode === 'resample' || mode === 'crop') && (
                    <>
                      <div className="time-fields">
                        <RegionNumber
                          label="Start time"
                          value={start}
                          onChange={setStart}
                        />
                        <RegionNumber
                          label="End time"
                          value={end}
                          onChange={setEnd}
                        />
                      </div>
                      <button
                        className="workflow-link"
                        type="button"
                        onClick={() => {
                          setStart(String(overlap[0]));
                          setEnd(String(overlap[1]));
                        }}
                      >
                        Use the time all signals share
                      </button>
                      {overlap[1] < overlap[0] && (
                        <p className="time-advice">
                          These signals share no time on their current axes.
                          Align them first.
                        </p>
                      )}
                    </>
                  )}
                  {mode === 'resample' && (
                    <>
                      <RegionSelect
                        label="Sample times"
                        value={gridKind}
                        onChange={setGridKind}
                        items={[
                          {
                            value: 'uniform',
                            label: 'Evenly spaced, at a rate I choose',
                          },
                          {
                            value: 'reference',
                            label: 'The same times as another signal',
                          },
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
                              label: `${sourceName(node.id)} · ${index.label(node.id)}`,
                            })),
                          ]}
                        />
                      )}
                      <div className="time-fields">
                        <RegionSelect
                          label="Between samples"
                          value={interpolation}
                          onChange={setInterpolation}
                          items={[
                            {
                              value: 'linear',
                              label: 'Straight line · measurements',
                            },
                            {
                              value: 'previous',
                              label: 'Hold the last value · states, commands',
                            },
                            { value: 'nearest', label: 'Nearest sample' },
                          ]}
                        />
                        <RegionNumber
                          label="Leave gaps longer than"
                          value={gap}
                          onChange={setGap}
                        />
                      </div>
                      <p>
                        Outside a signal’s own time span, and across longer
                        gaps, values stay missing.
                      </p>
                      <label className="time-check" htmlFor="time-filter">
                        <Checkbox
                          id="time-filter"
                          checked={filter}
                          onCheckedChange={(value) => setFilter(!!value)}
                        />
                        Smooth before lowering the rate (anti-alias filter)
                      </label>
                      <p className="time-advice">
                        When lowering the rate of a measured signal, smooth it
                        first. Filtering needs evenly spaced input and leaves
                        the first and last samples missing.
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
                        A: {ids[0] ? label(ids[0]) : 'Choose a first signal'}
                        <br />
                        B: {ids[1] ? label(ids[1]) : 'Choose a second signal'}
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
                        A and B need the same timeline and identical sample
                        times: align and resample them first. Missing samples
                        and division by zero give missing values.
                      </p>
                    </>
                  )}
                  {!editing && mode !== 'overlay' && (
                    <NameField
                      value={stepName}
                      onChange={setStepName}
                      kind="signal"
                      count={outputs}
                      disabled={busy}
                    />
                  )}
                </div>
              </fieldset>
              <section className="operation-preview" aria-label="Preview">
                <TimePreview
                  mode={mode}
                  ids={plotIds}
                  total={ids.length}
                  plots={plots?.key === plotKey ? plots : undefined}
                  graph={graph}
                  label={label}
                  settings={settings}
                  start={start}
                  end={end}
                  differentClocks={differentClocks}
                />
              </section>
            </div>
          </div>
          <div className="operation-footer">
            <p className="operation-footer-summary" aria-live="polite">
              {error ? (
                <span
                  className="operation-footer-reason"
                  role="alert"
                  data-error
                >
                  {error}
                </span>
              ) : blocked ? (
                <span className="operation-footer-reason">{blocked}</span>
              ) : (
                summary
              )}
            </p>
            {mode !== 'overlay' && (
              <button
                type="button"
                className="primary-button"
                disabled={!settings || busy}
                onClick={() => void apply()}
              >
                <Waves size={15} />
                {editing
                  ? 'Save changes and recalculate'
                  : `Create ${formatCount(outputs, 'derived signal')}`}
              </button>
            )}
          </div>
        </div>
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

function AlignSettings({
  project,
  graph,
  index,
  saved,
  references,
  referenceId,
  setReferenceId,
  name,
  setName,
  referenceKind,
  setReferenceKind,
  target,
  setTarget,
  bySignal,
  setBySignal,
  drift,
  setDrift,
  secondTarget,
  setSecondTarget,
  groups,
  anchors,
  patchAnchor,
  fallbackAnchor,
  byClock,
}: {
  project: Project;
  graph: SignalGraph;
  index: WorkflowIndex;
  saved?: TimeSettings;
  references: TimeReference[];
  referenceId: string;
  setReferenceId: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  referenceKind: TimeReference['kind'];
  setReferenceKind: (value: TimeReference['kind']) => void;
  target: string;
  setTarget: (value: string) => void;
  bySignal: boolean;
  setBySignal: (value: boolean) => void;
  drift: boolean;
  setDrift: (value: boolean) => void;
  secondTarget: string;
  setSecondTarget: (value: string) => void;
  groups: { key: string; inputIds: string[] }[];
  anchors: Record<string, AnchorForm>;
  patchAnchor: (key: string, patch: Partial<AnchorForm>) => void;
  fallbackAnchor: () => AnchorForm;
  /** Some group lines up by clock time, so the timeline tells clock time. */
  byClock: boolean;
}) {
  return (
    <>
      <RegionSelect
        label="Timeline for the results"
        value={referenceId}
        onChange={setReferenceId}
        items={[
          { value: 'new', label: 'A new timeline' },
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
          {byClock ? (
            <p>
              Clock time: time 0 is the earliest first sample, and times show as
              clock times.
            </p>
          ) : (
            <RegionSelect
              label="Times on this timeline are"
              value={referenceKind}
              onChange={(value) =>
                setReferenceKind(value as TimeReference['kind'])
              }
              items={[
                {
                  value: 'relative',
                  label: 'Seconds from an event',
                },
                {
                  value: 'absolute',
                  label: 'Clock time · Unix seconds',
                },
              ]}
            />
          )}
        </div>
      )}
      <RegionNumber
        label="Line anchors up at"
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
        Also correct clock drift using a second matching point
      </label>
      {drift && (
        <>
          <RegionNumber
            label="Second points line up at"
            value={secondTarget}
            onChange={setSecondTarget}
          />
          <p>
            Correcting drift stretches time, so it changes durations, rates and
            integrals. Use points you know happened together.
          </p>
        </>
      )}
      <WorkflowList
        items={groups}
        summary={`Anchors · ${formatCount(groups.length, 'group')}`}
        initialOpen
      >
        {(visible) =>
          visible.map((group) => {
            const form = anchors[group.key] ?? fallbackAnchor();
            const clock = referenceClock(
              graph.timeReferences.get(group.inputIds[0]),
            );
            const patch = (value: Partial<AnchorForm>) =>
              patchAnchor(group.key, value);
            return (
              <section className="time-group" key={group.key}>
                <strong>
                  {bySignal
                    ? index.label(group.inputIds[0])
                    : graph.timeReferences.get(group.inputIds[0])?.name}{' '}
                  · {formatCount(group.inputIds.length, 'signal')}
                </strong>
                <RegionSelect
                  label="Anchor"
                  value={form.mode}
                  onChange={(value) =>
                    patch({ mode: value as AnchorForm['mode'] })
                  }
                  items={[
                    ...(clock || form.mode === 'clock'
                      ? [{ value: 'clock', label: 'By clock time' }]
                      : []),
                    { value: 'start', label: 'Where the signal starts' },
                    { value: 'offset', label: 'Shift by a fixed time' },
                    { value: 'point', label: 'A time I enter' },
                    { value: 'event', label: 'When a signal crosses a level' },
                  ]}
                />
                {form.mode === 'clock' && (
                  <p>
                    {clock
                      ? `Starts ${describeClock(clock, graph.ranges.get(group.inputIds[0])?.[0] ?? 0)}`
                      : 'These signals have no clock time. Choose another anchor.'}
                  </p>
                )}
                {form.mode !== 'start' && form.mode !== 'clock' && (
                  <RegionNumber
                    label={
                      form.mode === 'offset'
                        ? 'Shift by'
                        : form.mode === 'event'
                          ? 'Then shift by'
                          : 'Anchor time'
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
                              graph.timeReferences.get(group.inputIds[0])?.id,
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
                          { value: 'rising', label: 'Rising above' },
                          { value: 'falling', label: 'Falling below' },
                        ]}
                      />
                      <RegionNumber
                        label="Threshold"
                        value={form.threshold}
                        onChange={(threshold) => patch({ threshold })}
                        unit=""
                      />
                      <RegionNumber
                        label="Crossing number"
                        value={form.occurrence}
                        onChange={(occurrence) => patch({ occurrence })}
                        unit=""
                      />
                    </div>
                  </>
                )}
                {drift && (
                  <RegionNumber
                    label="Second matching time"
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
  );
}

/**
 * Inputs on their current time axes. Alignment with start, offset or entered
 * anchors is drawn shifted for orientation only; the engine calculates the
 * saved result, and event anchors are found when the step is created.
 */
function TimePreview({
  mode,
  ids,
  total,
  plots,
  graph,
  label,
  settings,
  start,
  end,
  differentClocks,
}: {
  mode: Mode;
  ids: string[];
  total: number;
  plots?: { plots: Plot[]; error?: string };
  graph: SignalGraph;
  label: (id: string) => string;
  settings?: TimeSettings;
  start: string;
  end: string;
  differentClocks: boolean;
}) {
  const align =
    mode === 'align' && settings?.kind === 'align' ? settings : undefined;
  // Display-only time mapping per input, mirroring the saved recipe:
  // aligned = target + scale × (time − anchor).
  const mapping = new Map<string, (time: number) => number>();
  let events = false;
  let timeline: TimeReference | undefined;
  try {
    timeline = align ? alignedReference(graph, align) : undefined;
  } catch {
    timeline = undefined;
  }
  if (align)
    for (const group of align.groups) {
      const anchorTime = (anchor: TimeAnchor | undefined, target: number) => {
        if (anchor?.kind === 'clock') {
          try {
            return (
              timeline!.clock!.start -
              groupClock(graph, group.inputIds).start +
              target
            );
          } catch {
            return undefined;
          }
        }
        return anchor?.kind === 'point'
          ? anchor.time
          : anchor?.kind === 'start'
            ? graph.ranges.get(group.inputIds[0])?.[0]
            : undefined;
      };
      const first = anchorTime(group.anchor, align.target);
      const second = anchorTime(
        group.secondAnchor,
        align.secondTarget ?? align.target,
      );
      if (first === undefined) {
        events = true;
        continue;
      }
      const scale =
        group.secondAnchor && second !== undefined && second !== first
          ? (align.secondTarget! - align.target) / (second - first)
          : 1;
      for (const id of group.inputIds)
        mapping.set(id, (time) => align.target + scale * (time - first));
    }
  const traces: PreviewTrace[] = [];
  for (const [position, plot] of (plots?.plots ?? []).entries()) {
    const node = graph.nodes.get(plot.id);
    if (!node) continue;
    const map = mapping.get(plot.id);
    traces.push({
      node,
      plot: map
        ? {
            ...plot,
            points: plot.points.map(
              ([time, value]) => [map(time), value] as [number, number],
            ),
            summary: {
              ...plot.summary,
              start: map(plot.summary.start),
              end: map(plot.summary.end),
            },
          }
        : plot,
      label: label(plot.id),
      color: `var(--series-${(position % 8) + 1})`,
      width: 1.4,
    });
  }
  const span = (mode === 'crop' || mode === 'resample') && [
    Number(start),
    Number(end),
  ];
  const range: [number, number] | undefined =
    span &&
    Number.isFinite(span[0]) &&
    Number.isFinite(span[1]) &&
    span[1] > span[0]
      ? [span[0], span[1]]
      : traces.length
        ? [
            Math.min(...traces.map((trace) => trace.plot.summary.start)),
            Math.max(...traces.map((trace) => trace.plot.summary.end)),
          ]
        : undefined;
  const subject =
    mode === 'align' && mapping.size
      ? 'After alignment'
      : mode === 'crop' || mode === 'resample'
        ? 'Inside the chosen interval'
        : 'On their current times';
  return (
    <>
      <div className="operation-preview-heading">
        <strong>
          <Eye size={14} /> Preview
        </strong>
        <span className="operation-preview-subject">{subject}</span>
        {ids.length > 0 && !plots && (
          <output className="operation-preview-busy">
            <LoaderCircle size={13} /> Updating
          </output>
        )}
      </div>
      <div className="operation-preview-plot">
        {!ids.length ? (
          <output className="operation-preview-empty">
            Choose signals to preview them.
          </output>
        ) : plots?.error ? (
          <output className="operation-preview-error">{plots.error}</output>
        ) : traces.length && range && range[1] > range[0] ? (
          <PreviewLanes traces={traces} range={range} height={260} />
        ) : (
          <output className="operation-preview-empty">
            Loading the chosen signals…
          </output>
        )}
      </div>
      {total > ids.length && (
        <p className="operation-preview-summary">
          Showing the first {ids.length} of {formatCount(total, 'signal')}; all
          are processed.
        </p>
      )}
      {mode === 'align' && events && (
        <p className="input-hint">
          Event anchors are found when you create the step; the preview shows
          those signals on their current times.
        </p>
      )}
      {mode !== 'align' && differentClocks && (
        <p className="time-advice">
          These signals use different timelines. Align them before treating
          events as simultaneous.
        </p>
      )}
      <p className="input-hint operation-preview-help">
        {mode === 'align'
          ? 'Shifted from plot points for orientation; nothing is saved until you create the result.'
          : 'Nothing is saved until you create the result.'}
      </p>
    </>
  );
}
