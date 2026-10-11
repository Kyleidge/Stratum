/**
 * A UI session: the real workbench in a hidden Electron window
 * (`desktop/main.mjs --automation`), driven over the DevTools protocol. It
 * loads the bundled desktop renderer (`dist-desktop`, rebuilt when sources
 * changed) or a development server, with a temporary profile, and answers
 * file dialogs from its own folder. As a `Backend` it sends requests to the
 * workbench's own worker through `globalThis.stratumAutomation`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  createWriteStream,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EngineCommand } from '../lib/engine-requests';
import type { Backend, Reply, WorkspaceState } from './backend';
import { withFiles, type FileRef } from './backend';
import { Cdp } from './cdp';
import { installPageHelpers } from './page-helpers';

export type LaunchOptions = {
  source: 'desktop' | 'dev';
  /** Development server URL (`dev`); started when it does not answer. */
  url?: string;
  width?: number;
  height?: number;
  theme?: 'dark' | 'light';
  /** Rebuild `dist-desktop` before a desktop launch. */
  build?: 'auto' | 'always' | 'never';
  progress?: (message: string) => void;
};

type ConsoleEntry = { level: string; text: string; time: number };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === 'object' && address ? address.port : 0),
      );
    });
  });

async function answers(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** The newest modification time under `paths` (renderer sources only). */
function newest(paths: string[]): number {
  let latest = 0;
  const stack = [...paths];
  while (stack.length) {
    const path = stack.pop()!;
    if (!existsSync(path)) continue;
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const name of readdirSync(path))
        if (name !== 'node_modules' && !name.startsWith('.'))
          stack.push(join(path, name));
    } else if (/\.(tsx?|css|html|svg|json)$/.test(path))
      latest = Math.max(latest, info.mtimeMs);
  }
  return latest;
}

/** Electron's modifier bits and the keys `press` understands by name. */
const MODIFIERS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  shift: 8,
};
const KEYS: Record<string, [code: string, keyCode: number, text?: string]> = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Insert: ['Insert', 45],
  Space: ['Space', 32, ' '],
  ' ': ['Space', 32, ' '],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `F${i + 1}`,
      [`F${i + 1}`, 112 + i] as [string, number],
    ]),
  ),
};

function keyEvent(combination: string) {
  const parts = combination.split('+');
  // "Control++" presses the plus key.
  const key = combination.endsWith('++') ? '+' : parts.pop()!;
  let modifiers = 0;
  for (const part of parts.filter(Boolean)) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit)
      throw new Error(`Unknown modifier "${part}" in "${combination}".`);
    modifiers |= bit;
  }
  const named = KEYS[key];
  if (named) {
    const [code, keyCode, text] = named;
    return {
      key: key === 'Space' ? ' ' : key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
      text,
    };
  }
  if (key.length !== 1)
    throw new Error(
      `Unknown key "${key}". Use a character or one of: ${Object.keys(KEYS).join(', ')}.`,
    );
  const upper = key.toUpperCase();
  const code = /[a-z]/i.test(key)
    ? `Key${upper}`
    : /\d/.test(key)
      ? `Digit${key}`
      : '';
  const shifted = modifiers & 8 && /[a-z]/.test(key) ? upper : key;
  return {
    key: shifted,
    code,
    windowsVirtualKeyCode: /[a-z\d]/i.test(key) ? upper.charCodeAt(0) : 0,
    modifiers,
    text: modifiers & 7 ? undefined : shifted,
  };
}

export class UiSession implements Backend {
  readonly target = 'ui';
  readonly console: ConsoleEntry[] = [];
  private exited = false;
  width: number;
  height: number;

