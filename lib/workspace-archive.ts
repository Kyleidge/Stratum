import { SignalGraph } from './signal-graph';
import { FUNCTIONS } from './signal-functions';
import {
  arithmeticUnit,
  isArithmetic,
  isBinaryOperation,
} from './signal-arithmetic';
import { TIME_OPERATIONS, timeInputs, COMPARISON_MATH } from './time-types';
import { validateTimeRecipe, validateTimeSettings } from './time-model';
import type { Project, SegmentationDefinition } from './signal-types';
import { validateWorkflowRecords } from './workflow-checks';
import { validTriggerNoise } from './segmentation';
import { compileFormula } from './formula';
import { unitConversion } from './units';
import { belowNyquist } from './signal-filters';
import { valueParameters, valueSpec, type ScalarValue } from './workflow-types';
import { isSegmentCrop, segmentEntries, visibleInput } from './file-segments';
import {
  BINDABLE_DERIVE,
  BINDABLE_TRIGGER,
  BINDABLE_VALUE,
  bindingValueIds,
  validBindings,
} from './value-bindings';

/** A known calculation whose saved settings are exactly its valid settings. */
function validValueSettings(value: ScalarValue): boolean {
  const spec = valueSpec(value.operation);
  if (!spec) return false;
  if (!spec.parameters?.length) return value.parameters === undefined;
  if (!value.parameters || typeof value.parameters !== 'object') return false;
  try {
    const valid = valueParameters(value.operation, value.parameters);
    return (
      Object.keys(valid).length === Object.keys(value.parameters).length &&
      Object.entries(valid).every(
        ([name, number]) => value.parameters![name] === number,
      )
    );
  } catch {
    return false;
  }
}

/**
 * The backup format this version writes and the newest it reads. Raise it
 * when a newer Stratum's backups hold anything this one would reject or lose
 * (docs/file-format-stability.md).
 */
export const ARCHIVE_VERSION = 2;
/** The header's format name keeps its pre-rename spelling. */
export const ARCHIVE_FORMAT = 'stratus-workspace';

/**
 * Checks an archive's first record before anything is staged: the format, then
 * the version, naming a newer backup rather than guessing at it.
 */
export function checkArchiveHeader(record: Record<string, unknown>) {
  if (record.format !== ARCHIVE_FORMAT)
    throw new Error(
      'This file is not a Stratum workspace backup. Choose a .stratum file made with Save workspace backup (or Download workspace backup in the browser).',
    );
  const version = record.version;
  if (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > ARCHIVE_VERSION
  )
    throw new Error(
      `This backup was made by a newer version of Stratum (backup format ${version}). Update Stratum to restore it. Your current workspace is unchanged.`,
    );
  // Version 2 added file segments; version 1 backups still restore.
  if (version !== 1 && version !== ARCHIVE_VERSION)
    throw new Error("This workspace backup's version is not supported.");
}

/** Browser backups and downloads build one Blob, so they stay capped. */
export const ARCHIVE_LIMIT = 128 * 1024 * 1024;
export const EXPORT_LIMIT = 64 * 1024 * 1024;
/** One archive record (a header or a sample column) must fit in memory. */
export const ARCHIVE_LINE_LIMIT = 32 * 1024 * 1024;
/** Bytes handed to a sink at a time when streaming to a native file. */
export const STREAM_CHUNK = 1024 * 1024;
/** Receives encoded bytes in order; the next write waits for this one. */
export type ByteSink = (bytes: Uint8Array) => Promise<void> | void;

/**
 * Encodes text into bounded chunks for a sink. Memory stays within one chunk
 * plus the record being written, however large the whole output grows.
 */
export class ChunkedWriter {
  private parts: Uint8Array[] = [];
  private pending = 0;
  private encoder = new TextEncoder();
  /** Total bytes accepted so far. */
  bytes = 0;
  constructor(
    private sink: ByteSink,
    private limit = Infinity,
    private limitMessage = 'The output exceeds its size limit.',
    private chunk = STREAM_CHUNK,
  ) {}
  async write(text: string) {
    const bytes = this.encoder.encode(text);
    this.bytes += bytes.length;
    if (this.bytes > this.limit) throw new Error(this.limitMessage);
    this.parts.push(bytes);
    this.pending += bytes.length;
    if (this.pending >= this.chunk) await this.flush();
  }
  async flush() {
    if (!this.pending) return;
    const parts = this.parts;
    let joined: Uint8Array;
    if (parts.length === 1) joined = parts[0];
    else {
      joined = new Uint8Array(this.pending);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
    }
    this.parts = [];
    this.pending = 0;
    await this.sink(joined);
  }
}

