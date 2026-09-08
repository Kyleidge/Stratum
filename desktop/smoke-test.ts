import type { EngineResponse } from '@/lib/signal-types';

// Native Chromium integration: real worker, IndexedDB persistence, and evaluated results.
export async function smokeTest() {
  const worker = new Worker(
    new URL('../lib/signal.worker.ts', import.meta.url),
    { type: 'module' },
  );
  const timeout = setTimeout(() => {
    console.error('STRATUS_SMOKE_FAILED: Engine timed out');
    worker.terminate();
  }, 45000);
  worker.onerror = () => console.error('STRATUS_SMOKE_FAILED: Worker error');
  worker.onmessage = (event: MessageEvent<EngineResponse>) => {
    const r = event.data;
    if (r.type === 'error') {
      console.error(`STRATUS_SMOKE_FAILED: ${r.message}`);
      clearTimeout(timeout);
      worker.terminate();
    }
    if (r.type === 'project') {
      const bsfc = r.project.nodes.filter((n) => n.operation === 'bsfc');
      if (r.project.segments.length < 3 || bsfc.length < 3) {
        console.error('STRATUS_SMOKE_FAILED: Incomplete demonstration');
        return;
      }
      worker.postMessage({
        type: 'view',
        ids: bsfc.slice(0, 3).map((n) => n.id),
        requestId: 2,
      });
    }
    if (r.type === 'plots') {
      if (
        r.plots.length !== 3 ||
        r.plots.some(
          (p) =>
            !Number.isFinite(p.summary.weightedMean) || p.summary.count < 3000,
        )
      )
        console.error('STRATUS_SMOKE_FAILED: Invalid analysis results');
      else
        console.info(
          `STRATUS_SMOKE_OK: Three ramps evaluated in a native worker; BSFC ${r.plots.map((p) => p.summary.weightedMean?.toFixed(2)).join(', ')} g/kWh.`,
        );
      clearTimeout(timeout);
      worker.terminate();
    }
  };
  worker.postMessage({ type: 'init', requestId: 1 });
}
