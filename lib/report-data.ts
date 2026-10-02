import { SignalGraph } from './signal-graph';
import { WorkflowIndex, stepName } from './workflow-history';
import { targetOutputs, type WorkflowTarget } from './workflow-drag';
import { createBlock, type ReportBlock } from './report-mockup';
import type { EngineRequest, EngineResponse, Project } from './signal-types';
import type { PlotSheet } from './plot-scratchpad';
import type { ReportAsset } from './report-integration';
import { checkTableRows, currentResults } from './workflow-checks';
import type { WorkflowStep } from './workflow-types';

const MAX_ASSETS = 30;
const MAX_VALUES = 330;
// Each table has at most twelve rows including its repeated header.
const VALUES_PER_TABLE = 11;

type ReportRequest = (message: EngineRequest) => Promise<EngineResponse>;
type CapturePlot = (
  sheet: PlotSheet,
  signal?: AbortSignal,
) => Promise<ReportBlock[]>;

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException('Report capture cancelled.', 'AbortError');
}

/** Whole value steps use their explicit batch, while members remain independent. */
export function reportTargetAssets(
  index: WorkflowIndex,
  target: WorkflowTarget,
): string[] {
  if (target.kind === 'step' && index.steps.get(target.id)?.kind === 'value')
    return [`values:${target.id}`];
  return targetOutputs(index, target).flatMap((id) =>
    index.nodes.has(id)
      ? [`signal:${id}`]
      : index.values.has(id)
        ? [`value:${id}`]
        : [],
  );
}

/** Catalog membership is explicit; selecting one result never selects siblings. */
export function reportAssets(
  project: Project,
  sheets: PlotSheet[],
): ReportAsset[] {
  const index = new WorkflowIndex(project);
  // With several recordings, say which one each output came from.
  const names = new Map(
    project.sources.map((source) => [source.id, source.name]),
  );
  const recording = (id: string) => {
    if (names.size < 2) return '';
    const node =
      index.nodes.get(id) ??
      index.nodes.get(index.values.get(id)?.inputId ?? '');
    const sourceId =
      node?.sourceId || index.lineage([id]).originals[0]?.sourceId;
    const name = sourceId ? names.get(sourceId) : undefined;
    return name ? ` · ${name}` : '';
  };
  return [
    ...sheets.map(
      (sheet): ReportAsset => ({
        id: `plot:${sheet.id}`,
        kind: 'plot',
        name: sheet.name,
        detail: `Saved plot · ${sheet.traces.filter((trace) => trace.visible).length} visible traces`,
        outputIds: [
          ...new Set(
            sheet.traces
              .filter((trace) => trace.visible)
              .map((trace) => trace.id),
          ),
        ],
      }),
    ),
    ...project.nodes
      .filter((node) => !node.internal)
      .map(
        (node): ReportAsset => ({
          id: `signal:${node.id}`,
          kind: 'signal',
          name: index.label(node.id),
          detail: `${index.kind(node.id)}${node.unit ? ` · ${node.unit}` : ''}${recording(node.id)}`,
          outputIds: [node.id],
        }),
      ),
    ...(project.values ?? []).map(
      (value): ReportAsset => ({
        id: `value:${value.id}`,
        kind: 'value',
        name: index.label(value.id),
        detail: `Calculated value · ${value.value === null ? 'Unavailable' : String(value.value)}${value.unit ? ` ${value.unit}` : ''}${recording(value.id)}`,
        outputIds: [value.id],
      }),
    ),
    ...(project.workflowSteps ?? [])
      .filter((step) => step.kind === 'value')
      .map(
        (step): ReportAsset => ({
          id: `values:${step.id}`,
          kind: 'values',
          name: stepName(step),
          detail: `${step.outputIds.length} calculated values · step ${step.sequence + 1}${step.outputIds.length ? recording(step.outputIds[0]) : ''}`,
          outputIds: [...step.outputIds],
        }),
      ),
    ...checkAssets(project),
  ];
}

