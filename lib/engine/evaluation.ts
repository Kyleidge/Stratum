import { SignalGraph } from '../signal-graph';
import {
  CHECKPOINT_FIELDS,
  CHECKPOINTED,
  executeSignal,
  type ExecutionOptions,
} from '../signal-executor';
import { recipeKey } from '../signal-recipe';
import { yieldEngine } from '../engine-yield';
import { chunkWindow } from '../signal-range';
import {
  segmentEntries,
  segmentWithin,
  signalSegment,
  type SegmentEntry,
} from '../file-segments';
import {
  valueParameters,
  type BoundValue,
  type ParameterBindings,
  type ValueOperation,
  type ValueParameters,
} from '../workflow-types';
import {
  BINDABLE_VALUE,
  resolveBinding,
  type BindingContext,
} from '../value-bindings';
import type {
  FileSegment,
  Operation,
  Point,
  SegmentSet,
  SeriesChunk,
  SignalNode,
} from '../signal-types';
import {
  derivedOwner,
  CHECKPOINTS_KEY,
  CHECKPOINT_BUDGET,
  result,
  complete,
} from './store';
import { EngineStore } from './store';

/**
 * Reading signals: raw columns, lazy derived evaluation with filter
 * checkpoints, sample lookups, value bindings and segment crops.
 */
