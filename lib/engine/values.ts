import { boundValueIds, withValueInputs } from '../workflow-history';
import {
  isSegmentCrop,
  scopeSegments,
  segmentEntries,
  signalSegment,
} from '../file-segments';
import {
  statisticTime,
  statisticValue,
  valueSpec,
  valueTitle,
  valueUnit,
  type ScalarValue,
  type ParameterBindings,
  type ValueOperation,
  type ValueParameters,
  type ValueStatistics,
  type WorkflowStep,
} from '../workflow-types';
import { ValueAccumulator } from '../value-statistics';
import { VALUE_INPUT, valueMathResults } from '../value-math';
import type { FileSegment, SegmentScope, SignalNode } from '../signal-types';
import { uid, nextStepSequence } from './store';
import { EngineSegments } from './segments';

/**
 * Scalar values: statistics of signals, values within segments and
 * calculations from other values.
 */
export abstract class EngineValues extends EngineSegments {
  async calculateValues(
    inputIds: string[],
    operation: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    within?: SegmentScope,
    expression?: string,
    unit?: string,
  ) {
    if (operation === 'calculate') {
      if (within || parameters)
        throw new Error(
          'Calculations from values follow their input values; they take no segments or settings.',
        );
      return this.calculateFromValues(
        inputIds,
        expression ?? '',
        unit ?? '',
        bindings,
      );
    }
    if (expression !== undefined || unit !== undefined)
      throw new Error('Only calculations from values take a formula.');
    const spec = valueSpec(operation);
    if (!spec) throw new Error('Choose a supported value calculation.');
    this.checkBindings(bindings, spec.parameters ?? [], spec.name);
    if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
      throw new Error('Choose at least one unique signal.');
    if (inputIds.length > 10000)
      throw new Error('Limit a calculation to 10,000 signals.');
    if (within) {
      const before = this.project;
      if (
        inputIds.length * scopeSegments(before, within).segments.length >
        10000
      )
        throw new Error(
          'Limit a calculation to 10,000 values. Choose fewer signals or segments.',
        );
      const { values, segments } = await this.valuesWithin(
        within,
        inputIds,
        operation,
        parameters,
        bindings,
      );
      if (!values.length)
        throw new Error(
          'The selected signals have no samples inside these segments.',
        );
      if (values.length > 10000)
        throw new Error('Limit a calculation to 10,000 values.');
      const step: WorkflowStep = {
        id: uid(),
        sourceId: values[0].sourceId,
        sequence: nextStepSequence(before),
        createdAt: values[0].createdAt,
        kind: 'value',
        operation,
        inputIds: [...new Set(values.map((value) => value.inputId))],
        outputIds: values.map((value) => value.id),
        ...withValueInputs(boundValueIds(values)),
        ...(values[0].parameters
          ? { parameters: { ...values[0].parameters } }
          : {}),
        within: structuredClone(within),
        segmentInputIds: segments.map((segment) => segment.id),
      };
      await this.save({
        ...before,
        values: [...(before.values ?? []), ...values],
        workflowSteps: [...(before.workflowSteps ?? []), step],
      });
      return values;
    }
    const inputs = inputIds.map((id) => this.find(id));
    const mixedSources =
      new Set(inputs.map((node) => node.sourceId)).size !== 1;
    const batchId = uid(),
      createdAt = new Date().toISOString();
    const values: ScalarValue[] = [];
    for (const [index, input] of inputs.entries()) {
      this.check();
      this.progress(
        `Calculating ${spec.name.toLowerCase()} · ${index + 1}/${inputs.length}`,
        index / inputs.length,
      );
      const { parameters: settings, bound } = this.boundValueSettings(
        operation,
        parameters,
        bindings,
        input,
      );
      const statistics = await this.valueStatistics(
        input.id,
        operation,
        settings,
      );
      const [start, end] = this.bounds(input.id);
      const timestamp = statisticTime(statistics, operation);
      const segmentId = signalSegment(this.graph().nodes, input.id);
      values.push({
        ...(segmentId ? { segmentId } : {}),
        id: uid(),
        sourceId: mixedSources ? '' : input.sourceId,
        inputId: input.id,
        batchId,
        name: `${input.name} · ${valueTitle(operation, settings, input.unit)}`,
        unit: valueUnit(operation, input.unit),
        operation,
        ...(spec.parameters?.length ? { parameters: settings } : {}),
        ...(bound ? { bindings: bound } : {}),
        value: statisticValue(statistics, operation),
        sampleCount: statistics.sampleCount,
        validDuration: statistics.validDuration,
        start,
        end,
        createdAt,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(operation === 'time-of-minimum' && statistics.minimum !== null
          ? { level: statistics.minimum }
          : operation === 'time-of-maximum' && statistics.maximum !== null
            ? { level: statistics.maximum }
            : {}),
      });
    }
    await this.save({
      ...this.project,
      values: [...(this.project.values ?? []), ...values],
    });
    return values;
  }
  /**
   * A formula over calculated values: one result per input value (`a`),
   * other variables matched to each input by segment and lineage. Results
   * keep their input's signal, segment and interval; the unit is as chosen.
   */
  async calculateFromValues(
    inputIds: string[],
    expression: string,
    unit: string,
    bindings?: ParameterBindings,
  ) {
    const before = this.project;
    if (inputIds.length > 10000)
      throw new Error('Limit a calculation to 10,000 values.');
    if (unit.trim().length > 40)
      throw new Error('Keep the output unit to 40 characters.');
    const results = valueMathResults(
      this.bindingContext(),
      inputIds,
      expression,
      bindings,
    );
    const batchId = uid(),
      createdAt = new Date().toISOString();
    const mixedSources =
      new Set(results.map((result) => result.input.sourceId)).size !== 1;
    const title = valueTitle('calculate', {}, '', expression);
    const values: ScalarValue[] = results.map(
      ({ input, value, parameters, bindings: bound }) => ({
        ...(input.segmentId ? { segmentId: input.segmentId } : {}),
        id: uid(),
        sourceId: mixedSources ? '' : input.sourceId,
        inputId: input.inputId,
        batchId,
        name: `${input.name} · ${title}`,
        unit: unit.trim(),
        operation: 'calculate',
        expression,
        ...(Object.keys(parameters).length ? { parameters } : {}),
        bindings: bound,
        value,
        sampleCount: input.sampleCount,
        validDuration: input.validDuration,
        start: input.start,
        end: input.end,
        createdAt,
      }),
    );
    const others = [
      ...new Set(
        values.flatMap((value) =>
          Object.entries(value.bindings!).flatMap(([name, bound]) =>
            name === VALUE_INPUT ? [] : [bound.valueId],
          ),
        ),
      ),
    ];
    const step: WorkflowStep = {
      id: uid(),
      sourceId: values[0].sourceId,
      sequence: nextStepSequence(before),
      createdAt,
      kind: 'value',
      operation: 'calculate',
      inputIds: [...inputIds],
      outputIds: values.map((value) => value.id),
      ...withValueInputs(others),
      expression,
    };
    await this.save({
      ...before,
      values: [...(before.values ?? []), ...values],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    });
    return values;
  }
  /**
   * Exact statistics for every value calculation, from every finite sample,
   * with the result of `operation` when it takes settings.
   */
  async valueStatistics(
    id: string,
    operation?: ValueOperation,
    parameters?: ValueParameters,
  ): Promise<ValueStatistics> {
    const [start, end] = this.bounds(id);
    const accumulator = new ValueAccumulator(
      id,
      start,
      end,
      operation,
      parameters,
    );
    // A segment crop reads only its window of the input.
    const window: [number, number] | undefined = isSegmentCrop(this.find(id))
      ? [start, end]
      : undefined;
    for await (const chunk of this.evaluate(id, undefined, window)) {
      this.check();
      for (let i = 0; i < chunk.time.length; i++)
        accumulator.add(chunk.time[i], chunk.values[i]);
    }
    return accumulator.finish();
  }
  /** Value statistics for a dialog preview; nothing is saved. */
  async previewValues(
    ids: string[],
    operation?: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    within?: SegmentScope,
  ): Promise<ValueStatistics[]> {
    if (ids.length > 50) throw new Error('Preview up to 50 signals at once.');
    const spec = operation ? valueSpec(operation) : undefined;
    if (spec) this.checkBindings(bindings, spec.parameters ?? [], spec.name);
    // Within segments: the first 50 input and segment pairs.
    if (within)
      return (
        await this.valuesWithin(
          within,
          [...new Set(ids)],
          spec?.operation ?? 'time-average',
          parameters,
          bindings,
          true,
        )
      ).statistics;
    const statistics: ValueStatistics[] = [];
    for (const id of new Set(ids)) {
      this.check();
      statistics.push(
        spec?.parameters?.length
          ? await this.valueStatistics(
              id,
              spec.operation,
              this.boundValueSettings(
                spec.operation,
                parameters,
                bindings,
                this.find(id),
              ).parameters,
            )
          : await this.valueStatistics(id),
      );
    }
    return statistics;
  }
  /**
   * Each input's value within each chosen segment, read from the input
   * itself (filters keep their state from before the segment). Values on a
   * signal that already belongs to a segment keep that segment.
   */
  private async valuesWithin(
    within: SegmentScope,
    inputIds: string[],
    operation: ValueOperation,
    parameters?: ValueParameters,
    bindings?: ParameterBindings,
    preview = false,
  ): Promise<{
    values: ScalarValue[];
    statistics: ValueStatistics[];
    segments: FileSegment[];
  }> {
    const spec = valueSpec(operation)!;
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    for (const id of inputIds) this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    const batchId = uid(),
      createdAt = new Date().toISOString();
    const values: ScalarValue[] = [];
    const statistics: ValueStatistics[] = [];
    const total = segments.length * inputIds.length;
    try {
      for (const [position, segment] of segments.entries()) {
        if (preview && statistics.length >= 50) break;
        // Crops of every input in this segment, staged together.
        this.project = before;
        const crops = new Map<string, SignalNode>();
        const reads: (string | undefined)[] = [];
        for (const id of inputIds) {
          this.check();
          reads.push(await this.segmentCrop(id, segment, entries, crops));
        }
        this.project = {
          ...before,
          nodes: [...before.nodes, ...crops.values()],
        };
        for (const [index, id] of inputIds.entries()) {
          this.check();
          if (preview && statistics.length >= 50) break;
          if (!preview)
            this.progress(
              `Calculating ${spec.name.toLowerCase()} · ${position * inputIds.length + index + 1}/${total}`,
              (position * inputIds.length + index) / total,
            );
          const read = reads[index];
          if (!read) continue;
          const reading = this.find(read);
          const { parameters: settings, bound } = this.boundValueSettings(
            operation,
            parameters,
            bindings,
            reading,
          );
          const result = await this.valueStatistics(read, operation, settings);
          result.inputId = id;
          result.segmentId = segment.id;
          statistics.push(result);
          if (preview) continue;
          const input = this.find(id);
          const [start, end] = this.bounds(read);
          const timestamp = statisticTime(result, operation);
          values.push({
            id: uid(),
            sourceId: input.sourceId,
            inputId: id,
            batchId,
            name: `${input.name} · ${valueTitle(operation, settings, input.unit)}`,
            unit: valueUnit(operation, input.unit),
            operation,
            ...(spec.parameters?.length ? { parameters: settings } : {}),
            ...(bound ? { bindings: bound } : {}),
            value: statisticValue(result, operation),
            sampleCount: result.sampleCount,
            validDuration: result.validDuration,
            start,
            end,
            createdAt,
            segmentId: segment.id,
            ...(timestamp !== undefined ? { timestamp } : {}),
            ...(operation === 'time-of-minimum' && result.minimum !== null
              ? { level: result.minimum }
              : operation === 'time-of-maximum' && result.maximum !== null
                ? { level: result.maximum }
                : {}),
          });
        }
      }
    } finally {
      this.project = before;
    }
    return { values, statistics, segments };
  }
}
