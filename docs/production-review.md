# Usability and reliability review — September 2026

Three independent subagent reviews covered operation management and lineage,
results and data portability, and accessibility, performance and recovery.
The coordinator implemented and integrated the changes in the shared checkout.

## Everyday operation management

- Visible Edit settings, Duplicate operation, Rename and Delete controls accompany
  the selected operation/output. Originals expose recording removal and names.
- Editing rebuilds all dependent invocations atomically. Original samples stay
  immutable; operation positions and matching output identities stay stable.
  Revisions appear in history and reports. The inspected output stays selected.
- Deletion shows exactly which dependent invocations and output counts will be
  removed. A dependent batch is removed whole, including its other outputs.
  Shared region ranges are not owned by calculations that merely consume them.
- Undo/Redo restores the last 20 changes, including after restarting. Initialization
  and legacy migration preserve the journal. Unsupported legacy rebuilds fail
  with an explanation, before committing; duplicate/recreate remains available.
- Empty workspaces offer import or an explicit example, including after removing
  the final recording. Examples are not inserted into a user's empty workspace.

## Storage and recovery

- Workspace backups contain original samples, recipes, history, names and values.
  Restore checks archive version, metadata shapes, numerical recipes, graph
  dependencies, output ownership, bounds, samples and the completion footer.
  New raw storage is staged separately; one transaction publishes the replacement.
  Failed restoration preserves the workspace and its existing data.
- Raw import journals let startup reclaim interrupted imports without deleting
  published data or sources retained by Undo/Redo. Cross-window Web Locks protect
  recovery; optimistic revision checks still reject stale metadata writers.
- Cancelling work cancels queued jobs too. Obsolete plot and sample requests are
  replaced independently. A lock failure returns an error and leaves the next job
  able to run. Export cancellation independently suppresses late downloads.
- Fatal worker errors reject outstanding requests and disable the dead worker.
  Reload recovery is visible. Renderer errors and native load/crash failures also
  offer recovery. Native initial load failure does not exit under its reload dialog.
- Packaging uses a fresh staging directory and reads the application version from
  the manifest, preventing obsolete hashed assets from leaking into a new package.

## Validation

`pnpm test` covers numerical functions, graph/history behavior, atomic lifecycle
operations, persistence, concurrency, cancellation, lock failure, import recovery
and valid/invalid archive round trips. The actual worker is exercised for queued
cancellation and recovery. Archive cases include shifted axes, missing samples,
binary engineering units, regions and invalid history dependencies.

`pnpm desktop:ui-smoke` uses an isolated native workspace and real controls. It
checks derivation, nested segmentation, scalar results, large output batches,
pagination, lineage/keyboard navigation, names, dependent recalculation, deletion
confirmation, Undo/Redo, backup download, invalid restore handling and exact result
exports. Native screenshots cover wide and compact viewports. Test output and
screenshots are ignored build artifacts, not user workspace data.

Verified for this change: 93 automated tests, TypeScript, formatting, changed-file
lint, browser and desktop production builds, native worker smoke, HTTP worker
integration, and the full UI/download suite against the packaged Windows executable.
Full-repository lint retains the 19 starter issues listed below.

## Remaining release and scale limits

- This is a local application; browser and desktop profiles have separate storage.
  Clearing a profile also removes Undo history. Keep independent workspace backups.
- Archives have a 128 MiB limit; samples CSV has a 64 MiB limit per file. Native
  streaming backups/exports and historical raw-storage compaction are not included.
- Cold plots and high-offset sample pages can scan substantial data. There is no
  persistent plot pyramid and no certified multi-gigabyte performance target.
- HTML reports are output snapshots, not editable report templates. Current export
  scopes are the viewed output, checked signals, or one complete operation.
- Portable packages are unsigned. Signed public installers, update distribution
  and operating-system trust verification require a separate release setup.
- Full-repository lint now passes (October 2026: the unused starter UI
  primitives and mobile hook were removed, and CI runs every check).

These limits are explicit boundaries of this release, not a certification that
every production environment, dataset size or failure mode has been tested.
