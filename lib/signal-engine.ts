import { CsvParser, Envelope, power } from './signal-math';
import { SignalGraph } from './signal-graph';
import { executeSignal } from './signal-executor';
import { CrossingDetector } from './segmentation';
import type { TriggerEvent } from './segmentation';
import type {
  Chunk,
  EdgeTrigger,
  Operation,
  Plot,
  Point,
  Project,
  Segment,
  SegmentationDefinition,
  SegmentationPlan,
  SegmentationScope,
  SeriesChunk,
  SignalNode,
  Source,
} from './signal-types';

const CHUNK_SIZE = 16384;
export const COLORS = ['#61d9b0', '#ac9cfa', '#edb477', '#74b9fa', '#e787ac'];
const emptyProject = (): Project => ({ sources: [], nodes: [], segments: [] });
const uid = () => crypto.randomUUID();
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error('Storage transaction aborted.'));
    tx.onerror = () => reject(tx.error);
  });
}

export class SignalEngine {
  project: Project = emptyProject();
  cancelled = false;
  private db!: IDBDatabase;
  private cache = new Map<string, Plot>();
  private columnCache = new Map<string, Float64Array>();
  private cacheBytes = 0;
  private revision = 0;
  private indexedProject?: Project;
  private indexedGraph?: SignalGraph;
  private indexedCount = -1;
  private extremaTimes = new Map<string, number[]>();
  private graph(): SignalGraph {
    if (
      this.indexedProject !== this.project ||
      this.indexedCount !== this.project.nodes.length
    ) {
      this.indexedGraph = new SignalGraph(this.project);
      this.indexedProject = this.project;
      this.indexedCount = this.project.nodes.length;
    }
    return this.indexedGraph!;
  }
  private segmentPreviewCache?: { key: string; plan: SegmentationPlan };
  constructor(
    private progress: (message: string, percent: number) => void = () => {},
    private databaseName = 'stratus-workbench-v1',
  ) {}
  async open() {
    const request = indexedDB.open(this.databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chunks');
      request.result.createObjectStore('project');
    };
    this.db = await result(request);
    const tx = this.db.transaction('project');
    const snapshot = tx.objectStore('project').get('current');
    const revision = tx.objectStore('project').get('revision');
    this.project =
      ((await result(snapshot)) as Project | undefined) ?? emptyProject();
    this.revision = Number(await result(revision)) || 0;
    return this.project;
  }
  close() {
    this.db.close();
  }
  private check() {
    if (this.cancelled)
      throw new Error(
        'Operation cancelled. Your existing signals are unchanged.',
      );
  }
  private async save(next: Project) {
    this.check();
    const tx = this.db.transaction('project', 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore('project');
    const version = store.get('revision');
    let conflict = false;
    version.onsuccess = () => {
      if ((Number(version.result) || 0) !== this.revision) {
        conflict = true;
        tx.abort();
        return;
      }
      store.put(next, 'current');
      store.put(this.revision + 1, 'revision');
    };
    try {
      await done;
    } catch (error) {
      if (conflict)
        throw new Error(
          'This workspace was updated in another window. Reload before making changes.',
        );
      throw error;
    }
    this.project = next;
    this.revision++;
  }
  private async writeChunk(sourceId: string, index: number, chunk: Chunk) {
    this.check();
    const tx = this.db.transaction('chunks', 'readwrite');
    const done = complete(tx);
    tx.objectStore('chunks').add(chunk.time, [sourceId, index, 'time']);
    chunk.values.forEach((column, c) =>
      tx.objectStore('chunks').add(column, [sourceId, index, c]),
    );
    await done;
  }
  private async column(
    sourceId: string,
    index: number,
    column: string | number,
  ): Promise<Float64Array> {
    const key = JSON.stringify([sourceId, index, column]);
    const cached = this.columnCache.get(key);
    if (cached) return cached;
    const value = (await result(
      this.db
        .transaction('chunks')
        .objectStore('chunks')
        .get([sourceId, index, column]),
    )) as Float64Array | undefined;
    if (!value)
      throw new Error(
        'A stored source chunk is missing. Reimport the recording.',
      );
    while (
      this.cacheBytes + value.byteLength > 16 * 1024 * 1024 &&
      this.columnCache.size
    ) {
      const first = this.columnCache.keys().next().value!;
      this.cacheBytes -= this.columnCache.get(first)!.byteLength;
      this.columnCache.delete(first);
    }
    this.columnCache.set(key, value);
    this.cacheBytes += value.byteLength;
    return value;
  }
  private async removeIncomplete(sourceId: string) {
    const tx = this.db.transaction('chunks', 'readwrite');
    const done = complete(tx);
    tx.objectStore('chunks').delete(
      IDBKeyRange.bound([sourceId, 0], [sourceId, Number.MAX_SAFE_INTEGER]),
    );
    await done;
  }
  private node(
    sourceId: string,
    name: string,
    unit: string,
    operation: Operation,
    parents: string[],
    parameters: Record<string, number> = {},
    channel?: number,
  ): SignalNode {
    return {
      id: uid(),
      name,
      unit,
      operation,
      parents,
      parameters,
      channel,
      sourceId,
      color: COLORS[(channel ?? parents.length) % COLORS.length],
      createdAt: new Date().toISOString(),
      version: 1,
    };
  }
  find(id: string): SignalNode {
    return this.graph().find(id);
  }
  async importCsv(file: Blob & { name?: string }, synthetic = false) {
    this.cancelled = false;
    const id = uid();
    const parser = new CsvParser();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let headers: string[] = [];
    let times: number[] = [];
    let columns: number[][] = [];
    let rows = 0;
    let chunks = 0;
    let start = 0;
    let end = -Infinity;
    const chunkRanges: [number, number][] = [];
    const flush = async () => {
      if (!times.length) return;
      chunkRanges.push([times[0], times.at(-1)!]);
      await this.writeChunk(id, chunks++, {
        time: Float64Array.from(times),
        values: columns.map((c) => Float64Array.from(c)),
      });
      times = [];
      columns = headers.slice(1).map(() => []);
    };
    const consume = async (records: string[][]) => {
      for (const record of records) {
        this.check();
        if (!headers.length) {
          headers = record.map((v) => v.trim().replace(/^\uFEFF/, ''));
          if (
            headers.length < 2 ||
            headers.length > 256 ||
            headers.some((v) => !v) ||
            new Set(headers).size !== headers.length
          )
            throw new Error(
              'Use unique headers: time in seconds, followed by 1–255 numeric signals.',
            );
          columns = headers.slice(1).map(() => []);
          continue;
        }
        if (record.length !== headers.length)
          throw new Error(
            `Row ${rows + 2}: expected ${headers.length} columns, received ${record.length}.`,
          );
        const t = record[0].trim() ? Number(record[0]) : NaN;
        if (!Number.isFinite(t) || t <= end)
          throw new Error(
            `Row ${rows + 2}: time must be finite and strictly increasing in seconds.`,
          );
        if (!rows) start = t;
        end = t;
        times.push(t);
        for (let c = 1; c < record.length; c++) {
          const value = record[c].trim() ? Number(record[c]) : NaN;
          if (record[c].trim() && !Number.isFinite(value))
            throw new Error(
              `Row ${rows + 2}, ${headers[c]}: expected a finite number or empty cell.`,
            );
          columns[c - 1].push(value);
        }
        rows++;
        if (times.length >= CHUNK_SIZE) await flush();
      }
    };
    try {
      // Blob slices put a strict bound on decoded input even if a stream implementation emits huge chunks.
      for (let offset = 0; offset < file.size; offset += 262144) {
        this.check();
        const bytes = await file.slice(offset, offset + 262144).arrayBuffer();
        await consume(parser.feed(decoder.decode(bytes, { stream: true })));
        this.progress(
          `Importing ${rows.toLocaleString()} samples`,
          Math.min(99, ((offset + bytes.byteLength) / file.size) * 100),
        );
      }
      await consume(parser.feed(decoder.decode(), true));
      await flush();
      if (rows < 2)
        throw new Error('A recording needs at least two data rows.');
      const nodes = headers.slice(1).map((header, channel) => {
        const match = header.match(/^(.*?)\s*\[([^\]]+)\]$/);
        return this.node(
          id,
          match?.[1].trim() || header,
          match?.[2] || '—',
          'raw',
          [],
          {},
          channel,
        );
      });
      const source: Source = {
        id,
        name: file.name || 'Generated signal.csv',
        rows,
        chunks,
        bytes: rows * headers.length * 8,
        start,
        end,
        channels: nodes.map((n) => n.id),
        synthetic,
        chunkRanges,
      };
      await this.save({
        ...this.project,
        sources: [...this.project.sources, source],
        nodes: [...this.project.nodes, ...nodes],
      });
      return source;
    } catch (error) {
      await this.removeIncomplete(id);
      throw error;
    }
  }
  async demo() {
    const existing = this.project.sources.find((s) => s.synthetic);
    if (existing) return existing;
    const lines = [
      'Time [s],Engine speed [rpm],Torque [Nm],Fuel flow [kg/h],Oil temperature [°C]',
    ];
    for (let i = 0; i <= 18000; i++) {
      const t = i / 100;
      const ramp = Math.floor((t - 12) / 58);
      const local = t - 12 - Math.max(0, ramp) * 58;
      const active = ramp >= 0 && ramp < 3 && local >= 0 && local < 39;
      const x = Math.max(0, Math.min(1, local / 39));
      const rpm = active
        ? 1400 + 5200 * x + 10 * Math.sin(t * 17)
        : 870 + 18 * Math.sin(t * 4);
      const torque = active
        ? 210 +
          145 * Math.sin(x * Math.PI * 0.89) -
          16 * x +
          ramp * 3 +
          2.8 * Math.sin(t * 25)
        : 13 + 1.5 * Math.sin(t * 8);
      const efficiency = 239 + 70 * Math.pow(2 * x - 0.86, 2) + ramp * 2;
      const fuel = active
        ? (power(torque, rpm) * efficiency) / 1000 + 0.22 * Math.sin(t * 31)
        : 0.9 + 0.08 * Math.sin(t * 3);
      lines.push(
        [t, rpm, torque, fuel, 84 + t * 0.045 + Math.sin(t / 20)]
          .map((v) => v.toFixed(5))
          .join(','),
      );
    }
    const file = new File([lines.join('\n')], 'Dyno_Run_024.csv', {
      type: 'text/csv',
    });
    const source = await this.importCsv(file, true);
    const segments = await this.segment(
      source.id,
      {
        method: 'triggers',
        start: {
          signalId: source.channels[0],
          edge: 'rising',
          threshold: 900,
          offset: 0,
        },
        end: {
          signalId: source.channels[0],
          edge: 'falling',
          threshold: 900,
          offset: 0,
        },
        minimumDuration: 0,
        boundary: 'clip',
      },
      source.channels,
    );
    await this.calculateSegmentMetrics(segments.map((segment) => segment.id));
    return source;
  }
  bounds(id: string): [number, number] {
    this.find(id);
    return this.graph().ranges.get(id)!;
  }
  private async *raw(
    id: string,
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    const node = this.find(id);
    const source = this.project.sources.find(
      (item) => item.id === node.sourceId,
    )!;
    for (let i = 0; i < source.chunks; i++) {
      this.check();
      const bounds = source.chunkRanges[i];
      if (
        sourceRange &&
        (bounds[1] < sourceRange[0] || bounds[0] > sourceRange[1])
      )
        continue;
      const time = await this.column(source.id, i, 'time');
      const values = await this.column(source.id, i, node.channel!);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.check();
      yield { time: time.slice(), values: values.slice() };
    }
  }
  evaluate(
    id: string,
    _visiting = new Set<string>(),
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    return executeSignal(
      id,
      this.graph(),
      (input, range) => this.raw(input, range),
      () => this.check(),
      sourceRange,
    );
  }
  async derive(parentId: string, operation: Operation, value: number) {
    return (await this.deriveMany([parentId], operation, value))[0];
  }
  async deriveMany(parentIds: string[], operation: Operation, value: number) {
    if (!parentIds.length || new Set(parentIds).size !== parentIds.length)
      throw new Error('Choose unique inputs for this operation.');
    const nodes: SignalNode[] = [];
    const batchId = uid();
    for (const parentId of parentIds) {
      this.check();
      const parent = this.find(parentId);
      if (!Number.isFinite(value)) throw new Error('Enter a finite parameter.');
      if (
        operation === 'raw' ||
        operation === 'crop' ||
        operation === 'power' ||
        operation === 'bsfc'
      )
        throw new Error(
          'This operation requires a segment or multiple inputs.',
        );
      if (
        operation === 'smooth' &&
        (!Number.isInteger(value) || value < 1 || value > 100000)
      )
        throw new Error('Window must be 1–100,000 samples.');
      if (
        operation === 'median' &&
        (!Number.isInteger(value) || value < 1 || value > 1001)
      )
        throw new Error('Median window must be 1–1,001 whole samples.');
      if (operation === 'exponential' && (value <= 0 || value > 1))
        throw new Error(
          'Smoothing factor must be greater than 0 and at most 1.',
        );
      if ((operation === 'low-pass' || operation === 'high-pass') && value <= 0)
        throw new Error('Cutoff frequency must be greater than 0 Hz.');
      if (operation === 'resample' && (value < 0.01 || value > 10000))
        throw new Error('Sample rate must be 0.01–10,000 Hz.');
      if (
        operation === 'resample' &&
        (this.bounds(parentId)[1] - this.bounds(parentId)[0]) * value >
          100000000
      )
        throw new Error(
          'This rate would produce over 100 million samples. Choose a lower rate.',
        );
      const labels: Partial<Record<Operation, string>> = {
        smooth: 'Smoothed',
        median: 'Median filtered',
        exponential: 'Exponentially smoothed',
        'low-pass': 'Low-pass filtered',
        'high-pass': 'High-pass filtered',
        scale: 'Scaled',
        offset: 'Offset',
        absolute: 'Absolute',
        derivative: 'Derivative',
        integral: 'Integral',
        'min-max': 'Min / Max',
        'time-shift': 'Time shifted',
        'zero-time': 'Zeroed',
        resample: 'Resampled',
      };
      const unit =
        operation === 'derivative'
          ? `${parent.unit}/s`
          : operation === 'integral'
            ? `${parent.unit}·s`
            : parent.unit;
      const n = this.node(
        parent.sourceId,
        `${parent.name.split(' · ')[0]} · ${labels[operation]}`,
        unit,
        operation,
        [parentId],
        { value },
      );
      n.color = parent.color;
      n.batchId = batchId;
      if (operation === 'resample') {
        const first = await this.evaluate(parentId).next();
        const t = first.value?.time;
        const spacing = t && t.length > 1 ? t[1] - t[0] : 1 / value;
        n.parameters.maxGap = spacing * 5;
        const start = this.bounds(parentId)[0];
        if (start + 1 / value <= start)
          throw new Error(
            'Align this signal to zero before resampling at this rate.',
          );
      }
      nodes.push(n);
    }
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
    });
    return nodes;
  }
  /** Constant translation from recording time to this node's displayed time. */
  private axisOffset(id: string): number {
    this.find(id);
    return this.graph().offsets.get(id)!;
  }
  private async hasSample(
    id: string,
    start: number,
    end: number,
  ): Promise<boolean> {
    let node = this.find(id);
    while (true) {
      if (end < start) return false;
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
          if (low < times.length && times[low] <= end) return true;
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
        return times.some((time) => time >= start && time <= end);
      }
      if (node.operation === 'crop') {
        start = Math.max(start, node.parameters.start);
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
        if (candidate > Math.min(end, last)) return false;
        start = candidate;
        end = this.bounds(node.parents[0])[1];
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
  private gridRecipe(id: string): string {
    const operations: [Operation, Record<string, number>][] = [];
    let node = this.find(id);
    while (node.operation !== 'raw') {
      if (node.operation === 'min-max')
        return JSON.stringify([node.id, operations]);
      if (
        ['crop', 'resample', 'time-shift', 'zero-time'].includes(node.operation)
      )
        operations.push([node.operation, node.parameters]);
      node = this.find(node.parents[0]);
    }
    return JSON.stringify([node.sourceId, operations]);
  }
  private async *triggerEvents(
    trigger: EdgeTrigger,
  ): AsyncGenerator<TriggerEvent> {
    const detector = new CrossingDetector(trigger);
    const offset = this.axisOffset(trigger.signalId);
    let last: number | undefined;
    const [first, end] = this.bounds(trigger.signalId);
    for await (const chunk of this.evaluate(trigger.signalId)) {
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i] - offset;
        last = time;
        const event = detector.next(time, chunk.values[i]);
        if (event) yield event;
      }
      this.progress(
        'Scanning trigger crossings…',
        Math.min(99, 100 * ((last! + offset - first) / (end - first || 1))),
      );
    }
    // Explicit end-of-coverage prevents pairing across unequal input coverage.
    if (last !== undefined) yield { time: last, kind: 'finish' };
  }
  async previewSegments(
    sourceId: string,
    definition: SegmentationDefinition,
    targetIds: string[],
    independently = false,
    scope?: SegmentationScope,
  ): Promise<SegmentationPlan> {
    this.check();
    this.segmentationScope(sourceId, targetIds, independently, scope);
    if (independently) {
      if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
        throw new Error('Choose unique inputs for segmentation.');
      const combined: SegmentationPlan = {
        ranges: [],
        skipped: 0,
        incomplete: 0,
      };
      for (const id of targetIds) {
        const plan = await this.previewSegments(
          sourceId,
          this.memberDefinition(definition, targetIds[0], id),
          [id],
        );
        combined.ranges.push(
          ...plan.ranges.map((range) => ({ ...range, inputId: id })),
        );
        combined.skipped += plan.skipped;
        combined.incomplete += plan.incomplete;
        if (combined.ranges.length > 1000)
          throw new Error(
            'More than 1,000 segments in this batch. Narrow the settings or select fewer inputs.',
          );
      }
      return combined;
    }
    const cacheKey = JSON.stringify([sourceId, definition, targetIds]);
    if (cacheKey === this.segmentPreviewCache?.key)
      return structuredClone(this.segmentPreviewCache.plan);
    const source = this.project.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error('Choose a recording to segment.');
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
      throw new Error('Choose at least one unique output signal.');
    const fromSource = (id: string) => {
      const node = this.find(id);
      if (node.sourceId !== sourceId)
        throw new Error(
          'Triggers and output signals must belong to the same recording.',
        );
      return node;
    };
    const limits: [number, number] = [source.start, source.end];
    for (const id of targetIds) {
      fromSource(id);
      const offset = this.axisOffset(id);
      const [start, end] = this.bounds(id);
      limits[0] = Math.max(limits[0], start - offset);
      limits[1] = Math.min(limits[1], end - offset);
    }
    if (limits[1] <= limits[0])
      throw new Error('Output signals have no shared time interval.');
    if (definition.boundary !== 'clip' && definition.boundary !== 'discard')
      throw new Error('Choose how to handle recording boundaries.');
    const plan: SegmentationPlan = { ranges: [], skipped: 0, incomplete: 0 };
    const add = (
      requestedStart: number,
      requestedEnd: number,
      startTrigger?: number,
      endTrigger?: number,
    ) => {
      const start = Math.max(requestedStart, limits[0]);
      const end = Math.min(requestedEnd, limits[1]);
      const clipped = start !== requestedStart || end !== requestedEnd;
      const minimum =
        definition.method === 'triggers' ? definition.minimumDuration : 0;
      if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd))
        throw new Error('Segment boundaries must be finite.');
      if (
        end <= start ||
        end - start < minimum ||
        (clipped && definition.boundary === 'discard')
      ) {
        plan.skipped++;
        return;
      }
      if (plan.ranges.length >= 1000)
        throw new Error(
          'More than 1,000 segments. Narrow the interval or adjust the settings.',
        );
      plan.ranges.push({
        start,
        end,
        requestedStart,
        requestedEnd,
        startTrigger,
        endTrigger,
        clipped,
      });
    };
    switch (definition.method) {
      case 'triggers': {
        for (const trigger of [definition.start, definition.end]) {
          fromSource(trigger.signalId);
          if (
            !['rising', 'falling'].includes(trigger.edge) ||
            !Number.isFinite(trigger.threshold) ||
            !Number.isFinite(trigger.offset)
          )
            throw new Error(
              'Each trigger needs an edge, finite threshold, and finite time offset.',
            );
        }
        if (
          !Number.isFinite(definition.minimumDuration) ||
          definition.minimumDuration < 0
        )
          throw new Error('Minimum duration must be zero or positive.');
        const streams = [
          this.triggerEvents(definition.start),
          this.triggerEvents(definition.end),
        ];
        const events = await Promise.all(
          streams.map((stream) => stream.next()),
        );
        const valid = [false, false];
        let pending: number | undefined;
        const priority = { gap: 0, valid: 1, crossing: 2, finish: 3 };
        try {
          while (!events.every((event) => event.done)) {
            this.check();
            let side: number;
            if (events[0].done) side = 1;
            else if (events[1].done) side = 0;
            else {
              const a = events[0].value;
              const b = events[1].value;
              side =
                a.time < b.time ||
                (a.time === b.time && priority[a.kind] < priority[b.kind])
                  ? 0
                  : 1;
            }
            const event = events[side].value!;
            if (event.kind === 'valid') valid[side] = true;
            else if (event.kind === 'gap' || event.kind === 'finish') {
              valid[side] = false;
              if (pending !== undefined) {
                plan.incomplete++;
                pending = undefined;
              }
            } else if (valid.every(Boolean)) {
              if (side === 0) pending ??= event.time;
              else if (pending !== undefined && event.time > pending) {
                add(
                  pending + definition.start.offset,
                  event.time + definition.end.offset,
                  pending,
                  event.time,
                );
                pending = undefined;
              }
            }
            events[side] = await streams[side].next();
          }
        } finally {
          await Promise.all(streams.map((stream) => stream.return(undefined)));
        }
        break;
      }
      case 'ranges':
        if (!definition.ranges.length || definition.ranges.length > 1000)
          throw new Error('Enter between 1 and 1,000 time ranges.');
        for (const [start, end] of definition.ranges) {
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            throw new Error(
              'Each time range needs a finite start and a later end.',
            );
          add(start, end);
        }
        break;
      case 'windows': {
        const { start, end, duration, step, includePartial } = definition;
        if (
          ![start, end, duration, step].every(Number.isFinite) ||
          end <= start ||
          duration <= 0 ||
          step <= 0 ||
          start + step <= start ||
          start + duration <= start
        )
          throw new Error(
            'Use a finite time interval and positive window duration and step.',
          );
        const count = Math.ceil((end - start) / step);
        if (count > 1000)
          throw new Error(
            'More than 1,000 windows. Increase the step or narrow the interval.',
          );
        for (let i = 0; i < count; i++) {
          const a = start + i * step;
          const b = a + duration;
          if (a >= end) break;
          if (b > end && !includePartial) {
            plan.skipped++;
            continue;
          }
          add(a, Math.min(b, end));
        }
        break;
      }
      default:
        throw new Error('Unknown segmentation method.');
    }
    if (plan.ranges.length * targetIds.length > 10000)
      throw new Error(
        'This would create over 10,000 signals. Reduce the segment count or output selection.',
      );
    const populated = [];
    for (const range of plan.ranges) {
      let valid = true;
      for (const id of targetIds) {
        const offset = this.axisOffset(id);
        if (
          !(await this.hasSample(id, range.start + offset, range.end + offset))
        ) {
          valid = false;
          break;
        }
      }
      if (valid) populated.push(range);
      else plan.skipped++;
      this.check();
    }
    plan.ranges = populated;
    this.check();
    this.segmentPreviewCache = { key: cacheKey, plan: structuredClone(plan) };
    return plan;
  }
  async segment(
    sourceId: string,
    definition: SegmentationDefinition,
    targetIds: string[],
    independently = false,
    scope?: SegmentationScope,
  ) {
    const savedScope = this.segmentationScope(
      sourceId,
      targetIds,
      independently,
      scope,
    );
    const plan = await this.previewSegments(
      sourceId,
      definition,
      targetIds,
      independently,
      savedScope,
    );
    if (!plan.ranges.length)
      throw new Error(
        'No complete segments match these settings. Preview the triggers, offsets, or time ranges.',
      );
    const nodes: SignalNode[] = [];
    const baseIndex = this.project.segments.filter(
      (s) => s.sourceId === sourceId,
    ).length;
    const savedDefinition = structuredClone(definition);
    const batchId = uid();
    const segments = plan.ranges.map((boundary, index): Segment => {
      const recipe = boundary.inputId
        ? this.memberDefinition(savedDefinition, targetIds[0], boundary.inputId)
        : savedDefinition;
      const cropped = (boundary.inputId ? [boundary.inputId] : targetIds).map(
        (id) => {
          const parent = this.find(id);
          const offset = this.axisOffset(id);
          const triggers =
            recipe.method === 'triggers'
              ? [recipe.start.signalId, recipe.end.signalId]
              : [];
          const node = this.node(
            sourceId,
            parent.name,
            parent.unit,
            'crop',
            [...new Set([id, ...triggers])],
            {
              start: boundary.start + offset,
              end: boundary.end + offset,
            },
          );
          node.color = parent.color;
          node.batchId = batchId;
          return node;
        },
      );
      nodes.push(...cropped);
      return {
        id: uid(),
        sourceId,
        batchId,
        scope: savedScope,
        name: `Segment ${String(baseIndex + index + 1).padStart(2, '0')}`,
        start: boundary.start,
        end: boundary.end,
        nodes: cropped.map((node) => node.id),
        definition: recipe,
        boundary,
      };
    });
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
      segments: [...this.project.segments, ...segments],
      segmentationOperations: [
        ...(this.project.segmentationOperations ?? []),
        {
          id: batchId,
          sourceId,
          definition: savedDefinition,
          targetIds: [...targetIds],
          independently,
          scope: savedScope,
          segmentIds: segments.map((segment) => segment.id),
        },
      ],
    });
    return segments;
  }
  private segmentationScope(
    sourceId: string,
    targetIds: string[],
    independently: boolean,
    scope?: SegmentationScope,
  ): SegmentationScope {
    const source = this.project.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('Choose a recording to segment.');
    const targets = new Set(targetIds);
    const entireFile =
      !independently &&
      targets.size === source.channels.length &&
      source.channels.every((id) => targets.has(id));
    if (scope === 'file' && !entireFile)
      throw new Error(
        'File segmentation must include every original channel with shared boundaries.',
      );
    return scope ?? (entireFile ? 'file' : 'signals');
  }
  private memberDefinition(
    definition: SegmentationDefinition,
    first: string,
    current: string,
  ): SegmentationDefinition {
    if (definition.method !== 'triggers') return definition;
    return {
      ...definition,
      start: {
        ...definition.start,
        signalId:
          definition.start.signalId === first
            ? current
            : definition.start.signalId,
      },
      end: {
        ...definition.end,
        signalId:
          definition.end.signalId === first ? current : definition.end.signalId,
      },
    };
  }
  // An explicit calculation step; segmentation itself only creates crop recipes.
  async calculateSegmentMetrics(ids: string[]) {
    const nodes: SignalNode[] = [];
    const segments = this.project.segments.map((segment) => {
      if (!ids.includes(segment.id)) return segment;
      const members = segment.nodes.map((id) => this.find(id));
      const rpm = members.find((n) => n.unit.toLowerCase() === 'rpm');
      const torque = members.find((n) => /^n[· ]?m$/i.test(n.unit));
      const fuel = members.find((n) => /^kg\/h$/i.test(n.unit));
      if (!rpm || !torque || members.some((n) => n.operation === 'power'))
        return segment;
      if (
        this.gridRecipe(rpm.id) !== this.gridRecipe(torque.id) ||
        (fuel && this.gridRecipe(rpm.id) !== this.gridRecipe(fuel.id))
      )
        throw new Error(
          'Power and fuel metrics need matching sample grids and time transformations. Segment the synchronized raw channels together.',
        );
      const added = [
        this.node(segment.sourceId, 'Brake power', 'kW', 'power', [
          torque.id,
          rpm.id,
        ]),
      ];
      added[0].color = COLORS[3];
      if (fuel) {
        const consumption = this.node(
          segment.sourceId,
          'Specific fuel consumption',
          'g/kWh',
          'bsfc',
          [fuel.id, added[0].id],
        );
        consumption.color = COLORS[2];
        added.push(consumption);
      }
      nodes.push(...added);
      return {
        ...segment,
        nodes: [...segment.nodes, ...added.map((node) => node.id)],
      };
    });
    if (!nodes.length)
      throw new Error(
        'No new metrics to calculate. Segments need rpm and Nm channels; BSFC also needs kg/h.',
      );
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
      segments,
    });
    return segments.filter((segment) => ids.includes(segment.id));
  }
  async plot(id: string, range?: [number, number]): Promise<Plot> {
    const bounds = range ?? this.bounds(id);
    const key = JSON.stringify([id, bounds]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const envelope = new Envelope(...bounds);
    for await (const chunk of this.evaluate(id))
      for (let i = 0; i < chunk.time.length; i++)
        envelope.add(chunk.time[i], chunk.values[i]);
    const plot = { id, ...envelope.finish() };
    const node = this.find(id);
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
    if (this.cache.size >= 64)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, plot);
    return plot;
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
  async exportSummary(ids: string[]) {
    const lines = [
      'Signal,Operation,Unit,Valid samples,Minimum,Maximum,Mean,Time integral,Parents',
    ];
    const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
    for (const id of ids) {
      const n = this.find(id);
      const { summary: s } = await this.plot(id);
      lines.push(
        [
          quote(n.name),
          quote(n.operation),
          quote(n.unit),
          s.count,
          s.min,
          s.max,
          s.mean,
          s.integral,
          quote(n.parents.join(';')),
        ].join(','),
      );
    }
    return new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }
}
