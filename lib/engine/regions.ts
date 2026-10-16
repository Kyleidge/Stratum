import { power } from '../signal-math';
import { isBinaryOperation } from '../signal-arithmetic';
import { visibleInput } from '../file-segments';
import { EXAMPLES, exampleDefinition } from '../signal-examples';
import { nextSequence, regionBindings, regionContains } from '../region-model';
import {
  REGION_EXAMPLES,
  type RegionSettings,
  type RegionPlan,
  type RegionSet,
  type Region,
  type FunctionSettings,
  type FunctionRun,
} from '../region-types';
import type { SignalNode } from '../signal-types';
import { COLORS, uid, nextStepSequence } from './store';
import { EngineImports } from './imports';

/**
 * Legacy region workspaces and the worked examples, kept so older
 * workspaces and their tests still open and replay.
 */
export abstract class EngineRegions extends EngineImports {
  async demo(withAnalysis = true) {
    const existing = this.project.sources.find((s) => s.synthetic);
    if (existing) return existing;
    const lines = [
      'Time [s],Engine speed [rpm],Torque [Nm],Fuel flow [kg/h],Oil temperature [°C]',
    ];
    for (let i = 0; i <= 18000; i++) {
      const t = i / 100;
      const ramp = Math.floor((t - 12) / 58);
      const local = t - 12 - Math.max(0, ramp) * 58;
      const active = ramp >= 0 && ramp < 3 && local >= 0 && local < 39;
      const x = Math.max(0, Math.min(1, local / 39));
      const rpm = active
        ? 1400 + 5200 * x + 10 * Math.sin(t * 17)
        : 870 + 18 * Math.sin(t * 4);
      const torque = active
        ? 210 +
          145 * Math.sin(x * Math.PI * 0.89) -
          16 * x +
          ramp * 3 +
          2.8 * Math.sin(t * 25)
        : 13 + 1.5 * Math.sin(t * 8);
      const efficiency = 239 + 70 * Math.pow(2 * x - 0.86, 2) + ramp * 2;
      const fuel = active
        ? (power(torque, rpm) * efficiency) / 1000 + 0.22 * Math.sin(t * 31)
        : 0.9 + 0.08 * Math.sin(t * 3);
      lines.push(
        [t, rpm, torque, fuel, 84 + t * 0.045 + Math.sin(t / 20)]
          .map((v) => v.toFixed(5))
          .join(','),
      );
    }
    const file = new File([lines.join('\n')], 'Dyno_Run_024.csv', {
      type: 'text/csv',
    });
    const source = await this.importCsv(file, true);
    if (!withAnalysis) return source;
    const segments = await this.segment(
      source.id,
      {
        method: 'triggers',
        start: {
          signalId: source.channels[0],
          edge: 'rising',
          threshold: 900,
          offset: 0,
        },
        end: {
          signalId: source.channels[0],
          edge: 'falling',
          threshold: 900,
          offset: 0,
        },
        minimumDuration: 0,
        boundary: 'clip',
      },
      source.channels,
    );
    await this.calculateSegmentMetrics(segments.map((segment) => segment.id));
    return source;
  }
  async example(key: string) {
    const spec = EXAMPLES.find((item) => item.key === key);
    if (!spec) throw new Error('Choose an available example.');
    const existing = this.project.examples?.find((item) => item.key === key);
    if (existing) return existing;
    // All examples share the small immutable demo recording. Only recipes are
    // added; reopening an example never duplicates its data or operation tree.
    const source = await this.demo();
    const input = spec.chain
      ? (await this.derive(source.channels[0], 'median', 5)).id
      : source.channels[0];
    const segments = await this.segment(
      source.id,
      exampleDefinition(key, input),
      spec.chain ? [input] : source.channels,
      false,
      spec.chain ? 'signals' : 'file',
    );
    let outputIds = segments.map((segment) => segment.nodes[0]);
    if (spec.chain) {
      const averages = await this.deriveMany(outputIds, 'smooth', 25);
      const extrema = await this.deriveMany(
        averages.map((node) => node.id),
        'min-max',
        0,
      );
      outputIds = extrema.map((node) => node.id);
    }
    const run = {
      key,
      sourceId: source.id,
      segmentationId: segments[0].batchId!,
      outputIds,
    };
    await this.save({
      ...this.project,
      examples: [...(this.project.examples ?? []), run],
    });
    return run;
  }
  async previewRegions(settings: RegionSettings): Promise<RegionPlan> {
    this.check();
    const source = this.project.sources.find(
      (item) => item.id === settings.sourceId,
    );
    if (!source) throw new Error('Choose a recording.');
    if (!settings.name.trim()) throw new Error('Name this region set.');
    const parent = settings.parentSetId
      ? this.project.regionSets?.find((set) => set.id === settings.parentSetId)
      : undefined;
    if (settings.parentSetId && (!parent || parent.sourceId !== source.id))
      throw new Error('Parent regions must use this recording’s clock.');
    const selected = settings.parentRegionIds;
    if (
      parent &&
      selected &&
      (!selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some(
          (id) => !parent.regions.some((region) => region.id === id),
        ))
    )
      throw new Error('Choose valid parent regions.');
    if (!parent && settings.timeReference === 'parent')
      throw new Error('Relative times require parent regions.');
    if (
      settings.previousId &&
      !this.project.regionSets?.some(
        (set) => set.id === settings.previousId && set.sourceId === source.id,
      )
    )
      throw new Error('The previous region version is unavailable.');
    const domains = parent
      ? parent.regions.filter(
          (region) => !selected || selected.includes(region.id),
        )
      : [undefined];
    const plan: RegionPlan = { regions: [], skipped: 0, incomplete: 0 };
    for (const region of domains) {
      this.check();
      const domain: [number, number] = region
        ? [region.start, region.end]
        : [source.start, source.end];
      const offset =
        settings.timeReference === 'parent' && region ? region.start : 0;
      const definition = structuredClone(settings.definition);
      if (definition.method === 'ranges')
        definition.ranges = definition.ranges.map(([a, b]) => [
          a + offset,
          b + offset,
        ]);
      if (definition.method === 'windows') {
        if (
          ![
            definition.start,
            definition.end,
            definition.duration,
            definition.step,
          ].every(Number.isFinite) ||
          definition.end <= definition.start ||
          definition.duration <= 0 ||
          definition.step <= 0
        )
          throw new Error(
            'Use a finite interval and positive window duration and step.',
          );
        definition.start += offset;
        definition.end += offset;
        // Tail handling is relative to each parent, never to another parent's extent.
        definition.end = Math.min(definition.end, domain[1]);
        if (definition.end <= definition.start) {
          plan.skipped++;
          continue;
        }
      }
      const intervals = await this.previewSegments(
        source.id,
        definition,
        [source.channels[0]],
        false,
        'signals',
        region ? domain : undefined,
        true,
      );
      plan.regions.push(
        ...intervals.ranges.map((boundary) => ({
          start: boundary.start,
          end: boundary.end,
          parentRegionId: region?.id,
          boundary,
          endInclusive:
            boundary.end === domain[1] &&
            (region?.endInclusive ?? boundary.end === source.end),
        })),
      );
      plan.skipped += intervals.skipped;
      plan.incomplete += intervals.incomplete;
      if (plan.regions.length > 1000)
        throw new Error(
          'This batch exceeds 1,000 regions. Select fewer parents or increase the window step.',
        );
    }
    return plan;
  }
  async createRegions(settings: RegionSettings): Promise<RegionSet> {
    const plan = await this.previewRegions(settings);
    if (!plan.regions.length)
      throw new Error(
        'No complete regions match. Preview the crossings or choose time ranges inside the parent.',
      );
    const previous = this.project.regionSets?.find(
      (set) => set.id === settings.previousId,
    );
    const set: RegionSet = {
      ...structuredClone(settings),
      id: uid(),
      name: settings.name.trim(),
      version: previous
        ? Math.max(
            previous.version,
            ...(this.project.regionSets ?? [])
              .filter(
                (set) =>
                  set.name === settings.name.trim() &&
                  set.sourceId === settings.sourceId,
              )
              .map((set) => set.version),
          ) + 1
        : 1,
      sequence: nextSequence(this.project),
      createdAt: new Date().toISOString(),
      regions: plan.regions.map((region, index) => ({
        ...region,
        id: uid(),
        name: `${settings.name.trim()} ${String(index + 1).padStart(2, '0')}`,
      })),
    };
    await this.save({
      ...this.project,
      regionSets: [...(this.project.regionSets ?? []), set],
    });
    return set;
  }
  async applyRegionFunction(settings: FunctionSettings): Promise<FunctionRun> {
    this.check();
    if (settings.within) {
      // Two-input functions within segments: one output per first input in
      // each segment, both read from crops of that segment.
      const secondary = settings.secondaryIds ?? [];
      if (!isBinaryOperation(settings.operation) || secondary.length !== 1)
        throw new Error('Choose one second input for this calculation.');
      const labels = this.project.labels ?? {};
      const outputs = await this.deriveWithin(
        settings.within,
        settings.inputIds,
        secondary,
        async (inputs, crop) => {
          const second = crop(secondary[0]);
          if (!second) return [];
          const names = Object.fromEntries(
            [...inputs, second].map((id) => {
              const read = visibleInput(this.graph().nodes, id);
              return [id, labels[read] ?? this.find(read).name];
            }),
          );
          return inputs.map((id) =>
            this.binaryNode(
              settings.sourceId,
              settings.operation,
              id,
              second,
              names,
            ),
          );
        },
      );
      return {
        ...structuredClone(settings),
        id: outputs[0].batchId!,
        sequence: nextStepSequence(this.project),
        createdAt: outputs[0].createdAt,
        outputs: outputs.map((node) => ({
          signalId: node.id,
          inputId: visibleInput(this.graph().nodes, node.parents[0]),
        })),
        skipped: 0,
      };
    }
    const before = this.project;
    const binary = isBinaryOperation(settings.operation);
    const inputs = settings.inputIds;
    const secondary = settings.secondaryIds ?? [];
    if (!inputs.length || new Set(inputs).size !== inputs.length)
      throw new Error('Choose unique input signals.');
    if (binary && !secondary.length)
      throw new Error('Choose the second input for this calculation.');
    for (const id of [...inputs, ...secondary])
      if (this.find(id).sourceId !== settings.sourceId)
        throw new Error('Inputs must use the same recording.');
    const set = settings.regionSetId
      ? before.regionSets?.find((item) => item.id === settings.regionSetId)
      : undefined;
    if (settings.regionSetId && (!set || set.sourceId !== settings.sourceId))
      throw new Error('Choose regions from this recording.');
    if (
      settings.regionIds &&
      (!set ||
        !settings.regionIds.length ||
        settings.regionIds.some(
          (id) => !set.regions.some((region) => region.id === id),
        ))
    )
      throw new Error('Choose valid processing regions.');
    const bindings = regionBindings(before);
    const allRegions = new Map(
      (before.regionSets ?? []).flatMap((item) =>
        item.regions.map((region) => [region.id, region] as const),
      ),
    );
    const contexts = set
      ? set.regions.filter(
          (region) =>
            !settings.regionIds || settings.regionIds.includes(region.id),
        )
      : [undefined];
    const jobs: {
      input: string;
      second?: string;
      region?: Region;
      boundId?: string;
    }[] = [];
    for (const region of contexts) {
      const eligible = (id: string) =>
        !region ||
        !bindings.has(id) ||
        regionContains(before, bindings.get(id)!, region.id, allRegions);
      const firstIds = inputs.filter(eligible);
      const secondIds = secondary.filter(eligible);
      for (const input of firstIds) {
        const boundId = region?.id ?? bindings.get(input);
        let second: string | undefined;
        if (binary) {
          const matched = secondIds.filter(
            (id) =>
              !bindings.has(id) ||
              (boundId &&
                regionContains(before, bindings.get(id)!, boundId, allRegions)),
          );
          if (matched.length !== 1)
            throw new Error(
              'Choose one matching second input per region. Select a signal or one result family.',
            );
          second = matched[0];
        }
        jobs.push({
          input,
          second,
          region:
            region ?? (second && boundId ? allRegions.get(boundId) : undefined),
          boundId,
        });
      }
    }
    if (!jobs.length)
      throw new Error(
        'The selected result family does not contain these regions. Use its own regions, child regions, or a full-recording signal.',
      );
    if (jobs.length > 10000)
      throw new Error('Limit this operation to 10,000 results per batch.');
    const internal: SignalNode[] = [];
    const outputs: SignalNode[] = [];
    const run: FunctionRun = {
      ...structuredClone(settings),
      id: uid(),
      createdAt: new Date().toISOString(),
      sequence: nextSequence(before),
      outputs: [],
      skipped: 0,
    };
    try {
      for (const job of jobs) {
        this.check();
        const previousInternalCount = internal.length;
        const ids = [job.input, ...(job.second ? [job.second] : [])];
        const scoped: string[] = [];
        let populated = true;
        for (const id of ids) {
          if (!job.region || bindings.get(id) === job.region.id) {
            scoped.push(id);
            continue;
          }
          const offset = this.axisOffset(id);
          const start = Math.max(this.bounds(id)[0], job.region.start + offset);
          const end = Math.min(this.bounds(id)[1], job.region.end + offset);
          const endExclusive =
            end === job.region.end + offset && !job.region.endInclusive;
          if (
            end < start ||
            !(await this.hasSample(id, start, end, endExclusive))
          ) {
            populated = false;
            break;
          }
          const parent = this.find(id);
          const view = this.node(
            settings.sourceId,
            parent.name,
            parent.unit,
            'crop',
            [id],
            { start, end, endExclusive: endExclusive ? 1 : 0 },
          );
          view.internal = true;
          internal.push(view);
          scoped.push(view.id);
        }
        if (!populated) {
          internal.length = previousInternalCount;
          run.skipped++;
          continue;
        }
        this.project = {
          ...before,
          nodes: [...before.nodes, ...internal, ...outputs],
        };
        let result: SignalNode;
        if (binary)
          result = this.binaryNode(
            settings.sourceId,
            settings.operation,
            scoped[0],
            scoped[1],
            before.labels,
          );
        else
          result = (
            await this.deriveMany(
              [scoped[0]],
              settings.operation,
              settings.parameter,
              false,
            )
          )[0];
        result.batchId = run.id;
        outputs.push(result);
        run.outputs.push({
          signalId: result.id,
          inputId: job.input,
          regionId: job.boundId,
        });
      }
    } finally {
      this.project = before;
    }
    if (!outputs.length)
      throw new Error(
        'The selected signals have no samples inside these regions.',
      );
    if (!run.regionSetId) {
      const associated = (before.regionSets ?? []).filter((item) =>
        run.outputs.every((output) =>
          item.regions.some((region) => region.id === output.regionId),
        ),
      );
      if (associated.length === 1) run.regionSetId = associated[0].id;
    }
    await this.save({
      ...before,
      nodes: [...before.nodes, ...internal, ...outputs],
      functionRuns: [...(before.functionRuns ?? []), run],
    });
    return run;
  }
  async regionExample(key: string) {
    if (!REGION_EXAMPLES.some((item) => item.key === key))
      throw new Error('Choose an available example.');
    const existing = this.project.regionExamples?.find(
      (item) => item.key === key,
    );
    if (existing) return existing;
    const source = await this.demo(false);
    const base =
      key !== 'ramps' ? await this.regionExample('ramps') : undefined;
    let set: RegionSet;
    let run: FunctionRun;
    if (key === 'ramps') {
      set = await this.createRegions({
        sourceId: source.id,
        name: 'Ramps',
        timeReference: 'recording',
        definition: {
          method: 'triggers',
          boundary: 'clip',
          minimumDuration: 0,
          start: {
            signalId: source.channels[0],
            edge: 'rising',
            threshold: 900,
            offset: 0,
          },
          end: {
            signalId: source.channels[0],
            edge: 'falling',
            threshold: 900,
            offset: 0,
          },
        },
      });
      const filtered = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: [source.channels[1]],
        operation: 'low-pass',
        parameter: 5,
      });
      const smooth = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: filtered.outputs.map((output) => output.signalId),
        regionSetId: set.id,
        operation: 'smooth',
        parameter: 25,
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: smooth.outputs.map((output) => output.signalId),
        operation: 'min-max',
        parameter: 0,
      });
    } else if (key === 'fuel') {
      set = this.project.regionSets!.find(
        (item) => item.id === base!.regionSetId,
      )!;
      const powerRun = await this.applyRegionFunction({
        sourceId: source.id,
        operation: 'power',
        parameter: 0,
        inputIds: [source.channels[1]],
        secondaryIds: [source.channels[0]],
        regionSetId: set.id,
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        operation: 'bsfc',
        parameter: 0,
        inputIds: [source.channels[2]],
        secondaryIds: powerRun.outputs.map((output) => output.signalId),
        regionSetId: set.id,
      });
    } else {
      set = await this.createRegions({
        sourceId: source.id,
        name: key === 'nested' ? 'Ramp windows' : 'Overlapping windows',
        parentSetId: base!.regionSetId,
        timeReference: 'parent',
        definition: {
          method: 'windows',
          boundary: 'clip',
          start: 0,
          end: 180,
          duration: 10,
          step: key === 'nested' ? 10 : 5,
          includePartial: true,
        },
      });
      run = await this.applyRegionFunction({
        sourceId: source.id,
        inputIds: [source.channels[1]],
        regionSetId: set.id,
        operation: 'min-max',
        parameter: 0,
      });
    }
    const example = {
      key,
      sourceId: source.id,
      regionSetId: set.id,
      runId: run.id,
    };
    await this.save({
      ...this.project,
      regionExamples: [...(this.project.regionExamples ?? []), example],
    });
    return example;
  }
  // An explicit calculation step; segmentation itself only creates crop recipes.
  async calculateSegmentMetrics(ids: string[]) {
    const nodes: SignalNode[] = [];
    const segments = this.project.segments.map((segment) => {
      if (!ids.includes(segment.id)) return segment;
      const members = segment.nodes.map((id) => this.find(id));
      const rpm = members.find((n) => n.unit.toLowerCase() === 'rpm');
      const torque = members.find((n) => /^n[· ]?m$/i.test(n.unit));
      const fuel = members.find((n) => /^kg\/h$/i.test(n.unit));
      if (!rpm || !torque || members.some((n) => n.operation === 'power'))
        return segment;
      if (
        this.gridRecipe(rpm.id) !== this.gridRecipe(torque.id) ||
        (fuel && this.gridRecipe(rpm.id) !== this.gridRecipe(fuel.id))
      )
        throw new Error(
          'Power and fuel metrics need matching sample grids and time transformations. Segment the synchronized raw channels together.',
        );
      const added = [
        this.node(segment.sourceId, 'Brake power', 'kW', 'power', [
          torque.id,
          rpm.id,
        ]),
      ];
      added[0].color = COLORS[3];
      if (fuel) {
        const consumption = this.node(
          segment.sourceId,
          'Specific fuel consumption',
          'g/kWh',
          'bsfc',
          [fuel.id, added[0].id],
        );
        consumption.color = COLORS[2];
        added.push(consumption);
      }
      nodes.push(...added);
      return {
        ...segment,
        nodes: [...segment.nodes, ...added.map((node) => node.id)],
      };
    });
    if (!nodes.length)
      throw new Error(
        'No new metrics to calculate. Segments need rpm and Nm channels; BSFC also needs kg/h.',
      );
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
      segments,
    });
    return segments.filter((segment) => ids.includes(segment.id));
  }
}
