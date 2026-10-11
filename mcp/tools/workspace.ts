/** Workspace tools: status, reset, backups, examples, Undo/Redo, raw requests. */
import type { EngineCommand } from '../../lib/engine-requests';
import {
  PHASER_UNITS,
  PHASER_WORKFLOW,
  phaserRecording,
} from '../../lib/cam-phaser-example';
import {
  componentRecording,
  EOL_COMPONENTS,
  EOL_WORKFLOW,
} from '../../lib/eol-example';
import type { Project } from '../../lib/signal-types';
import { fileRef } from '../backend';
import { batches, history, recordings } from '../describe';
import {
  commit,
  objectArg,
  OVERWRITE,
  TARGET,
  type ServerContext,
} from '../context';
import type { Tool } from '../protocol';
import { runBatch } from './workflows';

const counts = (project: Project) => ({
  recordings: project.sources.length,
  steps: project.workflowSteps?.length ?? 0,
  signals: project.nodes.filter((node) => !node.internal).length,
  values: project.values?.length ?? 0,
  segmentSets: project.segmentSets?.length ?? 0,
  batches: project.workflowBatches?.length ?? 0,
});

const SECTIONS = [
  'sources',
  'nodes',
  'values',
  'workflowSteps',
  'segmentSets',
  'segments',
  'workflowBatches',
  'workflowRecipes',
  'labels',
] as const;

