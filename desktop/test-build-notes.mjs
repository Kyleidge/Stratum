// Release notes of a pull request's test build, written by
// .github/workflows/test-build.yml: a short explanation and the block
// Help → Test a Pull Request… reads (desktop/test-builds.mjs).
//
//   PR=31 PR_TITLE=… HEAD_REF=… HEAD_SHA=… STRATUM_VERSION=… \
//     node desktop/test-build-notes.mjs
import { fileURLToPath } from 'node:url';
import { repositoryFormatVersions } from './format-versions.mjs';
import { TEST_BUILD_LABEL, testBuildNotes } from './test-builds.mjs';

export function testBuildReleaseNotes(metadata) {
  return [
    `Test build of pull request #${metadata.pullRequest} (${metadata.branch} at ${metadata.commit.slice(0, 7)}), not a release.`,
    '',
    'Only copies that choose it in **Help → Test a Pull Request…** install it.',
    'They then update to newer builds of this pull request until they return',
    'to regular updates. Every push to the pull request replaces this build;',
    `it is removed when the pull request closes or loses the \`${TEST_BUILD_LABEL}\` label.`,
    '',
    testBuildNotes(metadata),
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  for (const name of ['PR', 'HEAD_REF', 'HEAD_SHA', 'STRATUM_VERSION'])
    if (!env[name]) throw new Error(`${name} is not set.`);
  process.stdout.write(
    testBuildReleaseNotes({
      pullRequest: Number(env.PR),
      title: env.PR_TITLE ?? '',
      version: env.STRATUM_VERSION,
      commit: env.HEAD_SHA,
      branch: env.HEAD_REF,
      builtAt: new Date().toISOString(),
      formats: repositoryFormatVersions(),
    }),
  );
}
