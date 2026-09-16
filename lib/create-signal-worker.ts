// oxlint-disable-next-line import/default -- Vite's ?worker transform provides the constructor export.
import SignalWorker from './signal.worker?worker';

// Let Vite resolve the worker asset. Vinext rewrites application import.meta.url
// to a source-identity file URL, which is not a loadable browser resource.
export function createSignalWorker(): Worker {
  return new SignalWorker({ name: 'stratum-signals' });
}
