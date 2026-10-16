import { SignalGraph } from '../signal-graph';
import { recipeKey } from '../signal-recipe';
import {
  groupBlocks,
  indexBytes,
  indexLeaves,
  type PlotBlocks,
  type PlotIndex,
} from '../plot-index';
import { withWorkflowHistory, WorkflowIndex } from '../workflow-history';
import {
  affectedOperations,
  describeChange,
  withoutOperations,
} from '../workflow-lifecycle';
import { restoreSegmentationOperations } from '../segmentation-operation';
import { migrateRegionHistory } from '../region-model';
import type {
  Chunk,
  Operation,
  Plot,
  Project,
  SegmentationPlan,
  SignalNode,
} from '../signal-types';
import { randomId } from '../random-id';
import { earlierChosenName, followsStepName } from '../output-names';

export const CHUNK_SIZE = 16384;
// Index read cache. A packed root costs 104 bytes per 4,096 samples.
const INDEX_BUDGET = 32 * 1024 * 1024;
// Base blocks built in memory at once: all channels of an import, or one
// channel of a rebuild. 64 MiB covers 2.6 billion channel samples.
export const INDEX_BUILD_BUDGET = 64 * 1024 * 1024;
export const indexKey = (channel: number) => `plot-index-v2:${channel}`;
export const leavesKey = (channel: number) => `plot-leaves-v2:${channel}`;
// Rebuildable artifacts of a derived signal, owned by its recipe key rather
// than a source: plot index (channel 0) and filter checkpoints.
const DERIVED = 'derived-v1:';
// Owners of every derived-cache version start with this; see pruning.
const DERIVED_ANY = 'derived-v';
export const derivedOwner = (recipe: string) => `${DERIVED}${recipe}`;
export const CHECKPOINTS_KEY = 'checkpoints-v1';
/**
 * Workspace schema version: the IndexedDB database version. Raise it whenever
 * a newer Stratum could store data an older one would misread, reject or drop
 * when rewriting, so older versions refuse the workspace instead
 * (docs/file-format-stability.md).
 */
export const WORKSPACE_SCHEMA_VERSION = 2;
export const NEWER_WORKSPACE_MESSAGE =
  'This workspace was saved by a newer version of Stratum. Update Stratum to open it; this version has not changed it.';
export const CHECKPOINT_BUDGET = 16 * 1024 * 1024;
export const COLORS = ['#61d9b0', '#ac9cfa', '#edb477', '#74b9fa', '#e787ac'];
const emptyProject = (): Project => ({ sources: [], nodes: [], segments: [] });
export const uid = () => randomId();
/** The sequence of a step appended now. */
export const nextStepSequence = (project: Project) =>
  (project.workflowSteps ?? []).reduce(
    (max, item) => Math.max(max, item.sequence + 1),
    0,
  );
export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error('Storage transaction aborted.'));
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Workspace state and storage: the open project, IndexedDB access, saving
 * with Undo/Redo, raw columns, plot index records and import tracking.
 */
export abstract class EngineStore {
  project: Project = emptyProject();
  cancelled = false;
  protected db!: IDBDatabase;
  protected cache = new Map<string, Plot>();
  protected sampleCounts = new Map<string, number>();
  private columnCache = new Map<string, Float64Array>();
  private cacheBytes = 0;
  private indexCache = new Map<
    string,
    { value: PlotIndex | PlotBlocks; bytes: number }
  >();
  private indexCacheBytes = 0;
  /** Filter checkpoints by recipe key; null records a confirmed absence. */
  protected checkpointCache = new Map<string, Float64Array | null>();
  protected checkpointBytes = 0;
  private revision = 0;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  /** Batch that owns the newest Undo entry, so its later items coalesce. */
  private journalTag?: string;
  /** What each Undo/Redo entry does, aligned with its stack; '' is unnamed. */
  private undoLabels: string[] = [];
  private redoLabels: string[] = [];
  protected staging = false;
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
  protected invalidate() {
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
  protected extremaTimes = new Map<string, number[]>();
  protected graph(): SignalGraph {
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
  protected segmentPreviewCache?: { key: string; plan: SegmentationPlan };
  constructor(
    protected progress: (message: string, percent: number) => void = () => {},
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
  protected check() {
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
  protected async save(
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
    const step = this.project.workflowSteps?.find((step) => step.id === id);
    if (step) {
      // Outputs named after the step when it was created follow it now.
      let labels = this.project.labels;
      if (labels && step.name && followsStepName({ ...step, name })) {
        const index = new WorkflowIndex(this.project);
        labels = { ...labels };
        for (const output of step.outputIds)
          if (labels[output] === earlierChosenName(index, output, step.name))
            delete labels[output];
      }
      return this.save({
        ...this.project,
        labels,
        workflowSteps: this.project.workflowSteps!.map((item) =>
          item.id === id ? { ...item, name } : item,
        ),
      });
    }
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
  protected async writeChunk(sourceId: string, index: number, chunk: Chunk) {
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
  protected async readIndex<T extends PlotIndex | PlotBlocks>(
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
  protected async writeIndex(
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
  protected async deleteIndex(key: [string, number, string]) {
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
  protected async column(
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
  protected async removeIncomplete(sourceId: string) {
    const tx = this.db.transaction('chunks', 'readwrite');
    const done = complete(tx);
    tx.objectStore('chunks').delete(
      IDBKeyRange.bound([sourceId, 0], [sourceId, Number.MAX_SAFE_INTEGER]),
    );
    await done;
  }
  protected async trackImport(sourceId: string, active: boolean) {
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
  protected node(
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
  bounds(id: string): [number, number] {
    this.find(id);
    return this.graph().ranges.get(id)!;
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
  /** Constant translation from recording time to this node's displayed time. */
  protected axisOffset(id: string): number {
    if (this.find(id).sourceId === '') return 0;
    return this.graph().offsets.get(id)!;
  }
}
