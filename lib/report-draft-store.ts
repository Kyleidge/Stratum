import { createBlock, type ReportDocument } from './report-mockup';

/**
 * Device-local storage for the Reports draft. It is its own IndexedDB database,
 * separate from the signal engine's, so saving a draft never touches signal
 * data, workflow history or backups. Report Undo/Redo stays session-only.
 */
export const REPORT_DRAFT_DATABASE = 'stratum-report-drafts';
const STORE = 'drafts';
const KEY = 'current';
const VERSION = 1;

type StoredDraft = {
  version: typeof VERSION;
  savedAt: string;
  report: ReportDocument;
};

/**
 * The stored draft was written by a newer Stratum. It is left untouched:
 * callers must not save over it.
 */
export class NewerReportDraftError extends Error {
  constructor() {
    super(
      'The report draft on this device was saved by a newer version of Stratum. It is kept unchanged; update Stratum to continue it.',
    );
    this.name = 'NewerReportDraftError';
  }
}

export type ReportDraftStore = {
  /**
   * The saved draft, or null when none is stored or it cannot be read.
   * Rejects with `NewerReportDraftError` for a newer draft or database.
   */
  load: () => Promise<ReportDocument | null>;
  save: (report: ReportDocument) => Promise<void>;
  clear: () => Promise<void>;
  close: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Validates a stored draft, filling block fields added since it was saved.
 * Throws `NewerReportDraftError` for a draft from a newer Stratum.
 */
export function restoreReportDraft(value: unknown): ReportDocument | null {
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version > VERSION
  )
    throw new NewerReportDraftError();
  if (!isRecord(value) || value.version !== VERSION) return null;
  const report = value.report;
  if (
    !isRecord(report) ||
    typeof report.title !== 'string' ||
    (report.pageSize !== 'a4' && report.pageSize !== 'letter') ||
    (report.orientation !== 'portrait' && report.orientation !== 'landscape') ||
    typeof report.background !== 'string' ||
    !Array.isArray(report.pages) ||
    !report.pages.length
  )
    return null;
  const pages: ReportDocument['pages'] = [];
  for (const page of report.pages) {
    if (
      !isRecord(page) ||
      typeof page.id !== 'string' ||
      !Array.isArray(page.blocks)
    )
      return null;
    const blocks = [];
    for (const block of page.blocks) {
      if (
        !isRecord(block) ||
        typeof block.id !== 'string' ||
        !['text', 'plot', 'image', 'table'].includes(String(block.type)) ||
        ![block.x, block.y, block.width, block.height].every(finite)
      )
        return null;
      const type = block.type as 'text' | 'plot' | 'image' | 'table';
      blocks.push({ ...createBlock(type), ...block, type });
    }
    pages.push({ id: page.id, blocks });
  }
  const frame = report.frame;
  return {
    title: report.title,
    pages,
    pageSize: report.pageSize,
    orientation: report.orientation,
    background: report.background,
    ...(isRecord(frame) &&
    typeof frame.style === 'string' &&
    typeof frame.accent === 'string'
      ? { frame: frame as unknown as NonNullable<ReportDocument['frame']> }
      : {}),
  };
}

/** Opens the draft database lazily; every method reports storage failures. */
export function openReportDraftStore(
  name = REPORT_DRAFT_DATABASE,
): ReportDraftStore {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  const open = () => {
    if (closed) return Promise.reject(new Error('The draft store is closed.'));
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser cannot save report drafts.'));
        return;
      }
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE))
          opening.result.createObjectStore(STORE);
      };
      opening.onsuccess = () => {
        const db = opening.result;
        // Let another window upgrade or delete the database.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      opening.onerror = () =>
        reject(
          opening.error?.name === 'VersionError'
            ? new NewerReportDraftError()
            : opening.error,
        );
      opening.onblocked = () =>
        reject(new Error('Report drafts are locked by another window.'));
    });
    database.catch(() => {
      database = undefined;
    });
    return database;
  };
  async function transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    const transaction = db.transaction(STORE, mode);
    const operation = run(transaction.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('The draft was not saved.'));
    });
    return operation.result;
  }
  return {
    load: async () =>
      restoreReportDraft(await transact('readonly', (store) => store.get(KEY))),
    save: async (report) => {
      const stored: StoredDraft = {
        version: VERSION,
        savedAt: new Date().toISOString(),
        report,
      };
      await transact('readwrite', (store) => store.put(stored, KEY));
    },
    clear: async () => {
      await transact('readwrite', (store) => store.delete(KEY));
    },
    close: () => {
      closed = true;
      void database?.then((db) => db.close()).catch(() => {});
    },
  };
}
