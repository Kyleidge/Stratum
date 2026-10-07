import type { Project, SignalNode, Source } from './signal-types';
import type { TimeAnchor, TimeRecipe, TimeSettings } from './time-types';
import { TIME_OPERATIONS, timeInputs, COMPARISON_MATH } from './time-types';
import { arithmeticUnit } from './signal-arithmetic';
import { SignalGraph } from './signal-graph';
import { CrossingDetector, validTriggerNoise } from './segmentation';
import type { SeriesChunk } from './signal-types';
import { randomId } from './random-id';

/** A UI/segmentation scope, never an imported recording or persisted source. */
export function workspaceTimeScope(
  project: Project,
  graph = new SignalGraph(project),
): Source | undefined {
  const nodes = project.nodes.filter((node) => node.sourceId === '');
  if (!nodes.length) return;
  const ranges = nodes.map((node) => graph.ranges.get(node.id)!);
  return {
    id: '',
    name: 'Workspace timeline',
    start: ranges.reduce((min, range) => Math.min(min, range[0]), Infinity),
    end: ranges.reduce((max, range) => Math.max(max, range[1]), -Infinity),
    rows: 0,
    chunks: 0,
    bytes: 0,
    channels: nodes.map((node) => node.id),
    synthetic: false,
    chunkRanges: [],
  };
}

function finite(...values: number[]) {
  if (!values.every(Number.isFinite))
    throw new Error('Time settings must contain finite numbers.');
}
function interval(start: number, end: number) {
  finite(start, end);
  if (end < start) throw new Error('The end must be at or after the start.');
}
export function validateTimeRecipe(recipe: TimeRecipe) {
  if (!recipe || typeof recipe !== 'object')
    throw new Error('Invalid time recipe.');
  if (recipe.kind === 'align') {
    finite(recipe.scale, recipe.anchor, recipe.target);
    if (recipe.scale <= 0) throw new Error('Clock scale must be positive.');
  } else if (recipe.kind === 'resample') {
    const grid = recipe.grid;
    if (!grid || !['uniform', 'reference'].includes(grid.kind))
      throw new Error('Choose a target grid.');
    interval(grid.start, grid.end);
    if (grid.kind === 'uniform') {
      finite(grid.rate);
      if (
        grid.rate < 0.01 ||
        grid.rate > 10000 ||
        (grid.end - grid.start) * grid.rate > 100000000
      )
        throw new Error(
          'Choose 0.01–10,000 Hz and at most 100 million output samples.',
        );
      if (grid.start + 1 / grid.rate <= grid.start)
        throw new Error(
          'Align to a smaller time origin before resampling at this rate.',
        );
    } else if (typeof grid.signalId !== 'string' || !grid.signalId)
      throw new Error('Choose a reference signal.');
    if (!['linear', 'previous', 'nearest'].includes(recipe.interpolation))
      throw new Error('Choose an interpolation method.');
    finite(recipe.maxGap);
    if (recipe.maxGap <= 0)
      throw new Error('Maximum interpolation gap must be positive.');
    if (recipe.filter) {
      finite(recipe.filter.cutoff, recipe.filter.halfWidth);
      if (
        recipe.filter.cutoff <= 0 ||
        !Number.isInteger(recipe.filter.halfWidth) ||
        recipe.filter.halfWidth < 4 ||
        recipe.filter.halfWidth > 256
      )
        throw new Error(
          'Choose a positive cutoff and a filter half-width of 4–256 samples.',
        );
      if (grid.kind === 'uniform' && recipe.filter.cutoff >= grid.rate / 2)
        throw new Error(
          'Anti-alias cutoff must be below half the output rate.',
        );
    }
  } else if (recipe.kind === 'combine') {
    if (!['difference', 'sum', 'product', 'ratio'].includes(recipe.operator))
      throw new Error('Choose a supported calculation.');
  } else if (recipe.kind === 'crop') interval(recipe.start, recipe.end);
  else throw new Error('Unknown time operation.');
}

export function validateTimeSettings(settings: TimeSettings) {
  if (!settings || typeof settings !== 'object')
    throw new Error('Invalid time settings.');
  if (settings.kind === 'align') {
    if (
      !settings.reference ||
      !settings.reference.id ||
      !settings.reference.name?.trim() ||
      !['absolute', 'relative'].includes(settings.reference.kind)
    )
      throw new Error('Name the comparison time reference.');
    finite(settings.target);
    if (settings.secondTarget !== undefined) finite(settings.secondTarget);
    if (!Array.isArray(settings.groups) || !settings.groups.length)
      throw new Error('Choose an alignment group.');
    for (const group of settings.groups) {
      if (!Array.isArray(group.inputIds) || !group.inputIds.length)
        throw new Error('Each alignment group needs signals.');
      for (const anchor of [group.anchor, group.secondAnchor]) {
        if (!anchor) continue;
        if (anchor.kind === 'point') finite(anchor.time);
        else if (anchor.kind === 'event') {
          if (
            !anchor.trigger ||
            !['rising', 'falling'].includes(anchor.trigger.edge) ||
            !Number.isSafeInteger(anchor.occurrence) ||
            anchor.occurrence < 1 ||
            !validTriggerNoise(anchor.trigger)
          )
            throw new Error('Choose an edge and positive event occurrence.');
          finite(anchor.trigger.threshold, anchor.trigger.offset);
        } else if (anchor.kind !== 'start')
          throw new Error('Invalid time anchor.');
      }
      if (
        !group.anchor ||
        (settings.secondTarget !== undefined) !==
          (group.secondAnchor !== undefined)
      )
        throw new Error(
          'Clock correction requires two anchors in every group.',
        );
    }
    const inputs = settings.groups.flatMap((g) => g.inputIds);
    if (new Set(inputs).size !== inputs.length)
      throw new Error(
        'A signal can only belong to one alignment group per operation.',
      );
  } else {
    if (!Array.isArray(settings.inputIds) || !settings.inputIds.length)
      throw new Error('Choose input signals.');
    if (settings.kind === 'combine' && settings.inputIds.length !== 2)
      throw new Error('Choose two input signals.');
    if (
      settings.kind === 'combine' &&
      settings.inputIds[0] === settings.inputIds[1]
    )
      throw new Error('Choose two distinct input signals.');
    if (
      settings.kind !== 'combine' &&
      new Set(settings.inputIds).size !== settings.inputIds.length
    )
      throw new Error('Choose unique input signals.');
    validateTimeRecipe(settings);
  }
  if (timeInputs(settings).length > 10000)
    throw new Error('Limit this operation to 10,000 inputs.');
}

