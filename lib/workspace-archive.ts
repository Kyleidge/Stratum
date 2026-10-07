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
import { valueParameters, valueSpec, type ScalarValue } from './workflow-types';
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

export const ARCHIVE_LIMIT = 128 * 1024 * 1024;
export const EXPORT_LIMIT = 64 * 1024 * 1024;
function archiveRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(
      'This file is not a valid workspace backup. Choose a complete .stratum archive.',
    );
  }
}
export async function* archiveLines(file: Blob): AsyncGenerator<unknown> {
  if (file.size > ARCHIVE_LIMIT)
    throw new Error(
      'Workspace archives are limited to 128 MiB in this version.',
    );
  let buffer = '';
  const decoder = new TextDecoder();
  for (let offset = 0; offset < file.size; offset += 262144) {
    buffer += decoder.decode(
      await file.slice(offset, offset + 262144).arrayBuffer(),
      { stream: true },
    );
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield archiveRecord(line);
    }
    if (buffer.length > 32 * 1024 * 1024)
      throw new Error('Archive metadata is too large.');
  }
  buffer += decoder.decode();
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
    ].every(Array.isArray)
  )
    throw new Error('Invalid workspace collections.');
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
          parameter <= 0)
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
  const outputs = new Set([
    ...nodes.keys(),
    ...(project.values ?? []).map((value) => value.id),
  ]);
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
        BINDABLE_DERIVE[node.operation] ? { value: true } : {},
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
    for (const id of step.outputIds) {
      if (owners.has(id))
        throw new Error('An output belongs to multiple operations.');
      owners.set(id, step);
      const node = nodes.get(id),
        value = values.get(id);
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
        dependencies.add(id),
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
        ? Object.values(segmentation?.definition?.bindings ?? {}).flatMap(
            (binding) => binding.valueIds,
          )
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
      [...step.inputIds, ...(step.valueInputIds ?? [])].some(
        (id) => (owners.get(id)?.sequence ?? Infinity) >= step.sequence,
      )
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
