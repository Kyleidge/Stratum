# UI review and refresh mockup — September 2026

> **Removed in October 2026.** The refreshed layout was ported into the
> workbench, so the `/mockup` prototype, its in-memory data and
> `pnpm desktop:mockup` were deleted. This review is kept as a record; the
> prototype is in Git history before the cleanup commit.

Branch: `claude/ui-refresh-mockup`, from `main` at `e6fe85d`. The branch adds an
interactive prototype of a refreshed workbench beside the active UI; it does
not change the workbench, engine, storage or any workflow behavior.

## How to open the mockup

- Desktop: `pnpm desktop:mockup` builds the renderer and opens a native window
  with `--mockup`. That window uses a temporary profile and never opens the
  user's workspace or its IndexedDB.
- Browser: `pnpm dev`, then open `/mockup`. With the desktop renderer's Vite
  server, use `/?mockup=1`.

The prototype runs on an in-memory workspace (`lib/mockup-data.ts`) that starts
from the seven-step motor-test example and implements its own small set of
operations. Every control works against that workspace, and nothing is saved:
reloading, or Reset example workspace, starts over.

- Derive (moving average, scale, offset, absolute value, derivative, A × B),
  Segment (time ranges or windows), Value (time average, maximum, minimum) and
  Compare (time shift) open dialogs with a live preview and create steps.
- Edit settings rebuilds the step and replays every dependent step; Duplicate,
  Rename (F2) and Delete work too. Delete lists every dependent step it removes.
- Undo/Redo (Ctrl+Z / Ctrl+Y, 20 steps) and a toast Undo cover every change.
- Import CSV reads `Time,Name [unit],…` files; the recording menu scopes History.
- Keep plot and + create saved plots; drag signals from History onto a plot or
  tab to add them. Export writes an SVG of the plot, exact samples CSV, or the
  outputs table as CSV.
- Ctrl+K opens a command and output search; the ? button opens the guide.

## Method

The review covered the running example workflow in the desktop renderer at
1007 px and 1540 px widths and at phone width. It included history, plot,
operation outputs, value results, Derive, Segment, Workspace, the Inspect/export
menu and Signals & values. Findings cite the code responsible.

## Findings

