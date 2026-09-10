import { SignalEngine } from './signal-engine';
import type { EngineRequest, EngineResponse } from './signal-types';

let requestId = 0;
const send = (message: EngineResponse) => globalThis.postMessage(message);
const engine = new SignalEngine((message, progress) =>
  send({ type: 'progress', requestId, message, progress }),
);
let queue = Promise.resolve();
const pending = new Set<number>(),
  cancelled = new Set<number>();
const inspections = new Map<number, 'view' | 'rows'>();
globalThis.onmessage = (
  event: MessageEvent<EngineRequest & { requestId: number }>,
) => {
  const r = event.data;
  if (r.type === 'cancel') {
    for (const id of r.requestIds ?? pending) cancelled.add(id);
    if (cancelled.has(requestId)) engine.cancelled = true;
    return;
  }
  if ((r.type === 'view' || r.type === 'rows') && r.inspection) {
    for (const [id, lane] of inspections)
      if (lane === r.type) cancelled.add(id);
    if (cancelled.has(requestId)) engine.cancelled = true;
    inspections.set(r.requestId, r.type);
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
          case 'undo':
          case 'redo':
            await engine.travel(r.type);
            break;
          case 'demo-workflow':
            await engine.workflowExample(r.refresh, r.sourceId);
            break;
          case 'init-workflow':
            await engine.open();
            if (typeof navigator !== 'undefined' && navigator.locks)
              await engine.recoverImports();
            await engine.initializeWorkflow();
            if (r.refreshExample) await engine.workflowExample(true);
            break;
          case 'calculate-values':
            await engine.calculateValues(r.inputIds, r.operation);
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
            await engine.importCsv(r.file);
            break;
          case 'derive':
            await engine.derive(r.parentId, r.operation, r.parameter);
            break;
          case 'derive-many':
            await engine.deriveMany(r.parentIds, r.operation, r.parameter);
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
          case 'segment-metrics':
            await engine.calculateSegmentMetrics(r.ids);
            break;
          case 'view': {
            const plots = [];
            for (const id of r.ids) plots.push(await engine.plot(id, r.range));
            send({ type: 'plots', requestId, plots });
            return;
          }
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
