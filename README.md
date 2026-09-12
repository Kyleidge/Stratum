# Stratus

A desktop workbench for workflows built from immutable time-series signals.
Derive signals, segment them into reusable signal chunks, and calculate scalar
values. Each operation keeps exact links to its inputs and outputs in chronological
history. The included motor-test example demonstrates the complete signal workflow.

New to Stratus? Read the two-page
[beginner's guide (PDF)](output/pdf/stratus-beginners-guide.pdf), with an
[editable text version](docs/beginners-guide.md).

See [the workflow proposal](docs/workflow-proposal.md) for the design and migration
rules. The earlier region workspace is retained for compatibility.

## Run

Use Node 24 and pnpm 11.19.0 in this local checkout:

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm desktop
```

For a browser preview, run `pnpm dev` and open its printed local URL. The desktop
build uses bundled assets and works offline. Browser and desktop workspaces have
separate local storage.

Create a portable desktop build with `pnpm desktop:package`. On Windows, launch
`build/releases/Stratus-win32-x64/Stratus.exe`. Keep the entire output folder
alongside the executable. Packaging on macOS/Linux produces the corresponding
native bundle. Packages are unsigned development builds.

## Explore

The center is a **plot scratchpad**. **Active** follows the inspected signal;
**Keep plot** makes a named tab that stays open as you browse. **New plot** starts
a blank comparison. Use **Add signals** for keyboard-accessible selection, or drag
items from **History tree** or **Signals & values** onto the canvas, a named tab,
or New plot. Dropping on Active creates a comparison containing its current signal.

| Dragged item               | Onto a plot                                             | Onto a processing tool                                     |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Original or derived signal | Add that trace                                          | Select that signal                                         |
| Segment                    | Add all segments from its producing operation           | Select that segment only                                   |
| Operation                  | Add every plottable output                              | Select its signal outputs, or the inputs of its values     |
| Scalar value               | Add a dashed reference line over its evaluated interval | Select its input signal, with an explanation in the editor |

Turn on **Δt · Align starts at 0** to compare segments by elapsed time. This is
a display setting; it does not change timestamps or create a workflow operation.
Overlays require matching units and a shared clock, or elapsed-time display.
Other comparisons use stacked axes. Use **Compare & align** to create reusable
aligned signals with explicit time references.

Named plots retain their traces, colors, visibility, grid and elapsed-time settings
on this device. Trace controls show 30 at a time and stacked plots show eight at
a time; overlays include the full batch. The scratchpad supports twelve named
tabs and up to 10,000 traces per tab, rejecting larger drops without partial adds.
Plots reference live outputs, so edits refresh them and Undo can restore a removed
trace. Layouts are separate from workspace backups and workflow Undo/Redo.

The toolbar above History keeps **Derive**, **Segment** and **Value** in view,
with **Compare** underneath. The input-count control opens the processing scope;
it distinguishes the current selection from checked inputs. **Follow selection**
releases a checked batch so inputs follow the item you inspect again. Removing
every checked input disables creation until you choose new inputs.

The **⋯** menu contains samples, export, lineage and navigation. Drag over it to
reveal accepting menu items, or drop an item on it and choose an action. Right-click
a History item for edit, duplicate, rename and delete, plus inspection, export and
input selection. Keyboard users can open the context menu with **Shift+F10**.

Accepting tools highlight during a drag. A processing drop selects the item in
History and opens the editor with its exact inputs, replacing any checked batch.
Inspection preserves checked inputs. Creating or editing data still requires
applying the editor, and deletion shows its normal impact confirmation. Starting
or cancelling a drag does not change the selection.

Select a step to inspect its complete **Step outputs** table; use checkboxes for
batch selection. Browsing normally preserves checked inputs. **Inputs and
originals**, **Show lineage in tree**, and **Used by later operations** open the
selected item's relationships from the toolbar. Segments remain ordinary derived
signals and can be segmented again. **Repeat with new settings** appends a new step.
The footer shows the inspected item, processing scope, workspace totals, local
storage status and progress or notifications. The recording filter lives above
the History toolbar.

**Edit settings** revises the selected operation and recalculates dependent
operations as one transaction. Step numbers and output identities are retained;
the history displays the revision. If a changed segment count would invalidate
downstream mappings, the edit is rejected and the existing work stays intact.
**Duplicate operation** creates a separate branch instead.

**Delete operation** previews the complete dependent batches it will remove.
**Remove recording** removes a recording and its analysis from the workspace.
The header's **Undo** and **Redo** retain the last 20 changes across restarts.
Recordings, operations and individual output display names can be renamed.
Original samples are never edited.

Minimum, maximum, time average, and sample average create stored scalar values.
Time average weights by valid elapsed time and excludes missing intervals.

**Derive signal** opens a compact palette grouped into Math, Filters, Time and
Calculus. Math includes add, subtract, multiply and divide between signals, plus
constant scaling, offsets and absolute value. Each checked input is A; choose
one B to use across the batch. Both inputs must have matching sample grids and
time transformations in the same recording. Add/subtract require identical unit
labels; multiply/divide compose labels without automatic conversion. Missing
inputs, division by zero and non-finite results stay missing. Saved brake-power
and fuel-consumption recipes remain readable and editable for compatibility;
they are no longer offered for new operations.

**Segment** uses method cards for time ranges, regular windows and signal
triggers, with separate settings and scope panels. Switching methods retains
the entered settings and clears any outdated interval preview. **Calculate
value** offers four cards for time average, sample average, minimum and maximum,
with a short explanation of how each result is calculated.

### Included motor-test workflow

Choose **Open example workflow** from the empty workspace or **Workspace**.
The synthetic recording contains three speed sweeps over 180 seconds, sampled
at 10 Hz. Its seven chronological steps use the same operations as your own data:

1. Original motor speed and torque, kept immutable.
2. Smooth torque with a five-sample moving average.
3. Multiply smoothed torque by original speed with the math palette (Nm·rpm).
4. Split the product into three run signals: 10–50, 65–105 and 120–160 s.
5. Calculate one time-average value per run.
6. Segment Run 2 again into two 20-second signals.
7. Calculate the maximum value in each of those two signals.

The example has two original signals, seven derived signals and five values.
Open any of its seven steps in History to inspect its outputs, or drag a run
segment onto New plot and align its siblings at zero.
Use **Export / report** on any of these results for CSV data or a printable report.
Every result keeps direct links to its inputs. Edit, rename, delete and Undo work
on the example just as they do on imported recordings.

Opening the example again preserves edits. Select an example recording and choose
**Workspace → Refresh this example** to replace its analysis with the current
example. Refresh is one undoable change and preserves imported recordings.
For a one-time desktop refresh at launch, run `pnpm desktop --refresh-example`;
the startup request is consumed after success, so reloading preserves later edits.

### Importable example CSVs

Four small synthetic recordings are included in [examples](examples/README.md):

- [Motor runs](examples/motor-runs.csv): speed, torque and a trigger channel over three runs.
- [Second motor logger](examples/motor-logger-b.csv): the same events on a clock offset by 2.5 s.
- [Vibration](examples/vibration.csv): a reference wave, higher-frequency noise, a gap and a spike.
- [Thermal step](examples/thermal-step.csv): a heater command and two delayed temperature responses.

The [example guide](examples/README.md) gives import, segmentation, plotting and
alignment exercises, including how the synthetic signals were constructed.

### Earlier region workspace

The following describes the retained region implementation. Its saved signals,
calculations, and region settings are preserved when opening the workflow UI.

1. Choose **Worked examples** in the left panel: ramp filtering and statistics,
   nested 10-second windows, overlapping windows, or power and fuel consumption.
   These run real calculations. Selecting one again reopens its saved results.
2. **Function history** has one item per invocation. Region sets and calculations
   share a chronological list. Select an item to inspect its saved settings;
   input links let you follow earlier operations. Results stay in a table instead
   of multiplying the tree by every region and channel.
3. Use **Segment** to create reusable time regions. Configure rising/falling
   triggers (including signed offsets), manual ranges, or fixed-duration windows.
   Regions point to recording times and do not create signal copies.
4. To segment a segment, select a region set and choose **Segment within set**,
   or select a row and choose **Segment this region**. Choose all or one parent,
   and use recording times or times relative to each parent start. Each parent is
   scanned independently; child regions are clipped to it or discarded.
5. **Process regions** chooses signals or a result family and explicitly applies
   a function within a region set. Each new function has independent state per
   region. Filtering a whole signal before applying a region retains its earlier
   filter history. Processing scope is separate from the region selected for viewing.
6. Min / Max produces one table row per input and region. Other functions produce
   a signal or result family; the table shows their statistics. **Export results**
   includes region names, versions, boundaries, units, and provenance.
7. Changing a saved region operation creates a new version. Existing children and
   calculations keep their original version. Arbitrary operation depth and nested
   region depth are supported; a creation batch is limited to 1,000 regions or
   10,000 calculated results. Overlapping regions remain independent.

Older workspaces are adapted without deleting or changing signal recipes. Legacy
inclusive endpoints are retained; newly created regions include their start and
exclude their end, except at an inclusive recording/parent endpoint.

Import comma-separated UTF-8 files with time in seconds in the first column.
Put units in square brackets in the column headers:

```csv
Time [s],Engine speed [rpm],Torque [Nm],Fuel flow [kg/h]
0.00,1500,210,8.4
0.01,1502,211,8.5
```

Times must be strictly increasing; empty signal cells remain missing. Imports
are processed locally in chunks and saved in IndexedDB. An empty workspace offers
CSV import or an explicit example recording; examples are never inserted automatically.

Use **Workspace → Download workspace backup** to save original samples, recipes,
names, results and history in a versioned `.stratus` archive. Restore validates
the entire archive before replacing the workspace; the prior workspace remains
available through Undo. Keep backups outside the app's profile. Clearing local
storage deletes the local workspace and its Undo history.

Archive version 1 is limited to **128 MiB**; evaluated samples CSV is limited to
**64 MiB per file**. These exports prepare local downloads; they do not claim
that a file has finished saving. For larger exports, use shorter segments or
fewer signals. Reports are standalone printable HTML snapshots of the chosen
outputs and their contributing history.

## Validate

```powershell
pnpm test
pnpm test:preview # Requires pnpm dev running on localhost:3000
pnpm typecheck
pnpm lint
pnpm exec oxfmt --check
pnpm build
pnpm desktop:build
pnpm desktop:smoke
pnpm desktop:ui-smoke
```

The test suite exercises numerical results and storage behavior; the native smoke
check runs the worker and IndexedDB inside a hidden Electron window. The original
starter has 19 lint issues in its unused UI primitives and mobile hook. New
application code is checked separately as well.
`signal-functions.test.ts` checks independently calculated values and defaults
for every single-input library function, plus all four persistent examples.
`regions.test.ts` checks nested pointers, version pinning, state boundaries,
family mapping, all new examples, and legacy migration. Legacy explorer
regressions cover keeping
one function item for partial or mixed input batches. The preview integration
also runs every selectable example through the actual HTTP worker module.
The workflow tests import all example CSVs and verify their grids and missing
samples. The native UI check also exercises signal/segment/value drag-and-drop,
exact toolbar input scopes, zero-time plots and complete paged comparisons.

See [the usability and reliability review](docs/production-review.md) for the
implemented recovery guarantees and remaining release limits, and
[architecture and limitations](docs/architecture.md) for numerical semantics.
