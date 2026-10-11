/**
 * Operation tools: import, Derive, Value, Segment, Compare & align, Edit,
 * Delete, Rename and checks. Each commits like its dialog does (optionally
 * named) and reports the steps it created or changed; `preview` runs the
 * dialog's preview instead and saves nothing.
 */
import type { EngineCommand } from '../../lib/engine-requests';
import { FUNCTIONS } from '../../lib/signal-functions';
import type { Operation } from '../../lib/signal-types';
import type { WorkflowCommand } from '../../lib/workflow-lifecycle';
import { fileRef } from '../backend';
import { changedSteps, indexOf, outputInfo } from '../describe';
import {
  argList,
  commit,
  objectArg,
  stringList,
  TARGET,
  type ServerContext,
} from '../context';
import type { Tool } from '../protocol';

const NAME = {
  type: 'string',
  description:
    'Optional step name (as typed in the dialog); a named step names its outputs after it.',
};
const PREVIEW = {
  type: 'boolean',
  description:
    "Run the dialog's live preview instead of creating anything (nothing is saved).",
};
const WITHIN = objectArg(
  'Work within segments: {"setId": "…"} (all) or {"setId": "…", "segmentIds": ["…"]}. One output per input and segment. See list_segments.',
);
const BINDINGS = objectArg(
  'Settings taken from values: {"<setting>": {"valueIds": ["…"], "factor": 1}}. Several values are matched to each input by lineage.',
);

