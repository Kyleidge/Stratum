---
name: run-stratum
description: Build, run, test and drive the Stratum signal-workflow app. Use when asked to start or launch Stratum, run its dev server, click through the UI, take a screenshot, run a batch workflow, check a UI change in a real browser, run the engine directly, or run its tests, builds and desktop (Electron) smoke checks.
---

Stratum is a React app served by vinext (web) and wrapped by Electron
(desktop). Agents drive the web app with
`.claude/skills/run-stratum/driver.py`: it starts the dev server if needed,
opens a fresh headless Chrome and runs the commands you pipe in, one per line.
Engine-only changes under `lib/` can skip the browser with
`.claude/skills/run-stratum/engine-smoke.mjs`. All paths are relative to the
repository root. Verified on Windows 10 with Git Bash; Linux is untested.

## Prerequisites

- Python 3 with Playwright (`python -m playwright --version` → 1.63), plus
  Google Chrome or Edge installed. The driver uses the system Chrome
  (`--channel chrome`, or `msedge`), so no `playwright install` download is
  needed.
- Node 24. If `node` is not on PATH, use the one bundled with Python
  Playwright and put its folder on PATH: oxlint's type-aware pass launches
  `node` itself. Every command below uses `$NODE`:

```bash
NODE=$(command -v node || python -c "import os, playwright; print(os.path.join(os.path.dirname(playwright.__file__), 'driver', 'node.exe'))")
export PATH="$(dirname "$NODE"):$PATH"
"$NODE" --version
```

- `node_modules`, normally from `pnpm install --frozen-lockfile`. In a
  `.claude/worktrees/<name>` checkout on a machine without pnpm, link the
  main checkout's installed copy (PowerShell, from the worktree root). It is
  ignored by Git:

```powershell
New-Item -ItemType Junction -Path node_modules -Target (Resolve-Path ..\..\..\node_modules)
```

## Run (agent path)

Pipe commands to the driver. Each run starts with an empty workspace, its own
browser profile and isolated IndexedDB. If `http://localhost:3107` does not
answer, the driver starts the dev server there and stops it afterwards. It
reuses an already-running server. Screenshots and the server log go to
`outputs/run-stratum/` (ignored by Git).

```bash
python .claude/skills/run-stratum/driver.py <<'EOF'
example
shot batch.png
click .workflow-batch-table tbody tr:has-text("SN-24003")
wait section.workflow-item-bar
text section.workflow-item-bar
shot item-sn-24003.png
EOF
```

`example` opens Import ▾ → **Try the batch example (8 motors)**, unticks both
downloads, runs the batch and prints each row. This is the expected output
(about 3 s with a warm server; the first cold start compiles for about 10 s):

```text
  Pass | SN-24001 SN-24001.csv | —
  Fail | SN-24003 SN-24003.csv | Sweep 1 · Average torque = 74.7626 Nm; expected 78 Nm – 95 Nm. +2 more
  ...
  Error | SN-24008 SN-24008.csv | "Torque" is in lbf·ft, but the workflow expects Nm. +1 more
```

Always open the screenshot. A frame stuck on "Opening your workflow…" means
the worker never initialised.

| command                              | what it does                                           |
| ------------------------------------ | ------------------------------------------------------ |
| `click SEL` / `dblclick SEL`         | real mouse click on the first match                    |
| `fill SEL => TEXT`                   | replace an input's text (`\n` for new lines)           |
| `type TEXT` / `press KEY`            | keyboard: `F2`, `Enter`, `Alt+ArrowRight`, `Control+Z` |
| `select SEL => LABEL`                | native `<select>` by option label                      |
| `check SEL` / `uncheck SEL`          | Base UI checkboxes (`role=checkbox`, `aria-checked`)   |
| `upload SEL => FILE\|FILE`           | click SEL and answer the file chooser; globs allowed   |
| `download SEL => PATH`               | click SEL and save the download it triggers            |
| `wait SEL` / `gone SEL`              | wait for visible / hidden (30 s)                       |
| `shot NAME.png`                      | screenshot (into `outputs/run-stratum/` unless a path) |
| `text SEL` / `count SEL` / `eval JS` | read text, count matches, evaluate JS                  |
| `goto PATH`, `sleep S`               | navigate under the base URL; pause                     |

Selectors are Playwright selectors. Role selectors are the most stable:
`role=button[name="Import CSV"]`, `role=menuitem[name="Save workflow…"]`,
`role=textbox[name="Display name"]`. Importing your own file looks like this:

```bash
python .claude/skills/run-stratum/driver.py <<'EOF'
upload role=button[name="Import CSV"] >> nth=0 => examples/eol-rig/SN-24001.csv
wait .workflow-tree-row >> text=Torque
shot imported.png
EOF
```

Options: `--url`, `--headed`, `--channel msedge`, `--width/--height`
(default 1440×900), `--script FILE`, `--keep-server`.

### Engine without a browser

For changes under `lib/` (engine, recipes, checks), call the engine directly
with in-memory IndexedDB. The script runs the 8-motor batch and checks each
status:

```bash
"$NODE" --import ./tests/typescript-loader.mjs .claude/skills/run-stratum/engine-smoke.mjs
```

