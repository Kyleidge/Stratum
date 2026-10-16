import type { WorkflowTarget } from '@/lib/workflow-drag';

/** The last inspected step or output on this device; never workflow history. */
const SELECTION_STORAGE_KEY = 'stratum-workflow-selection-v1';
export function readStoredSelection(): WorkflowTarget | undefined {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(SELECTION_STORAGE_KEY) ?? 'null',
    );
    if (
      saved &&
      typeof saved === 'object' &&
      'kind' in saved &&
      'id' in saved &&
      (saved.kind === 'step' || saved.kind === 'output') &&
      typeof saved.id === 'string'
    )
      return { kind: saved.kind, id: saved.id };
  } catch {
    // A missing or unreadable preference opens the default selection.
  }
  return undefined;
}
export function storeSelection(chosen: WorkflowTarget) {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(chosen));
  } catch {
    // The selection still applies for this session.
  }
}
/**
 * Signals chosen to show over each segment set's bands, by set ID; device
 * preferences, never workflow history. Missing signals are ignored on use.
 */
const SEGMENT_SIGNALS_STORAGE_KEY = 'stratum-segment-signals-v1';
export function readStoredSegmentSignals(): Record<string, string[]> {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(SEGMENT_SIGNALS_STORAGE_KEY) ?? 'null',
    );
    if (saved && typeof saved === 'object')
      return Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) &&
            entry[1].every((id) => typeof id === 'string'),
        ),
      );
  } catch {
    // A missing or unreadable preference shows the default signals.
  }
  return {};
}
export function storeSegmentSignals(choice: Record<string, string[]>) {
  try {
    localStorage.setItem(SEGMENT_SIGNALS_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // The choice still applies for this session.
  }
}