export abstract class EngineEvaluation extends EngineStore {
  /** Lookups and names for resolving settings taken from values. */
  protected bindingContext(): BindingContext {
    const values = new Map(
      (this.project.values ?? []).map((value) => [value.id, value]),
    );
    const nodes = new Map(this.project.nodes.map((node) => [node.id, node]));
    return {
      values,
      nodes,
      segments: segmentEntries(this.project),
      label: (id) =>
        this.project.labels?.[id] ??
        values.get(id)?.name ??
        nodes.get(id)?.name ??
        'this input',
    };
  }
  /** Bindings may only name settings that accept values. */
  protected checkBindings(
    bindings: ParameterBindings | undefined,
    allowed: readonly string[],
    name: string,
  ) {
    for (const key of Object.keys(bindings ?? {}))
      if (!allowed.includes(key) || !BINDABLE_VALUE[key])
        throw new Error(`${name} cannot take its ${key} from a value.`);
  }
  /** A value calculation's settings for one input, with bound values. */
  protected boundValueSettings(
    operation: ValueOperation,
    parameters: ValueParameters | undefined,
    bindings: ParameterBindings | undefined,
    input: SignalNode,
  ): { parameters: ValueParameters; bound?: Record<string, BoundValue> } {
    const resolved: ValueParameters = { ...parameters };
    const bound: Record<string, BoundValue> = {};
    const context = bindings ? this.bindingContext() : undefined;
    for (const [name, binding] of Object.entries(bindings ?? {})) {
      const result = resolveBinding(
        context!,
        binding,
        input.id,
        BINDABLE_VALUE[name],
        name,
        input.unit,
      );
      resolved[name] = result.number;
      bound[name] = { valueId: result.valueId, factor: result.factor };
    }
    return {
      parameters: valueParameters(operation, resolved),
      ...(Object.keys(bound).length ? { bound } : {}),
    };
  }
  private async *raw(
    id: string,
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    const node = this.find(id);
    const source = this.project.sources.find(
      (item) => item.id === node.sourceId,
    )!;
    const [first, end] = chunkWindow(source.chunkRanges, sourceRange);
    for (let i = first; i < end; i++) {
      this.check();
      const time = await this.column(source.id, i, 'time');
      const values = await this.column(source.id, i, node.channel!);
      await yieldEngine();
      this.check();
      yield { time: time.slice(), values: values.slice() };
    }
  }
  /**
   * Every sample, or for a window an exact contiguous run covering it plus
   * the neighboring sample on each side. Complete passes record filter
   * checkpoints; windows resume from them instead of the first sample.
   */
  evaluate(
    id: string,
    _visiting = new Set<string>(),
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    return this.execute(id, this.graph(), sourceRange);
  }
  /** Evaluate in a given graph, such as one with an unsaved preview node. */
  protected execute(
    id: string,
    graph: SignalGraph,
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    const options: ExecutionOptions = {
      checkpoints: (node) =>
        this.checkpointCache.get(recipeKey(graph, node.id)) ?? undefined,
      record: (node, checkpoints) =>
        this.saveCheckpoints(recipeKey(graph, node.id), checkpoints),
      spacing: (node) => {
        const source = this.project.sources.find(
          (item) => item.id === node.sourceId,
        );
        return source && source.rows > 1
          ? (source.end - source.start) / (source.rows - 1)
          : undefined;
      },
    };
    const run = () =>
      executeSignal(
        id,
        graph,
        (input, range) => this.raw(input, range),
        () => this.check(),
        sourceRange,
        options,
      );
    return sourceRange ? this.afterCheckpoints(id, graph, run) : run();
  }
  private async *afterCheckpoints(
    id: string,
    graph: SignalGraph,
    run: () => AsyncGenerator<SeriesChunk>,
  ): AsyncGenerator<SeriesChunk> {
    // Load saved state for every checkpointed step this window depends on.
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const node = graph.find(stack.pop()!);
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      stack.push(...node.parents);
      if (!CHECKPOINTED.has(node.operation) || node.timeRecipe) continue;
      const recipe = recipeKey(graph, node.id);
      if (this.checkpointCache.has(recipe)) continue;
      let value: unknown;
      try {
        value = await result(
          this.db
            .transaction('chunks')
            .objectStore('chunks')
            .get([derivedOwner(recipe), 0, CHECKPOINTS_KEY]),
        );
      } catch {
        value = undefined;
      }
      this.check();
      this.rememberCheckpoints(
        recipe,
        value instanceof Float64Array && value.length % CHECKPOINT_FIELDS === 0
          ? value
          : null,
      );
    }
    yield* run();
  }
  private rememberCheckpoints(recipe: string, value: Float64Array | null) {
    const bytes = value?.byteLength ?? 0;
    if (bytes > CHECKPOINT_BUDGET) return;
    const old = this.checkpointCache.get(recipe);
    if (old !== undefined) {
      this.checkpointBytes -= old?.byteLength ?? 0;
      this.checkpointCache.delete(recipe);
    }
    while (
      this.checkpointBytes + bytes > CHECKPOINT_BUDGET &&
      this.checkpointCache.size
    ) {
      const [first, evicted] = this.checkpointCache.entries().next().value!;
      this.checkpointBytes -= evicted?.byteLength ?? 0;
      this.checkpointCache.delete(first);
    }
    this.checkpointCache.set(recipe, value);
    this.checkpointBytes += bytes;
  }
  /** Disposable: a failed write only means a later window starts earlier. */
  private saveCheckpoints(recipe: string, checkpoints: Float64Array) {
    if (checkpoints.length < 2 * CHECKPOINT_FIELDS) return;
    this.rememberCheckpoints(recipe, checkpoints);
    try {
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(checkpoints, [
        derivedOwner(recipe),
        0,
        CHECKPOINTS_KEY,
      ]);
      void complete(tx).catch(() => {});
    } catch {
      // The database may be closing; the in-memory copy still serves windows.
    }
  }
  /** Count the full output, including missing values; never count plot points. */
  async sampleCount(id: string): Promise<number> {
    const graph = this.graph();
    this.check();
    const cached = this.sampleCounts.get(id);
    if (cached !== undefined) return cached;
    let node = graph.find(id);
    // These operations keep every input timestamp, even when a value is missing.
    while (
      node.timeRecipe
        ? ['align', 'combine'].includes(node.timeRecipe.kind)
        : [
            'smooth',
            'median',
            'exponential',
            'low-pass',
            'high-pass',
            'scale',
            'offset',
            'absolute',
            'derivative',
            'integral',
            'time-shift',
            'zero-time',
            'add',
            'subtract',
            'multiply',
            'divide',
            'power',
            'bsfc',
          ].includes(node.operation)
    ) {
      this.check();
      node = graph.find(node.parents[0]);
    }
    let count = this.sampleCounts.get(node.id);
    if (count === undefined) {
      if (node.operation === 'raw')
        count = this.project.sources.find(
          (source) => source.id === node.sourceId,
        )!.rows;
      else {
        count = 0;
        for await (const chunk of this.evaluate(node.id)) {
          this.check();
          count += chunk.time.length;
        }
      }
    }
    this.check();
    if (this.sampleCounts.size >= 64)
      this.sampleCounts.delete(this.sampleCounts.keys().next().value!);
    this.sampleCounts.set(id, count);
    return count;
  }
  protected async hasSample(
    id: string,
    start: number,
    end: number,
    endExclusive = false,
  ): Promise<boolean> {
    let node = this.find(id);
    while (true) {
      if (end < start) return false;
      if (node.timeRecipe) {
        for await (const chunk of this.evaluate(node.id))
          for (const time of chunk.time) {
            this.check();
            if (time >= start && (endExclusive ? time < end : time <= end))
              return true;
          }
        return false;
      }
      if (node.operation === 'raw') {
        const source = this.project.sources.find(
          (item) => item.id === node.sourceId,
        )!;
        for (let i = 0; i < source.chunks; i++) {
          const range = source.chunkRanges[i];
          if (range[1] < start || range[0] > end) continue;
          const times = await this.column(source.id, i, 'time');
          let low = 0;
          let high = times.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (times[middle] < start) low = middle + 1;
            else high = middle;
          }
          if (
            low < times.length &&
            (endExclusive ? times[low] < end : times[low] <= end)
          )
            return true;
        }
        return false;
      }
      if (node.operation === 'min-max') {
        let times = this.extremaTimes.get(node.id);
        if (!times) {
          times = [];
          for await (const chunk of this.evaluate(node.id))
            times.push(...chunk.time);
          if (this.extremaTimes.size >= 128)
            this.extremaTimes.delete(this.extremaTimes.keys().next().value!);
          this.extremaTimes.set(node.id, times);
        }
        return times.some(
          (time) => time >= start && (endExclusive ? time < end : time <= end),
        );
      }
      if (node.operation === 'crop') {
        start = Math.max(start, node.parameters.start);
        if (node.parameters.end < end)
          endExclusive = node.parameters.endExclusive === 1;
        else if (
          node.parameters.end === end &&
          node.parameters.endExclusive === 1
        )
          endExclusive = true;
        end = Math.min(end, node.parameters.end);
      }
      if (node.operation === 'resample') {
        const [origin, last] = this.bounds(node.id);
        let index = Math.max(
          0,
          Math.floor((start - origin) * node.parameters.value),
        );
        if (origin + index / node.parameters.value < start) index++;
        const candidate = origin + index / node.parameters.value;
        if (
          candidate > Math.min(end, last) ||
          (endExclusive && candidate === end)
        )
          return false;
        start = candidate;
        end = this.bounds(node.parents[0])[1];
        endExclusive = false;
      }
      const translation =
        node.operation === 'time-shift'
          ? node.parameters.value
          : node.operation === 'zero-time'
            ? -this.bounds(node.parents[0])[0]
            : 0;
      start -= translation;
      end -= translation;
      node = this.find(node.parents[0]);
    }
  }
  protected gridRecipe(id: string): string {
    const operations: [Operation, Record<string, number>][] = [];
    let node = this.find(id);
    while (node.operation !== 'raw') {
      if (node.timeRecipe?.kind === 'resample')
        return JSON.stringify([
          node.timeReference?.id,
          node.timeRecipe.grid,
          operations,
        ]);
      if (node.timeRecipe?.kind === 'align' || node.timeRecipe?.kind === 'crop')
        return JSON.stringify([node.id, operations]);
      if (node.operation === 'min-max')
        return JSON.stringify([node.id, operations]);
      if (
        ['crop', 'resample', 'time-shift', 'zero-time'].includes(node.operation)
      ) {
        const last = operations.at(-1);
        if (node.operation === 'crop' && last?.[0] === 'crop') {
          const a = last[1],
            b = node.parameters;
          const end = Math.min(a.end, b.end);
          last[1] = {
            start: Math.max(a.start, b.start),
            end,
            endExclusive:
              (a.end === end && a.endExclusive === 1) ||
              (b.end === end && b.endExclusive === 1)
                ? 1
                : 0,
          };
        } else
          operations.push([
            node.operation,
            node.operation === 'crop'
              ? {
                  ...node.parameters,
                  endExclusive: node.parameters.endExclusive ?? 0,
                }
              : node.parameters,
          ]);
      }
      node = this.find(node.parents[0]);
    }
    return JSON.stringify([node.sourceId, operations]);
  }
  /** Signals must share a segment set's recording or workspace time axis. */
  protected checkSegmentInput(id: string, set: SegmentSet) {
    const node = this.find(id);
    if (
      node.sourceId !== set.sourceId ||
      (set.sourceId === '' &&
        this.graph().timeReferences.get(id)?.id !== set.timeReferenceId)
    )
      throw new Error(
        `${this.project.labels?.[id] ?? node.name} is not on the time axis of these segments. Segments apply to the signals of the recording they were found in.`,
      );
  }
  /**
   * The signal to read for `id` within `segment`: itself when it already
   * belongs to that segment, otherwise a hidden crop of it (added to
   * `crops`). Undefined when it has no samples there, or belongs to a
   * segment that does not contain this one.
   */
  protected async segmentCrop(
    id: string,
    segment: FileSegment,
    entries: ReadonlyMap<string, SegmentEntry>,
    crops: Map<string, SignalNode>,
  ): Promise<string | undefined> {
    const own = signalSegment(this.graph().nodes, id);
    if (own === segment.id) return id;
    if (own && !segmentWithin(entries, segment.id, own)) return undefined;
    const key = `${id}\n${segment.id}`;
    const known = crops.get(key);
    if (known) return known.id;
    const parent = this.find(id);
    const offset = this.axisOffset(id);
    const [first, last] = this.bounds(id);
    const start = Math.max(first, segment.start + offset);
    const end = Math.min(last, segment.end + offset);
    const endExclusive = !segment.endInclusive && end === segment.end + offset;
    if (end < start || !(await this.hasSample(id, start, end, endExclusive)))
      return undefined;
    const crop = this.node(parent.sourceId, parent.name, parent.unit, 'crop', [
      id,
    ]);
    crop.parameters = { start, end, endExclusive: endExclusive ? 1 : 0 };
    crop.color = parent.color;
    crop.internal = true;
    crop.segmentId = segment.id;
    crops.set(key, crop);
    return crop.id;
  }
  protected async neighbor(
    id: string,
    time: number,
    side: 'before' | 'after',
  ): Promise<Point | undefined> {
    let previous: Point | undefined;
    const node = this.find(id);
    for await (const chunk of node.operation === 'raw' && !node.timeRecipe
      ? this.raw(id, [time, time])
      : this.evaluate(id, undefined, [time, time]))
      for (let i = 0; i < chunk.time.length; i++) {
        const t = chunk.time[i];
        if (side === 'before') {
          if (t >= time) return previous;
          previous = [t, chunk.values[i]];
        } else if (t > time) return [t, chunk.values[i]];
      }
    return previous;
  }
}
