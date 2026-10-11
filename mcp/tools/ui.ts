/**
 * UI tools: launch the real workbench in a hidden Electron window and drive
 * it like a user (snapshot, click, type, keys, uploads, screenshots). Engine
 * tools take target "ui" to act through this window's own worker.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OVERWRITE, type ServerContext } from '../context';
import type { Tool, ToolResult } from '../protocol';
import { UiSession } from '../ui-session';

const TARGET_ARG = {
  type: 'string',
  description:
    'Element: a ref from ui_snapshot (e.g. "e12"), role=button[name="Derive"], text=Torque, label=Name, or CSS; chain with >> and pick with >> nth=N.',
};
const SHOT = {
  type: 'boolean',
  description: 'Return a screenshot after the action.',
};

export function uiTools(context: ServerContext): Tool[] {
  const session = () => {
    if (!context.ui?.alive)
      throw new Error('No UI session is running. Call ui_launch first.');
    return context.ui;
  };
  const image = async (
    ui: UiSession,
    text: string,
    selector?: string,
    savePath?: string,
    overwrite = false,
  ): Promise<ToolResult> => {
    const png = await ui.screenshot(selector);
    const path = savePath
      ? context.save(png, savePath, 'screen.png', overwrite)
      : '';
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: path ? `${text}\nSaved ${path}` : text },
      ],
    };
  };
  const after = async (ui: UiSession, text: string, shot: unknown) => {
    if (!shot) return text;
    await new Promise((done) => setTimeout(done, 250));
    return image(ui, text);
  };

  return [
    {
      name: 'ui_launch',
      developer: true,
      title: 'Launch the Stratum UI',
      description:
        'Opens the real workbench in a hidden Electron window with an empty, temporary workspace (closing any earlier session). "desktop" (default) loads the bundled desktop renderer, rebuilding dist-desktop first when sources changed (about a minute); "dev" loads the development server (started on port 3107 if needed) so code edits hot-reload. File dialogs and downloads use the session\'s files folder.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['desktop', 'dev'] },
          url: {
            type: 'string',
            description: 'dev: server URL (default http://localhost:3107/).',
          },
          build: {
            type: 'string',
            enum: ['auto', 'always', 'never'],
            description: 'desktop: when to rebuild dist-desktop.',
          },
          width: { type: 'integer', description: 'Viewport (default 1440).' },
          height: { type: 'integer', description: 'Viewport (default 900).' },
          theme: { type: 'string', enum: ['dark', 'light'] },
          assistant: {
            type: 'boolean',
            description:
              'Allow AI assistants in the session profile, to test the assistant channel with the bundled server.',
          },
        },
      },
      run: async (args, call) => {
        await context.ui?.close().catch(() => {});
        context.ui = undefined;
        const started = Date.now();
        context.ui = await UiSession.launch(context.root, {
          source: (args.source as 'desktop' | 'dev') ?? 'desktop',
          url: args.url as string | undefined,
          build: args.build as 'auto' | 'always' | 'never' | undefined,
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          theme: args.theme as 'dark' | 'light' | undefined,
          assistant: !!args.assistant,
          progress: (message) => call.progress(message),
        });
        return image(
          context.ui,
          `Stratum is ready (${context.ui.source}, ${Math.round((Date.now() - started) / 100) / 10} s). Files folder: ${context.ui.filesDir}`,
        );
      },
    },
    {
      name: 'ui_close',
      developer: true,
      title: 'Close the UI session',
      description: 'Closes the window and deletes its temporary profile.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        await context.ui?.close();
        context.ui = undefined;
        return 'Closed.';
      },
    },
    {
      name: 'ui_screenshot',
      developer: true,
      title: 'Screenshot',
      description: 'A PNG of the window, or of one element.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          savePath: { type: 'string', description: 'Also write the PNG.' },
          overwrite: OVERWRITE,
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) =>
        image(
          session(),
          `${session().width}×${session().height}`,
          args.target as string | undefined,
          args.savePath as string | undefined,
          !!args.overwrite,
        ),
    },
    {
      name: 'ui_snapshot',
      developer: true,
      title: 'Snapshot visible controls',
      description:
        'An indented outline of what is visible: landmarks, dialogs, headings and controls with refs (e.g. [e12]) and states (checked, disabled, value…). Use refs as targets. withText adds text blocks; target narrows to one element (waited for up to 5 s).',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          withText: { type: 'boolean' },
          limit: { type: 'integer', description: 'Lines (default 400).' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        // A target that is about to appear (a dialog opening) is waited for.
        if (args.target) await session().locate(args.target as string, 5000);
        return session().helper<string>(
          'snapshot',
          args.target ?? null,
          !!args.withText,
          Number(args.limit ?? 400),
        );
      },
    },
    {
      name: 'ui_text',
      developer: true,
      title: 'Read text',
      description:
        'The visible text (innerText) of an element, or of the page.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          limit: { type: 'integer', description: 'Characters (default 8000).' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        if (args.target) await session().locate(args.target as string, 5000);
        return session().helper<string>(
          'readText',
          args.target ?? null,
          Number(args.limit ?? 8000),
        );
      },
    },
    {
      name: 'ui_query',
      developer: true,
      title: 'Count and describe matches',
      description:
        "How many elements match a target (and how many are visible), with the first one's role, name and states. Does not wait.",
      inputSchema: {
        type: 'object',
        properties: { target: TARGET_ARG },
        required: ['target'],
      },
      annotations: { readOnlyHint: true },
      run: async (args) => session().helper('info', String(args.target)),
    },
    {
      name: 'ui_click',
      developer: true,
      title: 'Click',
      description:
        'A real mouse click on an element\'s centre (waits up to timeoutMs for it). count 2 double-clicks; modifiers such as ["Control"] or ["Shift"] extend selections. Refuses when another element covers it unless force.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          count: { type: 'integer' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          modifiers: { type: 'array', items: { type: 'string' } },
          force: { type: 'boolean' },
          timeoutMs: { type: 'integer' },
          screenshot: SHOT,
        },
        required: ['target'],
      },
      run: async (args) => {
        const ui = session();
        const clicked = await ui.click(String(args.target), {
          count: args.count as number | undefined,
          button: args.button as 'left' | 'right' | 'middle' | undefined,
          modifiers: args.modifiers as string[] | undefined,
          force: !!args.force,
          timeoutMs: args.timeoutMs as number | undefined,
        });
        return after(ui, `Clicked ${clicked}.`, args.screenshot);
      },
    },
    {
      name: 'ui_hover',
      developer: true,
      title: 'Hover',
      description: 'Moves the mouse over an element (tooltips, hover states).',
      inputSchema: {
        type: 'object',
        properties: { target: TARGET_ARG, screenshot: SHOT },
        required: ['target'],
      },
      run: async (args) => {
        const ui = session();
        const found = await ui.locate(String(args.target));
        await ui.mouse('mouseMoved', found.x, found.y);
        return after(ui, `Hovering ${found.description}.`, args.screenshot);
      },
    },
    {
      name: 'ui_fill',
      developer: true,
      title: 'Fill a field',
      description:
        'Focuses a text, number or search field, selects its content and types the text in its place (as typing does, so React sees it).',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          text: { type: 'string' },
          submit: { type: 'boolean', description: 'Press Enter afterwards.' },
          screenshot: SHOT,
        },
        required: ['target', 'text'],
      },
      run: async (args) => {
        const ui = session();
        const field = await ui.fill(String(args.target), String(args.text));
        if (args.submit) await ui.press('Enter');
        return after(ui, `Filled ${field}.`, args.screenshot);
      },
    },
    {
      name: 'ui_type',
      developer: true,
      title: 'Type text',
      description: 'Types text into whatever has focus.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, screenshot: SHOT },
        required: ['text'],
      },
      run: async (args) => {
        const ui = session();
        await ui.type(String(args.text));
        return after(ui, 'Typed.', args.screenshot);
      },
    },
    {
      name: 'ui_press',
      developer: true,
      title: 'Press keys',
      description:
        'Presses a key or combination in the focused element: "Enter", "Escape", "F2", "Control+K", "Control+Z", "Shift+ArrowDown", "Alt+ArrowRight". Several separated by spaces press in turn.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'string' },
          target: {
            ...TARGET_ARG,
            description: 'Click this element first to focus it.',
          },
          screenshot: SHOT,
        },
        required: ['keys'],
      },
      run: async (args) => {
        const ui = session();
        if (args.target) await ui.click(args.target as string);
        const keys = String(args.keys).trim().split(/\s+/);
        for (const key of keys) await ui.press(key);
        return after(ui, `Pressed ${keys.join(', ')}.`, args.screenshot);
      },
    },
    {
      name: 'ui_select',
      developer: true,
      title: 'Choose a native select option',
      description:
        'Chooses an option of a native <select> by label or value. For Base UI menus and selects, click the trigger and then the option instead.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          option: { type: 'string' },
          screenshot: SHOT,
        },
        required: ['target', 'option'],
      },
      run: async (args) => {
        const ui = session();
        await ui.locate(String(args.target));
        const chosen = await ui.helper<string>(
          'setSelect',
          String(args.target),
          String(args.option),
        );
        return after(ui, `Chose "${chosen}".`, args.screenshot);
      },
    },
    {
      name: 'ui_drag',
      developer: true,
      title: 'Drag',
      description:
        'Drags with the left button from an element (or point) to another element, a point, or by an offset: plot panning, range edges, sliders.',
      inputSchema: {
        type: 'object',
        properties: {
          from: TARGET_ARG,
          fromPoint: { type: 'array', items: { type: 'number' } },
          to: TARGET_ARG,
          toPoint: { type: 'array', items: { type: 'number' } },
          by: {
            type: 'array',
            items: { type: 'number' },
            description: '[dx, dy] in pixels from the start.',
          },
          screenshot: SHOT,
        },
      },
      run: async (args) => {
        const ui = session();
        const point = async (target: unknown, given: unknown) => {
          if (Array.isArray(given)) return { x: given[0], y: given[1] };
          if (typeof target === 'string') return ui.locate(target);
          return undefined;
        };
        const from = await point(args.from, args.fromPoint);
        if (!from) throw new Error('Give from or fromPoint.');
        const by = args.by as [number, number] | undefined;
        const to =
          (await point(args.to, args.toPoint)) ??
          (by ? { x: from.x + by[0], y: from.y + by[1] } : undefined);
        if (!to) throw new Error('Give to, toPoint or by.');
        await ui.drag(from, to);
        return after(
          ui,
          `Dragged from ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}.`,
          args.screenshot,
        );
      },
    },
    {
      name: 'ui_scroll',
      developer: true,
      title: 'Scroll or wheel',
      description:
        'Sends mouse-wheel movement over an element (or the page centre): scrolls lists, zooms plots.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          deltaY: { type: 'number', description: 'Pixels; positive is down.' },
          deltaX: { type: 'number' },
          modifiers: { type: 'array', items: { type: 'string' } },
          screenshot: SHOT,
        },
      },
      run: async (args) => {
        const ui = session();
        const at = args.target
          ? await ui.locate(args.target as string)
          : { x: ui.width / 2, y: ui.height / 2 };
        const modifiers = ((args.modifiers as string[]) ?? []).reduce(
          (bits, name) =>
            bits |
            ({ alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 }[
              name.toLowerCase()
            ] ?? 0),
          0,
        );
        await ui.mouse('mouseWheel', at.x, at.y, {
          deltaX: Number(args.deltaX ?? 0),
          deltaY: Number(args.deltaY ?? 300),
          modifiers,
        });
        return after(ui, 'Scrolled.', args.screenshot);
      },
    },
    {
      name: 'ui_upload',
      developer: true,
      title: 'Answer a file choice',
      description:
        'Clicks a control that asks for a file (Import, Run workflow, Restore…) and answers with these files. Desktop sessions answer the native dialog with one file at a time.',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          paths: { type: 'array', items: { type: 'string' } },
          screenshot: SHOT,
        },
        required: ['target', 'paths'],
      },
      run: async (args) => {
        const ui = session();
        const paths = (args.paths as string[]).map((path) =>
          context.path(path),
        );
        const clicked = await ui.upload(String(args.target), paths);
        return after(
          ui,
          `Clicked ${clicked} and chose ${paths.length} file(s).`,
          args.screenshot,
        );
      },
    },
    {
      name: 'ui_wait',
      developer: true,
      title: 'Wait',
      description:
        'Waits for an element to become visible (or hidden), for text to appear on the page, or for the workbench to finish its current work (idle).',
      inputSchema: {
        type: 'object',
        properties: {
          target: TARGET_ARG,
          state: { type: 'string', enum: ['visible', 'hidden'] },
          text: { type: 'string' },
          idle: { type: 'boolean', description: 'Wait until not busy.' },
          timeoutMs: { type: 'integer', description: 'Default 30000.' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const ui = session();
        const deadline = Date.now() + Number(args.timeoutMs ?? 30_000);
        const hidden = args.state === 'hidden';
        for (;;) {
          let done = true;
          if (args.target) {
            const info = await ui.helper<{ visible: number }>(
              'info',
              args.target as string,
            );
            done &&= hidden ? !info.visible : info.visible > 0;
          }
          if (args.text)
            done &&= await ui.evaluate<boolean>(
              `document.body.innerText.includes(${JSON.stringify(args.text as string)})`,
            );
          if (args.idle)
            done &&= await ui.evaluate<boolean>(
              '!globalThis.stratumAutomation?.state.busy',
            );
          if (done) return 'Done.';
          if (Date.now() > deadline)
            throw new Error(
              'Timed out waiting. Take a ui_screenshot to see why.',
            );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      },
    },
    {
      name: 'ui_eval',
      developer: true,
      title: 'Evaluate JavaScript',
      description:
        'Evaluates an expression in the page (promises are awaited) and returns its JSON value. globalThis.stratumAutomation has state (project, busy, error…) and request(message).',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      run: async (args) => {
        const value = await session().evaluate(String(args.expression));
        return value === undefined ? 'undefined' : value;
      },
    },
    {
      name: 'ui_console',
      developer: true,
      title: 'Console messages',
      description:
        'Recent console messages and uncaught exceptions from the page (newest last).',
      inputSchema: {
        type: 'object',
        properties: {
          errorsOnly: { type: 'boolean' },
          clear: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const ui = session();
        const entries = ui.console.filter(
          (entry) =>
            !args.errorsOnly ||
            ['error', 'exception', 'assert'].includes(entry.level),
        );
        const list = entries.slice(-Number(args.limit ?? 50));
        if (args.clear) ui.console.length = 0;
        return list.length
          ? list
              .map(
                (entry) =>
                  `${new Date(entry.time).toISOString().slice(11, 23)} ${entry.level}: ${entry.text}`,
              )
              .join('\n')
          : 'No messages.';
      },
    },
    {
      name: 'ui_resize',
      developer: true,
      title: 'Resize the viewport',
      description:
        'Sets the viewport size. Below 1240 px Details becomes a drawer; below 820 px History does too.',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          screenshot: SHOT,
        },
        required: ['width', 'height'],
      },
      run: async (args) => {
        const ui = session();
        await ui.resize(Number(args.width), Number(args.height));
        return after(
          ui,
          `Viewport ${Number(args.width)}×${Number(args.height)}.`,
          args.screenshot,
        );
      },
    },
    {
      name: 'ui_reload',
      developer: true,
      title: 'Reload the page',
      description:
        'Reloads the workbench (the workspace persists in the session profile) and waits until it is ready.',
      inputSchema: { type: 'object', properties: { screenshot: SHOT } },
      run: async (args) => {
        const ui = session();
        await ui.reload();
        return after(ui, 'Reloaded.', args.screenshot);
      },
    },
    {
      name: 'ui_files',
      developer: true,
      title: 'Saved files and downloads',
      description:
        'Files in the session folder: exports, downloads and backups the UI saved (native save dialogs are answered here), newest first.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const dir = session().filesDir;
        const files = readdirSync(dir)
          .map((name) => {
            const info = statSync(join(dir, name));
            return {
              name,
              path: join(dir, name),
              bytes: info.size,
              time: info.mtimeMs,
            };
          })
          .sort((a, b) => b.time - a.time)
          .map(({ time, ...file }) => ({
            ...file,
            modified: new Date(time).toISOString(),
          }));
        return { dir, files };
      },
    },
  ];
}
