import {
  createBlock,
  pageDimensions,
  type ReportBlock,
  type ReportDocument,
} from './report-mockup';
import { resolveReportAssets } from './report-data';
import { captureReportPlot } from './report-plot';
import { createReportPdf } from './report-pdf';
import { stepName, WorkflowIndex } from './workflow-history';
import {
  bindChannels,
  BlockedReference,
  createResolver,
  parseWorkflow,
  type WorkflowRecipe,
} from './workflow-recipe';
import {
  checkTableRows,
  formatNumber,
  liveRunStatus,
  runProblems,
  STATUS_LABELS,
} from './workflow-checks';
import {
  fillPlaceholders,
  type TemplateBlock,
} from './workflow-report-template';
import { createZip, uniqueNames, type ZipEntry } from './zip-store';
import { TRACE_COLORS, type PlotSheet } from './plot-scratchpad';
import type { EngineRequest, EngineResponse, Project } from './signal-types';
import type { WorkflowBatch, WorkflowRun } from './workflow-types';

type Request = (message: EngineRequest) => Promise<EngineResponse>;

function aborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException('Report export cancelled.', 'AbortError');
}

/** The recipe and parsed workflow behind a batch. */
export function batchRecipe(
  project: Project,
  batch: WorkflowBatch,
): { recipe: WorkflowRecipe; text: string; revision?: string } {
  const record = project.workflowRecipes?.find(
    (item) => item.hash === batch.recipeHash,
  );
  if (!record)
    throw new Error('The workflow used by this batch is no longer available.');
  return {
    recipe: parseWorkflow(record.text),
    text: record.text,
    revision: record.revision,
  };
}

/** Resolve recipe references to this run's actual outputs. */
function runResolver(
  project: Project,
  recipe: WorkflowRecipe,
  run: WorkflowRun,
) {
  const index = new WorkflowIndex(project);
  const source = project.sources.find((item) => item.id === run.sourceId);
  const aliases = new Map<string, string>();
  if (source)
    for (const binding of bindChannels(
      recipe,
      source.channels.map((id) => index.nodes.get(id)!),
    ))
      if (!binding.problem)
        aliases.set(binding.alias, source.channels[binding.channel]);
  const outputs = new Map(
    Object.entries(run.steps).flatMap(([recipeStepId, stepId]) => {
      const step = index.steps.get(stepId);
      return step ? [[recipeStepId, step.outputIds] as const] : [];
    }),
  );
  return createResolver(aliases, outputs);
}

function unavailableBlock(block: TemplateBlock, reason: string): ReportBlock {
  return createBlock('text', {
    name: block.name,
    x: block.x,
    y: block.y,
    width: block.width,
    height: Math.min(block.height, 90),
    text: `${block.text || block.name}\nNot available for this item: ${reason}`,
    fontSize: 12,
    color: '#8a5a00',
    fill: '#fff8e6',
    borderColor: '#e8c77a',
    borderWidth: 1,
    radius: 6,
    padding: 12,
  });
}

/** Apply a template block's layout and styling to a freshly captured block. */
function placed(
  template: TemplateBlock,
  captured: ReportBlock,
  text: string,
): ReportBlock {
  const { bind: _bind, ...layout } = template;
  void _bind;
  return {
    ...captured,
    ...layout,
    text,
    signalPlot: captured.signalPlot,
    plotSnapshot: captured.plotSnapshot,
    source: captured.source,
  };
}

