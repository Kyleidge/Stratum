'use client';
import { ChevronLeft, ChevronRight, Compass, X } from 'lucide-react';
import { stepName } from '@/lib/workflow-history';
import { WORKFLOW_EXAMPLE } from '@/lib/workflow-example';
import type { Project } from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { WorkflowSelection } from './workflow-history';

export type TourStop = {
  target: WorkflowSelection;
  title: string;
  text: string;
};

const TOUR_STORAGE_KEY = 'stratum-example-tour-v1';

/** Whether the tour was closed on this device; it then no longer opens itself. */
export function tourDismissed(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissTour() {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, 'dismissed');
  } catch {
    // The tour still closes for this session.
  }
}

// One plain sentence per concept, by step kind and occurrence.
const TEXT: Record<string, string> = {
  import1:
    'A recording is imported once and never changes. Its columns become original signals, here motor speed and torque.',
  derive1:
    'Derive makes a new signal from others. Smoothing creates a derived signal and leaves the original untouched.',
  derive2:
    'Derive can also combine two signals. Details on the right traces this product back to the recording.',
  segment1:
    'Segment cuts a signal into parts by time ranges or triggers. Each run is an ordinary signal you can process further.',
  value1:
    'Value reduces each input to one number, such as an average or a peak. Here, the average product of each run.',
  segment2: 'Segments can be split again: Run 2 becomes two 20-second halves.',
  derive: 'Derive makes a new signal from others; its inputs never change.',
  segment: 'Segment cuts signals into parts you can process further.',
  value: 'Value reduces each input to one number.',
};
const LAST =
  'Details traces this value back to the recording. Edit any step and everything after it recalculates; Undo reverses any change.';

/**
 * Stops for the example recording's steps in order, ending on a value. Only
 * selects existing items; it never changes the workflow.
 */
export function exampleTourStops(project: Project): TourStop[] {
  const source = project.sources.find(
    (item) => item.exampleKey === WORKFLOW_EXAMPLE,
  );
  if (!source) return [];
  const steps = (project.workflowSteps ?? [])
    .filter((step) => step.sourceId === source.id && step.outputIds.length)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, 8);
  const seen = new Map<string, number>();
  const stops = steps.map((step: WorkflowStep): TourStop => {
    const count = (seen.get(step.kind) ?? 0) + 1;
    seen.set(step.kind, count);
    return {
      // One output is plotted on its own; several are shown together.
      target:
        step.outputIds.length === 1
          ? { kind: 'output', id: step.outputIds[0] }
          : { kind: 'step', id: step.id },
      title: stepName(step),
      text: TEXT[`${step.kind}${count}`] ?? TEXT[step.kind] ?? '',
    };
  });
  const lastValue = steps.findLast((step) => step.kind === 'value');
  if (lastValue) {
    const id = lastValue.outputIds.at(-1)!;
    const name = project.labels?.[id];
    stops.push({
      target: { kind: 'output', id },
      title: name ?? stepName(lastValue),
      text: LAST,
    });
  }
  return stops;
}

export function ExampleTour({
  stops,
  index,
  onGo,
  onClose,
}: {
  stops: TourStop[];
  index: number;
  onGo: (index: number) => void;
  onClose: () => void;
}) {
  const stop = stops[index];
  if (!stop) return null;
  const last = index === stops.length - 1;
  return (
    <section
      className="example-tour"
      aria-label="Example tour"
      aria-roledescription="tour"
    >
      <Compass size={16} aria-hidden className="example-tour-icon" />
      <div className="example-tour-body" aria-live="polite">
        <span className="example-tour-count">
          Example tour · {index + 1} of {stops.length}
        </span>
        <strong>{stop.title}</strong>
        <p>{stop.text}</p>
      </div>
      <div className="example-tour-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!index}
          onClick={() => onGo(index - 1)}
        >
          <ChevronLeft size={14} aria-hidden /> Back
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => (last ? onClose() : onGo(index + 1))}
        >
          {last ? (
            'Finish'
          ) : (
            <>
              Next <ChevronRight size={14} aria-hidden />
            </>
          )}
        </button>
      </div>
      <button
        type="button"
        className="example-tour-close"
        aria-label="Close the example tour"
        title="Close the tour. Start it again from the guide."
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </section>
  );
}
