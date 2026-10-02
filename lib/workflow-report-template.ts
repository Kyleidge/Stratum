import {
  createBlock,
  type ReportBlock,
  type ReportBlockType,
  type ReportDocument,
} from './report-mockup';
import { readPlotSheets, type PlotSheet } from './plot-scratchpad';
import type { YamlMap, YamlValue } from './workflow-yaml';

/**
 * A report layout whose data blocks are bound to recipe outputs instead of
 * captured snapshots. Rendering it for one run produces an ordinary report.
 */
export type TemplateBinding =
  | { kind: 'signal'; ref: string }
  | { kind: 'values'; refs: string[] }
  | { kind: 'plot'; sheet: PlotSheet }
  | { kind: 'checks'; scope: 'all' | 'flagged' };
export type TemplateBlock = Omit<
  ReportBlock,
  'id' | 'source' | 'signalPlot' | 'plotSnapshot' | 'plotSheet'
> & { bind?: TemplateBinding };
export type ReportTemplate = Omit<ReportDocument, 'pages'> & {
  pages: { blocks: TemplateBlock[] }[];
};

export const TEMPLATE_PLACEHOLDERS = [
  'item.id',
  'item.label',
  'file.name',
  'run.date',
  'run.status',
  'run.flags',
  'workflow.name',
  'workflow.revision',
  'workflow.hash',
] as const;
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const VALUE_PLACEHOLDER = /^value\s+([a-z][a-z0-9-]*(?:\[[1-9][0-9]*\])?)$/;

/** Names of placeholders a text uses; value references are returned as refs. */
export function placeholders(text: string): {
  names: string[];
  refs: string[];
  unknown: string[];
} {
  const names: string[] = [],
    refs: string[] = [],
    unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    const value = name.match(VALUE_PLACEHOLDER);
    if (value) refs.push(value[1]);
    else if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name))
      names.push(name);
    else unknown.push(name);
  }
  return { names, refs, unknown };
}

export function fillPlaceholders(
  text: string,
  values: Record<string, string>,
  value: (ref: string) => string,
): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const reference = name.match(VALUE_PLACEHOLDER);
    if (reference) return value(reference[1]);
    return Object.hasOwn(values, name) ? values[name] : whole;
  });
}

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
const camel = (key: string) =>
  key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

type BlockField = keyof Omit<
  ReportBlock,
  'id' | 'source' | 'signalPlot' | 'plotSnapshot' | 'plotSheet'
>;
const BLOCK_FIELDS = Object.keys(createBlock('text')).filter(
  (key) => key !== 'id',
) as BlockField[];
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
const IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/;
const MAX_IMAGE = 9 * 1024 * 1024;

function defaults(type: ReportBlockType): Omit<ReportBlock, 'id'> {
  const { id: _id, ...block } = createBlock(type);
  void _id;
  return block;
}

/** Converts captured blocks; data blocks need a binding from the caller. */
export function templateBlock(
  block: ReportBlock,
  bind?: TemplateBinding,
): TemplateBlock {
  const {
    id: _id,
    source: _source,
    signalPlot: _plot,
    plotSnapshot: _snapshot,
    plotSheet: _sheet,
    ...rest
  } = block;
  void [_id, _source, _plot, _snapshot, _sheet];
  return bind ? { ...rest, bind } : rest;
}

function sheetYaml(sheet: PlotSheet): YamlMap {
  const plain = JSON.parse(
    JSON.stringify({
      layout: sheet.layout,
      grid: sheet.grid,
      zeroTime: sheet.zeroTime,
      axes: sheet.axes,
      annotations: sheet.annotations,
    }),
  ) as Record<string, unknown>;
  const convert = (value: unknown, keys: boolean): YamlValue =>
    Array.isArray(value)
      ? value.map((item) => convert(item, true))
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              // Axis keys such as "unit:Nm" are data, not field names.
              keys && !key.includes(':') ? kebab(key) : key,
              convert(
                item,
                !key.includes(':') && key !== 'values' && key !== 'heldY',
              ),
            ]),
          )
        : (value as YamlValue);
  const result = convert(plain, true) as YamlMap;
  result.traces = sheet.traces.map((trace) => {
    const item: YamlMap = { ref: trace.id };
    if (!trace.visible) item.visible = false;
    item.color = trace.color;
    if (trace.style) item.style = trace.style;
    if (trace.width) item.width = trace.width;
    if (trace.axisId) item.axis = trace.axisId;
    return item;
  });
  return result;
}

