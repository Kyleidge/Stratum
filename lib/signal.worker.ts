import { SignalEngine } from './signal-engine';
import type { EngineRequest, EngineResponse } from './signal-types';
import { measurePlot } from './plot-measurement';

let requestId = 0;
const send = (message: EngineResponse) => globalThis.postMessage(message);
const engine = new SignalEngine((message, progress) =>
  send({ type: 'progress', requestId, message, progress }),
);
let queue = Promise.resolve();
const pending = new Set<number>(),
  cancelled = new Set<number>();
type InspectionLane = 'view' | 'rows' | 'measure-plot' | 'sample-count';
type PreviewLane = 'segment-preview' | 'derive-preview' | 'value-preview';
const inspections = new Map<number, InspectionLane | PreviewLane>();
const PREVIEWS = new Set<string>([
  'segment-preview',
  'derive-preview',
  'value-preview',
]);
const COMMITS = new Set<string>([
  'derive-many',
  'segment',
  'calculate-values',
  'region-function',
  'time-operation',
  'edit-operation',
]);
globalThis.onmessage = (
  event: MessageEvent<EngineRequest & { requestId: number }>,
) => {
  const r = event.data;
  if (r.type === 'cancel') {
    for (const id of r.requestIds ?? pending) cancelled.add(id);
    if (cancelled.has(requestId)) engine.cancelled = true;
    return;
  }
  // A newer inspection or dialog preview supersedes queued ones in its lane.
  if (
    (r.type === 'view' ||
      r.type === 'rows' ||
      r.type === 'measure-plot' ||
      r.type === 'sample-count' ||
      r.type === 'segment-preview' ||
      r.type === 'derive-preview' ||
      r.type === 'value-preview') &&
    r.inspection
  ) {
    for (const [id, lane] of inspections)
      if (lane === r.type) cancelled.add(id);
    if (cancelled.has(requestId)) engine.cancelled = true;
    inspections.set(r.requestId, r.type);
  }
  // Committing a dialog supersedes its live previews, which can take seconds
  // on long recordings; the commit must not wait for them to finish.
  if (COMMITS.has(r.type))
    for (const [id, lane] of inspections)
      if (PREVIEWS.has(lane)) {
        cancelled.add(id);
        if (id === requestId) engine.cancelled = true;
      }
  pending.add(r.requestId);
  queue = queue.then(async () => {
    const run = async () => {
      requestId = r.requestId;
      engine.cancelled = false;
      try {
        if (cancelled.has(r.requestId))
          throw new Error(
            'Operation cancelled. Your existing work is unchanged.',
          );
        switch (r.type) {
          case 'time-operation':
            await engine.applyTimeOperation(r.settings);
            break;
          case 'backup-workspace':
            send({
              type: 'export',
              requestId,
              blob: await engine.backupWorkspace(),
            });
            return;
          case 'restore-workspace':
            await engine.restoreWorkspace(r.file);
            break;
          case 'delete-operation':
            await engine.deleteOperation(r.stepId);
            break;
          case 'edit-operation':
            await engine.editOperation(r.stepId, r.command);
            break;
          case 'rename':
            await engine.rename(r.id, r.name);
            break;
          case 'run-workflow':
            await engine.runWorkflow(r);
            break;
          case 'finish-batch':
            await engine.finishBatch(r.batchId, r.state, r.failures);
            break;
          case 'set-checks':
            await engine.setChecks(r.stepId, r.checks);
            break;
          case 'undo':
          case 'redo':
            await engine.travel(r.type);
            break;
          case 'demo-workflow':
            await engine.workflowExample(r.refresh, r.sourceId);
            break;
          case 'init-workflow':
            await engine.open();
            if (typeof navigator !== 'undefined' && navigator.locks) {
              await engine.recoverImports();
              await engine.pruneDerivedIndexes().catch(() => {});
            }
            await engine.initializeWorkflow();
            if (r.refreshExample) await engine.workflowExample(true);
            break;
          case 'calculate-values':
            await engine.calculateValues(
              r.inputIds,
              r.operation,
              r.parameters,
              r.bindings,
            );
            break;
          case 'init-regions':
            await engine.open();
            await engine.initializeRegions();
            if (!(engine.project.regionExamples ?? []).length)
              await engine.regionExample('ramps');
            break;
          case 'region-example':
            await engine.regionExample(r.key);
            break;
          case 'region-create':
            await engine.createRegions(r.settings);
            break;
          case 'region-function':
            await engine.applyRegionFunction(r.settings);
            break;
          case 'region-preview':
            send({
              type: 'region-plan',
              requestId,
              plan: await engine.previewRegions(r.settings),
            });
            return;
          case 'init':
            await engine.open();
            if (!engine.project.sources.length) await engine.demo();
            break;
          case 'demo':
            await engine.demo();
            break;
          case 'example':
            await engine.example(r.key);
            break;
          case 'import':
            await engine.importRecording(r.file, { tables: r.tables });
            break;
          case 'derive':
            await engine.derive(r.parentId, r.operation, r.parameter);
            break;
          case 'derive-many':
            await engine.deriveMany(
              r.parentIds,
              r.operation,
              r.parameter,
              true,
              r.bindings,
              {
                ...(r.unit !== undefined ? { unit: r.unit } : {}),
                ...(r.formula ? { formula: r.formula } : {}),
              },
            );
            break;
          case 'segment':
            await engine.segment(
              r.sourceId,
              r.definition,
              r.targetIds,
              r.independently,
              r.scope,
            );
            break;
          case 'segment-preview':
            send({
              type: 'segment-plan',
              requestId,
              plan: await engine.previewSegments(
                r.sourceId,
                r.definition,
                r.targetIds,
                r.independently,
                r.scope,
              ),
            });
            return;
          case 'derive-preview':
            send({
              type: 'derive-preview',
              requestId,
              preview: await engine.previewDerived(r),
            });
            return;
          case 'value-preview':
            send({
              type: 'value-preview',
              requestId,
              statistics: await engine.previewValues(
                r.ids,
                r.operation,
                r.parameters,
                r.bindings,
              ),
            });
            return;
          case 'segment-metrics':
            await engine.calculateSegmentMetrics(r.ids);
            break;
          case 'view': {
            const plots = [];
            for (const id of r.ids)
              plots.push(
                await engine.plot(
                  id,
                  r.ranges?.[id] ?? r.range,
                  !!r.ranges?.[id],
                ),
              );
            send({ type: 'plots', requestId, plots });
            return;
          }
          case 'measure-plot': {
            if (r.items.length > 30)
              throw new Error('Measure up to 30 traces per page.');
            const measurements = [];
            for (const item of r.items)
              measurements.push(
                await measurePlot(
                  item.id,
                  engine.evaluate(item.id, undefined, [
                    Math.min(item.a, item.b),
                    Math.max(item.a, item.b),
                  ]),
                  item.a,
                  item.b,
                  () => {
                    if (engine.cancelled)
                      throw new Error('Measurement cancelled.');
                  },
                ),
              );
            send({ type: 'plot-measurements', requestId, measurements });
            return;
          }
          case 'sample-count':
            send({
              type: 'sample-count',
              requestId,
              count: r.id === null ? null : await engine.sampleCount(r.id),
            });
            return;
          case 'rows':
            send({
              type: 'rows',
              requestId,
              ...(await engine.rows(r.id, r.offset)),
            });
            return;
          case 'export':
            send({
              type: 'export',
              requestId,
              blob: await engine.exportSummary(r.ids),
            });
            return;
          case 'export-samples':
            send({
              type: 'export',
              requestId,
              blob: await engine.exportSamples(r.ids),
            });
            return;
        }
        send({
          type: 'project',
          requestId,
          project: engine.project,
          canUndo: engine.canUndo,
          canRedo: engine.canRedo,
          undoLabel: engine.undoLabel,
          redoLabel: engine.redoLabel,
        });
      } catch (error) {
        send({
          type: 'error',
          requestId,
          message:
            error instanceof Error
              ? error.message
              : 'Processing failed. Please try again.',
        });
      } finally {
        pending.delete(r.requestId);
        cancelled.delete(r.requestId);
        inspections.delete(r.requestId);
      }
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.locks)
        await navigator.locks.request('stratus-workspace-writer', run);
      else await run();
    } catch (error) {
      // Lock acquisition can fail before run() starts. Never poison the queue.
      send({
        type: 'error',
        requestId: r.requestId,
        message:
          error instanceof Error
            ? error.message
            : 'Could not access the workspace. Please retry.',
      });
      pending.delete(r.requestId);
      cancelled.delete(r.requestId);
      inspections.delete(r.requestId);
    }
  });
};
