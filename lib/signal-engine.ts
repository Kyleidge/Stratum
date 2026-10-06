import { CsvParser, Envelope, power } from './signal-math';
import { SignalGraph } from './signal-graph';
import { timeNodes, workspaceTimeScope } from './time-model';
import { TIME_OPERATIONS, timeInputs } from './time-types';
import type { TimeSettings } from './time-types';
import { executeSignal } from './signal-executor';
import { yieldEngine } from './engine-yield';
import { chunkWindow } from './signal-range';
import {
  blockCount,
  groupBlocks,
  IndexBuilder,
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
import { withWorkflowHistory, WorkflowIndex } from './workflow-history';
import {
  columnCountProblem,
  headerProblem,
  importError,
  timeProblem,
  valueProblem,
} from './csv-import-messages';
import {
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
import {
  ARCHIVE_LIMIT,
  EXPORT_LIMIT,
  archiveLines,
  validateWorkspace,
} from './workspace-archive';
import { VALUE_FUNCTIONS, statisticValue } from './workflow-types';
import type {
  CheckDefinition,
  RunFlag,
  ScalarValue,
  ValueOperation,
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
import { CrossingDetector } from './segmentation';
import type { TriggerEvent } from './segmentation';
import type {
  Chunk,
  DerivePreview,
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
// Index read cache. A packed root costs 104 bytes per 4,096 samples.
const INDEX_BUDGET = 32 * 1024 * 1024;
// Base blocks built in memory at once: all channels of an import, or one
// channel of a rebuild. 64 MiB covers 2.6 billion channel samples.
const INDEX_BUILD_BUDGET = 64 * 1024 * 1024;
const indexKey = (channel: number) => `plot-index-v2:${channel}`;
const leavesKey = (channel: number) => `plot-leaves-v2:${channel}`;
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
      id: crypto.randomUUID(),
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
    const request = indexedDB.open(this.databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chunks');
      request.result.createObjectStore('project');
    };
    this.db = await result(request);
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
      !this.project.nodes.some((node) => node.id === id) &&
      !this.project.values?.some((value) => value.id === id)
    )
      throw new Error('That output no longer exists.');
    await this.save({
      ...this.project,
      labels: { ...this.project.labels, [id]: name },
    });
  }
  async backupWorkspace() {
    const parts: BlobPart[] = [];
    let bytes = 0,
      chunks = 0;
    const append = (value: unknown) => {
      const line = JSON.stringify(value) + '\n';
      bytes += new TextEncoder().encode(line).length;
      if (bytes > ARCHIVE_LIMIT)
        throw new Error(
          'This workspace exceeds the 128 MiB archive limit. Nothing was downloaded.',
        );
      parts.push(line);
    };
    append({
      // Stable format identifier keeps backups compatible across the rename.
      format: 'stratus-workspace',
      version: 1,
      project: withWorkflowHistory(this.project),
    });
    for (const source of this.project.sources)
      for (let index = 0; index < source.chunks; index++)
        for (const column of [
          'time',
          ...source.channels.map((_, index) => index),
        ]) {
          this.check();
          const data = await this.column(source.id, index, column);
          append({
            sourceId: source.id,
            index,
            column,
            data: Array.from(data, (value) =>
              Number.isFinite(value) ? value : null,
            ),
          });
          chunks++;
        }
    append({ complete: true, chunks });
    return new Blob(parts, { type: 'application/x-stratus-workspace' });
  }
  async restoreWorkspace(file: File) {
    let next: Project | undefined;
    const sourceMapping = new Map<string, string>(),
      seen = new Set<string>();
    const previousTimes = new Map<string, number>();
    let completed = false;
    try {
      for await (const value of archiveLines(file)) {
        this.check();
        if (!value || typeof value !== 'object' || completed)
          throw new Error('Invalid or extra archive records.');
        const record = value as Record<string, unknown>;
        if (!next) {
          if (record.format !== 'stratus-workspace' || record.version !== 1)
            throw new Error('Choose a supported Stratum workspace backup.');
          next = validateWorkspace(record.project);
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
      if (
        !next ||
        !completed ||
        seen.size !==
          next.sources.reduce(
            (sum, source) => sum + source.chunks * (source.channels.length + 1),
            0,
          )
      )
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
        );
        break;
      case 'calculate-values':
        await this.calculateValues(command.inputIds, command.operation);
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
    try {
      this.project = withoutOperations(before, affected);
      this.invalidate();
      for (const old of affected) {
        this.check();
        const prior = new Set(
          this.project.workflowSteps?.map((step) => step.id),
        );
        await this.applyCommand(
          old.id === stepId ? command : savedCommand(before, old),
        );
        const added =
          this.project.workflowSteps?.filter((step) => !prior.has(step.id)) ??
          [];
        if (added.length !== 1)
          throw new Error(
            'This legacy operation cannot be rebuilt as one atomic step. Existing work is unchanged.',
          );
        const generated = added[0];
        if (
          generated.outputIds.length !== old.outputIds.length &&
          affected.length > 1
        )
          throw new Error(
            'The new settings change the number of outputs used by later operations. Remove or revise those dependent operations first. Existing work is unchanged.',
          );
        const mapping = new Map<string, string>([[generated.id, old.id]]);
        if (generated.outputIds.length === old.outputIds.length)
          generated.outputIds.forEach((id, position) =>
            mapping.set(id, old.outputIds[position]),
          );
        if (generated.segmentationId && old.segmentationId)
          mapping.set(generated.segmentationId, old.segmentationId);
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
      if (options.file) source = imported = await this.importCsv(options.file);
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
        const names = outputLabels(
          step,
          created.outputIds.length,
          itemId,
          (position) => {
            const id = created.outputIds[position];
            const parent =
              index.nodes.get(id)?.parents[0] ?? index.values.get(id)?.inputId;
            return parent ? index.label(parent) : '';
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
  async importCsv(file: Blob & { name?: string }, synthetic = false) {
    this.cancelled = false;
    const id = uid();
    await this.trackImport(id, true);
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
    let overview: IndexBuilder[] | undefined = [];
    const flush = async () => {
      if (!times.length) return;
      chunkRanges.push([times[0], times.at(-1)!]);
      const groups = await this.writeChunk(id, chunks++, {
        time: Float64Array.from(times),
        values: columns.map((c) => Float64Array.from(c)),
      });
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
      times = [];
      columns = headers.slice(1).map(() => []);
    };
    const consume = async (records: string[][]) => {
      for (const record of records) {
        this.check();
        if (!headers.length) {
          headers = record.map((v) => v.trim().replace(/^\uFEFF/, ''));
          const problem = headerProblem(headers);
          if (problem) throw new Error(problem);
          columns = headers.slice(1).map(() => []);
          continue;
        }
        if (record.length !== headers.length)
          throw new Error(
            columnCountProblem(rows + 2, headers.length, record.length),
          );
        const t = record[0].trim() ? Number(record[0]) : NaN;
        if (!Number.isFinite(t) || t <= end)
          throw new Error(timeProblem(rows + 2, record[0], end));
        if (!rows) start = t;
        end = t;
        times.push(t);
        for (let c = 1; c < record.length; c++) {
          const value = record[c].trim() ? Number(record[c]) : NaN;
          if (record[c].trim() && !Number.isFinite(value))
            throw new Error(valueProblem(rows + 2, headers[c], record[c]));
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
      if (overview)
        for (const [c, builder] of overview.entries())
          await this.writeIndex([id, 0, indexKey(c)], builder.finish(rows));
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
      // A staged workflow owns publication and recovery of its new columns.
      if (!this.staging) await this.trackImport(id, false).catch(() => {});
      return source;
    } catch (error) {
      await this.removeIncomplete(id);
      await this.trackImport(id, false);
      throw importError(error, file.name || 'The recording');
    }
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
  async calculateValues(inputIds: string[], operation: ValueOperation) {
    const spec = VALUE_FUNCTIONS.find((item) => item.operation === operation);
    if (!spec) throw new Error('Choose a supported value calculation.');
    if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
      throw new Error('Choose at least one unique signal.');
    if (inputIds.length > 10000)
      throw new Error('Limit a calculation to 10,000 signals.');
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
      const statistics = await this.valueStatistics(input.id);
      const [start, end] = this.bounds(input.id);
      values.push({
        id: uid(),
        sourceId: mixedSources ? '' : input.sourceId,
        inputId: input.id,
        batchId,
        name: `${input.name} · ${spec.name}`,
        unit: input.unit,
        operation,
        value: statisticValue(statistics, operation),
        sampleCount: statistics.sampleCount,
        validDuration: statistics.validDuration,
        start,
        end,
        createdAt,
        ...(operation === 'minimum' && statistics.minimumTime !== undefined
          ? { timestamp: statistics.minimumTime }
          : operation === 'maximum' && statistics.maximumTime !== undefined
            ? { timestamp: statistics.maximumTime }
            : {}),
      });
    }
    await this.save({
      ...this.project,
      values: [...(this.project.values ?? []), ...values],
    });
    return values;
  }
  /** Exact statistics for every value calculation, from every finite sample. */
  async valueStatistics(id: string): Promise<ValueStatistics> {
    let count = 0,
      mean = 0,
      minimum = Infinity,
      maximum = -Infinity;
    let minTime = 0,
      maxTime = 0,
      duration = 0,
      area = 0;
    let previous: Point | undefined;
    for await (const chunk of this.evaluate(id)) {
      this.check();
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i],
          value = chunk.values[i];
        if (!Number.isFinite(value)) {
          previous = undefined;
          continue;
        }
        count++;
        mean = mean * ((count - 1) / count) + value / count;
        if (value < minimum) {
          minimum = value;
          minTime = time;
        }
        if (value > maximum) {
          maximum = value;
          maxTime = time;
        }
        if (previous && time > previous[0]) {
          const dt = time - previous[0];
          area += (previous[1] / 2 + value / 2) * dt;
          duration += dt;
        }
        previous = [time, value];
      }
    }
    const finite = (value: number) => (Number.isFinite(value) ? value : null);
    return {
      inputId: id,
      sampleCount: count,
      validDuration: duration,
      sampleAverage: count ? finite(mean) : null,
      timeAverage: duration > 0 ? finite(area / duration) : null,
      minimum: finite(minimum),
      maximum: finite(maximum),
      ...(count ? { minimumTime: minTime, maximumTime: maxTime } : {}),
    };
  }
  /** Value statistics for a dialog preview; nothing is saved. */
  async previewValues(ids: string[]): Promise<ValueStatistics[]> {
    if (ids.length > 50) throw new Error('Preview up to 50 signals at once.');
    const statistics: ValueStatistics[] = [];
    for (const id of new Set(ids)) {
      this.check();
      statistics.push(await this.valueStatistics(id));
    }
    return statistics;
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
    value: number,
    persist = true,
  ) {
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
    const nodes: SignalNode[] = [];
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
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
        mixedSources ? '' : parent.sourceId,
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
    if (persist)
      await this.save({
        ...this.project,
        nodes: [...this.project.nodes, ...nodes],
      });
    return nodes;
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
    secondaryId?: string;
    range?: [number, number];
  }): Promise<DerivePreview> {
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
      );
    const graph = new SignalGraph({
      ...this.project,
      nodes: [...this.project.nodes, node],
    });
    const inputIds = [input.id, ...(binary ? [request.secondaryId!] : [])];
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
      for await (const chunk of executeSignal(
        node.id,
        graph,
        (id, range) => this.raw(id, range),
        () => this.check(),
        outputRange,
      ))
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
    const savedDefinition = structuredClone(definition);
    const batchId = uid();
    const segments = plan.ranges.map((boundary): Segment => {
      const number = (numbers.get(boundary.inputId ?? '') ?? 0) + 1;
      numbers.set(boundary.inputId ?? '', number);
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
    for await (const chunk of this.raw(id, [time, time]))
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
    for await (const chunk of this.evaluate(id, undefined, bounds)) {
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
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i],
          value = chunk.values[i];
        if (context && time < bounds[0]) before = [time, value];
        if (context && time > bounds[1] && !after) after = [time, value];
        envelope.add(time, value);
      }
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
  async exportSamples(ids: string[]) {
    const { csvText } = await import('./workflow-delivery');
    const { WorkflowIndex } = await import('./workflow-history');
    const index = new WorkflowIndex(this.project);
    const parts: BlobPart[] = [
      'Signal,Signal ID,Recording,Unit,Time reference,Time reference ID,Time meaning,Time (s),Value\r\n',
    ];
    let exportBytes = 0;
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
        const part = lines.join('');
        exportBytes += new TextEncoder().encode(part).length;
        if (exportBytes > EXPORT_LIMIT)
          throw new Error(
            'Samples CSV exceeds the 64 MiB export limit. Export fewer signals or shorter segments.',
          );
        parts.push(part);
      }
    }
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