  private constructor(
    private readonly child: ChildProcess,
    private readonly cdp: Cdp,
    readonly dir: string,
    readonly source: 'desktop' | 'dev',
    readonly url: string,
    private readonly devServer: ChildProcess | undefined,
    size: { width: number; height: number },
  ) {
    this.width = size.width;
    this.height = size.height;
    child.once('exit', () => (this.exited = true));
    const log = (level: string, text: string) => {
      // Electron's own sandbox bundle reports frames without a preload
      // (development pages); it is not the app's output.
      if (
        /sandboxed_renderer\.bundle|sandbox_bundle|binding\.startupData/.test(
          text,
        )
      )
        return;
      this.console.push({ level, text: text.slice(0, 2000), time: Date.now() });
      if (this.console.length > 300) this.console.shift();
    };
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const { type, args } = params as {
        type: string;
        args: { value?: unknown; description?: string }[];
      };
      log(
        type,
        args
          .map((arg) =>
            arg.value !== undefined
              ? typeof arg.value === 'string'
                ? arg.value
                : JSON.stringify(arg.value)
              : (arg.description ?? ''),
          )
          .join(' '),
      );
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = (
        params as {
          exceptionDetails: {
            text: string;
            exception?: { description?: string };
          };
        }
      ).exceptionDetails;
      log('exception', details.exception?.description ?? details.text);
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = (params as { entry: { level: string; text: string } })
        .entry;
      log(entry.level, entry.text);
    });
  }

  get filesDir() {
    return join(this.dir, 'files');
  }
  get alive() {
    return !this.exited && !this.cdp.closed;
  }

  static async ensureDesktopBuild(
    root: string,
    mode: 'auto' | 'always' | 'never',
    progress?: (message: string) => void,
  ) {
    const index = join(root, 'dist-desktop', 'index.html');
    if (mode === 'never') {
      if (!existsSync(index))
        throw new Error('dist-desktop is missing; launch with build "auto".');
      return 'kept';
    }
    if (mode === 'auto' && existsSync(index)) {
      const built = statSync(index).mtimeMs;
      const sources = newest(
        ['app', 'components', 'hooks', 'lib', 'public', 'desktop'].map((path) =>
          join(root, path),
        ),
      );
      if (sources <= built) return 'current';
    }
    progress?.('Building the desktop renderer (about a minute)…');
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        'desktop/vite.config.ts',
      ],
      { cwd: root, encoding: 'utf8', timeout: 600_000 },
    );
    if (result.status !== 0)
      throw new Error(
        `Desktop build failed:\n${(result.stderr || result.stdout || '').slice(-3000)}`,
      );
    return 'rebuilt';
  }

  private static async devServer(
    root: string,
    url: string,
    progress?: (message: string) => void,
  ): Promise<{ url: string; child?: ChildProcess }> {
    if (await answers(url)) return { url };
    const port = new URL(url).port || '3107';
    mkdirSync(join(root, 'outputs', 'mcp'), { recursive: true });
    const logPath = join(root, 'outputs', 'mcp', 'dev-server.log');
    const log = createWriteStream(logPath);
    progress?.(`Starting the development server on port ${port}…`);
    const child = spawn(
      process.execPath,
      [join(root, 'node_modules/vinext/dist/cli.js'), 'dev', '--port', port],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      log.write(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await answers(url)) return { url, child };
      const existing = /already running[\s\S]*?(http:\/\/\S+)/i.exec(output);
      if (existing && (await answers(existing[1]))) {
        child.kill();
        return { url: existing[1] };
      }
      if (child.exitCode !== null)
        throw new Error(
          `The development server exited; see ${logPath}.\n${output.slice(-1500)}`,
        );
      await sleep(500);
    }
    child.kill();
    throw new Error(`The development server did not answer at ${url}.`);
  }

  static async launch(root: string, options: LaunchOptions) {
    const progress = options.progress;
    let url = 'stratus://app/index.html';
    let devServer: ChildProcess | undefined;
    if (options.source === 'dev') {
      const server = await UiSession.devServer(
        root,
        options.url ?? 'http://localhost:3107/',
        progress,
      );
      url = server.url;
      devServer = server.child;
    } else
      await UiSession.ensureDesktopBuild(
        root,
        options.build ?? 'auto',
        progress,
      );
    const dir = mkdtempSync(join(tmpdir(), 'stratum-mcp-ui-'));
    mkdirSync(join(dir, 'files'), { recursive: true });
    const port = await freePort();
    const electron = createRequire(import.meta.url)('electron') as string;
    const headless =
      process.env.STRATUM_SMOKE_HEADLESS === '1' ||
      (process.platform === 'linux' &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY);
    // Test processes only: where Chromium's SUID sandbox helper is not
    // installed (CI, containers), it cannot start sandboxed.
    const sandbox = join(root, 'node_modules/electron/dist/chrome-sandbox');
    const noSandbox =
      process.platform === 'linux' &&
      existsSync(sandbox) &&
      !(statSync(sandbox).uid === 0 && statSync(sandbox).mode & 0o4000);
    const args = [
      ...(headless
        ? [
            '--ozone-platform=headless',
            '--ozone-override-screen-size=1920,1200',
            '--disable-gpu',
          ]
        : []),
      `--remote-debugging-port=${port}`,
      join(root, 'desktop/main.mjs'),
      '--automation',
      `--automation-dir=${dir}`,
      `--automation-parent=${process.pid}`,
      ...(options.source === 'dev' ? [`--automation-url=${url}`] : []),
    ];
    progress?.('Starting the Stratum window…');
    const child = spawn(electron, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(noSandbox ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
      },
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let socket = '';
    const deadline = Date.now() + 60_000;
    while (!socket) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill();
        devServer?.kill();
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`The Stratum window did not start.\n${output}`);
      }
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        socket =
          targets.find(
            (target) =>
              target.type === 'page' && target.url.includes('automation'),
          )?.webSocketDebuggerUrl ?? '';
      } catch {
        /* Not listening yet. */
      }
      if (!socket) await sleep(250);
    }
    const cdp = await Cdp.connect(socket);
    const session = new UiSession(
      child,
      cdp,
      dir,
      options.source,
      url,
      devServer,
      {
        width: options.width ?? 1440,
        height: options.height ?? 900,
      },
    );
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${installPageHelpers.toString()})()`,
    });
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    if (options.source === 'dev') {
      await cdp
        .send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: session.filesDir,
        })
        .catch(() => {});
    }
    await session.resize(session.width, session.height);
    if (options.theme) {
      await session.evaluate(
        `localStorage.setItem('stratum-theme-v1', ${JSON.stringify(options.theme)})`,
      );
      await session.reload();
    } else await session.waitReady();
    return session;
  }

  /** Evaluates an expression in the page (awaiting promises). */
  async evaluate<T = unknown>(expression: string, timeoutMs = 120_000) {
    const result = await this.cdp.send<{
      result: { value?: unknown; description?: string; type: string };
      exceptionDetails?: {
        text: string;
        exception?: { description?: string; value?: unknown };
      };
    }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        JSON.stringify(
          result.exceptionDetails.exception?.value ??
            result.exceptionDetails.text,
        );
      throw new Error(description.split('\n    at ')[0]);
    }
    return result.result.value as T;
  }

  /** Calls an installed page helper. */
  helper<T = unknown>(method: string, ...args: unknown[]) {
    return this.evaluate<T>(
      `(${installPageHelpers.toString()})(), globalThis.__stratumMcp.${method}(...${JSON.stringify(args)})`,
    );
  }

  async waitReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.evaluate<{
        ready?: boolean;
        error?: string;
      } | null>(
        `globalThis.stratumAutomation ? { ready: globalThis.stratumAutomation.state.ready, error: globalThis.stratumAutomation.state.error } : null`,
      ).catch(() => null);
      if (state?.ready) return;
      if (Date.now() > deadline)
        throw new Error(
          `The workspace did not become ready${state?.error ? `: ${state.error}` : ''}. Check ui_console.`,
        );
      await sleep(200);
    }
  }

  async reload() {
    await this.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(300);
    await this.waitReady();
  }

  async resize(width: number, height: number) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.width = width;
    this.height = height;
    await sleep(150);
  }

  /** Waits for `selector` to be visible and returns its centre. */
  async locate(selector: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.helper<{
        found: number;
        visible?: boolean;
        x?: number;
        y?: number;
        rect?: { x: number; y: number; width: number; height: number };
        description?: string;
        covered?: string;
      }>('locate', selector);
      if (found.visible) return found as Required<typeof found>;
      if (Date.now() > deadline)
        throw new Error(
          found.found
            ? `${selector} matches ${found.description}, but it is not visible.`
            : `Nothing matches ${selector}. Use ui_snapshot to find controls.`,
        );
      await sleep(100);
    }
  }

  /**
   * Lets an action's effects land: finite animations (dialogs and menus
   * opening) finish, up to a second; spinners are ignored.
   */
  async afterAction() {
    await this.evaluate(`(async () => {
      await new Promise((done) => setTimeout(done, 30));
      const running = document.getAnimations().filter(
        (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
      );
      await Promise.race([
        Promise.all(running.map((animation) => animation.finished.catch(() => {}))),
        new Promise((done) => setTimeout(done, 1000)),
      ]);
    })()`).catch(() => {});
  }

  async mouse(
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  async click(
    selector: string,
    options: {
      button?: 'left' | 'right' | 'middle';
      count?: number;
      modifiers?: string[];
      timeoutMs?: number;
      force?: boolean;
    } = {},
  ) {
    const target = await this.locate(selector, options.timeoutMs);
    if (target.covered && !options.force)
      throw new Error(
        `${target.description} is covered by ${target.covered}; close it first or pass force.`,
      );
    const modifiers = (options.modifiers ?? []).reduce(
      (bits, name) => bits | (MODIFIERS[name.toLowerCase()] ?? 0),
      0,
    );
    const button = options.button ?? 'left';
    await this.mouse('mouseMoved', target.x, target.y, { modifiers });
    for (let count = 1; count <= (options.count ?? 1); count++) {
      const common = { button, clickCount: count, modifiers, buttons: 1 };
      await this.mouse('mousePressed', target.x, target.y, common);
      await this.mouse('mouseReleased', target.x, target.y, {
        ...common,
        buttons: 0,
      });
    }
    await this.afterAction();
    return target.description;
  }

  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 12,
  ) {
    await this.mouse('mouseMoved', from.x, from.y);
    await this.mouse('mousePressed', from.x, from.y, {
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i++)
      await this.mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
        { button: 'left', buttons: 1 },
      );
    await this.mouse('mouseReleased', to.x, to.y, {
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await this.afterAction();
  }

  async press(combination: string) {
    const event = keyEvent(combination);
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: event.text ? 'keyDown' : 'rawKeyDown',
      ...event,
      unmodifiedText: event.text,
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    await this.afterAction();
  }

  async type(text: string) {
    await this.cdp.send('Input.insertText', { text });
    await this.afterAction();
  }

  async fill(selector: string, text: string) {
    await this.locate(selector);
    const description = await this.helper<string>('focus', selector);
    if (text) await this.type(text);
    else await this.press('Delete');
    return description;
  }

  /** Waits (up to `timeoutMs`) while the workbench reports it is busy. */
  async settle(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (
      Date.now() < deadline &&
      (await this.evaluate<boolean>(
        '!!globalThis.stratumAutomation?.state.busy',
      ).catch(() => false))
    )
      await sleep(50);
    await sleep(100);
  }

  async screenshot(selector?: string) {
    await this.settle();
    const clip = selector ? (await this.locate(selector)).rect : undefined;
    // A capture during a resize or repaint can fail once; try again.
    let png = '';
    for (let attempt = 1; !png; attempt++)
      try {
        ({ data: png } = await this.cdp.send<{ data: string }>(
          'Page.captureScreenshot',
          {
            format: 'png',
            ...(clip
              ? {
                  clip: {
                    x: Math.max(0, clip.x),
                    y: Math.max(0, clip.y),
                    width: Math.max(1, clip.width),
                    height: Math.max(1, clip.height),
                    scale: 1,
                  },
                }
              : {}),
          },
          30_000,
        ));
      } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(250);
      }
    return Buffer.from(png, 'base64');
  }

  /**
   * Clicks `selector` and answers the file choice with `paths`: a file input's
   * chooser (recordings, workflows), or else, on desktop, the bridge's native
   * dialog (backups), which opens the newest matching file in the session
   * folder.
   */
  async upload(selector: string, paths: string[]) {
    if (this.source === 'desktop' && paths.length === 1) {
      const target = join(this.filesDir, basename(paths[0]));
      copyFileSync(paths[0], target);
      const now = new Date();
      utimesSync(target, now, now);
    }
    let stop = () => {};
    const chooser = new Promise<{ backendNodeId: number } | null>((resolve) => {
      const timer = setTimeout(() => {
        stop();
        resolve(null);
      }, 3000);
      stop = this.cdp.on('Page.fileChooserOpened', (params) => {
        clearTimeout(timer);
        stop();
        resolve(params as { backendNodeId: number });
      });
    });
    const description = await this.click(selector);
    const opened = await chooser;
    if (opened)
      await this.cdp.send('DOM.setFileInputFiles', {
        files: paths,
        backendNodeId: opened.backendNodeId,
      });
    else if (this.source !== 'desktop' || paths.length !== 1)
      throw new Error(`Clicking ${selector} opened no file chooser.`);
    return description;
  }

  async request(
    request: EngineCommand | Record<string, unknown>,
  ): Promise<Reply> {
    const files: { name: string; data: string }[] = [];
    // Files travel into the page as base64 and become File objects there.
    const placeholders = (await withFiles(request, async (ref: FileRef) => {
      files.push({
        name: ref.name ?? basename(ref.$file),
        data: (await readFile(ref.$file)).toString('base64'),
      });
      return { $fileIndex: files.length - 1 };
    })) as Record<string, unknown>;
    const reply = await this.evaluate<Reply & { bytesBase64?: string }>(
      `(async (message, files) => {
        const automation = globalThis.stratumAutomation;
        if (!automation) throw new Error('The workbench is not ready.');
        const revive = (value) => {
          if (Array.isArray(value)) return value.map(revive);
          if (value && typeof value === 'object') {
            if (typeof value.$fileIndex === 'number') {
              const file = files[value.$fileIndex];
              const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
              return new File([bytes], file.name);
            }
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
          }
          return value;
        };
        const response = await automation.request(revive(message));
        // Return once the workbench has rendered the committed project.
        if (response.type === 'project')
          for (let i = 0; i < 250 && automation.state.revision !== response.revision; i++)
            await new Promise((done) => setTimeout(done, 20));
        if (response.blob) {
          const bytes = new Uint8Array(await response.blob.arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 32768)
            text += String.fromCharCode(...bytes.subarray(i, i + 32768));
          const { blob, ...rest } = response;
          return { ...rest, bytesBase64: btoa(text) };
        }
        return response;
      })(${JSON.stringify(placeholders)}, ${JSON.stringify(files)})`,
      600_000,
    );
    if (reply.bytesBase64 !== undefined) {
      const { bytesBase64, ...rest } = reply;
      return { ...rest, bytes: Buffer.from(bytesBase64, 'base64') } as Reply;
    }
    return reply;
  }

  async state(): Promise<WorkspaceState> {
    const state = await this.evaluate<WorkspaceState | null>(
      'globalThis.stratumAutomation?.state ?? null',
    );
    if (!state) throw new Error('The workbench is not ready.');
    return state;
  }

  cancel() {
    void this.evaluate('globalThis.stratumAutomation?.cancel()').catch(
      () => {},
    );
  }

  async close() {
    this.cdp.close();
    this.child.kill();
    this.devServer?.kill();
    await sleep(300);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
