import type { Plot, Project } from './signal-types';
import { SignalGraph } from './signal-graph';
import { stepName, WorkflowIndex } from './workflow-history';
import { VALUE_FUNCTIONS } from './workflow-types';
import { formatCount } from './format-count';

/** Text cells stay text when opened in a spreadsheet, including imported names. */
export const csvText = (text: string) =>
  `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
const numeric = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? String(value) : '';
const html = (text: string | number) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  );

export type ExportKind =
  | 'values'
  | 'samples'
  | 'summary'
  | 'report'
  | 'segments';

/**
 * A download name that says what the file holds: recording, scope and kind,
 * such as `SN-24001 · #013 Maximum · values.csv`. Characters that file
 * systems reject are replaced.
 */
export function exportFileName(
  project: Project,
  ids: readonly string[],
  scope: string,
  kind: ExportKind,
): string {
  const index = new WorkflowIndex(project);
  const sourceIds = new Set(
    index.lineage([...ids]).originals.map((node) => node.sourceId),
  );
  const recordings = project.sources
    .filter((source) => sourceIds.has(source.id))
    .map((source) => source.name.replace(/\.[a-z0-9]{1,5}$/i, ''));
  const recording =
    recordings.length > 2
      ? `${recordings.length} recordings`
      : recordings.join(', ');
  const suffix = {
    values: 'values.csv',
    samples: 'samples.csv',
    summary: 'signal summary.csv',
    report: 'summary.html',
    segments: 'segments.csv',
  }[kind];
  const name = [recording, scope]
    .filter(Boolean)
    .join(' · ')
    .replace(/[^\p{L}\p{N} .,#()_\-·×+]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return `${name || 'Stratum'} · ${suffix}`;
}

export function valuesCsv(project: Project, ids: string[]) {
  const index = new WorkflowIndex(project);
  const lines = [
    'Value,Unit,Calculation,Result,Input,Input ID,Step,Valid samples,Valid duration (s),Occurrence (s),Segment,Segment start (s),Segment end (s)',
  ];
  for (const id of ids) {
    const value = index.values.get(id);
    if (!value)
      throw new Error('Choose only calculated values for Values CSV.');
    const owner = index.owner.get(id);
    lines.push(
      [
        csvText(index.label(id)),
        csvText(value.unit),
        csvText(value.operation),
        numeric(value.value),
        csvText(index.label(value.inputId)),
        csvText(value.inputId),
        csvText(owner ? `#${String(owner.sequence + 1).padStart(3, '0')}` : ''),
        value.sampleCount,
        value.validDuration,
        numeric(value.timestamp),
        ...segmentCells(index, value.segmentId),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

/** A value's segment, or blanks for an entire signal. */
function segmentCells(index: WorkflowIndex, id?: string): string[] {
  const segment = id ? index.segments.get(id)?.segment : undefined;
  return segment
    ? [
        csvText(index.segmentLabel(segment.id)),
        numeric(segment.start),
        numeric(segment.end),
      ]
    : ['', '', ''];
}

/** One row per file segment: its interval, parent and step. */
export function segmentsCsv(project: Project, ids: string[]) {
  const index = new WorkflowIndex(project);
  const lines = [
    'Segment,Start (s),End (s),Duration (s),End included,Parent segment,Recording,Step,Segment ID',
  ];
  for (const id of ids) {
    const entry = index.segments.get(id);
    if (!entry) throw new Error('Choose only segments for Segments CSV.');
    const { segment, set } = entry;
    const owner = index.owner.get(id);
    lines.push(
      [
        csvText(index.segmentLabel(id)),
        numeric(segment.start),
        numeric(segment.end),
        numeric(segment.end - segment.start),
        segment.endInclusive ? 'yes' : 'no',
        csvText(segment.parentId ? index.segmentLabel(segment.parentId) : ''),
        csvText(
          project.sources.find((source) => source.id === set.sourceId)?.name ??
            'Workspace',
        ),
        csvText(
          owner
            ? `#${String(owner.sequence + 1).padStart(3, '0')} ${stepName(owner)}`
            : '',
        ),
        csvText(id),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

/** A self-contained, script-free snapshot. Plot points are labelled as envelopes. */
export function reportHtml(
  project: Project,
  ids: string[],
  plots: Plot[],
  createdAt = new Date(),
) {
  const index = new WorkflowIndex(project),
    graph = new SignalGraph(project);
  const lineage = index.lineage(ids);
  const finite = (value: number | null | undefined) =>
    numeric(value) || 'Unavailable';
  const stepRef = (id: string) => {
    const step = index.owner.get(id);
    return step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
  };
  const cards = ids
    .map((id) => {
      const node = index.nodes.get(id),
        value = index.values.get(id);
      if (!node && !value)
        throw new Error('A report output is no longer available.');
      const source = project.sources.find(
        (item) => item.id === (node?.sourceId ?? value?.sourceId),
      );
      const inputs = index
        .inputs(id)
        .map((input) => `${stepRef(input)} ${index.label(input)}`)
        .join('; ');
      const bounds = node ? graph.ranges.get(id) : [value!.start, value!.end];
      const plot = plots.find((item) => item.id === id);
      let content: string;
      if (value) {
        const spec = VALUE_FUNCTIONS.find(
          (item) => item.operation === value.operation,
        );
        content = `<p class="result">${html(finite(value.value))} <small>${html(value.unit)}</small></p>
        <p>${html(spec?.description ?? value.operation)}</p>
        <p>${value.sampleCount} finite samples · ${value.validDuration} s of valid intervals${value.timestamp === undefined ? '' : ` · at ${value.timestamp} s`}</p>`;
      } else if (plot && bounds) {
        const low = Number.isFinite(plot.summary.min) ? plot.summary.min : 0;
        const high = Number.isFinite(plot.summary.max) ? plot.summary.max : 1;
        const x = (time: number) =>
          75 + ((time - bounds[0]) / (bounds[1] - bounds[0] || 1)) * 730;
        const y = (sample: number) =>
          155 - ((sample - low) / (high - low || 1)) * 130;
        const path = plot.points
          .map(([time, sample], position) =>
            Number.isFinite(sample)
              ? `${position && Number.isFinite(plot.points[position - 1][1]) ? 'L' : 'M'}${x(time).toFixed(2)},${y(sample).toFixed(2)}`
              : '',
          )
          .join(' ');
        content = `<svg viewBox="0 0 840 200" role="img" aria-label="${html(index.label(id))} over time">
        <path d="M75 20V160H805" stroke="#89949b" fill="none"/>
        <path d="${path}" fill="none" stroke="#12644f" stroke-width="1.5"/>
        <g font-size="13" fill="#33434c"><text x="68" y="29" text-anchor="end">${html(Number(high.toPrecision(5)))}</text>
        <text x="68" y="157" text-anchor="end">${html(Number(low.toPrecision(5)))}</text>
        <text x="75" y="182">${html(bounds[0])} s</text><text x="805" y="182" text-anchor="end">${html(bounds[1])} s</text></g></svg>
        <p>Min ${html(finite(plot.summary.min))} · Max ${html(finite(plot.summary.max))} · Sample average ${html(finite(plot.summary.mean))} ${html(node!.unit)} · ${plot.summary.count} finite samples</p>
        <p class="muted">Plot uses a bounded min/max envelope. Export Samples CSV for every evaluated time and value.</p>`;
      } else throw new Error('A signal plot is missing from the report.');
      const timeReference = graph.timeReferences.get(
        node?.id ?? value!.inputId,
      );
      return `<section><h2>${html(index.label(id))}</h2><p class="muted">${html(index.kind(id))} · ${html(stepRef(id))} · ${html(source?.name ?? 'Workspace result')} · ${bounds ? `${html(bounds[0])}–${html(bounds[1])} s` : ''}</p>
      <p class="muted">Time reference: ${html(timeReference?.name ?? '')} (${html(timeReference?.kind ?? '')})</p>
      ${content}<p><b>From:</b> ${html(inputs || 'Original recording')}</p><p class="muted">Output ID: ${html(id)}</p></section>`;
    })
    .join('');
  const history = lineage.steps
    .map(
      (
        step,
      ) => `<tr><td>#${String(step.sequence + 1).padStart(3, '0')} · v${step.revision ?? 1}</td><td>${html(stepName(step))}${step.updatedAt ? `<br><small>Updated ${html(step.updatedAt)}</small>` : ''}</td>
    <td>${html(
      step.outputIds
        .filter((id) => lineage.outputIds.has(id))
        .map((id) => index.label(id))
        .join('; '),
    )}</td>
    <td>${html(JSON.stringify(step.timeSettings ?? step.definition ?? step.parameters ?? {}))}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Stratum analysis report</title><style>
    *{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;color:#182b35;background:white;max-width:1050px;margin:40px auto;padding:0 30px}
    h1{font-size:28px}h2{font-size:20px;margin:0}section{padding:22px 0;border-top:1px solid #ccd5d9;break-inside:avoid}
    .muted,small{color:#52636d;font-size:13px}.result{font-size:32px;margin:12px 0}svg{width:100%;height:auto;max-height:260px}
    table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;border-bottom:1px solid #ccd5d9;padding:10px;vertical-align:top;overflow-wrap:anywhere}p{overflow-wrap:anywhere}td:last-child{max-width:280px}thead{display:table-header-group}
    @media print{body{margin:0;max-width:none;padding:0}section{break-inside:avoid}h1,h2{break-after:avoid}@page{margin:16mm}}
    </style></head><body><header><p class="muted">STRATUM · ANALYSIS SNAPSHOT</p><h1>Workflow results</h1>
    <p>${html(formatCount(ids.length, 'output'))} · Created ${html(createdAt.toISOString())}</p><p class="muted">Original recordings remain unchanged. Signal times reflect each signal’s evaluated time axis. Open this file in a browser and use Print to save a PDF.</p></header>
    ${cards}<h2>Contributing operation history</h2><p>Chronological steps and only the outputs contributing to this report.</p>
    <table><thead><tr><th>Step</th><th>Operation</th><th>Contributing outputs</th><th>Saved settings</th></tr></thead><tbody>${history}</tbody></table></body></html>`;
}
