/**
 * True for failures of the worker, storage or workspace that a reload can
 * fix. Validation messages (CSV problems, invalid settings) are not: they are
 * dismissible, and reloading would not change them.
 */
export function needsReload(message: string, ready = true): boolean {
  if (!ready) return true;
  return /\breload\b|\bworker\b|indexeddb|\bdatabase\b|storage transaction|transaction was aborted|quota|could not access the workspace|engine is not ready/i.test(
    message,
  );
}
