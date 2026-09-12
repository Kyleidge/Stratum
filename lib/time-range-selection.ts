import type { SignalGraph } from './signal-graph';

export type TimeRange = [number, number];
export type RangeDrag = 'draw' | 'move' | 'start' | 'end';

export function rangeFields(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(',').map((field) => field.trim()));
}

export function validTimeRange(fields: string[]): TimeRange | undefined {
  if (
    fields.length !== 2 ||
    fields.some((field) => !field || !Number.isFinite(Number(field)))
  )
    return;
  const range: TimeRange = [Number(fields[0]), Number(fields[1])];
  return range[1] > range[0] ? range : undefined;
}

export function readTimeRanges(text: string): TimeRange[] {
  const rows = rangeFields(text);
  if (!rows.length || rows.length > 1000)
    throw new Error('Enter between 1 and 1,000 time ranges.');
  return rows.map((fields, index) => {
    const range = validTimeRange(fields);
    if (!range)
      throw new Error(
        `Range ${index + 1} needs a finite start and a later end.`,
      );
    return range;
  });
}

/** Segmentation uses recording time for local signals and the current axis for workspace outputs. */
export function segmentPlotDomain(graph: SignalGraph, id: string) {
  const node = graph.find(id);
  const offset = node.sourceId === '' ? 0 : (graph.offsets.get(id) ?? 0);
  const bounds = graph.ranges.get(id)!;
  return {
    offset,
    range: [bounds[0] - offset, bounds[1] - offset] as TimeRange,
    label:
      node.sourceId === ''
        ? (graph.timeReferences.get(id)?.name ?? 'Workspace time')
        : 'Recording time',
  };
}

/** Clamp whole-range moves without shortening them; crossing handles cannot invert a range. */
export function dragTimeRange(
  original: TimeRange,
  mode: RangeDrag,
  anchor: number,
  pointer: number,
  bounds: TimeRange,
): TimeRange {
  const clamp = (time: number) =>
    Math.max(bounds[0], Math.min(bounds[1], time));
  if (mode === 'draw')
    return [
      Math.min(clamp(anchor), clamp(pointer)),
      Math.max(clamp(anchor), clamp(pointer)),
    ];
  if (mode === 'move') {
    const delta = Math.max(
      bounds[0] - original[0],
      Math.min(bounds[1] - original[1], pointer - anchor),
    );
    return [original[0] + delta, original[1] + delta];
  }
  const epsilon = Math.max(
    (bounds[1] - bounds[0]) * 1e-9,
    Math.abs(pointer) * Number.EPSILON * 4,
  );
  return mode === 'start'
    ? [Math.min(original[1] - epsilon, clamp(pointer)), original[1]]
    : [original[0], Math.max(original[0] + epsilon, clamp(pointer))];
}
