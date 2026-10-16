import { Envelope } from '../signal-math';
import { SignalGraph } from '../signal-graph';
import { FUNCTIONS } from '../signal-functions';
import {
  ARITHMETIC_SYMBOLS,
  arithmeticUnit,
  isArithmetic,
  isBinaryOperation,
} from '../signal-arithmetic';
import { boundValueIds, withValueInputs } from '../workflow-history';
import {
  scopeSegments,
  segmentEntries,
  signalSegment,
  visibleInput,
} from '../file-segments';
import { compileFormula } from '../formula';
import { belowNyquist } from '../signal-filters';
import { unitConversion } from '../units';
import { BINDABLE_DERIVE, resolveBinding } from '../value-bindings';
import type {
  BoundValue,
  ParameterBindings,
  WorkflowStep,
} from '../workflow-types';
import type {
  DerivePreview,
  FormulaSettings,
  Operation,
  Plot,
  SegmentScope,
  SignalNode,
} from '../signal-types';
import { uid, nextStepSequence } from './store';
import { EngineValues } from './values';

/**
 * Derived signals: unary, binary, formula and unit conversion nodes, their
 * previews and outputs within segments.
 */
export abstract class EngineDerive extends EngineValues {
  /** A two-input recipe node. Both inputs must share one sample grid. */
  protected binaryNode(
    sourceId: string,
    operation: Operation,
    firstId: string,
    secondId: string,
    labels?: Record<string, string>,
  ): SignalNode {
    if (this.gridRecipe(firstId) !== this.gridRecipe(secondId))
      throw new Error(
        'Inputs need matching sample grids and time transformations.',
      );
    const a = this.find(firstId),
      b = this.find(secondId);
    if (
      operation === 'power' &&
      (!/^n[· ]?m$/i.test(a.unit) || b.unit.toLowerCase() !== 'rpm')
    )
      throw new Error(
        'Brake power requires torque [Nm] followed by speed [rpm].',
      );
    if (
      operation === 'bsfc' &&
      (!/^kg\/h$/i.test(a.unit) || b.unit.toLowerCase() !== 'kw')
    )
      throw new Error(
        'Specific fuel consumption requires fuel flow [kg/h] followed by power [kW].',
      );
    return this.node(
      sourceId,
      isArithmetic(operation)
        ? `${(labels?.[a.id] ?? a.name).slice(0, 64)} ${ARITHMETIC_SYMBOLS[operation]} ${(labels?.[b.id] ?? b.name).slice(0, 64)}`
        : operation === 'power'
          ? 'Brake power'
          : 'Specific fuel consumption',
      isArithmetic(operation)
        ? arithmeticUnit(operation, a.unit, b.unit)
        : operation === 'power'
          ? 'kW'
          : 'g/kWh',
      operation,
      [firstId, secondId],
    );
  }
  async derive(parentId: string, operation: Operation, value: number) {
    return (await this.deriveMany([parentId], operation, value))[0];
  }
  async deriveMany(
    parentIds: string[],
    operation: Operation,
    constant: number,
    persist = true,
    bindings?: ParameterBindings,
    extra: {
      unit?: string;
      formula?: FormulaSettings;
      within?: SegmentScope;
    } = {},
  ): Promise<SignalNode[]> {
    if (extra.within) {
      if (!persist) throw new Error('Preview segments with derive-preview.');
      const { within, ...rest } = extra;
      const signals = rest.formula?.signals ?? {};
      return this.deriveWithin(
        within,
        parentIds,
        [...new Set(Object.values(signals).flat())],
        async (inputs, crop) => {
          const letters = Object.entries(rest.formula?.signals ?? {}).map(
            ([letter, ids]) =>
              [letter, ids.flatMap((id) => crop(id) ?? [])] as const,
          );
          // A segment where a formula signal has no samples is skipped.
          if (letters.some(([, ids]) => !ids.length)) return [];
          return this.deriveMany(inputs, operation, constant, false, bindings, {
            ...rest,
            ...(rest.formula
              ? {
                  formula: {
                    ...rest.formula,
                    ...(rest.formula.signals
                      ? { signals: Object.fromEntries(letters) }
                      : {}),
                  },
                }
              : {}),
          });
        },
      );
    }
    if (
      !FUNCTIONS.some(
        (spec) =>
          spec.operation !== 'segment' &&
          !isBinaryOperation(spec.operation) &&
          spec.operation === operation,
      )
    )
      throw new Error(
        'Choose an implemented single-input function. Segmentation and two-input calculations use their own input settings.',
      );
    if (!parentIds.length || new Set(parentIds).size !== parentIds.length)
      throw new Error('Choose unique inputs for this operation.');
    if (operation === 'formula' || operation === 'convert') {
      const nodes =
        operation === 'formula'
          ? this.formulaNodes(parentIds, extra, bindings)
          : this.convertNodes(parentIds, extra.unit, bindings);
      if (persist)
        await this.save({
          ...this.project,
          nodes: [...this.project.nodes, ...nodes],
        });
      return nodes;
    }
    if (extra.unit !== undefined || extra.formula)
      throw new Error('Only formulas and conversions take a unit.');
    for (const key of Object.keys(bindings ?? {}))
      if (key !== 'value' || !BINDABLE_DERIVE[operation])
        throw new Error(
          'Only offsets, scale factors and time shifts can come from values.',
        );
    const binding = bindings?.value;
    const context = binding ? this.bindingContext() : undefined;
    const nodes: SignalNode[] = [];
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    for (const parentId of parentIds) {
      this.check();
      const parent = this.find(parentId);
      const bound = binding
        ? resolveBinding(
            context!,
            binding,
            parentId,
            BINDABLE_DERIVE[operation]!,
            operation === 'offset'
              ? 'offset'
              : operation === 'scale'
                ? 'scale factor'
                : 'time shift',
            parent.unit,
          )
        : undefined;
      const value = bound ? bound.number : constant;
      if (!Number.isFinite(value)) throw new Error('Enter a finite parameter.');
      if (
        operation === 'raw' ||
        operation === 'crop' ||
        operation === 'power' ||
        operation === 'bsfc'
      )
        throw new Error(
          'This operation requires a segment or multiple inputs.',
        );
      if (
        operation === 'smooth' &&
        (!Number.isInteger(value) || value < 1 || value > 100000)
      )
        throw new Error('Window must be 1–100,000 samples.');
      if (
        operation === 'median' &&
        (!Number.isInteger(value) || value < 1 || value > 1001)
      )
        throw new Error('Median window must be 1–1,001 whole samples.');
      if (operation === 'exponential' && (value <= 0 || value > 1))
        throw new Error(
          'Smoothing factor must be greater than 0 and at most 1.',
        );
      if (
        (operation === 'low-pass' ||
          operation === 'high-pass' ||
          operation === 'butterworth-low' ||
          operation === 'butterworth-high') &&
        value <= 0
      )
        throw new Error('Cutoff frequency must be greater than 0 Hz.');
      if (operation === 'resample' && (value < 0.01 || value > 10000))
        throw new Error('Sample rate must be 0.01–10,000 Hz.');
      if (
        operation === 'resample' &&
        (this.bounds(parentId)[1] - this.bounds(parentId)[0]) * value >
          100000000
      )
        throw new Error(
          'This rate would produce over 100 million samples. Choose a lower rate.',
        );
      const labels: Partial<Record<Operation, string>> = {
        smooth: 'Smoothed',
        median: 'Median filtered',
        exponential: 'Exponentially smoothed',
        'low-pass': 'Low-pass filtered',
        'high-pass': 'High-pass filtered',
        'butterworth-low': 'Butterworth low-pass',
        'butterworth-high': 'Butterworth high-pass',
        scale: 'Scaled',
        offset: 'Offset',
        absolute: 'Absolute',
        derivative: 'Derivative',
        integral: 'Integral',
        'min-max': 'Min / Max',
        'time-shift': 'Time shifted',
        'zero-time': 'Zeroed',
        resample: 'Resampled',
      };
      const unit =
        operation === 'derivative'
          ? `${parent.unit}/s`
          : operation === 'integral'
            ? `${parent.unit}·s`
            : operation === 'scale' && bound
              ? arithmeticUnit('multiply', parent.unit, bound.value.unit)
              : parent.unit;
      const n = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · ${labels[operation]}`,
        unit,
        operation,
        [parentId],
        { value },
      );
      n.color = parent.color;
      n.batchId = batchId;
      if (bound)
        n.bindings = {
          value: { valueId: bound.valueId, factor: bound.factor },
        };
      if (operation === 'butterworth-low' || operation === 'butterworth-high') {
        // The nominal rate is the median of the first 1,000 intervals, read
        // across chunks (a crop's first chunk can hold a single sample).
        const steps: number[] = [];
        let previous: number | undefined;
        const stream = this.evaluate(parentId);
        try {
          for await (const chunk of stream) {
            for (let i = 0; i < chunk.time.length && steps.length < 1000; i++) {
              if (previous !== undefined) steps.push(chunk.time[i] - previous);
              previous = chunk.time[i];
            }
            if (steps.length >= 1000) break;
          }
        } finally {
          await stream.return(undefined);
        }
        steps.sort((a, b) => a - b);
        const interval = steps[Math.floor(steps.length / 2)];
        if (!(interval > 0))
          throw new Error(
            'This filter needs at least two samples at a regular interval.',
          );
        const rate = 1 / interval;
        if (!belowNyquist(value, rate))
          throw new Error(
            `The cutoff must be below half the sample rate (${Number((rate / 2).toPrecision(4))} Hz).`,
          );
        n.parameters.rate = rate;
      }
      if (operation === 'resample') {
        const first = await this.evaluate(parentId).next();
        const t = first.value?.time;
        const spacing = t && t.length > 1 ? t[1] - t[0] : 1 / value;
        n.parameters.maxGap = spacing * 5;
        const start = this.bounds(parentId)[0];
        if (start + 1 / value <= start)
          throw new Error(
            'Align this signal to zero before resampling at this rate.',
          );
      }
      nodes.push(n);
    }
    if (persist)
      await this.save({
        ...this.project,
        nodes: [...this.project.nodes, ...nodes],
      });
    return nodes;
  }
  /**
   * Formula outputs, one per input A. Other signal variables use the
   * candidate on A's sample grid; value variables are resolved per input.
   */
  private formulaNodes(
    parentIds: string[],
    extra: { unit?: string; formula?: FormulaSettings },
    bindings?: ParameterBindings,
  ): SignalNode[] {
    if (!extra.formula) throw new Error('Enter a formula.');
    const formula = compileFormula(extra.formula.expression);
    const unit = (extra.unit ?? '').trim();
    if (unit.length > 40)
      throw new Error('Keep the output unit to 40 characters.');
    const letters = formula.signals.slice(1);
    for (const key of Object.keys(extra.formula.signals ?? {}))
      if (!letters.includes(key))
        throw new Error(`The formula does not use ${key}.`);
    for (const key of Object.keys(bindings ?? {}))
      if (!formula.values.includes(key))
        throw new Error(`The formula does not use "${key}".`);
    for (const name of formula.values)
      if (!bindings?.[name]) throw new Error(`Choose a value for "${name}".`);
    const context = formula.values.length ? this.bindingContext() : undefined;
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    return parentIds.map((parentId) => {
      this.check();
      const parent = this.find(parentId);
      const grid = this.gridRecipe(parentId);
      const others = letters.map((letter) => {
        const candidates = extra.formula!.signals?.[letter] ?? [];
        if (!candidates.length)
          throw new Error(`Choose a signal for ${letter}.`);
        const matched =
          candidates.length === 1
            ? candidates
            : candidates.filter((id) => this.gridRecipe(id) === grid);
        if (matched.length !== 1)
          throw new Error(
            matched.length
              ? `Several ${letter} signals share the sample grid of ${parent.name}. Choose one.`
              : `No ${letter} signal shares the sample grid of ${parent.name}.`,
          );
        if (this.gridRecipe(matched[0]) !== grid)
          throw new Error(
            `${letter} needs the same sample grid and time transformations as ${parent.name}. Use Compare & align first.`,
          );
        return matched[0];
      });
      const parameters: Record<string, number> = {};
      const bound: Record<string, BoundValue> = {};
      for (const name of formula.values) {
        const result = resolveBinding(
          context!,
          bindings![name],
          parentId,
          'any',
          `"${name}"`,
        );
        parameters[name] = result.number;
        bound[name] = { valueId: result.valueId, factor: result.factor };
      }
      const node = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · Formula`,
        unit,
        'formula',
        [parentId, ...others],
        parameters,
      );
      node.expression = formula.expression;
      node.color = parent.color;
      node.batchId = batchId;
      if (formula.values.length) node.bindings = bound;
      return node;
    });
  }
  /** Unit conversions, one per input, with exact linear factors. */
  private convertNodes(
    parentIds: string[],
    unit: string | undefined,
    bindings?: ParameterBindings,
  ): SignalNode[] {
    if (bindings && Object.keys(bindings).length)
      throw new Error('Unit conversions take no values.');
    const target = (unit ?? '').trim();
    if (!target) throw new Error('Choose the unit to convert to.');
    const batchId = uid();
    const mixedSources =
      new Set(parentIds.map((id) => this.find(id).sourceId)).size > 1;
    return parentIds.map((parentId) => {
      const parent = this.find(parentId);
      const conversion = unitConversion(parent.unit, target);
      if (!conversion)
        throw new Error(
          `Stratum has no conversion from ${parent.unit || 'no unit'} to ${target}.`,
        );
      const node = this.node(
        mixedSources ? '' : parent.sourceId,
        `${parent.name.split(' · ')[0]} · in ${target}`,
        target,
        'convert',
        [parentId],
        conversion,
      );
      node.color = parent.color;
      node.batchId = batchId;
      return node;
    });
  }
  /**
   * Evaluate a candidate derive operation without saving it. The candidate is
   * validated and built exactly as creation builds it; only bounded envelopes
   * of it and its inputs, each on its own time axis, are returned.
   */
  async previewDerived(request: {
    inputId: string;
    operation: Operation;
    parameter: number;
    bindings?: ParameterBindings;
    unit?: string;
    formula?: FormulaSettings;
    secondaryId?: string;
    range?: [number, number];
    within?: SegmentScope;
  }): Promise<DerivePreview> {
    if (request.within) return this.previewDerivedWithin(request);
    const input = this.find(request.inputId);
    const binary = isBinaryOperation(request.operation);
    let node: SignalNode;
    if (binary) {
      if (!request.secondaryId)
        throw new Error('Choose the second input for this calculation.');
      if (this.find(request.secondaryId).sourceId !== input.sourceId)
        throw new Error('Inputs must use the same recording.');
      node = this.binaryNode(
        input.sourceId,
        request.operation,
        input.id,
        request.secondaryId,
        this.project.labels,
      );
    } else
      [node] = await this.deriveMany(
        [input.id],
        request.operation,
        request.parameter,
        false,
        request.bindings,
        {
          ...(request.unit !== undefined ? { unit: request.unit } : {}),
          ...(request.formula ? { formula: request.formula } : {}),
        },
      );
    const graph = new SignalGraph({
      ...this.project,
      nodes: [...this.project.nodes, node],
    });
    // Every signal input in operation order: A, then B (or the formula's B, C …).
    const inputIds = binary
      ? [input.id, request.secondaryId!]
      : node.parents.slice(0, 8);
    const full = [node.id, ...inputIds].map((id) => graph.ranges.get(id)!);
    const domain: [number, number] = [
      Math.min(...full.map((range) => range[0])),
      Math.max(...full.map((range) => range[1])),
    ];
    const view = request.range ?? domain;
    const clip = (id: string): [number, number] | undefined => {
      const bounds = graph.ranges.get(id)!;
      const range: [number, number] = [
        Math.max(view[0], bounds[0]),
        Math.min(view[1], bounds[1]),
      ];
      return range[1] >= range[0] ? range : undefined;
    };
    const empty = (id: string): Plot => ({
      id,
      ...new Envelope(view[0], view[1]).finish(),
    });
    const outputRange = clip(node.id);
    let plot = empty(node.id);
    if (outputRange) {
      const envelope = new Envelope(...outputRange);
      for await (const chunk of this.execute(node.id, graph, outputRange))
        for (let i = 0; i < chunk.time.length; i++)
          envelope.add(chunk.time[i], chunk.values[i]);
      plot = { id: node.id, ...envelope.finish() };
    }
    const inputs: Plot[] = [];
    for (const id of inputIds) {
      const range = clip(id);
      inputs.push(range ? await this.plot(id, range) : empty(id));
    }
    return { node, plot, inputs, domain };
  }
  /**
   * A derive preview within the first chosen segment where the input has
   * samples: the candidate reads crops, and its inputs are shown over the
   * segment.
   */
  private async previewDerivedWithin(
    request: Parameters<EngineDerive['previewDerived']>[0],
  ): Promise<DerivePreview> {
    const within = request.within!;
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    const binary = isBinaryOperation(request.operation);
    const others = binary
      ? request.secondaryId
        ? [request.secondaryId]
        : []
      : [...new Set(Object.values(request.formula?.signals ?? {}).flat())];
    if (binary && !others.length)
      throw new Error('Choose the second input for this calculation.');
    for (const id of [request.inputId, ...others])
      this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    let node: SignalNode | undefined;
    let graph: SignalGraph | undefined;
    try {
      for (const segment of segments) {
        this.check();
        const crops = new Map<string, SignalNode>();
        const input = await this.segmentCrop(
          request.inputId,
          segment,
          entries,
          crops,
        );
        if (!input) continue;
        const mapped = new Map<string, string | undefined>();
        for (const id of others)
          mapped.set(id, await this.segmentCrop(id, segment, entries, crops));
        this.project = {
          ...before,
          nodes: [...before.nodes, ...crops.values()],
        };
        if (
          !binary &&
          Object.values(request.formula?.signals ?? {}).some(
            (ids) => !ids.some((id) => mapped.get(id)),
          )
        )
          continue;
        if (binary) {
          const second = mapped.get(others[0]);
          if (!second) continue;
          node = this.binaryNode(
            this.find(input).sourceId,
            request.operation,
            input,
            second,
            before.labels,
          );
        } else
          [node] = await this.deriveMany(
            [input],
            request.operation,
            request.parameter,
            false,
            request.bindings,
            {
              ...(request.unit !== undefined ? { unit: request.unit } : {}),
              ...(request.formula
                ? {
                    formula: {
                      ...request.formula,
                      ...(request.formula.signals
                        ? {
                            signals: Object.fromEntries(
                              Object.entries(request.formula.signals).map(
                                ([letter, ids]) => [
                                  letter,
                                  ids.flatMap((id) => mapped.get(id) ?? []),
                                ],
                              ),
                            ),
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          );
        graph = new SignalGraph({
          ...this.project,
          nodes: [...this.project.nodes, node],
        });
        break;
      }
    } finally {
      this.project = before;
    }
    if (!node || !graph)
      throw new Error('The input has no samples inside these segments.');
    // Inputs are shown as chosen, over the segment the candidate covers.
    const inputIds = (binary ? [request.inputId, ...others] : node.parents)
      .map((id) => visibleInput(graph!.nodes, id))
      .slice(0, 8);
    const domain = graph.ranges.get(node.id)!;
    const view: [number, number] = request.range
      ? [
          Math.max(domain[0], request.range[0]),
          Math.min(domain[1], request.range[1]),
        ]
      : domain;
    const envelope = new Envelope(...view);
    if (view[1] >= view[0])
      for await (const chunk of this.execute(node.id, graph, view))
        for (let i = 0; i < chunk.time.length; i++)
          envelope.add(chunk.time[i], chunk.values[i]);
    const inputs: Plot[] = [];
    for (const id of inputIds) {
      const bounds = this.bounds(id);
      const range: [number, number] = [
        Math.max(view[0], bounds[0]),
        Math.min(view[1], bounds[1]),
      ];
      inputs.push(
        range[1] >= range[0]
          ? await this.plot(id, range)
          : { id, ...new Envelope(view[0], view[1]).finish() },
      );
    }
    // The candidate is shown with the signals it crops and its segment.
    return {
      node: {
        ...node,
        parents: node.parents.map((id) => visibleInput(graph.nodes, id)),
        segmentId: signalSegment(graph.nodes, node.parents[0]),
      },
      plot: { id: node.id, ...envelope.finish() },
      inputs,
      domain,
    };
  }
  /**
   * Derived signals within segments: for each chosen segment, `create`
   * builds the outputs from crops of every signal input, so stateful
   * functions start at the segment's start. One step holds every output.
   */
  protected async deriveWithin(
    within: SegmentScope,
    inputIds: string[],
    otherIds: string[],
    create: (
      inputs: string[],
      crop: (id: string) => string | undefined,
    ) => Promise<SignalNode[]>,
  ) {
    const before = this.project;
    const { set, segments } = scopeSegments(before, within);
    if (!inputIds.length || new Set(inputIds).size !== inputIds.length)
      throw new Error('Choose unique inputs for this operation.');
    for (const id of [...inputIds, ...otherIds])
      this.checkSegmentInput(id, set);
    const entries = segmentEntries(before);
    const crops = new Map<string, SignalNode>();
    const outputs: SignalNode[] = [];
    const batchId = uid();
    try {
      for (const [position, segment] of segments.entries()) {
        this.check();
        this.progress(
          `Processing ${segment.name} · ${position + 1}/${segments.length}`,
          position / segments.length,
        );
        const mapped = new Map<string, string | undefined>();
        for (const id of [...inputIds, ...otherIds])
          mapped.set(id, await this.segmentCrop(id, segment, entries, crops));
        const inputs = inputIds.flatMap((id) => mapped.get(id) ?? []);
        if (!inputs.length) continue;
        this.project = {
          ...before,
          nodes: [...before.nodes, ...crops.values(), ...outputs],
        };
        for (const node of await create(inputs, (id) => mapped.get(id))) {
          node.segmentId = segment.id;
          node.batchId = batchId;
          outputs.push(node);
        }
        if (outputs.length > 10000)
          throw new Error('Limit this operation to 10,000 outputs.');
      }
    } finally {
      this.project = before;
    }
    if (!outputs.length)
      throw new Error(
        'The selected signals have no samples inside these segments.',
      );
    // Only crops an output reads are kept.
    const read = new Set(outputs.flatMap((node) => node.parents));
    const internal = [...crops.values()].filter((node) => read.has(node.id));
    const nodes = new Map(
      [...before.nodes, ...internal].map((node) => [node.id, node]),
    );
    const step: WorkflowStep = {
      id: uid(),
      sourceId: outputs[0].sourceId,
      sequence: nextStepSequence(before),
      createdAt: new Date().toISOString(),
      kind: 'derive',
      operation: outputs[0].operation,
      inputIds: [
        ...new Set(
          outputs.flatMap((node) =>
            node.parents.map((id) => visibleInput(nodes, id)),
          ),
        ),
      ],
      outputIds: outputs.map((node) => node.id),
      parameters: outputs[0].parameters,
      ...withValueInputs(boundValueIds(outputs)),
      within: structuredClone(within),
      segmentInputIds: segments.map((segment) => segment.id),
    };
    await this.save({
      ...before,
      nodes: [...before.nodes, ...internal, ...outputs],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    });
    return outputs;
  }
}
