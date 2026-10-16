import type { ActivePlot } from '@/components/plot-scratchpad';
import { MAX_ALIGNED } from '@/components/aligned-segments-plot';
import { segmentInterval, visibleInput } from '@/lib/file-segments';
import { formatCount } from '@/lib/format-count';
import { TRACE_COLORS } from '@/lib/plot-scratchpad';
import type { SignalGraph } from '@/lib/signal-graph';
import type { FileSegment, SegmentSet } from '@/lib/signal-types';
import { segmentSetSignals, segmentSignals } from '@/lib/workflow-drag';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';

/** Outputs of one operation drawn together on the Active plot. */
export const ACTIVE_LIMIT = 8;

/**
 * What Active plots for the selection: a signal, a value over its input, or
 * up to ACTIVE_LIMIT outputs of an operation. Colours follow each output's
 * position in its operation, so a member keeps its colour alone or with
 * siblings. Segment choosers' `onChange` is a placeholder the caller sets,
 * where it can select.
 */
export function activePlotFor({
  selectionKind,
  selectionId,
  index,
  graph,
  segmentViews,
  segmentSignalChoice,
  chooseSegmentSignals,
}: {
  selectionKind: 'step' | 'output';
  selectionId: string;
  index: WorkflowIndex;
  graph: SignalGraph;
  /**
   * How Active shows a step's segments, by step ID: 'all', 'aligned' or,
   * for steps within segments, one segment's ID.
   */
  segmentViews: Readonly<Record<string, string>>;
  /** Signals chosen to show over each segment set, by set ID. */
  segmentSignalChoice: Record<string, string[]>;
  chooseSegmentSignals: (setId: string, ids: string[]) => void;
}): ActivePlot {
  const key = `${selectionKind}:${selectionId}`;
  const colorOf = (id: string, ids: string[]) => {
    const owners = new Set(ids.map((item) => index.owner.get(item)?.id));
    const owner = index.owner.get(id);
    const slot =
      owners.size === 1 && owner
        ? owner.outputIds.indexOf(id)
        : ids.indexOf(id);
    return TRACE_COLORS[Math.max(0, slot) % TRACE_COLORS.length];
  };
  const withInputs = (valueIds: string[]) => {
    const inputs = [
      ...new Set(
        valueIds.flatMap((id) => {
          const input = index.values.get(id)?.inputId;
          return input && index.nodes.has(input) ? [input] : [];
        }),
      ),
    ];
    const colors = new Map(inputs.map((id) => [id, colorOf(id, inputs)]));
    return [
      ...inputs.map((id) => ({ id, color: colors.get(id)! })),
      ...valueIds.map((id) => ({
        id,
        color:
          colors.get(index.values.get(id)?.inputId ?? '') ?? TRACE_COLORS[0],
      })),
    ];
  };
  const segmentOptions = (segments: FileSegment[]) => [
    {
      value: 'all',
      label: `All ${formatCount(segments.length, 'segment')}`,
    },
    { value: 'aligned', label: 'Aligned from start' },
    ...segments.slice(0, 500).map((item) => ({
      value: item.id,
      label: `${index.segmentLabel(item.id)} · ${segmentInterval(item, 2)}`,
    })),
  ];
  const segmentNames = (segments: FileSegment[]) =>
    segments.map((item) => ({
      id: item.id,
      name: index.segmentLabel(item.id),
    }));
  // A derive step within segments: every segment's outputs, one segment's,
  // or each input's outputs aligned from their segments' starts.
  const withinPlot = (owner: WorkflowStep): ActivePlot | undefined => {
    const outputs = owner.outputIds.flatMap((id) => {
      const node = index.nodes.get(id);
      return node?.segmentId ? [node] : [];
    });
    if (outputs.length < 2) return undefined;
    const order = new Map(
      [...index.segments.keys()].map((id, k) => [id, k] as const),
    );
    const segments = [...new Set(outputs.map((node) => node.segmentId!))]
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .flatMap((id) => index.segments.get(id)?.segment ?? []);
    const inputs = [
      ...new Set(
        outputs.map((node) => visibleInput(index.nodes, node.parents[0])),
      ),
    ];
    const inputOf = (id: string) =>
      visibleInput(index.nodes, index.nodes.get(id)!.parents[0]);
    const view = segmentViews[owner.id] ?? 'all';
    const chosen = segments.find((segment) => segment.id === view);
    const choice = chosen ? chosen.id : view === 'aligned' ? view : 'all';
    // One colour per input; segments are told apart by their bands.
    const colorOfInput = (id: string) =>
      TRACE_COLORS[Math.max(0, inputs.indexOf(id)) % TRACE_COLORS.length];
    const members = outputs.filter(
      (node) => !chosen || node.segmentId === chosen.id,
    );
    const shown = members.slice(0, MAX_ALIGNED);
    const shift = (id: string) => graph.offsets.get(id) ?? 0;
    const first = shown[0]?.id ?? outputs[0].id;
    return {
      key: `step:${owner.id}:${choice}`,
      title: chosen
        ? `${stepName(owner)} · ${index.segmentLabel(chosen.id)}`
        : stepName(owner),
      segments: {
        value: choice,
        options: segmentOptions(segments),
        onChange: () => {},
        ...(choice === 'aligned'
          ? {
              aligned: {
                segments: segmentNames(segments),
                groups: inputs.map((input) => ({
                  id: input,
                  traces: outputs
                    .filter((node) => inputOf(node.id) === input)
                    .map((node) => ({
                      segmentId: node.segmentId!,
                      signalId: node.id,
                      start:
                        graph.ranges.get(node.id)?.[0] ??
                        index.segments.get(node.segmentId!)!.segment.start,
                    })),
                })),
              },
            }
          : {}),
      },
      traces: shown.map((node) => ({
        id: node.id,
        color: colorOfInput(inputOf(node.id)),
      })),
      bands: segments.map((segment) => ({
        id: segment.id,
        name: index.segmentLabel(segment.id),
        start: segment.start + shift(first),
        end: segment.end + shift(first),
        selected: segment.id === chosen?.id,
      })),
      ...(chosen
        ? {
            focus: [chosen.start + shift(first), chosen.end + shift(first)] as [
              number,
              number,
            ],
          }
        : {}),
      note:
        members.length > shown.length
          ? `Showing ${shown.length} of ${members.length} signals. Choose a segment, or Aligned from start, to see others.`
          : undefined,
    };
  };
  // Segments are intervals of the whole recording, shaded over any of its
  // signals: those chosen for the set, else the signals that found them.
  const segmentPlot = (set: SegmentSet, selected?: string): ActivePlot => {
    const choices = segmentSetSignals(index, graph.timeReferences, set);
    const chosen = (segmentSignalChoice[set.id] ?? []).filter((id) =>
      choices.includes(id),
    );
    const signals = chosen.length
      ? chosen
      : segmentSignals(index, set.segments[0]?.id ?? '');
    const shown = signals.slice(0, ACTIVE_LIMIT);
    const offset = set.sourceId ? (graph.offsets.get(shown[0]) ?? 0) : 0;
    const segment = set.segments.find((item) => item.id === selected);
    const owner = index.owner.get(set.segments[0]?.id ?? '');
    const aligned =
      !selected && !!owner && segmentViews[owner.id] === 'aligned';
    const choice = selected ?? (aligned ? 'aligned' : 'all');
    return {
      key: aligned ? `${key}:aligned` : key,
      segments: {
        value: choice,
        options: segmentOptions(set.segments),
        // Set outside the memo, where it can select.
        onChange: () => {},
        ...(aligned
          ? {
              aligned: {
                segments: segmentNames(set.segments),
                groups: shown.map((id) => {
                  const shift = set.sourceId ? (graph.offsets.get(id) ?? 0) : 0;
                  return {
                    id,
                    traces: set.segments.map((item) => ({
                      segmentId: item.id,
                      signalId: id,
                      window: [item.start + shift, item.end + shift] as [
                        number,
                        number,
                      ],
                      start: item.start + shift,
                    })),
                  };
                }),
              },
            }
          : {}),
      },
      title: selected
        ? index.label(selected)
        : owner
          ? stepName(owner)
          : 'Segments',
      traces: shown.map((id) => ({ id, color: colorOf(id, shown) })),
      bands: set.segments.map((item) => ({
        id: item.id,
        name: index.label(item.id),
        start: item.start + offset,
        end: item.end + offset,
        selected: item.id === selected,
      })),
      ...(segment
        ? { focus: [segment.start + offset, segment.end + offset] }
        : {}),
      signals: {
        choices,
        limit: ACTIVE_LIMIT,
        onChange: (ids) => chooseSegmentSignals(set.id, ids),
      },
      note:
        signals.length > shown.length
          ? `Showing ${shown.length} of ${signals.length} signals of this recording.`
          : undefined,
    };
  };
  if (selectionKind === 'output') {
    const entry = index.segments.get(selectionId);
    if (entry) return segmentPlot(entry.set, selectionId);
    const title = index.label(selectionId);
    return {
      key,
      title,
      traces: index.values.has(selectionId)
        ? withInputs([selectionId])
        : index.nodes.has(selectionId)
          ? [{ id: selectionId, color: colorOf(selectionId, [selectionId]) }]
          : [],
    };
  }
  const owner = index.steps.get(selectionId);
  if (!owner) return { key, title: 'Your workflow', traces: [] };
  const ownSet = owner.segmentSetId
    ? index.project.segmentSets?.find((set) => set.id === owner.segmentSetId)
    : undefined;
  if (ownSet) return segmentPlot(ownSet);
  const within =
    owner.kind === 'derive' && owner.within ? withinPlot(owner) : undefined;
  if (within) return within;
  const values = owner.outputIds.filter((id) => index.values.has(id));
  const signals = owner.outputIds.filter((id) => index.nodes.has(id));
  const members = values.length ? values : signals;
  const shown = members.slice(0, ACTIVE_LIMIT);
  return {
    key,
    title: stepName(owner),
    traces: values.length
      ? withInputs(shown)
      : shown.map((id) => ({ id, color: colorOf(id, shown) })),
    note:
      members.length > shown.length
        ? `Showing ${shown.length} of ${members.length} outputs. Create a plot from History to compare all of them.`
        : undefined,
  };
}