/** Steps with evaluated checks, grouped by the recording they were derived from. */
function checkedSteps(project: Project): Map<string, WorkflowStep[]> {
  const index = new WorkflowIndex(project);
  const runs = new Map(
    (project.workflowBatches ?? []).flatMap((batch) =>
      batch.runs.map((run) => [run.id, run.sourceId] as const),
    ),
  );
  const groups = new Map<string, WorkflowStep[]>();
  for (const step of project.workflowSteps ?? []) {
    if (!currentResults(step).length) continue;
    const sourceId =
      step.sourceId ||
      runs.get(step.runId ?? '') ||
      index.lineage(step.outputIds).originals[0]?.sourceId;
    if (!sourceId) continue;
    groups.set(sourceId, [...(groups.get(sourceId) ?? []), step]);
  }
  return groups;
}

function checkAssets(project: Project): ReportAsset[] {
  return [...checkedSteps(project)].flatMap(([sourceId, steps]) => {
    const source = project.sources.find((item) => item.id === sourceId);
    if (!source) return [];
    const results = steps.flatMap(currentResults);
    const flagged = results.filter((result) => result.status !== 'pass').length;
    return [
      {
        id: `checks:${sourceId}`,
        kind: 'checks' as const,
        name: `Check results · ${source.name}`,
        detail: `${results.length} ${results.length === 1 ? 'check' : 'checks'} · ${flagged} flagged`,
        outputIds: steps.flatMap((step) => step.outputIds),
      },
    ];
  });
}

function sourceMetadata(
  project: Project,
  index: WorkflowIndex,
  graph: SignalGraph,
  ids: readonly string[],
  kind: NonNullable<ReportBlock['source']>['kind'],
  label: string,
): NonNullable<ReportBlock['source']> {
  const outputIds = [...new Set(ids)];
  for (const id of outputIds) {
    if (!index.nodes.has(id) && !index.values.has(id))
      throw new Error('A selected report output is no longer available.');
  }
  const sourceIds = new Set(
    index.lineage(outputIds).originals.map((node) => node.sourceId),
  );
  const references = new Map<string, string>();
  for (const id of outputIds) {
    const reference = graph.timeReferences.get(
      index.values.get(id)?.inputId ?? id,
    );
    if (reference)
      references.set(reference.id, `${reference.name} (${reference.kind})`);
  }
  return {
    kind,
    label,
    capturedAt: new Date().toISOString(),
    outputIds,
    sourceNames: project.sources
      .filter((source) => sourceIds.has(source.id))
      .map((source) => source.name),
    timeReferences: [...references.values()],
  };
}

/** Metadata names every original source while retaining the evaluated output clock. */
export function reportSource(
  project: Project,
  ids: readonly string[],
  kind: NonNullable<ReportBlock['source']>['kind'],
  label: string,
): NonNullable<ReportBlock['source']> {
  return sourceMetadata(
    project,
    new WorkflowIndex(project),
    new SignalGraph(project),
    ids,
    kind,
    label,
  );
}