/** Reads a Blob in bounded slices. */
export async function* blobChunks(
  file: Blob,
  size = 262144,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < file.size; offset += size)
    yield new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
}
/** Reads a byte stream, releasing it if the reader stops early. */
export async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      if (!(next.value instanceof Uint8Array))
        throw new Error('The backup file could not be read.');
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function archiveRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(
      'This file is not a valid workspace backup. Choose a complete .stratum archive.',
    );
  }
}
/**
 * Parses NDJSON archive records from a Blob or a byte stream. Only one record
 * and one input chunk are held at a time; `limit` caps the total bytes read
 * (browser Blobs keep the 128 MiB limit, native streams have none).
 */
export async function* archiveLines(
  file: Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  limit = file instanceof Blob ? ARCHIVE_LIMIT : Infinity,
): AsyncGenerator<unknown> {
  const tooLarge = 'Workspace archives are limited to 128 MiB in this version.';
  if (file instanceof Blob && file.size > limit) throw new Error(tooLarge);
  const chunks =
    file instanceof Blob
      ? blobChunks(file)
      : file instanceof ReadableStream
        ? streamChunks(file)
        : file;
  let buffer = '',
    total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (bytes?: Uint8Array) => {
    try {
      return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
    } catch {
      throw new Error(
        'This file is not a valid workspace backup. Choose a complete .stratum archive.',
      );
    }
  };
  for await (const bytes of chunks) {
    total += bytes.length;
    if (total > limit) throw new Error(tooLarge);
    buffer += decode(bytes);
    let start = 0,
      newline: number;
    const records: unknown[] = [];
    while ((newline = buffer.indexOf('\n', start)) >= 0) {
      const line = buffer.slice(start, newline);
      start = newline + 1;
      if (line.trim()) records.push(archiveRecord(line));
    }
    buffer = buffer.slice(start);
    if (buffer.length > ARCHIVE_LINE_LIMIT)
      throw new Error('Archive metadata is too large.');
    yield* records;
  }
  buffer += decode();
  if (buffer.trim()) yield archiveRecord(buffer);
}

