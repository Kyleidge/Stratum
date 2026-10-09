# Signal workflow and history

Implemented on `codex/workflow-history`, starting from `e6264a5` on `main`.

## The working model

An original signal is immutable. A derived signal has its own identity, recipe,
and exact input IDs. Either type can feed another derivation, segmentation, or
value calculation. A **segment** is a time interval of a whole recording (or of
a workspace time axis), found by a Segment step from time ranges, windows or a
signal's triggers. It is not a signal: later steps choose to work **Within**
the entire signal, one segment, chosen segments, or every segment of a Segment
step. A value is a scalar result, with its unit, calculation, and input
identity; it is an endpoint, not a signal.

```mermaid
flowchart LR
  A[Original signal] --> B[Derived signal]
  S[Segment step · triggers on speed] --> R1[Run 1]
  S --> R2[Run 2]
  A -. triggers .-> S
  B --> V[Maximum · within all runs]
  R1 -. within .-> V
  R2 -. within .-> V
  B --> F[Moving average · within Run 2]
  R2 -. within .-> F
  R2 --> N[Nested segment step · halves of Run 2]
```

### Segments and Within

- A Segment step stores a `SegmentSet` (`project.segmentSets`): its settings
  and `FileSegment`s with recording-time `start`/`end`. A segment's end is
  excluded unless it is the recording's (or its parent's inclusive) end, so
  adjacent segments never share a sample. No signals are created.
- **Value within segments** gives one value per input per segment, read from
  the signal as it is there: a filter keeps its state from before the
  segment. Values carry `segmentId`; their labels read "Maximum · Run 2 ·
  Torque".
- **Derive within segments** gives one signal per input per segment. Each
  output reads hidden crops (`internal` crop nodes with `segmentId`) of every
  signal input, so filters, integrals and other running calculations start
  fresh at the segment's start. Hidden crops never appear in History; Details
  and lineage name the cropped signal and the segment instead.
- A signal made within a segment belongs to it: a later Value or Derive on it
  stays in that segment, and a nested Segment step searches each parent
  segment (its ranges and windows are seconds from the parent's start;
  triggers use recording time).
- Segments apply to signals of their own recording (workspace sets: signals
  on their time reference). Selecting a segment plots the signals that found
  it with every segment shaded and zooms to the selected one.
- Edit keeps outputs by what they are, not by position: a segment by its
  place within its parent, an output by its input and segment. Re-segmenting
  may therefore change the segment count; steps within the segments follow,
  and a later step that used every output of a rebuilt step uses all of its
  new outputs. A step that used a removed output on its own blocks the edit.
- Older workspaces keep their signal segments (crop outputs) and still open,
  edit and replay. Workspace schema 2 and backup version 2 added segments.

## History is the primary navigation

The center is a plot scratchpad. **Active** follows the selection: a signal, a
value as a reference line over its input, or up to eight outputs of an
operation. **Keep plot** copies those traces into a named comparison tab.
**New plot** starts an empty tab. Named tabs stay selected while browsing History,
and **Add to this plot** adds the inspected signal without changing checked
processing inputs. The searchable **Add signals** dialog can also use checked
inputs. Step outputs sit in a dock below Active with the existing export scopes.

Dragging a segment onto a plot adds the exact outputs of its producing segment
operation. Dragging it onto a processing tool selects only that member. Operation
rows drag their complete output membership. Scalar values plot as dashed reference
lines; signal-processing tools explicitly use their input signals instead.
**Create plot** in a History item's context menu opens a new plot with the same
output membership as dragging that item onto **New plot**, including whole
operation batches and segment families. It keeps the inspected item, checked
processing inputs, search and focused output tree unchanged.
Toolbar drops select their subject and replace processing scope before opening an
editor. Cancelled drags preserve selection; incompatible targets stay inactive.

