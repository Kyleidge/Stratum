'use client';
import { useState } from 'react';
import { Eye, Scissors } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { RegionNumber, RegionSelect, finite } from './region-controls';
import type {
  Project,
  SegmentationDefinition,
  Source,
} from '@/lib/signal-types';
import type { RegionPlan, RegionSettings, RegionSet } from '@/lib/region-types';

export default function RegionEditor({
  project,
  source,
  saved,
  parentId,
  parentRegionId,
  busy,
  onPreview,
  onCreate,
}: {
  project: Project;
  source: Source;
  saved?: RegionSet;
  parentId?: string;
  parentRegionId?: string;
  busy: boolean;
  onPreview: (settings: RegionSettings) => Promise<RegionPlan>;
  onCreate: (settings: RegionSettings) => Promise<void>;
}) {
  const initial = saved?.definition;
  const initialParent = saved?.parentSetId ?? parentId ?? '';
  const [name, setName] = useState(
    saved?.name ?? (initialParent ? 'Subregions' : 'Regions'),
  );
  const [parent, setParent] = useState(initialParent);
  const [parentIds, setParentIds] = useState(
    saved?.parentRegionIds ?? (parentRegionId ? [parentRegionId] : []),
  );
  const [clock, setClock] = useState<'parent' | 'recording'>(
    saved?.timeReference ?? (initialParent ? 'parent' : 'recording'),
  );
  const [method, setMethod] = useState<SegmentationDefinition['method']>(
    initial?.method ?? (initialParent ? 'windows' : 'triggers'),
  );
  const initialTrigger = initial?.method === 'triggers' ? initial : undefined;
  const speed =
    project.nodes.find(
      (node) =>
        source.channels.includes(node.id) && node.unit.toLowerCase() === 'rpm',
    )?.id ?? source.channels[0];
  const [start, setStart] = useState({
    signalId: initialTrigger?.start.signalId ?? speed,
    edge: initialTrigger?.start.edge ?? 'rising',
    threshold: String(initialTrigger?.start.threshold ?? 900),
    offset: String(initialTrigger?.start.offset ?? 0),
  });
  const [end, setEnd] = useState({
    signalId: initialTrigger?.end.signalId ?? speed,
    edge: initialTrigger?.end.edge ?? 'falling',
    threshold: String(initialTrigger?.end.threshold ?? 900),
    offset: String(initialTrigger?.end.offset ?? 0),
  });
  const [minimum, setMinimum] = useState(
    String(initialTrigger?.minimumDuration ?? 0),
  );
  const [ranges, setRanges] = useState(
    initial?.method === 'ranges'
      ? initial.ranges.map((r) => r.join(', ')).join('\n')
      : initialParent
        ? '0, 10'
        : `${source.start}, ${Math.min(source.end, source.start + 30)}`,
  );
  const windows = initial?.method === 'windows' ? initial : undefined;
  const [from, setFrom] = useState(
    String(windows?.start ?? (initialParent ? 0 : source.start)),
  );
  const [to, setTo] = useState(
    String(
      windows?.end ?? (initialParent ? source.end - source.start : source.end),
    ),
  );
  const [duration, setDuration] = useState(String(windows?.duration ?? 10));
  const [step, setStep] = useState(String(windows?.step ?? 10));
  const [partial, setPartial] = useState(windows?.includePartial ?? true);
  const [boundary, setBoundary] = useState<'clip' | 'discard'>(
    initial?.boundary ?? 'clip',
  );
  const [preview, setPreview] = useState<{ key: string; plan: RegionPlan }>();
  const [error, setError] = useState('');
  const selectedParent = project.regionSets?.find((set) => set.id === parent);
  const key = JSON.stringify([
    name,
    parent,
    parentIds,
    clock,
    method,
    start,
    end,
    minimum,
    ranges,
    from,
    to,
    duration,
    step,
    partial,
    boundary,
  ]);
  const plan = preview?.key === key ? preview.plan : undefined;
  const signals = project.nodes
    .filter(
      (node) =>
        node.sourceId === source.id &&
        !node.internal &&
        node.operation !== 'crop',
    )
    .map((node) => ({
      value: node.id,
      label: `${node.name} [${node.unit}] · ${node.id.slice(0, 5)}`,
    }));
  function settings(): RegionSettings {
    let definition: SegmentationDefinition;
    if (method === 'triggers')
      definition = {
        method,
        boundary,
        start: {
          ...start,
          threshold: finite(start.threshold),
          offset: finite(start.offset),
        },
        end: {
          ...end,
          threshold: finite(end.threshold),
          offset: finite(end.offset),
        },
        minimumDuration: finite(minimum),
      };
    else if (method === 'windows')
      definition = {
        method,
        boundary,
        start: finite(from),
        end: finite(to),
        duration: finite(duration),
        step: finite(step),
        includePartial: partial,
      };
    else
      definition = {
        method,
        boundary,
        ranges: ranges
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const parts = line.split(',');
            if (parts.length !== 2)
              throw new Error('Enter one start, end pair per line.');
            return [finite(parts[0]), finite(parts[1])];
          }),
      };
    return {
      sourceId: source.id,
      name,
      definition,
      parentSetId: parent || undefined,
      parentRegionIds: parentIds.length ? parentIds : undefined,
      timeReference: parent ? clock : 'recording',
      previousId: saved?.id,
    };
  }
  async function run(previewOnly: boolean) {
    setError('');
    try {
      const next = settings();
      if (previewOnly) setPreview({ key, plan: await onPreview(next) });
      else await onCreate(next);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to create regions.',
      );
    }
  }
  function trigger(
    label: string,
    value: typeof start,
    update: (value: typeof start) => void,
  ) {
    const unit =
      project.nodes.find((node) => node.id === value.signalId)?.unit ?? '';
    return (
      <fieldset className="region-trigger">
        <legend>{label}</legend>
        <RegionSelect
          label={`${label} signal`}
          value={value.signalId}
          items={signals}
          onChange={(signalId) => update({ ...value, signalId })}
        />
        <RegionSelect
          label={`${label} crossing`}
          value={value.edge}
          items={[
            { value: 'rising', label: 'Rising above' },
            { value: 'falling', label: 'Falling below' },
          ]}
          onChange={(edge) => {
            if (edge === 'rising' || edge === 'falling')
              update({ ...value, edge });
          }}
        />
        <div className="region-pair">
          <RegionNumber
            label={`${label} threshold`}
            value={value.threshold}
            unit={unit}
            onChange={(threshold) => update({ ...value, threshold })}
          />
          <RegionNumber
            label={`${label} offset`}
            value={value.offset}
            onChange={(offset) => update({ ...value, offset })}
          />
        </div>
      </fieldset>
    );
  }
  return (
    <fieldset className="region-form" disabled={busy}>
      <div className="region-form-title">
        <Scissors size={17} />
        <strong>
          {saved
            ? `Segment · ${saved.name} v${saved.version}`
            : 'Create region set'}
        </strong>
      </div>
      <label className="region-field">
        <span>Region-set name</span>
        <input
          aria-label="Region-set name"
          className="region-text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <RegionSelect
        label="Segment within"
        value={parent}
        items={[
          { value: '', label: 'Full recording' },
          ...(project.regionSets ?? [])
            .filter((set) => set.sourceId === source.id)
            .map((set) => ({
              value: set.id,
              label: `${set.name} v${set.version} · ${set.regions.length} regions`,
            })),
        ]}
        onChange={(id) => {
          setParent(id);
          setParentIds([]);
          setClock(id ? 'parent' : 'recording');
          setFrom(id ? '0' : String(source.start));
          setTo(String(source.end - (id ? source.start : 0)));
        }}
      />
      {selectedParent && (
        <>
          <RegionSelect
            label="Parent regions"
            value={parentIds.length === 1 ? parentIds[0] : ''}
            items={[
              {
                value: '',
                label: `All ${selectedParent.regions.length} parent regions`,
              },
              ...selectedParent.regions.map((region) => ({
                value: region.id,
                label: `${region.name} · ${region.start.toFixed(2)}–${region.end.toFixed(2)} s`,
              })),
            ]}
            onChange={(id) => setParentIds(id ? [id] : [])}
          />
          <RegionSelect
            label="Range time reference"
            value={clock}
            items={[
              { value: 'parent', label: 'Relative to each parent start' },
              { value: 'recording', label: 'Original recording time' },
            ]}
            onChange={(next) => {
              if (next === 'parent' || next === 'recording') setClock(next);
            }}
          />
        </>
      )}
      <RegionSelect
        label="Segmentation method"
        value={method}
        items={[
          { value: 'triggers', label: 'Signal edge triggers' },
          { value: 'ranges', label: 'Manual time ranges' },
          { value: 'windows', label: 'Fixed-duration windows' },
        ]}
        onChange={(value) => {
          if (value === 'triggers' || value === 'ranges' || value === 'windows')
            setMethod(value);
        }}
      />
      {method === 'triggers' ? (
        <>
          {trigger('Start', start, setStart)}
          {trigger('End', end, setEnd)}
          <RegionNumber
            label="Minimum region duration"
            value={minimum}
            onChange={setMinimum}
          />
          <p className="region-hint">
            Each parent is scanned independently. A start must cross the
            threshold, then an end must cross later. Offsets apply after
            pairing.
          </p>
        </>
      ) : method === 'ranges' ? (
        <label className="region-field" htmlFor="region-ranges">
          <span>Start, end · seconds, one range per line</span>
          <Textarea
            id="region-ranges"
            aria-label="Manual region ranges"
            rows={4}
            value={ranges}
            onChange={(event) => setRanges(event.target.value)}
          />
        </label>
      ) : (
        <>
          <div className="region-pair">
            <RegionNumber label="Range start" value={from} onChange={setFrom} />
            <RegionNumber label="Range end" value={to} onChange={setTo} />
            <RegionNumber
              label="Window duration"
              value={duration}
              onChange={setDuration}
            />
            <RegionNumber
              label="Step between starts"
              value={step}
              onChange={setStep}
            />
          </div>
          <label className="region-check">
            <input
              type="checkbox"
              checked={partial}
              onChange={(event) => setPartial(event.target.checked)}
            />{' '}
            Include shorter final windows
          </label>
        </>
      )}
      <RegionSelect
        label="Outside parent boundaries"
        value={boundary}
        items={[
          { value: 'clip', label: 'Clip to the parent interval' },
          { value: 'discard', label: 'Discard incomplete intervals' },
        ]}
        onChange={(next) => {
          if (next === 'clip' || next === 'discard') setBoundary(next);
        }}
      />
      {plan && (
        <output className="region-preview">
          <strong>{plan.regions.length} regions</strong> ·{' '}
          {plan.regions.filter((region) => region.boundary?.clipped).length}{' '}
          clipped · {plan.skipped} excluded · {plan.incomplete} unpaired starts
          {plan.regions.slice(0, 5).map((region, i) => (
            <div key={i}>
              {region.start.toFixed(3)} → {region.end.toFixed(3)} s{' '}
              {region.parentRegionId && '· child region'}
            </div>
          ))}
          {plan.regions.length > 5 && (
            <div>+ {plan.regions.length - 5} more</div>
          )}
          {!plan.regions.length && (
            <div>
              Check trigger crossings or choose a time range inside the parent.
            </div>
          )}
        </output>
      )}
      {error && (
        <p className="region-error" role="alert">
          {error}
        </p>
      )}
      <div className="region-pair">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void run(true)}
        >
          <Eye size={14} />
          Preview
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void run(false)}
        >
          <Scissors size={14} />
          {saved ? 'Create new version' : 'Create regions'}
        </button>
      </div>
      <p className="region-hint">
        Creates time pointers only. Select signals when applying a function.{' '}
        {saved && 'Existing calculations retain this region-set version.'}
      </p>
    </fieldset>
  );
}
