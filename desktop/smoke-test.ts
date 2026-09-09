import type { EngineRequest, EngineResponse } from '@/lib/signal-types';
import { createSignalWorker } from '@/lib/create-signal-worker';

// Exercise bundled worker code, protocol origin checks and real IndexedDB.
export async function smokeTest() {
  const worker = createSignalWorker();
  const timeout = setTimeout(() => {
    console.error('STRATUS_SMOKE_FAILED: Engine timed out');
    worker.terminate();
  }, 45000);
  let serial = 0;
  function send(request: EngineRequest): Promise<EngineResponse> {
    return new Promise((resolve, reject) => {
      worker.onerror = () => reject(new Error('Worker failed'));
      worker.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
        if (data.type === 'progress') return;
        if (data.type === 'error') reject(new Error(data.message));
        else resolve(data);
      };
      worker.postMessage({ ...request, requestId: ++serial });
    });
  }
  try {
    const initialized = await send({ type: 'init-regions' });
    if (
      initialized.type !== 'project' ||
      initialized.project.regionSets?.[0].regions.length !== 3
    )
      throw new Error('Region workspace did not initialize');
    const nested = await send({ type: 'region-example', key: 'nested' });
    if (
      nested.type !== 'project' ||
      !nested.project.regionSets?.some(
        (set) => set.parentSetId && set.regions.length > 3,
      )
    )
      throw new Error('Nested windows failed');
    const fuel = await send({ type: 'region-example', key: 'fuel' });
    if (fuel.type !== 'project') throw new Error('Fuel example failed');
    const example = fuel.project.regionExamples!.find(
      (item) => item.key === 'fuel',
    )!;
    const run = fuel.project.functionRuns!.find(
      (item) => item.id === example.runId,
    )!;
    const plots = await send({
      type: 'view',
      ids: run.outputs.map((output) => output.signalId),
    });
    if (
      plots.type !== 'plots' ||
      plots.plots.length !== 3 ||
      plots.plots.some(
        (plot) =>
          !Number.isFinite(plot.summary.weightedMean) ||
          plot.summary.count < 3000,
      )
    )
      throw new Error('Invalid per-region fuel results');
    console.info(
      `STRATUS_SMOKE_OK: Region workspace, nested windows and independent calculations passed; BSFC ${plots.plots.map((plot) => plot.summary.weightedMean?.toFixed(2)).join(', ')} g/kWh.`,
    );
  } catch (error) {
    console.error(
      `STRATUS_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    worker.terminate();
  }
}
