# Stratum: instructions for Codex

## Current purpose and scope

Stratum is a local desktop signal-workflow application with a Sites browser preview.
It imports immutable CSV signals. Derivations create ordinary derived signals,
which can feed further derivations, segmentation, and scalar values. Segments
are time intervals of a whole recording (not signals); Derive, Value and nested
Segment steps work within the entire signal, one segment or all of a step's.
The primary navigation is chronological operation history with explicit output
membership and direct input/lineage links. Data stays local to the device.
There are no server API routes or cloud signal uploads.

## Architecture

- `lib/time-types.ts`, `time-model.ts`, and `time-executor.ts`: explicit time
  references, grouped event/offset/two-point alignment, shared/reference grids,
  interpolation/gap policy, optional centered FIR filtering and cross-file math.
  `components/time-workbench.tsx` exposes Compare & align. Time outputs use the
  workspace scope (`sourceId: ''`); derive provenance from every parent, never
  invent a source recording. Ordinary unary outputs inherit their time reference.
  Workspace segmentation uses its current time axis. See `docs/time-bases.md`.
  Keep time settings in workflow history for atomic Edit/replay and archive
  validation. Samples CSV identifies the time reference and all source recordings.

- React 19 and strict TypeScript, with Next-style App Router conventions supplied
  by vinext. Use the existing vinext/Vite commands rather than replacing the stack.
