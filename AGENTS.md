# Stratum: instructions for Codex

## Current purpose and scope

Stratum is a local desktop signal-workflow application with a Sites browser preview.
It imports immutable CSV signals. Derivations and segments create ordinary derived
signals, which can feed further derivations, segmentation, and scalar values.
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
  Inspection and checked processing inputs are independent. Explicit parent
  navigation clears search; opening a search result preserves matching context.
  Lineage-filtered trees show only contributing outputs, not batch siblings.
  One top bar holds the recording scope, Undo/Redo (Ctrl+Z/Ctrl+Y), the four
  operations and their "Apply to" processing scope. History filters by text
  and All/Signals/Values chips and dots outputs that feed the selection.
  `components/workflow-properties.tsx` is the right-hand inspector (properties,
  bounded lineage chain, Used by, Edit/Duplicate/Delete); it becomes a drawer
  below 1240 px, and History becomes one below 820 px. Ctrl+K opens
  `components/workflow-command-palette.tsx`: the top-bar commands plus a word
  search over every step and output in scope, capped at 40 results.
- `components/workflow-export.tsx` and `lib/workflow-delivery.ts`: explicit
  viewed/checked/whole-step export scope; values CSV, evaluated samples CSV,
  summary CSV, and standalone printable HTML reports with escaped labels.
  These printable HTML reports remain immutable snapshots.
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
  Keep the report and plot views mounted across workspace switches; drafts and
  report Undo/Redo are session-only. While Reports is shown, workflow keyboard
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
  must preserve the journal; do not journal them as user actions.
- `lib/workflow-example.ts`: deterministic motor-test data and a seven-step
  original → smoothing → multiplication → run segments → values → nested segments → values
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
  Report templates (`lib/workflow-report-template.ts`) bind blocks to recipe
  references; `lib/workflow-batch-report.ts` renders one item's report, and
  `lib/zip-store.ts` packages PDFs. `lib/eol-example.ts` generates
  `examples/eol-rig` (`pnpm examples:eol`); tests check the committed copies match.
- `lib/workspace-archive.ts` validates versioned NDJSON workspace backups before
  publication. Restore stages original columns under fresh source IDs and commits
  metadata atomically, preserving the prior workspace for Undo. Archives are
  limited to 128 MiB; samples CSV to 64 MiB. Never publish partial archives or
  delete published/Undo/Redo source chunks during import recovery.
- `components/workflow-list.tsx`: render disclosure rows only while open, with
  30-item pages. Keep large lineage and checked-input lists bounded in the DOM.
- `docs/workflow-proposal.md`: design rationale, interaction rules and compatibility.
- `components/region-workbench.tsx`: retained region workspace. Regions
  are reusable recording-time pointers, not automatic channel copies. The left
  history has one item per invocation; region/results tables keep families compact.
- `hooks/use-signal-engine.ts`: worker request client; the active UI requests
  `init-workflow`. Region compatibility callers retain `init-regions`.
- `lib/region-types.ts` and `lib/region-model.ts`: region versions, parent links,
  function invocations, ancestry and legacy migration. Never mutate an existing
  region version or retarget its children/results. View selection must remain
  independent of processing scope. Nested segmentation scans each parent separately.
  New intervals exclude their end unless it is an inclusive parent/recording end;
  migrated legacy intervals retain inclusive endpoints. Test with `pnpm test`,
  which includes `tests/regions.test.ts` and the earlier numerical suites.
- `components/region-editor.tsx`, `region-function-editor.tsx`, `region-history.tsx`:
  saved settings, explicit scopes and a virtualized chronological history.
- `components/ui-refresh-mockup.tsx`, `mockup-chart.tsx`, `mockup-dialogs.tsx`,
  `lib/mockup-data.ts` and `app/ui-refresh-mockup.css`: interactive prototype of
  a refreshed layout on an in-memory workspace, opened at `/mockup` or with
  `pnpm desktop:mockup`. It never uses the engine or workspace storage, and its
  operations are illustrative, not the engine's. See `docs/ui-refresh-review.md`.
