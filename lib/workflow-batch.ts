import { openRecording } from './formats/index';
import { csvText } from './workflow-delivery';
import { WorkflowIndex } from './workflow-history';
import {
  bestTable,
  bindChannels,
  itemIdFromFileName,
  parseWorkflow,
  type ChannelBinding,
  type RecipeChannel,
  type WorkflowRecipe,
} from './workflow-recipe';
import {
  currentResults,
  describeLimits,
  liveRunStatus,
  runEdited,
  runProblems,
  STATUS_LABELS,
  worst,
} from './workflow-checks';
import type { Project } from './signal-types';
import type {
  CheckStatus,
  WorkflowBatch,
  WorkflowRun,
  WorkflowStep,
} from './workflow-types';

export type PreflightColumn = { name: string; unit: string };
export type PreflightItem = {
  key: string;
  file?: File;
  sourceId?: string;
  name: string;
  itemId: string;
  /** Signal columns found in the file (the time column excluded). */
  columns: PreflightColumn[];
  /** The group processed in a multi-group file (MDF, TDMS …). */
  table?: number;
  /** That group's name, shown beside the file. */
  group?: string;
  /** Columns chosen for missing channels: alias → column name. */
  mapping: Record<string, string>;
  bindings: ChannelBinding[];
  /** A file problem that prevents processing, such as an unreadable header. */
  error?: string;
};

