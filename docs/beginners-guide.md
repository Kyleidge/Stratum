# Stratus: beginner's guide

## Your first signal workflow

Import a recording, create useful results, and keep every step traceable.
Original samples stay unchanged; each operation creates new signals or values.

### 1. Open the example

Launch Stratus and choose **Workspace > Open example workflow**. The empty
workspace also offers **Open example workflow**. This loads a motor-test recording
and seven completed steps: original signals, smoothing, multiplication, run
segments, averages, smaller segments, and maxima. Expand a step in **History tree**
and click an output to inspect it.

### 2. Bring in your own recording

Choose **Import CSV**. Use a comma-separated UTF-8 file with time in seconds in
the first column and signal names in the header. Put units in square brackets:

```csv
Time [s],Speed [rpm],Torque [Nm]
0.00,1500,210
0.01,1502,211
0.02,1504,212
```

Times must increase strictly, with no duplicates. Leave missing signal cells
empty. Imported recordings and results are saved locally on this device.

### 3. Choose what to process

Click a signal to view it in **Active**. By default, processing follows your
selection. To process several signals, select their step and tick the checkboxes
in **Step outputs**. Check the input-count control beside the tools before
creating anything.

**Remember:** checked inputs stay selected while you browse other items. Open
the input-count control and choose **Follow selection** to use the viewed item
again. A highlighted item and a checked processing input serve different purposes.

### 4. Try a small workflow

Using the example, select the original torque signal and follow these steps.
Use **Follow selection** first if a checked batch is active.

- **Smooth:** choose **Derive > Filters > Moving average**, set **Window size** to **5**
  samples, then **Create 1 derived signal**. Select the new output.
- **Keep an interval:** choose **Segment > Time ranges**. Set the range's
  **Start (s)** to **10** and **End (s)** to **50**. Choose **Preview**, check the
  boundaries, then **Create signal segments**. Select the new segment.
- **Get a number:** choose **Value > Time average**, then **Create 1 value**.
  Open the result to see its value, unit and sample coverage.

A segment is another signal: you can derive from it or segment it again.
**Time average** weights by elapsed time; **Sample average** weights each finite
sample equally. **Minimum** and **Maximum** find the lowest and highest samples.

<!-- pagebreak -->

## Explore, compare and save

Use history to find your work, plots to compare it, and exports to take it with you.

### Find outputs and their inputs

**History tree** lists operations oldest first. Expand the arrow beside a step
for its outputs; select the step for the full **Step outputs** table.
**Signals & values** provides a searchable list. Use **Scope** to show one
recording or **All recordings & results**.

The **...** menu beside the tools contains **View samples**, **Inputs and
originals**, **Show lineage in tree**, and **Used by later operations**. These
help you see the data and calculations behind a result. Clear search or choose
**Show all steps** if a filter hides something you expect to see.

### Compare signals on a plot

**Active** follows the item you inspect. Choose **Keep plot** to retain it in a
named tab, or **New plot**, then **Add signals**, to build a comparison. You can
also drag signals onto a plot. Dragging a segment adds all sibling segments from
its operation; use **Add signals** to choose individual members.

Use **Align starts at 0** to compare segments by elapsed time. This changes the
display only. **Compare** opens **Compare & align** for creating reusable aligned
signals, including signals from different recordings. On a focused plot, scroll
to zoom time, Shift-drag to pan, and choose **Fit** to see the complete plot again.

### Change or undo an operation

Right-click a History item to rename it or manage its operation. **Edit settings**
updates the operation and recalculates dependent results. **Duplicate operation**
starts a separate branch. **Delete operation** shows the dependent work that will
also be removed. The header's **Undo** and **Redo** keep the last 20 workspace
changes, including across restarts.

### Export results

Choose **... > Export / report**. Set **Include** to the viewed output, checked
signals, or all outputs from a step. Choose a **File format**, review the included
outputs, then **Download file**.

| Format                  | Use it for                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Samples CSV             | Every evaluated signal sample, with its time axis; missing values stay blank.                      |
| Values CSV              | One row per calculated value, with units and its input.                                            |
| Signal summary CSV      | A compact summary of each signal, without individual samples.                                      |
| Printable report (HTML) | A snapshot of results, plots and contributing history. Open in a browser and print or save as PDF. |

### Keep a workspace backup

Choose **Workspace > Download workspace backup** and keep the **.stratus** file
somewhere safe. It includes original samples, recipes, results, names and history;
saved plot layouts and Undo/Redo history are excluded. **Restore workspace backup**
replaces the current workspace after confirmation; Undo can recover the prior one.

Desktop and browser workspaces have separate local storage. Use a backup to move
your analysis between them or to another computer. Result CSV files are not
workspace backups. Backups support up to **128 MiB**; Samples CSV supports
**64 MiB** per file. For a larger sample export, choose fewer signals or shorter
segments. The header's **Guide** opens the built-in workflow help.
