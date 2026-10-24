// Pull request test builds (docs/releasing.md): .github/workflows/test-build.yml
// keeps one prerelease per labelled pull request, tagged `pr-<number>`, whose
// installer and latest.yml it replaces on every push and deletes when the
// pull request closes or loses the label. Its tag is not a version, so
// electron-updater's beta channel never takes it; Help → Test a Pull
// Request… (desktop/updater.mjs) lists these builds and follows one through
// a generic feed on that release's downloads.
//
// No Electron imports: tests load this module directly.

export const TEST_BUILD_LABEL = 'test-build';
const TAG = /^pr-(\d+)$/;
const VERSION = /^\d+\.\d+\.\d+-pr\.(\d+)\.\d+$/;
const MARKER = /<!-- stratum-test-build (\{.*?\}) -->/s;
// Only the workflow's own token creates these releases.
const PUBLISHER = 'github-actions[bot]';
const NAME = /^[A-Za-z0-9_.-]+$/;
const API_TIMEOUT_MS = 15_000;

export const testBuildTag = (pullRequest) => `pr-${pullRequest}`;

/** The pull request a test build version belongs to, if it is one. */
export function pullRequestOfVersion(version) {
  const match = VERSION.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * The GitHub repository of an app-update.yml feed, or undefined for any
 * other feed (test builds are GitHub releases).
 */
export function feedRepository(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (fields.provider !== 'github') return undefined;
  const { owner, repo } = fields;
  return NAME.test(owner ?? '') && NAME.test(repo ?? '')
    ? { owner, repo }
    : undefined;
}

/** A generic electron-updater feed on one pull request's test build. */
export const testBuildFeed = ({ owner, repo }, pullRequest) =>
  `https://github.com/${owner}/${repo}/releases/download/${testBuildTag(pullRequest)}/`;

/** The release notes' machine-readable block, written by the workflow. */
export function testBuildNotes(metadata) {
  // `<` and `>` escaped, so no title can end the HTML comment.
  const json = JSON.stringify(metadata)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return `<!-- stratum-test-build ${json} -->`;
}

function readMetadata(body) {
  const match = MARKER.exec(body ?? '');
  if (!match) return undefined;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  const text = (value) => typeof value === 'string' && value.length > 0;
  if (
    !data ||
    !Number.isSafeInteger(data.pullRequest) ||
    !text(data.version) ||
    pullRequestOfVersion(data.version) !== data.pullRequest ||
    !text(data.commit) ||
    !text(data.branch) ||
    !text(data.builtAt)
  )
    return undefined;
  const formats = {};
  for (const [format, version] of Object.entries(data.formats ?? {}))
    if (Number.isSafeInteger(version)) formats[format] = version;
  return {
    pullRequest: data.pullRequest,
    title: text(data.title) ? data.title : '',
    version: data.version,
    commit: data.commit,
    branch: data.branch,
    builtAt: data.builtAt,
    formats,
  };
}

async function getJson(fetch, path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 429
        ? 'GitHub is limiting requests from this network. Try again in an hour.'
        : `GitHub answered ${response.status} ${response.statusText}.`,
    );
  return response.json();
}

/**
 * Published test builds of open pull requests from the repository itself
 * (never forks), newest build first. `fetch` is Electron's net.fetch.
 */
export async function listTestBuilds({ owner, repo }, fetch) {
  const [releases, pulls] = await Promise.all([
    getJson(fetch, `/repos/${owner}/${repo}/releases?per_page=100`),
    getJson(fetch, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`),
  ]);
  const self = `${owner}/${repo}`.toLowerCase();
  const open = new Map(
    pulls
      .filter((pull) => pull.head?.repo?.full_name?.toLowerCase() === self)
      .map((pull) => [pull.number, pull]),
  );
  const builds = [];
  for (const release of releases) {
    const tag = TAG.exec(release.tag_name ?? '');
    if (
      !tag ||
      release.draft ||
      !release.prerelease ||
      release.author?.login !== PUBLISHER ||
      !release.assets?.some((asset) => asset.name === 'latest.yml')
    )
      continue;
    const metadata = readMetadata(release.body);
    const pull = open.get(Number(tag[1]));
    if (!metadata || !pull || metadata.pullRequest !== pull.number) continue;
    builds.push({
      ...metadata,
      title: pull.title || metadata.title,
      url: pull.html_url,
    });
  }
  return builds.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}

/** 'open', 'merged' or 'closed'. */
export async function pullRequestState({ owner, repo }, fetch, pullRequest) {
  const pull = await getJson(
    fetch,
    `/repos/${owner}/${repo}/pulls/${pullRequest}`,
  );
  return pull.merged_at ? 'merged' : pull.state === 'open' ? 'open' : 'closed';
}

const FORMAT_NAMES = {
  workspace: 'workspace database',
  backup: 'workspace backup',
  workflow: 'workflow file',
};

/**
 * Formats `to` writes at a higher version than `from`: data it saves in them
 * is refused by a build like `from`. Unknown versions raise nothing.
 */
export function raisedFormats(from, to) {
  return Object.entries(to ?? {})
    .filter(([format, version]) => from?.[format] < version)
    .map(([format, version]) => ({
      format,
      name: FORMAT_NAMES[format] ?? format,
      from: from[format],
      to: version,
    }));
}

/** "2 h ago" style ages for build lists. */
export function age(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
