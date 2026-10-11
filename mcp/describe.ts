/**
 * Compact, model-readable views of a project: History steps with their
 * outputs, Details of any record, recordings, segments and batches. They use
 * the workbench's own naming (`WorkflowIndex`), so names match the UI.
 */
import type { Project, SignalNode } from '../lib/signal-types';
import type { ScalarValue, WorkflowStep } from '../lib/workflow-types';
import { stepName, WorkflowIndex } from '../lib/workflow-history';
import { stepInputSummary } from '../lib/workflow-tree';
import {
  affectedOperations,
  savedCommand,
  stepReference,
} from '../lib/workflow-lifecycle';
import { liveRunStatus, runProblems } from '../lib/workflow-checks';

export function indexOf(project: Project) {
  return new WorkflowIndex(project);
}

const round = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? value
    : Number(value.toPrecision(12));

/** A recording by ID or name (the file extension may be left out). */
export function findRecording(project: Project, ref: string) {
  const wanted = ref.trim().toLowerCase();
  const bare = (name: string) => name.toLowerCase().replace(/\.[^.]*$/, '');
  return (
    project.sources.find((source) => source.id === ref) ??
    project.sources.find((source) => source.name.toLowerCase() === wanted) ??
    project.sources.find((source) => bare(source.name) === wanted)
  );
}

export function recordingName(project: Project, sourceId: string) {
  return (
    project.sources.find((source) => source.id === sourceId)?.name ??
    (sourceId ? 'Unavailable recording' : 'Workspace')
  );
}

/** One output, signal, value or segment as a short record. */
export function outputInfo(index: WorkflowIndex, id: string) {
  const kind = index.kind(id);
  const node = index.nodes.get(id);
  const value = index.values.get(id);
  const segment = index.segments.get(id)?.segment;
  return {
    id,
    kind,
    name: index.label(id),
    ...(node ? { unit: node.unit } : {}),
    ...(value
      ? {
          unit: value.unit,
          value: round(value.value),
          ...(value.timestamp !== undefined
            ? { at: round(value.timestamp) }
            : {}),
        }
      : {}),
    ...(segment
      ? {
          start: round(segment.start),
          end: round(segment.end),
          ...(segment.parentId ? { parentId: segment.parentId } : {}),
        }
      : {}),
    ...((node?.segmentId ?? value?.segmentId)
      ? { segment: index.segmentLabel((node?.segmentId ?? value?.segmentId)!) }
      : {}),
  };
}

function stepOutputs(index: WorkflowIndex, step: WorkflowStep): string[] {
  if (step.segmentSetId)
    return (
      index.project.segmentSets
        ?.find((set) => set.id === step.segmentSetId)
        ?.segments.map((segment) => segment.id) ?? step.outputIds
    );
  return step.outputIds.filter((id) => !index.nodes.get(id)?.internal);
}

/** A History row: the step, what it was made from and its outputs. */
export function stepSummary(
  index: WorkflowIndex,
  step: WorkflowStep,
  outputLimit = 8,
) {
  const outputs = stepOutputs(index, step);
  const checks = step.checkResults?.results ?? [];
  return {
    id: step.id,
    ref: stepReference(step),
    name: stepName(step),
    kind: step.kind,
    operation: step.operation,
    recording: recordingName(index.project, step.sourceId),
    ...(stepInputSummary(step, index)
      ? { from: stepInputSummary(step, index) }
      : {}),
    ...(step.revision ? { revision: step.revision } : {}),
    ...(step.within
      ? { within: step.within.segmentIds?.length ?? 'all segments' }
      : {}),
    ...(step.runId ? { runId: step.runId } : {}),
    ...(checks.length
      ? {
          checks: checks.reduce<Record<string, number>>((counts, result) => {
            counts[result.status] = (counts[result.status] ?? 0) + 1;
            return counts;
          }, {}),
        }
      : {}),
    outputCount: outputs.length,
    outputs: outputs.slice(0, outputLimit).map((id) => outputInfo(index, id)),
    ...(outputs.length > outputLimit
      ? { moreOutputs: outputs.length - outputLimit }
      : {}),
  };
}

export type HistoryFilter = {
  text?: string;
  show?: 'all' | 'signals' | 'values' | 'segments';
  recording?: string;
  offset?: number;
  limit?: number;
  outputLimit?: number;
};