/** Reads the file's metadata only; the file is not imported. */
export async function preflightFile(
  recipe: WorkflowRecipe,
  file: File,
): Promise<PreflightItem> {
  const base = {
    key: `file:${file.name}:${file.size}:${file.lastModified}`,
    file,
    name: file.name,
    itemId: itemIdFromFileName(recipe, file.name),
    mapping: {},
  };
  try {
    const { tables } = await openRecording(file);
    const table = bestTable(recipe, tables);
    const columns = tables[table]?.channels ?? [];
    if (!columns.length)
      return {
        ...base,
        columns: [],
        bindings: [],
        error: 'The file has no signal columns.',
      };
    return {
      ...base,
      columns,
      ...(tables.length > 1 ? { table, group: tables[table].name } : {}),
      bindings: bindChannels(recipe, columns),
    };
  } catch (error) {
    return {
      ...base,
      columns: [],
      bindings: [],
      error:
        error instanceof Error && error.message
          ? error.message
          : 'The file could not be read.',
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
  const columns = source.channels.map((id) => {
    const node = nodes.get(id)!;
    return { name: node.name, unit: node.unit };
  });
  return {
    key: `source:${sourceId}`,
    sourceId,
    name: source.name,
    itemId: itemIdFromFileName(recipe, source.name),
    columns,
    mapping: {},
    bindings: bindChannels(recipe, columns),
  };
}

/** Re-bind an item with column choices; an empty choice removes a mapping. */
export function remapItem(
  recipe: Pick<WorkflowRecipe, 'channels'>,
  item: PreflightItem,
  changes: Record<string, string>,
): PreflightItem {
  if (item.error) return item;
  const mapping = { ...item.mapping };
  for (const [alias, column] of Object.entries(changes))
    if (column) mapping[alias] = column;
    else delete mapping[alias];
  return {
    ...item,
    mapping,
    bindings: bindChannels(recipe, item.columns, mapping),
  };
}

/** Files with the same columns, in any order, share one header signature. */
export const headerSignature = (item: PreflightItem) =>
  item.columns
    .map((column) => `${column.name.trim().toLowerCase()}[${column.unit}]`)
    .sort()
    .join('\u0000');

export type PreflightState = 'ready' | 'error' | 'unreadable';

/** Ready, will error (missing inputs skip dependent steps) or can't be read. */
export function preflightStatus(item: PreflightItem): PreflightState {
  if (item.error) return 'unreadable';
  return item.bindings.some((binding) => binding.problem) ? 'error' : 'ready';
}

const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Columns ordered as candidates for a missing channel: matching unit, shared
 * words and similar spelling first. Columns already bound sort last.
 */
export function rankColumns(
  channel: Pick<RecipeChannel, 'name' | 'unit'>,
  columns: PreflightColumn[],
  bound: ReadonlySet<string> = new Set(),
): PreflightColumn[] {
  const wanted = tokens(channel.name);
  const compact = wanted.join('');
  const score = (column: PreflightColumn) => {
    const words = tokens(column.name);
    const joined = words.join('');
    let value = 0;
    if (channel.unit !== undefined && column.unit === channel.unit) value += 4;
    value += 3 * words.filter((word) => wanted.includes(word)).length;
    if (
      compact &&
      joined &&
      (joined.includes(compact) || compact.includes(joined))
    )
      value += 3;
    if (bound.has(column.name.trim().toLowerCase())) value -= 10;
    return value;
  };
  return columns
    .map((column, position) => ({ column, position, score: score(column) }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .map((entry) => entry.column);
}

export type BatchColumn = {
  recipeStepId: string;
  position: number;
  label: string;
  unit: string;
};

/**
 * Value outputs as table columns in workflow order, labelled from the first
 * item that has them, so columns never depend on which item came first.
 */
export function batchColumns(
  project: Project,
  batch: WorkflowBatch,
): BatchColumn[] {
  const index = new WorkflowIndex(project);
  const columns = new Map<string, BatchColumn>();
  let order: string[] = [];
  try {
    const text = project.workflowRecipes?.find(
      (item) => item.hash === batch.recipeHash,
    )?.text;
    if (text) order = parseWorkflow(text).steps.map((step) => step.id);
  } catch {
    // Without the workflow, first appearance is the best order available.
  }
  const rank = (id: string) => {
    const position = order.indexOf(id);
    return position < 0 ? order.length : position;
  };
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
  return [...columns.values()].sort(
    (a, b) =>
      rank(a.recipeStepId) - rank(b.recipeStepId) || a.position - b.position,
  );
}

/** A value cell's evaluated checks: worst status and its limit messages. */
export function columnCheck(
  index: WorkflowIndex,
  run: WorkflowRun,
  column: BatchColumn,
): { status: CheckStatus; message: string } | undefined {
  const step = index.steps.get(run.steps[column.recipeStepId] ?? '');
  const id = step?.outputIds[column.position];
  if (!step || !id) return undefined;
  const results = currentResults(step).filter(
    (result) => result.outputId === id,
  );
  if (!results.length) return undefined;
  const status = worst(
    results.map((result) => result.status),
    'pass',
  );
  const message = results
    .map((result) => {
      const check = step.checks?.[result.check];
      return status === 'pass' && check
        ? `Within ${describeLimits(check, index.values.get(id)?.unit)}`
        : result.message;
    })
    .join('\n');
  return { status, message };
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
      'Mapped channels',
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
        csvText(mappedChannels(recipe?.text, run).join(' | ')),
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

/** "Torque ← Shaft torque" for each channel bound to another column. */
export function mappedChannels(
  recipeText: string | undefined,
  run: WorkflowRun,
): string[] {
  const entries = Object.entries(run.channelMap ?? {});
  if (!entries.length) return [];
  let channels: RecipeChannel[] = [];
  try {
    if (recipeText) channels = parseWorkflow(recipeText).channels;
  } catch {
    // Fall back to the aliases the run recorded.
  }
  return entries.map(
    ([alias, column]) =>
      `${channels.find((channel) => channel.alias === alias)?.name ?? alias} ← ${column}`,
  );
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

/** Device-local memory of the open batch results, restored after a reload. */
const BATCH_VIEW_KEY = 'stratum-batch-view-v1';
export function storedBatchView(): string {
  try {
    return localStorage.getItem(BATCH_VIEW_KEY) ?? '';
  } catch {
    return '';
  }
}
export function storeBatchView(batchId: string) {
  try {
    if (batchId) localStorage.setItem(BATCH_VIEW_KEY, batchId);
    else localStorage.removeItem(BATCH_VIEW_KEY);
  } catch {
    // The batch view still works for this session.
  }
}
