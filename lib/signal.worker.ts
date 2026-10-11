import { SignalEngine } from './signal-engine';
import type { EngineRequest, EngineResponse } from './signal-types';
import { handleEngineRequest } from './engine-requests';

let requestId = 0;
const send = (message: EngineResponse) => globalThis.postMessage(message);
const engine = new SignalEngine((message, progress) =>
  send({ type: 'progress', requestId, message, progress }),
);
let queue = Promise.resolve();
const pending = new Set<number>(),
  cancelled = new Set<number>();
type InspectionLane = 'view' | 'rows' | 'measure-plot' | 'sample-count';
type PreviewLane =
  | 'segment-preview'
  | 'segment-set-preview'
  | 'derive-preview'
  | 'value-preview';
const inspections = new Map<number, InspectionLane | PreviewLane>();
const PREVIEWS = new Set<string>([
  'segment-preview',
  'segment-set-preview',
  'derive-preview',
  'value-preview',
]);
const COMMITS = new Set<string>([
  'derive-many',
  'segment',
  'segment-set',
  'calculate-values',
  'region-function',
  'time-operation',
  'edit-operation',
  'create-named',
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
      r.type === 'segment-set-preview' ||
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
        await handleEngineRequest(engine, r, requestId, send);
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
