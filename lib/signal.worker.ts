import { SignalEngine } from './signal-engine';
import type { EngineRequest, EngineResponse } from './signal-types';

let requestId = 0;
const send = (message: EngineResponse) => globalThis.postMessage(message);
const engine = new SignalEngine((message, progress) =>
  send({ type: 'progress', requestId, message, progress }),
);
let queue = Promise.resolve();
globalThis.onmessage = (
  event: MessageEvent<EngineRequest & { requestId: number }>,
) => {
  const r = event.data;
  if (r.type === 'cancel') {
    engine.cancelled = true;
    return;
  }
  queue = queue.then(async () => {
    requestId = r.requestId;
    engine.cancelled = false;
    try {
      switch (r.type) {
        case 'init':
          await engine.open();
          if (!engine.project.sources.length) await engine.demo();
          break;
        case 'demo':
          await engine.demo();
          break;
        case 'import':
          await engine.importCsv(r.file);
          break;
        case 'derive':
          await engine.derive(r.parentId, r.operation, r.parameter);
          break;
        case 'segment':
          await engine.segment(r.sourceId, r.definition, r.targetIds);
          break;
        case 'segment-preview':
          send({
            type: 'segment-plan',
            requestId,
            plan: await engine.previewSegments(
              r.sourceId,
              r.definition,
              r.targetIds,
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
      }
      send({ type: 'project', requestId, project: engine.project });
    } catch (error) {
      send({
        type: 'error',
        requestId,
        message:
          error instanceof Error
            ? error.message
            : 'Processing failed. Please try again.',
      });
    }
  });
};
