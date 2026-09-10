# Multiple sources and time bases

Use **Compare & align** beside the processing scope to select signals from any
recording. The recording selector includes **All recordings & workspace
results**. CSV import accepts multiple files; each successful import remains an
independent, undoable operation if a later file fails or is cancelled.

Sources, time references and sample grids are separate concepts. A source owns
immutable imported columns. A time reference names the meaning of timestamps.
A grid contains the actual sample timestamps, which may be irregular. Imports
currently accept strictly increasing numeric seconds and initially have separate
relative time references. Date-string parsing and automatic clock discovery are
not included. Equal numbers in two files never establish a clock relationship.

## Compare and align

Overlay uses evaluated timestamps without resampling. Up to eight selected
traces are shown, with separate plots for different units and a shared horizontal
interval. The selector and input lists are paged. An overlay of different time
references is explicitly identified as a comparison of numeric axes.

Alignment creates ordinary derived signals on a named relative or absolute
(Unix seconds) timeline. Choose a new timeline or an existing time reference.
Signals sharing a time reference form a group by default; one transformation
applies to the entire selected group, preserving channel delays. Alternatively,
align each signal separately, for example to compare repeated segments.

Supported anchors are group start, a signed manual offset, a selected timestamp,
or a numbered rising/falling threshold event with an optional signed offset.
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