export async function timeNodes(
  project: Project,
  settings: TimeSettings,
  evaluate: (id: string) => AsyncGenerator<SeriesChunk>,
  check: () => void,
): Promise<SignalNode[]> {
  validateTimeSettings(settings);
  const graph = new SignalGraph(project);
  timeInputs(settings).forEach((id) => graph.find(id));
  const batchId = randomId();
  const outputs: SignalNode[] = [];
  const sameClock = (ids: string[]) => {
    const reference = graph.timeReferences.get(ids[0])!;
    if (ids.some((id) => graph.timeReferences.get(id)?.id !== reference.id))
      throw new Error(
        'These signals have different time references. Save an explicit alignment before using a shared grid or calculation.',
      );
    return reference;
  };
  const add = (
    inputId: string,
    recipe: TimeRecipe,
    extra: string[] = [],
    unit?: string,
  ) => {
    const parent = graph.find(inputId);
    const operation = `time-${recipe.kind}` as keyof typeof TIME_OPERATIONS;
    outputs.push({
      id: randomId(),
      sourceId: '',
      parents: [inputId, ...extra],
      name: `${parent.name} · ${TIME_OPERATIONS[operation]}`,
      unit: unit ?? parent.unit,
      operation,
      parameters: {},
      timeRecipe: recipe,
      timeReference:
        settings.kind === 'align'
          ? structuredClone(settings.reference)
          : graph.timeReferences.get(inputId),
      color: parent.color,
      createdAt: new Date().toISOString(),
      version: 1,
      batchId,
    });
  };
  async function anchorTime(
    anchor: TimeAnchor,
    ids: string[],
  ): Promise<number> {
    if (anchor.kind === 'point') return anchor.time;
    if (anchor.kind === 'start') return graph.ranges.get(ids[0])![0];
    sameClock([...ids, anchor.trigger.signalId]);
    const detector = new CrossingDetector(anchor.trigger);
    let count = 0;
    for await (const chunk of evaluate(anchor.trigger.signalId))
      for (let i = 0; i < chunk.time.length; i++) {
        check();
        const event = detector.next(chunk.time[i], chunk.values[i]);
        if (event?.kind === 'crossing' && ++count === anchor.occurrence)
          return event.time + anchor.trigger.offset;
      }
    throw new Error(
      `Alignment event ${anchor.occurrence} was not found. Existing work is unchanged.`,
    );
  }
  if (settings.kind === 'align') {
    for (const group of settings.groups) {
      check();
      sameClock(group.inputIds);
      const anchor = await anchorTime(group.anchor, group.inputIds);
      const second = group.secondAnchor
        ? await anchorTime(group.secondAnchor, group.inputIds)
        : undefined;
      const scale =
        second === undefined
          ? 1
          : (settings.secondTarget! - settings.target) / (second - anchor);
      const recipe: TimeRecipe = {
        kind: 'align',
        anchor,
        target: settings.target,
        scale,
      };
      validateTimeRecipe(recipe);
      const extra = [
        ...new Set(
          [group.anchor, group.secondAnchor].flatMap((item) =>
            item?.kind === 'event' ? [item.trigger.signalId] : [],
          ),
        ),
      ];
      for (const id of group.inputIds)
        add(
          id,
          recipe,
          extra.filter((item) => item !== id),
        );
    }
  } else if (settings.kind === 'resample') {
    sameClock(timeInputs(settings));
    for (const id of settings.inputIds)
      add(
        id,
        {
          kind: 'resample',
          grid: structuredClone(settings.grid),
          interpolation: settings.interpolation,
          maxGap: settings.maxGap,
          filter: settings.filter,
        },
        settings.grid.kind === 'reference' ? [settings.grid.signalId] : [],
      );
  } else if (settings.kind === 'combine') {
    sameClock(settings.inputIds);
    const [a, b] = settings.inputIds.map((id) => graph.find(id));
    const unit = arithmeticUnit(
      COMPARISON_MATH[settings.operator],
      a.unit,
      b.unit,
    );
    add(a.id, { kind: 'combine', operator: settings.operator }, [b.id], unit);
    outputs[0].name = `${a.name} ${{ difference: '−', sum: '+', product: '×', ratio: '/' }[settings.operator]} ${b.name}`;
  } else {
    for (const id of settings.inputIds) {
      const [start, end] = graph.ranges.get(id)!;
      if (Math.max(start, settings.start) > Math.min(end, settings.end))
        throw new Error(
          'A selected signal has no samples in the requested interval.',
        );
      add(id, { kind: 'crop', start: settings.start, end: settings.end });
    }
  }
  return outputs;
}
