import { Envelope, power } from './signal-math';
import { openRecording } from './formats/index';
import { MAX_RECORDING_CHANNELS } from './formats/recording';
import type { RecordingFile } from './formats/recording';
import { SignalGraph } from './signal-graph';
import { timeNodes, workspaceTimeScope } from './time-model';
import { TIME_OPERATIONS, timeInputs } from './time-types';
import type { TimeSettings } from './time-types';
import {
  CHECKPOINT_FIELDS,
  CHECKPOINTED,
  executeSignal,
  type ExecutionOptions,
} from './signal-executor';
import { recipeKey } from './signal-recipe';
import { yieldEngine } from './engine-yield';
import { chunkWindow } from './signal-range';
import {
  blockCount,
  groupBlocks,
  IndexBuilder,
  LeafWriter,
  indexBytes,
  indexLeaves,
  indexSlices,
  readBlock,
  usableIndex,
  PLOT_LEAF_SIZE,
} from './plot-index';
import type { PlotBlocks, PlotIndex } from './plot-index';
import { FUNCTIONS } from './signal-functions';
import {
  ARITHMETIC_SYMBOLS,
  arithmeticUnit,
  isArithmetic,
  isBinaryOperation,
} from './signal-arithmetic';
import {
  boundValueIds,
  withValueInputs,
  withWorkflowHistory,
  WorkflowIndex,
} from './workflow-history';
import {
  isSegmentCrop,
  scopeSegments,
  segmentEntries,
  segmentWithin,
  signalSegment,
  visibleInput,
  type SegmentEntry,
} from './file-segments';
import { importError, sampleTimeProblem } from './csv-import-messages';
import {
  bestTable,
  bindChannels,
  createResolver,
  outputLabels,
  parseRef,
  parseWorkflow,
  recipeHash,
  stepCommand,
  stepRefs,
  type BindContext,
  type RecipeStep,
} from './workflow-recipe';
import {
  evaluateChecks,
  runStatus,
  validateChecks,
  type CheckOutput,
  type OutputStatistics,
} from './workflow-checks';
import {
  affectedOperations,
  describeChange,
  withoutOperations,
  savedCommand,
  remapProject,
} from './workflow-lifecycle';
import type { WorkflowCommand } from './workflow-lifecycle';
import { followRebuiltBatches, segmentOutputKeys } from './workflow-lifecycle';
import { APP_VERSION } from './app-version';
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
} from './workspace-archive';
import {
  statisticTime,
  statisticValue,
  valueParameters,
  valueSpec,
  valueTitle,
  valueUnit,
} from './workflow-types';
import { ValueAccumulator } from './value-statistics';
import { compileFormula } from './formula';
import { belowNyquist } from './signal-filters';
import { unitConversion } from './units';
import {
  BINDABLE_DERIVE,
  BINDABLE_VALUE,
  bindingValueIds,
  resolveBinding,
  resolveTriggerBindings,
  type BindingContext,
} from './value-bindings';
import type {
  CheckDefinition,
  RunFlag,
  ScalarValue,
  BoundValue,
  ParameterBindings,
  ValueOperation,
  ValueParameters,
  ValueStatistics,
  WorkflowRun,
  WorkflowStep,
} from './workflow-types';
import { EXAMPLES, exampleDefinition } from './signal-examples';
import {
  WORKFLOW_EXAMPLE,
  workflowExampleFile,
  buildExampleWorkflow,
} from './workflow-example';
import { restoreSegmentationOperations } from './segmentation-operation';
import {
  migrateRegionHistory,
  nextSequence,
  regionBindings,
  regionContains,
} from './region-model';
import { REGION_EXAMPLES } from './region-types';
import type {
  RegionSettings,
  RegionPlan,
  RegionSet,
  Region,
  FunctionSettings,
  FunctionRun,
} from './region-types';
import { CrossingDetector, validTriggerNoise } from './segmentation';
import type { TriggerEvent } from './segmentation';
import type {
  Chunk,
  DerivePreview,
  EdgeTrigger,
  FileSegment,
  FormulaSettings,
  Operation,
  Plot,
  Point,
  Project,
  Segment,
  SegmentationDefinition,
  SegmentationPlan,
  SegmentationScope,
  SegmentScope,
  SegmentSet,
  SeriesChunk,
  SignalNode,
  Source,
} from './signal-types';
import { randomId } from './random-id';

const CHUNK_SIZE = 16384;
// Index read cache. A packed root costs 104 bytes per 4,096 samples.
const INDEX_BUDGET = 32 * 1024 * 1024;
// Base blocks built in memory at once: all channels of an import, or one
// channel of a rebuild. 64 MiB covers 2.6 billion channel samples.
const INDEX_BUILD_BUDGET = 64 * 1024 * 1024;
const indexKey = (channel: number) => `plot-index-v2:${channel}`;
const leavesKey = (channel: number) => `plot-leaves-v2:${channel}`;
// Rebuildable artifacts of a derived signal, owned by its recipe key rather
// than a source: plot index (channel 0) and filter checkpoints.
const DERIVED = 'derived-v1:';
// Owners of every derived-cache version start with this; see pruning.
const DERIVED_ANY = 'derived-v';
const derivedOwner = (recipe: string) => `${DERIVED}${recipe}`;
const CHECKPOINTS_KEY = 'checkpoints-v1';
/**
 * Workspace schema version: the IndexedDB database version. Raise it whenever
 * a newer Stratum could store data an older one would misread, reject or drop
 * when rewriting, so older versions refuse the workspace instead
 * (docs/file-format-stability.md).
 */
export const WORKSPACE_SCHEMA_VERSION = 2;
export const NEWER_WORKSPACE_MESSAGE =
  'This workspace was saved by a newer version of Stratum. Update Stratum to open it; this version has not changed it.';
