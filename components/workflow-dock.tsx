'use client';

import type { ReactNode } from 'react';
import { CopyPlus, PanelBottom, Settings2 } from 'lucide-react';
import { formatCount } from '@/lib/format-count';
import { operationLabels } from '@/lib/signal-explorer';
import type { Operation, SegmentationDefinition } from '@/lib/signal-types';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import { VALUE_FUNCTIONS, type WorkflowStep } from '@/lib/workflow-types';
import { formatValue } from './signal-chart';
import { SIGNAL_FUNCTIONS } from './signal-operation-palette';

export type DockTab = 'outputs' | 'samples' | 'settings';

/** Outputs, exact samples and saved settings of the selection, below Active. */
export default function WorkflowDock({
  tab,
  onTab,
  open,
  onOpen,
  outputCount,
  context,
  children,
}: {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  outputCount: number;
  context?: ReactNode;
  children: ReactNode;
}) {
  const tabs: [DockTab, string, number?][] = [
    ['outputs', 'Outputs', outputCount],
    ['samples', 'Samples'],
    ['settings', 'Settings'],
  ];
  return (
    <section
      className="plot-output-dock"
      data-open={open}
      aria-label="Step outputs, samples and settings"
    >
      <div className="plot-dock-head">
        <div role="tablist" aria-label="Step panel views">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              id={`plot-dock-${key}`}
              aria-selected={open && tab === key}
              aria-controls="plot-dock-panel"
              onClick={() => {
                onTab(key);
                onOpen(true);
              }}
            >
              {label}
              {count !== undefined && <span>{count.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        {context && <span className="plot-dock-context">{context}</span>}
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label={open ? 'Collapse step panel' : 'Expand step panel'}
          aria-expanded={open}
          aria-controls="plot-dock-panel"
          onClick={() => onOpen(!open)}
        >
          <PanelBottom size={15} />
        </button>
      </div>
      {open && (
        <div
          id="plot-dock-panel"
          role="tabpanel"
          aria-labelledby={`plot-dock-${tab}`}
          className="plot-dock-body"
        >
          {children}
        </div>
      )}
    </section>
  );
}

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
const seconds = (value: number) => `${formatValue(value, 3)} s`;
const signedSeconds = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatValue(Math.abs(value), 3)} s`;
/** `maxGap` → `Max gap`: parameter keys without a catalogued label. */
const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The step's function as named in the Derive and Value catalogs. */
export function stepFunctionName(step: WorkflowStep): string {
  return (
    (step.kind === 'value'
      ? VALUE_FUNCTIONS.find((spec) => spec.operation === step.operation)?.name
      : undefined) ??
    SIGNAL_FUNCTIONS.find((spec) => spec.operation === step.operation)?.name ??
    operationLabels[step.operation as Operation] ??
    step.operation
  );
}

type Row = [label: string, value: ReactNode, title?: string];

function segmentationRows(
  definition: SegmentationDefinition,
  signal: (id: string) => string,
): Row[] {
  const rows: Row[] = [];
  if (definition.method === 'triggers') {
    const trigger = (item: typeof definition.start): Row[1] => {
      const text = `${signal(item.signalId)} ${item.edge === 'rising' ? 'rises through' : 'falls through'} ${formatValue(item.threshold, 4)}${item.offset ? `, then ${signedSeconds(item.offset)}` : ''}`;
      return <span title={text}>{text}</span>;
    };
    rows.push(['Method', 'Start and end triggers']);
    rows.push(['Starts when', trigger(definition.start)]);
    rows.push(['Ends when', trigger(definition.end)]);
    rows.push(['Shortest segment', seconds(definition.minimumDuration)]);
  } else if (definition.method === 'ranges') {
    const shown = definition.ranges
      .slice(0, 6)
      .map(([start, end]) => `${formatValue(start, 3)}–${seconds(end)}`)
      .join(', ');
    const more = definition.ranges.length - 6;
    rows.push(['Method', 'Time ranges']);
    rows.push([
      'Ranges',
      `${formatCount(definition.ranges.length, 'range')}: ${shown}${more > 0 ? ` and ${more.toLocaleString()} more` : ''}`,
    ]);
  } else {
    rows.push(['Method', 'Repeating windows']);
    rows.push([
      'Windows',
      `${seconds(definition.duration)} long, every ${seconds(definition.step)}`,
    ]);
    rows.push([
      'Between',
      `${formatValue(definition.start, 3)}–${seconds(definition.end)}`,
    ]);
    rows.push([
      'Partial windows',
      definition.includePartial ? 'Kept' : 'Left out',
    ]);
  }
  rows.push([
    'At the input’s ends',
    definition.boundary === 'clip'
      ? 'Shorten segments to fit'
      : 'Leave out segments that do not fit',
  ]);
  return rows;
}

function SettingsTable({ title, rows }: { title?: string; rows: Row[] }) {
  return (
    <section className="workflow-settings">
      {title && <h3>{title}</h3>}
      <dl className="workflow-property-grid">
        {rows.map(([label, value, hint]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={hint}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The Settings tab: a step's saved settings as a readable table, with the
 * exact stored record behind a "Show raw" disclosure.
 */
export function WorkflowStepSettings({
  step,
  index,
  busy,
  onEdit,
  onNewVersion,
}: {
  step: WorkflowStep;
  index: WorkflowIndex;
  busy: boolean;
  onEdit: () => void;
  onNewVersion: () => void;
}) {
  const signal = (id: string) =>
    `${reference(index.owner.get(id))} ${index.label(id)}`.trim();
  const general: Row[] = [['Step', `${reference(step)} ${stepName(step)}`]];
  if (step.kind === 'derive' || step.kind === 'value')
    general.push(['Function', stepFunctionName(step)]);
  if (step.timeSettings) {
    const methods: Record<string, string> = {
      align: 'Align time axes',
      resample: 'Resample onto a shared grid',
      combine: 'Combine across recordings',
      crop: 'Crop to a shared interval',
    };
    general.push([
      'Method',
      methods[step.timeSettings.kind] ?? humanize(step.timeSettings.kind),
    ]);
  }
  general.push(['Inputs', formatCount(step.inputIds.length, 'input')]);
  general.push(['Revision', (step.revision ?? 1).toLocaleString()]);
  const parameterLabel = (key: string) =>
    key === 'value'
      ? SIGNAL_FUNCTIONS.find((spec) => spec.operation === step.operation)
          ?.parameter || 'Parameter'
      : humanize(key);
  const parameters: Row[] = Object.entries(step.parameters ?? {}).map(
    ([key, value]) => [parameterLabel(key), formatValue(value, 6)],
  );
  const raw = {
    ...(step.parameters && { parameters: step.parameters }),
    ...(step.definition && { definition: step.definition }),
    ...(step.timeSettings && { timeSettings: step.timeSettings }),
  };
  return (
    <section className="workflow-dock-settings">
      <SettingsTable rows={general} />
      {!!parameters.length && (
        <SettingsTable title="Parameters" rows={parameters} />
      )}
      {step.definition && (
        <SettingsTable
          title="Segmentation"
          rows={segmentationRows(step.definition, signal)}
        />
      )}
      {!!Object.keys(raw).length && (
        <details className="workflow-settings-raw">
          <summary>Show raw</summary>
          <pre>
            {JSON.stringify(
              raw,
              (key, value: unknown) =>
                key === 'signalId' && typeof value === 'string'
                  ? signal(value)
                  : value,
              2,
            )}
          </pre>
        </details>
      )}
      {step.kind === 'import' ? (
        <p className="workflow-muted">
          Original recordings are immutable. Import the file again to add
          another recording.
        </p>
      ) : (
        <div className="workflow-panel-actions">
          {step.kind !== 'regions' && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onEdit}
            >
              <Settings2 size={14} /> Edit settings
            </button>
          )}
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onNewVersion}
          >
            <CopyPlus size={14} />
            {step.kind === 'regions'
              ? 'Create signal segments'
              : 'New version…'}
          </button>
        </div>
      )}
    </section>
  );
}
