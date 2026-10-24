// What desktop/package.mjs recorded in the packaged app's package.json: the
// format versions this build writes (desktop/format-versions.mjs) and the
// commit, branch and pull request it was built from. Development runs and
// local packages may lack any of them.
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let info;

/** @returns {{ formats?: Record<string, number>, commit?: string, branch?: string, pullRequest?: number }} */
export function buildInfo() {
  if (info) return info;
  try {
    const { stratum } = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
    );
    info = stratum && typeof stratum === 'object' ? stratum : {};
  } catch {
    info = {};
  }
  return info;
}

/** One line for About: where this build came from, if known. */
export function buildOrigin() {
  const { commit, branch, pullRequest } = buildInfo();
  const at = commit ? ` at ${commit.slice(0, 7)}` : '';
  if (pullRequest)
    return `Test build of pull request #${pullRequest}${branch ? ` (${branch}${at})` : ''}.`;
  if (!commit) return undefined;
  return branch
    ? `Built from ${branch}${at}.`
    : `Built from commit ${commit.slice(0, 7)}.`;
}