export function operationTools(context: ServerContext): Tool[] {
  return [
    {
      name: 'import_recording',
      title: 'Import recordings',
      description:
        'Imports recording files (CSV/TSV, MDF, TDMS, MAT, XLSX, WAV) as one import step each. Without options, CSV columns are read as the file describes them, leniently (like a batch). Pass layout/units/names to mirror the import dialog, which then refuses unrecognised units.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: stringList(
            'Files; relative paths are from the repository root.',
          ),
          tables: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Tables (time axes) to import from multi-table files.',
          },
          layout: objectArg(
            'Delimited text layout (lib/formats/delimited-layout.ts): which columns are time axes, signals or skipped.',
          ),
          units: {
            type: 'array',
            description: 'Units by table then channel, as the dialog sends.',
          },
          custom: stringList('Unrecognised unit labels to keep.'),
          names: { type: 'array', description: 'Signal names by table.' },
          tableNames: {
            type: 'array',
            description: 'Recording names by table.',
          },
          target: TARGET,
        },
        required: ['paths'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const results = [];
        for (const path of argList(args.paths, 'paths')) {
          const file = fileRef(context.path(path));
          results.push({
            path,
            ...(await commit(
              backend,
              {
                type: 'import',
                file,
                ...Object.fromEntries(
                  ['tables', 'layout', 'units', 'custom', 'names', 'tableNames']
                    .filter((key) => args[key] !== undefined)
                    .map((key) => [key, args[key]]),
                ),
              } as unknown as EngineCommand,
              call,
            )),
          });
        }
        return results.length === 1 ? results[0] : results;
      },
    },
    {
      name: 'derive',
      title: 'Derive signals',
      description:
        'Derive: applies one single-input function to each input signal (one output each), optionally within segments. Operations and parameters: catalog section "derive". Formulas: operation "formula" with formula {"expression": "A * B / 2", "signals": {"B": ["<id>"]}} (A = each input; lowercase names bind values through bindings). Unit conversion: operation "convert" with unit.',
      inputSchema: {
        type: 'object',
        properties: {
          inputIds: stringList('Input signal IDs.'),
          operation: { type: 'string' },
          parameter: {
            type: 'number',
            description:
              "The function's one number (window, cutoff, factor…); defaults to the catalog default.",
          },
          bindings: BINDINGS,
          unit: { type: 'string', description: 'Formula or conversion unit.' },
          formula: objectArg('{"expression": "…", "signals": {"B": ["id"]}}'),
          within: WITHIN,
          name: NAME,
          preview: PREVIEW,
          range: {
            type: 'array',
            items: { type: 'number' },
            description: 'Preview only: [start, end] to evaluate.',
          },
          target: TARGET,
        },
        required: ['inputIds', 'operation'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const operation = String(args.operation) as Operation;
        const spec = FUNCTIONS.find((item) => item.operation === operation);
        if (!spec && !String(operation).startsWith('time-'))
          throw new Error(
            `Unknown operation "${operation}". See catalog section "derive".`,
          );
        const parameter = Number(args.parameter ?? spec?.defaultValue ?? 0);
        const inputIds = argList(args.inputIds, 'inputIds');
        const extra = {
          ...(args.bindings ? { bindings: args.bindings } : {}),
          ...(args.unit !== undefined ? { unit: args.unit } : {}),
          ...(args.formula ? { formula: args.formula } : {}),
          ...(args.within ? { within: args.within } : {}),
        };
        if (args.preview) {
          const reply = await backend.request({
            type: 'derive-preview',
            inputId: inputIds[0],
            operation,
            parameter,
            ...extra,
            ...(args.range ? { range: args.range } : {}),
          } as EngineCommand);
          if (reply.type !== 'derive-preview')
            throw new Error('Unexpected reply.');
          const { node, plot, inputs, domain } = reply.preview;
          return {
            preview: {
              name: node.name,
              unit: node.unit,
              parameters: node.parameters,
              domain,
              summary: plot.summary,
              inputSummaries: inputs.map((input) => input.summary),
            },
            note:
              inputIds.length > 1
                ? 'Previewed the first input only, as the dialog does.'
                : undefined,
          };
        }
        return commit(
          backend,
          {
            type: 'derive-many',
            parentIds: inputIds,
            operation,
            parameter,
            ...extra,
          } as EngineCommand,
          call,
          args.name,
        );
      },
    },
    {
      name: 'calculate_values',
      title: 'Calculate values',
      description:
        'Value: reduces each input signal to one number (per segment when within), e.g. time-average, maximum, first-crossing. Operations and settings: catalog section "value". Calculate from values: operation "calculate" with inputIds = values and expression in a (each input value) and other lowercase names bound through bindings.',
      inputSchema: {
        type: 'object',
        properties: {
          inputIds: stringList('Input signal IDs (values for "calculate").'),
          operation: { type: 'string' },
          parameters: objectArg(
            'Settings: threshold, edge (1 rising, −1 falling), time, hysteresis, debounce.',
          ),
          bindings: BINDINGS,
          within: WITHIN,
          expression: {
            type: 'string',
            description: '"calculate" only: the formula.',
          },
          unit: { type: 'string', description: '"calculate" only.' },
          name: NAME,
          preview: PREVIEW,
          target: TARGET,
        },
        required: ['inputIds', 'operation'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const inputIds = argList(args.inputIds, 'inputIds');
        if (args.preview) {
          const reply = await backend.request({
            type: 'value-preview',
            ids: inputIds,
            operation: args.operation,
            ...(args.parameters ? { parameters: args.parameters } : {}),
            ...(args.bindings ? { bindings: args.bindings } : {}),
            ...(args.within ? { within: args.within } : {}),
          } as EngineCommand);
          if (reply.type !== 'value-preview')
            throw new Error('Unexpected reply.');
          return reply.statistics.map((item) => ({
            inputId: item.inputId,
            ...(item.segmentId ? { segmentId: item.segmentId } : {}),
            result: item.result,
          }));
        }
        const result = await commit(
          backend,
          {
            type: 'calculate-values',
            inputIds,
            operation: args.operation,
            ...Object.fromEntries(
              ['parameters', 'bindings', 'within', 'expression', 'unit']
                .filter((key) => args[key] !== undefined)
                .map((key) => [key, args[key]]),
            ),
          } as EngineCommand,
          call,
          args.name,
        );
        return result;
      },
    },
    {
      name: 'segment',
      title: 'Find segments',
      description:
        'Segment: finds time intervals of a recording (not signals) by start/end triggers, fixed time ranges or windows; nested within parent segments with "within". Definition shapes: catalog section "segment". Preview returns the boundaries without saving.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceId: {
            type: 'string',
            description: 'Recording ID ("" for the workspace time axis).',
          },
          definition: objectArg(
            'SegmentationDefinition, e.g. {"method": "triggers", "start": {"signalId": "…", "edge": "rising", "threshold": 900, "offset": 0}, "end": {…, "edge": "falling"}, "minimumDuration": 0, "boundary": "clip"}.',
          ),
          referenceId: {
            type: 'string',
            description: 'Ranges and windows: the signal whose axis they use.',
          },
          within: WITHIN,
          name: NAME,
          preview: PREVIEW,
          target: TARGET,
        },
        required: ['sourceId', 'definition'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const request = {
          sourceId: String(args.sourceId),
          definition: args.definition,
          ...(args.referenceId ? { referenceId: args.referenceId } : {}),
          ...(args.within ? { within: args.within } : {}),
        };
        if (args.preview) {
          const reply = await backend.request({
            type: 'segment-set-preview',
            ...request,
          } as EngineCommand);
          if (reply.type !== 'segment-plan')
            throw new Error('Unexpected reply.');
          return reply.plan;
        }
        return commit(
          backend,
          { type: 'segment-set', ...request } as EngineCommand,
          call,
          args.name,
        );
      },
    },
    {
      name: 'time_operation',
      title: 'Compare & align',
      description:
        'Compare & align across recordings: align time bases (event, offset, two-point or clock), resample to a shared grid, calculate between two signals, or crop a comparison interval. Settings shapes: catalog section "time".',
      inputSchema: {
        type: 'object',
        properties: {
          settings: objectArg('TimeSettings (lib/time-types.ts).'),
          name: NAME,
          target: TARGET,
        },
        required: ['settings'],
      },
      run: async (args, call) =>
        commit(
          context.backend(args.target),
          { type: 'time-operation', settings: args.settings } as EngineCommand,
          call,
          args.name,
        ),
    },
    {
      name: 'edit_step',
      title: 'Edit a step',
      description:
        'Edit: rebuilds a step with new settings and every dependent step atomically (IDs kept where the output count matches). Take "savedCommand" from describe(stepId), change it, and pass it as command.',
      inputSchema: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          command: objectArg(
            'A WorkflowCommand: derive-many, calculate-values, segment-set, segment or time-operation request.',
          ),
          target: TARGET,
        },
        required: ['stepId', 'command'],
      },
      run: async (args, call) =>
        commit(
          context.backend(args.target),
          {
            type: 'edit-operation',
            stepId: String(args.stepId),
            command: args.command as WorkflowCommand,
          },
          call,
        ),
    },
    {
      name: 'delete_step',
      title: 'Delete a step',
      description:
        'Deletes a step with its outputs and every dependent step (describe lists the impact). Undo restores them.',
      inputSchema: {
        type: 'object',
        properties: { stepId: { type: 'string' }, target: TARGET },
        required: ['stepId'],
      },
      annotations: { destructiveHint: true },
      run: async (args, call) =>
        commit(
          context.backend(args.target),
          { type: 'delete-operation', stepId: String(args.stepId) },
          call,
        ),
    },
    {
      name: 'rename',
      title: 'Rename',
      description:
        'Renames a step, signal, value or segment (an empty name restores the default where allowed).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          target: TARGET,
        },
        required: ['id', 'name'],
      },
      run: async (args, call) => {
        const backend = context.backend(args.target);
        const before = (await backend.state()).project;
        const reply = await backend.request(
          { type: 'rename', id: String(args.id), name: String(args.name) },
          call.progress,
        );
        if (reply.type !== 'project') throw new Error('Rename failed.');
        const index = indexOf(reply.project);
        const step = index.steps.get(String(args.id));
        return step
          ? { changed: changedSteps(before, reply.project) }
          : { renamed: outputInfo(index, String(args.id)) };
      },
    },
    {
      name: 'set_checks',
      title: 'Set checks',
      description:
        'Replaces a step\'s checks (count, limits, missing, duration expectations on its outputs) and returns their results. Shapes: catalog section "checks".',
      inputSchema: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          checks: {
            type: 'array',
            items: { type: 'object' },
            description:
              'CheckDefinition list, e.g. [{"kind": "limits", "min": 0, "max": 100, "unit": "Nm", "severity": "fail"}].',
          },
          target: TARGET,
        },
        required: ['stepId', 'checks'],
      },
      run: async (args, call) =>
        commit(
          context.backend(args.target),
          {
            type: 'set-checks',
            stepId: String(args.stepId),
            checks: args.checks,
          } as EngineCommand,
          call,
        ),
    },
  ];
}