/** Render a workflow's report template for one batch item. */
export async function renderRunReport(options: {
  project: Project;
  batch: WorkflowBatch;
  run: WorkflowRun;
  request: Request;
  signal?: AbortSignal;
}): Promise<ReportDocument> {
  const { project, batch, run, request, signal } = options;
  const { recipe, revision } = batchRecipe(project, batch);
  const template = recipe.report;
  if (!template)
    throw new Error(
      'This workflow has no report template. Save a workflow with a report first.',
    );
  const index = new WorkflowIndex(project);
  const steps = index.steps;
  const resolve = runResolver(project, recipe, run);
  const problems = runProblems(run, steps);
  const status = liveRunStatus(run, steps);
  const values: Record<string, string> = {
    'item.id': run.itemId,
    'item.label': recipe.item.label,
    'file.name': run.fileName,
    'run.date': new Date(run.finishedAt).toLocaleString(),
    'run.status': STATUS_LABELS[status],
    'run.flags': problems.length
      ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}: ${problems[0].message}`
      : 'no problems found',
    'workflow.name': recipe.name,
    'workflow.revision': revision ?? recipe.revision ?? '—',
    'workflow.hash': batch.recipeHash.slice(0, 12),
  };
  const valueText = (ref: string) => {
    try {
      return resolve(ref)
        .map((id) => {
          const value = index.values.get(id);
          if (!value) return index.label(id);
          return value.value === null
            ? 'unavailable'
            : `${formatNumber(value.value)}${value.unit && value.unit !== '—' ? ` ${value.unit}` : ''}`;
        })
        .join(', ');
    } catch {
      return 'unavailable';
    }
  };
  const fill = (text: string) => fillPlaceholders(text, values, valueText);
  const runSteps = Object.values(run.steps).flatMap((id) => {
    const step = steps.get(id);
    return step ? [step] : [];
  });
  const size = pageDimensions(template);
  const pages: ReportDocument['pages'] = [];
  for (const page of template.pages) {
    const blocks: ReportBlock[] = [];
    for (const block of page.blocks) {
      aborted(signal);
      const text = fill(block.text);
      const bind = block.bind;
      if (!bind) {
        blocks.push({
          ...block,
          id: crypto.randomUUID(),
          name: fill(block.name),
          text,
        });
        continue;
      }
      try {
        if (bind.kind === 'checks') {
          const rows = checkTableRows(runSteps, (step) => stepName(step), {
            flaggedOnly: bind.scope === 'flagged',
            flags: run.flags,
          });
          blocks.push({
            ...placed(block, createBlock('table'), text),
            id: crypto.randomUUID(),
            tableData:
              rows.length > 1
                ? rows
                : [...rows, ['All checks', 'No problems found', 'Pass']],
          });
          continue;
        }
        if (bind.kind === 'values') {
          const ids = bind.refs
            .flatMap((ref) => resolve(ref))
            .filter((id) => index.values.has(id));
          if (!ids.length)
            throw new BlockedReference('no values were calculated.');
          blocks.push({
            ...placed(block, createBlock('table'), text),
            id: crypto.randomUUID(),
            tableData: [
              ['Value', 'Result', 'Unit'],
              ...ids.slice(0, 40).map((id) => {
                const value = index.values.get(id)!;
                return [
                  index.label(id),
                  value.value === null
                    ? 'Unavailable'
                    : formatNumber(value.value),
                  value.unit,
                ];
              }),
            ],
          });
          continue;
        }
        if (bind.kind === 'signal') {
          const ids = resolve(bind.ref).filter((id) => index.nodes.has(id));
          if (!ids.length)
            throw new BlockedReference('the signal was not created.');
          const [captured] = await resolveReportAssets(
            project,
            [],
            [`signal:${ids[0]}`],
            request,
            async () => [],
            signal,
          );
          blocks.push({
            ...placed(block, captured, text),
            id: crypto.randomUUID(),
          });
          continue;
        }
        // A bound plot expands each reference to this item's outputs.
        const traces = bind.sheet.traces.flatMap((trace) =>
          resolve(trace.id)
            .filter((id) => index.nodes.has(id) || index.values.has(id))
            .map((id, offset) => ({
              ...trace,
              id,
              color: offset
                ? TRACE_COLORS[offset % TRACE_COLORS.length]
                : trace.color,
            })),
        );
        const unique = traces.filter(
          (trace, position) =>
            traces.findIndex((item) => item.id === trace.id) === position,
        );
        if (!unique.length)
          throw new BlockedReference('the plotted outputs were not created.');
        const sheet: PlotSheet = {
          ...bind.sheet,
          id: `plot:${crypto.randomUUID()}`,
          name: fill(block.name),
          traces: unique.slice(0, 30),
        };
        const captured = await captureReportPlot(
          project,
          sheet,
          request,
          signal,
        );
        // Stacked panels share the template block's area, top to bottom.
        const height = Math.max(80, block.height / captured.length);
        captured.forEach((panel, position) =>
          blocks.push({
            ...placed(block, panel, position ? panel.text : text),
            id: crypto.randomUUID(),
            y: Math.min(size.height - height, block.y + position * height),
            height,
          }),
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          throw error;
        blocks.push(
          unavailableBlock(
            block,
            error instanceof Error
              ? error.message.replace(/^"[^"]*" /, '')
              : 'not available.',
          ),
        );
      }
    }
    pages.push({ id: crypto.randomUUID(), blocks });
  }
  return {
    title: fill(template.title).slice(0, 200),
    pageSize: template.pageSize,
    orientation: template.orientation,
    background: template.background,
    ...(template.frame ? { frame: { ...template.frame } } : {}),
    pages: pages.length ? pages : [{ id: crypto.randomUUID(), blocks: [] }],
  };
}

export type ReportExportProgress = (
  done: number,
  total: number,
  item: string,
) => void;

type DirectoryHandle = {
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/** Folder output where the browser allows it; otherwise the caller uses a ZIP. */
export async function chooseFolder(): Promise<DirectoryHandle | undefined> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (options: {
        mode: 'readwrite';
      }) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) return undefined;
  return picker({ mode: 'readwrite' });
}

/**
 * One PDF per item. Writes into `folder` as each finishes, or returns a ZIP.
 * Cancelling stops before the next item and never returns a partial ZIP.
 */
export async function exportRunReports(options: {
  project: Project;
  batch: WorkflowBatch;
  runs: WorkflowRun[];
  request: Request;
  folder?: DirectoryHandle;
  signal?: AbortSignal;
  progress?: ReportExportProgress;
}): Promise<{ zip?: Blob; written: number }> {
  const { project, batch, runs, request, folder, signal, progress } = options;
  const { recipe } = batchRecipe(project, batch);
  const names = uniqueNames(
    runs.map((run) => `${run.itemId} – ${recipe.name}.pdf`),
  );
  const entries: ZipEntry[] = [];
  for (const [position, run] of runs.entries()) {
    aborted(signal);
    progress?.(position, runs.length, run.itemId);
    const report = await renderRunReport({
      project,
      batch,
      run,
      request,
      signal,
    });
    aborted(signal);
    const pdf = await createReportPdf(report);
    aborted(signal);
    if (folder) {
      const file = await folder.getFileHandle(names[position], {
        create: true,
      });
      const writable = await file.createWritable();
      await writable.write(pdf);
      await writable.close();
    } else
      entries.push({
        name: names[position],
        data: new Uint8Array(await pdf.arrayBuffer()),
      });
  }
  progress?.(runs.length, runs.length, '');
  return folder
    ? { written: runs.length }
    : { zip: createZip(entries), written: runs.length };
}
