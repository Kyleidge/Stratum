import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageRoot } from '../desktop/notices.mjs';
import { betaVersion } from '../desktop/beta-version.mjs';
import { repositoryFormatVersions } from '../desktop/format-versions.mjs';
import { testBuildReleaseNotes } from '../desktop/test-build-notes.mjs';
import {
  age,
  feedRepository,
  listTestBuilds,
  pullRequestOfVersion,
  raisedFormats,
  testBuildFeed,
  testBuildNotes,
} from '../desktop/test-builds.mjs';
import { WORKSPACE_SCHEMA_VERSION } from '../lib/signal-engine';
import { ARCHIVE_VERSION } from '../lib/workspace-archive';
import { WORKFLOW_VERSION } from '../lib/workflow-recipe';

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n',
  );

void test('every desktop build keeps the original Stratus profile and origin', () => {
  // Existing workspaces live in %APPDATA%\Stratus under the stratus://app
  // origin. Electron would otherwise derive the profile from the app name
  // (Stratum), so the installer, unpacked and development runs must all pin
  // it before the app is ready.
  const main = read('desktop/main.mjs');
  const pin = main.indexOf(
    "app.setPath('userData', resolve(app.getPath('appData'), 'Stratus'));",
  );
  assert.ok(pin > 0, 'main.mjs must pin userData to appData/Stratus');
  assert.ok(pin < main.indexOf('app\n    .whenReady()'));
  assert.match(main, /scheme: 'stratus',/);
  assert.match(main, /loadURL\(\s*`stratus:\/\/app\/index\.html/);
  // Uninstalling must never remove a workspace.
  assert.match(read('desktop/package.mjs'), /deleteAppDataOnUninstall: false/);
});

void test('licence notices attribute bundled modules to their packages', () => {
  assert.equal(packageRoot('/repo/lib/signal-engine.ts'), undefined);
  const react = packageRoot(
    fileURLToPath(new URL('../node_modules/react/index.js', import.meta.url)),
  );
  assert.ok(react?.replaceAll('\\', '/').endsWith('/node_modules/react'));
});

void test('automatic betas outrank earlier betas and released versions', () => {
  assert.equal(betaVersion('1.0.0', 42, []), '1.0.0-beta.42');
  assert.equal(
    betaVersion('1.0.0-beta.3', 42, ['v1.0.0-beta.3']),
    '1.0.0-beta.42',
  );
  // Once 1.0.0 is tagged, betas move on so beta installs keep updating.
  assert.equal(
    betaVersion('1.0.0', 43, ['v1.0.0', 'v1.0.1', 'v1.0.0-beta.42']),
    '1.0.2-beta.43',
  );
  assert.equal(betaVersion('1.1.0', 44, ['v1.0.0']), '1.1.0-beta.44');
  assert.throws(() => betaVersion('1.0', 1, []));
  assert.throws(() => betaVersion('1.0.0', 0, []));
  assert.throws(() => betaVersion('1.0.0', Number.NaN, []));
});

void test('pull request test builds have a channel of their own', () => {
  assert.equal(betaVersion('1.0.0', 42, [], 31), '1.0.0-pr.31.42');
  assert.equal(betaVersion('1.0.0', 43, ['v1.0.0'], 7), '1.0.1-pr.7.43');
  assert.throws(() => betaVersion('1.0.0', 1, [], 0));
  assert.equal(pullRequestOfVersion('1.0.0-pr.31.42'), 31);
  assert.equal(pullRequestOfVersion('1.0.0-beta.42'), undefined);
  assert.equal(pullRequestOfVersion('1.0.0'), undefined);
  // electron-updater orders a pull request's builds by run number.
  assert.ok(
    ['1.0.0-pr.31.9', '1.0.0-pr.31.10'].every(
      (version) => pullRequestOfVersion(version) === 31,
    ),
  );
});

void test('test builds read only GitHub feeds', () => {
  assert.deepEqual(
    feedRepository(
      'owner: Kyleidge\nrepo: Stratum\nprovider: github\nreleaseType: draft\nupdaterCacheDirName: stratum-updater\n',
    ),
    { owner: 'Kyleidge', repo: 'Stratum' },
  );
  assert.deepEqual(
    feedRepository('provider: \'github\'\r\nowner: "a"\r\nrepo: b\r\n'),
    { owner: 'a', repo: 'b' },
  );
  assert.equal(
    feedRepository('provider: generic\nurl: https://example.com/\n'),
    undefined,
  );
  assert.equal(
    feedRepository('provider: github\nowner: a/../b\nrepo: c\n'),
    undefined,
  );
  assert.equal(
    testBuildFeed({ owner: 'Kyleidge', repo: 'Stratum' }, 31),
    'https://github.com/Kyleidge/Stratum/releases/download/pr-31/',
  );
});

void test('the app lists only published test builds of open pull requests', async () => {
  const metadata = (pullRequest: number, builtAt: string) => ({
    pullRequest,
    title: 'Ends a comment --> <b>',
    version: `1.0.0-pr.${pullRequest}.5`,
    commit: 'abcdef0123456789',
    branch: 'feature',
    builtAt,
    formats: { workspace: 3, backup: 2, workflow: 2 },
  });
  const release = (
    pullRequest: number,
    builtAt: string,
    changes: Record<string, unknown> = {},
  ) => ({
    tag_name: `pr-${pullRequest}`,
    draft: false,
    prerelease: true,
    author: { login: 'github-actions[bot]' },
    assets: [{ name: 'latest.yml' }],
    body: testBuildReleaseNotes(metadata(pullRequest, builtAt)),
    ...changes,
  });
  const pull = (number: number, repository = 'Kyleidge/Stratum') => ({
    number,
    title: `Pull ${number}`,
    html_url: `https://github.com/Kyleidge/Stratum/pull/${number}`,
    head: { repo: { full_name: repository } },
  });
  const releases = [
    release(1, '2026-10-24T10:00:00Z'),
    release(2, '2026-10-24T12:00:00Z'),
    release(3, '2026-10-24T12:00:00Z', { draft: true }),
    release(4, '2026-10-24T12:00:00Z', { author: { login: 'someone' } }),
    release(5, '2026-10-24T12:00:00Z', { assets: [] }),
    // Closed: no open pull request.
    release(6, '2026-10-24T12:00:00Z'),
    // From a fork.
    release(7, '2026-10-24T12:00:00Z'),
    // Metadata of another pull request.
    { ...release(8, '2026-10-24T12:00:00Z'), tag_name: 'pr-9' },
    { ...release(1, '2026-10-24T12:00:00Z'), tag_name: 'v1.0.0-beta.4' },
  ];
  const pulls = [1, 2, 3, 4, 5, 9].map((number) => pull(number));
  pulls.push(pull(7, 'someone/Stratum'));
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    return new Response(
      JSON.stringify(url.includes('/releases') ? releases : pulls),
    );
  };
  const builds = await listTestBuilds(
    { owner: 'Kyleidge', repo: 'Stratum' },
    fetch,
  );
  assert.deepEqual(
    builds.map((build) => [build.pullRequest, build.title]),
    [
      [2, 'Pull 2'],
      [1, 'Pull 1'],
    ],
  );
  assert.deepEqual(builds[0].formats, {
    workspace: 3,
    backup: 2,
    workflow: 2,
  });
  assert.ok(
    requested.every((url) =>
      url.startsWith('https://api.github.com/repos/Kyleidge/Stratum/'),
    ),
  );
  // The title cannot end the HTML comment the metadata sits in.
  const notes = testBuildNotes(metadata(1, '2026-10-24T12:00:00Z'));
  assert.equal(notes.indexOf('-->'), notes.length - 3);
  await assert.rejects(
    listTestBuilds(
      { owner: 'a', repo: 'b' },
      async () => new Response('{}', { status: 403 }),
    ),
    /limiting requests/,
  );
});

void test('switching builds warns about raised file formats', () => {
  assert.deepEqual(
    raisedFormats(
      { workspace: 2, backup: 2, workflow: 2 },
      { workspace: 3, backup: 2, workflow: 1 },
    ),
    [{ format: 'workspace', name: 'workspace database', from: 2, to: 3 }],
  );
  // Unknown versions (a development build) raise nothing.
  assert.deepEqual(raisedFormats(undefined, { workspace: 3 }), []);
  assert.deepEqual(raisedFormats({ workspace: 3 }, undefined), []);
  assert.deepEqual(repositoryFormatVersions(), {
    workspace: WORKSPACE_SCHEMA_VERSION,
    backup: ARCHIVE_VERSION,
    workflow: WORKFLOW_VERSION,
  });
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.equal(age('2026-10-24T11:58:00Z', now), '2 min ago');
  assert.equal(age('2026-10-24T09:00:00Z', now), '3 h ago');
  assert.equal(age('2026-10-20T12:00:00Z', now), '4 days ago');
});