Each tab holds up to 10,000 traces; the scratchpad holds up to twelve named tabs.
Oversized drops are rejected whole. Trace controls are paged in groups of 30 and
stacked plots in groups of eight. Overlays combine independent SVG subpaths by
style to retain the complete batch without a DOM element for each signal.
Trace visibility, colors, names, layout, elapsed-time and grid settings persist in device-local
browser storage, separately from workflow Undo/Redo and workspace backups. These
are live references to signal IDs, not sample snapshots. Editing an operation
refreshes its plots. Removed signals remain marked unavailable so Undo can restore
them. Closing a tab offers Reopen for the most recently closed plot.

The optional Δt display subtracts each trace's own interval start. It changes no
samples, time references or workflow history. It permits elapsed-time comparisons
across recordings. Otherwise overlays require matching units and explicit time references. Other comparisons
use stacked axes, with independent time axes clearly labeled when clocks differ.
Zoom, pan, and Fit adjust the bounded plot preview; summaries describe all samples.
Exact samples and exports still come from evaluated engine data, never the preview.
One top bar holds labelled Derive, Segment, Value and Compare actions, the
"Apply to" processing scope and an inspection/export menu. Edit, duplicate,
rename and delete live in each History item's context menu and in the inspector.
Inspection preserves checked scope; an explicitly empty scope disables creation.
The input review's Follow selection, or the × on Apply to, returns to automatic
inputs. The footer shows selection, notifications with Undo, totals and progress.
Only the selected tab renders charts, and signal choices are paged in groups of 30.

**Segment → Time ranges** shows an interactive plot of a chosen input signal.
Drag repeatedly in **Draw ranges** to add independent intervals, including
overlaps. **Adjust ranges** moves a shaded interval or resizes either edge;
Escape cancels an unfinished gesture. The numbered range list provides exact
start/end fields, duration and removal, with 30 rows per page. Arrow keys move
the selected range (Shift for a larger step); Delete removes it. **Zoom to
range**, pan and **Fit** change only the preview. Range pairs can also be pasted.
New operations start with no ranges; Edit restores every saved range. The plot
uses recording time for recording signals, reversing display offsets, and the
current time reference for workspace outputs. Choosing a preview signal does
not change the processing scope. Preview and Create retain the existing clip /
discard policy, independent input processing and atomic operation history.

In workflow dialogs the segment preview runs automatically, debounced, in the
worker's `segment-preview` inspection lane, so a newer preview supersedes a
queued one and never blocks the form. **Triggers** plots the trigger signal
with draggable start and end threshold lines (snapped to readable steps),
rising/falling toggles, crossing markers and the planned segments as bands.
**Windows** plots a target with a draggable windowed span and each planned
window. Typed fields remain the exact source of every setting.

Derive and Value dialogs place their settings beside a live preview.
`derive-preview` builds the unsaved candidate with the same validation as
creation, then returns bounded envelopes of it and its inputs, each on its own
time axis, so a time shift is visible. Units share a lane; other units get
their own lane on the same time axis. Drag to zoom; the engine re-evaluates the
zoomed interval. Parameters have a slider (logarithmic where the useful range
spans decades), presets and a plain-language hint derived from the input's
sample interval and value range; the engine still validates every value.
`value-preview` reads `valueStatistics`, the same exact pass that creation
uses, for up to 12 inputs, so each value card shows its result in advance.

Selection details live in a right-hand **inspector**: kind, name, a value's
result, properties, time axis, inputs, a bounded lineage chain back to the
original recordings, the operations that use the selection, source recordings
and Edit/Duplicate/Delete. Selection changes update it in place, and History
keeps the full height of its rail. Hiding the inspector returns its width to the
plot; the choice is remembered on this device. Below 1240 px it opens as a
drawer, and below 820 px History does too.

Drag the dividers beside History and the inspector to resize them. Widths are
remembered on this device and constrained to leave room for the plot. Focus the divider and use Left/Right arrows (Shift for larger steps),
Home/End for its limits, or Enter to reset. Double-click also resets the width;
Escape cancels an in-progress drag.

