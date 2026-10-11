# Multiple sources and time bases

Use **Compare & align** beside the processing scope to select signals from any
recording. The recording selector includes **All recordings & workspace
results**. CSV import accepts multiple files; each successful import remains an
independent, undoable operation if a later file fails or is cancelled.

Sources, time references and sample grids are separate concepts. A source owns
immutable imported columns. A time reference names the meaning of timestamps.
A grid contains the actual sample timestamps, which may be irregular. Every
recording starts on its own time reference. Equal numbers in two files never
establish a clock relationship; only clock times do.

## Relative and absolute (clock) time

Sample times are always seconds on the recording's own axis, strictly
increasing. A recording whose file says when it happened also keeps a
**clock** (`TimeClock` in `lib/time-types.ts`): `start`, the Unix time (UTC
seconds) of axis time 0; `offset`, the minutes east of UTC the file's clock
showed, in which its times are shown; and `undated` for files that give times
of day without dates. Times stay small numbers relative to `start`, so a
microsecond recording keeps its resolution; a Unix-seconds double would not.
Its time reference is then `absolute` with that clock; without one it is
`relative` (elapsed time from an unknown instant).

Clocks come from:

- **Delimited text** time columns read as _Date and time_ (ISO 8601 such as
  `2026-10-10T14:03:22.120+01:00`, `2026/10/10 14:03`, `10.10.2026 14:03:22`,
  `10/10/2026 2:03 PM`, a date alone, or a time of day alone) or _Unix time_
  (numbers in any unit of time since 1970-01-01 UTC). Time 0 is the first row.
  Text without a zone is read in the chosen zone, by default this computer's
  zone at the first row, kept for the whole recording so a daylight-saving
  change never makes time jump. Text with a zone (`Z`, `+01:00`) keeps it. Day
  and month order is detected from dates that settle it, otherwise from the
  computer's language (month first only in US English) and can be chosen in
  the import dialog. Times of day pass midnight when they fall back by more
  than 12 hours. A file with separate date and time columns imports with the
  time-of-day column as its clock.
- **MDF 4 and 3** header start times, **TDMS** `wf_start_time` or timestamp
  axes, and **Excel** date-formatted time columns (see `docs/file-formats.md`).

