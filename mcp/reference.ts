/**
 * Reference material for models: the operation catalogs (read from the same
 * modules the dialogs use, so they never drift), request shapes read from
 * the protocol's source, and the repository's docs as resources.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FUNCTIONS } from '../lib/signal-functions';
import { TIME_OPERATIONS } from '../lib/time-types';
import { CALCULATE, VALUE_FUNCTIONS } from '../lib/workflow-types';
import type { ServerContext } from './context';
import type { Resource, Tool } from './protocol';

/** A type's source text, from its declaration to the next export. */
function typeSource(path: string, name: string) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(`export type ${name} =`);
  if (start < 0) return `(${name} not found in ${path})`;
  const end = text.indexOf('\nexport ', start + 1);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

const SEGMENT_EXAMPLES = {
  triggers: {
    method: 'triggers',
    start: {
      signalId: '<signal ID>',
      edge: 'rising',
      threshold: 900,
      offset: 0,
      hysteresis: 0,
      debounce: 0,
    },
    end: {
      signalId: '<signal ID>',
      edge: 'falling',
      threshold: 900,
      offset: 0,
    },
    minimumDuration: 0,
    boundary: 'clip',
  },
  ranges: {
    method: 'ranges',
    ranges: [
      [0, 10],
      [20, 30],
    ],
    boundary: 'clip',
  },
  windows: {
    method: 'windows',
    start: 0,
    end: 60,
    duration: 10,
    step: 10,
    includePartial: false,
    boundary: 'discard',
  },
  notes: [
    'Segments are recording-time intervals; the end is excluded unless it is the recording or parent end.',
    'Nested segments: pass within {"setId": "<parent set>"}; ranges and windows are then seconds from each parent start.',
    'Trigger thresholds/offsets can come from values: definition.bindings {"start.threshold": {"valueIds": [...], "factor": 1}}.',
    'Ranges and windows on the workspace axis (sourceId "") need referenceId.',
  ],
};

const TIME_EXAMPLES = {
  align: {
    kind: 'align',
    reference: { id: '<new ID>', name: 'Aligned time', kind: 'relative' },
    target: 0,
    groups: [
      {
        inputIds: ['<signal IDs from one recording>'],
        anchor: {
          kind: 'event',
          trigger: {
            signalId: '<ID>',
            edge: 'rising',
            threshold: 1,
            offset: 0,
          },
          occurrence: 1,
        },
      },
      { inputIds: ['<other recording signals>'], anchor: { kind: 'start' } },
    ],
  },
  resample: {
    kind: 'resample',
    inputIds: ['<IDs>'],
    grid: { kind: 'uniform', start: 0, end: 10, rate: 100 },
    interpolation: 'linear',
    maxGap: 0.1,
  },
  combine: {
    kind: 'combine',
    inputIds: ['<A>', '<B>'],
    operator: 'difference',
  },
  crop: { kind: 'crop', inputIds: ['<IDs>'], start: 0, end: 10 },
  notes: [
    'Anchors: {"kind": "point", "time": t}, {"kind": "start"}, {"kind": "clock"} (absolute clocks) or an event trigger.',
    'Grids: uniform, or {"kind": "reference", "signalId", "start", "end"}. Optional resample filter {"cutoff", "halfWidth"}.',
    'Outputs use the workspace scope (sourceId ""). See docs/time-bases.md.',
  ],
};

const CHECK_EXAMPLES = {
  shape: {
    kind: 'count | limits | missing | duration',
    min: 0,
    max: 100,
    unit: 'limits only: exactly the output unit',
    outputs: '1-based output positions (default all)',
    severity: 'warning | fail',
    message: 'optional',
  },
  examples: [
    { kind: 'count', min: 3, max: 3, severity: 'fail' },
    { kind: 'limits', min: 78, max: 95, unit: 'Nm', severity: 'fail' },
    { kind: 'missing', max: 0, severity: 'warning' },
  ],
};

export const CATALOG_SECTIONS = [
  'derive',
  'value',
  'segment',
  'time',
  'checks',
  'requests',
] as const;