export function templateYaml(template: ReportTemplate): YamlMap {
  return {
    title: template.title,
    'page-size': template.pageSize,
    orientation: template.orientation,
    background: template.background,
    pages: template.pages.map((page) => ({
      blocks: page.blocks.map((block) => {
        const base = defaults(block.type);
        const item: YamlMap = { type: block.type };
        for (const key of BLOCK_FIELDS) {
          if (key === 'type') continue;
          const value = block[key];
          if (JSON.stringify(value) !== JSON.stringify(base[key]))
            item[kebab(key)] = value as YamlValue;
        }
        if (block.bind) {
          const bind = block.bind;
          item.bind =
            bind.kind === 'signal'
              ? { signal: bind.ref }
              : bind.kind === 'values'
                ? { values: bind.refs }
                : bind.kind === 'checks'
                  ? { checks: bind.scope }
                  : { plot: sheetYaml(bind.sheet) };
        }
        return item;
      }),
    })),
  };
}

export type TemplateIssue = (message: string, at?: object) => never;

/** Validates a parsed `report:` mapping. Refs are checked by the recipe. */
export function readTemplate(
  value: YamlValue,
  fail: TemplateIssue,
): ReportTemplate {
  const map = (item: YamlValue, context: string): YamlMap => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      fail(
        `${context} must be a mapping.`,
        item && typeof item === 'object' ? item : undefined,
      );
    return item;
  };
  const report = map(value, 'report');
  const allowed = new Set([
    'title',
    'page-size',
    'orientation',
    'background',
    'pages',
  ]);
  for (const key of Object.keys(report))
    if (!allowed.has(key)) fail(`Unknown report setting "${key}".`, report);
  const title = report.title ?? 'Report · {{item.id}}';
  if (typeof title !== 'string' || !title.trim() || title.length > 200)
    fail('The report title must be 1–200 characters.', report);
  for (const unknown of placeholders(title).unknown)
    fail(
      `The report title uses an unknown placeholder {{${unknown}}}.`,
      report,
    );
  const pageSize = report['page-size'] ?? 'a4';
  if (pageSize !== 'a4' && pageSize !== 'letter')
    fail('page-size must be a4 or letter.', report);
  const orientation = report.orientation ?? 'portrait';
  if (orientation !== 'portrait' && orientation !== 'landscape')
    fail('orientation must be portrait or landscape.', report);
  const background = report.background ?? '#ffffff';
  if (typeof background !== 'string' || !COLOR.test(background))
    fail('background must be a colour such as #ffffff.', report);
  const pages = report.pages ?? [];
  if (!Array.isArray(pages) || pages.length > 50)
    fail('pages must be a list of at most 50 pages.', report);
  let imageBytes = 0;
  return {
    title,
    pageSize,
    orientation,
    background,
    pages: pages.map((rawPage, pageIndex) => {
      const page = map(rawPage, `Page ${pageIndex + 1}`);
      for (const key of Object.keys(page))
        if (key !== 'blocks') fail(`Unknown page setting "${key}".`, page);
      const blocks = page.blocks ?? [];
      if (!Array.isArray(blocks) || blocks.length > 200)
        fail(
          `Page ${pageIndex + 1} blocks must be a list of at most 200.`,
          page,
        );
      return {
        blocks: blocks.map((rawBlock, blockIndex) => {
          const context = `Page ${pageIndex + 1}, block ${blockIndex + 1}`;
          const item = map(rawBlock, context);
          const type = item.type;
          if (
            type !== 'text' &&
            type !== 'plot' &&
            type !== 'image' &&
            type !== 'table'
          )
            fail(`${context}: type must be text, plot, image or table.`, item);
          const block = defaults(type) as Record<string, unknown>;
          for (const [key, raw] of Object.entries(item)) {
            if (key === 'type' || key === 'bind') continue;
            const field = camel(key) as BlockField;
            if (!BLOCK_FIELDS.includes(field) || field === 'type')
              fail(`${context}: unknown field "${key}".`, item);
            const expected = block[field];
            const bad = () =>
              fail(`${context}: "${key}" has an invalid value.`, item);
            if (field === 'tableData') {
              if (
                !Array.isArray(raw) ||
                raw.length > 100 ||
                !raw.every(
                  (row) =>
                    Array.isArray(row) &&
                    row.length <= 12 &&
                    row.every(
                      (cell) => typeof cell === 'string' && cell.length <= 500,
                    ),
                )
              )
                bad();
            } else if (typeof expected === 'number') {
              if (
                typeof raw !== 'number' ||
                !Number.isFinite(raw) ||
                Math.abs(raw) > 100_000
              )
                bad();
            } else if (typeof expected === 'boolean') {
              if (typeof raw !== 'boolean') bad();
            } else if (typeof raw !== 'string') bad();
            else if (
              ['color', 'fill', 'borderColor', 'accent'].includes(field) &&
              !COLOR.test(raw)
            )
              bad();
            else if (field === 'src') {
              if (raw && !IMAGE.test(raw)) bad();
              imageBytes += raw.length;
              if (raw.length > MAX_IMAGE || imageBytes > 4 * MAX_IMAGE)
                fail(`${context}: embedded images are too large.`, item);
            } else if (
              (field === 'fontFamily' &&
                !['sans', 'serif', 'mono'].includes(raw)) ||
              (field === 'align' &&
                !['left', 'center', 'right'].includes(raw)) ||
              (field === 'objectFit' && !['cover', 'contain'].includes(raw)) ||
              (field === 'plot' &&
                !['power', 'torque', 'temperature'].includes(raw)) ||
              raw.length > 20_000
            )
              bad();
            block[field] = raw;
          }
          const result = block as unknown as TemplateBlock;
          if (item.bind !== undefined)
            result.bind = readBinding(item.bind, context, fail);
          for (const unknown of placeholders(result.text).unknown)
            fail(`${context}: unknown placeholder {{${unknown}}}.`, item);
          if (
            result.bind &&
            ((result.bind.kind === 'values' ||
              result.bind.kind === 'checks') !==
              (type === 'table') ||
              ((result.bind.kind === 'signal' || result.bind.kind === 'plot') &&
                type !== 'plot'))
          )
            fail(
              `${context}: bind signals and plots to plot blocks, values and checks to tables.`,
              item,
            );
          return result;
        }),
      };
    }),
  };
}

