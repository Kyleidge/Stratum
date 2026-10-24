// The version of an automatic beta build (see docs/releasing.md):
// package.json's version with `-beta.<n>`, where n is the Release workflow's
// run number, so every beta outranks the one before it. Once that version
// has a stable tag, betas move on to the next patch, so they still outrank
// the stable release beta testers may have updated to.
//
// A pull request's test build (.github/workflows/test-build.yml) uses
// `-pr.<number>.<n>` instead: a channel of its own that beta installs never
// take, ordered within the pull request by the run number.
//
//   node desktop/beta-version.mjs <n>                    prints the version
//   node desktop/beta-version.mjs <n> --pull-request <p> a test build's
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `version` may carry a prerelease; `tags` are the repository's tags.
 * `pullRequest` makes a test build of that pull request.
 */
export function betaVersion(version, number, tags, pullRequest) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`Beta number must be a positive integer, not ${number}.`);
  if (
    pullRequest !== undefined &&
    (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
  )
    throw new Error(`Not a pull request number: ${pullRequest}.`);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  if (!match) throw new Error(`Cannot make a beta of version ${version}.`);
  const [major, minor] = [match[1], match[2]];
  const released = new Set(tags);
  let patch = Number(match[3]);
  while (released.has(`v${major}.${minor}.${patch}`)) patch += 1;
  const core = `${major}.${minor}.${patch}`;
  return pullRequest === undefined
    ? `${core}-beta.${number}`
    : `${core}-pr.${pullRequest}.${number}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const tags = execFileSync('git', ['tag', '--list', 'v*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const flag = process.argv.indexOf('--pull-request');
  const pullRequest = flag > 0 ? Number(process.argv[flag + 1]) : undefined;
  process.stdout.write(
    `${betaVersion(manifest.version, Number(process.argv[2]), tags, pullRequest)}\n`,
  );
}