- `app/page.tsx`: homepage; `app/layout.tsx`: root document, metadata, Geist fonts.
- `components/workflow-workbench.tsx`: active desktop/browser workspace. Original
  and derived signals can be processed, segmented again, or reduced to values.
  `components/workflow-history.tsx` is a virtualized two-level chronological tree;
  `lib/workflow-tree.ts` bounds output previews and reveals selected members.
  Do not encode dependency depth as recursive indentation or regroup by names.
  A step with exactly one output is one `single` row (the output's name, the
  step number, and the step's name on a second line when it differs); it
  selects the output, and Details reaches the step through "Produced by".
  Inspection and checked processing inputs are independent; Ctrl/Shift+click
  and row check boxes in History edit only the checked inputs. A plain check box
  starts from the explicit checks; only Ctrl/Shift+click extends from the viewed
  signal. The Outputs table's Input column ticks only explicit inputs and marks
  the viewed row "in view". Rows are 28 px, or 44 px when a step name wraps to
  two lines, virtualized with prefix offsets. The last selection is stored per
  device (`stratum-workflow-selection-v1`), restored only if it still exists,
  and never journaled. Explicit parent
  navigation clears search; opening a search result preserves matching context.
  Lineage-filtered trees show only contributing outputs, not batch siblings.
  One top bar holds the recording scope, Undo/Redo (Ctrl+Z/Ctrl+Y), the four
  operations and their "Apply to" processing scope. Data | Reports, Import and
  the Apply to label stay labelled at laptop widths; secondary labels collapse
  first and the recording/Apply to pills have fixed, truncating widths
  (`--topbar-recording-width`, `--topbar-scope-width`) so end controls never
  clip. Add to report never switches workspace; it confirms with a toast and a
  badge on Reports. History filters by text and All/Signals/Values chips and
  dots outputs that feed the selection.
  `components/workflow-properties.tsx` is the right-hand Details panel
  (properties, bounded lineage chain, Used by, Checks, and a sticky Edit/New
  version/Delete footer; a batch summary while batch results are open). The
  dock keeps one height across tabs; Settings render as a table through
  `WorkflowStepSettings` with the raw JSON behind "Show raw". It becomes a drawer
  below 1240 px, and History becomes one below 820 px. Ctrl+K opens
  `components/workflow-command-palette.tsx`: the top-bar commands plus a word
  search over every step and output in scope, capped at 40 results.
- `components/function-editor.tsx`: Derive/Value dialog, settings beside a
  live preview (`components/preview-lanes.tsx`, one lane per unit). The worker's
  `derive-preview` evaluates an unsaved candidate built by creation's own
  validation; `value-preview` uses `SignalEngine.valueStatistics`, which
  `calculateValues` also uses. `lib/value-statistics.ts` computes every value
  in one streaming pass; `VALUE_FUNCTIONS` in `lib/workflow-types.ts` defines
  the catalog (groups, units, settings). Elapsed results are seconds from the
  input's start; crossings reuse `CrossingDetector`. `valueReference` in
  `lib/plot-scratchpad.ts` places a value on plots (time and count results
  draw at the level they refer to). `lib/value-bindings.ts` lets offset,
  scale, time-shift, value threshold/time and trigger threshold/offset
  settings take factor × a value (`ParameterBindings`); several candidate
  values are matched to each input by first-input lineage. Outputs store the
  resolved number in `parameters` plus `bindings`; steps list the values in
  `valueInputIds`, which drive Edit/Delete impact, lineage, Used by, archive
  validation and workflow-file `{ value: step, factor }` settings.
  `components/value-binding-control.tsx` is the shared "A number | A value"
  control. `lib/formula.ts` parses formula expressions (A = each input,
  B–Z = signals matched by sample grid, lowercase = bound values) into
  closures; never `eval`. Formula nodes keep `expression`, include it in
  their recipe key, and evaluate their parents in lockstep like binary math.
  `lib/units.ts` holds exact linear unit conversions for `convert` nodes;
  conversions are only within one family and labels match exactly. Previews run in inspection lanes and never save.
  `lib/parameter-scale.ts` gives sliders, presets and hints only; the engine
  validates values. `components/segment-plot.tsx` draws trigger thresholds and
  window spans; workflow segment previews run automatically. Operation dialogs
  use a header with "Applies to" chips (`components/operation-inputs.tsx`, which
  also builds edit titles and impact text), a scrolling `.operation-body` and a
  sticky `.operation-footer` with a one-line summary. Create stays disabled while
  the preview reports an error. Derive and Value remember the last operation in
  localStorage; trigger thresholds default to the input's range midpoint with
  offset 0. New segments are numbered per step ("Segment 01"; nested ones after
  their parent, "Segment 01.02"); saved names never change. Compare & align
  defaults to Align; its alignment preview is display-only.
- File segments (`lib/file-segments.ts`, `docs/workflow-proposal.md`): a
  Segment step (`segmentSetId`) stores a `SegmentSet` in `project.segmentSets`
  whose `FileSegment`s are recording-time intervals (end excluded unless a
  recording/parent end), never signals. `within` (`SegmentScope`: a set, or
  chosen `segmentIds`) on Derive, Value and Segment steps, chosen with
  `components/within-control.tsx`; steps record `within` and
  `segmentInputIds` (impact, lineage, Used by, ordering). Values within read
  the signal as it is there; derived outputs within read hidden
  `internal` crops (with `segmentId`) so running state restarts per segment.
  Never show hidden crops: `visibleInput` names the signal they read, and
  outputs carry `segmentId`. Edit maps outputs by key (`segmentOutputKeys`:
  segment place within its parent, or input + segment), so the segment count
  may change; `followRebuiltBatches` lets later steps that used a whole
  rebuilt batch follow it. Old crop-segment steps (`segmentationId`) still
  open, edit and replay. History shows a Segment step, and a step with
  several outputs within segments, as one row (`oneRowStep` in
  `lib/workflow-tree.ts`); a selected member highlights that row. Active
  shades segments (`ActivePlot.bands`/`focus`) over the signals chosen with
  "Choose signals" (any visible signal on the set's axis,
  `segmentSetSignals`, remembered per set on the device in
  `stratum-segment-signals-v1`), by default the signals that found them. Its
  `segments` chooser picks all segments, one (selecting and zooming to it) or
  "Aligned from start" (`components/aligned-segments-plot.tsx`, `view` with
  `windows`). A derive step within segments gets the same chooser
  (`segmentViews`, by step): all its outputs with bands, one segment's, or
  each input's outputs aligned; values within segments use the dock's By
  segment table.
- First run: `components/workflow-welcome.tsx` is the empty state and the
  post-import next-steps strip; `components/example-tour.tsx` only changes the
  selection and stores dismissal under `stratum-example-tour-v1`;
  `components/workflow-guide.tsx` is the tabbed guide, whose Shortcuts list must
  match the actual key handlers. `components/workflow-alert.tsx` with
  `lib/engine-error.ts` offers Reload only for worker/storage failures, never for
  validation errors. `lib/csv-import-messages.ts` names the file, row and cause
  of CSV problems. Import steps carry an optional `fileName` and default to
  "Import <file>". UI copy follows the glossary in `docs/ux-review.md` (step,
  New version…, Export data…, Add to report, Details); counts use
  `lib/format-count.ts`.
- `components/workflow-export.tsx` and `lib/workflow-delivery.ts`: explicit
  viewed/checked/whole-step export scope; values CSV, evaluated samples CSV,
  summary CSV, and standalone printable HTML reports with escaped labels
  (shown as "Export data" and "Quick HTML summary"; files are named after the
  recording, step and kind). These HTML summaries remain immutable snapshots.
  Sample exports preserve each signal's evaluated axis and blank missing values.
  Never substitute decimated plot points for sample data. CSV text cells must
  remain text in spreadsheets. Cancellation must prevent the download even
  when a worker request was queued behind another read.
- `components/report-builder-mockup.tsx` is also the main application's Reports
  workspace beside Data Inspector, chosen in the top bar. `lib/report-data.ts`
  resolves explicit signal and scalar membership; `lib/report-plot.tsx` captures
  saved plots with the workspace's lane, Y-axis and stacked layouts and value
  labels. Report blocks are snapshots: engine changes never silently refresh
  captures. Report edits do not mutate the signal engine or workflow history.
  Keep the report and plot views mounted across workspace switches. The draft
  persists device-locally in `lib/report-draft-store.ts` (its own IndexedDB,
  not part of backups); report Undo/Redo stays session-only. Captures record
  their source assets and a data fingerprint: "Data changed" and Update snapshot
  are explicit, never automatic. Report values use `formatReportValue` from
  `lib/report-format.ts`; exact values stay in CSV. While Reports is shown, workflow keyboard
  shortcuts stay inactive so report Undo never reaches workflow history. The
  editor maps its `--rb-*` tokens to the theme's role tokens; paper keeps its
  document colors. `/report-mockup` remains an isolated synthetic preview. See
  `docs/report-builder-mockup.md` for PDF limits and validation.
  `lib/report-templates.ts` defines page designs (border, header, footer),
  their clear areas and starter title pages; `components/report-frame.tsx`
  draws them behind blocks for canvas, previews and PDF alike. A design is
  document-level (`frame`), never blocks; starter text stays neutral ink.
- `lib/workflow-history.ts`: chronological invocation history, legacy adaptation,
  output ownership, and iterative lineage including binary and trigger inputs.
  `lib/workflow-types.ts`: immutable scalar records and explicit operation records.
  History and outputs commit together. New operations append. Explicit Edit
  rebuilds the operation and dependent invocations atomically, preserves their
  sequence/output IDs when cardinality matches, and increments revisions.
  `lib/workflow-lifecycle.ts` owns dependency impact, deletion and recipe replay.
  Removing one operation removes dependent invocation batches, not arbitrary
  individual outputs. Shared region scopes are dependencies, not owned data.
  `workflow-management.tsx` exposes impact confirmation, edit, duplicate and names.
  Undo/Redo retains 20 project snapshots across restarts. Housekeeping migrations
  must preserve the journal; do not journal them as user actions. Entries carry
  labels (`undoLabels`/`redoLabels`), explicit or from `describeChange`, which
  move with their entry; coalesced batches are labelled from current state and
  unlabeled older entries read "last change". After Undo/Redo the affected step
  stays selected while it exists.
- `lib/workflow-example.ts`: deterministic motor-test data and a seven-step
  original → smoothing → multiplication → run segments (speed triggers) →
  values within the runs → nested segments within Run 2 → values within them
  example built with normal engine commands. `workflowExample` publishes it as
  one undoable action. Refresh only replaces the selected synthetic source, keeps
  imported recordings, and retains old source columns for Undo. Staged imports
  stay journaled until metadata publication. Legacy example methods remain for
  compatibility tests; the active workflow UI uses `demo-workflow`.
- Batch workflows (see `docs/batch-workflows.md`): `lib/workflow-yaml.ts` is a
  strict YAML subset (no anchors, aliases or tags); `lib/workflow-recipe.ts`
  parses, validates and serialises `.stratum.yaml` recipes and turns each step
  into the same `WorkflowCommand` Edit uses; `lib/workflow-extract.ts` builds a
  recipe from a recording's History through `savedCommand`, binding channels by
  name and outputs by step reference. `SignalEngine.runWorkflow` stages one item
  (import, replay, checks) and commits it atomically. Later items of a batch
  coalesce into one Undo entry via the journal tag, without rewriting the
  journal. `lib/workflow-checks.ts` evaluates checks from exact statistics and
  validates batch records; Edit carries checks, `runId` and `recipeStepId`.
  Batches, runs and recipe text are part of the project and of backups;
  deleting an item's import removes its run. UI: `workflow-save-dialog.tsx`,
  `workflow-run-dialog.tsx` (header-only pre-flight), `workflow-batch-view.tsx`,
  `workflow-item-bar.tsx`, `workflow-checks-panel.tsx`, `app/workflow-batch.css`.
  Run status `none` ("No checks") ranks below Pass and is not flagged; older
  records stay valid. A pre-flight `channelMap` (missing channel → column) is
  passed to `runWorkflow` and recorded on the run; recipe text never changes.
  Batch value columns follow recipe step order. The open batch view is stored
  per device under `stratum-batch-view-v1`. The Workspace dialog holds backup,
  restore and the example; workflow commands live in the Import menu.
  Workflow files are version 2 (`WORKFLOW_VERSION`): a `segment` step finds
  file segments (no `input`), and `within` (`sweeps`, `sweeps[2]`, or a list
  of positions from one step) scopes derive, value and nested segment steps,
  bound at run time to a `SegmentScope`. Labels may use `{segment}`; segment
  steps take only `count` and `duration` checks and are never signal inputs or
  report bindings. Version 1 files keep crop segments (`crop-segment` in the
  recipe model), replay unchanged and keep their hash (`recipeYaml` writes the
  version a recipe was read with). Extraction writes version 2; legacy crop
  segment steps are written as version 1 only when nothing needs version 2,
  otherwise they are skipped with a named reason.
  Report templates (`lib/workflow-report-template.ts`) bind blocks to recipe
  references; `lib/workflow-batch-report.ts` renders one item's report, and
  `lib/zip-store.ts` packages PDFs. `lib/eol-example.ts` generates
  `examples/eol-rig` (`pnpm examples:eol`); tests check the committed copies match.
- `lib/workspace-archive.ts` validates versioned NDJSON workspace backups before
  publication (`ARCHIVE_VERSION`, `checkArchiveHeader`; optional header `app`,
  `createdAt`, `schema`). Restore stages original columns under fresh source IDs
  and commits metadata atomically, preserving the prior workspace for Undo.
  `SignalEngine.writeBackup`/`writeSamples` stream through a `ByteSink` via
  `ChunkedWriter` (1 MiB chunks, each write awaited); `archiveLines` reads a
  Blob or byte stream one record at a time (32 MiB per record). Browser Blobs
  keep the 128 MiB archive and 64 MiB samples CSV limits; native streams have
  none. A backup validates its own metadata first. Never publish partial
  archives or delete published/Undo/Redo source chunks during import recovery.
- Desktop bridge: `desktop/preload.cjs` (sandboxed CommonJS, requires only
  'electron') exposes `window.stratumDesktop`; `desktop/files.mjs` registers
  the IPC handlers (only the top-level `stratus://app` frame may call them).
  The renderer never names a path: it gets opaque handles for files chosen in
  native dialogs or for the auto-backup folder. Writes go to a hidden
  `.partial` file, flushed and renamed on finish; abort or a closed page
  deletes it. `lib/desktop-bridge.ts` is the typed, feature-detected client:
  it transfers a `WritableStream`/`ReadableStream` to the worker
  (`backup-workspace`/`export-samples` with `stream`, `restore-workspace` with
  a stream; reply `written`). Without the bridge the browser keeps downloads
  and file inputs. Automatic backups (`components/desktop-auto-backup.tsx`,
  Workspace dialog): main stores settings in userData `desktop-settings.json`,
  tracks the committed `revision` the renderer reports, and asks for a backup
  on window close (progress dialog, 15 s start / 10 min cap, a second close
  offers Quit without backup) and every 30 minutes while changed. Files are
  `Stratum-backup-<local time>.stratum`; `desktop/backup-files.mjs` rotates to
  the newest 10 and removes stale partials. Failures are shown in the app and
  once at the next launch. Smoke runs (`--smoke`, `--ui-smoke`,
  `--backup-smoke`; temporary profile only) answer dialogs from `outputs/`.
- `components/workflow-list.tsx`: render disclosure rows only while open, with
  30-item pages. Keep large lineage and checked-input lists bounded in the DOM.
- `docs/workflow-proposal.md`: design rationale, interaction rules and compatibility.
- Regions (engine only; the region workspace UI was removed): reusable
  recording-time pointers, not automatic channel copies. Older workspaces that
  contain them still open, migrate and replay.
- `hooks/use-signal-engine.ts`: worker request client; the active UI requests
  `init-workflow`. The engine keeps `init-regions` for compatibility tests.
- `lib/region-types.ts` and `lib/region-model.ts`: region versions, parent links,
  function invocations, ancestry and legacy migration. Never mutate an existing
  region version or retarget its children/results. View selection must remain
  independent of processing scope. Nested segmentation scans each parent separately.
  New intervals exclude their end unless it is an inclusive parent/recording end;
  migrated legacy intervals retain inclusive endpoints. Test with `pnpm test`,
  which includes `tests/regions.test.ts` and the earlier numerical suites.
- `components/region-controls.tsx`: small select/number fields shared by the
  dialogs (`app/regions.css` styles them).
- `components/signal-chart.tsx`: bounded SVG min/max envelope plots.
- `components/plot-scratchpad.tsx` and `lib/plot-scratchpad.ts`: Active plots
  the selection (a signal; a value as a labelled reference line over its input,
  with a marker at a minimum/maximum; or up to eight outputs of an operation,
  each coloured by its position in that operation) above value tiles and the
  `components/workflow-dock.tsx` Outputs/Samples/Settings dock. The chart fills
  the space between its controls and the dock. Saved plots persist styles, limits,
  annotations and viewport independently of workflow history. Palette hexes are
  stored trace IDs drawn through `seriesColor` as the theme's `--series-N`;
  exports and report captures resolve tokens with `resolveColor` so standalone
  files stay self-contained. Tick labels use ink; same-unit axes are titled by
  their unit. A narrow plot toolbar moves settings into "More plot tools", and a
  value's explanation collapses below 800 px of height. Plot gestures use
  display time and translate per-trace offsets before viewport evaluation.
  `lib/plot-axes.ts` groups exact units into independently scaled, automatically
  named Y axes on a shared time plot. Overlay (the default) draws each axis
  group in its own lane sharing the time axis; the explicit "Y axes" layout
  overlays them in one frame. Ticks use `lib/plot-ticks.ts` 1/2/5 steps. The
  plot toolbar is one row with a single Export menu. Additional same-unit axes
  use stable IDs; traces choose compatible axes without implicit conversion.
  Axis wheel zoom and drag pan target only their own scale. Persist settings by
  stable axis ID, never by a trace's display position. Annotation label heights
  are normalized plot positions; vertical drags never change their display time
  or clock.
  `lib/plot-measurement.ts` streams exact cursor samples and region statistics;
  never use envelope points as measurement samples. Boundary context points may
  extend outside a zoom window for drawing, but never enter its statistics.
  `lib/plot-export.ts` creates standalone SVG/PNG snapshots of displayed panels.
  See `docs/plotting-plan.md`; native checks include `desktop/plot-ui-smoke.ts`.
- `lib/signal-explorer.ts` (its legacy UI was removed; `operationLabels` and
  the explorer model remain for the dialogs and tests): virtualized,
  numbered operation chains with explicit batch collections and independent
  member branches. Keep exact batch membership; never infer batches from names.
  Files own file-segmentation operations and file segments with synchronized
  channels. Original signals own signal-only segmentation. Persist explicit
  segment scope; legacy file scope is inferred only from complete raw coverage.
  A Segment operation is one row above its outputs. Double-click or Enter/F2
  opens saved settings; disclosure arrows expand outputs. `segmentation-operation.ts`
  reads isolated settings snapshots, with a legacy fallback. New operations store
  complete input IDs/definitions atomically with outputs; revisions append history.
  On opening a workspace, missing legacy settings are restored and persisted as
  explicit ranges from saved boundaries. Preserve node IDs and downstream data;
  never invent old trigger settings or merge operations without batch provenance.
  Explicit creation/reveal commands clear stale search/collapse overrides and
  open the new operation's outputs. Each invocation stays one function item,
  including partial/mixed batches, anchored at its inputs' common ancestor.
- `lib/signal-functions.ts`: exposed function catalog shared by the UI, runtime
  operation validation, and numerical coverage tests. `lib/signal-examples.ts`
  defines four worked examples; the engine persists their recipe IDs for reuse.
- `lib/signal-graph.ts` and `lib/signal-executor.ts`: iterative graph indexing and
  stack-based streaming evaluation. Do not reintroduce recursion or depth caps.
- `lib/signal-range.ts`: binary-search chunk selection, with boundary neighbors,
  and range propagation through stateless unary/crop/time-alignment paths and
  shared-timestamp math. A window yields an exact contiguous run covering it
  plus one neighbor each side, and stops after it. Median and derivative read
  look-back; moving average, exponential, RC, integral and resample resume from
  checkpoints (`CHECKPOINTED` in `signal-executor.ts`) that a complete pass
  records, restoring the exact state, else they start at the first sample.
  Min-max, reference-grid and FIR resampling keep complete history. Windowed
  results must equal a complete pass sample for sample
  (`tests/windowed-evaluation.test.ts`).
- `lib/signal-recipe.ts`: content key of a signal's whole upstream recipe
  (not names, IDs or revisions). Derived plot indexes and checkpoints are
  stored under `derived-v1:<key>`; an Edit gets a new key. They are disposable,
  excluded from backups and pruned on open unless current, Undo or Redo
  signals use them. Bump the `derived-v1` version whenever an operation's
  numerical results change, so no stored index or checkpoint outlives it.
  Committing a Derive/Segment/Value/time dialog cancels its queued previews.
- `lib/plot-index.ts`: versioned, rebuildable min/max hierarchies for raw
  signals and, built by their first complete plot pass, derived signals.
  Index keys share source ownership with raw chunks but are excluded from backups.
  Publish roots only after their leaves; index recovery never changes workflow
  history. Summaries cover original samples; partial boundary blocks use exact
  data. Drawing candidates are not measurement or export samples. Blocks are
  packed in `Float64Array`s (v2 keys; a rebuild deletes the v1 entry). The read
  cache is capped at 32 MiB and builds at 64 MiB of base blocks (about 2.6
  billion channel samples); larger builds fall back to streaming reads.
  `lib/plot-view.ts` draws loaded detail where it reaches while a moved view
  loads, with overview points only beyond it. `docs/plot-interaction.md` has
  the UI pan/zoom benchmark.
- `lib/engine-yield.ts`: cooperative worker yielding with `scheduler.yield()` and
  a timer fallback. Preserve actual task boundaries so cancellation can arrive.
- `components/segmentation-editor.tsx`: trigger/range/window editor and saved
  segmentation provenance. `components/time-range-picker.tsx` draws multiple
  intervals on a bounded signal plot, with movement, edge resizing and exact
  numeric fields. Plot coordinates must match the segmentation clock: undo local
  display offsets, but keep workspace outputs on their current time axis.
  Start and end triggers
  independently select raw/derived signals, edges, thresholds, and signed offsets.
- `lib/formats/`: recording-file readers (see `docs/file-formats.md`).
  `index.ts` is the registry (content signatures before extensions, lazily
  loaded parsers, `RECORDING_ACCEPT`); `recording.ts` the contract: a file
  holds tables, each one time axis in seconds, streamed as bounded blocks via
  `BlobBytes`. Readers: `delimited.ts` (CSV, semicolons with decimal commas,
  tabs, UTF-16/Windows-1252), `mdf.ts` (MDF 4/3), `tdms.ts`, `mat.ts`,
  `xlsx.ts`, `wav.ts`. Never load a whole file; skip unsupported channels with
  a note rather than guessing. `SignalEngine.importRecording` validates times
  and publishes every chosen table in one commit; multi-table files open
  `components/workflow-import-dialog.tsx`, and batch items use `bestTable`.
  Fixtures in `tests/fixtures/formats/` come from its `generate_*.py` scripts.
- `lib/signal-engine.ts`: append-only IndexedDB columns, CSV import, lazy derived
  evaluation, segmentation, and samples/summary exports. `signal-math.ts` holds numerical
  helpers; `signal-types.ts` defines the domain and worker protocol.
- `lib/segmentation.ts`: stateful generic threshold crossings. No hidden smoothing
  or engine-ramp heuristics. Optional hysteresis (re-arm distance) and
  debounce (seconds held) reject chatter; at zero the detector must equal the
  adjacent-sample rule (`tests/trigger-noise.test.ts`). Pair crossings before applying offsets; retain
  source-time provenance and translate derived output axes. Segmentation creates
  crops only; engineering metrics are a separate explicit operation.
- `lib/signal.worker.ts`: serialized processing away from the UI thread, coordinated
  across windows by Web Locks plus optimistic metadata revisions. Cancellation
  includes queued requests; plot, samples and measurement inspections coalesce separately.
  Failed lock acquisition must never poison the queue. Fatal worker/renderer
  failures expose recovery, not another request to a dead worker.
- `lib/create-signal-worker.ts`: shared Vite worker factory. Use its explicit
  `?worker` import; vinext's source-identity rewrite makes application
  `import.meta.url` unsuitable for constructing browser worker URLs.
- `desktop/`: Electron shell and a separate Vite renderer build that shares the
  workbench. Native windows load bundled assets using a restricted custom scheme.
  `menu.mjs` is the application menu (Edit items never register accelerators,
  so workbench shortcuts reach the page); `updater.mjs` wraps electron-updater
  (installed Windows copies only, never dev or smoke runs; Help → Get Beta
  Updates opts into prereleases); `notices.mjs`
  writes `dist-desktop/THIRD_PARTY_NOTICES.txt` during `desktop:build`;
  `package.mjs` stages a minimal app for electron-builder. Icons come from
  `desktop/icons/stratum.svg` (`pnpm desktop:icons`). Releases (Windows NSIS,
  `.github/workflows/release.yml`, signing, update feed): `docs/releasing.md`.
  Every push to `main` except documentation publishes an automatic beta
  (`desktop/beta-version.mjs`) that the user's test copy installs, so only
  merge finished, checked work, and keep `main` releasable. When the user asks
  to test a branch, push it, then publish it as a beta with
  `gh workflow run release.yml --ref <branch> -f beta=true` (about 10 minutes;
  the test copy installs the newest beta via Help → Check for Updates…). Say
  if the branch raises a workspace, backup or workflow format version: the
  test copy upgrades its workspace one way, so the user should back up first.
- `app/globals.css`: Tailwind CSS v4 imports and the colour role tokens
  (surfaces, ink 1–3, primary, status, kind and series colours), defined once
  per theme under `:root[data-theme]`. Stylesheets and components use only
  these tokens, never raw colours. `lib/theme.ts` and `hooks/use-theme.ts`
  persist the device-local light/dark choice (dark by default). One system
  font family and a five-step type scale (`--text-xs` 12 px … `--text-xl`
  20 px) apply; `--text-tick` (11 px) is for plot ticks only. `--line-mid`
  draws panel borders and `--line-strong` outlines fields and controls at ≥3:1.
  Light-theme primary, kind and series colours meet ≥4.5:1 as text. Controls
  keep at least 24×24 px hit areas.
- `app/workflow*.css`: workbench styles by area: `workflow.css` (base),
  `-layout`, `-plot`, `-topbar`, `-dialogs`, `-onboarding`, then
  `workflow-batch.css`. `app/layout.tsx` and `desktop/renderer.tsx` import
  them in that order; keep it, since later files override earlier ones.
- `components/ui/`: the Base UI/shadcn primitives the app uses, with Lucide
  icons. Unused ones were removed; add new ones with the shadcn CLI
  (`components.json`) when needed.
- `lib/utils.ts`: `cn()` combines clsx and tailwind-merge.
- `vite.config.ts`: vinext, Sites, Tailwind/PostCSS, Cloudflare Workers integration.
- `.openai/hosting.json`: portable, non-secret hosting configuration imported by
  Vite. Keep it tracked. Both D1 and R2 are currently null. Do not put credentials
  or actual environment values in it. Use Sites skills for future site work.
- `next.config.ts`, `tsconfig.json`, and `components.json`: framework compatibility,
  strict TypeScript with the `@/` root alias, and component generator configuration.

## Install and run

Use a local checkout on each computer. Windows network shares can reject pnpm
symlinks; do not share a working tree or node_modules between computers.

Prerequisites: Node.js >=22.13.0, Git, and pnpm 11.19.0 (pinned in package.json).
Install that pnpm version with `npm install --global pnpm@11.19.0` if necessary.
Run commands from the repository root:

- `pnpm install --frozen-lockfile`: install the committed dependency resolution.
- `pnpm dev`: start vinext; use the local URL printed by the development server.
- `pnpm build`: produce the Cloudflare-compatible build in dist/.
- `pnpm start`: preview the completed build with Wrangler, using
  dist/server/wrangler.json. Run the build first.
- `pnpm exec install-electron`: download the pinned desktop runtime once per
  computer (Electron 44 uses an explicit installer).
- `pnpm desktop`: build and launch the native desktop app.
- `pnpm desktop:build`: compile the offline desktop renderer into dist-desktop/.
- `pnpm desktop:smoke`: after the desktop build, run a hidden native worker and
  IndexedDB integration check against the demonstration recording.
- `pnpm desktop:ui-smoke`: after the desktop build, exercise the actual workflow
  UI in a hidden native window with isolated temporary storage. Covers nested
  segments, scalar values, large batches, lineage and keyboard navigation; saves
  an ignored screenshot in `outputs/workflow-desktop.png`.
- `pnpm desktop:report-mockup`: build and open the isolated report preview.
- `pnpm desktop:report-workspace-smoke`, `desktop:report-plot-smoke` and
  `desktop:report-smoke`: after the desktop build, check the integrated Reports
  workspace, saved plot captures and the report editor in hidden windows.
- `pnpm desktop:backup-smoke`: after the desktop build, save and restore a
  backup through the native bridge, reject an invalid one, write an automatic
  backup, then close the window and verify the close-time backup.
- `pnpm desktop:package`: package with electron-builder under build/releases/:
  on Windows the NSIS installer and `win-unpacked`, elsewhere an unpacked app
  (`--dir` for unpacked only). Unsigned unless signing secrets are set; tagged
  releases publish through `.github/workflows/release.yml` (`docs/releasing.md`).

The first install can require pnpm approval for esbuild, sharp, and workerd native
build scripts. Use `pnpm approve-builds` to review pending scripts; do not disable
the dependency script policy globally. After approval, rerun the frozen install
and commit any resulting project policy file so it is shared across computers.

No application secrets or external service configuration are currently required.
Preserve package versions and pnpm-lock.yaml unless a requested change needs a
package update. For intentional dependency updates, run `pnpm install` and commit
package.json and pnpm-lock.yaml together. Do not introduce competing lockfiles.

## Validation

- `pnpm lint`: oxlint, including configured type-aware and typechecking checks.
- `pnpm typecheck`: TypeScript without emitting JavaScript.
- `pnpm exec oxfmt --check`: verify formatting without rewriting files.
- `pnpm format`: format files; keep formatting changes scoped to the task.
- `pnpm build`: check production compilation when application code changes.

Full-repository `pnpm lint` passes with no errors. GitHub Actions
(`.github/workflows/ci.yml`) runs the install, typecheck, lint, format check,
tests and both production builds on every push and pull request, and every
native smoke on Linux (headless) and Windows.

- `pnpm test`: Node test runner with in-memory TypeScript transpilation and
  fake-indexeddb. Tests cover CSV boundaries and validation, numerical units,
  immutable derivation chains, resampling, missing data, concurrent writers,
  cancellation, generic edge triggers/offsets, manual ranges, overlapping windows,
  derived time axes, segmentation provenance, and chunk-boundary continuity.
  `tests/signal-history.test.ts` covers collection ordering, atomic batches,
  independent re-segmentation, sparse extrema, binary chunk alignment, and
  5,000-stage evaluation/persistence without a configured depth limit.
- `tests/workflow.test.ts` covers append-only operation ordering, scalar numerical
  semantics, immutable nested segment chains, legacy migration, atomic batches,
  concurrent writers, and bounded history previews through 5,000 levels.
  It also covers atomic editing/deletion, persisted Undo/Redo, worker cancellation,
  lock failures, abandoned import recovery, archive round trips and corrupt
  archive rejection. `desktop:ui-smoke` exercises actual edit/delete/rename,
  Undo/Redo, backup download and invalid restore dialogs with isolated storage.
- `tests/workflow-batch.test.ts` covers the YAML subset's safety, recipe
  validation with line numbers, lossless serialisation, the EOL example batch
  (statuses, messages, coalesced Undo across restarts), cancellation, replaying a
  saved workflow to identical values, checks across Edit/Undo, batch backups and
  item deletion.
- Run `pnpm desktop:build` when shared application or desktop code changes.
- `pnpm desktop:smokes`: build the desktop renderer, then run every native
  smoke in sequence (`tests/native-smokes.mjs`; add new checks to its
  `SMOKES` list) with a pass/fail summary and logs in `outputs/smoke-logs/`.
  `node tests/native-smokes.mjs ui-smoke` runs chosen checks on the current
  build. On Linux without a display it adds the headless Ozone flags
  `--ozone-platform=headless`, `--ozone-override-screen-size=1920,1200` and
  `--disable-gpu`. Where Chromium's SUID sandbox is unavailable, prefix
  `ELECTRON_DISABLE_SANDBOX=1` (test runs only, never the shipped app).
- `pnpm test:preview`: with `pnpm dev` serving localhost:3000, exercise the HTTP
  worker factory in hidden Chromium with isolated storage. Verifies same-origin
  script loading, demo initialization, BSFC, trigger preview, offsets, crop
  creation, window previews, and independent moving-average/extrema batches. Run this
  when changing worker loading or build configuration; native smoke alone cannot
  detect vinext's browser-only URL transforms.
- Full-repository lint must stay clean; justify any `oxlint-disable-next-line`
  in a comment, as existing ones do.

The tests require Node >=22.15 for `registerHooks`; Node 24 is recommended.
Do not claim multi-gigabyte throughput from architectural design alone. Raw
columns use 16,384-sample chunks and a 16 MiB read cache. New raw imports have
persistent plot indexes; older/restored recordings build them on a full plot.
Stateful derived evaluation still scans its required history, and browser storage
quota applies. There is no plugin runtime; binary measurement files are read
by the TypeScript readers in `lib/formats/`. See `docs/high-rate-performance.md`
and `tests/high-rate.test.ts`.

## Development conventions

- Use function components, explicit TypeScript types, and the existing `@/` alias.
- Add 'use client' only where browser APIs, hooks, or interactive state need it.
- Reuse components/ui and cn(); preserve accessibility, keyboard behavior,
  data-slot attributes, and established class-variance-authority variants.
- Prefer semantic Tailwind theme tokens and keep light/dark themes consistent.
- Oxfmt uses single quotes and an 80-character print width.
- Follow .oxlintrc.json, including hook rules, prefer-const, and no explicit any.
- Keep Cloudflare server code compatible with Workers and ESM.
- Keep Wrangler logs and Miniflare state project-local, as configured in Vite.
- Preserve existing app behavior and dependencies unless the task needs a change.
- Persisted formats follow `docs/file-format-stability.md`: read every older
  version, refuse newer ones without writing, and bump `WORKFLOW_VERSION`,
  `WORKSPACE_SCHEMA_VERSION`, the backup or draft version, or a cache key
  version as it describes.

## Git workflow

Apply this workflow automatically to the primary agent and every delegated agent.
After each completed action that changes repository files, commit and push its
relevant changes before reporting success. A completed action is a coherent
requested change with its applicable validation complete. Do not wait for the
user to request syncing or defer finished changes until an unrelated task ends.
Read-only actions and actions with no file changes do not need an empty commit.

The user authorizes these routine commits and pushes; do not ask again solely for
them. Follow the active Codex permission controls and report any authentication or
approval blocker. AGENTS.md does not override those controls.

### Agent coordination and completion

- Include this Git workflow in delegated instructions. Every agent must report
  its changed files and validation results to the coordinating agent.
- When agents share a checkout, the coordinating agent owns all staging, commits,
  rebases, and pushes. Serialize those operations so agents cannot commit each
  other's unfinished work or race to update the same branch. Subagents hand off
  their completed changes as ready for coordinator commit/push, then stop editing
  those files until the coordinating agent confirms the handoff is committed.
- An agent working in an independent checkout follows the same workflow for its
  own branch and reports the final commit hash and push result.
- A delegated change is ready for integration when handed off; its repository
  workflow is complete only after the coordinator confirms its commit and push,
  or reports a specific blocker. Do not silently leave finished changes unsynced.
- Before reporting a successful push, verify that the pushed commit is present on
  the intended remote branch. Always include the final commit hash and push result
  in the completion report. If checks, conflicts, authentication, or permissions
  block safe completion, preserve the work and report the blocker instead.

### At the beginning of every task

1. Check `git status` and the current branch before making changes. Note existing
   staged, unstaged, and untracked work so it stays separate from the task.
2. If the working tree is clean and an `origin` remote exists, fetch from origin
   and pull/rebase the current branch onto its corresponding remote branch before
   editing. Use the current branch's configured origin upstream when present;
   otherwise check for the same-named branch on origin. Never guess a different
   branch or silently switch branches. If no remote branch exists yet, keep the
   local branch and establish its upstream with the first push. If HEAD is
   detached or the upstream mapping is ambiguous, report it before syncing.
3. Never discard, overwrite, reset, or stash existing local changes just to
   perform a pull. Disable automatic stashing for pull/rebase operations, even if
   a machine's Git configuration enables it.
4. If local uncommitted changes make syncing unsafe, preserve them, skip the
   pull/rebase, and tell the user. Continue only task work that can safely coexist
   with those changes.

### At the end of every completed action that changed files

1. Run the project's tests/checks appropriate to the change. Read the current
   package scripts rather than assuming an old command is still correct. For a
   documentation-only change, check the edited document and `git diff --check`;
   application changes need the applicable tests, lint, types, and build checks.
   Report failures or checks that could not run; do not claim they passed.
2. Review both the working diff and the exact staged diff. Ensure the commit has
   no secrets, .env files, credentials, temporary files, build output, dependencies,
   machine-specific files, or unrelated changes. Stage only the task's relevant
   files or hunks; preserve any pre-existing staged work without committing it.
3. Commit the relevant changes with a concise descriptive commit message. Do not
   make an empty commit for a task that leaves no changes.
4. Before pushing, fetch from origin again. Fetching remote references is safe
   with a dirty working tree; it does not authorize pulling or rebasing that tree.
5. Check the fetched remote branch against the current branch. If the remote has
   moved and is not already an ancestor of the local branch, rebase safely onto
   that remote branch before pushing. Rebase only with a clean working tree and
   automatic stashing disabled. If unrelated local changes prevent rebasing, keep
   them and the task commit, stop before pushing, and tell the user. After a rebase,
   review the result and rerun checks appropriate to any affected changes.
6. Push the current branch to origin, using the verified remote branch mapping.
   Set its upstream on the first push. If origin is missing or authentication or
   permissions prevent pushing, retain the local commit and report the blocker.
   If the push is rejected because the remote moved again, fetch and repeat the
   same safe checks; never bypass them.
7. Never force-push unless the user explicitly asks. This includes force-with-lease.
8. If a merge/rebase conflict cannot be resolved confidently, stop and tell the
   user rather than guessing. Do not discard work to make the operation succeed.

Afterwards, tell the user what was committed, the final commit hash (after any
rebase), and whether the push succeeded. If no commit or push was made, state why.
Mention any local changes that remain uncommitted and therefore were not synced.

### Working across computers

- The main branch is `main`. Use a separate local clone on each computer and use
  GitHub to exchange commits; do not edit the same shared network checkout.
- Follow the start/end sync workflow above when changing computers. Uncommitted
  changes do not travel through GitHub. Install dependencies from the committed
  lockfile on each computer instead of sharing node_modules.
- Use separate feature branches for parallel work. Do not reset, clean, or
  discard someone else's work when reconciling branch history.
- Keep secrets separately configured on each computer; never store credentials
  in tracked files, Git remote URLs, or documentation.
- .gitattributes normalizes text to LF to prevent line-ending churn.
