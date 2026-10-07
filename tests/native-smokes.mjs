/**
 * Runs every native Electron smoke check in sequence against the current
 * dist-desktop build and prints a pass/fail summary. Add new checks to SMOKES.
 *
 *   node tests/native-smokes.mjs [name …]   (all checks when no name is given)
 *
 * Each check's complete output is written to outputs/smoke-logs/<name>.log.
 * Without a display on Linux (or with STRATUM_SMOKE_HEADLESS=1), Chromium's
 * headless Ozone platform is used with a screen large enough for the 1540 px
 * smoke windows. Where the SUID sandbox is unavailable (CI, containers), run
 * with ELECTRON_DISABLE_SANDBOX=1; this only affects these test processes.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const SMOKES = [
  { name: 'smoke', args: ['desktop/main.mjs', '--smoke'] },
  { name: 'ui-smoke', args: ['desktop/main.mjs', '--ui-smoke'] },
  { name: 'report-workspace', args: ['tests/report-workspace-smoke.mjs'] },
  { name: 'report-plot', args: ['tests/report-plot-smoke.mjs'] },
  { name: 'report-builder', args: ['tests/report-builder-smoke.mjs'] },
];
// Each check has its own shorter timeout; this only stops a hung process.
const LIMIT_MS = 10 * 60 * 1000;

const root = fileURLToPath(new URL('../', import.meta.url));
const logs = fileURLToPath(new URL('../outputs/smoke-logs/', import.meta.url));
const requested = process.argv.slice(2);
const unknown = requested.filter(
  (name) => !SMOKES.some((smoke) => smoke.name === name),
);
if (unknown.length) {
  process.stderr.write(
    `Unknown smoke check: ${unknown.join(', ')}. Choose from ${SMOKES.map((smoke) => smoke.name).join(', ')}.\n`,
  );
  process.exit(2);
}
if (
  !existsSync(
    fileURLToPath(new URL('../dist-desktop/index.html', import.meta.url)),
  )
) {
  process.stderr.write(
    'dist-desktop is missing; run pnpm desktop:build first.\n',
  );
  process.exit(2);
}
const headless =
  process.env.STRATUM_SMOKE_HEADLESS === '1' ||
  (process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY);
const flags = headless
  ? [
      '--ozone-platform=headless',
      '--ozone-override-screen-size=1920,1200',
      '--disable-gpu',
    ]
  : [];
mkdirSync(logs, { recursive: true });

function run({ name, args }) {
  const log = `${logs}${name}.log`;
  const started = Date.now();
  return new Promise((resolve) => {
    const out = createWriteStream(log);
    const child = spawn(electron, [...flags, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const timer = setTimeout(() => {
      out.write(`\nKilled after ${LIMIT_MS / 1000} s.\n`);
      child.kill('SIGKILL');
    }, LIMIT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out.end(() =>
        resolve({
          name,
          log,
          passed: code === 0,
          status: signal ?? `exit ${code}`,
          seconds: (Date.now() - started) / 1000,
        }),
      );
    });
  });
}

const selected = requested.length
  ? SMOKES.filter((smoke) => requested.includes(smoke.name))
  : SMOKES;
process.stdout.write(
  `Running ${selected.length} native smoke check(s)${headless ? ' headless' : ''}.\n`,
);
const results = [];
for (const smoke of selected) {
  process.stdout.write(`\n▶ ${smoke.name}\n`);
  const result = await run(smoke);
  results.push(result);
  const lines = readFileSync(result.log, 'utf8').trimEnd().split('\n');
  if (result.passed) {
    // The checks finish with a one-line description of what passed.
    const summary = lines.filter((line) =>
      /passed|verified|STRATUM_SMOKE_OK/.test(line),
    );
    process.stdout.write(`${summary.join('\n')}\n`);
  } else {
    process.stdout.write(
      `${result.status}; last lines of ${result.log}:\n${lines.slice(-40).join('\n')}\n`,
    );
  }
}
process.stdout.write('\nNative smoke summary\n');
for (const { name, passed, status, seconds } of results)
  process.stdout.write(
    `  ${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${seconds.toFixed(1).padStart(6)} s${passed ? '' : `  (${status})`}\n`,
  );
const failed = results.filter((result) => !result.passed).length;
process.stdout.write(
  failed
    ? `${failed} of ${results.length} failed. Logs and screenshots are in outputs/.\n`
    : `All ${results.length} passed.\n`,
);
process.exitCode = failed ? 1 : 0;
