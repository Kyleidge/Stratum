# Stratum MCP server

`mcp/` is a [Model Context Protocol](https://modelcontextprotocol.io) server
that lets an agent (Claude Code, Codex or any MCP client) test Stratum
directly: run the real signal engine headlessly, and drive the real workbench
in a hidden Electron window. It is a development tool. It is not part of the
shipped app and adds no dependencies.

## Setup

The repository's `.mcp.json` registers it for Claude Code; approve the
`stratum` server when asked. Other clients run the same command from the
repository root:

```bash
node mcp/start.mjs          # or: pnpm mcp
```

- Codex (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.stratum]
  command = "node"
  args = ["/absolute/path/to/Stratum/mcp/start.mjs"]
  ```

- If `node` is not on the client's `PATH`, use its absolute path as the
  command, for example with
  `claude mcp add --scope local stratum -- /path/to/node mcp/start.mjs`, which
  takes precedence over `.mcp.json` on that computer only.

Node ≥22.15 is required, as for `pnpm test`. UI sessions need the Electron
runtime (`pnpm exec install-electron`) and, for the desktop source, a
`dist-desktop` build, which `ui_launch` makes when it is missing or older
than its sources (about a minute).

## Two places to work

| Target             | What runs                                                                      | Use it for                                                  |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `engine` (default) | `SignalEngine` in the server process, fake-indexeddb, an in-memory workspace   | Engine behaviour, numbers, workflows: milliseconds per call |
| `ui`               | The workbench in a hidden Electron window started by `ui_launch` (own profile) | What the user sees: dialogs, layout, keyboard, screenshots  |

Every workspace, operation and inspection tool takes `target`. With `"ui"` it
sends the same request through the window's own worker, so the screen
updates as if the user had done it, and then returns once the workbench has
rendered the result. Both targets run requests through
`lib/engine-requests.ts`, the handler the signal worker uses, so they cannot
behave differently.

Relative paths are taken from the repository root. Files the server writes go
to `outputs/mcp/` (ignored by Git) unless a path is given.

## Tools

**Workspace**: `stratum_status` (start here), `workspace_reset`,
`workspace_save` / `workspace_open` (`.stratum` backups, also to move a
workspace between engine and UI), `load_example` (`motor-test`, `eol-rig`,
`cam-phaser-eol`), `undo`, `redo`, `get_project` (raw records),
`engine_request` (any worker request).

**Inspect**: `list_history`, `describe` (Details of any ID or `#003`,
including the step's `savedCommand` and delete impact), `search`,
`list_recordings`, `list_segments`, `list_batches`, `read_samples` (exact
evaluated samples), `signal_statistics` (exact one-pass statistics, within
segments, optionally with a value calculation), `measure` (two cursors),
`plot` (a PNG of the min/max envelopes, one lane per unit).

**Operations** (each commits like its dialog, optionally named, and returns
the steps it created or changed and the Undo label; `preview: true` runs the
dialog's preview instead): `import_recording`, `derive`, `calculate_values`,
`segment`, `time_operation`, `edit_step`, `delete_step`, `rename`,
`set_checks`.

**Workflows and exports**: `workflow_validate`, `workflow_extract`,
`workflow_run` (a batch over files; `*` and `?` expand), `export_data`
(samples or summary CSV).

**Reference**: `catalog` lists derive functions, value calculations, segment
definitions, Compare & align settings, checks, and the raw request types read
from the source. Resources expose `AGENTS.md`, `docs/*.md` and the example
workflow files.

**UI**: `ui_launch` (`desktop`: the bundled renderer; `dev`: the development
server on port 3107, started when needed, which hot-reloads code edits),
`ui_close`, `ui_screenshot`, `ui_snapshot`, `ui_text`, `ui_query`,
`ui_click`, `ui_hover`, `ui_fill`, `ui_type`, `ui_press`, `ui_select`,
`ui_drag`, `ui_scroll`, `ui_upload`, `ui_wait`, `ui_eval`, `ui_console`,
`ui_resize`, `ui_reload`, `ui_files`.

`ui_snapshot` returns an outline of what is visible with refs such as `[e12]`
and states (`checked`, `disabled`, `value="…"`). Targets accept a ref,
`role=button[name="Derive signal"]` (exact name, else substring, ignoring
case), `text=Torque` or `text="Torque"`, `label=Window size`, or CSS; chain
them with `>>` and choose one with `>> nth=1`. Actions wait for the element,
refuse when another element covers it (unless `force`), and wait for opening
animations before returning. Most actions accept `screenshot: true`.

`ui_upload` clicks a control and answers its file choice: a file input's
chooser (recordings, workflow files), or on the desktop source the native
dialog (backups), which the session answers from its files folder.
`ui_files` lists what the window saved there (exports, backups).

## A typical session

1. `load_example {example: "motor-test"}` → seven steps, with IDs.
2. `derive {inputIds: [...], operation: "smooth", parameter: 25, preview: true}`,
   then without `preview` to create it.
3. `read_samples` / `signal_statistics` / `plot` to check results.
4. `edit_step` with the `savedCommand` from `describe`, then `undo`.
5. `ui_launch`, `load_example {example: "motor-test", target: "ui"}`,
   `ui_snapshot`, `ui_click {target: "e7"}`, `ui_screenshot`.

## How UI sessions work

`ui_launch` starts `desktop/main.mjs --automation` with
`--remote-debugging-port`. In automation mode the main process uses a
temporary profile under `--automation-dir`, never shows the window, renders
it offscreen (so animations, dialogs and menus run as they do for a user),
answers native file dialogs from the session's `files` folder and saves
downloads there. `--automation-url` loads a development server page without
the desktop bridge, as a browser would.

The server drives the page over the DevTools protocol (`mcp/cdp.ts`): real
mouse and keyboard input, file choosers, evaluation and console messages.
Page helpers (`mcp/page-helpers.ts`) resolve targets and build snapshots.
Screenshots and window resizes go through the window's control channel
(`desktop/automation.mjs`: JSON lines on stdin, replies on stdout), because a
never-shown window can only be captured by the main process. The app quits
when the server closes that channel. Pages opened with `?automation` expose
`globalThis.stratumAutomation` from `hooks/use-signal-engine.ts`: the
workbench's state and its request function.

## Extending it

Keep the server in step with the app; it is how agents test Stratum.

- **New engine request**: add it to `EngineRequest` and handle it in
  `lib/engine-requests.ts`. Its exhaustive `never` check fails the type check
  until it is handled, and `engine_request` and `catalog` pick it up with no
  server change. Add a typed tool when it is a user-facing operation.
- **New tool**: add it to a group in `mcp/tools/` (or a new group in
  `TOOL_GROUPS` in `mcp/server.ts`). Give it a clear description, a JSON
  schema with `target: TARGET` when it reads or changes a workspace, and a
  result that names things as the UI does (`mcp/describe.ts`).
- **New dialog or control**: give it an accessible role and name; that is
  what `ui_snapshot` shows and targets match.
- **Catalogs** are read from `FUNCTIONS`, `VALUE_FUNCTIONS` and the source,
  so new operations appear automatically.
- **Tests**: `tests/mcp-server.test.ts` (in `pnpm test`) covers the protocol
  and engine tools; the `mcp-ui` native smoke (`tests/mcp-ui-smoke.mjs`)
  drives a real window.

## Limits

- The engine workspace lives in memory; use `workspace_save` to keep it.
- One UI session at a time; `ui_launch` replaces the previous one.
- The `dev` source compiles on first load (about 30–60 s).
- `plot` draws min/max envelopes; use `read_samples` or `signal_statistics`
  for numbers, never plot points.
