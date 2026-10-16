import { workspaceTimeScope } from '../time-model';
import { scopeSegments, segmentEntries } from '../file-segments';
import { bindingValueIds, resolveTriggerBindings } from '../value-bindings';
import type { WorkflowStep } from '../workflow-types';
import {
  CrossingDetector,
  validTriggerNoise,
  type TriggerEvent,
} from '../segmentation';
import type {
  EdgeTrigger,
  FileSegment,
  Segment,
  SegmentationDefinition,
  SegmentationPlan,
  SegmentationScope,
  SegmentScope,
  SegmentSet,
  SignalNode,
} from '../signal-types';
import { uid, nextStepSequence } from './store';
import { EnginePlots } from './plots';

/**
 * Segmentation: trigger, range and window previews, crop segments and file
 * segment sets.
 */
export abstract class EngineSegments extends EnginePlots {
  private async *triggerEvents(
    trigger: EdgeTrigger,
    domain?: [number, number],
  ): AsyncGenerator<TriggerEvent> {
    const detector = new CrossingDetector(trigger);
    const offset = this.axisOffset(trigger.signalId);
    let last: number | undefined;
    const [first, end] = this.bounds(trigger.signalId);
    for await (const chunk of this.evaluate(
      trigger.signalId,
      new Set(),
      domain ? [domain[0] + offset, domain[1] + offset] : undefined,
    )) {
      for (let i = 0; i < chunk.time.length; i++) {
        const time = chunk.time[i] - offset;
        if (domain && time < domain[0]) continue;
        if (domain && time >= domain[1]) {
          if (last !== undefined) yield { time: last, kind: 'finish' };
          return;
        }
        last = time;
        const event = detector.next(time, chunk.values[i]);
        if (event) yield event;
      }
      this.progress(
        'Scanning trigger crossings…',
        Math.min(99, 100 * ((last! + offset - first) / (end - first || 1))),
      );
    }
    // Explicit end-of-coverage prevents pairing across unequal input coverage.
    if (last !== undefined) yield { time: last, kind: 'finish' };
  }
  async previewSegments(
    sourceId: string,
    definition: SegmentationDefinition,
    targetIds: string[],
    independently = false,
    scope?: SegmentationScope,
    domain?: [number, number],
    pointersOnly = false,
  ): Promise<SegmentationPlan> {
    this.check();
    this.segmentationScope(sourceId, targetIds, independently, scope);
    if (independently) {
      if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
        throw new Error('Choose unique inputs for segmentation.');
      const combined: SegmentationPlan = {
        ranges: [],
        skipped: 0,
        incomplete: 0,
      };
      for (const id of targetIds) {
        const plan = await this.previewSegments(
          sourceId,
          this.memberDefinition(definition, targetIds[0], id),
          [id],
        );
        combined.ranges.push(
          ...plan.ranges.map((range) => ({ ...range, inputId: id })),
        );
        combined.skipped += plan.skipped;
        combined.incomplete += plan.incomplete;
        if (combined.ranges.length > 1000)
          throw new Error(
            'More than 1,000 segments in this batch. Narrow the settings or select fewer inputs.',
          );
      }
      return combined;
    }
    definition = resolveTriggerBindings(this.bindingContext(), definition);
    const cacheKey = JSON.stringify([
      sourceId,
      definition,
      targetIds,
      domain,
      pointersOnly,
    ]);
    if (cacheKey === this.segmentPreviewCache?.key)
      return structuredClone(this.segmentPreviewCache.plan);
    const source =
      this.project.sources.find((s) => s.id === sourceId) ??
      (sourceId === ''
        ? workspaceTimeScope(this.project, this.graph())
        : undefined);
    if (!source) throw new Error('Choose a recording to segment.');
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
      throw new Error('Choose at least one unique output signal.');
    const fromSource = (id: string) => {
      const node = this.find(id);
      if (node.sourceId !== sourceId)
        throw new Error(
          'Triggers and output signals must belong to the same recording.',
        );
      if (
        sourceId === '' &&
        this.graph().timeReferences.get(id)?.id !==
          this.graph().timeReferences.get(targetIds[0])?.id
      )
        throw new Error(
          'Segmentation inputs and triggers must share a time reference. Align them first.',
        );
      return node;
    };
    const limits: [number, number] = domain
      ? [Math.max(source.start, domain[0]), Math.min(source.end, domain[1])]
      : [source.start, source.end];
    for (const id of targetIds) {
      fromSource(id);
      const offset = this.axisOffset(id);
      const [start, end] = this.bounds(id);
      limits[0] = Math.max(limits[0], start - offset);
      limits[1] = Math.min(limits[1], end - offset);
    }
    if (limits[1] <= limits[0])
      throw new Error('Output signals have no shared time interval.');
    if (definition.boundary !== 'clip' && definition.boundary !== 'discard')
      throw new Error('Choose how to handle recording boundaries.');
    const plan: SegmentationPlan = { ranges: [], skipped: 0, incomplete: 0 };
    const add = (
      requestedStart: number,
      requestedEnd: number,
      startTrigger?: number,
      endTrigger?: number,
    ) => {
      const start = Math.max(requestedStart, limits[0]);
      const end = Math.min(requestedEnd, limits[1]);
      const clipped = start !== requestedStart || end !== requestedEnd;
      const minimum =
        definition.method === 'triggers' ? definition.minimumDuration : 0;
      if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd))
        throw new Error('Segment boundaries must be finite.');
      if (
        end <= start ||
        end - start < minimum ||
        (clipped && definition.boundary === 'discard')
      ) {
        plan.skipped++;
        return;
      }
      if (plan.ranges.length >= 1000)
        throw new Error(
          'More than 1,000 segments. Narrow the interval or adjust the settings.',
        );
      plan.ranges.push({
        start,
        end,
        requestedStart,
        requestedEnd,
        startTrigger,
        endTrigger,
        clipped,
      });
    };
    switch (definition.method) {
      case 'triggers': {
        for (const trigger of [definition.start, definition.end]) {
          fromSource(trigger.signalId);
          if (
            !['rising', 'falling'].includes(trigger.edge) ||
            !Number.isFinite(trigger.threshold) ||
            !Number.isFinite(trigger.offset)
          )
            throw new Error(
              'Each trigger needs an edge, finite threshold, and finite time offset.',
            );
          if (!validTriggerNoise(trigger))
            throw new Error(
              'Trigger hysteresis and debounce must be zero or positive.',
            );
        }
        if (
          !Number.isFinite(definition.minimumDuration) ||
          definition.minimumDuration < 0
        )
          throw new Error('Minimum duration must be zero or positive.');
        const streams = [
          this.triggerEvents(definition.start, domain),
          this.triggerEvents(definition.end, domain),
        ];
        const events = await Promise.all(
          streams.map((stream) => stream.next()),
        );
        const valid = [false, false];
        let pending: number | undefined;
        const priority = { gap: 0, valid: 1, crossing: 2, finish: 3 };
        try {
          while (!events.every((event) => event.done)) {
            this.check();
            let side: number;
            if (events[0].done) side = 1;
            else if (events[1].done) side = 0;
            else {
              const a = events[0].value;
              const b = events[1].value;
              side =
                a.time < b.time ||
                (a.time === b.time && priority[a.kind] < priority[b.kind])
                  ? 0
                  : 1;
            }
            const event = events[side].value!;
            if (event.kind === 'valid') valid[side] = true;
            else if (event.kind === 'gap' || event.kind === 'finish') {
              valid[side] = false;
              if (pending !== undefined) {
                plan.incomplete++;
                pending = undefined;
              }
            } else if (valid.every(Boolean)) {
              if (side === 0) pending ??= event.time;
              else if (pending !== undefined && event.time > pending) {
                add(
                  pending + definition.start.offset,
                  event.time + definition.end.offset,
                  pending,
                  event.time,
                );
                pending = undefined;
              }
            }
            events[side] = await streams[side].next();
          }
        } finally {
          await Promise.all(streams.map((stream) => stream.return(undefined)));
        }
        break;
      }
      case 'ranges':
        if (!definition.ranges.length || definition.ranges.length > 1000)
          throw new Error('Enter between 1 and 1,000 time ranges.');
        for (const [start, end] of definition.ranges) {
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            throw new Error(
              'Each time range needs a finite start and a later end.',
            );
          add(start, end);
        }
        break;
      case 'windows': {
        const { start, end, duration, step, includePartial } = definition;
        if (
          ![start, end, duration, step].every(Number.isFinite) ||
          end <= start ||
          duration <= 0 ||
          step <= 0 ||
          start + step <= start ||
          start + duration <= start
        )
          throw new Error(
            'Use a finite time interval and positive window duration and step.',
          );
        const count = Math.ceil((end - start) / step);
        if (count > 1000)
          throw new Error(
            'More than 1,000 windows. Increase the step or narrow the interval.',
          );
        for (let i = 0; i < count; i++) {
          const a = start + i * step;
          const b = a + duration;
          if (a >= end) break;
          if (b > end && !includePartial) {
            plan.skipped++;
            continue;
          }
          add(a, Math.min(b, end));
        }
        break;
      }
      default:
        throw new Error('Unknown segmentation method.');
    }
    if (plan.ranges.length * targetIds.length > 10000)
      throw new Error(
        'This would create over 10,000 signals. Reduce the segment count or output selection.',
      );
    const populated = [];
    for (const range of plan.ranges) {
      if (pointersOnly) {
        populated.push(range);
        continue;
      }
      let valid = true;
      for (const id of targetIds) {
        const offset = this.axisOffset(id);
        if (
          !(await this.hasSample(id, range.start + offset, range.end + offset))
        ) {
          valid = false;
          break;
        }
      }
      if (valid) populated.push(range);
      else plan.skipped++;
      this.check();
    }
    plan.ranges = populated;
    this.check();
    this.segmentPreviewCache = { key: cacheKey, plan: structuredClone(plan) };
    return plan;
  }
  async segment(
    sourceId: string,
    definition: SegmentationDefinition,
    targetIds: string[],
    independently = false,
    scope?: SegmentationScope,
  ) {
    const savedScope = this.segmentationScope(
      sourceId,
      targetIds,
      independently,
      scope,
    );
    const plan = await this.previewSegments(
      sourceId,
      definition,
      targetIds,
      independently,
      savedScope,
    );
    if (!plan.ranges.length)
      throw new Error(
        'No complete segments match these settings. Preview the triggers, offsets, or time ranges.',
      );
    const nodes: SignalNode[] = [];
    // New segments are numbered within this step (per member when members
    // are segmented independently) and named after each parent's display
    // label. Saved segments keep their names.
    const numbers = new Map<string, number>();
    // Bound trigger settings are saved as the results each segment used.
    const context = this.bindingContext();
    const savedDefinition = resolveTriggerBindings(
      context,
      structuredClone(definition),
    );
    const batchId = uid();
    const segments = plan.ranges.map((boundary): Segment => {
      const number = (numbers.get(boundary.inputId ?? '') ?? 0) + 1;
      numbers.set(boundary.inputId ?? '', number);
      const recipe = boundary.inputId
        ? resolveTriggerBindings(
            context,
            this.memberDefinition(
              savedDefinition,
              targetIds[0],
              boundary.inputId,
            ),
          )
        : savedDefinition;
      const cropped = (boundary.inputId ? [boundary.inputId] : targetIds).map(
        (id) => {
          const parent = this.find(id);
          const offset = this.axisOffset(id);
          const triggers =
            recipe.method === 'triggers'
              ? [recipe.start.signalId, recipe.end.signalId]
              : [];
          const node = this.node(
            sourceId,
            this.project.labels?.[id] ?? parent.name,
            parent.unit,
            'crop',
            [...new Set([id, ...triggers])],
            {
              start: boundary.start + offset,
              end: boundary.end + offset,
            },
          );
          node.color = parent.color;
          node.batchId = batchId;
          return node;
        },
      );
      nodes.push(...cropped);
      return {
        id: uid(),
        sourceId,
        batchId,
        scope: savedScope,
        name: `Segment ${String(number).padStart(2, '0')}`,
        start: boundary.start,
        end: boundary.end,
        nodes: cropped.map((node) => node.id),
        definition: recipe,
        boundary,
      };
    });
    await this.save({
      ...this.project,
      nodes: [...this.project.nodes, ...nodes],
      segments: [...this.project.segments, ...segments],
      segmentationOperations: [
        ...(this.project.segmentationOperations ?? []),
        {
          id: batchId,
          sourceId,
          definition: savedDefinition,
          targetIds: [...targetIds],
          independently,
          scope: savedScope,
          segmentIds: segments.map((segment) => segment.id),
        },
      ],
    });
    return segments;
  }
  /**
   * The signal whose bounds limit a segment set: a recording's first channel,
   * a workspace trigger, or the workspace signal chosen for ranges/windows.
   */
  private segmentAxis(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
  ): string {
    if (sourceId !== '') {
      const source = this.project.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error('Choose a recording to segment.');
      return source.channels[0];
    }
    const id =
      definition.method === 'triggers'
        ? definition.start.signalId
        : referenceId;
    if (!id || this.find(id).sourceId !== '')
      throw new Error(
        'Choose a workspace signal whose time axis these segments use.',
      );
    return id;
  }
  /**
   * File segments found by these settings, for a dialog preview. Nested
   * segmentation searches each parent segment; its ranges and windows are
   * seconds from that parent's start.
   */
  async previewSegmentSet(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
    within?: SegmentScope,
  ): Promise<SegmentationPlan> {
    this.check();
    const axis = this.segmentAxis(sourceId, definition, referenceId);
    if (!within)
      return this.previewSegments(
        sourceId,
        definition,
        [axis],
        false,
        'signals',
        undefined,
        true,
      );
    const { set, segments } = scopeSegments(this.project, within);
    if (
      set.sourceId !== sourceId ||
      (sourceId === '' &&
        set.timeReferenceId !== this.graph().timeReferences.get(axis)?.id)
    )
      throw new Error(
        'Nested segments must use the same recording as their parent segments.',
      );
    const combined: SegmentationPlan = {
      ranges: [],
      skipped: 0,
      incomplete: 0,
    };
    for (const parent of segments) {
      this.check();
      const local: SegmentationDefinition =
        definition.method === 'ranges'
          ? {
              ...definition,
              ranges: definition.ranges.map(
                ([a, b]) =>
                  [parent.start + a, parent.start + b] as [number, number],
              ),
            }
          : definition.method === 'windows'
            ? {
                ...definition,
                start: parent.start + definition.start,
                end: Math.min(parent.end, parent.start + definition.end),
              }
            : definition;
      if (local.method === 'windows' && !(local.end > local.start)) {
        combined.skipped++;
        continue;
      }
      const plan = await this.previewSegments(
        sourceId,
        local,
        [axis],
        false,
        'signals',
        [parent.start, parent.end],
        true,
      );
      combined.ranges.push(
        ...plan.ranges.map((range) => ({ ...range, parentId: parent.id })),
      );
      combined.skipped += plan.skipped;
      combined.incomplete += plan.incomplete;
      if (combined.ranges.length > 10000)
        throw new Error(
          'More than 10,000 nested segments. Narrow the settings or choose fewer parent segments.',
        );
    }
    return combined;
  }
  /**
   * A Segment step that finds file segments: time intervals of the whole
   * recording, not signals. Later steps choose them with `within`.
   */
  async segmentSet(
    sourceId: string,
    definition: SegmentationDefinition,
    referenceId?: string,
    within?: SegmentScope,
  ) {
    const plan = await this.previewSegmentSet(
      sourceId,
      definition,
      referenceId,
      within,
    );
    if (!plan.ranges.length)
      throw new Error(
        'No segments match these settings. Preview the triggers, offsets, or time ranges.',
      );
    const before = this.project;
    const axis = this.segmentAxis(sourceId, definition, referenceId);
    const recordingEnd = this.bounds(axis)[1] - this.axisOffset(axis);
    const saved = resolveTriggerBindings(
      this.bindingContext(),
      structuredClone(definition),
    );
    const entries = segmentEntries(before);
    const numbers = new Map<string, number>();
    const segments = plan.ranges.map(
      ({ parentId, ...boundary }): FileSegment => {
        const parent = parentId ? entries.get(parentId)!.segment : undefined;
        const number = (numbers.get(parentId ?? '') ?? 0) + 1;
        numbers.set(parentId ?? '', number);
        const label = String(number).padStart(2, '0');
        return {
          id: uid(),
          name: parent
            ? `${before.labels?.[parent.id] ?? parent.name}.${label}`
            : `Segment ${label}`,
          start: boundary.start,
          end: boundary.end,
          endInclusive:
            boundary.end >= recordingEnd ||
            (!!parent && boundary.end >= parent.end && parent.endInclusive),
          ...(parent ? { parentId: parent.id } : {}),
          boundary,
        };
      },
    );
    const set: SegmentSet = {
      id: uid(),
      sourceId,
      ...(sourceId === ''
        ? {
            timeReferenceId: this.graph().timeReferences.get(axis)!.id,
            ...(saved.method === 'triggers' ? {} : { referenceId: axis }),
          }
        : {}),
      definition: saved,
      ...(within ? { within: structuredClone(within) } : {}),
      segments,
    };
    const valueIds = bindingValueIds(saved.bindings);
    const step: WorkflowStep = {
      id: uid(),
      sourceId,
      sequence: nextStepSequence(before),
      createdAt: new Date().toISOString(),
      kind: 'segment',
      operation: 'segment',
      inputIds:
        saved.method === 'triggers'
          ? [...new Set([saved.start.signalId, saved.end.signalId])]
          : set.referenceId
            ? [set.referenceId]
            : [],
      outputIds: segments.map((segment) => segment.id),
      ...(valueIds.length ? { valueInputIds: valueIds } : {}),
      definition: saved,
      segmentSetId: set.id,
      ...(within
        ? {
            within: structuredClone(within),
            segmentInputIds: scopeSegments(before, within).segments.map(
              (segment) => segment.id,
            ),
          }
        : {}),
    };
    await this.save({
      ...before,
      segmentSets: [...(before.segmentSets ?? []), set],
      workflowSteps: [...(before.workflowSteps ?? []), step],
    });
    return set;
  }
  private segmentationScope(
    sourceId: string,
    targetIds: string[],
    independently: boolean,
    scope?: SegmentationScope,
  ): SegmentationScope {
    if (sourceId === '') {
      if (scope === 'file')
        throw new Error('Workspace outputs use signal segmentation.');
      return 'signals';
    }
    const source = this.project.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('Choose a recording to segment.');
    const targets = new Set(targetIds);
    const entireFile =
      !independently &&
      targets.size === source.channels.length &&
      source.channels.every((id) => targets.has(id));
    if (scope === 'file' && !entireFile)
      throw new Error(
        'File segmentation must include every original channel with shared boundaries.',
      );
    return scope ?? (entireFile ? 'file' : 'signals');
  }
  private memberDefinition(
    definition: SegmentationDefinition,
    first: string,
    current: string,
  ): SegmentationDefinition {
    if (definition.method !== 'triggers') return definition;
    return {
      ...definition,
      start: {
        ...definition.start,
        signalId:
          definition.start.signalId === first
            ? current
            : definition.start.signalId,
      },
      end: {
        ...definition.end,
        signalId:
          definition.end.signalId === first ? current : definition.end.signalId,
      },
    };
  }
}
