# Stratum

A desktop workbench for workflows built from immutable time-series signals.
Derive signals, segment them into reusable signal chunks, and calculate scalar
values. Each operation keeps exact links to its inputs and outputs in chronological
history. The included motor-test example demonstrates the complete signal workflow.

New to Stratum? Read the illustrated
[beginner's guide (PDF)](output/pdf/stratum-beginners-guide.pdf), with an
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

Stratum keeps the original desktop profile, storage keys and internal origin so
existing workspaces, Undo/Redo and saved plots remain available after the rename.
New workspace backups use `.stratum`; existing `.stratus` backups still restore.
The archive format and version are unchanged.
[File format stability](docs/file-format-stability.md) states what each saved
format promises across versions.

Create a portable desktop build with `pnpm desktop:package`. On Windows, launch
`build/releases/Stratum-win32-x64/Stratum.exe`. Keep the entire output folder
alongside the executable. Packaging on macOS/Linux produces the corresponding
native bundle. Packages are unsigned development builds.

## Explore

The center is a **plot scratchpad**. **Active** follows the selection: a signal,
a value drawn as a labelled dashed line over its input, or up to eight outputs of
an operation, each keeping its colour. **Keep plot** makes a named tab that stays
open as you browse. **New plot** starts a blank comparison. Use **Add signals**
for keyboard-accessible selection, or drag items from **History** onto the
canvas, a named tab, or New plot. Dropping on Active creates a comparison
containing its current traces.

| Dragged item               | Onto a plot                                             | Onto a processing tool                                     |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Original or derived signal | Add that trace                                          | Select that signal                                         |
| Segment                    | Add all segments from its producing operation           | Select that segment only                                   |
| Operation                  | Add every plottable output                              | Select its signal outputs, or the inputs of its values     |
| Scalar value               | Add a dashed reference line over its evaluated interval | Select its input signal, with an explanation in the editor |

Turn on **Align starts** to compare segments by elapsed time. This is a display
setting; it does not change timestamps or create a workflow operation.
**Overlay** draws traces on one time axis and gives each unit its own lane;
**Y axes** overlays different units on independent scales; **Stacked** gives each
trace a panel. Traces need a shared clock, or elapsed-time display, to share a
time axis. Use **Compare & align** to create reusable aligned signals with
explicit time references.

Named plots retain their traces, colors, visibility, grid and elapsed-time settings
on this device. Trace controls show 30 at a time and stacked plots show eight at
a time; overlays include the full batch. The scratchpad supports twelve named
tabs and up to 10,000 traces per tab, rejecting larger drops without partial adds.
Plots reference live outputs, so edits refresh them and Undo can restore a removed
trace. Layouts are separate from workspace backups and workflow Undo/Redo.

One top bar holds the recording menu, **Undo**/**Redo**, **Derive**, **Segment**,
**Value** and **Compare**, and **Apply to**, which names the processing inputs.
It distinguishes the current selection from checked inputs; its **×** releases a
checked batch so inputs follow the item you inspect again. Removing every checked
input disables creation until you choose new inputs. **Ctrl+K** searches every
step and output and runs the same commands. The sun or moon button switches
between the dark and light themes.

The **⋯ Inspect / export** menu contains samples, export, lineage and navigation. Drag over it to
reveal accepting menu items, or drop an item on it and choose an action. Right-click
a History item for edit, duplicate, rename and delete, plus inspection, export and
input selection. Keyboard users can open the context menu with **Shift+F10**.

Accepting tools highlight during a drag. A processing drop selects the item in
History and opens the editor with its exact inputs, replacing any checked batch.
Inspection preserves checked inputs. Creating or editing data still requires
applying the editor, and deletion shows its normal impact confirmation. Starting
or cancelling a drag does not change the selection.

Select a step to plot its outputs. The dock below the plot lists them under
**Outputs**, with exact **Samples** and saved **Settings**; use checkboxes for
batch selection. In History, **Ctrl+click** signals (or their row check boxes)
to check several from any steps or recordings, **Shift+click** to check a range,
or **Ctrl+click** a step for all its signals. A bar below the tree then offers
**Value** and **Derive**, and right-clicking a checked row offers Value, Derive
and Segment for every checked signal. Browsing normally preserves checked inputs. The inspector on the
right shows the selection's properties, its lineage back to the original
recordings and the operations that use it. **Inputs and originals**, **Show
lineage in tree**, and **Used by later operations** are also in Inspect / export.
History filters by text and by the **All**, **Signals** and **Values** chips.
Segments remain ordinary derived signals and can be segmented again. **Repeat
with new settings** appends a new step. The footer shows the inspected item,
notifications with Undo, workspace totals and local storage status.

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

**Calculate value** creates stored scalar values, one per input, grouped in
four tabs:

- **Level**: time average, sample average, minimum, maximum, start value, end
  value and the value at a time from the input's start.
- **Spread**: RMS, standard deviation (n − 1), peak to peak and the area
  under the signal (unit × s).
- **Time**: duration, time of the minimum or maximum, and time above or below
  a threshold.
- **Events**: the time of the first rising or falling crossing of a threshold,
  and the number of crossings.

Time average weights by valid elapsed time and excludes missing intervals.
Every value excludes missing samples, and no interval spans a gap. Times are
seconds measured from the input's start, so they stay meaningful for
segments. Crossings use the same detection as segmentation triggers, including
optional hysteresis and debounce.
Thresholds start at the middle of the input's range. Plots draw a time or
count at the level it refers to, such as the threshold, labelled with the
result.

### Use values as settings

Some settings can come from a calculated value instead of a typed number:
**Offset**, **Scale** and **Shift time** in Derive, the threshold and time of
a value calculation, and the threshold and offset of segment triggers. Choose
**A value**, pick the value and a factor; the setting is factor × value. For
example, offset each run by −1 × its own average, or start segments when speed
rises above 0.5 × its maximum.

- Choosing a value step with several values matches one to each input: the
  value calculated from that input, or from the nearest signal it came from
  or that came from it. A single value is shared by every input.
- Units must match exactly (a time shift needs seconds; a scale factor
  multiplies the units). Nothing is converted. An unavailable value, or one
  that matches no input or two, blocks Create with an explanation.
- The step lists the values it uses as inputs, in Details, lineage and
  **Used by**. Editing a value recalculates every step that uses it; deleting
  it deletes them, after the usual impact confirmation.

**Derive signal** opens a compact palette grouped into Math, Filters, Time and
Calculus. Math includes add, subtract, multiply and divide between signals, plus
constant scaling, offsets, absolute value, **Formula** and **Convert units**.

- **Formula** evaluates an expression such as `A * B / 9549` for each sample:
  A is each input, B–Z are other signals on the same sample grid (a step's
  outputs are matched to each input by grid, so segments pair with their own
  sibling segments), and lowercase names are calculated values (matched per
  input like other value settings). Operators `+ − * / % ^`, comparisons
  (1 or 0) and functions such as `abs`, `sqrt`, `min`, `max`, `if`, `clamp`
  are available. You set the output unit; it is never inferred. Missing
  samples and non-finite results stay missing. Expressions are parsed, never
  run as code.
- **Filters** add second-order **Butterworth** low- and high-pass filters,
  twice as steep as the RC filters (see [filters](docs/filters.md)).
- **Convert units** converts between units of one quantity (torque, speed,
  temperature, pressure, power, flow and more) with exact factors, such as
  lbf·ft to N·m or °F to °C. The input's unit must be one Stratum knows. Each checked input is A; choose
  one B to use across the batch. Both inputs must have matching sample grids and
  time transformations in the same recording. Add/subtract require identical unit
  labels; multiply/divide compose labels without automatic conversion. Missing
  inputs, division by zero and non-finite results stay missing. Saved brake-power
  and fuel-consumption recipes remain readable and editable for compatibility;
  they are no longer offered for new operations.

**Segment** uses method cards for time ranges, regular windows and signal
triggers, with separate settings and scope panels. Switching methods retains
the entered settings and clears any outdated interval preview. Each trigger's
**Ignore chatter** section sets hysteresis (how far the signal must return
past the threshold before another crossing counts) and debounce (how long it
must stay crossed). **Calculate
value** offers cards in Level, Spread, Time and Events tabs, each with a short
explanation of how its result is calculated.

### Compose a report

Choose **Reports** in the top bar for a page-based report editor beside **Data
Inspector**. Switching keeps both workspaces as they were: the inspected item,
checked inputs, plots and the report draft. Add workspace content with
**Report** in the top bar (the viewed output or operation), **Add to report** in
a History item's context menu, the Outputs dock or the checked-input review, the
report button on a plot (its displayed panels), or by dragging a History item
onto the **Reports** button or the page. The report's **Data** library lists
every signal, value, value step and saved plot.

Captures are snapshots: later changes in Data Inspector never alter them, so add
an item again for its latest state. Signals become editable plot blocks and
values become read-only tables with editable titles and formatting. Saved plots
keep their traces, axes, lanes, annotations and value labels as images in the
current theme. Add text, images and tables; move, resize and format blocks
across A4 or Letter pages; and choose **Export PDF** to create the PDF on this
device. Report edits never change signals or workflow history. Drafts and report
Undo/Redo last for the session. See the
[report builder notes](docs/report-builder-mockup.md) for limits.

### Included motor-test workflow

Choose **Explore the example recording** from the empty workspace, or
**Open the example recording** in **Workspace**.
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
Use **Export data…** on any of these results for CSV data or a quick HTML
summary, or **Add to report** to compose a PDF in Reports.
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

Use **Workspace → Save workspace backup…** (the browser build: **Download
workspace backup**) to save original samples, recipes, names, results and
history in a versioned `.stratum` archive. Restore validates the entire archive
before replacing the workspace; the prior workspace remains available through
Undo. Keep backups outside the app's profile. Clearing local storage deletes the
local workspace and its Undo history.

The desktop app writes backups and evaluated samples CSV straight to the file
chosen in a Save dialog, in bounded chunks, with no size limit; a failed or
cancelled save leaves no partial file. In the Workspace dialog, **Automatic
backups** writes a timestamped backup to a folder you choose when Stratum
closes and every 30 minutes while there are changes, keeping the newest 10. A
failed automatic backup is reported in the app, including at the next launch.
In the browser, archives are limited to **128 MiB** and samples CSV to **64 MiB
per file**; these prepare downloads and do not claim a file finished saving.
For larger browser exports, use shorter segments or fewer signals. Export data's quick HTML summaries are standalone HTML snapshots
of the chosen outputs and their contributing history; use **Reports** for an
arranged multipage PDF.

**Batch workflows** run the same analysis on many recordings, such as one file
per component from a test rig. Save a recording's operations, checks and report
layout as a `.stratum.yaml` workflow, run it on a set of CSV files, review flagged
items in the batch view and export a PDF report per item. Every result is an
ordinary History operation, and one Undo removes the whole batch. Choose
**Import ▾ → Try the batch example** to see it with
[the end-of-line rig data](examples/eol-rig), and read
[batch workflows](docs/batch-workflows.md) for the guide and file format.

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
pnpm desktop:report-workspace-smoke
pnpm desktop:report-plot-smoke
pnpm desktop:report-smoke
```

The test suite exercises numerical results and storage behavior; the native smoke
check runs the worker and IndexedDB inside a hidden Electron window. `pnpm lint`
passes with no errors, and CI runs every check on each push.
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
