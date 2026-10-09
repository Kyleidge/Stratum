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
 * Names chosen when a step is created. A Segment step takes the name itself
 * (its segments stay numbered). One output takes the name exactly. Several
 * outputs fill `{input}`, `{segment}` and `{n}`; without them the name
 * replaces the operation's title in each automatic name, and also names the
 * step.
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
  const tokens = hasNameToken(name);
  const labels: Record<string, string> = {};
  step.outputIds.forEach((id, position) => {
    const input = outputInputLabel(index, id);
    const within = outputSegmentLabel(index, id);
    // An input already within the segment names it.
    const segment = input.startsWith(within) ? '' : within;
    const label = tokens
      ? name
          .replaceAll('{n}', String(position + 1))
          .replaceAll('{input}', () => input)
          .replaceAll('{segment}', () => within)
      : // Automatic names read "Speed · Moving average" for signals and
        // "Mean · Speed" for values; the chosen name replaces the title.
        (index.values.has(id) ? [name, segment, input] : [segment, input, name])
          .filter(Boolean)
          .join(' · ');
    const trimmed = label.slice(0, 160).trim();
    if (trimmed) labels[id] = trimmed;
  });
  return { labels, ...(tokens ? {} : { stepName: name }) };
}
