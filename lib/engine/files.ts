import { referenceClock } from '../time-types';
import { isoClockTime } from '../clock-time';
import { withWorkflowHistory } from '../workflow-history';
import { remapProject } from '../workflow-lifecycle';
import { APP_VERSION } from '../app-version';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_LIMIT,
  ARCHIVE_VERSION,
  EXPORT_LIMIT,
  ChunkedWriter,
  checkArchiveHeader,
  archiveLines,
  validateWorkspace,
  type ByteSink,
} from '../workspace-archive';
import type { Project } from '../signal-types';
import { CHUNK_SIZE, WORKSPACE_SCHEMA_VERSION, uid, complete } from './store';
import { EngineRegions } from './regions';

/**
 * Workspace backups, restore and samples/summary exports.
 */
export abstract class EngineFiles extends EngineRegions {
  /**
   * Streams a version 1 NDJSON archive to `sink` in bounded chunks: the
   * header, every original sample column, then a completion record. Returns
   * the archive's size in bytes. `limit` caps it for in-memory downloads.
   */
  async writeBackup(sink: ByteSink, limit = Infinity) {
    const out = new ChunkedWriter(
      sink,
      limit,
      'This workspace exceeds the 128 MiB archive limit. Nothing was downloaded.',
    );
    const project = this.project;
    let chunks = 0;
    const total = project.sources.reduce(
      (sum, source) => sum + source.chunks * (source.channels.length + 1),
      0,
    );
    const header = JSON.stringify({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      app: APP_VERSION,
      createdAt: new Date().toISOString(),
      schema: WORKSPACE_SCHEMA_VERSION,
      project: withWorkflowHistory(project),
    });
    // JSON turns NaN and Infinity into null: write only metadata that restores.
    try {
      validateWorkspace((JSON.parse(header) as { project: unknown }).project);
    } catch (error) {
      throw new Error(
        `This workspace cannot be backed up because its saved metadata is invalid: ${error instanceof Error ? error.message : String(error)} Nothing was saved.`,
      );
    }
    await out.write(header + '\n');
    for (const source of project.sources)
      for (let index = 0; index < source.chunks; index++)
        for (const column of [
          'time',
          ...source.channels.map((_, index) => index),
        ]) {
          this.check();
          const data = await this.column(source.id, index, column);
          await out.write(
            JSON.stringify({
              sourceId: source.id,
              index,
              column,
              data: Array.from(data, (value) =>
                Number.isFinite(value) ? value : null,
              ),
            }) + '\n',
          );
          chunks++;
          if (chunks % 64 === 0) {
            const percent = Math.round((chunks / total) * 100);
            this.progress(`Writing workspace backup… ${percent}%`, percent);
          }
        }
    await out.write(JSON.stringify({ complete: true, chunks }) + '\n');
    await out.flush();
    return out.bytes;
  }
  async backupWorkspace() {
    const parts: BlobPart[] = [];
    await this.writeBackup((bytes) => {
      parts.push(bytes as Uint8Array<ArrayBuffer>);
    }, ARCHIVE_LIMIT);
    return new Blob(parts, { type: 'application/x-stratus-workspace' });
  }
  /**
   * Restores a backup from a Blob (browser, 128 MiB) or a native byte stream
   * (no size limit). Every record is validated and staged under fresh source
   * IDs; the workspace is replaced in one commit only after the archive is
   * complete, and the prior workspace stays available through Undo.
   */
  async restoreWorkspace(file: Blob | ReadableStream<Uint8Array>) {
    let next: Project | undefined;
    const sourceMapping = new Map<string, string>(),
      seen = new Set<string>();
    const previousTimes = new Map<string, number>();
    let completed = false;
    try {
      let expected = 0;
      for await (const value of archiveLines(file)) {
        this.check();
        if (expected && seen.size % 64 === 63) {
          const percent = Math.min(
            99,
            Math.round((seen.size / expected) * 100),
          );
          this.progress(`Restoring workspace backup… ${percent}%`, percent);
        }
        if (!value || typeof value !== 'object' || completed)
          throw new Error('Invalid or extra archive records.');
        const record = value as Record<string, unknown>;
        if (!next) {
          checkArchiveHeader(record);
          next = validateWorkspace(record.project);
          expected = next.sources.reduce(
            (sum, source) => sum + source.chunks * (source.channels.length + 1),
            0,
          );
          next.sources.forEach((source) => sourceMapping.set(source.id, uid()));
          for (const id of sourceMapping.values())
            await this.trackImport(id, true);
          continue;
        }
        if (record.complete === true) {
          if (record.chunks !== seen.size)
            throw new Error('Archive chunk count is incorrect.');
          completed = true;
          continue;
        }
        const source = next.sources.find((item) => item.id === record.sourceId);
        const index = record.index as number,
          column = record.column as string | number;
        if (
          !source ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= source.chunks ||
          !(
            column === 'time' ||
            (Number.isSafeInteger(column) &&
              Number(column) >= 0 &&
              Number(column) < source.channels.length)
          ) ||
          !Array.isArray(record.data)
        )
          throw new Error('Invalid archive sample column.');
        const key = JSON.stringify([source.id, index, column]);
        if (
          seen.has(key) ||
          record.data.length !==
            Math.min(CHUNK_SIZE, source.rows - index * CHUNK_SIZE)
        )
          throw new Error('Duplicate or incomplete archive samples.');
        const data = Float64Array.from(record.data, (sample: unknown) => {
          if (sample === null && column !== 'time') return NaN;
          if (typeof sample !== 'number' || !Number.isFinite(sample))
            throw new Error('Invalid sample value.');
          return sample;
        });
        if (column === 'time') {
          const bounds = source.chunkRanges[index];
          if (bounds[0] !== data[0] || bounds[1] !== data.at(-1))
            throw new Error('Archive chunk ranges do not match samples.');
          for (const time of data) {
            if (time <= (previousTimes.get(source.id) ?? -Infinity))
              throw new Error('Archive timestamps must increase.');
            previousTimes.set(source.id, time);
          }
          if (
            (index === 0 && data[0] !== source.start) ||
            (index === source.chunks - 1 && data.at(-1) !== source.end)
          )
            throw new Error('Archive time bounds do not match metadata.');
        }
        const tx = this.db.transaction('chunks', 'readwrite'),
          done = complete(tx);
        tx.objectStore('chunks').add(data, [
          sourceMapping.get(source.id)!,
          index,
          column,
        ]);
        await done;
        seen.add(key);
      }
      if (!next || !completed || seen.size !== expected)
        throw new Error('The archive is truncated or missing samples.');
      await this.save(
        remapProject(next, sourceMapping),
        undefined,
        undefined,
        'Restore workspace backup',
      );
      for (const id of sourceMapping.values())
        await this.trackImport(id, false).catch(() => {});
    } catch (error) {
      for (const id of sourceMapping.values()) await this.removeIncomplete(id);
      throw error;
    }
  }
  /**
   * Streams evaluated samples as CSV to `sink` in bounded chunks and returns
   * the size in bytes. `limit` caps it for in-memory downloads.
   */
  async writeSamples(ids: string[], sink: ByteSink, limit = Infinity) {
    const { csvText } = await import('../workflow-delivery');
    const { WorkflowIndex } = await import('../workflow-history');
    const index = new WorkflowIndex(this.project);
    const out = new ChunkedWriter(
      sink,
      limit,
      'Samples CSV exceeds the 64 MiB export limit. Export fewer signals or shorter segments.',
    );
    // Signals whose time tells clock time add their samples' clock times.
    const clocks = new Map(
      [...new Set(ids)].map((id) => [
        id,
        referenceClock(this.graph().timeReferences.get(id)),
      ]),
    );
    const withClock = [...clocks.values()].some(Boolean);
    await out.write(
      `Signal,Signal ID,Recording,Unit,Time reference,Time reference ID,Time meaning,Time (s),Value${withClock ? ',Clock time' : ''}\r\n`,
    );
    for (const id of new Set(ids)) {
      const clock = clocks.get(id);
      const node = this.find(id);
      const source = this.project.sources.find(
        (item) => item.id === node.sourceId,
      );
      const timeReference = this.graph().timeReferences.get(id)!;
      const sources = source
        ? source.name
        : [
            ...new Set(
              index
                .lineage([id])
                .originals.map(
                  (original) =>
                    this.project.sources.find(
                      (item) => item.id === original.sourceId,
                    )?.name ?? original.sourceId,
                ),
            ),
          ].join('; ');
      const prefix = [
        index.label(id),
        id,
        sources,
        node.unit,
        timeReference.name,
        timeReference.id,
        timeReference.kind,
      ]
        .map(csvText)
        .join(',');
      for await (const chunk of this.evaluate(id)) {
        const lines: string[] = [];
        for (let i = 0; i < chunk.time.length; i++)
          lines.push(
            `${prefix},${chunk.time[i]},${Number.isFinite(chunk.values[i]) ? chunk.values[i] : ''}${withClock ? `,${clock ? isoClockTime(clock, chunk.time[i]) : ''}` : ''}\r\n`,
          );
        await out.write(lines.join(''));
        this.check();
      }
    }
    await out.flush();
    return out.bytes;
  }
  async exportSamples(ids: string[]) {
    const parts: BlobPart[] = [];
    await this.writeSamples(
      ids,
      (bytes) => {
        parts.push(bytes as Uint8Array<ArrayBuffer>);
      },
      EXPORT_LIMIT,
    );
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }
  async exportSummary(ids: string[]) {
    const { csvText: quote } = await import('../workflow-delivery');
    const finite = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) ? value : '';
    const lines = [
      'Signal,Operation,Unit,Valid samples,Minimum,Maximum,Mean,Time integral,Parents,Function ID,Region set,Region version,Region,Start (s),End (s),End inclusive,Energy-weighted mean',
    ];
    for (const id of ids) {
      const n = this.find(id);
      const run = this.project.functionRuns?.find((item) =>
        item.outputs.some((output) => output.signalId === id),
      );
      const output = run?.outputs.find((item) => item.signalId === id);
      const set = this.project.regionSets?.find((item) =>
        item.regions.some((region) => region.id === output?.regionId),
      );
      const region = set?.regions.find((item) => item.id === output?.regionId);
      const { summary: s } = await this.plot(id);
      lines.push(
        [
          quote(this.project.labels?.[id] ?? n.name),
          quote(n.operation),
          quote(n.unit),
          s.count,
          finite(s.min),
          finite(s.max),
          finite(s.mean),
          finite(s.integral),
          quote(n.parents.join(';')),
          quote(run?.id ?? ''),
          quote(set?.name ?? ''),
          set?.version ?? '',
          quote(region?.name ?? ''),
          region?.start ?? '',
          region?.end ?? '',
          region ? String(region.endInclusive) : '',
          finite(s.weightedMean),
        ].join(','),
      );
    }
    return new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }
}