const CHECKPOINT_BUDGET = 16 * 1024 * 1024;
export const COLORS = ['#61d9b0', '#ac9cfa', '#edb477', '#74b9fa', '#e787ac'];
const emptyProject = (): Project => ({ sources: [], nodes: [], segments: [] });
const uid = () => randomId();
/** The sequence of a step appended now. */
const nextStepSequence = (project: Project) =>
  (project.workflowSteps ?? []).reduce(
    (max, item) => Math.max(max, item.sequence + 1),
    0,
  );
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
  async applyTimeOperation(settings: TimeSettings) {
    const original = this.project;
    const before = withWorkflowHistory(original);
    const snapshot = structuredClone(settings);
    const nodes = await timeNodes(
      before,
      snapshot,
      (id) => this.evaluate(id),
      () => this.check(),
    );
    const step = {
      id: randomId(),
      sourceId: '',
      sequence: (before.workflowSteps ?? []).reduce(
        (max, item) => Math.max(max, item.sequence + 1),
        0,
      ),
      createdAt: new Date().toISOString(),
      kind: 'derive' as const,
      operation: `time-${snapshot.kind}` as keyof typeof TIME_OPERATIONS,
      inputIds: timeInputs(snapshot),
      outputIds: nodes.map((node) => node.id),
      timeSettings: snapshot,
    };
    const next = {
      ...before,
      nodes: [...before.nodes, ...nodes],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    };
    try {
      this.project = next;
      this.invalidate();
      for (const node of nodes) {
        const plot = await this.plot(node.id);
        if (!plot.summary.count && snapshot.kind === 'crop')
          throw new Error(
            'A selected signal has no finite samples in this interval.',
          );
      }
    } finally {
      this.project = original;
      this.invalidate();
    }
    await this.save(next);
    return nodes;
  }
  project: Project = emptyProject();
  cancelled = false;
  private db!: IDBDatabase;
  private cache = new Map<string, Plot>();
  private sampleCounts = new Map<string, number>();
  private columnCache = new Map<string, Float64Array>();
  private cacheBytes = 0;
  private indexCache = new Map<
    string,
    { value: PlotIndex | PlotBlocks; bytes: number }
  >();
  private indexCacheBytes = 0;
  /** Filter checkpoints by recipe key; null records a confirmed absence. */
  private checkpointCache = new Map<string, Float64Array | null>();
  private checkpointBytes = 0;
  private revision = 0;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  /** Batch that owns the newest Undo entry, so its later items coalesce. */
  private journalTag?: string;
  /** What each Undo/Redo entry does, aligned with its stack; '' is unnamed. */
  private undoLabels: string[] = [];
  private redoLabels: string[] = [];
  private staging = false;
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  /** The action Undo reverses, or undefined when unnamed (older entries). */
  get undoLabel(): string | undefined {
    const target = this.undoStack.at(-1);
    if (!target) return undefined;
    // A coalesced batch entry grows with each item: describe it as it stands.
    if (this.journalTag) {
      const live = describeChange(target, this.project)?.label;
      if (live) return live;
    }
    return this.undoLabels.at(-1) || undefined;
  }
  get redoLabel(): string | undefined {
    if (!this.redoStack.length) return undefined;
    return this.redoLabels.at(-1) || undefined;
  }
  private invalidate() {
    this.cache.clear();
    this.extremaTimes.clear();
    this.columnCache.clear();
    this.cacheBytes = 0;
    this.indexCache.clear();
    this.indexCacheBytes = 0;
    this.checkpointCache.clear();
    this.checkpointBytes = 0;
    this.segmentPreviewCache = undefined;
    this.indexedProject = undefined;
    this.indexedGraph = undefined;
  }
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
      this.sampleCounts.clear();
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
    const request = indexedDB.open(this.databaseName, WORKSPACE_SCHEMA_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('chunks');
        request.result.createObjectStore('project');
      }
    };
    try {
      this.db = await result(request);
    } catch (error) {
      // The browser refuses to open a database at an older version.
      if ((error as { name?: unknown } | null)?.name === 'VersionError')
        throw new Error(NEWER_WORKSPACE_MESSAGE);
      throw error;
    }
    // Yield to a newer Stratum upgrading the schema rather than blocking it;
    // this window's later requests then fail and offer Reload.
    const db = this.db;
    db.onversionchange = () => db.close();
    const tx = this.db.transaction('project');
    const snapshot = tx.objectStore('project').get('current');
    const revision = tx.objectStore('project').get('revision');
    const journal = tx.objectStore('project').get('history');
    this.project =
      ((await result(snapshot)) as Project | undefined) ?? emptyProject();
    this.revision = Number(await result(revision)) || 0;
    const history = (await result(journal)) as
      | {
          undo: Project[];
          redo: Project[];
          tag?: string;
          undoLabels?: unknown;
          redoLabels?: unknown;
        }
      | undefined;
    this.undoStack = history?.undo ?? [];
    this.redoStack = history?.redo ?? [];
    this.journalTag = history?.tag;
    // Older journals have no labels; their entries read as "last change".
    const align = (labels: unknown, length: number) => {
      const list = Array.isArray(labels)
        ? labels.map((label) => (typeof label === 'string' ? label : ''))
        : [];
      return list.length >= length
        ? list.slice(list.length - length)
        : [...Array<string>(length - list.length).fill(''), ...list];
    };
    this.undoLabels = align(history?.undoLabels, this.undoStack.length);
    this.redoLabels = align(history?.redoLabels, this.redoStack.length);
    const restored = restoreSegmentationOperations(this.project);
    if (restored !== this.project)
      await this.save(restored, { undo: this.undoStack, redo: this.redoStack });
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
  /**
   * Commit a project. `batch` coalesces consecutive commits of one batch into a
   * single Undo entry; `null` clears that association (Undo/Redo). Explicit
   * housekeeping journals keep it and the entries' labels. `label` names a new
   * Undo entry; otherwise it is described from the change itself.
   */
  private async save(
    next: Project,
    history?: {
      undo: Project[];
      redo: Project[];
      undoLabels?: string[];
      redoLabels?: string[];
    },
    batch?: string | null,
    label?: string,
  ) {
    this.check();
    if (this.project.workflowSteps) next = withWorkflowHistory(next);
    if (this.staging) {
      this.project = next;
      this.invalidate();
      return;
    }
    // Later items of a batch reuse the batch's Undo entry and skip the journal write.
    const coalesce =
      !history &&
      !!batch &&
      this.journalTag === batch &&
      !this.redoStack.length;
    const journal = history
      ? {
          undo: history.undo,
          redo: history.redo,
          undoLabels: history.undoLabels ?? this.undoLabels,
          redoLabels: history.redoLabels ?? this.redoLabels,
        }
      : coalesce
        ? {
            undo: this.undoStack,
            redo: [],
            undoLabels: this.undoLabels,
            redoLabels: [],
          }
        : {
            undo: [...this.undoStack.slice(-19), this.project],
            redo: [],
            undoLabels: [
              ...this.undoLabels.slice(-19),
              label ?? describeChange(this.project, next)?.label ?? '',
            ],
            redoLabels: [],
          };
    const tag =
      batch === null
        ? undefined
        : (batch ?? (history ? this.journalTag : undefined));
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
      if (!coalesce) store.put({ ...journal, tag }, 'history');
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
    this.undoStack = journal.undo;
    this.redoStack = journal.redo;
    this.undoLabels = journal.undoLabels;
    this.redoLabels = journal.redoLabels;
    this.journalTag = tag;
    this.invalidate();
  }
  async travel(direction: 'undo' | 'redo') {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack;
    const target = stack.at(-1);
    if (!target) throw new Error(`Nothing to ${direction}.`);
    // The entry keeps its name as it moves between the Undo and Redo stacks.
    const label =
      (direction === 'undo' ? this.undoLabel : this.redoLabel) ?? '';
    await this.save(
      target,
      direction === 'undo'
        ? {
            undo: this.undoStack.slice(0, -1),
            redo: [...this.redoStack, this.project],
            undoLabels: this.undoLabels.slice(0, -1),
            redoLabels: [...this.redoLabels, label],
          }
        : {
            undo: [...this.undoStack, this.project],
            redo: this.redoStack.slice(0, -1),
            undoLabels: [...this.undoLabels, label],
            redoLabels: this.redoLabels.slice(0, -1),
          },
      null,
    );
  }
  async deleteOperation(stepId: string) {
    await this.save(
      withoutOperations(this.project, affectedOperations(this.project, stepId)),
    );
  }
  async rename(id: string, name: string) {
    name = name.trim();
    if (!name || name.length > 160)
      throw new Error('Enter a name between 1 and 160 characters.');
    if (this.project.sources.some((source) => source.id === id))
      return this.save({
        ...this.project,
        sources: this.project.sources.map((source) =>
          source.id === id ? { ...source, name } : source,
        ),
      });
    if (this.project.workflowSteps?.some((step) => step.id === id))
      return this.save({
        ...this.project,
        workflowSteps: this.project.workflowSteps.map((step) =>
          step.id === id ? { ...step, name } : step,
        ),
      });
    if (
      !this.project.nodes.some((node) => node.id === id && !node.internal) &&
      !this.project.values?.some((value) => value.id === id) &&
      !this.project.segmentSets?.some((set) =>
        set.segments.some((segment) => segment.id === id),
      )
    )
      throw new Error('That output no longer exists.');
    await this.save({
      ...this.project,
      labels: { ...this.project.labels, [id]: name },
    });
  }
  /** The committed metadata revision, which changes with every save. */
  get savedRevision() {
    return this.revision;
  }
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
  private async applyCommand(command: WorkflowCommand) {
    switch (command.type) {
      case 'time-operation':
        await this.applyTimeOperation(command.settings);
        break;
      case 'derive-many':
        await this.deriveMany(
          command.parentIds,
          command.operation,
          command.parameter,
          true,
          command.bindings,
          {
            ...(command.unit !== undefined ? { unit: command.unit } : {}),
            ...(command.formula ? { formula: command.formula } : {}),
            ...(command.within ? { within: command.within } : {}),
          },
        );
        break;
      case 'calculate-values':
        await this.calculateValues(
          command.inputIds,
          command.operation,
          command.parameters,
          command.bindings,
          command.within,
        );
        break;
      case 'segment-set':
        await this.segmentSet(
          command.sourceId,
          command.definition,
          command.referenceId,
          command.within,
        );
        break;
      case 'segment':
        await this.segment(
          command.sourceId,
          command.definition,
          command.targetIds,
          command.independently,
          command.scope,
        );
        break;
      case 'region-function':
        await this.applyRegionFunction(command.settings);
        break;
    }
  }
  async editOperation(stepId: string, command: WorkflowCommand) {
    const before = this.project;
    const affected = affectedOperations(before, stepId);
    if (
      affected[0]?.id !== stepId ||
      ['import', 'regions'].includes(affected[0].kind)
    )
      throw new Error('This operation cannot be edited with signal settings.');
    let next: Project;
    this.staging = true;
    // Rebuilt outputs, so later steps that used a whole batch follow it.
    const rebuilt: { old: string[]; now: string[] }[] = [];
    try {
      this.project = withoutOperations(before, affected);
      this.invalidate();
      for (const old of affected) {
        this.check();
        const prior = new Set(
          this.project.workflowSteps?.map((step) => step.id),
        );
        await this.applyCommand(
          old.id === stepId
            ? command
            : followRebuiltBatches(savedCommand(before, old), rebuilt),
        );
        const added =
          this.project.workflowSteps?.filter((step) => !prior.has(step.id)) ??
          [];
        if (added.length !== 1)
          throw new Error(
            'This legacy operation cannot be rebuilt as one atomic step. Existing work is unchanged.',
          );
        const generated = added[0];
        // Segments and outputs within segments match by what they are (the
        // segment's place, or input and segment), so their count may change.
        const oldKeys = segmentOutputKeys(before, old);
        const newKeys = segmentOutputKeys(this.project, generated);
        if (
          (!oldKeys || !newKeys) &&
          generated.outputIds.length !== old.outputIds.length &&
          affected.length > 1
        )
          throw new Error(
            'The new settings change the number of outputs used by later operations. Remove or revise those dependent operations first. Existing work is unchanged.',
          );
        const mapping = new Map<string, string>([[generated.id, old.id]]);
        if (oldKeys && newKeys) {
          const byKey = new Map(
            old.outputIds.map((id, position) => [oldKeys[position], id]),
          );
          generated.outputIds.forEach((id, position) => {
            const match = byKey.get(newKeys[position]);
            if (match) mapping.set(id, match);
          });
        } else if (generated.outputIds.length === old.outputIds.length)
          generated.outputIds.forEach((id, position) =>
            mapping.set(id, old.outputIds[position]),
          );
        if (generated.segmentationId && old.segmentationId)
          mapping.set(generated.segmentationId, old.segmentationId);
        if (generated.segmentSetId && old.segmentSetId)
          mapping.set(generated.segmentSetId, old.segmentSetId);
        rebuilt.push({
          old: old.outputIds,
          now: generated.outputIds.map((id) => mapping.get(id) ?? id),
        });
        this.project = remapProject(this.project, mapping);
        this.project = {
          ...this.project,
          workflowSteps: this.project
            .workflowSteps!.map((step) =>
              step.id === old.id
                ? {
                    ...step,
                    sequence: old.sequence,
                    createdAt: old.createdAt,
                    name: old.name,
                    revision: (old.revision ?? 1) + 1,
                    updatedAt: new Date().toISOString(),
                    // Checks and batch membership belong to the operation, not its settings.
                    ...(old.checks ? { checks: old.checks } : {}),
                    ...(old.runId ? { runId: old.runId } : {}),
                    ...(old.recipeStepId
                      ? { recipeStepId: old.recipeStepId }
                      : {}),
                  }
                : step,
            )
            .sort((a, b) => a.sequence - b.sequence),
        };
        this.invalidate();
      }
      // A step may only use values calculated before it: History, backups
      // and workflow files are chronological.
      const sequences = new Map(
        this.project.workflowSteps!.flatMap((step) =>
          step.outputIds.map((id) => [id, step.sequence] as const),
        ),
      );
      for (const step of this.project.workflowSteps ?? [])
        if (
          affected.some((item) => item.id === step.id) &&
          step.valueInputIds?.some(
            (id) => (sequences.get(id) ?? Infinity) >= step.sequence,
          )
        )
          throw new Error(
            'A step can only use values calculated before it. Choose an earlier value, or create a new step instead. Existing work is unchanged.',
          );
      // Build every affected signal before commit so bad recipes never publish.
      const affectedIds = new Set(affected.map((step) => step.id));
      const signalIds = new Set(this.project.nodes.map((node) => node.id));
      for (const step of this.project.workflowSteps ?? [])
        if (affectedIds.has(step.id))
          for (const id of step.outputIds)
            if (signalIds.has(id)) await this.plot(id);
      for (const step of this.project.workflowSteps ?? [])
        if (affectedIds.has(step.id) && step.checks?.length)
          await this.save(await this.withCheckResults(step));
      next = this.project;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    await this.save(next);
  }
  /** Exact sample statistics from the evaluated signal, never a plot preview. */
  async outputStatistics(id: string): Promise<OutputStatistics> {
    let samples = 0,
      finite = 0,
      min = Infinity,
      max = -Infinity;
    for await (const chunk of this.evaluate(id)) {
      this.check();
      samples += chunk.time.length;
      for (const value of chunk.values)
        if (Number.isFinite(value)) {
          finite++;
          if (value < min) min = value;
          if (value > max) max = value;
        }
    }
    const [start, end] = this.bounds(id);
    return {
      samples,
      finite,
      min: finite ? min : null,
      max: finite ? max : null,
      start,
      end,
    };
  }
  private async checkOutputs(
    step: WorkflowStep,
    statistics = new Map<string, OutputStatistics>(),
  ): Promise<CheckOutput[]> {
    const index = new WorkflowIndex(this.project);
    const outputs: CheckOutput[] = [];
    for (const id of step.outputIds) {
      this.check();
      const value = index.values.get(id);
      if (value) {
        outputs.push({
          id,
          label: index.label(id),
          unit: value.unit,
          value: value.value,
        });
        continue;
      }
      // A file segment is a time interval: its duration, never samples.
      const segment = index.segments.get(id)?.segment;
      if (segment) {
        outputs.push({
          id,
          label: index.label(id),
          unit: 's',
          interval: { start: segment.start, end: segment.end },
        });
        continue;
      }
      const node = this.find(id);
      let stats = statistics.get(id);
      if (!stats) {
        stats = await this.outputStatistics(id);
        statistics.set(id, stats);
      }
      outputs.push({
        id,
        label: index.label(id),
        unit: node.unit,
        statistics: stats,
      });
    }
    return outputs;
  }
  /** The project with this step's checks evaluated for its current revision. */
  private async withCheckResults(
    step: WorkflowStep,
    statistics?: Map<string, OutputStatistics>,
  ): Promise<Project> {
    // Segment steps take count and duration checks only.
    if (step.segmentSetId && step.checks?.length)
      validateChecks(step.checks, 'segments');
    const results = step.checks?.length
      ? evaluateChecks(step.checks, await this.checkOutputs(step, statistics))
      : undefined;
    return {
      ...this.project,
      workflowSteps: this.project.workflowSteps!.map((item) => {
        if (item.id !== step.id) return item;
        const { checkResults: _old, ...rest } = item;
        void _old;
        return results
          ? { ...rest, checkResults: { revision: item.revision ?? 1, results } }
          : rest;
      }),
    };
  }
  /** Replace a step's checks and evaluate them. Undoable like a rename. */
  async setChecks(stepId: string, checks: CheckDefinition[]) {
    const step = this.project.workflowSteps?.find((item) => item.id === stepId);
    if (!step) throw new Error('This operation no longer exists.');
    if (step.kind === 'import' || step.kind === 'regions')
      throw new Error('Add checks to a derived, segment or value operation.');
    const valid = validateChecks(
      checks,
      step.kind === 'value' ? 'values' : 'signals',
    );
    const before = this.project;
    let next: Project;
    this.staging = true;
    try {
      const updated = {
        ...step,
        ...(valid.length ? { checks: valid } : {}),
      };
      if (!valid.length) delete updated.checks;
      await this.save({
        ...this.project,
        workflowSteps: this.project.workflowSteps!.map((item) =>
          item.id === stepId ? updated : item,
        ),
      });
      next = await this.withCheckResults(updated);
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    await this.save(next);
  }
  /**
   * Import one file (or use an existing recording), replay a workflow on it and
   * evaluate its checks. Everything for the item publishes in one commit; later
   * items of the same batch share one Undo entry.
   */
  async runWorkflow(options: {
    recipe: string;
    batchId: string;
    batchName: string;
    itemId: string;
    file?: File;
    /** The group of a multi-group file; the best-matching one by default. */
    table?: number;
    sourceId?: string;
    /** Pre-flight column choices for missing channels: alias → column. */
    channelMap?: Record<string, string>;
  }): Promise<WorkflowRun> {
    const recipe = parseWorkflow(options.recipe);
    // Keep only string choices for this recipe's channels; recorded with the run.
    const channelMap: Record<string, string> = {};
    for (const channel of recipe.channels) {
      const column = options.channelMap?.[channel.alias];
      if (typeof column === 'string' && column.trim())
        channelMap[channel.alias] = column.trim().slice(0, 255);
    }
    const hash = await recipeHash(recipe);
    const itemId = options.itemId.trim().slice(0, 120);
    if (!itemId) throw new Error('Enter an item ID.');
    const startedAt = new Date().toISOString();
    const before = this.project;
    let imported: Source | undefined;
    let next: Project;
    let run: WorkflowRun;
    this.staging = true;
    try {
      await this.initializeWorkflow();
      let source: Source | undefined;
      if (options.file)
        source = imported = (
          await this.importRecording(options.file, {
            choose: (recording) => [
              recording.tables[options.table ?? -1]
                ? options.table!
                : bestTable(recipe, recording.tables, channelMap),
            ],
          })
        )[0];
      else
        source = this.project.sources.find(
          (item) => item.id === options.sourceId,
        );
      if (!source) throw new Error('Choose a recording or file to process.');
      const runId = uid();
      const flags: RunFlag[] = [];
      const stepMap: Record<string, string> = {};
      const aliases = new Map<string, string>();
      for (const binding of bindChannels(
        recipe,
        source.channels.map((id) => this.find(id)),
        channelMap,
      )) {
        if (binding.problem)
          flags.push({ severity: 'error', message: binding.problem });
        else aliases.set(binding.alias, source.channels[binding.channel]);
      }
      const outputs = new Map<string, string[]>();
      const resolve = createResolver(aliases, outputs);
      // Unavailable channel or step → the root cause it traces back to.
      const unavailable = new Map(
        recipe.channels
          .filter((channel) => !aliases.has(channel.alias))
          .map((channel) => [channel.alias, channel.alias]),
      );
      const skippedBy = new Map<string, string[]>();
      const context: BindContext = {
        resolve,
        sourceOf: (id) => this.find(id).sourceId,
        sourceId: source.id,
        segmentSet: (id) => {
          const set = segmentEntries(this.project).get(id)?.set;
          if (!set) throw new Error('These segments no longer exist.');
          return { id: set.id, sourceId: set.sourceId };
        },
        clockStart: (id) => this.bounds(id)[0] - this.axisOffset(id),
        recordingStart: source.start,
        newId: uid,
      };
      // A newly imported item is named after it, so History reads per item.
      const importStep = `import:${source.id}`;
      await this.save({
        ...this.project,
        workflowSteps: this.project.workflowSteps!.map((step) =>
          step.id === importStep && !step.runId
            ? {
                ...step,
                runId,
                ...(imported && !step.name
                  ? { name: `${recipe.item.label} ${itemId}`.slice(0, 160) }
                  : {}),
              }
            : step,
        ),
      });
      let stoppedAt: string | undefined;
      const label = (step: RecipeStep) => step.name ?? step.id;
      for (const step of recipe.steps) {
        this.check();
        if (stoppedAt) {
          unavailable.set(step.id, stoppedAt);
          continue;
        }
        const missing = stepRefs(step)
          .map((ref) => parseRef(ref).name)
          .find((name) => unavailable.has(name));
        if (missing) {
          const root = unavailable.get(missing)!;
          unavailable.set(step.id, root);
          skippedBy.set(root, [...(skippedBy.get(root) ?? []), label(step)]);
          continue;
        }
        const prior = new Set(
          this.project.workflowSteps!.map((item) => item.id),
        );
        try {
          await this.applyCommand(stepCommand(step, context));
        } catch (error) {
          if (this.cancelled) throw error;
          unavailable.set(step.id, step.id);
          flags.push({
            severity: 'error',
            recipeStepId: step.id,
            message: `“${label(step)}” could not run: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
          continue;
        }
        const added = this.project.workflowSteps!.filter(
          (item) => !prior.has(item.id),
        );
        if (added.length !== 1)
          throw new Error(
            'A workflow step did not produce exactly one operation.',
          );
        const created = added[0];
        outputs.set(step.id, created.outputIds);
        stepMap[step.id] = created.id;
        const index = new WorkflowIndex(this.project);
        // `{input}` names the signal chosen (never a hidden segment crop);
        // `{segment}` the segment an output was made within.
        const names = outputLabels(
          step,
          created.outputIds.length,
          itemId,
          (position) => {
            const id = created.outputIds[position];
            const node = index.nodes.get(id);
            const parent = node
              ? node.parents[0] && visibleInput(index.nodes, node.parents[0])
              : index.values.get(id)?.inputId;
            return parent ? index.label(parent) : '';
          },
          (position) => {
            const id = created.outputIds[position];
            const segment =
              index.nodes.get(id)?.segmentId ??
              index.values.get(id)?.segmentId ??
              index.segments.get(id)?.segment.parentId;
            return segment ? index.segmentLabel(segment) : '';
          },
        );
        const tagged: WorkflowStep = {
          ...created,
          runId,
          recipeStepId: step.id,
          ...(step.name ? { name: step.name } : {}),
          ...(step.checks?.length
            ? { checks: structuredClone(step.checks) }
            : {}),
        };
        const labels = { ...this.project.labels };
        names.forEach((name, position) => {
          if (name) labels[created.outputIds[position]] = name;
        });
        await this.save({
          ...this.project,
          labels,
          workflowSteps: this.project.workflowSteps!.map((item) =>
            item.id === created.id ? tagged : item,
          ),
        });
        // Evaluate every signal once: checks use the exact statistics, and a
        // recipe that cannot evaluate is reported now rather than on first plot.
        const statistics = new Map<string, OutputStatistics>();
        try {
          for (const id of created.outputIds.slice(0, 1000))
            if (index.nodes.has(id)) {
              const stats = await this.outputStatistics(id);
              statistics.set(id, stats);
              if (!stats.finite)
                flags.push({
                  severity: 'warning',
                  recipeStepId: step.id,
                  message: `${labels[id] ?? index.label(id)} has no finite samples.`,
                });
            }
        } catch (error) {
          if (this.cancelled) throw error;
          flags.push({
            severity: 'error',
            recipeStepId: step.id,
            message: `“${label(step)}” could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
        }
        if (tagged.checks) {
          await this.save(await this.withCheckResults(tagged, statistics));
          const results =
            this.project.workflowSteps!.find((item) => item.id === created.id)
              ?.checkResults?.results ?? [];
          if (
            step.onFail === 'stop' &&
            results.some((result) => result.status === 'fail')
          )
            stoppedAt = step.id;
        }
      }
      // One flag per root cause rather than one per dependent step.
      for (const [root, skipped] of skippedBy) {
        const channel = recipe.channels.find((item) => item.alias === root);
        const step = recipe.steps.find((item) => item.id === root);
        flags.push({
          severity: 'error',
          recipeStepId: step?.id,
          message: `Skipped ${skipped.length} ${skipped.length === 1 ? 'step' : 'steps'} that need “${channel?.name ?? (step ? label(step) : root)}”: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}.`,
        });
      }
      if (stoppedAt) {
        const remaining =
          recipe.steps.length -
          1 -
          recipe.steps.findIndex((step) => step.id === stoppedAt);
        if (remaining > 0)
          flags.push({
            severity: 'warning',
            recipeStepId: stoppedAt,
            message: `Stopped after a failed check in “${label(recipe.steps.find((step) => step.id === stoppedAt)!)}”; ${remaining} later ${remaining === 1 ? 'step was' : 'steps were'} skipped.`,
          });
      }
      const steps = new Map(
        this.project.workflowSteps!.map((step) => [step.id, step]),
      );
      run = {
        id: runId,
        batchId: options.batchId,
        itemId,
        fileName: options.file?.name ?? source.name,
        sourceId: source.id,
        status: runStatus(
          flags,
          Object.values(stepMap).map((id) => steps.get(id)),
        ),
        steps: stepMap,
        flags,
        ...(Object.keys(channelMap).length ? { channelMap } : {}),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      const batches = this.project.workflowBatches ?? [];
      const existing = batches.find((batch) => batch.id === options.batchId);
      if (existing && existing.recipeHash !== hash)
        throw new Error(
          'Every item in a batch must use the same workflow revision.',
        );
      next = {
        ...this.project,
        workflowRecipes: [
          ...(this.project.workflowRecipes ?? []).filter(
            (item) => item.hash !== hash,
          ),
          {
            hash,
            name: recipe.name,
            ...(recipe.revision ? { revision: recipe.revision } : {}),
            text: options.recipe,
          },
        ],
        workflowBatches: existing
          ? batches.map((batch) =>
              batch.id === existing.id
                ? { ...batch, runs: [...batch.runs, run] }
                : batch,
            )
          : [
              ...batches,
              {
                id: options.batchId,
                name: options.batchName.trim().slice(0, 160) || recipe.name,
                recipeHash: hash,
                createdAt: startedAt,
                state: 'running',
                runs: [run],
              },
            ],
      };
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    try {
      await this.save(next, undefined, options.batchId);
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    }
    if (imported) await this.trackImport(imported.id, false).catch(() => {});
    return run;
  }
  /** Mark a batch complete or cancelled, within the batch's Undo entry. */
  async finishBatch(
    batchId: string,
    state: 'complete' | 'cancelled',
    failures: { name: string; message: string }[] = [],
  ) {
    const batch = this.project.workflowBatches?.find(
      (item) => item.id === batchId,
    );
    if (!batch || (batch.state === state && !failures.length)) return;
    const recorded = failures.slice(0, 500).map((failure) => ({
      name: String(failure.name).slice(0, 255),
      message: String(failure.message).slice(0, 500),
    }));
    await this.save(
      {
        ...this.project,
        workflowBatches: this.project.workflowBatches!.map((item) =>
          item.id === batchId
            ? {
                ...item,
                state,
                ...(recorded.length
                  ? { failures: [...(item.failures ?? []), ...recorded] }
                  : {}),
              }
            : item,
        ),
      },
      undefined,
      batchId,
    );
  }
  private async writeChunk(sourceId: string, index: number, chunk: Chunk) {
    this.check();
    const leaves = chunk.values.map((values) =>
      indexLeaves({ time: chunk.time, values }),
    );
    const tx = this.db.transaction('chunks', 'readwrite');
    const done = complete(tx);
    tx.objectStore('chunks').add(chunk.time, [sourceId, index, 'time']);
    chunk.values.forEach((column, c) =>
      tx.objectStore('chunks').add(column, [sourceId, index, c]),
    );
    leaves.forEach((blocks, c) =>
      tx.objectStore('chunks').add(blocks, [sourceId, index, leavesKey(c)]),
    );
    await done;
    return leaves.map(groupBlocks);
  }
  private async readIndex<T extends PlotIndex | PlotBlocks>(
    key: IDBValidKey,
  ): Promise<T | undefined> {
    const cacheKey = JSON.stringify(key);
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      this.indexCache.delete(cacheKey);
      this.indexCache.set(cacheKey, cached);
      return cached.value as T;
    }
    const value = (await result(
      this.db.transaction('chunks').objectStore('chunks').get(key),
    )) as T | undefined;
    if (!value) return;
    const bytes = indexBytes(value);
    if (bytes <= INDEX_BUDGET) {
      while (
        this.indexCacheBytes + bytes > INDEX_BUDGET &&
        this.indexCache.size
      ) {
        const first = this.indexCache.keys().next().value!;
        this.indexCacheBytes -= this.indexCache.get(first)!.bytes;
        this.indexCache.delete(first);
      }
      this.indexCache.set(cacheKey, { value, bytes });
      this.indexCacheBytes += bytes;
    }
    return value;
  }
  private async writeIndex(
    key: [string, number, string],
    value: PlotIndex | PlotBlocks,
  ) {
    this.check();
    const tx = this.db.transaction('chunks', 'readwrite'),
      done = complete(tx);
    tx.objectStore('chunks').put(value, key);
    // A rebuilt entry replaces its unreadable previous-format counterpart.
    tx.objectStore('chunks').delete([
      key[0],
      key[1],
      key[2].replace(/-v\d+:/, '-v1:'),
    ]);
    await done;
    const cacheKey = JSON.stringify(key);
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      this.indexCacheBytes -= cached.bytes;
      this.indexCache.delete(cacheKey);
    }
  }
  private async deleteIndex(key: [string, number, string]) {
    const tx = this.db.transaction('chunks', 'readwrite'),
      done = complete(tx);
    tx.objectStore('chunks').delete(key);
    await done;
    const cacheKey = JSON.stringify(key);
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      this.indexCacheBytes -= cached.bytes;
      this.indexCache.delete(cacheKey);
    }
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
  private async trackImport(sourceId: string, active: boolean) {
    const tx = this.db.transaction('project', 'readwrite'),
      done = complete(tx);
    const store = tx.objectStore('project');
    if (active) store.put(true, ['pending-import', sourceId]);
    else store.delete(['pending-import', sourceId]);
    await done;
  }
  /** Caller must hold the shared workspace writer lock. Legacy unknown chunks are untouched. */
  async recoverImports() {
    const keys = await result(
      this.db.transaction('project').objectStore('project').getAllKeys(),
    );
    const published = new Set(
      [this.project, ...this.undoStack, ...this.redoStack].flatMap((project) =>
        project.sources.map((source) => source.id),
      ),
    );
    for (const key of keys)
      if (
        Array.isArray(key) &&
        key[0] === 'pending-import' &&
        typeof key[1] === 'string'
      ) {
        if (!published.has(key[1])) await this.removeIncomplete(key[1]);
        await this.trackImport(key[1], false);
      }
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
  /** Imports a CSV or any other supported file; returns its first recording. */
  async importCsv(file: Blob & { name?: string }, synthetic = false) {
    return (await this.importRecording(file, { synthetic }))[0];
  }
  /**
   * Imports the chosen tables of a recording file (all by default) as one
   * recording each. Every table publishes in one commit and one Undo entry.
   */
  async importRecording(
    file: Blob & { name?: string },
    options: {
      tables?: number[];
      synthetic?: boolean;
      /** Picks tables once the file's metadata is known (batch runs). */
      choose?: (recording: RecordingFile) => number[];
    } = {},
  ): Promise<Source[]> {
    this.cancelled = false;
    const fileName = file.name || 'Generated signal.csv';
    const ids: string[] = [];
    try {
      const recording = await openRecording(file);
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
      const sources: Source[] = [];
      const nodes: SignalNode[] = [];
      for (const [position, index] of tables.entries()) {
        const id = uid();
        ids.push(id);
        await this.trackImport(id, true);
        const table = recording.tables[index];
        const grouped = recording.tables.length > 1 && !!table.name;
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
        const channels = table.channels.map((channel, c) =>
          this.node(id, channel.name, channel.unit, 'raw', [], {}, c),
        );
        nodes.push(...channels);
        sources.push({
          id,
          name: grouped ? `${fileName} · ${table.name}` : fileName,
          ...written,
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
    return { rows, chunks, start, end, chunkRanges };
  }
  async workflowExample(refresh = false, sourceId?: string) {
    const existing = sourceId
      ? this.project.sources.find((source) => source.id === sourceId)
      : (this.project.sources.find(
          (source) => source.exampleKey === WORKFLOW_EXAMPLE,
        ) ?? this.project.sources.find((source) => source.synthetic));
    if ((sourceId && !existing) || (existing && !existing.synthetic))
      throw new Error('Only a built-in example can be refreshed.');
    if (!refresh && existing?.exampleKey === WORKFLOW_EXAMPLE) return existing;
    const before = this.project;
    let imported: Source | undefined;
    let next: Project;
    this.staging = true;
    try {
      await this.initializeWorkflow();
      // Opening an example never replaces saved work. Replacement is explicit.
      if (refresh && existing)
        await this.deleteOperation(`import:${existing.id}`);
      imported = await this.importCsv(workflowExampleFile(), true);
      const source = { ...imported, exampleKey: WORKFLOW_EXAMPLE };
      await this.save({
        ...this.project,
        sources: [
          source,
          ...this.project.sources.filter((item) => item.id !== source.id),
        ],
      });
      await buildExampleWorkflow(this, source);
      next = this.project;
    } catch (error) {
      if (imported) {
        await this.removeIncomplete(imported.id);
        await this.trackImport(imported.id, false);
      }
      throw error;
    } finally {
      this.staging = false;
      this.project = before;
      this.invalidate();
    }
    try {
      await this.save(
        next,
        undefined,
        undefined,
        refresh && existing
          ? 'Refresh example recording'
          : 'Open example recording',
      );
    } catch (error) {
      await this.removeIncomplete(imported.id);
      await this.trackImport(imported.id, false);
      throw error;
    }
    await this.trackImport(imported.id, false).catch(() => {});
    return this.project.sources.find((source) => source.id === imported.id)!;
  }
  async demo(withAnalysis = true) {
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
    if (!withAnalysis) return source;
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
  async example(key: string) {
    const spec = EXAMPLES.find((item) => item.key === key);
    if (!spec) throw new Error('Choose an available example.');
    const existing = this.project.examples?.find((item) => item.key === key);
    if (existing) return existing;
    // All examples share the small immutable demo recording. Only recipes are
    // added; reopening an example never duplicates its data or operation tree.
    const source = await this.demo();
    const input = spec.chain
      ? (await this.derive(source.channels[0], 'median', 5)).id
      : source.channels[0];
    const segments = await this.segment(
      source.id,
      exampleDefinition(key, input),
      spec.chain ? [input] : source.channels,
      false,
      spec.chain ? 'signals' : 'file',
    );
    let outputIds = segments.map((segment) => segment.nodes[0]);
    if (spec.chain) {
      const averages = await this.deriveMany(outputIds, 'smooth', 25);
      const extrema = await this.deriveMany(
        averages.map((node) => node.id),
        'min-max',
        0,
      );
      outputIds = extrema.map((node) => node.id);
    }
    const run = {
      key,
      sourceId: source.id,
      segmentationId: segments[0].batchId!,
      outputIds,
    };
    await this.save({
      ...this.project,
      examples: [...(this.project.examples ?? []), run],
    });
    return run;
  }
  async initializeRegions() {
    const migrated = migrateRegionHistory(this.project);
    if (migrated !== this.project)
      await this.save(migrated, { undo: this.undoStack, redo: this.redoStack });
  }
  async initializeWorkflow() {
    const next = withWorkflowHistory(this.project);
    if (next !== this.project)
      await this.save(next, { undo: this.undoStack, redo: this.redoStack });
    else if (!this.project.workflowSteps)
      await this.save(
        { ...this.project, workflowSteps: [] },
        { undo: this.undoStack, redo: this.redoStack },
      );
  }
  async calculateValues(
    inputIds: string[],
    operation: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    within?: SegmentScope,
  ) {
    const spec = valueSpec(operation);
    if (!spec) throw new Error('Choose a supported value calculation.');
    this.checkBindings(bindings, spec.parameters ?? [], spec.name);
    if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
      throw new Error('Choose at least one unique signal.');
    if (inputIds.length > 10000)
      throw new Error('Limit a calculation to 10,000 signals.');
    if (within) {
      const before = this.project;
      const { values, segments } = await this.valuesWithin(
        within,
        inputIds,
        operation,
        parameters,
        bindings,
      );
      if (!values.length)
        throw new Error(
          'The selected signals have no samples inside these segments.',
        );
      if (values.length > 10000)
        throw new Error('Limit a calculation to 10,000 values.');
      const step: WorkflowStep = {
        id: uid(),
        sourceId: values[0].sourceId,
        sequence: nextStepSequence(before),
        createdAt: values[0].createdAt,
        kind: 'value',
        operation,
        inputIds: [...new Set(values.map((value) => value.inputId))],
        outputIds: values.map((value) => value.id),
        ...withValueInputs(boundValueIds(values)),
        ...(values[0].parameters
          ? { parameters: { ...values[0].parameters } }
          : {}),
        within: structuredClone(within),
        segmentInputIds: segments.map((segment) => segment.id),
      };
      await this.save({
        ...before,
        values: [...(before.values ?? []), ...values],
        workflowSteps: [...(before.workflowSteps ?? []), step],
      });
      return values;
    }
    const inputs = inputIds.map((id) => this.find(id));
    const mixedSources =
      new Set(inputs.map((node) => node.sourceId)).size !== 1;
    const batchId = uid(),
      createdAt = new Date().toISOString();
    const values: ScalarValue[] = [];
    for (const [index, input] of inputs.entries()) {
      this.check();
      this.progress(
        `Calculating ${spec.name.toLowerCase()} · ${index + 1}/${inputs.length}`,
        index / inputs.length,
      );
      const { parameters: settings, bound } = this.boundValueSettings(
        operation,
        parameters,
        bindings,
        input,
      );
      const statistics = await this.valueStatistics(
        input.id,
        operation,
        settings,
      );
      const [start, end] = this.bounds(input.id);
      const timestamp = statisticTime(statistics, operation);
      const segmentId = signalSegment(this.graph().nodes, input.id);
      values.push({
        ...(segmentId ? { segmentId } : {}),
        id: uid(),
        sourceId: mixedSources ? '' : input.sourceId,
        inputId: input.id,
        batchId,
        name: `${input.name} · ${valueTitle(operation, settings, input.unit)}`,
        unit: valueUnit(operation, input.unit),
        operation,
        ...(spec.parameters?.length ? { parameters: settings } : {}),
        ...(bound ? { bindings: bound } : {}),
        value: statisticValue(statistics, operation),
        sampleCount: statistics.sampleCount,
        validDuration: statistics.validDuration,
        start,
        end,
        createdAt,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(operation === 'time-of-minimum' && statistics.minimum !== null
          ? { level: statistics.minimum }
          : operation === 'time-of-maximum' && statistics.maximum !== null
            ? { level: statistics.maximum }
            : {}),
      });
    }
    await this.save({
      ...this.project,
      values: [...(this.project.values ?? []), ...values],
    });
    return values;
  }
  /**
   * Exact statistics for every value calculation, from every finite sample,
   * with the result of `operation` when it takes settings.
   */
  async valueStatistics(
    id: string,
    operation?: ValueOperation,
    parameters?: ValueParameters,
  ): Promise<ValueStatistics> {
    const [start, end] = this.bounds(id);
    const accumulator = new ValueAccumulator(
      id,
      start,
      end,
      operation,
      parameters,
    );
    // A segment crop reads only its window of the input.
    const window: [number, number] | undefined = isSegmentCrop(this.find(id))
      ? [start, end]
      : undefined;
    for await (const chunk of this.evaluate(id, undefined, window)) {
      this.check();
      for (let i = 0; i < chunk.time.length; i++)
        accumulator.add(chunk.time[i], chunk.values[i]);
    }
    return accumulator.finish();
  }
  /** Value statistics for a dialog preview; nothing is saved. */
  async previewValues(
    ids: string[],
    operation?: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    within?: SegmentScope,
  ): Promise<ValueStatistics[]> {
    if (ids.length > 50) throw new Error('Preview up to 50 signals at once.');
    const spec = operation ? valueSpec(operation) : undefined;
    if (spec) this.checkBindings(bindings, spec.parameters ?? [], spec.name);
    // Within segments: the first 50 input and segment pairs.
    if (within)
      return (
        await this.valuesWithin(
          within,
          [...new Set(ids)],
          spec?.operation ?? 'time-average',
          parameters,
          bindings,
          true,
        )
      ).statistics;
    const statistics: ValueStatistics[] = [];
    for (const id of new Set(ids)) {
      this.check();
      statistics.push(
        spec?.parameters?.length
          ? await this.valueStatistics(
              id,
              spec.operation,
              this.boundValueSettings(
                spec.operation,
                parameters,
                bindings,
                this.find(id),
              ).parameters,
            )
          : await this.valueStatistics(id),
      );
    }
    return statistics;
  }
  /** Lookups and names for resolving settings taken from values. */
  private bindingContext(): BindingContext {
    const values = new Map(
      (this.project.values ?? []).map((value) => [value.id, value]),
    );
    const nodes = new Map(this.project.nodes.map((node) => [node.id, node]));
    return {
      values,
      nodes,
      label: (id) =>
        this.project.labels?.[id] ??
        values.get(id)?.name ??
        nodes.get(id)?.name ??
        'this input',
    };
  }
  /** Bindings may only name settings that accept values. */
  private checkBindings(
    bindings: ParameterBindings | undefined,
    allowed: readonly string[],
    name: string,
  ) {
    for (const key of Object.keys(bindings ?? {}))
      if (!allowed.includes(key) || !BINDABLE_VALUE[key])
        throw new Error(`${name} cannot take its ${key} from a value.`);
  }
  /** A value calculation's settings for one input, with bound values. */
  private boundValueSettings(
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
  async previewRegions(settings: RegionSettings): Promise<RegionPlan> {
    this.check();
    const source = this.project.sources.find(
      (item) => item.id === settings.sourceId,
    );
    if (!source) throw new Error('Choose a recording.');
    if (!settings.name.trim()) throw new Error('Name this region set.');
    const parent = settings.parentSetId
      ? this.project.regionSets?.find((set) => set.id === settings.parentSetId)
      : undefined;
    if (settings.parentSetId && (!parent || parent.sourceId !== source.id))
      throw new Error('Parent regions must use this recording’s clock.');
    const selected = settings.parentRegionIds;
    if (
      parent &&
      selected &&
      (!selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some(
          (id) => !parent.regions.some((region) => region.id === id),
        ))
    )
      throw new Error('Choose valid parent regions.');
    if (!parent && settings.timeReference === 'parent')
      throw new Error('Relative times require parent regions.');
    if (
      settings.previousId &&
      !this.project.regionSets?.some(
        (set) => set.id === settings.previousId && set.sourceId === source.id,
      )
    )
      throw new Error('The previous region version is unavailable.');
    const domains = parent
      ? parent.regions.filter(
          (region) => !selected || selected.includes(region.id),
        )
      : [undefined];
    const plan: RegionPlan = { regions: [], skipped: 0, incomplete: 0 };
    for (const region of domains) {
      this.check();
      const domain: [number, number] = region
        ? [region.start, region.end]
        : [source.start, source.end];
      const offset =
        settings.timeReference === 'parent' && region ? region.start : 0;
      const definition = structuredClone(settings.definition);
      if (definition.method === 'ranges')
        definition.ranges = definition.ranges.map(([a, b]) => [
          a + offset,
          b + offset,
        ]);
      if (definition.method === 'windows') {
        if (
          ![
            definition.start,
            definition.end,
            definition.duration,
            definition.step,
          ].every(Number.isFinite) ||
          definition.end <= definition.start ||
          definition.duration <= 0 ||
          definition.step <= 0
        )
          throw new Error(
            'Use a finite interval and positive window duration and step.',
          );
        definition.start += offset;
        definition.end += offset;
        // Tail handling is relative to each parent, never to another parent's extent.
        definition.end = Math.min(definition.end, domain[1]);
        if (definition.end <= definition.start) {
          plan.skipped++;
          continue;
        }
      }
      const intervals = await this.previewSegments(
        source.id,
        definition,
        [source.channels[0]],
        false,
        'signals',
        region ? domain : undefined,
        true,
      );
      plan.regions.push(
        ...intervals.ranges.map((boundary) => ({
          start: boundary.start,
          end: boundary.end,
          parentRegionId: region?.id,
          boundary,
          endInclusive:
            boundary.end === domain[1] &&
            (region?.endInclusive ?? boundary.end === source.end),
        })),
      );
      plan.skipped += intervals.skipped;
      plan.incomplete += intervals.incomplete;
      if (plan.regions.length > 1000)
        throw new Error(
          'This batch exceeds 1,000 regions. Select fewer parents or increase the window step.',
        );
    }
    return plan;
  }
  async createRegions(settings: RegionSettings): Promise<RegionSet> {
    const plan = await this.previewRegions(settings);
    if (!plan.regions.length)
      throw new Error(
        'No complete regions match. Preview the crossings or choose time ranges inside the parent.',
      );
    const previous = this.project.regionSets?.find(
      (set) => set.id === settings.previousId,
    );
    const set: RegionSet = {
      ...structuredClone(settings),
      id: uid(),
      name: settings.name.trim(),
      version: previous
        ? Math.max(
            previous.version,
            ...(this.project.regionSets ?? [])
              .filter(
                (set) =>
                  set.name === settings.name.trim() &&
                  set.sourceId === settings.sourceId,
              )
              .map((set) => set.version),
          ) + 1
        : 1,
      sequence: nextSequence(this.project),
      createdAt: new Date().toISOString(),
      regions: plan.regions.map((region, index) => ({
        ...region,
        id: uid(),
        name: `${settings.name.trim()} ${String(index + 1).padStart(2, '0')}`,
      })),
    };
    await this.save({
      ...this.project,
      regionSets: [...(this.project.regionSets ?? []), set],
    });
    return set;
  }
  /** A two-input recipe node. Both inputs must share one sample grid. */
  private binaryNode(
    sourceId: string,
    operation: Operation,
    firstId: string,
    secondId: string,
    labels?: Record<string, string>,
  ): SignalNode {
    if (this.gridRecipe(firstId) !== this.gridRecipe(secondId))
      throw new Error(
        'Inputs need matching sample grids and time transformations.',
      );
    const a = this.find(firstId),
      b = this.find(secondId);
    if (
      operation === 'power' &&
      (!/^n[· ]?m$/i.test(a.unit) || b.unit.toLowerCase() !== 'rpm')
    )
      throw new Error(
        'Brake power requires torque [Nm] followed by speed [rpm].',
      );
    if (
      operation === 'bsfc' &&
      (!/^kg\/h$/i.test(a.unit) || b.unit.toLowerCase() !== 'kw')
    )
      throw new Error(
        'Specific fuel consumption requires fuel flow [kg/h] followed by power [kW].',
      );
    return this.node(
      sourceId,
      isArithmetic(operation)
        ? `${(labels?.[a.id] ?? a.name).slice(0, 64)} ${ARITHMETIC_SYMBOLS[operation]} ${(labels?.[b.id] ?? b.name).slice(0, 64)}`
        : operation === 'power'
          ? 'Brake power'
          : 'Specific fuel consumption',
      isArithmetic(operation)
        ? arithmeticUnit(operation, a.unit, b.unit)
        : operation === 'power'
          ? 'kW'
          : 'g/kWh',
      operation,
      [firstId, secondId],
    );
  }
  async applyRegionFunction(settings: FunctionSettings): Promise<FunctionRun> {
    this.check();
    if (settings.within) {
      // Two-input functions within segments: one output per first input in
      // each segment, both read from crops of that segment.
      const secondary = settings.secondaryIds ?? [];
      if (!isBinaryOperation(settings.operation) || secondary.length !== 1)
        throw new Error('Choose one second input for this calculation.');
      const labels = this.project.labels ?? {};
      const outputs = await this.deriveWithin(
        settings.within,
        settings.inputIds,
        secondary,
        async (inputs, crop) => {
          const second = crop(secondary[0]);
          if (!second) return [];
          const names = Object.fromEntries(
            [...inputs, second].map((id) => {
              const read = visibleInput(this.graph().nodes, id);
              return [id, labels[read] ?? this.find(read).name];
            }),
          );
          return inputs.map((id) =>
            this.binaryNode(
              settings.sourceId,
              settings.operation,
              id,
              second,
              names,
            ),
          );
        },
      );
      return {
        ...structuredClone(settings),
        id: outputs[0].batchId!,
        sequence: nextStepSequence(this.project),
        createdAt: outputs[0].createdAt,
        outputs: outputs.map((node) => ({
          signalId: node.id,
          inputId: visibleInput(this.graph().nodes, node.parents[0]),
        })),
        skipped: 0,
      };
    }
    const before = this.project;
    const binary = isBinaryOperation(settings.operation);
    const inputs = settings.inputIds;
    const secondary = settings.secondaryIds ?? [];
    if (!inputs.length || new Set(inputs).size !== inputs.length)
      throw new Error('Choose unique input signals.');
    if (binary && !secondary.length)
      throw new Error('Choose the second input for this calculation.');
    for (const id of [...inputs, ...secondary])
      if (this.find(id).sourceId !== settings.sourceId)
        throw new Error('Inputs must use the same recording.');
    const set = settings.regionSetId
      ? before.regionSets?.find((item) => item.id === settings.regionSetId)
      : undefined;
    if (settings.regionSetId && (!set || set.sourceId !== settings.sourceId))
      throw new Error('Choose regions from this recording.');
    if (
      settings.regionIds &&
      (!set ||
        !settings.regionIds.length ||
        settings.regionIds.some(
          (id) => !set.regions.some((region) => region.id === id),
        ))
    )
      throw new Error('Choose valid processing regions.');
    const bindings = regionBindings(before);
    const allRegions = new Map(
      (before.regionSets ?? []).flatMap((item) =>
        item.regions.map((region) => [region.id, region] as const),
      ),
    );
    const contexts = set
      ? set.regions.filter(
          (region) =>
            !settings.regionIds || settings.regionIds.includes(region.id),
        )
      : [undefined];
    const jobs: {
      input: string;
      second?: string;
      region?: Region;
      boundId?: string;
    }[] = [];
    for (const region of contexts) {
      const eligible = (id: string) =>
        !region ||
        !bindings.has(id) ||
        regionContains(before, bindings.get(id)!, region.id, allRegions);
      const firstIds = inputs.filter(eligible);
      const secondIds = secondary.filter(eligible);
      for (const input of firstIds) {
        const boundId = region?.id ?? bindings.get(input);
        let second: string | undefined;
        if (binary) {
          const matched = secondIds.filter(
            (id) =>
              !bindings.has(id) ||
              (boundId &&
                regionContains(before, bindings.get(id)!, boundId, allRegions)),
          );
          if (matched.length !== 1)
            throw new Error(
              'Choose one matching second input per region. Select a signal or one result family.',
            );
          second = matched[0];
        }
        jobs.push({
          input,
          second,
          region:
            region ?? (second && boundId ? allRegions.get(boundId) : undefined),
          boundId,
        });
      }
    }
    if (!jobs.length)
      throw new Error(
        'The selected result family does not contain these regions. Use its own regions, child regions, or a full-recording signal.',
      );
    if (jobs.length > 10000)
      throw new Error('Limit this operation to 10,000 results per batch.');
    const internal: SignalNode[] = [];
    const outputs: SignalNode[] = [];
    const run: FunctionRun = {
      ...structuredClone(settings),
      id: uid(),
      createdAt: new Date().toISOString(),
      sequence: nextSequence(before),
      outputs: [],
      skipped: 0,
    };
    try {
      for (const job of jobs) {
        this.check();
        const previousInternalCount = internal.length;
        const ids = [job.input, ...(job.second ? [job.second] : [])];
        const scoped: string[] = [];
        let populated = true;
        for (const id of ids) {
          if (!job.region || bindings.get(id) === job.region.id) {
            scoped.push(id);
            continue;
          }
          const offset = this.axisOffset(id);
          const start = Math.max(this.bounds(id)[0], job.region.start + offset);
          const end = Math.min(this.bounds(id)[1], job.region.end + offset);
          const endExclusive =
            end === job.region.end + offset && !job.region.endInclusive;
          if (
            end < start ||
            !(await this.hasSample(id, start, end, endExclusive))
          ) {
            populated = false;
            break;
          }
          const parent = this.find(id);
          const view = this.node(
            settings.sourceId,
            parent.name,
            parent.unit,
            'crop',
            [id],
            { start, end, endExclusive: endExclusive ? 1 : 0 },
          );
          view.internal = true;
          internal.push(view);
          scoped.push(view.id);
        }
        if (!populated) {
          internal.length = previousInternalCount;
          run.skipped++;
          continue;
        }
        this.project = {
          ...before,
          nodes: [...before.nodes, ...internal, ...outputs],
        };
        let result: SignalNode;
        if (binary)
          result = this.binaryNode(
            settings.sourceId,
            settings.operation,
            scoped[0],
            scoped[1],
            before.labels,
          );
        else
          result = (
            await this.deriveMany(
              [scoped[0]],
              settings.operation,
              settings.parameter,
              false,
            )
          )[0];
        result.batchId = run.id;
        outputs.push(result);
        run.outputs.push({
          signalId: result.id,
          inputId: job.input,
          regionId: job.boundId,
        });
      }
    } finally {
      this.project = before;
    }
    if (!outputs.length)
      throw new Error(
        'The selected signals have no samples inside these regions.',
      );
    if (!run.regionSetId) {
      const associated = (before.regionSets ?? []).filter((item) =>
        run.outputs.every((output) =>
          item.regions.some((region) => region.id === output.regionId),
        ),
      );
      if (associated.length === 1) run.regionSetId = associated[0].id;
    }
    await this.save({
      ...before,
      nodes: [...before.nodes, ...internal, ...outputs],
      functionRuns: [...(before.functionRuns ?? []), run],
    });
    return run;
  }
  async regionExample(key: string) {
    if (!REGION_EXAMPLES.some((item) => item.key === key))
      throw new Error('Choose an available example.');
    const existing = this.project.regionExamples?.find(
      (item) => item.key === key,
    );
    if (existing) return existing;
    const source = await this.demo(false);
    const base =
      key !== 'ramps' ? await this.regionExample('ramps') : undefined;
    let set: RegionSet;
    let run: FunctionRun;
    if (key === 'ramps') {
      set = await this.createRegions({
        sourceId: source.id,
        name: 'Ramps',
        timeReference: 'recording',
        definition: {
          method: 'triggers',
          boundary: 'clip',
          minimumDuration: 0,
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
        },
      });
      const filtered = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: [source.channels[1]],
        operation: 'low-pass',
        parameter: 5,
      });
      const smooth = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: filtered.outputs.map((output) => output.signalId),
        regionSetId: set.id,
        operation: 'smooth',
        parameter: 25,
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: smooth.outputs.map((output) => output.signalId),
        operation: 'min-max',
        parameter: 0,
      });
    } else if (key === 'fuel') {
      set = this.project.regionSets!.find(
        (item) => item.id === base!.regionSetId,
      )!;
      const powerRun = await this.applyRegionFunction({
        sourceId: source.id,
        operation: 'power',
        parameter: 0,
        inputIds: [source.channels[1]],
        secondaryIds: [source.channels[0]],
        regionSetId: set.id,
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        operation: 'bsfc',
        parameter: 0,
        inputIds: [source.channels[2]],
        secondaryIds: powerRun.outputs.map((output) => output.signalId),
        regionSetId: set.id,
      });
    } else {
      set = await this.createRegions({
        sourceId: source.id,
        name: key === 'nested' ? 'Ramp windows' : 'Overlapping windows',
        parentSetId: base!.regionSetId,
        timeReference: 'parent',
        definition: {
          method: 'windows',
          boundary: 'clip',
          start: 0,
          end: 180,
          duration: 10,
          step: key === 'nested' ? 10 : 5,
          includePartial: true,
        },
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: [source.channels[1]],
        regionSetId: set.id,
        operation: 'min-max',
        parameter: 0,
      });
    }
    const example = {
      key,
      sourceId: source.id,
      regionSetId: set.id,
      runId: run.id,
    };
    await this.save({
      ...this.project,
      regionExamples: [...(this.project.regionExamples ?? []), example],
    });
    return example;
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
  private execute(
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
  /**
   * Remove derived indexes and checkpoints that no current, Undo or Redo
   * signal uses, and every artifact of another `derived-vN` cache version.
   * Caller must hold the shared workspace writer lock.
   */
  async pruneDerivedIndexes() {
    const live = new Set<string>();
    try {
      for (const project of [
        this.project,
        ...this.undoStack,
        ...this.redoStack,
      ]) {
        const graph = new SignalGraph(project);
        for (const node of project.nodes)
          live.add(derivedOwner(recipeKey(graph, node.id)));
      }
    } catch {
      return; // Never delete anything while any snapshot is unreadable.
    }
    const keys = await result(
      this.db
        .transaction('chunks')
        .objectStore('chunks')
        .getAllKeys(IDBKeyRange.bound([DERIVED_ANY], [`${DERIVED_ANY}\uffff`])),
    );
    const stale = keys.filter(
      (key) =>
        Array.isArray(key) && typeof key[0] === 'string' && !live.has(key[0]),
    );
    if (!stale.length) return;
    const tx = this.db.transaction('chunks', 'readwrite'),
      done = complete(tx);
    for (const key of stale) tx.objectStore('chunks').delete(key);
    await done;
    this.indexCache.clear();
    this.indexCacheBytes = 0;
    this.checkpointCache.clear();
    this.checkpointBytes = 0;
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
  async derive(parentId: string, operation: Operation, value: number) {
    return (await this.deriveMany([parentId], operation, value))[0];
  }
  async deriveMany(
    parentIds: string[],
    operation: Operation,
    constant: number,
    persist = true,
    bindings?: ParameterBindings,
    extra: {
      unit?: string;
      formula?: FormulaSettings;
      within?: SegmentScope;
    } = {},
  ): Promise<SignalNode[]> {
    if (extra.within) {
      if (!persist) throw new Error('Preview segments with derive-preview.');
      const { within, ...rest } = extra;
      const signals = rest.formula?.signals ?? {};
      return this.deriveWithin(
        within,
        parentIds,
        [...new Set(Object.values(signals).flat())],
        (inputs, crop) =>
          this.deriveMany(inputs, operation, constant, false, bindings, {
            ...rest,
            ...(rest.formula
              ? {
                  formula: {
                    ...rest.formula,
                    ...(rest.formula.signals
                      ? {
                          signals: Object.fromEntries(
                            Object.entries(rest.formula.signals).map(
                              ([letter, ids]) => [
                                letter,
                                ids.flatMap((id) => crop(id) ?? []),
                              ],
                            ),
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          }),
      );
    }
    if (
      !FUNCTIONS.some(
        (spec) =>
          spec.operation !== 'segment' &&
          !isBinaryOperation(spec.operation) &&
          spec.operation === operation,
      )
    )
      throw new Error(
        'Choose an implemented single-input function. Segmentation and two-input calculations use their own input settings.',
      );
    if (!parentIds.length || new Set(parentIds).size !== parentIds.length)
      throw new Error('Choose unique inputs for this operation.');
    if (operation === 'formula' || operation === 'convert') {
      const nodes =
        operation === 'formula'
          ? this.formulaNodes(parentIds, extra, bindings)
          : this.convertNodes(parentIds, extra.unit, bindings);
      if (persist)
        await this.save({
          ...this.project,
          nodes: [...this.project.nodes, ...nodes],
        });
      return nodes;
    }
    if (extra.unit !== undefined || extra.formula)
      throw new Error('Only formulas and conversions take a unit.');
    for (const key of Object.keys(bindings ?? {}))
      if (key !== 'value' || !BINDABLE_DERIVE[operation])
        throw new Error(
          'Only offsets, scale factors and time shifts can come from values.',
        );
    const binding = bindings?.value;
    const context = binding ? this.bindingContext() : undefined;
    const nodes: SignalNode[] = [];
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    for (const parentId of parentIds) {
      this.check();
      const parent = this.find(parentId);
      const bound = binding
        ? resolveBinding(
            context!,
            binding,
            parentId,
            BINDABLE_DERIVE[operation]!,
            operation === 'offset'
              ? 'offset'
              : operation === 'scale'
                ? 'scale factor'
                : 'time shift',
            parent.unit,
          )
        : undefined;
      const value = bound ? bound.number : constant;
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
      if (
        (operation === 'low-pass' ||
          operation === 'high-pass' ||
          operation === 'butterworth-low' ||
          operation === 'butterworth-high') &&
        value <= 0
      )
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
        'butterworth-low': 'Butterworth low-pass',
        'butterworth-high': 'Butterworth high-pass',
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
            : operation === 'scale' && bound
              ? arithmeticUnit('multiply', parent.unit, bound.value.unit)
              : parent.unit;
      const n = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · ${labels[operation]}`,
        unit,
        operation,
        [parentId],
        { value },
      );
      n.color = parent.color;
      n.batchId = batchId;
      if (bound)
        n.bindings = {
          value: { valueId: bound.valueId, factor: bound.factor },
        };
      if (operation === 'butterworth-low' || operation === 'butterworth-high') {
        // The nominal rate is the median of the first 1,000 intervals, read
        // across chunks (a crop's first chunk can hold a single sample).
        const steps: number[] = [];
        let previous: number | undefined;
        const stream = this.evaluate(parentId);
        try {
          for await (const chunk of stream) {
            for (let i = 0; i < chunk.time.length && steps.length < 1000; i++) {
              if (previous !== undefined) steps.push(chunk.time[i] - previous);
              previous = chunk.time[i];
            }
            if (steps.length >= 1000) break;
          }
        } finally {
          await stream.return(undefined);
        }
        steps.sort((a, b) => a - b);
        const interval = steps[Math.floor(steps.length / 2)];
        if (!(interval > 0))
          throw new Error(
            'This filter needs at least two samples at a regular interval.',
          );
        const rate = 1 / interval;
        if (!belowNyquist(value, rate))
          throw new Error(
            `The cutoff must be below half the sample rate (${Number((rate / 2).toPrecision(4))} Hz).`,
          );
        n.parameters.rate = rate;
      }
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
    if (persist)
      await this.save({
        ...this.project,
        nodes: [...this.project.nodes, ...nodes],
      });
    return nodes;
  }
  /**
   * Formula outputs, one per input A. Other signal variables use the
   * candidate on A's sample grid; value variables are resolved per input.
   */
  private formulaNodes(
    parentIds: string[],
    extra: { unit?: string; formula?: FormulaSettings },
    bindings?: ParameterBindings,
  ): SignalNode[] {
    if (!extra.formula) throw new Error('Enter a formula.');
    const formula = compileFormula(extra.formula.expression);
    const unit = (extra.unit ?? '').trim();
    if (unit.length > 40)
      throw new Error('Keep the output unit to 40 characters.');
    const letters = formula.signals.slice(1);
    for (const key of Object.keys(extra.formula.signals ?? {}))
      if (!letters.includes(key))
        throw new Error(`The formula does not use ${key}.`);
    for (const key of Object.keys(bindings ?? {}))
      if (!formula.values.includes(key))
        throw new Error(`The formula does not use "${key}".`);
    for (const name of formula.values)
      if (!bindings?.[name]) throw new Error(`Choose a value for "${name}".`);
    const context = formula.values.length ? this.bindingContext() : undefined;
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    return parentIds.map((parentId) => {
      this.check();
      const parent = this.find(parentId);
      const grid = this.gridRecipe(parentId);
      const others = letters.map((letter) => {
        const candidates = extra.formula!.signals?.[letter] ?? [];
        if (!candidates.length)
          throw new Error(`Choose a signal for ${letter}.`);
        const matched =
          candidates.length === 1
            ? candidates
            : candidates.filter((id) => this.gridRecipe(id) === grid);
        if (matched.length !== 1)
          throw new Error(
            matched.length
              ? `Several ${letter} signals share the sample grid of ${parent.name}. Choose one.`
              : `No ${letter} signal shares the sample grid of ${parent.name}.`,
          );
        if (this.gridRecipe(matched[0]) !== grid)
          throw new Error(
            `${letter} needs the same sample grid and time transformations as ${parent.name}. Use Compare & align first.`,
          );
        return matched[0];
      });
      const parameters: Record<string, number> = {};
      const bound: Record<string, BoundValue> = {};
      for (const name of formula.values) {
        const result = resolveBinding(
          context!,
          bindings![name],
          parentId,
          'any',
          `"${name}"`,
        );
        parameters[name] = result.number;
        bound[name] = { valueId: result.valueId, factor: result.factor };
      }
      const node = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · Formula`,
        unit,
        'formula',
        [parentId, ...others],
        parameters,
      );
      node.expression = formula.expression;
      node.color = parent.color;
      node.batchId = batchId;
      if (formula.values.length) node.bindings = bound;
      return node;
    });
  }
  /** Unit conversions, one per input, with exact linear factors. */
  private convertNodes(
    parentIds: string[],
    unit: string | undefined,
    bindings?: ParameterBindings,
  ): SignalNode[] {
    if (bindings && Object.keys(bindings).length)
      throw new Error('Unit conversions take no values.');
    const target = (unit ?? '').trim();
    if (!target) throw new Error('Choose the unit to convert to.');
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    return parentIds.map((parentId) => {
      const parent = this.find(parentId);
      const conversion = unitConversion(parent.unit, target);
      if (!conversion)
        throw new Error(
          `Stratum has no conversion from ${parent.unit || 'no unit'} to ${target}.`,
        );
      const node = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · in ${target}`,
        target,
        'convert',
        [parentId],
        conversion,
      );
      node.color = parent.color;
      node.batchId = batchId;
      return node;
    });
  }
  /**
   * Evaluate a candidate derive operation without saving it. The candidate is
   * validated and built exactly as creation builds it; only bounded envelopes
   * of it and its inputs, each on its own time axis, are returned.
   */
  async previewDerived(request: {
    inputId: string;
    operation: Operation;
    parameter: number;
    bindings?: ParameterBindings;
    unit?: string;
    formula?: FormulaSettings;
    secondaryId?: string;
    range?: [number, number];
    within?: SegmentScope;
  }): Promise<DerivePreview> {
    if (request.within) return this.previewDerivedWithin(request);
    const input = this.find(request.inputId);
    const binary = isBinaryOperation(request.operation);
    let node: SignalNode;
    if (binary) {
      if (!request.secondaryId)
        throw new Error('Choose the second input for this calculation.');
      if (this.find(request.secondaryId).sourceId !== input.sourceId)
        throw new Error('Inputs must use the same recording.');
      node = this.binaryNode(
        input.sourceId,
        request.operation,
        input.id,
        request.secondaryId,
        this.project.labels,
      );
    } else
      [node] = await this.deriveMany(
        [input.id],
        request.operation,
        request.parameter,
        false,
        request.bindings,
        {
          ...(request.unit !== undefined ? { unit: request.unit } : {}),
          ...(request.formula ? { formula: request.formula } : {}),
        },
      );
    const graph = new SignalGraph({
      ...this.project,
      nodes: [...this.project.nodes, node],
    });
    // Every signal input in operation order: A, then B (or the formula's B, C …).
    const inputIds = binary
      ? [input.id, request.secondaryId!]
      : node.parents.slice(0, 8);
    const full = [node.id, ...inputIds].map((id) => graph.ranges.get(id)!);
    const domain: [number, number] = [
      Math.min(...full.map((range) => range[0])),
      Math.max(...full.map((range) => range[1])),
    ];
    const view = request.range ?? domain;
    const clip = (id: string): [number, number] | undefined => {
      const bounds = graph.ranges.get(id)!;
      const range: [number, number] = [
        Math.max(view[0], bounds[0]),
        Math.min(view[1], bounds[1]),
      ];
      return range[1] >= range[0] ? range : undefined;
    };
    const empty = (id: string): Plot => ({
      id,
      ...new Envelope(view[0], view[1]).finish(),
    });
    const outputRange = clip(node.id);
    let plot = empty(node.id);
    if (outputRange) {
      const envelope = new Envelope(...outputRange);
      for await (const chunk of this.execute(node.id, graph, outputRange))
        for (let i = 0; i < chunk.time.length; i++)
          envelope.add(chunk.time[i], chunk.values[i]);
      plot = { id: node.id, ...envelope.finish() };
    }
    const inputs: Plot[] = [];
    for (const id of inputIds) {
      const range = clip(id);
      inputs.push(range ? await this.plot(id, range) : empty(id));
    }
    return { node, plot, inputs, domain };
  }
  /**
   * A derive preview within the first chosen segment where the input has
   * samples: the candidate reads crops, and its inputs are shown over the
   * segment.
   */
  private async previewDerivedWithin(
    request: Parameters<SignalEngine['previewDerived']>[0],
  ): Promise<DerivePreview> {
    const within = request.within!;
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    const binary = isBinaryOperation(request.operation);
    const others = binary
      ? request.secondaryId
        ? [request.secondaryId]
        : []
      : [...new Set(Object.values(request.formula?.signals ?? {}).flat())];
    if (binary && !others.length)
      throw new Error('Choose the second input for this calculation.');
    for (const id of [request.inputId, ...others])
      this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    let node: SignalNode | undefined;
    let graph: SignalGraph | undefined;
    try {
      for (const segment of segments) {
        this.check();
        const crops = new Map<string, SignalNode>();
        const input = await this.segmentCrop(
          request.inputId,
          segment,
          entries,
          crops,
        );
        if (!input) continue;
        const mapped = new Map<string, string | undefined>();
        for (const id of others)
          mapped.set(id, await this.segmentCrop(id, segment, entries, crops));
        this.project = {
          ...before,
          nodes: [...before.nodes, ...crops.values()],
        };
        if (binary) {
          const second = mapped.get(others[0]);
          if (!second) continue;
          node = this.binaryNode(
            this.find(input).sourceId,
            request.operation,
            input,
            second,
            before.labels,
          );
        } else
          [node] = await this.deriveMany(
            [input],
            request.operation,
            request.parameter,
            false,
            request.bindings,
            {
              ...(request.unit !== undefined ? { unit: request.unit } : {}),
              ...(request.formula
                ? {
                    formula: {
                      ...request.formula,
                      ...(request.formula.signals
                        ? {
                            signals: Object.fromEntries(
                              Object.entries(request.formula.signals).map(
                                ([letter, ids]) => [
                                  letter,
                                  ids.flatMap((id) => mapped.get(id) ?? []),
                                ],
                              ),
                            ),
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          );
        graph = new SignalGraph({
          ...this.project,
          nodes: [...this.project.nodes, node],
        });
        break;
      }
    } finally {
      this.project = before;
    }
    if (!node || !graph)
      throw new Error('The input has no samples inside these segments.');
    // Inputs are shown as chosen, over the segment the candidate covers.
    const inputIds = (binary ? [request.inputId, ...others] : node.parents)
      .map((id) => visibleInput(graph!.nodes, id))
      .slice(0, 8);
    const domain = graph.ranges.get(node.id)!;
    const view: [number, number] = request.range
      ? [
          Math.max(domain[0], request.range[0]),
          Math.min(domain[1], request.range[1]),
        ]
      : domain;
    const envelope = new Envelope(...view);
    if (view[1] >= view[0])
      for await (const chunk of this.execute(node.id, graph, view))
        for (let i = 0; i < chunk.time.length; i++)
          envelope.add(chunk.time[i], chunk.values[i]);
    const inputs: Plot[] = [];
    for (const id of inputIds) {
      const bounds = this.bounds(id);
      const range: [number, number] = [
        Math.max(view[0], bounds[0]),
        Math.min(view[1], bounds[1]),
      ];
      inputs.push(
        range[1] >= range[0]
          ? await this.plot(id, range)
          : { id, ...new Envelope(view[0], view[1]).finish() },
      );
    }
    return {
      node,
      plot: { id: node.id, ...envelope.finish() },
      inputs,
      domain,
    };
  }
  /** Constant translation from recording time to this node's displayed time. */
  private axisOffset(id: string): number {
    if (this.find(id).sourceId === '') return 0;
    return this.graph().offsets.get(id)!;
  }
  private async hasSample(
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
  private gridRecipe(id: string): string {
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
  private async *triggerEvents(
    trigger: EdgeTrigger,
    domain?: [number, number],
  ): AsyncGenerator<TriggerEvent> {
    const detector = new CrossingDetector(trigger);
    const offset = this.axisOffset(trigger.signalId);
    let last: number | undefined;
    const [first, end] = this.bounds(trigger.signalId);
    for await (const chunk of this.evaluate(
      trigger.signalId,
      new Set(),
      domain ? [domain[0] + offset, domain[1] + offset] : undefined,
    )) {
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i] - offset;
        if (domain && time < domain[0]) continue;
        if (domain && time >= domain[1]) {
          if (last !== undefined) yield { time: last, kind: 'finish' };
          return;
        }
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
    domain?: [number, number],
    pointersOnly = false,
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
    definition = resolveTriggerBindings(this.bindingContext(), definition);
    const cacheKey = JSON.stringify([
      sourceId,
      definition,
      targetIds,
      domain,
      pointersOnly,
    ]);
    if (cacheKey === this.segmentPreviewCache?.key)
      return structuredClone(this.segmentPreviewCache.plan);
    const source =
      this.project.sources.find((s) => s.id === sourceId) ??
      (sourceId === ''
        ? workspaceTimeScope(this.project, this.graph())
        : undefined);
    if (!source) throw new Error('Choose a recording to segment.');
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
      throw new Error('Choose at least one unique output signal.');
    const fromSource = (id: string) => {
      const node = this.find(id);
      if (node.sourceId !== sourceId)
        throw new Error(
          'Triggers and output signals must belong to the same recording.',
        );
      if (
        sourceId === '' &&
        this.graph().timeReferences.get(id)?.id !==
          this.graph().timeReferences.get(targetIds[0])?.id
      )
        throw new Error(
          'Segmentation inputs and triggers must share a time reference. Align them first.',
        );
      return node;
    };
    const limits: [number, number] = domain
      ? [Math.max(source.start, domain[0]), Math.min(source.end, domain[1])]
      : [source.start, source.end];
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
          if (!validTriggerNoise(trigger))
            throw new Error(
              'Trigger hysteresis and debounce must be zero or positive.',
            );
        }
        if (
          !Number.isFinite(definition.minimumDuration) ||
          definition.minimumDuration < 0
        )
          throw new Error('Minimum duration must be zero or positive.');
        const streams = [
          this.triggerEvents(definition.start, domain),
          this.triggerEvents(definition.end, domain),
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
      if (pointersOnly) {
        populated.push(range);
        continue;
      }
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
    // New segments are numbered within this step (per member when members
    // are segmented independently) and named after each parent's display
    // label. Saved segments keep their names.
    const numbers = new Map<string, number>();
    // Bound trigger settings are saved as the results each segment used.
    const context = this.bindingContext();
    const savedDefinition = resolveTriggerBindings(
      context,
      structuredClone(definition),
    );
    const batchId = uid();
    const segments = plan.ranges.map((boundary): Segment => {
      const number = (numbers.get(boundary.inputId ?? '') ?? 0) + 1;
      numbers.set(boundary.inputId ?? '', number);
      const recipe = boundary.inputId
        ? resolveTriggerBindings(
            context,
            this.memberDefinition(
              savedDefinition,
              targetIds[0],
              boundary.inputId,
            ),
          )
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
            this.project.labels?.[id] ?? parent.name,
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
        name: `Segment ${String(number).padStart(2, '0')}`,
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
  /**
   * The signal whose bounds limit a segment set: a recording's first channel,
   * a workspace trigger, or the workspace signal chosen for ranges/windows.
   */
  private segmentAxis(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
  ): string {
    if (sourceId !== '') {
      const source = this.project.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error('Choose a recording to segment.');
      return source.channels[0];
    }
    const id =
      definition.method === 'triggers'
        ? definition.start.signalId
        : referenceId;
    if (!id || this.find(id).sourceId !== '')
      throw new Error(
        'Choose a workspace signal whose time axis these segments use.',
      );
    return id;
  }
  /**
   * File segments found by these settings, for a dialog preview. Nested
   * segmentation searches each parent segment; its ranges and windows are
   * seconds from that parent's start.
   */
  async previewSegmentSet(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
    within?: SegmentScope,
  ): Promise<SegmentationPlan> {
    this.check();
    const axis = this.segmentAxis(sourceId, definition, referenceId);
    if (!within)
      return this.previewSegments(
        sourceId,
        definition,
        [axis],
        false,
        'signals',
        undefined,
        true,
      );
    const { set, segments } = scopeSegments(this.project, within);
    if (
      set.sourceId !== sourceId ||
      (sourceId === '' &&
        set.timeReferenceId !== this.graph().timeReferences.get(axis)?.id)
    )
      throw new Error(
        'Nested segments must use the same recording as their parent segments.',
      );
    const combined: SegmentationPlan = {
      ranges: [],
      skipped: 0,
      incomplete: 0,
    };
    for (const parent of segments) {
      this.check();
      const local: SegmentationDefinition =
        definition.method === 'ranges'
          ? {
              ...definition,
              ranges: definition.ranges.map(
                ([a, b]) =>
                  [parent.start + a, parent.start + b] as [number, number],
              ),
            }
          : definition.method === 'windows'
            ? {
                ...definition,
                start: parent.start + definition.start,
                end: Math.min(parent.end, parent.start + definition.end),
              }
            : definition;
      if (local.method === 'windows' && !(local.end > local.start)) {
        combined.skipped++;
        continue;
      }
      const plan = await this.previewSegments(
        sourceId,
        local,
        [axis],
        false,
        'signals',
        [parent.start, parent.end],
        true,
      );
      combined.ranges.push(
        ...plan.ranges.map((range) => ({ ...range, parentId: parent.id })),
      );
      combined.skipped += plan.skipped;
      combined.incomplete += plan.incomplete;
      if (combined.ranges.length > 10000)
        throw new Error(
          'More than 10,000 nested segments. Narrow the settings or choose fewer parent segments.',
        );
    }
    return combined;
  }
  /**
   * A Segment step that finds file segments: time intervals of the whole
   * recording, not signals. Later steps choose them with `within`.
   */
  async segmentSet(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
    within?: SegmentScope,
  ) {
    const plan = await this.previewSegmentSet(
      sourceId,
      definition,
      referenceId,
      within,
    );
    if (!plan.ranges.length)
      throw new Error(
        'No segments match these settings. Preview the triggers, offsets, or time ranges.',
      );
    const before = this.project;
    const axis = this.segmentAxis(sourceId, definition, referenceId);
    const recordingEnd = this.bounds(axis)[1] - this.axisOffset(axis);
    const saved = resolveTriggerBindings(
      this.bindingContext(),
      structuredClone(definition),
    );
    const entries = segmentEntries(before);
    const numbers = new Map<string, number>();
    const segments = plan.ranges.map(
      ({ parentId, ...boundary }): FileSegment => {
        const parent = parentId ? entries.get(parentId)!.segment : undefined;
        const number = (numbers.get(parentId ?? '') ?? 0) + 1;
        numbers.set(parentId ?? '', number);
        const label = String(number).padStart(2, '0');
        return {
          id: uid(),
          name: parent
            ? `${before.labels?.[parent.id] ?? parent.name}.${label}`
            : `Segment ${label}`,
          start: boundary.start,
          end: boundary.end,
          endInclusive:
            boundary.end >= recordingEnd ||
            (!!parent && boundary.end >= parent.end && parent.endInclusive),
          ...(parent ? { parentId: parent.id } : {}),
          boundary,
        };
      },
    );
    const set: SegmentSet = {
      id: uid(),
      sourceId,
      ...(sourceId === ''
        ? {
            timeReferenceId: this.graph().timeReferences.get(axis)!.id,
            ...(saved.method === 'triggers' ? {} : { referenceId: axis }),
          }
        : {}),
      definition: saved,
      ...(within ? { within: structuredClone(within) } : {}),
      segments,
    };
    const valueIds = bindingValueIds(saved.bindings);
    const step: WorkflowStep = {
      id: uid(),
      sourceId,
      sequence: nextStepSequence(before),
      createdAt: new Date().toISOString(),
      kind: 'segment',
      operation: 'segment',
      inputIds:
        saved.method === 'triggers'
          ? [...new Set([saved.start.signalId, saved.end.signalId])]
          : set.referenceId
            ? [set.referenceId]
            : [],
      outputIds: segments.map((segment) => segment.id),
      ...(valueIds.length ? { valueInputIds: valueIds } : {}),
      definition: saved,
      segmentSetId: set.id,
      ...(within
        ? {
            within: structuredClone(within),
            segmentInputIds: scopeSegments(before, within).segments.map(
              (segment) => segment.id,
            ),
          }
        : {}),
    };
    await this.save({
      ...before,
      segmentSets: [...(before.segmentSets ?? []), set],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    });
    return set;
  }
  /** Signals must share a segment set's recording or workspace time axis. */
  private checkSegmentInput(id: string, set: SegmentSet) {
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
  private async segmentCrop(
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
  /**
   * Derived signals within segments: for each chosen segment, `create`
   * builds the outputs from crops of every signal input, so stateful
   * functions start at the segment's start. One step holds every output.
   */
  private async deriveWithin(
    within: SegmentScope,
    inputIds: string[],
    otherIds: string[],
    create: (
      inputs: string[],
      crop: (id: string) => string | undefined,
    ) => Promise<SignalNode[]>,
  ) {
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
      throw new Error('Choose unique inputs for this operation.');
    for (const id of [...inputIds, ...otherIds])
      this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    const crops = new Map<string, SignalNode>();
    const outputs: SignalNode[] = [];
    const batchId = uid();
    try {
      for (const [position, segment] of segments.entries()) {
        this.check();
        this.progress(
          `Processing ${segment.name} · ${position + 1}/${segments.length}`,
          position / segments.length,
        );
        const mapped = new Map<string, string | undefined>();
        for (const id of [...inputIds, ...otherIds])
          mapped.set(id, await this.segmentCrop(id, segment, entries, crops));
        const inputs = inputIds.flatMap((id) => mapped.get(id) ?? []);
        if (!inputs.length) continue;
        this.project = {
          ...before,
          nodes: [...before.nodes, ...crops.values(), ...outputs],
        };
        for (const node of await create(inputs, (id) => mapped.get(id))) {
          node.segmentId = segment.id;
          node.batchId = batchId;
          outputs.push(node);
        }
        if (outputs.length > 10000)
          throw new Error('Limit this operation to 10,000 outputs.');
      }
    } finally {
      this.project = before;
    }
    if (!outputs.length)
      throw new Error(
        'The selected signals have no samples inside these segments.',
      );
    // Only crops an output reads are kept.
    const read = new Set(outputs.flatMap((node) => node.parents));
    const internal = [...crops.values()].filter((node) => read.has(node.id));
    const nodes = new Map(
      [...before.nodes, ...internal].map((node) => [node.id, node]),
    );
    const step: WorkflowStep = {
      id: uid(),
      sourceId: outputs[0].sourceId,
      sequence: nextStepSequence(before),
      createdAt: new Date().toISOString(),
      kind: 'derive',
      operation: outputs[0].operation,
      inputIds: [
        ...new Set(
          outputs.flatMap((node) =>
            node.parents.map((id) => visibleInput(nodes, id)),
          ),
        ),
      ],
      outputIds: outputs.map((node) => node.id),
      parameters: outputs[0].parameters,
      ...withValueInputs(boundValueIds(outputs)),
      within: structuredClone(within),
      segmentInputIds: segments.map((segment) => segment.id),
    };
    await this.save({
      ...before,
      nodes: [...before.nodes, ...internal, ...outputs],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    });
    return outputs;
  }
  /**
   * Each input's value within each chosen segment, read from the input
   * itself (filters keep their state from before the segment). Values on a
   * signal that already belongs to a segment keep that segment.
   */
  private async valuesWithin(
    within: SegmentScope,
    inputIds: string[],
    operation: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    preview = false,
  ): Promise<{
    values: ScalarValue[];
    statistics: ValueStatistics[];
    segments: FileSegment[];
  }> {
    const spec = valueSpec(operation)!;
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    for (const id of inputIds) this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    const batchId = uid(),
      createdAt = new Date().toISOString();
    const values: ScalarValue[] = [];
    const statistics: ValueStatistics[] = [];
    const total = segments.length * inputIds.length;
    try {
      for (const [position, segment] of segments.entries())
        for (const [index, id] of inputIds.entries()) {
          this.check();
          if (preview && statistics.length >= 50) break;
          if (!preview)
            this.progress(
              `Calculating ${spec.name.toLowerCase()} · ${position * inputIds.length + index + 1}/${total}`,
              (position * inputIds.length + index) / total,
            );
          this.project = before;
          const crops = new Map<string, SignalNode>();
          const read = await this.segmentCrop(id, segment, entries, crops);
          if (!read) continue;
          this.project = {
            ...before,
            nodes: [...before.nodes, ...crops.values()],
          };
          const reading = this.find(read);
          const { parameters: settings, bound } = this.boundValueSettings(
            operation,
            parameters,
            bindings,
            reading,
          );
          const result = await this.valueStatistics(read, operation, settings);
          result.inputId = id;
          result.segmentId = segment.id;
          statistics.push(result);
          if (preview) continue;
          const input = this.find(id);
          const [start, end] = this.bounds(read);
          const timestamp = statisticTime(result, operation);
          values.push({
            id: uid(),
            sourceId: input.sourceId,
            inputId: id,
            batchId,
            name: `${input.name} · ${valueTitle(operation, settings, input.unit)}`,
            unit: valueUnit(operation, input.unit),
            operation,
            ...(spec.parameters?.length ? { parameters: settings } : {}),
            ...(bound ? { bindings: bound } : {}),
            value: statisticValue(result, operation),
            sampleCount: result.sampleCount,
            validDuration: result.validDuration,
            start,
            end,
            createdAt,
            segmentId: segment.id,
            ...(timestamp !== undefined ? { timestamp } : {}),
            ...(operation === 'time-of-minimum' && result.minimum !== null
              ? { level: result.minimum }
              : operation === 'time-of-maximum' && result.maximum !== null
                ? { level: result.maximum }
                : {}),
          });
        }
    } finally {
      this.project = before;
    }
    return { values, statistics, segments };
  }
  private segmentationScope(
    sourceId: string,
    targetIds: string[],
    independently: boolean,
    scope?: SegmentationScope,
  ): SegmentationScope {
    if (sourceId === '') {
      if (scope === 'file')
        throw new Error('Workspace outputs use signal segmentation.');
      return 'signals';
    }
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
  private async neighbor(
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
  /**
   * Streams evaluated samples as CSV to `sink` in bounded chunks and returns
   * the size in bytes. `limit` caps it for in-memory downloads.
   */
  async writeSamples(ids: string[], sink: ByteSink, limit = Infinity) {
    const { csvText } = await import('./workflow-delivery');
    const { WorkflowIndex } = await import('./workflow-history');
    const index = new WorkflowIndex(this.project);
    const out = new ChunkedWriter(
      sink,
      limit,
      'Samples CSV exceeds the 64 MiB export limit. Export fewer signals or shorter segments.',
    );
    await out.write(
      'Signal,Signal ID,Recording,Unit,Time reference,Time reference ID,Time meaning,Time (s),Value\r\n',
    );
    for (const id of new Set(ids)) {
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
            `${prefix},${chunk.time[i]},${Number.isFinite(chunk.values[i]) ? chunk.values[i] : ''}\r\n`,
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
    const { csvText: quote } = await import('./workflow-delivery');
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