Prints `ok … SN-24008 error "Torque" is in lbf·ft…` for each motor, then `0
batches after one Undo`. It exits 1 if any status differs from
`lib/eol-example.ts`. Copy it to test another engine path; imports are relative
to `lib/` through `tests/typescript-loader.mjs`.

## Run (human path)

```bash
"$NODE" node_modules/vinext/dist/cli.js dev --port 3107   # open http://localhost:3107; Ctrl+C stops it
```

## Test and build

```bash
"$NODE" --import ./tests/typescript-loader.mjs --test tests/signal-engine.test.ts tests/signal-filters.test.ts tests/signal-history.test.ts tests/signal-functions.test.ts tests/regions.test.ts tests/workflow.test.ts tests/time-bases.test.ts tests/high-rate.test.ts tests/mockup-data.test.ts tests/mockup-chart.test.ts tests/plot-ticks.test.ts tests/report-data.test.ts tests/workflow-batch.test.ts
"$NODE" node_modules/typescript/bin/tsc --noEmit
"$NODE" node_modules/oxlint/bin/oxlint
"$NODE" node_modules/vinext/dist/cli.js build
```

Expect 173 tests to pass and a clean typecheck. Lint exits 1 with 19 errors,
all in `components/ui/` and `hooks/use-mobile.ts`; they predate this work, and
new files must add none.

Desktop (Electron) checks build the renderer, then run hidden native windows
with temporary profiles:

```bash
"$NODE" node_modules/vite/bin/vite.js build --config desktop/vite.config.ts
node_modules/electron/dist/electron.exe desktop/main.mjs --smoke
node_modules/electron/dist/electron.exe desktop/main.mjs --ui-smoke
node_modules/electron/dist/electron.exe tests/report-workspace-smoke.mjs
```

Each prints a success line: `STRATUM_SMOKE_OK: …`, or "Report workspace
passed: …". `--ui-smoke` takes about 2 minutes and verifies its downloads.
Launching `desktop/main.mjs` without a flag opens the user's real workspace
profile; don't do that to test.

## Gotchas

- **One vinext dev server per checkout.** A second `dev` on another port exits
  with "Another vinext dev server is already running" and the existing URL.
  The driver detects this and reuses that server; by hand, use the printed URL
  or stop that PID.
- **Claude's in-app browser pane** (the desktop app's Browser tab) is a poor
  driver for this app:
  - while the pane is hidden, screenshots time out and Base UI dialogs and
    menus freeze mid-animation;
  - clicking a Base UI menu trigger by reference often doesn't open it;
    focusing it and pressing Enter does;
  - one frame showed state that a direct check contradicted.

  Use `driver.py` for verification and the pane only to show the user.

- **Windows console encoding.** Python prints with cp1252, which crashes on
  "≤" and "·" in check messages. The driver forces UTF-8 output; set
  `PYTHONIOENCODING=utf-8` in your own scripts.
- **Viewport.** Below 1240 px the inspector becomes a drawer, and below 820 px
  History does too. At about 480 px the top-bar toolbar overlaps the Import ▾
  and Workspace buttons, so clicks land on the wrong control. Keep 1440×900.
- **Ambiguous labels.** `[aria-label="Workspace"]` matches the
  `<nav aria-label="Workspace">` before the button; use
  `role=button[name="Workspace"]`. The rename dialog is titled "Rename
  signal", "Rename value" or "Rename operation", never "Rename output".
- **History shows three outputs per step.** The 4th channel of an import
  (Winding temperature) is hidden behind "View all 4 outputs →". Type in
  `role=textbox[name="Search workflow"]` to reach it.
- **Trigger editor defaults** are threshold 900 and start offset −20 s on the
  selected signal. Fill every field explicitly
  (`role=spinbutton[name="Start threshold"]`, `"Start offset"`, …).
- **Base UI menus.** Radio items don't close their menu on click unless they
  have `closeOnClick` (the recording menu does). A stuck popup swallows the
  next click, so press Escape before continuing.
- **Lucide icons are `display: block`** (Tailwind's base styles), so an icon
  and text in a button wrap onto two lines unless the button is `inline-flex`.
- **Video.** Playwright's `record_video` needs a separately downloaded ffmpeg.
  A working alternative is CDP `Page.startScreencast` frames encoded with
  `imageio_ffmpeg.get_ffmpeg_exe()`.

## Troubleshooting

- **`exec: node: not found`** (from `node_modules/.bin/*` shims): Node is not
  on PATH. Call the JS entry directly with `$NODE`, as above.
- **Lint prints `'node' is not recognized…` then `Error running tsgolint`**
  with no findings: Node is not on PATH, so oxlint's type-aware pass failed.
  Run the `export PATH=…` line from Prerequisites.
- **`Dev server exited early; see outputs/run-stratum/dev-server.log`**: read
  the log. "Already running" is handled automatically; a missing `vinext`
  means `node_modules` isn't installed or linked.
- **`HTTP 404 …` under `page errors`** on the first run after a server start:
  it was seen once and didn't recur on later runs.
- **Removing the worktree's `node_modules` junction**: use
  `cmd /c rmdir node_modules`. That removes only the link, and the target stays
  intact (verified). Never `Remove-Item -Recurse` it.
