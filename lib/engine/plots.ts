import { Envelope } from '../signal-math';
import { recipeKey } from '../signal-recipe';
import { yieldEngine } from '../engine-yield';
import { chunkWindow } from '../signal-range';
import {
  blockCount,
  groupBlocks,
  IndexBuilder,
  LeafWriter,
  indexLeaves,
  indexSlices,
  readBlock,
  usableIndex,
  PLOT_LEAF_SIZE,
  type PlotBlocks,
  type PlotIndex,
} from '../plot-index';
import type { Plot, Point, SeriesChunk, SignalNode } from '../signal-types';
import {
  CHUNK_SIZE,
  INDEX_BUILD_BUDGET,
  indexKey,
  leavesKey,
  derivedOwner,
  complete,
} from './store';
import { EngineEvaluation } from './evaluation';

/**
 * Plot envelopes from persistent min/max indexes or streamed samples.
 */
export abstract class EnginePlots extends EngineEvaluation {
  private async indexedRawPlot(
    node: SignalNode,
    bounds: [number, number],
    context: boolean,
  ): Promise<Plot | undefined> {
    const source = this.project.sources.find(
      (item) => item.id === node.sourceId,
    )!;
    const window = chunkWindow(source.chunkRanges, bounds);
    // Exact reads are cheaper at sample-level zoom and for small recordings.
    if (source.rows < PLOT_LEAF_SIZE * 700 || window[1] - window[0] <= 4)
      return;
    try {
      const index = await this.readIndex<PlotIndex>([
        source.id,
        0,
        indexKey(node.channel!),
      ]);
      if (!usableIndex(index, source.rows)) return;
      const root = readBlock(index.levels.at(-1)!, 0);
      if (
        root.first[0] !== source.start ||
        root.last[0] !== source.end ||
        !Number.isFinite(root.total) ||
        !Number.isFinite(root.integral) ||
        (root.count &&
          Math.max(Math.abs(root.min[1]), Math.abs(root.max[1])) > 1e150)
      )
        return;
      const envelope = new Envelope(...bounds);
      let current = -1;
      let time: Float64Array = new Float64Array();
      let values: Float64Array = new Float64Array();
      let ticks = 0;
      for await (const slice of indexSlices(
        index,
        bounds,
        async (chunk) => {
          const leaves = await this.readIndex<PlotBlocks>([
            source.id,
            chunk,
            leavesKey(node.channel!),
          ]);
          if (
            !(leaves instanceof Float64Array) ||
            blockCount(leaves) !==
              Math.ceil(
                Math.min(CHUNK_SIZE, source.rows - chunk * CHUNK_SIZE) /
                  PLOT_LEAF_SIZE,
              )
          )
            throw new Error('Rebuild the incomplete plot index.');
          return leaves;
        },
        () => this.check(),
      )) {
        if (++ticks % 128 === 0) {
          await yieldEngine();
          this.check();
        }
        if ('block' in slice) envelope.addBlock(slice.block);
        else {
          if (current !== slice.chunk) {
            time = await this.column(source.id, slice.chunk, 'time');
            values = await this.column(source.id, slice.chunk, node.channel!);
            current = slice.chunk;
          }
          for (let i = slice.start; i < slice.end; i++)
            envelope.add(time[i], values[i]);
        }
      }
      const plot = { id: node.id, ...envelope.finish() };
      if (context && bounds[0] > source.start) {
        const before = await this.neighbor(node.id, bounds[0], 'before');
        if (before) plot.points.unshift(before);
      }
      if (context && bounds[1] < source.end) {
        const after = await this.neighbor(node.id, bounds[1], 'after');
        if (after) plot.points.push(after);
      }
      this.check();
      return plot;
    } catch {
      // Indexes are disposable. Incomplete/old caches must never break raw data.
      this.check();
      return undefined;
    }
  }
  private async indexedDerivedPlot(
    node: SignalNode,
    recipe: string,
    bounds: [number, number],
    context: boolean,
  ): Promise<Plot | undefined> {
    const owner = derivedOwner(recipe);
    try {
      const index = await this.readIndex<PlotIndex>([owner, 0, indexKey(0)]);
      if (!usableIndex(index, index?.rows ?? -1)) return;
      const root = readBlock(index.levels.at(-1)!, 0);
      if (
        !Number.isFinite(root.total) ||
        !Number.isFinite(root.integral) ||
        (root.count &&
          Math.max(Math.abs(root.min[1]), Math.abs(root.max[1])) > 1e150)
      )
        return;
      const envelope = new Envelope(...bounds);
      // Partial leaves at the window edges evaluate exact samples, resuming
      // from checkpoints rather than the first sample.
      let span: [number, number] | undefined;
      const exact = async () => {
        if (!span) return;
        const [from, to] = span;
        span = undefined;
        let past = false;
        for await (const chunk of this.evaluate(node.id, undefined, [
          from,
          to,
        ])) {
          for (let i = 0; i < chunk.time.length; i++) {
            const time = chunk.time[i];
            if (time > to) {
              past = true;
              break;
            }
            if (time >= from) envelope.add(time, chunk.values[i]);
          }
          if (past) break;
        }
      };
      let ticks = 0;
      for await (const slice of indexSlices(
        index,
        bounds,
        async (chunk) => {
          const leaves = await this.readIndex<PlotBlocks>([
            owner,
            chunk,
            leavesKey(0),
          ]);
          if (
            !(leaves instanceof Float64Array) ||
            blockCount(leaves) !==
              Math.ceil(
                Math.min(CHUNK_SIZE, index.rows - chunk * CHUNK_SIZE) /
                  PLOT_LEAF_SIZE,
              )
          )
            throw new Error('Rebuild the incomplete plot index.');
          return leaves;
        },
        () => this.check(),
      )) {
        if (++ticks % 128 === 0) {
          await yieldEngine();
          this.check();
        }
        if ('block' in slice) {
          await exact();
          envelope.addBlock(slice.block);
        } else span = span ? [span[0], slice.to] : [slice.from, slice.to];
      }
      await exact();
      const plot = { id: node.id, ...envelope.finish() };
      if (context && bounds[0] > root.first[0]) {
        const before = await this.neighbor(node.id, bounds[0], 'before');
        if (before) plot.points.unshift(before);
      }
      if (context && bounds[1] < root.last[0]) {
        const after = await this.neighbor(node.id, bounds[1], 'after');
        if (after) plot.points.push(after);
      }
      this.check();
      return plot;
    } catch {
      // Indexes are disposable; a damaged one is rebuilt by the next overview.
      this.check();
      await this.deleteIndex([owner, 0, indexKey(0)]).catch(() => {});
      return undefined;
    }
  }
  private rememberPlot(key: string, plot: Plot) {
    if (this.cache.size >= 64)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, plot);
    return plot;
  }
  async plot(
    id: string,
    range?: [number, number],
    context = false,
  ): Promise<Plot> {
    const bounds = range ?? this.bounds(id);
    const key = JSON.stringify([id, bounds, context]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const node = this.find(id);
    if (node.operation === 'raw' && !node.timeRecipe) {
      const indexed = await this.indexedRawPlot(node, bounds, context);
      if (indexed) return this.rememberPlot(key, indexed);
    }
    const graph = this.graph();
    const recipe =
      node.operation === 'raw' && !node.timeRecipe
        ? undefined
        : recipeKey(graph, id);
    if (recipe) {
      const indexed = await this.indexedDerivedPlot(
        node,
        recipe,
        bounds,
        context,
      );
      if (indexed) return this.rememberPlot(key, indexed);
    }
    // A complete pass of a derived signal records its filter checkpoints and
    // plot index, so later windows and overviews need not repeat it.
    const extent = graph.ranges.get(id)!;
    const whole = !!recipe && bounds[0] <= extent[0] && bounds[1] >= extent[1];
    let writer: LeafWriter | undefined = whole
      ? new LeafWriter(PLOT_LEAF_SIZE * 700, async (first, leaves) => {
          const tx = this.db.transaction('chunks', 'readwrite'),
            done = complete(tx);
          leaves.forEach((blocks, i) =>
            tx
              .objectStore('chunks')
              .put(blocks, [derivedOwner(recipe!), first + i, leavesKey(0)]),
          );
          await done;
        })
      : undefined;
    const envelope = new Envelope(...bounds);
    let before: Point | undefined, after: Point | undefined;
    const source =
      node.operation === 'raw'
        ? this.project.sources.find((item) => item.id === node.sourceId)
        : undefined;
    // Old workspaces/restores acquire an optional index during a full plot pass.
    let rebuilding: IndexBuilder | undefined =
      source &&
      source.rows >= PLOT_LEAF_SIZE * 700 &&
      bounds[0] === source.start &&
      bounds[1] === source.end
        ? new IndexBuilder()
        : undefined;
    let rebuiltChunks = 0;
    for await (const chunk of this.evaluate(
      id,
      undefined,
      whole ? undefined : bounds,
    )) {
      if (writer)
        try {
          await writer.add(chunk);
          if (writer.builder.bytes > INDEX_BUILD_BUDGET) writer = undefined;
        } catch {
          this.check();
          writer = undefined;
        }
      if (rebuilding) {
        try {
          const leaves = indexLeaves(chunk);
          rebuilding.push(groupBlocks(leaves));
          if (rebuilding.bytes > INDEX_BUILD_BUDGET) rebuilding = undefined;
          else
            await this.writeIndex(
              [source!.id, rebuiltChunks++, leavesKey(node.channel!)],
              leaves,
            );
        } catch {
          this.check();
          rebuilding = undefined;
        }
      }
      let past = false;
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i],
          value = chunk.values[i];
        if (time > bounds[1]) {
          if (context) after = [time, value];
          past = true;
          break;
        }
        if (context && time < bounds[0]) before = [time, value];
        envelope.add(time, value);
      }
      // Later samples cannot change this window; stop reading them.
      if (past && !writer && !rebuilding) break;
    }
    if (writer)
      try {
        const index = await writer.finish();
        if (index)
          await this.writeIndex([derivedOwner(recipe!), 0, indexKey(0)], index);
      } catch {
        this.check();
      }
    if (rebuilding && rebuiltChunks === source!.chunks)
      try {
        await this.writeIndex(
          [source!.id, 0, indexKey(node.channel!)],
          rebuilding.finish(source!.rows),
        );
      } catch {
        this.check();
      }
    const plot = { id, ...envelope.finish() };
    // Boundary neighbors keep line segments visible between sample instants.
    // They never enter the viewport summary, and a missing neighbor breaks the line.
    if (before) plot.points.unshift(before);
    if (after) plot.points.push(after);
    if (node.operation === 'bsfc') {
      // Integrate only intervals valid in BOTH inputs to avoid bias from missing fuel samples.
      const powerInput = this.evaluate(node.parents[1]);
      let powerChunk: SeriesChunk | undefined;
      let powerIndex = 0;
      let previous: [number, number, number] | undefined;
      let fuelTotal = 0;
      let energyTotal = 0;
      for await (const fuel of this.evaluate(node.parents[0])) {
        for (let i = 0; i < fuel.time.length; i++) {
          if (!powerChunk || powerIndex === powerChunk.time.length) {
            powerChunk = (await powerInput.next()).value;
            powerIndex = 0;
          }
          if (!powerChunk || powerChunk.time[powerIndex] !== fuel.time[i])
            throw new Error('Inputs must share timestamps.');
          const t = fuel.time[i];
          const f = fuel.values[i];
          const watts = powerChunk.values[powerIndex++];
          const valid =
            t >= bounds[0] &&
            t <= bounds[1] &&
            Number.isFinite(f) &&
            f >= 0 &&
            Number.isFinite(watts) &&
            watts > 0.1;
          if (valid && previous) {
            const dt = t - previous[0];
            fuelTotal += ((f + previous[1]) * dt) / 2;
            energyTotal += ((watts + previous[2]) * dt) / 2;
          }
          previous = valid ? [t, f, watts] : undefined;
        }
      }
      plot.summary.weightedMean =
        energyTotal > 0 ? (fuelTotal * 1000) / energyTotal : NaN;
    }
    return this.rememberPlot(key, plot);
  }
  async rows(
    id: string,
    offset: number,
  ): Promise<{ rows: Point[]; hasMore: boolean }> {
    const rows: Point[] = [];
    let count = 0;
    for await (const c of this.evaluate(id))
      for (let i = 0; i < c.time.length; i++) {
        if (count++ < offset) continue;
        if (rows.length >= 100) return { rows, hasMore: true };
        rows.push([c.time[i], c.values[i]]);
      }
    return { rows, hasMore: false };
  }
}
