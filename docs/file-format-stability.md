# File and storage format stability

Once Stratum 1.0 ships, everything it saves is a compatibility promise. This
page is the contract for each persisted format: what carries a version, what a
later Stratum must keep opening, and what an older Stratum does with data from
a newer one.

## Rules for every format

- **Older data always opens.** A later Stratum reads every format version that
  any earlier release wrote, and every legacy shape the 1.0 code still reads.
  Old records are adapted in memory or by a housekeeping save that never
  changes sample values, recipes, IDs or results, and is never journaled.
- **Newer data is refused, not guessed.** An older Stratum names the newer
  version and changes nothing. It never reads a newer file partially, silently
  drops its unknown parts, or overwrites newer data.
- **Bump the version** when a newer Stratum may write anything an older one
  would reject, misread or lose when it rewrites the record. When in doubt,
  bump. Writers always write their current version.
- **Meaning never changes under a name.** A function, setting, unit label or
  key keeps its meaning. A changed meaning needs a new name or a new version
  whose reader converts the old one.
- **Numbers** are IEEE doubles. Text formats write the shortest round-trip
  form (`String(n)`/`JSON.stringify`), so values are exact. Missing samples are
  `null` in JSON and `NaN` in storage; times are always finite.
- **Time** is in seconds. Raw timestamps are the recording's own axis, strictly
  increasing; intervals exclude their end unless it is a recording/parent end
  (migrated legacy intervals keep inclusive ends). `createdAt`/`updatedAt` are
  ISO 8601 UTC strings.
- **Units** are free text compared exactly; Stratum never converts implicitly.
  `convert` uses only the exact families in `lib/units.ts`.
- **IDs** are opaque strings: new ones are random UUIDs, older workspaces may
  hold others. Never parse an ID or derive meaning from one.

## Formats

| Format                 | Where                                    | Version                         | Newer data in 1.0                      |
| ---------------------- | ---------------------------------------- | ------------------------------- | -------------------------------------- |
| Workspace backup       | `.stratum` (and legacy `.stratus`) files | header `version: 1`             | Refused; see below                     |
| Workflow file          | `.stratum.yaml`                          | `version: 1`                    | Refused with "made by a newer Stratum" |
| Report template        | `report:` inside a workflow file         | the workflow file's version     | As the workflow file                   |
| Workspace database     | IndexedDB `stratus-workbench-v1`         | database version 1              | Refused; nothing written               |
| Derived caches         | `derived-v1:` and `plot-index-v2` keys   | in the key                      | Pruned; rebuilt when needed            |
| Report draft           | IndexedDB `stratum-report-drafts`        | database 1, record `version: 1` | Kept; edits are not saved              |
| Saved plots and layout | `localStorage` keys                      | in the key                      | Best effort; may lose newer settings   |

### Workspace backup (`.stratum`)

Versioned NDJSON (`lib/workspace-archive.ts`): a header record
`{ format: 'stratus-workspace', version: 1, project }` (the format name keeps
its pre-rename spelling), sample column records, then a completion record
that counts them. Restore validates everything before publishing anything and
gives sources fresh IDs; other IDs are kept. Any other format or version is
refused before anything is written. Unknown project fields are preserved, but
unknown operations are rejected, so a newer Stratum must raise `version`
whenever its projects use anything 1.0 does not validate. Derived caches,
plot indexes, saved plots and report drafts are never included.

### Workflow files (`.stratum.yaml`) and report templates

A strict YAML subset (`lib/workflow-yaml.ts`) with `format: stratum-workflow`
and a whole-number `version` (`lib/workflow-recipe.ts`). Every mapping rejects
unknown keys, so any new key, function, choice or placeholder needs a version
bump. A newer version is refused with "This workflow was made by a newer
Stratum (version N). Update Stratum to open it.", even when the file uses YAML
syntax 1.0 cannot parse. The report template has no version of its own.

Stable meanings: channel aliases bind by column name, ignoring case, with the
unit checked exactly; `step[n]` is a 1-based output position; derive
parameters use the units in `lib/signal-functions.ts`; segment ranges,
windows, offsets and check durations are seconds; `time-origin` defaults to
`recording`;
`item id pattern` is an ECMAScript regular expression with the `u` flag.
Saving writes a canonical layout without comments. The recipe hash is SHA-256
of that canonical form, including `version`, so it identifies a recipe within
one format version; stored batch hashes are never recomputed.

### Workspace database

IndexedDB database `stratus-workbench-v1` with stores `chunks` (raw columns as
`Float64Array`s keyed `[sourceId, chunk, column]`, plus plot indexes) and
`project` (`current`, `revision`, `history` with 20 Undo/Redo snapshots and
labels, and `['pending-import', id]` markers). The project record has no
version field of its own: the **database version** is the workspace schema
version (`WORKSPACE_SCHEMA_VERSION` in `lib/signal-engine.ts`).

- To change the schema, raise the database version. The upgrade may be empty;
  migrating the project can happen afterwards. Undo/Redo snapshots stay in
  their old shape and are adapted when restored.
- An older Stratum then cannot open the database and reports "This workspace
  was saved by a newer version of Stratum. Update Stratum to open it; this
  version has not changed it." Portable copies share one profile, so this is
  the downgrade path to protect.
- Open windows close their connection when another window upgrades, so an
  upgrade is never blocked; their next request fails and offers Reload.
- Legacy shapes that must keep opening: region sets, function runs and region
  examples (engine-only), old segmentations without saved settings, projects
  without workflow history, and journals without Undo labels.
- The profile and origin own this data: desktop `userData` stays
  `%APPDATA%\Stratus`, the scheme stays `stratus://app`, and the workspace
  writer lock stays `stratus-workspace-writer`. Renaming any of them orphans
  existing workspaces.

### Derived caches and plot indexes

Disposable and rebuildable; never in backups or Undo. Derived artifacts are
owned by `derived-v1:<recipe key>`; raise that number whenever an operation's
numerical results change. Pruning on open removes every other `derived-vN`
owner. Raw plot indexes use `plot-index-v2`/`plot-leaves-v2` keys; a rebuild
deletes the v1 entry. A cache from another version is never read.

### Report draft

Its own database, `stratum-report-drafts`, holding one record
`{ version: 1, savedAt, report }` (`lib/report-draft-store.ts`). Missing block
fields gain defaults. A newer record or database is kept unchanged: Reports
says "Not saved: the saved draft is from a newer Stratum" and saves nothing.
Captures inside a draft are snapshots and are never refreshed automatically.

### Saved plots and device preferences

`localStorage` holds saved plots (`stratus.plot-scratchpad.v1`) and small
preferences: `stratum-theme-v1`, `stratum-workflow-selection-v1`,
`stratum-batch-view-v1`, `stratum-example-tour-v1`, `stratum-inspector-open-v1`,
`stratum-last-derive-v1`, `stratum-last-value-v1` and
`stratus-{history,inspector}-width-v1`. Readers validate each field and fall
back to defaults. Additive fields may share a key; an older Stratum ignores
them and drops them when it saves. An incompatible shape needs a new key,
read alongside the old one.

## Exports

Values, samples and summary CSV, HTML summaries, report PDFs and plot images
are outputs for people and other tools. Columns keep their meaning; new
columns may be added. Stratum reads an exported CSV back only as a new
recording.
