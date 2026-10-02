import { CsvParser } from './signal-math';
import { csvText } from './workflow-delivery';
import { WorkflowIndex } from './workflow-history';
import {
  bindChannels,
  headerChannel,
  itemIdFromFileName,
  type ChannelBinding,
  type WorkflowRecipe,
} from './workflow-recipe';
import {
  liveRunStatus,
  runEdited,
  runProblems,
  STATUS_LABELS,
} from './workflow-checks';
import type { Project } from './signal-types';
import type {
  RunStatus,
  WorkflowBatch,
  WorkflowRun,
  WorkflowStep,
} from './workflow-types';

/** Column names from the first line only; the file is not imported. */
export async function readHeader(file: Blob): Promise<string[]> {
  const text = await file.slice(0, 65536).text();
  const end = text.search(/\r?\n/);
  const first = (end < 0 ? text : text.slice(0, end)).replace(/^﻿/, '');
  const parser = new CsvParser();
  const [record] = parser.feed(`${first}\n`, true);
  return (record ?? []).map((cell) => cell.trim());
}

export type PreflightItem = {
  key: string;
  file?: File;
  sourceId?: string;
  name: string;
  itemId: string;
  bindings: ChannelBinding[];
  /** A file problem that prevents processing, such as an unreadable header. */
  error?: string;
};

export function preflightHeaders(
  recipe: Pick<WorkflowRecipe, 'channels'>,
  headers: string[],
): ChannelBinding[] {
  return bindChannels(recipe, headers.slice(1).map(headerChannel));
}

export async function preflightFile(
  recipe: WorkflowRecipe,
  file: File,
): Promise<PreflightItem> {
  const base = {
    key: `file:${file.name}:${file.size}:${file.lastModified}`,
    file,
    name: file.name,
    itemId: itemIdFromFileName(recipe, file.name),
  };
  try {
    const headers = await readHeader(file);
    if (headers.length < 2)
      return {
        ...base,
        bindings: [],
        error: 'The first line has no signal columns.',
      };
    return { ...base, bindings: preflightHeaders(recipe, headers) };
  } catch {
    return {
      ...base,
      bindings: [],
      error: 'The file could not be read as text.',
    };
  }
}

export function preflightRecording(
  recipe: WorkflowRecipe,
  project: Project,
  sourceId: string,
): PreflightItem {
  const source = project.sources.find((item) => item.id === sourceId)!;
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  return {
    key: `source:${sourceId}`,
    sourceId,
    name: source.name,
    itemId: itemIdFromFileName(recipe, source.name),
    bindings: bindChannels(
      recipe,
      source.channels.map((id) => nodes.get(id)!),
    ),
  };
}

/** Pre-flight status: missing inputs only skip dependent steps. */
export function preflightStatus(item: PreflightItem): RunStatus {
  if (item.error) return 'error';
  return item.bindings.some((binding) => binding.problem) ? 'error' : 'pass';
}

export type BatchColumn = {
  recipeStepId: string;
  position: number;
  label: string;
  unit: string;
};

/** Value outputs as table columns, labelled from the first item that has them. */
export function batchColumns(
  project: Project,
  batch: WorkflowBatch,
): BatchColumn[] {
  const index = new WorkflowIndex(project);
  const columns = new Map<string, BatchColumn>();
  for (const run of batch.runs)
    for (const [recipeStepId, stepId] of Object.entries(run.steps)) {
      const step = index.steps.get(stepId);
      if (step?.kind !== 'value') continue;
      step.outputIds.forEach((id, position) => {
        const key = `${recipeStepId}:${position}`;
        const value = index.values.get(id);
        if (!columns.has(key) && value)
          columns.set(key, {
            recipeStepId,
            position,
            label: index.label(id),
            unit: value.unit,
          });
      });
    }
  // Keep recipe order: first appearance in the first complete item.
  return [...columns.values()];
}

export function columnValue(
  project: Project,
  index: WorkflowIndex,
  run: WorkflowRun,
  column: BatchColumn,
): number | null | undefined {
  const step = index.steps.get(run.steps[column.recipeStepId] ?? '');
  const id = step?.outputIds[column.position];
  return id ? (index.values.get(id)?.value ?? null) : undefined;
}

const numeric = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? String(value) : '';

/** One row per item, with every calculated value; text cells stay text. */
export function batchSummaryCsv(
  project: Project,
  batch: WorkflowBatch,
): string {
  const index = new WorkflowIndex(project);
  const steps = index.steps as ReadonlyMap<string, WorkflowStep>;
  const recipe = project.workflowRecipes?.find(
    (item) => item.hash === batch.recipeHash,
  );
  const columns = batchColumns(project, batch);
  const lines = [
    [
      'Item',
      'File',
      'Status',
      'Edited',
      'Problems',
      ...columns.map((column) =>
        csvText(
          `${column.label}${column.unit && column.unit !== '—' ? ` [${column.unit}]` : ''}`,
        ),
      ),
      'Workflow',
      'Revision',
      'Workflow SHA-256',
      'Processed',
    ].join(','),
  ];
  for (const run of batch.runs)
    lines.push(
      [
        csvText(run.itemId),
        csvText(run.fileName),
        csvText(STATUS_LABELS[liveRunStatus(run, steps)]),
        runEdited(run, steps) ? 'yes' : 'no',
        csvText(
          runProblems(run, steps)
            .map((problem) => problem.message)
            .join(' | '),
        ),
        ...columns.map((column) =>
          numeric(columnValue(project, index, run, column)),
        ),
        csvText(recipe?.name ?? batch.name),
        csvText(recipe?.revision ?? ''),
        csvText(batch.recipeHash),
        csvText(run.finishedAt),
      ].join(','),
    );
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The batch and run that own a recording, if it was processed by a workflow. */
export function runForSource(
  project: Project,
  sourceId: string | undefined,
): { batch: WorkflowBatch; run: WorkflowRun } | undefined {
  if (!sourceId) return undefined;
  for (const batch of project.workflowBatches ?? []) {
    for (let i = batch.runs.length - 1; i >= 0; i--)
      if (batch.runs[i].sourceId === sourceId)
        return { batch, run: batch.runs[i] };
  }
  return undefined;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
