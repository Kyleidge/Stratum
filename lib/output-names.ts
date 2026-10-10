import type { WorkflowStep } from './workflow-types';
import type { WorkflowIndex } from './workflow-history';
import { visibleInput } from './file-segments';
import { calculatedInput } from './value-math';

/** Placeholders a name may use to tell several outputs apart. */
export const NAME_TOKENS = ['{input}', '{segment}', '{n}'] as const;

export const hasNameToken = (name: string) =>
  NAME_TOKENS.some((token) => name.includes(token));

/**
 * The signal an output was made from (never a hidden segment crop), or the
 * value a calculation used, by its display label.
 */
export function outputInputLabel(index: WorkflowIndex, id: string): string {
  const node = index.nodes.get(id);
  const value = index.values.get(id);
  const parent = node
    ? node.parents[0] && visibleInput(index.nodes, node.parents[0])
    : value && (calculatedInput(value) ?? value.inputId);
  return parent ? index.label(parent) : '';
}

/** The segment an output was made within, or a segment's parent. */
export function outputSegmentLabel(index: WorkflowIndex, id: string): string {
  const segment =
    index.nodes.get(id)?.segmentId ??
    index.values.get(id)?.segmentId ??
    index.segments.get(id)?.segment.parentId;
  return segment ? index.segmentLabel(segment) : '';
}

/**
 * Whether a step's outputs are named after it: a named Derive or Value step
 * with several outputs. Renaming the step renames them, except outputs that
 * were given names of their own.
 */
export const followsStepName = (step: WorkflowStep) =>
  !!step.name &&
  step.outputIds.length > 1 &&
  (step.kind === 'derive' || step.kind === 'value') &&
  !step.segmentSetId;

/**
 * The names a named step gives its outputs: its name, then whatever tells
 * them apart: their segment when they are in several, their input when one
 * segment holds several ("Phasing time · Segment 01"). Numbers settle any
 * outputs still alike.
 */
export function followedLabels(
  index: WorkflowIndex,
  step: WorkflowStep,
): Map<string, string> {
  const parts = step.outputIds.map((id) => ({
    segment: outputSegmentLabel(index, id),
    input: outputInputLabel(index, id),
  }));
  const bySegment = new Map<string, string>();
  let inputs = false;
  for (const { segment, input } of parts) {
    const seen = bySegment.get(segment);
    if (seen !== undefined && seen !== input) inputs = true;
    bySegment.set(segment, input);
  }
  const segments = bySegment.size > 1;
  const name = step.name ?? '';
  const labels = parts.map(({ segment, input }) =>
    [
      name,
      segments ? segment : '',
      // An input within the segment already names it.
      inputs
        ? segments && input.startsWith(`${segment} · `)
          ? input.slice(segment.length + 3)
          : input
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const alike = new Set(labels).size < labels.length;
  return new Map(
    step.outputIds.map((id, position) => [
      id,
      (alike ? `${labels[position]} ${position + 1}` : labels[position])
        .slice(0, 160)
        .trim(),
    ]),
  );
}

/**
 * Names chosen when a step is created. A Segment step takes the name itself
 * (its segments stay numbered). One output takes the name exactly. Several
 * outputs fill `{input}`, `{segment}` and `{n}` into names of their own;
 * without them the name names the step, and its outputs follow it
 * (`followedLabels`).
 */
export function chosenNames(
  index: WorkflowIndex,
  step: WorkflowStep,
  name: string,
): { labels: Record<string, string>; stepName?: string } {
  name = name.trim();
  if (!name) return { labels: {} };
  if (step.segmentSetId || step.kind === 'segment')
    return { labels: {}, stepName: name };
  if (step.outputIds.length === 1)
    return { labels: { [step.outputIds[0]]: name } };
  if (!hasNameToken(name)) return { labels: {}, stepName: name };
  const labels: Record<string, string> = {};
  step.outputIds.forEach((id, position) => {
    const input = outputInputLabel(index, id);
    const within = outputSegmentLabel(index, id);
    const label = name
      .replaceAll('{n}', String(position + 1))
      .replaceAll('{input}', () => input)
      .replaceAll('{segment}', () => within)
      .slice(0, 160)
      .trim();
    if (label) labels[id] = label;
  });
  return { labels };
}

/**
 * The name `chosenNames` gave an output of a step named `name` before
 * outputs followed their step, so a rename can let those follow too.
 */
export function earlierChosenName(
  index: WorkflowIndex,
  id: string,
  name: string,
): string {
  const input = outputInputLabel(index, id);
  const within = outputSegmentLabel(index, id);
  const segment = input.startsWith(within) ? '' : within;
  return (
    index.values.has(id) ? [name, segment, input] : [segment, input, name]
  )
    .filter(Boolean)
    .join(' · ')
    .slice(0, 160)
    .trim();
}
