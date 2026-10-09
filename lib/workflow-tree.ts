import type { WorkflowStep } from './workflow-types';
import { stepName, WorkflowIndex } from './workflow-history';
import { formatCount } from './format-count';

export type WorkflowRow = {
  key: string;
  /** `single` is one row for a step that made exactly one output. */
  kind: 'step' | 'output' | 'single' | 'more';
  step: WorkflowStep;
  outputId?: string;
  label: string;
  /** For `single` rows: the step's name, when it differs from the output's. */
  stepLabel?: string;
  /** Step and single rows: what the step was made from, in small text. */
  inputs?: string;
};

/**
 * Steps History shows as one row, never listing their outputs: Segment steps
 * and steps whose several outputs all belong to segments (made within them,
 * or from signals or values that were). The plot chooses among them.
 */
export function oneRowStep(step: WorkflowStep, index: WorkflowIndex) {
  if (step.segmentSetId) return true;
  if (step.outputIds.length < 2) return false;
  if (step.within) return true;
  return step.outputIds.every(
    (id) => (index.nodes.get(id) ?? index.values.get(id))?.segmentId,
  );
}

/**
 * What a step was made from, in History's small text: a Segment step's
 * recording, otherwise its input signals or values (the first two by name).
 */
export function stepInputSummary(
  step: WorkflowStep,
  index: WorkflowIndex,
): string | undefined {
  if (step.kind === 'import') return undefined;
  if (step.segmentSetId) {
    const set = index.project.segmentSets?.find(
      (item) => item.id === step.segmentSetId,
    );
    return set?.sourceId
      ? index.project.sources.find((source) => source.id === set.sourceId)?.name
      : 'Workspace time axis';
  }
  const inputs = [...new Set(step.inputIds)];
  if (!inputs.length) return undefined;
  const names = inputs.slice(0, 2).map((id) => index.label(id));
  const more =
    inputs.length > 2
      ? ` and ${formatCount(inputs.length - 2, 'more input', 'more inputs')}`
      : '';
  return `from ${names.join(', ')}${more}`;
}

/**
 * Two levels with bounded previews, or every member of one focused operation.
 * A step with exactly one output is a single row that stands for both.
 */
export function workflowRows(
  steps: WorkflowStep[],
  index: WorkflowIndex,
  collapsed: ReadonlySet<string>,
  query = '',
  selectedOutput?: string,
  contributingOutputs?: ReadonlySet<string>,
  focusedStepId?: string,
  outputKind: 'all' | 'signals' | 'values' = 'all',
): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  const search = query.trim().toLowerCase();
  for (const step of steps) {
    if (focusedStepId && step.id !== focusedStepId) continue;
    const label = stepName(step);
    const matchesStep =
      `#${String(step.sequence + 1).padStart(3, '0')} ${step.sequence + 1} ${label}`
        .toLowerCase()
        .includes(search);
    const candidates = step.outputIds.filter(
      (id) =>
        (!contributingOutputs || contributingOutputs.has(id)) &&
        (outputKind === 'all' ||
          (outputKind === 'values'
            ? index.values.has(id)
            : index.nodes.has(id))),
    );
    // Type filters show only steps that produced a matching output.
    if (outputKind !== 'all' && !candidates.length) continue;
    const outputs =
      search && !matchesStep
        ? candidates.filter((id) =>
            `${index.label(id)} ${index.kind(id)} ${index.nodes.get(id)?.unit ?? index.values.get(id)?.unit ?? ''}`
              .toLowerCase()
              .includes(search),
          )
        : candidates;
    if (search && !matchesStep && !outputs.length) continue;
    // A Segment step, or a step within segments, is one row: its outputs are
    // chosen on the plot, not listed, however many there are.
    const inputs = stepInputSummary(step, index);
    if (oneRowStep(step, index)) {
      rows.push({ key: step.id, kind: 'step', step, label, inputs });
      continue;
    }
    if (!focusedStepId && step.outputIds.length === 1 && outputs.length) {
      const id = outputs[0];
      const output = index.label(id);
      rows.push({
        key: `output:${id}`,
        kind: 'single',
        step,
        outputId: id,
        label: output,
        stepLabel:
          label.trim().toLowerCase() === output.trim().toLowerCase()
            ? undefined
            : label,
        inputs,
      });
      continue;
    }
    rows.push({ key: step.id, kind: 'step', step, label, inputs });
    if (!search && collapsed.has(step.id)) continue;
    const shown = focusedStepId ? [...outputs] : outputs.slice(0, 3);
    // A selected output is always revealed, including a member beyond the preview.
    if (
      selectedOutput &&
      outputs.includes(selectedOutput) &&
      !shown.includes(selectedOutput)
    )
      shown.push(selectedOutput);
    for (const id of shown)
      rows.push({
        key: `output:${id}`,
        kind: 'output',
        step,
        outputId: id,
        label: index.label(id),
      });
    if (outputs.length > shown.length)
      rows.push({
        key: `more:${step.id}`,
        kind: 'more',
        step,
        label: `View all ${outputs.length} outputs`,
      });
  }
  return rows;
}
