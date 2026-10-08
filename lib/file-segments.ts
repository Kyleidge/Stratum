import type {
  FileSegment,
  Project,
  SegmentScope,
  SegmentSet,
  SignalNode,
} from './signal-types';

/**
 * File segments: time intervals of a whole recording found by a Segment step.
 * Operations choose them with a `SegmentScope`; outputs created within a
 * segment carry its ID, and the hidden crops they read are internal nodes.
 */

export type SegmentEntry = { segment: FileSegment; set: SegmentSet };

/** Every file segment by ID, with its set. */
export function segmentEntries(project: Project): Map<string, SegmentEntry> {
  return new Map(
    (project.segmentSets ?? []).flatMap((set) =>
      set.segments.map((segment) => [segment.id, { segment, set }] as const),
    ),
  );
}

/** The segments a scope chooses, in their set's order. */
export function scopeSegments(
  project: Project,
  scope: SegmentScope,
): { set: SegmentSet; segments: FileSegment[] } {
  const set = project.segmentSets?.find((item) => item.id === scope.setId);
  if (!set)
    throw new Error(
      'The segments chosen for this step no longer exist. Choose other segments.',
    );
  if (scope.segmentIds) {
    const chosen = new Set(scope.segmentIds);
    if (
      !scope.segmentIds.length ||
      chosen.size !== scope.segmentIds.length ||
      scope.segmentIds.some(
        (id) => !set.segments.some((segment) => segment.id === id),
      )
    )
      throw new Error(
        'A chosen segment no longer exists. Choose the segments again.',
      );
    return {
      set,
      segments: set.segments.filter((segment) => chosen.has(segment.id)),
    };
  }
  if (!set.segments.length) throw new Error('This step found no segments.');
  return { set, segments: set.segments };
}

/** A hidden crop that reads one signal within one segment. */
export const isSegmentCrop = (node: SignalNode | undefined): boolean =>
  !!node?.internal && !!node.segmentId && node.operation === 'crop';

/**
 * The input a user chose for an output: hidden segment crops are replaced by
 * the signal they read.
 */
export function visibleInput(
  nodes: ReadonlyMap<string, SignalNode>,
  id: string,
): string {
  const node = nodes.get(id);
  return isSegmentCrop(node) ? node!.parents[0] : id;
}

/**
 * The segment a signal is restricted to: its own, or the nearest along its
 * first inputs. Iterative, so chain depth is unlimited.
 */
export function signalSegment(
  nodes: ReadonlyMap<string, SignalNode>,
  id: string,
): string | undefined {
  const seen = new Set<string>();
  for (
    let current: string | undefined = id;
    current !== undefined && !seen.has(current);
    current = nodes.get(current)?.parents[0]
  ) {
    seen.add(current);
    const segment = nodes.get(current)?.segmentId;
    if (segment) return segment;
  }
  return undefined;
}

/** Whether `ancestor` is `id` or contains it through nested segmentation. */
export function segmentWithin(
  entries: ReadonlyMap<string, SegmentEntry>,
  id: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>();
  for (
    let current: string | undefined = id;
    current !== undefined && !seen.has(current);
    current = entries.get(current)?.segment.parentId
  ) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

/** "12.5–40 s" for a segment's interval. */
export function segmentInterval(segment: Pick<FileSegment, 'start' | 'end'>) {
  const short = (value: number) => String(Number(value.toFixed(3)));
  return `${short(segment.start)}–${short(segment.end)} s`;
}