export function validateWorkspace(value: unknown): Project {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid workspace metadata.');
  const project = value as Project;
  if (
    ![
      project.sources,
      project.nodes,
      project.segments,
      project.workflowSteps,
      project.values ?? [],
      project.regionSets ?? [],
      project.functionRuns ?? [],
      project.segmentationOperations ?? [],
      project.examples ?? [],
      project.regionExamples ?? [],
      project.segmentSets ?? [],
    ].every(Array.isArray)
  )
    throw new Error('Invalid workspace collections.');
  const fileSegments = segmentEntries(project);
  const sources = new Map(project.sources.map((source) => [source.id, source]));
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const values = new Map((project.values ?? []).map((item) => [item.id, item]));
  const regionSets = new Map(
    (project.regionSets ?? []).map((item) => [item.id, item]),
  );
  const stringList = (items: unknown, unique = true): items is string[] =>
    Array.isArray(items) &&
    items.every((id) => typeof id === 'string') &&
    (!unique || new Set(items).size === items.length);
  const optionalText = (item: unknown) =>
    item === undefined || typeof item === 'string';
  const nonnegative = (item: number) => Number.isFinite(item) && item >= 0;
  if (
    project.labels !== undefined &&
    (!project.labels ||
      Array.isArray(project.labels) ||
      typeof project.labels !== 'object' ||
      Object.values(project.labels).some(
        (label) => typeof label !== 'string' || label.length > 160,
      ))
  )
    throw new Error('Invalid output display names.');
  const ids = new Set<string>();
  for (const item of [
    ...project.sources,
    ...project.nodes,
    ...(project.values ?? []),
    ...(project.workflowSteps ?? []),
    ...(project.segmentSets ?? []),
    ...(project.segmentSets ?? []).flatMap((set) =>
      Array.isArray(set.segments) ? set.segments : [],
    ),
  ]) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id))
      throw new Error('Workspace contains duplicate or invalid IDs.');
    ids.add(item.id);
  }
  for (const source of project.sources) {
    if (
      typeof source.name !== 'string' ||
      !Number.isSafeInteger(source.rows) ||
      source.rows < 2 ||
      source.chunks !== Math.ceil(source.rows / 16384) ||
      !Number.isFinite(source.start) ||
      !Number.isFinite(source.end) ||
      source.start >= source.end ||
      !nonnegative(source.bytes) ||
      typeof source.synthetic !== 'boolean' ||
      !optionalText(source.exampleKey) ||
      (source.exampleKey !== undefined && !source.synthetic) ||
      !stringList(source.channels) ||
      !source.channels.length
    )
      throw new Error('Invalid recording metadata.');
    source.channels.forEach((id, channel) => {
      const node = nodes.get(id);
      if (
        !node ||
        node.operation !== 'raw' ||
        node.channel !== channel ||
        node.sourceId !== source.id
      )
        throw new Error('Invalid original signal mapping.');
    });
    if (
      !Array.isArray(source.chunkRanges) ||
      source.chunkRanges.length !== source.chunks ||
      source.chunkRanges.some(
        (range) =>
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(Number.isFinite) ||
          range[0] > range[1],
      )
    )
      throw new Error('Invalid recording chunk ranges.');
  }
  const operations = new Set([
    ...Object.keys(TIME_OPERATIONS),
    'raw',
    'crop',
    'power',
    'bsfc',
    ...FUNCTIONS.map((item) => item.operation),
  ]);
  for (const node of project.nodes) {
    if (
      (node.sourceId !== '' && !sources.has(node.sourceId)) ||
      !operations.has(node.operation) ||
      typeof node.name !== 'string' ||
      typeof node.unit !== 'string' ||
      typeof node.color !== 'string' ||
      typeof node.createdAt !== 'string' ||
      node.version !== 1 ||
      !optionalText(node.batchId) ||
      (node.segmentId !== undefined && !fileSegments.has(node.segmentId)) ||
      !stringList(
        node.parents,
        !isArithmetic(node.operation) && node.timeRecipe?.kind !== 'resample',
      ) ||
      !node.parameters ||
      !Object.values(node.parameters).every(Number.isFinite)
    )
      throw new Error('Invalid signal recipe.');
    if (
      node.operation === 'raw' &&
      (!sources.get(node.sourceId)?.channels.includes(node.id) ||
        node.parents.length)
    )
      throw new Error('Invalid original signal.');
    if (
      node.parents.some(
        (id) =>
          !nodes.has(id) ||
          (node.sourceId !== '' && nodes.get(id)?.sourceId !== node.sourceId),
      )
    )
      throw new Error('Signal parents must belong to the same recording.');
    if (
      node.timeReference &&
      (typeof node.timeReference.id !== 'string' ||
        !node.timeReference.id ||
        typeof node.timeReference.name !== 'string' ||
        !node.timeReference.name.trim() ||
        !['relative', 'absolute'].includes(node.timeReference.kind))
    )
      throw new Error('Invalid time reference.');
    if (node.operation in TIME_OPERATIONS || node.timeRecipe) {
      if (
        !node.timeRecipe ||
        node.operation !== `time-${node.timeRecipe.kind}` ||
        node.sourceId !== '' ||
        !node.timeReference ||
        !node.parents.length
      )
        throw new Error('Invalid time operation output.');
      validateTimeRecipe(node.timeRecipe);
      const recipe = node.timeRecipe;
      if (
        (recipe.kind === 'combine' && node.parents.length !== 2) ||
        (recipe.kind === 'crop' && node.parents.length !== 1) ||
        (recipe.kind === 'resample' &&
          (recipe.grid.kind === 'reference'
            ? node.parents.length !== 2 ||
              node.parents[1] !== recipe.grid.signalId
            : node.parents.length !== 1))
      )
        throw new Error('Invalid time recipe dependencies.');
    } else if (node.operation === 'crop') {
      if (
        !node.parents.length ||
        (node.internal && node.segmentId && node.parents.length !== 1) ||
        !Number.isFinite(node.parameters.start) ||
        !Number.isFinite(node.parameters.end) ||
        node.parameters.start > node.parameters.end
      )
        throw new Error('Invalid segment recipe.');
    } else if (isBinaryOperation(node.operation)) {
      if (node.parents.length !== 2)
        throw new Error('Binary recipes require two inputs.');
      const units = node.parents.map((id) => nodes.get(id)!.unit);
      if (isArithmetic(node.operation)) {
        arithmeticUnit(node.operation, units[0], units[1]);
      } else if (
        node.operation === 'power'
          ? !/^n[· ]?m$/i.test(units[0]) || units[1].toLowerCase() !== 'rpm'
          : !/^kg\/h$/i.test(units[0]) || units[1].toLowerCase() !== 'kw'
      )
        throw new Error('Invalid binary input units.');
    } else if (node.operation === 'formula') {
      let formula;
      try {
        formula = compileFormula(
          typeof node.expression === 'string' ? node.expression : '',
        );
      } catch {
        throw new Error('Invalid formula.');
      }
      const names = Object.keys(node.parameters);
      if (
        node.parents.length !== formula.signals.length ||
        names.length !== formula.values.length ||
        formula.values.some(
          (name) => !names.includes(name) || !node.bindings?.[name],
        ) ||
        typeof node.unit !== 'string' ||
        node.unit.length > 40
      )
        throw new Error('Invalid formula inputs.');
    } else if (node.operation === 'convert') {
      const conversion = unitConversion(
        nodes.get(node.parents[0])?.unit ?? '',
        node.unit,
      );
      if (
        node.parents.length !== 1 ||
        !conversion ||
        node.parameters.factor !== conversion.factor ||
        node.parameters.offset !== conversion.offset
      )
        throw new Error('Invalid unit conversion.');
    } else if (node.operation !== 'raw') {
      const spec = FUNCTIONS.find((item) => item.operation === node.operation);
      const parameter = node.parameters.value;
      if (
        node.parents.length !== 1 ||
        !spec ||
        spec.operation === 'segment' ||
        (spec.parameter &&
          (!Number.isFinite(parameter) ||
            (spec.min !== undefined && parameter < spec.min) ||
            (spec.max !== undefined && parameter > spec.max)))
      )
        throw new Error('Invalid operation parameters.');
      if (
        (['smooth', 'median'].includes(node.operation) &&
          !Number.isInteger(parameter)) ||
        (['exponential', 'low-pass', 'high-pass'].includes(node.operation) &&
          parameter <= 0) ||
        (['butterworth-low', 'butterworth-high'].includes(node.operation) &&
          !(
            parameter > 0 &&
            Number.isFinite(node.parameters.rate) &&
            belowNyquist(parameter, node.parameters.rate)
          ))
      )
        throw new Error('Invalid filter parameters.');
      if (
        node.operation === 'resample' &&
        (!Number.isFinite(node.parameters.maxGap) ||
          node.parameters.maxGap <= 0)
      )
        throw new Error('Invalid resampling gap.');
    }
  }
  const graph = new SignalGraph(project);
  for (const node of project.nodes) {
    const recipe = node.timeRecipe;
    if (recipe && recipe.kind !== 'align') {
      const reference = graph.timeReferences.get(node.parents[0])!.id;
      if (
        node.timeReference?.id !== reference ||
        ((recipe.kind === 'combine' ||
          (recipe.kind === 'resample' && recipe.grid.kind === 'reference')) &&
          graph.timeReferences.get(node.parents[1])!.id !== reference)
      )
        throw new Error(
          'Time recipe inputs do not share their declared clock.',
        );
      if (
        recipe.kind === 'combine' &&
        node.unit !==
          arithmeticUnit(
            COMPARISON_MATH[recipe.operator],
            nodes.get(node.parents[0])!.unit,
            nodes.get(node.parents[1])!.unit,
          )
      )
        throw new Error('Time calculation has incompatible input units.');
    }
  }
  for (const range of graph.ranges.values())
    if (!range.every(Number.isFinite))
      throw new Error('Invalid signal time bounds.');
  // Hidden segment crops belong to the outputs that read them.
  const outputs = new Set([
    ...[...nodes.values()]
      .filter((node) => !isSegmentCrop(node))
      .map((node) => node.id),
    ...(project.values ?? []).map((value) => value.id),
    ...fileSegments.keys(),
  ]);
  const read = new Set(project.nodes.flatMap((node) => node.parents));
  for (const node of project.nodes)
    if (isSegmentCrop(node) && !read.has(node.id))
      throw new Error('Invalid segment crop.');
  for (const value of project.values ?? [])
    if (
      !nodes.has(value.inputId) ||
      (value.sourceId !== '' &&
        nodes.get(value.inputId)?.sourceId !== value.sourceId) ||
      typeof value.name !== 'string' ||
      typeof value.unit !== 'string' ||
      typeof value.batchId !== 'string' ||
      typeof value.createdAt !== 'string' ||
      !Number.isSafeInteger(value.sampleCount) ||
      value.sampleCount < 0 ||
      !nonnegative(value.validDuration) ||
      !Number.isFinite(value.start) ||
      !Number.isFinite(value.end) ||
      (value.timestamp !== undefined && !Number.isFinite(value.timestamp)) ||
      (value.level !== undefined && !Number.isFinite(value.level)) ||
      (value.segmentId !== undefined && !fileSegments.has(value.segmentId)) ||
      !validValueSettings(value) ||
      (value.value !== null && !Number.isFinite(value.value))
    )
      throw new Error('Invalid calculated value.');
  // A bound setting names an existing value and holds exactly its result.
  const boundSettings = (
    bindings: unknown,
    allowed: Record<string, unknown>,
    parameters: Record<string, number> | undefined,
    self: string,
  ): string[] => {
    if (bindings === undefined) return [];
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
      throw new Error('Invalid settings taken from values.');
    const entries = Object.entries(bindings as Record<string, unknown>);
    if (!entries.length) throw new Error('Invalid settings taken from values.');
    return entries.map(([name, item]) => {
      const bound = item as { valueId?: unknown; factor?: unknown };
      const value = values.get(
        typeof bound?.valueId === 'string' ? bound.valueId : '',
      );
      if (
        !Object.hasOwn(allowed, name) ||
        !value ||
        value.id === self ||
        typeof bound.factor !== 'number' ||
        !Number.isFinite(bound.factor) ||
        value.value === null ||
        parameters?.[name] !== bound.factor * value.value
      )
        throw new Error('Invalid settings taken from values.');
      return value.id;
    });
  };
  const usedValues = new Map<string, string[]>();
  for (const node of project.nodes)
    usedValues.set(
      node.id,
      boundSettings(
        node.bindings,
        node.operation === 'formula'
          ? node.parameters
          : BINDABLE_DERIVE[node.operation]
            ? { value: true }
            : {},
        node.parameters,
        node.id,
      ),
    );
  for (const value of project.values ?? [])
    usedValues.set(
      value.id,
      boundSettings(
        value.bindings,
        Object.fromEntries(
          (valueSpec(value.operation)?.parameters ?? [])
            .filter((name) => BINDABLE_VALUE[name])
            .map((name) => [name, true]),
        ),
        value.parameters,
        value.id,
      ),
    );
  const fileSets = new Map(
    (project.segmentSets ?? []).map((set) => [set.id, set]),
  );
  /** A scope names an existing set and, if listed, its own segments. */
  function validScope(
    scope: unknown,
    used?: string[],
  ): scope is import('./signal-types').SegmentScope {
    const item = scope as import('./signal-types').SegmentScope;
    const set =
      item && typeof item === 'object' ? fileSets.get(item.setId) : undefined;
    if (!set || (item.segmentIds !== undefined && !stringList(item.segmentIds)))
      return false;
    const chosen = item.segmentIds ?? set.segments.map((segment) => segment.id);
    return (
      chosen.length > 0 &&
      chosen.every((id) => fileSegments.get(id)?.set === set) &&
      (used === undefined ||
        (used.length === chosen.length &&
          used.every((id, k) => id === chosen[k])))
    );
  }
  const owners = new Map<
    string,
    NonNullable<Project['workflowSteps']>[number]
  >();
  const sequences = new Set<number>();
  for (const step of project.workflowSteps ?? []) {
    if (
      (step.sourceId !== '' && !sources.has(step.sourceId)) ||
      !['import', 'derive', 'segment', 'value', 'regions'].includes(
        step.kind,
      ) ||
      typeof step.operation !== 'string' ||
      typeof step.createdAt !== 'string' ||
      !optionalText(step.name) ||
      !optionalText(step.fileName) ||
      !optionalText(step.updatedAt) ||
      (step.revision !== undefined &&
        (!Number.isSafeInteger(step.revision) || step.revision < 1)) ||
      !stringList(step.outputIds) ||
      !stringList(step.inputIds) ||
      (step.valueInputIds !== undefined &&
        (!stringList(step.valueInputIds) ||
          !step.valueInputIds.length ||
          step.valueInputIds.some((id) => !values.has(id)))) ||
      (step.segmentInputIds !== undefined &&
        (!stringList(step.segmentInputIds) ||
          !step.segmentInputIds.length ||
          step.segmentInputIds.some((id) => !fileSegments.has(id)))) ||
      (step.within !== undefined &&
        !validScope(step.within, step.segmentInputIds)) ||
      (step.segmentSetId !== undefined &&
        (step.kind !== 'segment' ||
          fileSets.get(step.segmentSetId)?.sourceId !== step.sourceId)) ||
      !Number.isSafeInteger(step.sequence) ||
      step.sequence < 0 ||
      sequences.has(step.sequence) ||
      step.outputIds.some((id) => !outputs.has(id)) ||
      step.inputIds.some(
        (id) =>
          !nodes.has(id) ||
          (step.sourceId !== '' && nodes.get(id)?.sourceId !== step.sourceId),
      ) ||
      (step.parameters !== undefined &&
        (!step.parameters ||
          typeof step.parameters !== 'object' ||
          !Object.values(step.parameters).every(Number.isFinite))) ||
      (step.regionSetId !== undefined &&
        regionSets.get(step.regionSetId)?.sourceId !== step.sourceId)
    )
      throw new Error('Invalid operation history.');
    sequences.add(step.sequence);
    if (step.timeSettings) {
      validateTimeSettings(step.timeSettings);
      const inputs = timeInputs(step.timeSettings);
      if (
        step.sourceId !== '' ||
        step.operation !== `time-${step.timeSettings.kind}` ||
        inputs.length !== step.inputIds.length ||
        inputs.some((id) => !step.inputIds.includes(id))
      )
        throw new Error('Time settings do not match operation inputs.');
    } else if (step.operation in TIME_OPERATIONS)
      throw new Error('Missing saved time settings.');
    const dependencies = new Set<string>();
    const fileSet = fileSets.get(step.segmentSetId ?? '');
    if (fileSet) {
      const segmentIds = fileSet.segments.map((segment) => segment.id);
      if (
        step.operation !== 'segment' ||
        step.outputIds.length !== segmentIds.length ||
        step.outputIds.some((id, k) => id !== segmentIds[k]) ||
        JSON.stringify(step.within) !== JSON.stringify(fileSet.within)
      )
        throw new Error('Invalid segment history.');
      for (const id of step.outputIds) {
        if (owners.has(id))
          throw new Error('An output belongs to multiple operations.');
        owners.set(id, step);
      }
      const definition = fileSet.definition;
      if (definition.method === 'triggers') {
        dependencies.add(definition.start.signalId);
        dependencies.add(definition.end.signalId);
      } else if (fileSet.referenceId) dependencies.add(fileSet.referenceId);
    }
    const scopeSet = new Set(step.segmentInputIds);
    for (const id of fileSet ? [] : step.outputIds) {
      if (owners.has(id))
        throw new Error('An output belongs to multiple operations.');
      owners.set(id, step);
      const node = nodes.get(id),
        value = values.get(id);
      const segment = (node ?? value)?.segmentId;
      if (segment !== undefined && step.within && !scopeSet.has(segment))
        throw new Error('An output lies outside its step’s segments.');
      if ((node ?? value)?.sourceId !== step.sourceId)
        throw new Error('Invalid output recording.');
      if (
        step.kind === 'value'
          ? !value || value.operation !== step.operation
          : !node ||
            (step.kind === 'import'
              ? node.operation !== 'raw'
              : step.kind === 'segment'
                ? node.operation !== 'crop'
                : step.kind !== 'derive' ||
                  node.operation !== step.operation ||
                  ['raw', 'crop'].includes(node.operation))
      )
        throw new Error('Operation kind does not match its outputs.');
      (node?.parents ?? (value ? [value.inputId] : [])).forEach((id) =>
        dependencies.add(visibleInput(nodes, id)),
      );
    }
    if (step.kind === 'regions') {
      const set = regionSets.get(step.regionSetId ?? '');
      if (!set || step.outputIds.length || step.operation !== 'regions')
        throw new Error('Invalid region history.');
      if (set.definition.method === 'triggers') {
        dependencies.add(set.definition.start.signalId);
        dependencies.add(set.definition.end.signalId);
      }
    } else if (!step.outputIds.length)
      throw new Error('An operation has no outputs.');
    if (
      step.kind === 'import' &&
      (step.operation !== 'import' ||
        step.outputIds.length !== sources.get(step.sourceId)!.channels.length)
    )
      throw new Error('Invalid import history.');
    if (step.kind === 'segment' && step.operation !== 'segment')
      throw new Error('Invalid segmentation history.');
    if (
      dependencies.size !== step.inputIds.length ||
      step.inputIds.some((id) => !dependencies.has(id))
    )
      throw new Error('Operation history does not match signal dependencies.');
    const segmentation = project.segmentationOperations?.find(
      (item) => item.id === step.segmentationId,
    );
    const used = new Set(
      step.kind === 'segment'
        ? Object.values(
            (fileSet ?? segmentation)?.definition?.bindings ?? {},
          ).flatMap((binding) => binding.valueIds)
        : step.outputIds.flatMap((id) => usedValues.get(id) ?? []),
    );
    if (
      used.size !== (step.valueInputIds?.length ?? 0) ||
      step.valueInputIds?.some((id) => !used.has(id))
    )
      throw new Error('Operation history does not match value dependencies.');
  }
  if (owners.size !== outputs.size)
    throw new Error('Some outputs have no operation history.');
  for (const step of project.workflowSteps ?? [])
    if (
      [
        ...step.inputIds,
        ...(step.valueInputIds ?? []),
        ...(step.segmentInputIds ?? []),
      ].some((id) => (owners.get(id)?.sequence ?? Infinity) >= step.sequence)
    )
      throw new Error('Operation history is not chronological.');
  for (const segment of project.segments)
    if (
      (segment.sourceId !== '' && !sources.has(segment.sourceId)) ||
      typeof segment.id !== 'string' ||
      typeof segment.name !== 'string' ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start > segment.end ||
      !stringList(segment.nodes) ||
      segment.nodes.some((id) => nodes.get(id)?.sourceId !== segment.sourceId)
    )
      throw new Error('Invalid segment membership.');
  function definition(
    def: SegmentationDefinition | undefined,
    sourceId: string,
  ) {
    if (!def || !['clip', 'discard'].includes(def.boundary))
      throw new Error('Invalid segmentation settings.');
    if (
      def.bindings !== undefined &&
      (def.method !== 'triggers' ||
        !validBindings(def.bindings, BINDABLE_TRIGGER) ||
        bindingValueIds(def.bindings).some((id) => !values.has(id)))
    )
      throw new Error('Invalid trigger settings taken from values.');
    if (def.method === 'ranges') {
      if (
        !Array.isArray(def.ranges) ||
        !def.ranges.length ||
        def.ranges.some(
          (range) =>
            !Array.isArray(range) ||
            range.length !== 2 ||
            !range.every(Number.isFinite) ||
            range[0] >= range[1],
        )
      )
        throw new Error('Invalid saved ranges.');
    } else if (def.method === 'triggers') {
      if (
        !nonnegative(def.minimumDuration) ||
        [def.start, def.end].some(
          (trigger) =>
            !trigger ||
            nodes.get(trigger.signalId)?.sourceId !== sourceId ||
            !['rising', 'falling'].includes(trigger.edge) ||
            !Number.isFinite(trigger.threshold) ||
            !Number.isFinite(trigger.offset) ||
            !validTriggerNoise(trigger),
        )
      )
        throw new Error('Invalid saved triggers.');
    } else if (def.method === 'windows') {
      if (
        ![def.start, def.end, def.duration, def.step].every(Number.isFinite) ||
        def.start >= def.end ||
        def.duration <= 0 ||
        def.step <= 0 ||
        typeof def.includePartial !== 'boolean'
      )
        throw new Error('Invalid saved windows.');
    } else throw new Error('Unknown segmentation method.');
  }
  for (const set of project.segmentSets ?? []) {
    if (
      typeof set.id !== 'string' ||
      (set.sourceId !== '' && !sources.has(set.sourceId)) ||
      (set.sourceId === '') !== (typeof set.timeReferenceId === 'string') ||
      (set.referenceId !== undefined &&
        nodes.get(set.referenceId)?.sourceId !== set.sourceId) ||
      (set.within !== undefined &&
        (!validScope(set.within) || set.within.setId === set.id)) ||
      !Array.isArray(set.segments) ||
      !set.segments.length
    )
      throw new Error('Invalid segment set.');
    definition(set.definition, set.sourceId);
    for (const segment of set.segments) {
      const parent = segment.parentId
        ? fileSegments.get(segment.parentId)
        : undefined;
      if (
        typeof segment.name !== 'string' ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start >= segment.end ||
        typeof segment.endInclusive !== 'boolean' ||
        !segment.boundary ||
        typeof segment.boundary !== 'object' ||
        (segment.parentId !== undefined
          ? !parent || parent.set.id !== set.within?.setId
          : set.within !== undefined)
      )
        throw new Error('Invalid file segment.');
    }
  }
  const segmentIds = new Set(project.segments.map((segment) => segment.id));
  for (const operation of project.segmentationOperations ?? []) {
    if (
      typeof operation.id !== 'string' ||
      (operation.sourceId !== '' && !sources.has(operation.sourceId)) ||
      !stringList(operation.targetIds) ||
      !operation.targetIds.length ||
      operation.targetIds.some(
        (id) => nodes.get(id)?.sourceId !== operation.sourceId,
      ) ||
      !stringList(operation.segmentIds) ||
      operation.segmentIds.some((id) => !segmentIds.has(id)) ||
      !['file', 'signals'].includes(operation.scope) ||
      typeof operation.independently !== 'boolean'
    )
      throw new Error('Invalid segmentation operation.');
    definition(operation.definition, operation.sourceId);
  }
  for (const set of project.regionSets ?? []) {
    if (
      typeof set.name !== 'string' ||
      typeof set.createdAt !== 'string' ||
      !sources.has(set.sourceId) ||
      !Number.isSafeInteger(set.sequence) ||
      !Number.isSafeInteger(set.version) ||
      !['recording', 'parent'].includes(set.timeReference) ||
      !Array.isArray(set.regions)
    )
      throw new Error('Invalid saved region set.');
    definition(set.definition, set.sourceId);
    for (const parentId of [set.parentSetId, set.previousId])
      if (
        parentId &&
        (regionSets.get(parentId)?.sourceId !== set.sourceId ||
          regionSets.get(parentId)!.sequence >= set.sequence)
      )
        throw new Error('Invalid region ancestry.');
    for (const region of set.regions)
      if (
        typeof region.id !== 'string' ||
        typeof region.name !== 'string' ||
        !Number.isFinite(region.start) ||
        !Number.isFinite(region.end) ||
        region.start > region.end ||
        typeof region.endInclusive !== 'boolean'
      )
        throw new Error('Invalid saved region.');
  }
  for (const run of project.functionRuns ?? []) {
    if (
      typeof run.id !== 'string' ||
      typeof run.createdAt !== 'string' ||
      !Number.isSafeInteger(run.sequence) ||
      !nonnegative(run.skipped) ||
      (run.sourceId !== '' && !sources.has(run.sourceId)) ||
      !operations.has(run.operation) ||
      !Number.isFinite(run.parameter) ||
      !stringList(run.inputIds) ||
      !run.inputIds.length ||
      !stringList(run.secondaryIds ?? []) ||
      [...run.inputIds, ...(run.secondaryIds ?? [])].some(
        (id) => nodes.get(id)?.sourceId !== run.sourceId,
      ) ||
      !Array.isArray(run.outputs) ||
      (run.regionSetId &&
        regionSets.get(run.regionSetId)?.sourceId !== run.sourceId)
    )
      throw new Error('Invalid saved function invocation.');
    for (const output of run.outputs)
      if (
        nodes.get(output.signalId)?.sourceId !== run.sourceId ||
        nodes.get(output.inputId)?.sourceId !== run.sourceId ||
        (output.regionId &&
          !regionSets
            .get(run.regionSetId ?? '')
            ?.regions.some((region) => region.id === output.regionId))
      )
        throw new Error('Invalid function output.');
  }
  for (const example of project.examples ?? [])
    if (
      typeof example.key !== 'string' ||
      !sources.has(example.sourceId) ||
      !stringList(example.outputIds) ||
      example.outputIds.some((id) => !nodes.has(id))
    )
      throw new Error('Invalid saved example.');
  for (const example of project.regionExamples ?? [])
    if (
      typeof example.key !== 'string' ||
      !sources.has(example.sourceId) ||
      !regionSets.has(example.regionSetId) ||
      (example.runId &&
        !project.functionRuns?.some((run) => run.id === example.runId))
    )
      throw new Error('Invalid saved region example.');
  validateWorkflowRecords(
    project.workflowSteps ?? [],
    project.workflowBatches,
    project.workflowRecipes,
    new Set(sources.keys()),
  );
  return project;
}
