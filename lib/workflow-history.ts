import { FUNCTIONS } from './signal-functions';
import { TIME_OPERATIONS } from './time-types';
import { valueTitle, type ValueOperation } from './workflow-types';
import type { Project, SignalNode } from './signal-types';
import type { WorkflowStep } from './workflow-types';

export function stepName(step: WorkflowStep): string {
  if (step.name) return step.name;
  if (step.kind === 'import')
    return step.fileName ? `Import ${step.fileName}` : 'Import recording';
  if (step.kind === 'segment') return 'Segment signals';
  if (step.kind === 'regions') return 'Saved region ranges';
  if (step.operation === 'power') return 'Brake power';
  if (step.operation === 'bsfc') return 'Specific fuel consumption';
  if (step.operation in TIME_OPERATIONS)
    return TIME_OPERATIONS[step.operation as keyof typeof TIME_OPERATIONS];
  if (step.kind === 'value')
    return valueTitle(step.operation as ValueOperation, step.parameters);
  return (
    FUNCTIONS.find((spec) => spec.operation === step.operation)?.name ??
    step.operation
  );
}

/**
 * Capture additions atomically with the project. Existing records never move.
 * Also adapts old workspaces using explicit batches and dependency order, never
 * labels. An old region-scoped invocation's actual crops become visible steps.
 */
