import { CsvParser, Envelope, RollingMean, bsfc, power } from './signal-math';
import type {
  Chunk,
  Operation,
  Plot,
  Point,
  Project,
  Segment,
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
    const n = this.project.nodes.find((node) => node.id === id);
    if (!n) throw new Error('Signal no longer exists.');
    return n;
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
    await this.segment(source.channels[0], 1400, 8);
    return source;
  }
  bounds(id: string): [number, number] {
    const n = this.find(id);
    const source = this.project.sources.find((s) => s.id === n.sourceId)!;
    let [start, end] = n.parents.length
      ? this.bounds(n.parents[0])
      : [source.start, source.end];
    if (n.operation === 'crop') {
      start = Math.max(start, n.parameters.start);
      end = Math.min(end, n.parameters.end);
    }
    if (n.operation === 'time-shift') {
      start += n.parameters.value;
      end += n.parameters.value;
    }
    if (n.operation === 'zero-time') {
      end -= start;
      start = 0;
    }
    return [start, end];
  }
  async *evaluate(
    id: string,
    visiting = new Set<string>(),
    sourceRange?: [number, number],
  ): AsyncGenerator<SeriesChunk> {
    this.check();
    if (visiting.has(id) || visiting.size > 64)
      throw new Error('Invalid or excessively deep signal dependency graph.');
    const path = new Set(visiting).add(id);
    const n = this.find(id);
    if (n.operation === 'raw') {
      const source = this.project.sources.find((s) => s.id === n.sourceId)!;
      for (let i = 0; i < source.chunks; i++) {
        this.check();
        const bounds = source.chunkRanges[i];
        if (
          sourceRange &&
          (bounds[1] < sourceRange[0] || bounds[0] > sourceRange[1])
        )
          continue;
        const time = await this.column(source.id, i, 'time');
        const values = await this.column(source.id, i, n.channel!);
        // Yield a task even on cache hits so cancellation reaches the worker.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.check();
        yield { time: time.slice(), values: values.slice() };
      }
      return;
    }
    if (n.operation === 'power' || n.operation === 'bsfc') {
      const right = this.evaluate(n.parents[1], path);
      for await (const a of this.evaluate(n.parents[0], path)) {
        const b = await right.next();
        if (b.done || b.value.time.length !== a.time.length)
          throw new Error('Inputs must share a sample grid.');
        const values = new Float64Array(a.time.length);
        for (let i = 0; i < values.length; i++) {
          if (a.time[i] !== b.value.time[i])
            throw new Error('Inputs must share timestamps.');
          values[i] =
            n.operation === 'power'
              ? power(a.values[i], b.value.values[i])
              : bsfc(a.values[i], b.value.values[i]);
        }
        yield { time: a.time, values };
      }
      if (!(await right.next()).done) throw new Error('Input lengths differ.');
      return;
    }
    const mean = new RollingMean(
      n.operation === 'smooth' ? n.parameters.value : 1,
    );
    let previous: Point | undefined;
    let integrated = 0;
    let gridIndex = 0;
    const origin = this.bounds(n.parents[0])[0];
    const inputRange: [number, number] | undefined =
      n.operation === 'crop'
        ? [n.parameters.start, n.parameters.end]
        : undefined;
    for await (const chunk of this.evaluate(n.parents[0], path, inputRange)) {
      const times: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < chunk.time.length; i++) {
        this.check();
        let t = chunk.time[i];
        const input = chunk.values[i];
        let value = input;
        switch (n.operation) {
          case 'crop':
            if (t < n.parameters.start || t > n.parameters.end) continue;
            break;
          case 'smooth':
            value = mean.next(input);
            break;
          case 'scale':
            value *= n.parameters.value;
            break;
          case 'offset':
            value += n.parameters.value;
            break;
          case 'absolute':
            value = Math.abs(value);
            break;
          case 'time-shift':
            t += n.parameters.value;
            break;
          case 'zero-time':
            t -= origin;
            break;
          case 'derivative':
            value = previous ? (input - previous[1]) / (t - previous[0]) : NaN;
            break;
          case 'integral':
            if (
              previous &&
              Number.isFinite(input) &&
              Number.isFinite(previous[1])
            )
              integrated += ((input + previous[1]) / 2) * (t - previous[0]);
            value = Number.isFinite(input) ? integrated : NaN;
            break;
          case 'resample': {
            let nextTime = origin + gridIndex / n.parameters.value;
            while (nextTime <= t) {
              this.check();
              if (times.length >= CHUNK_SIZE) {
                yield {
                  time: Float64Array.from(times),
                  values: Float64Array.from(values),
                };
                times.length = 0;
                values.length = 0;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                this.check();
              }
              times.push(nextTime);
              values.push(
                nextTime === t
                  ? input
                  : previous && nextTime === previous[0]
                    ? previous[1]
                    : previous && t - previous[0] <= n.parameters.maxGap
                      ? previous[1] +
                        ((input - previous[1]) * (nextTime - previous[0])) /
                          (t - previous[0])
                      : NaN,
              );
              const candidate = origin + ++gridIndex / n.parameters.value;
              if (candidate <= nextTime)
                throw new Error(
                  'The output rate is too precise for these timestamps. Align to zero first.',
                );
              nextTime = candidate;
            }
            previous = [t, input];
            continue;
          }
        }
        previous = [chunk.time[i], input];
        times.push(t);
        values.push(value);
      }
      if (times.length)
        yield {
          time: Float64Array.from(times),
          values: Float64Array.from(values),
        };
    }
  }
  async derive(parentId: string, operation: Operation, value: number) {
    this.cancelled = false;
    const parent = this.find(parentId);
    if (!Number.isFinite(value)) throw new Error('Enter a finite parameter.');
    if (
      operation === 'raw' ||
      operation === 'crop' ||
      operation === 'power' ||
      operation === 'bsfc'
    )
      throw new Error('This operation requires a segment or multiple inputs.');
    if (
      operation === 'smooth' &&
      (!Number.isInteger(value) || value < 1 || value > 100000)
    )
      throw new Error('Window must be 1–100,000 samples.');
    if (operation === 'resample' && (value < 0.01 || value > 10000))
      throw new Error('Sample rate must be 0.01–10,000 Hz.');
    if (
      operation === 'resample' &&
      (this.bounds(parentId)[1] - this.bounds(parentId)[0]) * value > 100000000
    )
      throw new Error(
        'This rate would produce over 100 million samples. Choose a lower rate.',
      );
    const labels: Partial<Record<Operation, string>> = {
      smooth: 'Smoothed',
      scale: 'Scaled',
      offset: 'Offset',
      absolute: 'Absolute',
      derivative: 'Derivative',
      integral: 'Integral',
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
      `${parent.name} · ${labels[operation]}`,
      unit,
      operation,
      [parentId],
      { value },
    );
    n.color = parent.color;
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
    // Validate the graph and limits without materializing the recording.
    let depth = 0;
    let cursor = parent;
    while (cursor.parents.length) {
      if (++depth >= 60)
        throw new Error('Maximum derivation depth reached (60).');
      cursor = this.find(cursor.parents[0]);
    }
    await this.save({ ...this.project, nodes: [...this.project.nodes, n] });
    return n;
  }
  async segment(parentId: string, threshold: number, minimumDuration: number) {
    this.cancelled = false;
    if (
      !Number.isFinite(threshold) ||
      !Number.isFinite(minimumDuration) ||
      minimumDuration <= 0
    )
      throw new Error('Use a finite threshold and positive minimum duration.');
    const trigger = this.find(parentId);
    if (trigger.operation !== 'raw')
      throw new Error(
        'Detect ramps from a raw speed channel. Derived signals can be cropped using their source segments in a future version.',
      );
    const ranges: [number, number][] = [];
    let start: number | undefined;
    let initial = 0;
    let peak = -Infinity;
    let previousTime = 0;
    let rawStart: number | undefined;
    let lastAbove = 0;
    const smooth = new RollingMean(15);
    const finish = () => {
      if (
        start !== undefined &&
        Math.min(previousTime, lastAbove) - start >= minimumDuration &&
        peak - initial > Math.max(100, Math.abs(threshold) * 0.15)
      )
        ranges.push([start, Math.min(previousTime, lastAbove)]);
      start = undefined;
      rawStart = undefined;
      peak = -Infinity;
    };
    for await (const chunk of this.evaluate(parentId)) {
      for (let i = 0; i < chunk.time.length; i++) {
        const v = smooth.next(chunk.values[i]);
        const t = chunk.time[i];
        if (chunk.values[i] >= threshold) {
          rawStart ??= t;
          lastAbove = t;
        }
        if (v >= threshold) {
          if (start === undefined) {
            start = rawStart ?? t;
            initial = v;
          }
          peak = Math.max(peak, v);
        } else if (start !== undefined) finish();
        else if (chunk.values[i] < threshold) rawStart = undefined;
        previousTime = t;
      }
    }
    finish();
    if (!ranges.length)
      throw new Error(
        'No ramps found. Lower the threshold or minimum duration.',
      );
    if (ranges.length > 100)
      throw new Error(
        'More than 100 ramps found. Increase the threshold or minimum duration.',
      );
    const source = this.project.sources.find((s) => s.id === trigger.sourceId)!;
    const nodes: SignalNode[] = [];
    const segments: Segment[] = [];
    for (const [a, b] of ranges) {
      const cropped = source.channels.map((id) => {
        const p = this.find(id);
        const n = this.node(source.id, p.name, p.unit, 'crop', [id], {
          start: a,
          end: b,
        });
        n.color = p.color;
        return n;
      });
      const rpm = cropped.find((n) => n.unit.toLowerCase() === 'rpm');
      const torque = cropped.find((n) => /^n[· ]?m$/i.test(n.unit));
      const fuel = cropped.find((n) => /^kg\/h$/i.test(n.unit));
      if (rpm && torque) {
        const p = this.node(source.id, 'Brake power', 'kW', 'power', [
          torque.id,
          rpm.id,
        ]);
        p.color = COLORS[3];
        cropped.push(p);
        if (fuel) {
          const f = this.node(
            source.id,
            'Specific fuel consumption',
            'g/kWh',
            'bsfc',
            [fuel.id, p.id],
          );
          f.color = COLORS[2];
          cropped.push(f);
        }
      }
      nodes.push(...cropped);
      segments.push({
        id: uid(),
        sourceId: source.id,
        name: `Ramp ${String(segments.length + 1).padStart(2, '0')}`,
        start: a,
        end: b,
        nodes: cropped.map((n) => n.id),
        triggerId: parentId,
        threshold,
        minimumDuration,
      });
    }
    // Rerunning creates a new segmentation revision; old lineage remains intact.
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
      segments: [...this.project.segments, ...segments],
    });
    return segments;
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
      let previous: [number, number, number] | undefined;
      let fuelTotal = 0;
      let energyTotal = 0;
      for await (const fuel of this.evaluate(node.parents[0])) {
        const p = await powerInput.next();
        if (p.done) break;
        for (let i = 0; i < fuel.time.length; i++) {
          const t = fuel.time[i];
          const f = fuel.values[i];
          const watts = p.value.values[i];
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