The history tree has two levels: an operation and its immediate outputs. The
operation sequence remains chronological, oldest first. Dependency depth does
not increase indentation. Stable step references identify where a signal was
created, including when several outputs have the same channel name.

For example:

```text
#001 Import recording
     Engine speed                         Original signal
     Torque                               Original signal
#002 Moving average                       From #001 Torque
     Torque · Smoothed                    Derived signal
#003 Trigger segments                     From #001 Engine speed
     Segment 01 · 12–51 s                  Segment
     Segment 02 · 70–109 s                 Segment
#004 Nested time range segments           Within #003 Segment 01
     Segment 01.01 · 15–20 s               Segment
#005 Time average                         From #002, within #004
     Time average · Segment 01.01 · Torque · Smoothed   Value
```

Branches are expressed by input links, not by moving later operations underneath
earlier ones. This keeps chronological order honest when a user returns to an
earlier signal and starts a new branch. A binary operation has links to both
inputs. Trigger-defined segments also expose the signals used for boundaries.

The tree previews three outputs per operation, plus the selected output when it
is elsewhere in a large batch. **View all outputs** focuses the history sidebar
on that operation and its complete output tree without changing the active view
or processing inputs. Search and lineage filters still apply. **Back to history**
(or Escape in the tree) restores the previous history scroll position, keyboard
focus and collapsed rows. Only the visible history rows are mounted, including
in the focused output tree.
The **Signals & values** index provides a flat, searchable list of every output.
**Compact history** collapses other output lists while keeping the selected
output visible; **Show outputs** restores the previews across all steps.

Selecting an output shows:

- its type, units, interval, and producing step;
- clickable **From** links to immediate inputs;
- the full contributing lineage, in creation order, including all input branches;
- a **Show lineage in tree** filter with an explicit return to all steps;
- links to later operations that consume the selected signal;
- the plot or scalar result, with the original signal still accessible.

Arrow Up/Down moves focus in the tree. Arrow Right/Left expands or collapses an
operation; Home/End jumps to the first/last visible row; Enter or Space selects.
Right-click an operation or output (or press Shift+F10) for its edit, duplicate,
rename and deletion actions. Actions target that item, including when another
item is selected. Double-click opens the producing operation's saved settings;
originals and saved region scopes open Rename instead. F2 also opens Rename.
Disclosure arrows only expand or collapse outputs. Deletion keeps the existing
dependent-operation confirmation, and checked processing inputs stay separate.
The Back button returns to the previous selection without changing the workflow.

## Creating the next step

Select a signal to use it as the next input, or use checkboxes in an output table
to choose an exact batch. Once inputs are explicitly checked, inspecting another
signal, value, operation or parent does not replace them. The action bar states
whether inputs follow the signal in view or are an explicit checked collection.
**Use only this signal** returns to the single viewed signal. Viewing an operation
does not silently select all its outputs. **Select all signals** is explicit,
and honors the output search. New batch outputs are selected together
so the next operation can continue across that batch.

The three actions are **Derive signal**, **Segment**, and **Calculate value**.
Derive and Value dialogs show the exact input list and a **Within** choice:
the entire signal, all segments of a Segment step, or chosen segments; opened
from a segment or Segment step, Within starts there. **Find segments** names
the recording rather than signals: manual ranges in recording time with an
interval preview (the checked signals are plotted), fixed-duration windows,
and trigger crossings on any signal of the recording. Its Within choice nests
the new segments inside earlier ones. Time-shifted and zeroed signals retain
their own displayed axis; segments stay in recording time and are translated
when a step reads a signal within them.

**New version…** appends another step. It never changes the old
recipe, output IDs, downstream signals, or stored scalar values.

## Values and numerical meaning