Derived signals inherit the clock with their time reference. **Time shift**
keeps it (a shift corrects a clock), and **Zero time** moves it to the
signal's start, so clock times are unchanged. Details shows a signal's clock
start, and **Clock time** on the plot toolbar labels a time axis that shows
one time reference (one recording, or a Stacked panel) with clock times
(ticks at round seconds, minutes and hours, the date at midnight and in the
axis title); it is a display setting saved with the plot. Samples CSV adds
a `Clock time` column (ISO 8601 with the clock's offset, to the microsecond)
when an exported signal has a clock; it is blank for those without.

## Compare and align

Overlay uses evaluated timestamps without resampling. Up to eight selected
traces are shown, with separate plots for different units and a shared horizontal
interval. The selector and input lists are paged. An overlay of different time
references is explicitly identified as a comparison of numeric axes.

Saved plots take signals from any recording: check them in History and choose
Plot, use a plot's Add signals, or drag History rows onto it. Overlay and Y axes
draw them at their own time values, and the plot footer names separate time
references; Stacked gives each its own time range, and Align starts compares
them from their starts. None of these creates a time reference.

Alignment creates ordinary derived signals on a named relative or absolute
(Unix seconds) timeline. Choose a new timeline or an existing time reference.
Signals sharing a time reference form a group by default; one transformation
applies to the entire selected group, preserving channel delays. Alternatively,
align each signal separately, for example to compare repeated segments.

Supported anchors are group start, a signed manual offset, a selected timestamp,
**clock time**, or a numbered rising/falling threshold event with an optional
signed offset. Lining up recordings that have clocks defaults to clock time.
Clock anchors put every group on a timeline that tells clock time: an existing
one keeps its clock, and a new one starts at the earliest first sample of the
clock-anchored groups, shown in the first group's offset; the line-up time is
seconds from that instant. A group whose time reference has no clock, or a mix
of dated and time-of-day clocks, is refused. A relative timeline cannot take
clock anchors. Clock times are only as right as the recorders' clocks: correct
a known offset with an extra shift, or drift with a second anchor.
Threshold crossings interpolate adjacent finite samples and never bridge missing
samples. The event signal is an explicit lineage dependency. A missing event
rejects the whole operation.

A second synchronization point enables clock-rate correction. Each output uses
`(input time - first anchor) * scale + target time`, with a positive scale
calculated from the two pairs of points. This is clock correction, not automatic
normalization of test duration; elapsed time, derivatives and integrals reflect
the corrected clock. Originals remain unchanged. Non-increasing or unrepresentable
transformed timestamps are rejected before publication.

## Resample and calculate

Inputs must share an explicit time reference. Resampling targets either a uniform
grid with a shared start, end and rate, or the actual timestamps of another signal
within a chosen interval. The reference signal is a dependency even when its
values are missing. Choosing only the same rate does not align two grids.

Interpolation supports linear, previous-value hold and nearest sample (ties choose
the earlier sample). An explicit maximum gap prevents bridging long interruptions.
There is no extrapolation. Exact sample values, including missing values, are
retained at their timestamps. By default, the dialog uses the overlapping interval;
an explicitly broader grid produces missing values outside each input's support.

For downsampling continuous measurements, enable the anti-alias filter or supply
appropriately filtered inputs. The optional filter is a symmetric, normalized
Blackman-windowed sinc FIR evaluated before interpolation. Cutoff and half-width
(4–256 samples on either side) are saved. It requires regularly spaced input;
irregular timestamps are rejected rather than passed through an invalid filter.
Filter windows containing missing values or unsupported recording edges produce
missing values. The centered filter does not shift timestamps. Filter quality
depends on the chosen cutoff and width; it is not an automatic bandwidth detector.

Sum, difference, product and ratio require the same time reference and exactly
matching timestamps and lengths. Resample to a common grid first when needed.
Sum and difference require identical unit labels; automatic unit conversion is
not included. Missing/non-finite inputs and division by zero yield missing values.
Existing numerical functions can process the outputs, including binary functions
when their explicit shared-grid recipes match. Calculate value can also summarize
signals from different sources independently without requiring aligned clocks.

Workspace outputs support manual, trigger and window segmentation through the
existing Segment action, including nested segments. Those ranges use the current
workspace time axis; shared triggers must use the same time reference. Crop
comparison interval is also available in Compare & align.

## Persistence and delivery

Time operations append one chronological invocation with exact input membership,
saved settings and output IDs. They belong to the workspace rather than an
arbitrarily selected recording. `sourceId: ''` identifies this scope for backward
compatibility with existing string-based records; it never represents a synthetic
stored recording. Source provenance is obtained from all parents. `timeReference`
and `timeRecipe` are explicit on time-operation outputs; ordinary unary outputs
inherit their reference through the graph.

Edit rebuilds the operation and dependent invocations atomically. The existing
revision, output-ID preservation, Undo/Redo, cross-window coordination and queued
cancellation rules apply. Removing either contributing source removes dependent
invocation batches. Backups validate time recipes, references and dependencies
before publishing restored metadata.

Samples CSV retains the actual evaluated samples and adds time-reference name,
ID and meaning before the Time and Value columns. Its Recording field lists all
contributing recordings for workspace outputs. Printable reports include the time
reference and saved alignment/resampling settings. Plot envelopes are never used
as calculation or resampling input.

`tests/time-bases.test.ts` covers different origins/rates, event and clock-rate
alignment, interpolation and gaps, reference grids across chunk boundaries,
anti-alias filtering, atomic failures, editing, dependency deletion, nested
segmentation and archive restore. The desktop UI smoke includes multiple-file
import, overlay, alignment, resampling and a scalar result from cross-file math.