/** Chronological History, newest last, filtered like the History panel. */
export function history(project: Project, filter: HistoryFilter = {}) {
  const index = indexOf(project);
  const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const steps = [...(project.workflowSteps ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((step) => {
      if (filter.recording) {
        const source = findRecording(project, filter.recording);
        if (step.sourceId !== (source?.id ?? filter.recording)) return false;
      }
      const outputs = stepOutputs(index, step);
      if (
        filter.show === 'values' &&
        !outputs.some((id) => index.values.has(id))
      )
        return false;
      if (
        filter.show === 'signals' &&
        !outputs.some((id) => index.nodes.has(id))
      )
        return false;
      if (filter.show === 'segments' && !step.segmentSetId) return false;
      if (!words.length) return true;
      const text = [
        stepName(step),
        step.operation,
        ...outputs.slice(0, 200).map((id) => index.label(id)),
      ]
        .join(' ')
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  return {
    totalSteps: project.workflowSteps?.length ?? 0,
    matching: steps.length,
    ...(offset ? { offset } : {}),
    steps: steps
      .slice(offset, offset + limit)
      .map((step) => stepSummary(index, step, filter.outputLimit ?? 8)),
    ...(steps.length > offset + limit
      ? { more: `${steps.length - offset - limit} more; pass offset.` }
      : {}),
  };
}

export function recordings(project: Project) {
  return project.sources.map((source) => {
    const signals = project.nodes.filter(
      (node) =>
        node.sourceId === source.id &&
        node.operation === 'raw' &&
        !node.internal,
    );
    return {
      id: source.id,
      name: source.name,
      rows: source.rows,
      start: round(source.start),
      end: round(source.end),
      ...(source.clock ? { clock: source.clock } : {}),
      ...(source.synthetic ? { synthetic: true } : {}),
      signals: signals.map((node) => ({
        id: node.id,
        name: node.name,
        unit: node.unit,
      })),
    };
  });
}

export function segmentSets(project: Project, filter?: string) {
  const index = indexOf(project);
  return (project.segmentSets ?? [])
    .filter(
      (set) =>
        !filter ||
        set.id === filter ||
        project.workflowSteps?.some(
          (step) => step.id === filter && step.segmentSetId === set.id,
        ),
    )
    .map((set) => {
      const step = project.workflowSteps?.find(
        (item) => item.segmentSetId === set.id,
      );
      return {
        id: set.id,
        ...(step ? { stepId: step.id, step: stepName(step) } : {}),
        recording: recordingName(project, set.sourceId),
        method: set.definition.method,
        ...(set.within ? { within: set.within } : {}),
        segments: set.segments.map((segment) => ({
          id: segment.id,
          name: index.segmentLabel(segment.id),
          start: round(segment.start),
          end: round(segment.end),
          ...(segment.parentId ? { parentId: segment.parentId } : {}),
        })),
      };
    });
}

export function batches(project: Project) {
  const steps = new Map(
    (project.workflowSteps ?? []).map((step) => [step.id, step]),
  );
  return (project.workflowBatches ?? []).map((batch) => ({
    id: batch.id,
    name: batch.name,
    state: batch.state,
    createdAt: batch.createdAt,
    runs: batch.runs.map((run) => ({
      id: run.id,
      itemId: run.itemId,
      fileName: run.fileName,
      status: liveRunStatus(run, steps),
      problems: runProblems(run, steps)
        .slice(0, 5)
        .map((problem) => problem.message),
    })),
    ...(batch.failures?.length ? { failures: batch.failures } : {}),
  }));
}

function nodeDetails(index: WorkflowIndex, node: SignalNode) {
  return {
    ...outputInfo(index, node.id),
    operation: node.operation,
    ...(Object.keys(node.parameters).length
      ? { parameters: node.parameters }
      : {}),
    ...(node.expression ? { expression: node.expression } : {}),
    ...(node.bindings ? { bindings: node.bindings } : {}),
    recording: recordingName(index.project, node.sourceId),
    ...(node.timeReference ? { timeReference: node.timeReference } : {}),
  };
}

function valueDetails(index: WorkflowIndex, value: ScalarValue) {
  return {
    ...outputInfo(index, value.id),
    operation: value.operation,
    ...(value.parameters ? { parameters: value.parameters } : {}),
    ...(value.bindings ? { bindings: value.bindings } : {}),
    ...(value.expression ? { expression: value.expression } : {}),
    input: outputInfo(index, value.inputId),
    sampleCount: value.sampleCount,
    validDuration: round(value.validDuration),
    start: round(value.start),
    end: round(value.end),
  };
}

/**
 * Details of a step, signal, value, segment, recording, segment set or
 * batch, as the Details panel shows them: properties, inputs, the step that
 * produced it, a bounded lineage chain and what uses it.
 */
export function describe(project: Project, id: string) {
  const index = indexOf(project);
  const step =
    index.steps.get(id) ??
    project.workflowSteps?.find(
      (item) => stepReference(item) === id || `#${item.sequence + 1}` === id,
    );
  if (step) {
    let command: unknown;
    try {
      command =
        step.kind === 'import' ? undefined : savedCommand(project, step);
    } catch {
      command = undefined;
    }
    const impact = affectedOperations(project, step.id);
    return {
      type: 'step',
      ...stepSummary(index, step, 40),
      createdAt: step.createdAt,
      ...(step.updatedAt ? { updatedAt: step.updatedAt } : {}),
      inputs: [...new Set(step.inputIds)]
        .slice(0, 20)
        .map((input) => outputInfo(index, input)),
      ...(step.valueInputIds?.length
        ? {
            valueInputs: step.valueInputIds.map((input) =>
              outputInfo(index, input),
            ),
          }
        : {}),
      ...(step.parameters ? { parameters: step.parameters } : {}),
      ...(step.definition ? { definition: step.definition } : {}),
      ...(step.timeSettings ? { timeSettings: step.timeSettings } : {}),
      ...(step.expression ? { expression: step.expression } : {}),
      ...(step.within ? { within: step.within } : {}),
      ...(step.checks?.length ? { checkDefinitions: step.checks } : {}),
      ...(step.checkResults ? { checkResults: step.checkResults.results } : {}),
      ...(command ? { savedCommand: command } : {}),
      deleteImpact: impact
        .filter((item) => item.id !== step.id)
        .map((item) => `${stepReference(item)} ${stepName(item)}`),
    };
  }
  const source = findRecording(project, id);
  if (source)
    return {
      type: 'recording',
      ...recordings(project).find((item) => item.id === source.id),
    };
  const set = project.segmentSets?.find((item) => item.id === id);
  if (set) return { type: 'segment-set', ...segmentSets(project, set.id)[0] };
  const batch = batches(project).find((item) => item.id === id);
  if (batch) return { type: 'batch', ...batch };
  const node = index.nodes.get(id);
  const value = index.values.get(id);
  const segment = index.segments.get(id);
  if (!node && !value && !segment)
    throw new Error(
      `Nothing has the ID "${id}". Use list_history, list_recordings or search to find IDs.`,
    );
  const owner = index.owner.get(id);
  const lineage = index.lineage([id]);
  const usedBy = index.consumers.get(id) ?? [];
  return {
    type: index.kind(id),
    ...(node
      ? nodeDetails(index, node)
      : value
        ? valueDetails(index, value)
        : outputInfo(index, id)),
    ...(owner
      ? {
          producedBy: {
            id: owner.id,
            ref: stepReference(owner),
            name: stepName(owner),
          },
        }
      : {}),
    inputs: index
      .inputs(id)
      .slice(0, 20)
      .map((input) => outputInfo(index, input)),
    lineage: lineage.steps
      .slice(-12)
      .map((item) => `${stepReference(item)} ${stepName(item)}`),
    ...(lineage.steps.length > 12
      ? { earlierLineageSteps: lineage.steps.length - 12 }
      : {}),
    usedBy: usedBy
      .slice(0, 20)
      .map((item) => ({ id: item.id, name: stepName(item) })),
    ...(usedBy.length > 20 ? { moreUsedBy: usedBy.length - 20 } : {}),
  };
}

/** Word search over every step and output, like the command palette. */
export function search(project: Project, text: string, limit = 40) {
  const index = indexOf(project);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: (ReturnType<typeof outputInfo> & { recording: string })[] = [];
  const steps: { id: string; ref: string; name: string }[] = [];
  const hit = (label: string) =>
    words.every((word) => label.toLowerCase().includes(word));
  for (const step of project.workflowSteps ?? [])
    if (
      hit(
        `${stepName(step)} ${stepReference(step)} ${recordingName(project, step.sourceId)}`,
      )
    )
      steps.push({
        id: step.id,
        ref: stepReference(step),
        name: stepName(step),
      });
  const ids = [
    ...project.nodes.filter((node) => !node.internal).map((node) => node.id),
    ...(project.values ?? []).map((value) => value.id),
    ...index.segments.keys(),
  ];
  for (const id of ids) {
    if (matches.length >= limit) break;
    const record = index.nodes.get(id) ?? index.values.get(id);
    const recording = record ? recordingName(project, record.sourceId) : '';
    if (hit(`${index.label(id)} ${recording}`))
      matches.push({ ...outputInfo(index, id), recording });
  }
  return { steps: steps.slice(0, limit), outputs: matches };
}

/** The steps a request created or changed, by comparing projects. */
export function changedSteps(before: Project, after: Project) {
  const index = indexOf(after);
  const previous = new Map(
    (before.workflowSteps ?? []).map((step) => [step.id, step]),
  );
  return (after.workflowSteps ?? [])
    .filter((step) => {
      const old = previous.get(step.id);
      return (
        !old ||
        old.revision !== step.revision ||
        old.name !== step.name ||
        JSON.stringify(old.checks) !== JSON.stringify(step.checks)
      );
    })
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => stepSummary(index, step, 20));
}

/** Steps a request removed (Delete, Undo of a creation). */
export function removedSteps(before: Project, after: Project) {
  const remaining = new Set((after.workflowSteps ?? []).map((step) => step.id));
  return (before.workflowSteps ?? [])
    .filter((step) => !remaining.has(step.id))
    .map((step) => ({
      id: step.id,
      ref: stepReference(step),
      name: stepName(step),
    }));
}