export function workspaceTools(context: ServerContext): Tool[] {
  return [
    {
      name: 'stratum_status',
      title: 'Workspace and session status',
      description:
        'Summarises the engine workspace (counts, Undo/Redo labels, latest steps) and the UI session if one is running. Start here.',
      inputSchema: {
        type: 'object',
        properties: { target: TARGET },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const backend = context.backend(args.target);
        const state = await backend.state();
        const latest = history(state.project, { limit: 200, outputLimit: 3 });
        return {
          target: backend.target,
          ...counts(state.project),
          revision: state.revision,
          undo: state.canUndo ? (state.undoLabel ?? 'last change') : null,
          redo: state.canRedo ? (state.redoLabel ?? 'last change') : null,
          latestSteps: latest.steps.slice(-5).map((step) => ({
            id: step.id,
            ref: step.ref,
            name: step.name,
            outputs: step.outputCount,
          })),
          ...(context.mode === 'app'
            ? {}
            : {
                ui: context.ui?.alive
                  ? {
                      source: context.ui.source,
                      url: context.ui.url,
                      size: `${context.ui.width}×${context.ui.height}`,
                      filesDir: context.ui.filesDir,
                    }
                  : null,
              }),
        };
      },
    },
    {
      name: 'workspace_reset',
      developer: true,
      title: 'Start an empty engine workspace',
      description:
        'Discards the engine workspace (in memory) and starts an empty one. For the UI, close and relaunch its session instead.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { destructiveHint: true },
      run: async () => {
        if (!context.primary.reset)
          throw new Error('This workspace cannot be reset here.');
        await context.primary.reset();
        return 'The engine workspace is empty.';
      },
    },
    {
      name: 'workspace_save',
      title: 'Save a workspace backup',
      description:
        'Writes a workspace backup (.stratum, the Workspace dialog\'s "Back up") to a file, so a workspace can be reopened later or moved between engine and UI.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              context.mode === 'app'
                ? 'Full path of the .stratum file to write.'
                : 'Destination; relative to the repository root. Default outputs/mcp/workspace-<time>.stratum.',
          },
          overwrite: OVERWRITE,
          target: TARGET,
        },
        ...(context.mode === 'app' ? { required: ['path'] } : {}),
      },
      run: async (args, call) => {
        const reply = await context
          .backend(args.target)
          .request({ type: 'backup-workspace' }, call.progress);
        if (!reply.bytes) throw new Error('The backup returned no data.');
        const path = context.save(
          reply.bytes,
          args.path as string | undefined,
          `workspace-${Date.now()}.stratum`,
          !!args.overwrite,
        );
        return { path, bytes: reply.bytes.length };
      },
    },
    {
      name: 'workspace_open',
      title: 'Restore a workspace backup',
      description:
        'Replaces the workspace with a .stratum backup (Undo restores the previous one). Works for engine and UI targets.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The .stratum file.' },
          target: TARGET,
        },
        required: ['path'],
      },
      annotations: { destructiveHint: true },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const reply = await backend.request(
          {
            type: 'restore-workspace',
            file: fileRef(context.path(String(args.path))),
          },
          call.progress,
        );
        if (reply.type !== 'project') throw new Error('Restore failed.');
        return { restored: counts(reply.project) };
      },
    },
    {
      name: 'load_example',
      title: 'Load an example',
      description:
        'Loads a worked example. "motor-test": the seven-step motor example (synthetic recording, smoothing, multiplication, run segments, values, nested segments), one undoable action. "eol-rig" / "cam-phaser-eol": runs that batch example from examples/ (8 or 7 recordings through a saved workflow with checks).',
      inputSchema: {
        type: 'object',
        properties: {
          example: {
            type: 'string',
            enum: ['motor-test', 'eol-rig', 'cam-phaser-eol'],
          },
          target: TARGET,
        },
        required: ['example'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        if (args.example === 'motor-test')
          return commit(backend, { type: 'demo-workflow' }, call);
        const example =
          args.example === 'eol-rig'
            ? {
                recipe: EOL_WORKFLOW,
                files: EOL_COMPONENTS.map(({ serial, variant }) =>
                  componentRecording(serial, variant),
                ),
              }
            : {
                recipe: PHASER_WORKFLOW,
                files: PHASER_UNITS.map(({ serial, variant }) =>
                  phaserRecording(serial, variant),
                ),
              };
        return runBatch(context, backend, call, {
          ...example,
          batchName: `${args.example as string} example`,
        });
      },
    },
    {
      name: 'undo',
      title: 'Undo',
      description: 'Undoes the last workspace change (Ctrl+Z).',
      inputSchema: { type: 'object', properties: { target: TARGET } },
      run: async (args, call) =>
        commit(context.backend(args.target), { type: 'undo' }, call),
    },
    {
      name: 'redo',
      title: 'Redo',
      description: 'Redoes the last undone change (Ctrl+Y).',
      inputSchema: { type: 'object', properties: { target: TARGET } },
      run: async (args, call) =>
        commit(context.backend(args.target), { type: 'redo' }, call),
    },
    {
      name: 'get_project',
      developer: true,
      title: 'Raw project records',
      description:
        'Returns raw project records (the persisted model) for debugging: one section, optionally only some IDs, or the whole project written to a JSON file.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...SECTIONS] },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only records with these IDs.',
          },
          savePath: {
            type: 'string',
            description: 'Write the whole project as JSON here instead.',
          },
          target: TARGET,
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const { project } = await context.backend(args.target).state();
        if (args.savePath) {
          const path = context.save(
            new TextEncoder().encode(JSON.stringify(project, null, 1)),
            args.savePath as string,
            'project.json',
          );
          return { path, ...counts(project) };
        }
        if (!args.section)
          return {
            sections: SECTIONS,
            ...counts(project),
            recordings: recordings(project),
            batches: batches(project).length,
          };
        const section = project[args.section as (typeof SECTIONS)[number]];
        const ids = args.ids as string[] | undefined;
        if (Array.isArray(section)) {
          const records = ids
            ? section.filter((record) =>
                ids.includes((record as { id: string }).id),
              )
            : section;
          return records.length > 50 && !ids
            ? {
                total: records.length,
                first50: records.slice(0, 50),
                note: 'Pass ids or savePath for the rest.',
              }
            : records;
        }
        return section ?? null;
      },
    },
    {
      name: 'engine_request',
      developer: true,
      title: 'Send any engine request',
      description:
        'Sends one raw worker-protocol request (EngineRequest in lib/signal-types.ts, handled by lib/engine-requests.ts) and returns its reply. Any request type the workbench uses works here, including ones added later. Put {"$file": "path"} wherever a File or Blob goes (import, restore-workspace, run-workflow). Project replies are summarised (changed steps) unless fullProject is set; export/backup bytes are saved to savePath.',
      inputSchema: {
        type: 'object',
        properties: {
          request: objectArg(
            'The request, e.g. {"type": "derive-many", "parentIds": ["…"], "operation": "smooth", "parameter": 0.5}.',
          ),
          savePath: {
            type: 'string',
            description: 'Where to write bytes from export/backup replies.',
          },
          fullProject: {
            type: 'boolean',
            description: 'Return the whole project from a project reply.',
          },
          target: TARGET,
        },
        required: ['request'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const request = args.request as EngineCommand;
        if (!request || typeof request.type !== 'string')
          throw new Error('request needs a "type".');
        if (request.type === ('cancel' as string)) {
          backend.cancel();
          return 'Cancel sent.';
        }
        const reply = await backend.request(request, call.progress);
        if (reply.type === 'project' && !args.fullProject) {
          return {
            type: 'project',
            ...counts(reply.project),
            undo: reply.undoLabel,
            latestSteps: history(reply.project, { limit: 200 }).steps.slice(-3),
          };
        }
        if (reply.bytes) {
          const path = context.save(
            reply.bytes,
            args.savePath as string | undefined,
            `${request.type}-${Date.now()}.${request.type === 'backup-workspace' ? 'stratum' : 'csv'}`,
          );
          return { type: reply.type, path, bytes: reply.bytes.length };
        }
        const text = JSON.stringify(reply);
        return text.length > 60_000
          ? {
              type: reply.type,
              note: `Reply is ${text.length} characters; showing the start.`,
              start: text.slice(0, 60_000),
            }
          : reply;
      },
    },
  ];
}