function readBinding(
  value: YamlValue,
  context: string,
  fail: TemplateIssue,
): TemplateBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${context}: bind must be a mapping.`);
  const keys = Object.keys(value);
  if (keys.length !== 1)
    fail(
      `${context}: bind needs exactly one of signal, values, plot or checks.`,
      value,
    );
  if (typeof value.signal === 'string')
    return { kind: 'signal', ref: value.signal };
  if (value.values !== undefined) {
    const refs =
      typeof value.values === 'string' ? [value.values] : value.values;
    if (
      !Array.isArray(refs) ||
      !refs.length ||
      refs.length > 50 ||
      !refs.every((ref) => typeof ref === 'string')
    )
      fail(`${context}: bind values must list value references.`, value);
    return { kind: 'values', refs: refs as string[] };
  }
  if (value.checks !== undefined) {
    if (value.checks !== 'all' && value.checks !== 'flagged')
      fail(`${context}: bind checks must be all or flagged.`, value);
    return { kind: 'checks', scope: value.checks };
  }
  if (value.plot !== undefined) {
    const plot = value.plot;
    if (!plot || typeof plot !== 'object' || Array.isArray(plot))
      fail(`${context}: bind plot must be a mapping.`, value);
    const traces = plot.traces;
    if (!Array.isArray(traces) || !traces.length || traces.length > 30)
      fail(`${context}: a bound plot needs 1–30 traces.`, plot);
    const convert = (item: unknown, keys: boolean): unknown =>
      Array.isArray(item)
        ? item.map((entry) => convert(entry, true))
        : item && typeof item === 'object'
          ? Object.fromEntries(
              Object.entries(item).map(([key, entry]) => [
                keys && !key.includes(':') ? camel(key) : key,
                convert(
                  entry,
                  !key.includes(':') && key !== 'values' && key !== 'held-y',
                ),
              ]),
            )
          : item;
    const { traces: _traces, ...settings } = convert(plot, true) as Record<
      string,
      unknown
    >;
    void _traces;
    const sheet = {
      ...settings,
      id: 'plot:template',
      name: 'Template plot',
      traces: traces.map((trace) => {
        if (
          !trace ||
          typeof trace !== 'object' ||
          Array.isArray(trace) ||
          typeof trace.ref !== 'string'
        )
          fail(`${context}: each plot trace needs a ref.`, plot);
        return {
          id: trace.ref,
          visible: trace.visible !== false,
          color: trace.color,
          style: trace.style,
          width: trace.width,
          axisId: trace.axis,
        };
      }),
    };
    const [read] = readPlotSheets(JSON.stringify([sheet]));
    if (!read || read.traces.length !== traces.length)
      fail(`${context}: the bound plot has invalid or duplicate traces.`, plot);
    return { kind: 'plot', sheet: read };
  }
  fail(`${context}: bind needs signal, values, plot or checks.`, value);
}

/**
 * Turn a report draft into a template. Captured blocks are bound to the recipe
 * outputs they came from; blocks from elsewhere are reported and left out.
 */
export function templateFromReport(
  report: ReportDocument,
  refs: ReadonlyMap<string, string>,
  recordingNames: readonly string[],
): { template: ReportTemplate; problems: string[] } {
  const problems: string[] = [];
  const pages = report.pages.map((page, pageIndex) => ({
    blocks: page.blocks.flatMap((block): TemplateBlock[] => {
      const where = `Page ${pageIndex + 1} · ${block.name}`;
      const source = block.source;
      if (!source) return [templateBlock(block)];
      const mapped = source.outputIds.map((id) => refs.get(id));
      const missing = () => {
        problems.push(
          `${where} uses data from outside this workflow, so it was left out.`,
        );
        return [];
      };
      if (source.kind === 'checks') {
        if (!source.sourceNames.every((name) => recordingNames.includes(name)))
          return missing();
        return [templateBlock(block, { kind: 'checks', scope: 'all' })];
      }
      if (mapped.some((ref) => ref === undefined)) return missing();
      if (source.kind === 'signal')
        return [templateBlock(block, { kind: 'signal', ref: mapped[0]! })];
      if (source.kind === 'values')
        return [
          templateBlock(block, { kind: 'values', refs: mapped as string[] }),
        ];
      if (!block.plotSheet) {
        problems.push(
          `${where} is an extra panel of a saved plot; the template redraws all panels from the first one.`,
        );
        return [];
      }
      const traces = block.plotSheet.traces.filter((trace) => trace.visible);
      if (traces.some((trace) => !refs.has(trace.id))) return missing();
      return [
        templateBlock(block, {
          kind: 'plot',
          sheet: {
            ...block.plotSheet,
            traces: traces.map((trace) => ({
              ...trace,
              id: refs.get(trace.id)!,
            })),
          },
        }),
      ];
    }),
  }));
  return {
    template: {
      title: report.title.trim() ? report.title : 'Report · {{item.id}}',
      pageSize: report.pageSize,
      orientation: report.orientation,
      background: report.background,
      pages,
    },
    problems,
  };
}

/** Every recipe reference a template uses, for validation against the steps. */
export function templateRefs(template: ReportTemplate): string[] {
  return [...placeholders(template.title).refs, ...templateBlockRefs(template)];
}
function templateBlockRefs(template: ReportTemplate): string[] {
  return template.pages.flatMap((page) =>
    page.blocks.flatMap((block) => [
      ...placeholders(block.text).refs,
      ...placeholders(block.name).refs,
      ...(block.bind?.kind === 'signal'
        ? [block.bind.ref]
        : block.bind?.kind === 'values'
          ? block.bind.refs
          : block.bind?.kind === 'plot'
            ? block.bind.sheet.traces.map((trace) => trace.id)
            : []),
    ]),
  );
}
