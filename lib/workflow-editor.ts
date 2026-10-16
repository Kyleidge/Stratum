import type { SignalGraph } from '@/lib/signal-graph';
import { isBinaryOperation } from '@/lib/signal-arithmetic';
import type { TimeSettings } from '@/lib/time-types';
import type { WorkflowIndex } from '@/lib/workflow-history';
import { savedCommand } from '@/lib/workflow-lifecycle';
import type {
  ParameterBindings,
  ValueOperation,
  ValueParameters,
  WorkflowStep,
} from '@/lib/workflow-types';
import type {
  FormulaSettings,
  Operation,
  Project,
  SegmentationOperation,
  SegmentScope,
  SegmentSet,
  Source,
} from '@/lib/signal-types';
import { segmentationOperation } from '@/lib/segmentation-operation';
import { visibleInput } from '@/lib/file-segments';

/** The Derive, Segment or Value dialog's subject and saved settings. */
export type Editor = {
  editingStepId?: string;
  /** `calculate`: a formula over values; `ids` are values. */
  kind: 'derive' | 'segment' | 'value' | 'calculate';
  ids: string[];
  operation?: Operation | ValueOperation;
  parameter?: number;
  secondaryId?: string;
  valueParameters?: ValueParameters;
  bindings?: ParameterBindings;
  unit?: string;
  formula?: FormulaSettings;
  savedSegment?: SegmentationOperation;
  /** The segments the step works within. */
  within?: SegmentScope;
  /** Segment steps that find file segments (always, for new ones). */
  segmentSet?: { saved?: SegmentSet };
  /** A calculation from values: its formula. */
  expression?: string;
  /** Values whose signals a Value step was opened with, to switch back. */
  fromValues?: string[];
};

/**
 * A step's settings beyond its parameter (values, formula, unit), for
 * reopening its editor.
 */
export function savedBindingsOf(
  project: Project,
  step: WorkflowStep,
): Pick<Editor, 'bindings' | 'unit' | 'formula' | 'within'> {
  try {
    const command = savedCommand(project, step);
    const within = step.within ? { within: step.within } : {};
    if (command.type === 'calculate-values')
      return {
        ...within,
        ...(command.bindings ? { bindings: command.bindings } : {}),
        ...(command.unit !== undefined ? { unit: command.unit } : {}),
      };
    if (command.type !== 'derive-many') return within;
    return {
      ...within,
      ...(command.bindings ? { bindings: command.bindings } : {}),
      ...(command.unit !== undefined ? { unit: command.unit } : {}),
      ...(command.formula ? { formula: command.formula } : {}),
    };
  } catch {
    // Legacy recipes have no further settings to restore.
    return {};
  }
}

/** The Compare & align dialog: its inputs and, when reopened, settings. */
export type TimeEditor = {
  ids: string[];
  saved?: TimeSettings;
  editingId?: string;
  mode?: 'crop' | 'combine';
};

/**
 * The dialog that reopens `step`'s settings: Compare & align for time steps,
 * else the operation editor (`editing` edits the step in place). Undefined
 * when the step cannot be reopened.
 */
