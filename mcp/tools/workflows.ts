/** Workflow files, batches and exports. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  itemIdFromFileName,
  parseWorkflow,
  serializeWorkflow,
} from '../../lib/workflow-recipe';
import { extractWorkflow } from '../../lib/workflow-extract';
import { fileRef, type Backend } from '../backend';
import { batches, findRecording } from '../describe';
import { argList, stringList, TARGET, type ServerContext } from '../context';
import {
  formatJson,
  type CallContext,
  type Tool,
  type ToolResult,
} from '../protocol';

/** Workflow text from a path or the text itself. */
function recipeText(context: ServerContext, value: string) {
  if (!value.includes('\n') && /\.ya?ml$/i.test(value.trim())) {
    const path = context.path(value.trim());
    if (!existsSync(path)) throw new Error(`No workflow file at ${path}.`);
    return readFileSync(path, 'utf8');
  }
  return value;
}

/** Expands `*` and `?` in the last part of each path. */
function expand(context: ServerContext, paths: string[]) {
  return paths.flatMap((path) => {
    const full = context.path(path);
    const name = basename(full);
    if (!/[*?]/.test(name)) return [full];
    const pattern = new RegExp(
      `^${name
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i',
    );
    const folder = dirname(full);
    return readdirSync(folder)
      .filter((item) => pattern.test(item))
      .sort()
      .map((item) => join(folder, item));
  });
}

/** Runs a workflow over files as one batch, as Run workflow… does. */
export async function runBatch(
  context: ServerContext,
  backend: Backend,
  call: CallContext,
  options: {
    recipe: string;
    files: string[];
    batchName?: string;
    channelMap?: Record<string, string>;
  },
) {
  const text = recipeText(context, options.recipe);
  const recipe = parseWorkflow(text);
  const files = expand(context, options.files);
  if (!files.length) throw new Error('No files match.');
  const batchId = randomUUID();
  const failures: { name: string; message: string }[] = [];
  let cancelled = false;
  for (const [position, file] of files.entries()) {
    if (call.signal.aborted) {
      cancelled = true;
      break;
    }
    call.progress(
      `Processing ${basename(file)} · ${position + 1} of ${files.length}`,
      position / files.length,
    );
    try {
      await backend.request({
        type: 'run-workflow',
        recipe: text,
        batchId,
        batchName: options.batchName ?? recipe.name,
        itemId: itemIdFromFileName(recipe, basename(file)),
        file: fileRef(file),
        ...(options.channelMap ? { channelMap: options.channelMap } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancelled/i.test(message)) {
        cancelled = true;
        break;
      }
      failures.push({ name: basename(file), message });
    }
  }
  const reply = await backend.request({
    type: 'finish-batch',
    batchId,
    state: cancelled ? 'cancelled' : 'complete',
    failures,
  });
  if (reply.type !== 'project') throw new Error('Finishing the batch failed.');
  const batch = batches(reply.project).find((item) => item.id === batchId);
  const tally: Record<string, number> = {};
  for (const run of batch?.runs ?? [])
    tally[run.status] = (tally[run.status] ?? 0) + 1;
  return { batch: batch ?? null, tally, ...(cancelled ? { cancelled } : {}) };
}

export function workflowTools(context: ServerContext): Tool[] {
  return [
    {
      name: 'workflow_validate',
      title: 'Validate a workflow file',
      description:
        'Parses and validates a .stratum.yaml workflow (path or text) without running it; errors name their line.',
      inputSchema: {
        type: 'object',
        properties: {
          recipe: {
            type: 'string',
            description: 'A .stratum.yaml path or the workflow text.',
          },
        },
        required: ['recipe'],
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const recipe = parseWorkflow(recipeText(context, String(args.recipe)));
        return {
          valid: true,
          name: recipe.name,
          ...(recipe.revision ? { revision: recipe.revision } : {}),
          channels: recipe.channels,
          steps: recipe.steps.map((step) => ({
            id: step.id,
            operation:
              'operation' in step.operation
                ? `${step.operation.kind} ${step.operation.operation}`
                : step.operation.kind,
            ...(step.checks?.length ? { checks: step.checks.length } : {}),
          })),
        };
      },
    },
    {
      name: 'workflow_extract',
      title: 'Save workflow from a recording',
      description:
        "Builds a .stratum.yaml workflow from a recording's History (Save workflow…): channels bound by name, outputs by step reference. Returns the text, skipped steps with reasons and warnings; optionally writes it.",
      inputSchema: {
        type: 'object',
        properties: {
          recording: { type: 'string', description: 'Recording ID or name.' },
          name: { type: 'string', description: 'Workflow name.' },
          stepIds: stringList('Only these steps (default: all eligible).'),
          savePath: { type: 'string' },
          target: TARGET,
        },
        required: ['recording', 'name'],
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const { project } = await context.backend(args.target).state();
        const source = findRecording(project, args.recording as string);
        if (!source)
          throw new Error(`No recording ${JSON.stringify(args.recording)}.`);
        const extracted = extractWorkflow(project, source.id, {
          name: String(args.name),
          ...(args.stepIds
            ? { stepIds: new Set(argList(args.stepIds, 'stepIds')) }
            : {}),
        });
        const text = serializeWorkflow(extracted.recipe);
        const path = args.savePath ? context.path(args.savePath as string) : '';
        if (path) writeFileSync(path, text);
        return {
          content: [
            {
              type: 'text',
              text: formatJson({
                ...(path ? { path } : {}),
                skipped: extracted.skipped,
                warnings: extracted.warnings,
              }),
            },
            { type: 'text', text },
          ],
        } satisfies ToolResult;
      },
    },
    {
      name: 'workflow_run',
      title: 'Run a workflow (batch)',
      description:
        "Runs a workflow over recording files as one batch (Run workflow…): each file is imported, replayed and checked atomically; later items share one Undo entry. Files accept * and ? in the name. Returns each item's status and first problems.",
      inputSchema: {
        type: 'object',
        properties: {
          recipe: {
            type: 'string',
            description: 'A .stratum.yaml path or the workflow text.',
          },
          files: stringList('Recording files, e.g. examples/eol-rig/*.csv.'),
          batchName: { type: 'string' },
          channelMap: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Pre-flight choices for missing channels: alias → column name.',
          },
          target: TARGET,
        },
        required: ['recipe', 'files'],
      },
      run: async (args, call) =>
        runBatch(context, context.backend(args.target), call, {
          recipe: String(args.recipe),
          files: argList(args.files, 'files'),
          batchName: args.batchName as string | undefined,
          channelMap: args.channelMap as Record<string, string> | undefined,
        }),
    },
    {
      name: 'export_data',
      title: 'Export data',
      description:
        'Writes signals/values to CSV like Export data…: "samples" (evaluated samples, each signal on its own axis) or "summary" (one row per output with statistics or value).',
      inputSchema: {
        type: 'object',
        properties: {
          ids: stringList('Signal and value IDs.'),
          kind: { type: 'string', enum: ['samples', 'summary'] },
          path: {
            type: 'string',
            description: 'Destination (default outputs/mcp/<kind>-<time>.csv).',
          },
          target: TARGET,
        },
        required: ['ids', 'kind'],
      },
      run: async (args, call) => {
        const reply = await context.backend(args.target).request(
          {
            type: args.kind === 'samples' ? 'export-samples' : 'export',
            ids: argList(args.ids, 'ids'),
          },
          call.progress,
        );
        if (!reply.bytes) throw new Error('The export returned no data.');
        const path = context.save(
          reply.bytes,
          args.path as string | undefined,
          `${args.kind as string}-${Date.now()}.csv`,
        );
        const text = new TextDecoder().decode(reply.bytes.slice(0, 1500));
        return {
          path,
          bytes: reply.bytes.length,
          start: text.split('\n').slice(0, 6).join('\n'),
        };
      },
    },
  ];
}
