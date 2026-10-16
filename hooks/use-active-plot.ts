'use client';
import { useCallback, useMemo, useState } from 'react';
import type { ActivePlot } from '@/components/plot-scratchpad';
import type { WorkflowSelection } from '@/components/workflow-history';
import { activePlotFor } from '@/lib/active-plot';
import type { SignalGraph } from '@/lib/signal-graph';
import type { WorkflowIndex } from '@/lib/workflow-history';
import {
  readStoredSegmentSignals,
  storeSegmentSignals,
} from '@/lib/workflow-preferences';
import type { WorkflowStep } from '@/lib/workflow-types';

/**
 * What Active plots for the selection, with its segment chooser and the
 * signals chosen for each segment set (device preferences).
 */
export function useActivePlot({
  index,
  graph,
  selection,
  step,
  select,
}: {
  index: WorkflowIndex;
  graph: SignalGraph;
  selection: WorkflowSelection;
  /** The viewed step, or the viewed output's. */
  step?: WorkflowStep;
  select: (next: WorkflowSelection) => void;
}): ActivePlot {
  const [segmentSignalChoice, setSegmentSignalChoice] = useState(
    readStoredSegmentSignals,
  );
  const chooseSegmentSignals = useCallback((setId: string, ids: string[]) => {
    setSegmentSignalChoice((old) => {
      const next = { ...old, [setId]: ids };
      if (!ids.length) delete next[setId];
      storeSegmentSignals(next);
      return next;
    });
  }, []);
  // How Active shows a step's segments, by step ID: 'all', 'aligned' or,
  // for steps within segments, one segment's ID.
  const [segmentViews, setSegmentViews] = useState<
    Readonly<Record<string, string>>
  >({});
  // The Active segment chooser. A Segment step selects one segment; a step
  // within segments stays selected and shows that segment's outputs.
  function chooseSegments(stepId: string, value: string) {
    const owner = index.steps.get(stepId);
    if (!owner) return;
    if (owner.segmentSetId && value !== 'all' && value !== 'aligned') {
      select({ kind: 'output', id: value });
      return;
    }
    setSegmentViews((old) => ({ ...old, [stepId]: value }));
    if (selection.kind !== 'step' || selection.id !== stepId)
      select({ kind: 'step', id: stepId });
  }
  const selectionKind = selection.kind,
    selectionId = selection.id;
  const plainActivePlot = useMemo<ActivePlot>(
    () =>
      activePlotFor({
        selectionKind,
        selectionId,
        index,
        graph,
        segmentViews,
        segmentSignalChoice,
        chooseSegmentSignals,
      }),
    [
      selectionKind,
      selectionId,
      index,
      graph,
      segmentViews,
      segmentSignalChoice,
      chooseSegmentSignals,
    ],
  );
  // The step whose segments the chooser shows.
  const chooserStep =
    selectionKind === 'output' ? index.owner.get(selectionId) : step;
  const activePlot: ActivePlot =
    plainActivePlot.segments && chooserStep
      ? {
          ...plainActivePlot,
          segments: {
            ...plainActivePlot.segments,
            onChange: (value) => chooseSegments(chooserStep.id, value),
          },
        }
      : plainActivePlot;
  return activePlot;
}