/** Build all snapshots before returning any, so failures cannot insert partial reports. */
export async function resolveReportAssets(
  project: Project,
  sheets: PlotSheet[],
  ids: string[],
  request: ReportRequest,
  capturePlot: CapturePlot,
  signal?: AbortSignal,
): Promise<ReportBlock[]> {
  checkAborted(signal);
  const selectedIds = [...new Set(ids)];
  if (selectedIds.length > MAX_ASSETS)
    throw new Error(`Choose at most ${MAX_ASSETS} report assets at a time.`);
  const catalog = new Map(
    reportAssets(project, sheets).map((asset) => [asset.id, asset]),
  );
  const index = new WorkflowIndex(project);
  const graph = new SignalGraph(project);
  const selected = selectedIds.map((id) => {
    const asset = catalog.get(id);
    if (!asset)
      throw new Error('A selected report asset is no longer available.');
    if (!asset.outputIds.length)
      throw new Error(`“${asset.name}” has no visible outputs to capture.`);
    for (const outputId of asset.kind === 'checks' ? [] : asset.outputIds) {
      const available =
        asset.kind === 'value' || asset.kind === 'values'
          ? index.values.has(outputId)
          : asset.kind === 'plot'
            ? index.nodes.has(outputId) || index.values.has(outputId)
            : index.nodes.has(outputId);
      if (!available)
        throw new Error(`An output in “${asset.name}” is no longer available.`);
    }
    return asset;
  });
  const valueIds = [
    ...new Set(
      selected
        .filter((asset) => asset.kind === 'value' || asset.kind === 'values')
        .flatMap((asset) => asset.outputIds),
    ),
  ];
  if (valueIds.length > MAX_VALUES)
    throw new Error(
      `Choose at most ${MAX_VALUES} calculated values per report insertion. Select individual results from this batch.`,
    );
  const blocks: ReportBlock[] = [];
  for (const asset of selected) {
    checkAborted(signal);
    if (asset.kind === 'plot') {
      const sheet = sheets.find((item) => `plot:${item.id}` === asset.id)!;
      const captured = await capturePlot(structuredClone(sheet), signal);
      checkAborted(signal);
      if (!captured.length)
        throw new Error(`“${asset.name}” did not produce a plot snapshot.`);
      blocks.push(...structuredClone(captured));
    } else if (asset.kind === 'signal') {
      const id = asset.outputIds[0];
      // Report capture must not join/coalesce the interactive inspection queue.
      const response = await request({ type: 'view', ids: [id] });
      checkAborted(signal);
      if (response.type === 'error') throw new Error(response.message);
      const plot =
        response.type === 'plots'
          ? response.plots.find((item) => item.id === id)
          : undefined;
      if (!plot)
        throw new Error(`“${asset.name}” did not produce evaluated plot data.`);
      const node = index.nodes.get(id)!;
      const range = graph.ranges.get(id)!;
      const reference = graph.timeReferences.get(id)!;
      const points: [number, number | null][] = plot.points.map(
        ([time, value]) => {
          if (!Number.isFinite(time))
            throw new Error('A signal contains an invalid plot timestamp.');
          return [time, Number.isFinite(value) ? value : null];
        },
      );
      blocks.push(
        createBlock('plot', {
          name: asset.name,
          text: asset.name,
          width: 698,
          height: 320,
          accent: node.color,
          signalPlot: {
            points,
            unit: node.unit,
            timeLabel: `${reference.name} (${reference.kind}) · time (s)`,
            range: [...range],
            label: asset.name,
          },
          source: sourceMetadata(
            project,
            index,
            graph,
            [id],
            'signal',
            asset.name,
          ),
        }),
      );
    }
  }
  for (const asset of selected) {
    if (asset.kind !== 'checks') continue;
    const sourceId = asset.id.slice('checks:'.length);
    const steps = checkedSteps(project).get(sourceId) ?? [];
    const rows = checkTableRows(steps, (step) => stepName(step));
    blocks.push(
      createBlock('table', {
        name: asset.name,
        text: 'Checks',
        width: 698,
        height: Math.min(900, 62 + rows.length * 40),
        fontSize: 11,
        padding: 14,
        tableData: rows.slice(0, 41),
        source: {
          kind: 'checks',
          label: asset.name,
          capturedAt: new Date().toISOString(),
          outputIds: [...asset.outputIds],
          sourceNames: project.sources
            .filter((source) => source.id === sourceId)
            .map((source) => source.name),
          timeReferences: [],
        },
      }),
    );
  }
  for (let offset = 0; offset < valueIds.length; offset += VALUES_PER_TABLE) {
    const tableIds = valueIds.slice(offset, offset + VALUES_PER_TABLE);
    const title =
      valueIds.length <= VALUES_PER_TABLE
        ? 'Calculated values'
        : `Calculated values · ${Math.floor(offset / VALUES_PER_TABLE) + 1} of ${Math.ceil(valueIds.length / VALUES_PER_TABLE)}`;
    blocks.push(
      createBlock('table', {
        name: title,
        text: title,
        width: 698,
        height: 62 + (tableIds.length + 1) * 52,
        fontSize: 12,
        padding: 14,
        tableData: [
          ['Value', 'Result', 'Unit', 'Input'],
          ...tableIds.map((id) => {
            const value = index.values.get(id)!;
            return [
              index.label(id),
              value.value === null ? 'Unavailable' : String(value.value),
              value.unit,
              index.label(value.inputId),
            ];
          }),
        ],
        source: sourceMetadata(
          project,
          index,
          graph,
          tableIds,
          'values',
          title,
        ),
      }),
    );
  }
  checkAborted(signal);
  return blocks;
}
