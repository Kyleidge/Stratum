# Changelog

All notable changes to Stratum are listed here. Versions follow
[semantic versioning](https://semver.org/).

## 1.0.0 — Unreleased

The first release of Stratum, a Windows desktop workbench for analysing
time-series recordings. Recordings and workspaces stay on your computer.

### Recordings

- Open CSV and other delimited text (including semicolons with decimal commas,
  tabs and UTF-16 or Windows-1252 files), MDF 3 and 4, TDMS, MATLAB `.mat`,
  Excel `.xlsx` and WAV recordings. Files with several tables let you choose
  which to open. Large files are read in pieces, never all at once.
- Original samples are never changed; every result is a new signal or value.
- Problems in a file are reported with the file name, row and cause.

### Analysis

- **Derive** new signals with math between signals, scaling, offsets, absolute
  value, unit conversion, moving-average, median, exponential, RC and
  Butterworth filters, derivatives, integrals, resampling and time shifts.
- **Formula** evaluates expressions such as `A * B / 9549` across signals and
  calculated values, safely parsed and never run as code.
- **Segment** signals into time ranges, regular windows or trigger-based
  segments, with hysteresis and debounce to ignore chatter. Segments are
  ordinary signals and can be processed or segmented again.
- **Value** calculates averages, minimum and maximum, RMS, standard deviation,
  peak to peak, area, durations, times above or below a threshold, crossing
  times and counts. Values can drive other settings, such as offsetting each
  run by its own average.
- **Compare & align** puts recordings from different loggers on a shared time
  axis by events, offsets or two reference points.
- Every dialog shows a live preview before anything is created.

### History and workspace

- Chronological History of every step, with exact links from each result to
  its inputs, lineage back to the original recordings and what uses it.
- Edit a step and everything that depends on it recalculates in one change;
  delete shows exactly what will be removed. Undo and Redo keep the last 20
  changes, even across restarts.
- Check several signals across steps and recordings and process them together.
- **Ctrl+K** command palette searches every step and output.
- Workspace backups (`.stratum`) save recordings, history and results, and
  restore after full validation.
- A built-in motor-test example and guide show the complete workflow.

### Plots and reports

- Fast plots of long, high-rate recordings with lanes per unit, independent Y
  axes, stacked panels, cursors, measurements, annotations and SVG/PNG export.
- Saved plots keep their traces, styles, limits and annotations.
- **Reports** workspace for page-based PDF reports with plots, value tables,
  text, images and page designs. Captures are snapshots that change only when
  you update them.
- Export exact samples, values and summaries as CSV, or a standalone HTML
  summary.

### Batch workflows

- Save a recording's analysis, checks and report layout as a `.stratum.yaml`
  workflow and run it on many recordings, with pass/fail checks, a batch
  review view and one PDF report per item. One Undo removes a whole batch.

### Desktop app

- Windows installer for the current user (no administrator rights), with a
  Start-menu shortcut and an uninstaller that keeps your workspace.
- Automatic updates download in the background; Stratum asks before
  restarting to install them.
- Light and dark themes.
- Help menu with About Stratum, the licence and third-party notices.
- Released under the MIT licence.
