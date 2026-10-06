# Batch workflows

Build an analysis once on one recording, then run it on many. Each recording
(an **item**, such as one component from an end-of-line test rig) is imported,
processed with the same steps, checked against limits and, optionally, given its
own PDF report. Every result is an ordinary History step: you can plot,
edit, delete, export and back it up like work done by hand, and one Undo removes
a whole batch.

The design rationale and remaining follow-ups are in
[the plan](batch-workflows-plan.md). This page describes what is implemented.

## Try it with the example rig data

1. Choose **Import ▾ → Try the batch example (8 motors)**. The Run dialog
   opens with the example workflow and eight generated motor recordings. The
   same files are in [examples/eol-rig](../examples/eol-rig).
2. Pre-flight reads only each file's first line. A summary line counts the
   files that are ready, will error or can't be read, and problem rows are
   listed first. SN-24008 shows that its torque is logged in lbf·ft rather
   than Nm.
3. Choose **Run 8 recordings (1 will error)**. The batch view fills in, with a
   status for each item: two pass, one starts late but still passes, two fail,
   two warn and one errors. Each case is explained in the
   [example README](../examples/eol-rig/README.md).
4. Open a row to scope History to that item. Its first flagged output is
   selected, the item bar above the plot shows where it sits in the batch, and
   **Alt+←/→** moves between items while keeping the same step selected.
   **← All 8 items** returns to the batch view.
5. Back in the batch view, **Plot across items** overlays one output from every
   item (from Δt = 0) and names the items that have no such output. **Summary
   CSV** writes one row per item with every value. **Report** previews an
   item's PDF in Reports. **Export reports** produces one PDF per item, as a ZIP
   or, where the browser allows, straight into a folder.

## Author a workflow

1. Import one representative recording and process it with the normal tools.
2. Add **checks** in Details (select a step, then **Checks → Add check**):
   - **Number of outputs**, for example exactly 3 segments;
   - **Value limits** or **Sample limits** (min/max, with an exact unit);
   - **Missing samples (%)** and **Duration (s)** for signals.

   Each check either fails or warns. Checks evaluate immediately, flag the
   step and outputs in History (and the **Flagged** filter), and are undoable.
   A workflow without checks still runs, but its items show **No checks**
   rather than **Pass**; the Save dialog says so.

3. Optionally lay out a report in **Reports**. Add signals, values, saved plots
   and **Check results** from the library. Text can contain placeholders (see
   below).
4. Choose **Import ▾ → Save this recording's workflow…**. Pick the recording,
   the steps to include, the item label and how the item ID comes from the file
   name: **Text before the first space or underscore**, **Whole file name** or
   **Custom pattern…** (a regular expression), with a live preview. Saving
   segments by fixed times prompts a choice of where those times are measured
   from. Tick **Include the current Reports draft** to embed the report as the
   template. Then **Download** the `.stratum.yaml` file, or **Run on other
   files…** straight away.

## Run a workflow

**Import ▾ → Run a workflow on recordings…**, **Open a workflow file…**, or drop
a `.stratum.yaml` file (with or without recordings) onto the window. Add
recording files (CSV, MDF, TDMS, MAT, WAV or Excel) or recordings already in
the workspace. For a file with several groups, pre-flight picks the group that
matches the most workflow inputs and shows its name; only that group is
imported. Item IDs come from the file name
pattern and can be edited before you run.

- Items commit one at a time. Cancelling keeps the items already processed.
- A file that cannot be imported is listed as **Not imported**; nothing is
  published for it.
- A missing or mismatched input skips only the steps that need it; independent
  steps still run and the item is flagged **Error**. Pre-flight shows these
  files as **Will error**, in the same red as Error, and lists the columns each
  file has.
- When a file names a channel differently, choose its column under **Use
  column** (the closest match is listed first). **Apply to all files with this
  header** applies the choice to every file with the same columns. The choice
  belongs to this run only: the workflow file is unchanged, the item records
  the mapping, and the summary CSV lists it under **Mapped channels**.
- A file whose header can't be read is not run, and is named in the dialog.
- A step marked `on-fail: stop` skips the item's remaining steps when one of its
  checks fails.
- Running a workflow on a recording that is already imported adds the steps
  without importing it again.
- Editing an item's step afterwards is allowed. The item is marked
  **edited**, and its status is re-evaluated.
- PDF reports for each item are off by default; export them later from the
  batch view.

Batches are listed in the recording menu (**Batch · …**). Choosing one scopes
History to all its items and opens the batch view; it reopens after a reload
on the same device. Deleting an item's recording removes it from the batch.

### Statuses

Each item has exactly one status, and the batch view has one filter chip per
status, with a headline such as "4 of 10 items passed · 6 need attention":

- **Pass**: every evaluated check passed.
- **Warning**: a warning check failed, or a processing warning occurred.
- **Fail**: a fail check failed.
- **Error**: an input was missing or a step could not run.
- **No checks**: the item ran without problems, but its workflow has no checks.

Value columns follow the workflow's step order, with units on a second header
line. A value outside a check's limits is highlighted, and its tooltip gives
the limit. The item ID and Report columns stay visible while values scroll.

