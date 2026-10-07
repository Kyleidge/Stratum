// Filesystem helpers for native saves and automatic backups. Plain Node, no
// Electron, so tests can exercise naming, rotation and atomic writes.
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const BACKUP_PATTERN =
  /^Stratum-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?\.stratum$/;
const PARTIAL_PATTERN = /^\..+\.[0-9a-f]{12}\.partial$/;
/** Leftover partial files older than this are from a crash, not a writer. */
const STALE_PARTIAL_MS = 60 * 60 * 1000;

const pad = (value) => String(value).padStart(2, '0');
/** A sortable, local-time name such as Stratum-backup-2026-10-07_15-30-12.stratum. */
export function backupFileName(date = new Date(), taken = new Set()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  let name = `Stratum-backup-${stamp}.stratum`;
  for (let copy = 2; taken.has(name); copy++)
    name = `Stratum-backup-${stamp}-${copy}.stratum`;
  return name;
}

/** The hidden temporary file a write goes to before it replaces `target`. */
export function partialPath(target) {
  return join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString('hex')}.partial`,
  );
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** A file name safe on Windows, macOS and Linux, with `extension` ensured. */
export function safeFileName(name, extension) {
  let clean = String(name ?? '')
    .split(/[\\/]/)
    .at(-1)
    // oxlint-disable-next-line no-control-regex -- control characters are invalid in Windows file names.
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean || RESERVED.test(clean))
    clean = `Stratum${clean ? `-${clean}` : ''}`;
  const suffix = `.${extension}`;
  if (!clean.toLowerCase().endsWith(suffix)) clean += suffix;
  if (clean.length > 180) clean = clean.slice(0, 180 - suffix.length) + suffix;
  return clean;
}

/**
 * Names of automatic backups beyond the newest `keep`, by modification time
 * (then name). Files that do not match the backup pattern are never chosen.
 */
export function backupsToRemove(entries, keep) {
  return entries
    .filter((entry) => BACKUP_PATTERN.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(Math.max(1, keep))
    .map((entry) => entry.name);
}

/**
 * Keeps the newest `keep` automatic backups in `folder` and removes partial
 * files a crash left behind. `active` lists partial paths still being written.
 */
export async function rotateBackups(folder, keep, active = new Set()) {
  const entries = [];
  const now = Date.now();
  const removed = [];
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    if (BACKUP_PATTERN.test(name)) {
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) entries.push({ name, mtimeMs: info.mtimeMs });
    } else if (
      PARTIAL_PATTERN.test(name) &&
      name.startsWith('.Stratum-backup-') &&
      !active.has(path)
    ) {
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile() && now - info.mtimeMs > STALE_PARTIAL_MS) {
        await rm(path, { force: true });
        removed.push(name);
      }
    }
  }
  for (const name of backupsToRemove(entries, keep)) {
    await rm(join(folder, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Renames `from` over `to`. Windows briefly locks files that antivirus or the
 * search indexer opened, so retry a few times before failing.
 */
export async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        attempt >= 6 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code ?? '')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

/** Writes `bytes` to `target` through a flushed temporary file and a rename. */
export async function writeFileAtomic(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const temp = partialPath(target);
  const file = await open(temp, 'wx');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
  await file.close();
  try {
    await replaceFile(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
