import type { Plot, Project } from './signal-types';
import { SignalGraph } from './signal-graph';
import { stepName, WorkflowIndex } from './workflow-history';
import { VALUE_FUNCTIONS } from './workflow-types';

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

export function valuesCsv(project: Project, ids: string[]) {
  const index = new WorkflowIndex(project);
  const lines = [
    'Value,Unit,Calculation,Result,Input,Input ID,Step,Valid samples,Valid duration (s),Occurrence (s)',
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
        <p>${value.sampleCount} finite samples · ${value.validDuration} s of valid intervals${value.timestamp === undefined ? '' : ` · first occurrence ${value.timestamp} s`}</p>`;
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
      return `<section><h2>${html(index.label(id))}</h2><p class="muted">${html(index.kind(id))} · ${html(stepRef(id))} · ${html(source?.name ?? '')} · ${bounds ? `${html(bounds[0])}–${html(bounds[1])} s` : ''}</p>
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
    <td>${html(JSON.stringify(step.definition ?? step.parameters ?? {}))}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Stratus analysis report</title><style>
    *{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;color:#182b35;background:white;max-width:1050px;margin:40px auto;padding:0 30px}
    h1{font-size:28px}h2{font-size:20px;margin:0}section{padding:22px 0;border-top:1px solid #ccd5d9;break-inside:avoid}
    .muted,small{color:#52636d;font-size:13px}.result{font-size:32px;margin:12px 0}svg{width:100%;height:auto;max-height:260px}
    table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;border-bottom:1px solid #ccd5d9;padding:10px;vertical-align:top;overflow-wrap:anywhere}p{overflow-wrap:anywhere}td:last-child{max-width:280px}thead{display:table-header-group}
    @media print{body{margin:0;max-width:none;padding:0}section{break-inside:avoid}h1,h2{break-after:avoid}@page{margin:16mm}}
    </style></head><body><header><p class="muted">STRATUS · ANALYSIS SNAPSHOT</p><h1>Workflow results</h1>
    <p>${ids.length} outputs · Created ${html(createdAt.toISOString())}</p><p class="muted">Original recordings remain unchanged. Signal times reflect each signal’s evaluated time axis. Open this file in a browser and use Print to save a PDF.</p></header>
    ${cards}<h2>Contributing operation history</h2><p>Chronological steps and only the outputs contributing to this report.</p>
    <table><thead><tr><th>Step</th><th>Operation</th><th>Contributing outputs</th><th>Saved settings</th></tr></thead><tbody>${history}</tbody></table></body></html>`;
}
