import { openRecording } from '../formats/index';
import {
  channelNameProblem,
  cleanName,
  MAX_CHANNEL_NAME,
  MAX_RECORDING_CHANNELS,
  type RecordingFile,
} from '../formats/recording';
import type { DelimitedLayout } from '../formats/delimited-layout';
import { clockProblem, type TimeClock } from '../time-types';
import { yieldEngine } from '../engine-yield';
import { IndexBuilder } from '../plot-index';
import { importError, sampleTimeProblem } from '../csv-import-messages';
import { importUnitProblem, UNSTATED_UNIT } from '../units';
import type { SignalNode, Source } from '../signal-types';
import { CHUNK_SIZE, INDEX_BUILD_BUDGET, indexKey, uid } from './store';
import { EngineDerive } from './derive';

/**
 * Recording imports: validated tables written as raw columns with plot
 * indexes, published in one commit.
 */
export abstract class EngineImports extends EngineDerive {
  /** Imports a CSV or any other supported file; returns its first recording. */
  async importCsv(file: Blob & { name?: string }, synthetic = false) {
    return (await this.importRecording(file, { synthetic }))[0];
  }
  /**
   * Imports the chosen tables of a recording file (all by default) as one
   * recording each. Every table publishes in one commit and one Undo entry.
   * With `units` (the import dialog), every signal needs a recognised unit,
   * no unit ('') or a label listed in `custom`; without (batch runs and
   * built-in examples), units are kept as the file states them. Recognised
   * labels keep their spelling (Nm stays Nm); `sameUnit` compares them.
   */
  async importRecording(
    file: Blob & { name?: string },
    options: {
      tables?: number[];
      synthetic?: boolean;
      /** Picks tables once the file's metadata is known (batch runs). */
      choose?: (recording: RecordingFile) => number[];
      /** Delimited text: time axes and the signals on each. */
      layout?: DelimitedLayout;
      /** Units chosen in the import dialog, by table and channel. */
      units?: (string[] | null | undefined)[];
      /** Unrecognised labels the user chose to keep as custom units. */
      custom?: string[];
      /** Signal names chosen in the import dialog, by table and channel. */
      names?: (string[] | null | undefined)[];
      /** Recording names chosen in the import dialog, by table. */
      tableNames?: (string | null | undefined)[];
      /** Units for channels the file leaves without one (batch runs). */
      fill?: (
        channels: RecordingFile['tables'][number]['channels'],
      ) => (string | undefined)[];
    } = {},
  ): Promise<Source[]> {
    this.cancelled = false;
    const fileName = file.name || 'Generated signal.csv';
    const ids: string[] = [];
    try {
      const recording = await openRecording(
        file,
        options.layout ? { layout: options.layout } : {},
      );
      const chosen =
        options.choose?.(recording) ??
        options.tables ??
        recording.tables.map((_, index) => index);
      const tables = [...new Set(chosen)].filter(
        (index) => Number.isInteger(index) && recording.tables[index],
      );
      if (!tables.length)
        throw new Error(
          recording.tables.length
            ? 'Choose at least one group to import.'
            : 'The file holds no numeric signals.',
        );
      const custom = (options.custom ?? []).flatMap((label) =>
        typeof label === 'string' ? [label.trim()] : [],
      );
      const unitsOf = (index: number) => {
        const { channels } = recording.tables[index];
        const chosenUnits = options.units?.[index];
        const filled = options.fill?.(channels);
        return channels.map((channel, c) => {
          const unit =
            chosenUnits?.[c] ??
            (channel.unit === UNSTATED_UNIT ? filled?.[c] : undefined) ??
            channel.unit;
          if (typeof unit !== 'string')
            throw new Error(`The unit of “${channel.name}” is not text.`);
          if (options.units) {
            const problem = importUnitProblem(channel.name, unit, custom);
            if (problem) throw new Error(problem);
          }
          return unit === UNSTATED_UNIT ? unit : unit.trim();
        });
      };
      const units = new Map(tables.map((index) => [index, unitsOf(index)]));
      const namesOf = (index: number) => {
        const { channels } = recording.tables[index];
        const chosenNames = options.names?.[index];
        const names = channels.map((channel, c) => {
          const name = chosenNames?.[c] ?? channel.name;
          if (typeof name !== 'string')
            throw new Error(`The name of “${channel.name}” is not text.`);
          return cleanName(name);
        });
        if (chosenNames) {
          const problem = channelNameProblem(names);
          if (problem) throw new Error(problem);
        }
        return names;
      };
      const names = new Map(tables.map((index) => [index, namesOf(index)]));
      const tableName = (index: number) => {
        const chosenName = options.tableNames?.[index];
        if (chosenName === undefined || chosenName === null)
          return recording.tables[index].name;
        if (typeof chosenName !== 'string' || !cleanName(chosenName))
          throw new Error('Every recording needs a name.');
        return cleanName(chosenName).slice(0, MAX_CHANNEL_NAME);
      };
      const sources: Source[] = [];
      const nodes: SignalNode[] = [];
      for (const [position, index] of tables.entries()) {
        const id = uid();
        ids.push(id);
        await this.trackImport(id, true);
        const table = recording.tables[index];
        const grouped = recording.tables.length > 1 && !!tableName(index);
        const written = await this.writeTable(
          id,
          recording,
          index,
          (rows, fraction) =>
            this.progress(
              `Importing ${grouped ? `${table.name}: ` : ''}${rows.toLocaleString()} samples`,
              Math.min(99, ((position + fraction) / tables.length) * 100),
            ),
        );
        const channels = table.channels.map((_, c) =>
          this.node(
            id,
            names.get(index)![c],
            units.get(index)![c],
            'raw',
            [],
            {},
            c,
          ),
        );
        nodes.push(...channels);
        const { clock: blockClock, ...stored } = written;
        const clock = blockClock ?? table.clock;
        if (clock && clockProblem(clock))
          throw new Error(
            `${grouped ? `${table.name}: ` : ''}The file’s start time cannot be read.`,
          );
        sources.push({
          id,
          name: grouped ? `${fileName} · ${tableName(index)}` : fileName,
          ...stored,
          ...(clock ? { clock: { ...clock } } : {}),
          bytes: written.rows * (channels.length + 1) * 8,
          channels: channels.map((node) => node.id),
          synthetic: options.synthetic ?? false,
        });
      }
      await this.save({
        ...this.project,
        sources: [...this.project.sources, ...sources],
        nodes: [...this.project.nodes, ...nodes],
      });
      // A staged workflow owns publication and recovery of its new columns.
      if (!this.staging)
        for (const id of ids) await this.trackImport(id, false).catch(() => {});
      return sources;
    } catch (error) {
      for (const id of ids) {
        await this.removeIncomplete(id);
        await this.trackImport(id, false);
      }
      throw importError(error, fileName);
    }
  }
  /** Streams one table into chunks; times must be finite and increase. */
  private async writeTable(
    id: string,
    recording: RecordingFile,
    index: number,
    report: (rows: number, fraction: number) => void,
  ) {
    const table = recording.tables[index];
    const width = table.channels.length;
    const label = recording.tables.length > 1 ? table.name : '';
    if (!width)
      throw new Error(`${label || 'The recording'} has no signal columns.`);
    if (width > MAX_RECORDING_CHANNELS)
      throw new Error(
        `${label || 'The recording'} has ${width.toLocaleString()} signals; a recording can have at most ${MAX_RECORDING_CHANNELS.toLocaleString()}.`,
      );
    let time = new Float64Array(CHUNK_SIZE);
    let columns = table.channels.map(() => new Float64Array(CHUNK_SIZE));
    let fill = 0;
    let rows = 0;
    let chunks = 0;
    let start = 0;
    let end = -Infinity;
    const chunkRanges: [number, number][] = [];
    let clock: TimeClock | undefined;
    let overview: IndexBuilder[] | undefined = [];
    const flush = async () => {
      if (!fill) return;
      // Full buffers are stored as they are; a partial one is copied, since
      // storing a view would clone its whole buffer.
      const full = fill === CHUNK_SIZE;
      const chunk = {
        time: full ? time : time.slice(0, fill),
        values: columns.map((column) =>
          full ? column : column.slice(0, fill),
        ),
      };
      chunkRanges.push([chunk.time[0], chunk.time[fill - 1]]);
      const groups = await this.writeChunk(id, chunks++, chunk);
      if (overview) {
        groups.forEach((blocks, c) =>
          (overview![c] ??= new IndexBuilder()).push(blocks),
        );
        if (
          overview.reduce((sum, builder) => sum + builder.bytes, 0) >
          INDEX_BUILD_BUDGET
        )
          overview = undefined;
      }
      time = new Float64Array(CHUNK_SIZE);
      columns = table.channels.map(() => new Float64Array(CHUNK_SIZE));
      fill = 0;
    };
    for await (const block of recording.read(index)) {
      this.check();
      const count = block.time.length;
      if (
        block.values.length !== width ||
        block.values.some((values) => values.length !== count)
      )
        throw new Error('The file reader returned columns of unequal length.');
      if (!rows && count) start = block.time[0];
      clock ??= block.clock;
      for (let r = 0; r < count;) {
        const take = Math.min(count - r, CHUNK_SIZE - fill);
        for (let k = r; k < r + take; k++) {
          const t = block.time[k];
          if (!(t > end) || !Number.isFinite(t))
            throw new Error(sampleTimeProblem(label, rows + k - r + 1, t, end));
          end = t;
          time[fill + k - r] = t;
        }
        for (let c = 0; c < width; c++) {
          const source = block.values[c];
          const target = columns[c];
          // Infinite readings are missing samples, as empty CSV cells are.
          for (let k = 0; k < take; k++) {
            const value = source[r + k];
            target[fill + k] = Number.isFinite(value) ? value : NaN;
          }
        }
        fill += take;
        rows += take;
        r += take;
        if (fill === CHUNK_SIZE) await flush();
      }
      report(rows, block.progress ?? 0);
      await yieldEngine();
    }
    await flush();
    if (rows < 2)
      throw new Error(
        `${label ? `${label}: ` : ''}A recording needs at least two data rows.`,
      );
    if (overview)
      for (const [c, builder] of overview.entries())
        await this.writeIndex([id, 0, indexKey(c)], builder.finish(rows));
    return { rows, chunks, start, end, chunkRanges, clock };
  }
}