| #   | Severity | Area             | Finding                                                                                                                                                                                                                                                                                                                             | Recommendation                                                                                                                                        |
| --- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Segment dialog   | The preview-signal picker labels inputs by graph node name, not the workflow label. With Run 1–3 as inputs, it lists three identical "Smoothed torque × Motor speed [Nm·rpm]" entries, while History calls them "Run 1–3 · Torque × speed" (`components/time-range-picker.tsx:103`).                                                | Use the same label source as History (`WorkflowIndex.label`) wherever a signal is named.                                                              |
| 2   | High     | Plot axes        | Tick labels divide the axis range evenly instead of using round numbers, giving labels such as 192.96, 1,036.1 and 6,095 rpm, or 10, 18, 26 s (`components/signal-chart.tsx:194`, `:729–745`, `:764–784`). Values are harder to read and compare across plots.                                                                      | Choose 1/2/5 × 10ⁿ steps and round the value domain outward. The mockup implements this in `niceTicks` / `niceDomain`.                                |
| 3   | Medium   | Layout           | Selecting an operation replaces the plot with the outputs table, leaving most of the document empty (#004, three runs). The results cannot be seen together.                                                                                                                                                                        | Overlay the operation's outputs on the plot and keep the table in a dock below it.                                                                    |
| 4   | Medium   | Values           | A calculated value appears as a card above the plot, but the plot does not show it. You cannot see where an average or peak sits relative to its signal.                                                                                                                                                                            | Draw each value as a labelled reference line over its input interval, or a marker at the time of the peak.                                            |
| 5   | Medium   | Chrome           | The header and the command bar are two stacked full-width bars (`workflow-workbench.tsx:639`, `:734`). The processing scope ("3 inputs ›") sits at the far right, away from the commands it controls (`workflow-toolbar.tsx:255`).                                                                                                  | Merge them into one bar and put the "Apply to" scope next to Derive/Segment/Value/Compare.                                                            |
| 6   | Medium   | History sidebar  | Four controls sit above the tree: scope select, two tabs, search, and the compact/outputs toggle. Details and the inventory sit below it. The tree gets about 60% of the rail, and Details truncates provenance ("#001 Record motor speed and tor…") (`workflow-workbench.tsx:751–937`).                                            | Keep the rail for history. Merge Signals & values into filter chips and move Details to a right-hand inspector with room for lineage.                 |
| 7   | Medium   | Theming          | Only a dark theme exists: `<html className="dark">`, with `:root` and `.dark` sharing one block (`app/globals.css:32–45`). `globals.css` has about 300 hard-coded hex colors (about 270 distinct), `workflow.css` 68 and `regions.css` 47. AGENTS.md asks for consistent light/dark themes, and the literals make that impractical. | Define colors as role tokens per theme and use only the tokens in components. The mockup's stylesheet has no raw colors outside its two theme blocks. |
| 8   | Low      | Typography       | `.workflow-app` forces `'Segoe UI'` (`app/workflow.css:761`), overriding the Geist fonts that `app/layout.tsx` downloads on the web. The base is 12 px, and `globals.css` uses 11 font sizes (9–24 px).                                                                                                                             | Pick one family and a 5-step scale (11/12/13/15/18 px), with tabular figures for numeric columns and axes.                                            |
| 9   | Low      | Output table     | The Type column renders as bordered, tinted chips that look like buttons but do nothing (`app/workflow.css:1275–1297`).                                                                                                                                                                                                             | Use a colored dot plus text for kind; keep button styling for buttons.                                                                                |
| 10  | Low      | Plot toolbar     | At 1007 px the plot toolbar wraps onto two rows of 20 small controls. SVG and PNG are separate text buttons.                                                                                                                                                                                                                        | Use grouped segmented controls on one row and a single Export entry.                                                                                  |
| 11  | Low      | Copy             | The Workspace dialog reads "1 recordings are saved" (`workflow-storage.tsx:108`). The Segment dialog repeats the same point twice (`segmentation-editor.tsx:429` and `:629`).                                                                                                                                                       | Pluralize, and remove the duplicate sentence.                                                                                                         |
| 12  | Low      | CSS hygiene      | Rule blocks are declared twice with conflicting values: `.workflow-header` (`app/workflow.css:873`, `:883`) and `.workflow-sidebar-heading` (`:152`, `:998`, where `padding` overrides `padding-bottom`).                                                                                                                           | Consolidate when tokens are introduced.                                                                                                               |
| 13  | Design   | Multi-unit plots | Each exact unit gets its own independently scaled Y axis on one shared plot (`lib/plot-axes.ts`). Two independent scales in one frame imply an alignment that the data does not have.                                                                                                                                               | Default mixed units to lanes that share one time axis (small multiples); keep multi-axis as an explicit option.                                       |

## What the mockup changes

- **One top bar**: brand, recording scope, Undo/Redo, the four operations, an
  "Apply to" chip showing the processing inputs, search (Ctrl K), Import, theme
  and help. Checked inputs turn the chip solid, and it can be cleared in place.
- **History rail**: a chronological spine of numbered step nodes, colored by
  operation kind, with a one-line summary per step. Order is shown by the spine,
  never by dependency indentation. All/Signals/Values chips and one filter field
  replace the scope select, tabs and separate catalog. Outputs that contribute to
  the current selection are marked with a dot.
- **Plot document**: value tiles above the plot for value selections; one
  toolbar row (Overlay/Stacked, Pan/Zoom/Measure, Fit, Hold Y, Align starts,
  Grid, Export); legend chips that hide and show traces; round-number ticks;
  mixed units in separate lanes; value reference lines with direct labels;
  crosshair readout; wheel zoom, drag pan, box zoom and A/B measurement. "Align
  starts" plots each segment from its own start time for run-to-run comparison.
- **Dock**: Outputs (with use-as-input checkboxes, kind dots and sparklines),
  Samples (exact values that follow the cursor, the table view of the plot) and
  Settings.
- **Inspector**: kind, name, the value as a headline, properties, a lineage
  chain from original recordings to the selection, "Used by", and
  Edit/Duplicate/Delete.
- **Themes and tokens**: light and dark are defined as role tokens. Trace colors
  use a fixed categorical order validated for color-vision deficiency in both
  themes, and each color follows its output, not its position in the current
  plot.
- **Responsive**: under 1240 px the inspector becomes a drawer; under 820 px the
  history does too. Phone width keeps one row of icon commands.

## Not in the prototype

The real engine, worker and storage; trigger segmentation; the full function
catalog; multi-recording alignment by events; plot annotations; printable
reports; virtualization of large histories; and keyboard tree navigation. The
active workbench already implements the behavioral rules in AGENTS.md
(virtualized history, bounded lists, atomic Edit, exact samples); a production
refresh must keep them while adopting the layout.

## Suggested order for adopting it

1. Fix findings 1, 2 and 11 in the active UI; they are independent of layout.
2. Introduce theme tokens and replace literals file by file (findings 7, 8, 12).
3. Merge the header and command bar, and move Details into an inspector (5, 6).
4. Keep the plot visible for operation selections and add value lines (3, 4).
5. Consolidate the plot toolbar and switch mixed units to lanes (10, 13).

## Validation on this branch

TypeScript, oxlint on the changed files and oxfmt pass. Full-repository lint
reports only the 19 documented starter-component issues. `pnpm test` passes
134/134. The desktop renderer build and the web build (including `/mockup`)
compile. The mockup was exercised at 1007 px, 1540 px and 375 px in both themes.
A scripted click-through (32 checks covering every command, dialog, undo/redo,
edit replay, delete impact, saved plots, drag and drop, import, exports, search
and theme) passes in the browser renderer and in the Electron window.

## Merge review — 23 September 2026

The merge review covers the prototype, its browser/desktop entry points and
isolation from the production workspace. The prototype remains in memory;
merging it does not replace the active workbench or integrate its illustrative
operations with the signal engine.

The review corrected the following defects:

- Editing could select the operation's own output or a later output as a
  Multiply input, creating cyclic or stale dependencies. Both the picker and
  model now require earlier inputs, replay increments dependent revisions, and
  failed replay leaves the workspace intact with an error inside the dialog.
- CSV parsing could misread quoted fields, skip malformed rows and silently
  truncate oversized recordings. Imports now validate complete rows and quoting,
  reject the 200,000-row limit explicitly and preserve intervening edits when
  asynchronous file reads finish. CSV exports neutralize formula-like labels.
- Window segmentation silently stopped after 200 windows; it now reports that
  limit. Centred smoothing rejects even widths and uses a rolling calculation
  for large inputs. Missing derivative samples stay missing, and multiplication
  rejects an overlap too short to form a signal.
- The Samples table rounded small timestamps and used a fixed matching tolerance
  that could omit or repeat nearby samples. It now preserves numeric precision
  and matches actual display times. Crop boundaries also use exact comparisons.
- Simultaneous plots shared SVG clipping IDs, stacked lanes could collapse, and
  large-offset axes could hang while generating ticks. Clips are unique, lanes
  have a minimum height and tick generation is bounded.
- F2 could focus a hidden rename field on narrow layouts; it now opens the
  inspector. Drawers can be dismissed with Escape and the inspector has a close
  control. Compact Import and Export controls now have accessible names.

All 152 tests pass, including 18 new model and axis regressions in the normal
test command. Validation
also includes TypeScript, formatting, scoped lint, browser and desktop builds,
the native production UI smoke test and live browser checks of the prototype.
The full lint baseline remains the same 19 starter-component issues. In this
environment, checks used the installed executables behind the package scripts
because the bundled pnpm launcher attempted an unnecessary dependency reinstall.

## Adoption in the workbench — October 2026

The active workbench now implements the refresh, following the suggested order
above. The prototype remains at `/mockup` as the design reference; it still
runs on its own in-memory workspace.

| #   | Area             | Adopted as                                                                                                                                                                                      |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Segment dialog   | Preview, trigger and target choices use the History labels (`WorkflowIndex.label`).                                                                                                             |
| 2   | Plot axes        | Time and value ticks use 1/2/5 × 10ⁿ steps from `lib/plot-ticks.ts`; logarithmic axes use decades. The value range keeps its padding instead of rounding outward, so held scales are unchanged. |
| 3   | Layout           | An operation plots up to eight outputs on Active, coloured by position, above a dock with Outputs, Samples and Settings.                                                                        |
| 4   | Values           | Values are dashed reference lines with direct labels; minima and maxima mark their time. Value operations show result tiles above the plot.                                                     |
| 5   | Chrome           | One top bar holds the scope menu, Undo/Redo, the four operations and the "Apply to" chip, which names a single input and clears checked inputs in place.                                        |
| 6   | History sidebar  | One filter field and All/Signals/Values chips; numbered, kind-coloured steps on a spine; dots on contributing outputs. Details are in a right-hand inspector with lineage and Used by.          |
| 7   | Theming          | Role tokens per theme in `app/globals.css`, with a persisted light theme. Stylesheets contain no raw colours outside the two theme blocks.                                                      |
| 8   | Typography       | One system font family, a five-step scale and tabular figures.                                                                                                                                  |
| 9   | Output table     | Output kinds are a coloured dot and text.                                                                                                                                                       |
| 10  | Plot toolbar     | One row of grouped segmented controls with a single Export menu; labels collapse to icons in narrow plots.                                                                                      |
| 11  | Copy             | Pluralized, with the duplicate segmentation hint removed.                                                                                                                                       |
| 12  | CSS hygiene      | The duplicate header and sidebar rules were rewritten once, and styles for about 20 classes that no component uses were removed.                                                                |
| 13  | Multi-unit plots | Overlay draws different units in lanes on one time axis; the "Y axes" layout keeps multi-axis overlays as an explicit choice.                                                                   |

The workbench also adopts the prototype's Ctrl+K command palette, Ctrl+Z/Ctrl+Y,
Undo in change notices, and drawers for the inspector below 1240 px and History
below 820 px.

It keeps the engine behaviours listed under "Not in the prototype": the
virtualized history, bounded lists, atomic Edit and exact samples. Unlike the
prototype, the Samples tab pages exact samples of one plotted signal rather
than following the cursor, the outputs table has no sparklines (each would need
its own engine read), and dark remains the default theme. The printable
HTML report is a standalone document and keeps its own print colours. Saved
trace colours stay fixed values because users can edit them.