- `components/workbench.tsx`: retained legacy workspace for compatibility.
- `components/signal-chart.tsx`: bounded SVG min/max envelope plots.
- `components/plot-scratchpad.tsx` and `lib/plot-scratchpad.ts`: Active plots
  the selection (a signal; a value as a labelled reference line over its input,
  with a marker at a minimum/maximum; or up to eight outputs of an operation,
  each coloured by its position in that operation) above value tiles and the
  `components/workflow-dock.tsx` Outputs/Samples/Settings dock. The chart fills
  the space between its controls and the dock. Saved plots persist styles, limits,
  annotations and viewport independently of workflow history. Plot gestures use
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
- Legacy `components/signal-explorer.tsx` and `lib/signal-explorer.ts`: virtualized,
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
  and range propagation through stateless unary/crop/time-alignment paths.
  Stateful filters, reductions, resampling and binary grids must retain complete
  input history unless an equivalent state/checkpoint strategy is implemented.
- `lib/plot-index.ts`: versioned, rebuildable raw-signal min/max hierarchies.
  Index keys share source ownership with raw chunks but are excluded from backups.
  Publish roots only after their leaves; index recovery never changes workflow
  history. Summaries cover original samples; partial boundary blocks use exact
  data. Drawing candidates are not measurement or export samples. The index read
  cache is capped at 8 MiB; oversized index builds fall back to streaming reads.
- `lib/engine-yield.ts`: cooperative worker yielding with `scheduler.yield()` and
  a timer fallback. Preserve actual task boundaries so cancellation can arrive.
- `components/segmentation-editor.tsx`: trigger/range/window editor and saved
  segmentation provenance. `components/time-range-picker.tsx` draws multiple
  intervals on a bounded signal plot, with movement, edge resizing and exact
  numeric fields. Plot coordinates must match the segmentation clock: undo local
  display offsets, but keep workspace outputs on their current time axis.
  Start and end triggers
  independently select raw/derived signals, edges, thresholds, and signed offsets.
- `lib/signal-engine.ts`: append-only IndexedDB columns, CSV import, lazy derived
  evaluation, segmentation, and samples/summary exports. `signal-math.ts` holds numerical
  helpers; `signal-types.ts` defines the domain and worker protocol.
- `lib/segmentation.ts`: stateful generic threshold crossings. No hidden smoothing
  or engine-ramp heuristics. Pair crossings before applying offsets; retain
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
- `app/globals.css`: Tailwind CSS v4 imports and the colour role tokens
  (surfaces, ink 1–3, primary, status, kind and series colours), defined once
  per theme under `:root[data-theme]`. Stylesheets and components use only
  these tokens, never raw colours. `lib/theme.ts` and `hooks/use-theme.ts`
  persist the device-local light/dark choice (dark by default). One system
  font family and a five-step type scale (`--text-xs`…`--text-xl`) apply.
- `components/ui/`: reusable Base UI/shadcn primitives with Lucide icons.
- `lib/utils.ts`: `cn()` combines clsx and tailwind-merge.
- `hooks/use-mobile.ts`: shared mobile breakpoint hook (768px).
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
- `pnpm desktop:mockup`: build and open the UI refresh mockup in a native
  window with a temporary profile.
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
- `pnpm desktop:package`: create a portable app under build/releases/ for the
  current operating system. This is an unsigned development package.

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

Initial Git setup validation: TypeScript passed; oxlint reported 19 pre-existing
issues in the starter UI components and mobile hook. No app behavior was changed
to address those issues during repository setup.

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
- `pnpm test:preview`: with `pnpm dev` serving localhost:3000, exercise the HTTP
  worker factory in hidden Chromium with isolated storage. Verifies same-origin
  script loading, demo initialization, BSFC, trigger preview, offsets, crop
  creation, window previews, and independent moving-average/extrema batches. Run this
  when changing worker loading or build configuration; native smoke alone cannot
  detect vinext's browser-only URL transforms.
- Full-repository lint still includes the original 19 starter-component issues.
  Keep new application files clean and report the baseline separately.

The tests require Node >=22.15 for `registerHooks`; Node 24 is recommended.
Do not claim multi-gigabyte throughput from architectural design alone. Raw
columns use 16,384-sample chunks and a 16 MiB read cache. New raw imports have
persistent plot indexes; older/restored recordings build them on a full plot.
Stateful derived evaluation still scans its required history, and browser storage
quota applies. There is no plugin runtime or native binary measurement-file
importer yet. See `docs/high-rate-performance.md` and `tests/high-rate.test.ts`.

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