## The workflow file

A workflow is a YAML text file, normally named `<name>.stratum.yaml`. The
`.stratum` extension alone remains the workspace backup format.

```yaml
format: stratum-workflow
version: 1
name: Motor EOL test
revision: '1'
item:
  label: Serial number
  id: { from: file-name, pattern: '^(?<id>SN-[0-9]+)' }
input:
  channels: # Matched by CSV column name, ignoring case; unit checked exactly
    speed: { name: Motor speed, unit: rpm }
    torque: { name: Torque, unit: Nm }
steps:
  - id: smoothed-torque
    name: Smooth measured torque
    derive: { function: smooth, input: torque, parameter: 5 }
    outputs: Smoothed torque
  - id: sweeps
    segment:
      input: smoothed-torque
      triggers:
        start: { signal: speed, edge: rising, threshold: 850 }
        end: { signal: speed, edge: falling, threshold: 850 }
        minimum-duration: 20
      boundary: discard
    outputs: Sweep {n} · Torque
    checks:
      - count: 3
        severity: fail
        message: The rig should record three speed sweeps.
    on-fail: stop
```

The complete example, including a report template, is
[Motor EOL test.stratum.yaml](../examples/eol-rig/Motor%20EOL%20test.stratum.yaml).

### References

Steps refer to channel aliases and earlier step IDs (lowercase letters, digits
and dashes):

- `torque` refers to a channel.
- `sweeps` refers to every output of a step, in order, however many there are.
- `sweeps[2]` refers to the second output. If an item has fewer outputs, the
  step is skipped and flagged. Inside `{ }` or `[ ]`, quote it: `'sweeps[2]'`.

### Steps

Each step has exactly one operation:

| Key       | Settings                                                                                                        | Equivalent tool |
| --------- | --------------------------------------------------------------------------------------------------------------- | --------------- |
| `derive`  | `function`, `input`/`inputs`, `parameter`; two-input functions also need `with`                                 | Derive          |
| `segment` | `input`/`inputs`, one of `ranges`, `windows` or `triggers`, `boundary`, `independently`, `scope`, `time-origin` | Segment         |
| `value`   | `function` (`time-average`, `sample-average`, `minimum`, `maximum`), `input`/`inputs`                           | Calculate value |
| `time`    | one of `align`, `resample`, `combine`, `crop`                                                                   | Compare & align |

Optional step settings: `name`, `outputs` (a label with `{n}`, `{input}` and
`{item}` tokens, or a list of labels), `checks` and `on-fail: stop`.

`time-origin` applies to segment `ranges` and `windows`:

- `recording` (the default): recording times, exactly as saved.
- `recording-start`: measured from each recording's first sample.
- `input-start`: measured from the start of the step's single input, for
  windows within a segment found by triggers.

### Checks

```yaml
checks:
  - count: 3 # Or { min: 2, max: 4 }
  - limits: { min: 78, max: 95, unit: Nm }
    outputs: [1, 3] # Optional output positions
    severity: warning # Default: fail
    message: Torque out of range.
  - missing: { max: 0.01 } # Fraction of samples
  - duration: { min: 30 } # Seconds
```

Limits are inclusive. Signal limits use exact samples, never plot previews.
Unknown settings are rejected, so a mistyped limit is never ignored.

### Report template

The optional `report:` section has the same page, block and style settings as
the Reports workspace. Blocks can bind to recipe outputs:

| Binding                              | Block type | Renders                               |
| ------------------------------------ | ---------- | ------------------------------------- |
| `bind: { signal: smoothed-torque }`  | plot       | That signal for the item              |
| `bind: { plot: { traces: [...] } }`  | plot       | A saved plot with its layout and axes |
| `bind: { values: [sweep-torque] }`   | table      | Value, result and unit for each value |
| `bind: { checks: all }` or `flagged` | table      | Check results and processing problems |

Text, block names and the report title can use these placeholders:
`{{item.id}}`, `{{item.label}}`, `{{file.name}}`, `{{run.date}}`,
`{{run.status}}`, `{{run.flags}}`, `{{workflow.name}}`, `{{workflow.revision}}`,
`{{workflow.hash}}` and `{{value step-id[1]}}`.

### YAML subset and limits

Stratum reads a strict YAML 1.2 subset: block and flow mappings and lists, plain
and quoted text, `|` and `>` blocks and comments. Anchors, aliases, tags,
directives and multiple documents are rejected, so a file can never expand
beyond its own size. Other limits:

- 8 MiB per file and 500 steps;
- 500 recordings per batch run.

Errors name the line. A file from a newer Stratum version is refused rather than
partly read. Saving from Stratum writes a canonical layout, so comments in a
file you opened are not kept when you save a new copy.

Each batch stores the exact workflow text it used, identified by a SHA-256 of
the validated recipe. Reports and the summary CSV print it for traceability.

## Limits and notes

- Report PDFs are raster pages, so their text is not selectable.
- Batch results live in the current workspace and are included in backups.
  Very large lots use browser storage; the Run dialog warns when space may be
  short.
- Undo removes a whole batch at once. Restarting the app mid-batch keeps the
  items already committed, and the batch shows as interrupted.