export function withWorkflowHistory(project: Project): Project {
  const history = project.workflowSteps ?? [];
  const knownSteps = new Set(history.map((step) => step.id));
  const knownOutputs = new Set(history.flatMap((step) => step.outputIds));
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const candidates: Omit<WorkflowStep, 'sequence'>[] = [];
  const claim = (step: Omit<WorkflowStep, 'sequence'>) => {
    if (knownSteps.has(step.id)) return;
    const outputIds = step.outputIds.filter((id) => !knownOutputs.has(id));
    if (!outputIds.length && step.kind !== 'regions') return;
    candidates.push({ ...step, outputIds });
    knownSteps.add(step.id);
    for (const id of outputIds) knownOutputs.add(id);
  };
  for (const source of project.sources)
    claim({
      id: `import:${source.id}`,
      sourceId: source.id,
      kind: 'import',
      operation: 'import',
      ...(source.name ? { fileName: source.name } : {}),
      createdAt: nodes.get(source.channels[0])?.createdAt ?? '',
      inputIds: [],
      outputIds: source.channels,
    });
  const segments = new Map(project.segments.map((item) => [item.id, item]));
  for (const operation of project.segmentationOperations ?? []) {
    const outputs = operation.segmentIds.flatMap((id) =>
      (segments.get(id)?.nodes ?? []).filter(
        (id) => nodes.get(id)?.operation === 'crop',
      ),
    );
    claim({
      id: `segment:${operation.id}`,
      sourceId: operation.sourceId,
      kind: 'segment',
      operation: 'segment',
      createdAt: nodes.get(outputs[0])?.createdAt ?? '',
      inputIds: [
        ...new Set(outputs.flatMap((id) => nodes.get(id)?.parents ?? [])),
      ],
      outputIds: outputs,
      definition: operation.definition,
      segmentationId: operation.id,
    });
  }
  // Preserve region-only settings; these can be reused to create signal segments.
  for (const set of project.regionSets ?? []) {
    if (project.segmentationOperations?.some((item) => item.id === set.id))
      continue;
    claim({
      id: `regions:${set.id}`,
      sourceId: set.sourceId,
      kind: 'regions',
      operation: 'regions',
      createdAt: set.createdAt,
      inputIds:
        set.definition.method === 'triggers'
          ? [
              ...new Set([
                set.definition.start.signalId,
                set.definition.end.signalId,
              ]),
            ]
          : [],
      outputIds: [],
      definition: set.definition,
      regionSetId: set.id,
    });
  }
  for (const run of project.functionRuns ?? []) {
    const outputs = run.outputs.map((output) => output.signalId);
    const crops = [
      ...new Set(outputs.flatMap((id) => nodes.get(id)?.parents ?? [])),
    ].flatMap((id) => {
      const node = nodes.get(id);
      return node?.internal && node.operation === 'crop' ? [node] : [];
    });
    if (crops.length)
      claim({
        id: `scope:${run.id}`,
        sourceId: run.sourceId,
        kind: 'segment',
        operation: 'segment',
        createdAt: crops[0].createdAt,
        inputIds: [...new Set(crops.flatMap((node) => node.parents))],
        outputIds: crops.map((node) => node.id),
        regionSetId: run.regionSetId,
      });
    claim({
      id: `run:${run.id}`,
      sourceId: run.sourceId,
      kind: 'derive',
      operation: run.operation,
      createdAt: run.createdAt,
      inputIds: [
        ...new Set(outputs.flatMap((id) => nodes.get(id)?.parents ?? [])),
      ],
      outputIds: outputs,
      parameters: { value: run.parameter },
      regionSetId: run.regionSetId,
    });
  }
  const groups = new Map<string, SignalNode[]>();
  for (const node of project.nodes) {
    if (knownOutputs.has(node.id)) continue;
    const key = `${node.sourceId}:${node.batchId ?? node.id}:${node.operation}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const first = group[0];
    claim({
      id: `nodes:${key}`,
      sourceId: first.sourceId,
      kind: first.operation === 'crop' ? 'segment' : 'derive',
      operation: first.operation === 'crop' ? 'segment' : first.operation,
      createdAt: first.createdAt,
      inputIds: [...new Set(group.flatMap((node) => node.parents))],
      outputIds: group.map((node) => node.id),
      parameters: first.parameters,
    });
  }
  const values = new Map<string, NonNullable<Project['values']>>();
  for (const value of project.values ?? []) {
    const batch = values.get(value.batchId) ?? [];
    batch.push(value);
    values.set(value.batchId, batch);
  }
  for (const [batchId, batch] of values)
    claim({
      id: `values:${batchId}`,
      sourceId: batch[0].sourceId,
      kind: 'value',
      operation: batch[0].operation,
      createdAt: batch[0].createdAt,
      inputIds: batch.map((value) => value.inputId),
      outputIds: batch.map((value) => value.id),
      ...(batch[0].parameters ? { parameters: batch[0].parameters } : {}),
    });
  if (!candidates.length) return project;
  // Stable topological ordering resolves tied timestamps and old batch metadata.
  // Newly recorded invocations append, even if the machine clock moves backwards.
  candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const owner = new Map(
    candidates.flatMap((step, index) =>
      step.outputIds.map((id) => [id, index] as const),
    ),
  );
  const byRegion = new Map(
    candidates.flatMap((step, index) =>
      step.kind === 'regions' && step.regionSetId
        ? [[step.regionSetId, index] as const]
        : [],
    ),
  );
  const children = new Map<number, number[]>();
  const degrees = candidates.map((step, index) => {
    const dependencies = new Set(
      step.inputIds.flatMap((id) => {
        const parent = owner.get(id);
        return parent === undefined || parent === index ? [] : [parent];
      }),
    );
    const source = project.sources.find(
      (source) => source.id === step.sourceId,
    );
    const imported = source && owner.get(source.channels[0]);
    if (imported !== undefined && imported !== index)
      dependencies.add(imported);
    const region = step.regionSetId && byRegion.get(step.regionSetId);
    if (typeof region === 'number' && region !== index)
      dependencies.add(region);
    if (step.kind === 'regions') {
      const set = project.regionSets?.find(
        (set) => set.id === step.regionSetId,
      );
      for (const id of [set?.parentSetId, set?.previousId]) {
        const parent = id && byRegion.get(id);
        if (typeof parent === 'number' && parent !== index)
          dependencies.add(parent);
      }
    }
    for (const parent of dependencies) {
      const list = children.get(parent) ?? [];
      list.push(index);
      children.set(parent, list);
    }
    return dependencies.size;
  });
  const ready = degrees.flatMap((degree, index) =>
    degree === 0 ? [index] : [],
  );
  const appended: WorkflowStep[] = [];
  let sequence = history.reduce(
    (max, step) => Math.max(max, step.sequence + 1),
    0,
  );
  while (ready.length) {
    const index = ready.shift()!;
    appended.push({ ...candidates[index], sequence: sequence++ });
    for (const child of children.get(index) ?? []) {
      if (--degrees[child]) continue;
      let low = 0,
        high = ready.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ready[middle] < child) low = middle + 1;
        else high = middle;
      }
      ready.splice(low, 0, child);
    }
  }
  if (appended.length !== candidates.length)
    throw new Error(
      'Cannot order workflow history: cyclic operation dependencies.',
    );
  return { ...project, workflowSteps: [...history, ...appended] };
}

export class WorkflowIndex {
  readonly nodes;
  readonly values;
  readonly steps;
  readonly owner = new Map<string, WorkflowStep>();
  readonly consumers = new Map<string, WorkflowStep[]>();
  readonly segmentNames = new Map<string, string>();
  readonly branchNames = new Map<string, string>();
  constructor(readonly project: Project) {
    this.nodes = new Map(project.nodes.map((node) => [node.id, node]));
    this.values = new Map(
      (project.values ?? []).map((value) => [value.id, value]),
    );
    this.steps = new Map(
      (project.workflowSteps ?? []).map((step) => [step.id, step]),
    );
    for (const segment of project.segments)
      for (const id of segment.nodes)
        if (this.nodes.get(id)?.operation === 'crop')
          this.segmentNames.set(id, segment.name);
    // Propagate a short segment identity without accumulating long ancestor names.
    const children = new Map<string, string[]>();
    const ready = project.nodes
      .filter((node) => !node.parents.length)
      .map((node) => node.id);
    for (const node of project.nodes) {
      if (!node.parents.length) continue;
      const list = children.get(node.parents[0]) ?? [];
      list.push(node.id);
      children.set(node.parents[0], list);
    }
    const visited = new Set<string>();
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const id = ready[cursor];
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes.get(id)!;
      const name =
        node.operation === 'crop'
          ? (this.segmentNames.get(id) ??
            `Segment ${Number(node.parameters.start.toFixed(3))}–${Number(node.parameters.end.toFixed(3))} s`)
          : this.branchNames.get(node.parents[0]);
      if (name) this.branchNames.set(id, name);
      for (const child of children.get(id) ?? []) ready.push(child);
    }
    for (const step of this.steps.values()) {
      for (const id of step.outputIds) this.owner.set(id, step);
      for (const id of step.inputIds) {
        const list = this.consumers.get(id) ?? [];
        list.push(step);
        this.consumers.set(id, list);
      }
    }
  }
  label(id: string): string {
    if (this.project.labels?.[id]) return this.project.labels[id];
    const node = this.nodes.get(id);
    if (!node) {
      const value = this.values.get(id);
      return value
        ? `${valueTitle(value.operation, value.parameters, this.nodes.get(value.inputId)?.unit)} · ${this.label(value.inputId)}`
        : 'Unavailable input';
    }
    if (node.operation === 'crop') {
      const interval = `${Number(node.parameters.start.toFixed(3))}–${Number(node.parameters.end.toFixed(3))} s`;
      return `${this.segmentNames.get(id) ?? 'Segment'} · ${node.name.split(' · ')[0]} · ${interval}`;
    }
    const branch = this.branchNames.get(id);
    return branch ? `${branch} · ${node.name}` : node.name;
  }
  kind(id: string): 'Original signal' | 'Derived signal' | 'Value' {
    return this.values.has(id)
      ? 'Value'
      : this.nodes.get(id)?.operation === 'raw'
        ? 'Original signal'
        : 'Derived signal';
  }
  inputs(id: string): string[] {
    return (
      this.nodes.get(id)?.parents ??
      (this.values.has(id) ? [this.values.get(id)!.inputId] : [])
    );
  }
  /** Iterative DAG traversal includes every binary and trigger dependency. */
  lineage(ids: string[]): {
    steps: WorkflowStep[];
    originals: SignalNode[];
    outputIds: ReadonlySet<string>;
  } {
    const visited = new Set<string>(),
      stepIds = new Set<string>();
    const originals: SignalNode[] = [];
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const owner = this.owner.get(id);
      if (owner) stepIds.add(owner.id);
      const node = this.nodes.get(id);
      if (node?.operation === 'raw') originals.push(node);
      stack.push(...this.inputs(id));
    }
    return {
      steps: [...stepIds]
        .map((id) => this.steps.get(id)!)
        .sort((a, b) => a.sequence - b.sequence),
      originals,
      outputIds: visited,
    };
  }
}
