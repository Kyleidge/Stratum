/** Read-only tools: History, Details, search, samples, statistics and plots. */
import type { Plot, Point } from '../../lib/signal-types';
import type { ValueStatistics } from '../../lib/workflow-types';
import {
  batches,
  describe,
  history,
  indexOf,
  recordings,
  search,
  segmentSets,
} from '../describe';
import { argList, objectArg, TARGET, type ServerContext } from '../context';
import { plotPng } from '../plot-image';
import type { Tool, ToolResult } from '../protocol';

const READ = { readOnlyHint: true } as const;

const within = objectArg(
  'Segments to work within: {"setId": "<segment set ID>"} for all its segments, plus "segmentIds": [...] for some. See list_segments.',
);

export function inspectTools(context: ServerContext): Tool[] {
  return [
    {
      name: 'list_history',
      title: 'History',
      description:
        'Chronological steps (oldest first) with their outputs, as the History panel lists them. Filter by text, output kind or recording. Each output has the ID other tools take.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Words to match.' },
          show: {
            type: 'string',
            enum: ['all', 'signals', 'values', 'segments'],
          },
          recording: {
            type: 'string',
            description: 'Recording ID or name.',
          },
          offset: { type: 'integer' },
          limit: { type: 'integer', description: 'Steps (default 50).' },
          outputLimit: {
            type: 'integer',
            description: 'Outputs listed per step (default 8).',
          },
          target: TARGET,
        },
      },
      annotations: READ,
      run: async (args) =>
        history((await context.backend(args.target).state()).project, args),
    },
    {
      name: 'describe',
      title: 'Details',
      description:
        'Details of any ID: a step (settings, inputs, outputs, checks, the savedCommand edit_step takes, delete impact), a signal or value (properties, producing step, lineage, used by), a segment, recording, segment set or batch. Steps can also be named by reference, e.g. "#003".',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, target: TARGET },
        required: ['id'],
      },
      annotations: READ,
      run: async (args) =>
        describe(
          (await context.backend(args.target).state()).project,
          String(args.id),
        ),
    },
    {
      name: 'search',
      title: 'Search steps and outputs',
      description:
        'Word search over step names and output names (like Ctrl+K), returning IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          limit: { type: 'integer' },
          target: TARGET,
        },
        required: ['text'],
      },
      annotations: READ,
      run: async (args) =>
        search(
          (await context.backend(args.target).state()).project,
          String(args.text),
          Number(args.limit ?? 40),
        ),
    },
    {
      name: 'list_recordings',
      title: 'Recordings',
      description:
        'Imported recordings with their time span, clock and original signals (IDs, names, units).',
      inputSchema: { type: 'object', properties: { target: TARGET } },
      annotations: READ,
      run: async (args) =>
        recordings((await context.backend(args.target).state()).project),
    },
    {
      name: 'list_segments',
      title: 'Segment sets',
      description:
        'Segment sets (from Segment steps) and their segments with times, for "within" scopes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'A segment set or Segment step ID.',
          },
          target: TARGET,
        },
      },
      annotations: READ,
      run: async (args) =>
        segmentSets(
          (await context.backend(args.target).state()).project,
          args.id as string | undefined,
        ),
    },
    {
      name: 'list_batches',
      title: 'Batches',
      description:
        "Workflow batches with each item's live status (pass, warning, fail, error, none) and first problems.",
      inputSchema: { type: 'object', properties: { target: TARGET } },
      annotations: READ,
      run: async (args) =>
        batches((await context.backend(args.target).state()).project),
    },
    {
      name: 'read_samples',
      title: 'Evaluated samples',
      description:
        'Exact evaluated samples [time, value] of a signal (original or derived), from an offset. Use for checking numerical results.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          offset: { type: 'integer', description: 'First sample (default 0).' },
          count: {
            type: 'integer',
            description: 'Samples to return (default 100, at most 2000).',
          },
          target: TARGET,
        },
        required: ['id'],
      },
      annotations: READ,
      run: async (args) => {
        const backend = context.backend(args.target);
        const wanted = Math.max(1, Math.min(2000, Number(args.count ?? 100)));
        const offset = Math.max(0, Number(args.offset ?? 0));
        const rows: Point[] = [];
        let more = true;
        while (rows.length < wanted && more) {
          const reply = await backend.request({
            type: 'rows',
            id: String(args.id),
            offset: offset + rows.length,
          });
          if (reply.type !== 'rows') throw new Error('Unexpected reply.');
          rows.push(...reply.rows);
          more = reply.hasMore;
        }
        const count = await backend.request({
          type: 'sample-count',
          id: String(args.id),
        });
        return {
          id: args.id,
          totalSamples: count.type === 'sample-count' ? count.count : undefined,
          offset,
          rows: rows.slice(0, wanted),
          ...(more || rows.length > wanted
            ? { next: offset + Math.min(rows.length, wanted) }
            : {}),
        };
      },
    },
    {
      name: 'signal_statistics',
      title: 'Exact statistics',
      description:
        "Exact statistics of signals from one streaming pass (the numbers values are calculated from): count, valid duration, averages, min/max with times, RMS, standard deviation, area, start/end. Optionally within segments, and with one value calculation evaluated (operation + parameters) as Value's preview does.",
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          within,
          operation: {
            type: 'string',
            description: 'A value operation to evaluate too (see catalog).',
          },
          parameters: objectArg('Its settings, e.g. {"threshold": 900}.'),
          target: TARGET,
        },
        required: ['ids'],
      },
      annotations: READ,
      run: async (args) => {
        const backend = context.backend(args.target);
        const project = (await backend.state()).project;
        const index = indexOf(project);
        const reply = await backend.request({
          type: 'value-preview',
          ids: argList(args.ids, 'ids'),
          ...(args.within ? { within: args.within } : {}),
          ...(args.operation ? { operation: args.operation } : {}),
          ...(args.parameters ? { parameters: args.parameters } : {}),
        } as never);
        if (reply.type !== 'value-preview')
          throw new Error('Unexpected reply.');
        return reply.statistics.map((item: ValueStatistics) => ({
          name: index.label(item.inputId),
          ...(item.segmentId
            ? { segment: index.segmentLabel(item.segmentId) }
            : {}),
          unit: index.nodes.get(item.inputId)?.unit,
          ...item,
        }));
      },
    },
    {
      name: 'measure',
      title: 'Measure between two times',
      description:
        "Exact measurement of signals between times a and b (the plot's two-cursor measurement): values at each cursor and statistics of the region, from evaluated samples.",
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          a: { type: 'number', description: 'First cursor time (s).' },
          b: { type: 'number', description: 'Second cursor time (s).' },
          target: TARGET,
        },
        required: ['ids', 'a', 'b'],
      },
      annotations: READ,
      run: async (args) => {
        const reply = await context.backend(args.target).request({
          type: 'measure-plot',
          items: argList(args.ids, 'ids').map((id) => ({
            id,
            a: Number(args.a),
            b: Number(args.b),
          })),
        });
        if (reply.type !== 'plot-measurements')
          throw new Error('Unexpected reply.');
        return reply.measurements;
      },
    },
    {
      name: 'plot',
      title: 'Plot signals',
      description:
        "Draws signals as a PNG (one lane per unit, shared time axis) from the engine's min/max envelopes, with each plot's summary. For looking at shapes only: use read_samples/signal_statistics for numbers. Optional time range.",
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          range: {
            type: 'array',
            items: { type: 'number' },
            description: "[start, end] in seconds on the signals' axis.",
          },
          title: { type: 'string' },
          width: { type: 'integer', description: 'Pixels (default 960).' },
          savePath: { type: 'string', description: 'Also write the PNG.' },
          points: {
            type: 'integer',
            description: 'Also return up to this many envelope points each.',
          },
          target: TARGET,
        },
        required: ['ids'],
      },
      annotations: READ,
      run: async (args) => {
        const backend = context.backend(args.target);
        const ids = argList(args.ids, 'ids');
        const range = args.range as [number, number] | undefined;
        const reply = await backend.request({
          type: 'view',
          ids,
          ...(range ? { range } : {}),
        });
        if (reply.type !== 'plots') throw new Error('Unexpected reply.');
        const index = indexOf((await backend.state()).project);
        const series = reply.plots.map((plot: Plot) => ({
          label: index.label(plot.id),
          unit: index.nodes.get(plot.id)?.unit ?? '',
          plot,
        }));
        const png = await plotPng(series, {
          title: args.title as string | undefined,
          width: args.width as number | undefined,
        });
        const path = args.savePath
          ? context.save(png, args.savePath as string, 'plot.png')
          : undefined;
        const points = Number(args.points ?? 0);
        const summary = series.map((item) => ({
          id: item.plot.id,
          name: item.label,
          unit: item.unit,
          summary: item.plot.summary,
          ...(points
            ? {
                points: item.plot.points.filter(
                  (_, i, all) =>
                    i % Math.max(1, Math.ceil(all.length / points)) === 0,
                ),
              }
            : {}),
        }));
        return {
          content: [
            {
              type: 'image',
              data: png.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text',
              text: JSON.stringify(
                { ...(path ? { path } : {}), plots: summary },
                null,
                2,
              ),
            },
          ],
        } satisfies ToolResult;
      },
    },
  ];
}