export function catalog(
  context: ServerContext,
  section: (typeof CATALOG_SECTIONS)[number],
) {
  switch (section) {
    case 'derive':
      return {
        functions: FUNCTIONS.filter((spec) => spec.operation !== 'segment').map(
          (spec) => ({
            operation: spec.operation,
            name: spec.name,
            category: spec.category,
            ...(spec.parameter
              ? {
                  parameter: spec.parameter,
                  default: spec.defaultValue,
                  unit: spec.unit,
                  ...(spec.min !== undefined ? { min: spec.min } : {}),
                  ...(spec.max !== undefined ? { max: spec.max } : {}),
                }
              : {}),
            description: spec.description,
          }),
        ),
        notes: [
          'derive applies one function to each input (one output each). Two-signal math (add, subtract, multiply, divide) is a formula: operation "formula", formula {"expression": "A - B", "signals": {"B": ["<id>"]}} — or time_operation combine across recordings.',
          'convert: unit = the target unit of the same dimension.',
          'bindings: offset, scale, time-shift settings can be factor × a value: {"parameter": {"valueIds": ["<value>"], "factor": 1}}.',
        ],
      };
    case 'value':
      return {
        functions: [...VALUE_FUNCTIONS, CALCULATE].map((spec) => ({
          operation: spec.operation,
          name: spec.name,
          group: spec.group,
          result: spec.result,
          ...(spec.parameters ? { settings: spec.parameters } : {}),
          description: spec.description,
        })),
        notes: [
          'Settings: threshold (input unit), edge (1 rising, -1 falling), time (seconds from the input start), hysteresis, debounce.',
          'Elapsed results are seconds from the input start.',
          'calculate: inputIds are values; expression uses a (each input value) and other lowercase names from bindings {"b": {"valueIds": [...], "factor": 1}}.',
        ],
      };
    case 'segment':
      return SEGMENT_EXAMPLES;
    case 'time':
      return { operations: TIME_OPERATIONS, settings: TIME_EXAMPLES };
    case 'checks':
      return CHECK_EXAMPLES;
    case 'requests':
      return {
        note: 'engine_request accepts any of these (from lib/signal-types.ts and lib/region-types.ts). Put {"$file": "path"} where a File or Blob goes.',
        EngineRequest: typeSource(
          join(context.root, 'lib/signal-types.ts'),
          'EngineRequest',
        ),
        RegionRequest: typeSource(
          join(context.root, 'lib/region-types.ts'),
          'RegionRequest',
        ),
        WorkflowCommand: typeSource(
          join(context.root, 'lib/workflow-lifecycle.ts'),
          'WorkflowCommand',
        ),
      };
  }
}

export function referenceTools(context: ServerContext): Tool[] {
  return [
    {
      name: 'catalog',
      title: 'Operation catalog',
      description:
        'What operations exist and their settings: "derive" functions, "value" calculations, "segment" definitions, "time" (Compare & align) settings, "checks", and the raw "requests" protocol types.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...CATALOG_SECTIONS] },
        },
        required: ['section'],
      },
      annotations: { readOnlyHint: true },
      run: async (args) =>
        catalog(context, args.section as (typeof CATALOG_SECTIONS)[number]),
    },
  ];
}

/** Docs, project instructions and example workflows as readable resources. */
export function resources(context: ServerContext): Resource[] {
  const files: Resource[] = [];
  const add = (path: string, name: string, description: string) => {
    const full = join(context.root, path);
    if (!existsSync(full)) return;
    files.push({
      uri: `stratum://${encodeURI(path)}`,
      name,
      description,
      mimeType: path.endsWith('.md') ? 'text/markdown' : 'text/plain',
      read: async () => readFileSync(full, 'utf8'),
    });
  };
  add('AGENTS.md', 'Project instructions', 'Architecture and conventions.');
  add(
    'docs/mcp-server.md',
    'MCP server guide',
    'How these tools work and how to extend them.',
  );
  for (const name of readdirSync(join(context.root, 'docs')).sort())
    if (name.endsWith('.md') && name !== 'mcp-server.md')
      add(`docs/${name}`, name.replace(/\.md$/, ''), 'Stratum documentation.');
  for (const folder of ['eol-rig', 'cam-phaser-eol']) {
    const dir = join(context.root, 'examples', folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir))
      if (name.endsWith('.stratum.yaml'))
        add(
          `examples/${folder}/${name}`,
          name,
          'Example workflow file (.stratum.yaml).',
        );
  }
  return files;
}