Minimum and maximum use finite samples and record the first occurrence time.
Sample average assigns equal weight to finite samples. Time average divides the
trapezoidal integral by valid elapsed time, using only intervals between adjacent
finite samples. It does not bridge missing samples. A single isolated sample has
no time average. Missing or non-finite results are stored explicitly as
unavailable, not zero. Every scalar stores its finite sample count and valid
duration. Values can be exported with input and operation IDs.

Existing `min-max` recipes retain their extrema samples as derived signals for
compatibility. New minimum/maximum calculations create true scalar values.

## Existing work and rollback

Opening an old workspace adds history metadata without changing signal samples,
node IDs, recipes, region versions, or calculations. Explicit old batch IDs define
grouping; names never determine membership. Previously hidden region-scoped crop
inputs become visible derived outputs. Standalone region settings remain as
**Saved region ranges**, with an action to create signal segments from their exact
boundaries. They are not silently expanded into copies of every channel.

For older work that did not store a global invocation order, migration uses the
available timestamps and dependency order. All newly recorded steps have an
append-only sequence, including after a clock change. Step/output metadata is
saved in the same IndexedDB transaction as the operation. Failed or cancelled
batches publish no partial values; the existing concurrent-writer check applies.

`main` remains the earlier implementation. The new IndexedDB fields are additive;
returning to the old branch does not delete originals. The older UI does not
display the new scalar records. Use the workflow branch to see them again. Close
the app before switching and rebuilding a branch. User data stays local; no
desktop workspace is uploaded or replaced by validation.

## Verification and limits

### Inspection and delivery

Individual outputs open **Plot & samples** or **Value & input**. Operation rows
open **Step outputs** directly; **View all outputs** opens the operation's full
tree in the history sidebar with a return button. The compact action bar
keeps checked input scope visible; long input lists and full lineage expand only
when needed. Narrow layouts keep history behind a labeled toggle. Native charts
adapt tick density to their width without distorting axis text. A named lineage
filter shows only contributing outputs, excluding unrelated siblings.

**Export data…** is available alongside the inspection tabs. Its dialog names
the exact scope, output count, format and filename before downloading. Viewing
one result defaults to exporting that result; whole-step export is explicit.
Table filters never silently change export scope.

- Samples CSV contains actual evaluated times and values, including nested
  segments and shifted clocks. Missing values are blank. Multiple signals use
  separate rows to preserve their individual sampling grids.
- Signal summary CSV contains one row per signal, not individual samples.
- Values CSV contains the exact selected scalar results and input references.
- Printable HTML reports are self-contained snapshots with results, bounded
  signal plots and chronological contributing history. They can be opened
  without the app and printed or saved as PDF using a browser. Imported labels
  are escaped; formula-like CSV text remains text in spreadsheet software.

Printable HTML reports have a fixed layout. The **Reports** workspace composes
an editable multipage PDF from snapshots of signals, values and saved plots,
including multi-axis and lane layouts (`docs/report-builder-mockup.md`); saved
report templates and persistent report drafts are not yet available. Large sample files are assembled in memory as a Blob and
remain subject to device memory limits. Export cancellation suppresses download
even when the worker request had been queued.

`pnpm test` includes numerical, storage, migration, chronological ordering, batch
membership, and 5,000-level history checks. `pnpm desktop:ui-smoke` tests the real
native renderer with isolated temporary storage: derivation, nested segmentation,
values, a 40-output batch, pagination, input recovery, and keyboard navigation.
It verifies actual native downloads for one-value and whole-batch scopes,
evaluated nested samples and standalone reports. Unit tests check missing data,
shifted sample axes, export escaping and contributing-only history.
It writes an ignored native screenshot to `outputs/workflow-desktop.png`.

The history is virtualized and output tables are paged. Existing data-engine
limits remain: 1,000 segments or 10,000 output signals per segmentation batch,
browser storage quotas, and a scan to generate a signal's first plot. This change
does not add workflow scheduling, mutable recipes, plugins, or binary importers.