export function reopenStep(
  project: Project,
  index: WorkflowIndex,
  graph: SignalGraph,
  step: WorkflowStep,
  source: Source,
  inputIds: string[],
  editing: boolean,
): { time: TimeEditor } | { editor: Editor } | undefined {
  if (step.timeSettings)
    return {
      time: {
        ids: step.inputIds,
        saved: step.timeSettings,
        editingId: editing ? step.id : undefined,
      },
    };
  const open = (next: Editor) => ({
    editor: { ...next, editingStepId: editing ? step.id : undefined },
  });
  const nodeIds = step.inputIds.filter((id) => index.nodes.has(id));
  if (step.segmentSetId) {
    const set = project.segmentSets?.find(
      (item) => item.id === step.segmentSetId,
    );
    if (!set) return undefined;
    const sourceChannels =
      project.sources.find((item) => item.id === set.sourceId)?.channels ?? [];
    return open({
      kind: 'segment',
      ids: nodeIds.length ? nodeIds : sourceChannels.slice(0, 1),
      segmentSet: { saved: set },
      within: set.within,
      savedSegment: {
        id: set.id,
        sourceId: set.sourceId,
        definition: set.definition,
        targetIds: nodeIds,
        independently: false,
        scope: 'signals',
        segmentIds: [],
      },
    });
  }
  if (step.kind === 'segment') {
    const saved = step.segmentationId
      ? segmentationOperation(project, step.segmentationId)
      : undefined;
    const targets = saved?.targetIds ?? [
      ...new Set(
        step.outputIds.flatMap(
          (id) => index.nodes.get(id)?.parents.slice(0, 1) ?? [],
        ),
      ),
    ];
    const cropRanges: [number, number][] = step.outputIds.flatMap((id) => {
      const node = index.nodes.get(id);
      return node?.operation === 'crop'
        ? [
            [
              node.parameters.start - (graph.offsets.get(node.parents[0]) ?? 0),
              node.parameters.end - (graph.offsets.get(node.parents[0]) ?? 0),
            ] as [number, number],
          ]
        : [];
    });
    return open({
      kind: 'segment',
      ids: targets,
      savedSegment: saved ?? {
        id: step.id,
        sourceId: source.id,
        definition: {
          method: 'ranges',
          boundary: 'clip',
          ranges: cropRanges,
        },
        targetIds: targets,
        independently: targets.length > 1,
        scope: 'signals',
        segmentIds: [],
      },
    });
  } else if (step.kind === 'regions') {
    const set = project.regionSets?.find(
      (item) => item.id === step.regionSetId,
    );
    if (!set) return undefined;
    return open({
      kind: 'segment',
      ids: inputIds.length ? inputIds : source.channels,
      savedSegment: {
        id: step.id,
        sourceId: source.id,
        definition: {
          method: 'ranges',
          boundary: 'clip',
          ranges: set.regions.map((region) => [region.start, region.end]),
        },
        targetIds: inputIds.length ? inputIds : source.channels,
        independently: true,
        scope: 'signals',
        segmentIds: [],
      },
    });
  } else if (step.operation === 'calculate') {
    const saved = savedBindingsOf(project, step);
    return open({
      kind: 'calculate',
      ids: step.inputIds,
      ...(step.expression !== undefined ? { expression: step.expression } : {}),
      ...(saved.unit !== undefined ? { unit: saved.unit } : {}),
      ...(saved.bindings ? { bindings: saved.bindings } : {}),
    });
  } else if (step.kind === 'derive' || step.kind === 'value') {
    const binary = isBinaryOperation(step.operation);
    // Outputs within segments read hidden crops; name the signals cropped.
    const parents = step.outputIds.flatMap(
      (id) =>
        index.nodes
          .get(id)
          ?.parents.slice(0, 1)
          .map((parent) => visibleInput(index.nodes, parent)) ?? [],
    );
    const second = [
      ...new Set(
        step.outputIds.flatMap(
          (id) =>
            index.nodes
              .get(id)
              ?.parents.slice(1, 2)
              .map((parent) => visibleInput(index.nodes, parent)) ?? [],
        ),
      ),
    ];
    return open({
      kind: step.kind,
      // A formula's B, C … are settings; only A is a processing input.
      ids:
        binary || step.operation === 'formula'
          ? [...new Set(parents)]
          : nodeIds,
      operation: step.operation as Operation | ValueOperation,
      parameter: step.parameters?.value,
      secondaryId: second.length === 1 ? second[0] : '',
      ...(step.kind === 'value' && step.parameters
        ? { valueParameters: step.parameters }
        : {}),
      ...savedBindingsOf(project, step),
    });
  }
  return undefined;
}
