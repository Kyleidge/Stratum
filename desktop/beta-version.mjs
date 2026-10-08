// The version of an automatic beta build (see docs/releasing.md):
// package.json's version with `-beta.<n>`, where n is the Release workflow's
// run number, so every beta outranks the one before it. Once that version
// has a stable tag, betas move on to the next patch, so they still outrank
// the stable release beta testers may have updated to.
//
//   node desktop/beta-version.mjs <n>    prints the version
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `version` may carry a prerelease; `tags` are the repository's tags. */
export function betaVersion(version, number, tags) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`Beta number must be a positive integer, not ${number}.`);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  if (!match) throw new Error(`Cannot make a beta of version ${version}.`);
  const [major, minor] = [match[1], match[2]];
  const released = new Set(tags);
  let patch = Number(match[3]);
  while (released.has(`v${major}.${minor}.${patch}`)) patch += 1;
  return `${major}.${minor}.${patch}-beta.${number}`;
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
  process.stdout.write(
    `${betaVersion(manifest.version, Number(process.argv[2]), tags)}\n`,
  );
}
