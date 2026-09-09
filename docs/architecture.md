# Stratus prototype architecture

The same React workspace runs inside Electron and the Sites browser preview.
Desktop builds bundle the renderer and worker locally and need no web server or
network connection. The Electron renderer is sandboxed with Node integration
disabled, context isolation enabled, a restrictive content security policy,
blocked external navigation, and no general-purpose filesystem IPC.

## Data and lineage

The worker owns an IndexedDB database. CSV import decodes 256 KiB slices with
backpressure. A stateful quoted-field parser preserves boundaries across slices,
including UTF-8 sequences, CRLF, quoted newlines, and escaped quotes. The first
column is strictly increasing time in seconds. Signal cells are finite numbers
or empty (stored as NaN). Invalid imports fail without publishing a source.

Data is stored in append-only, 16,384-sample Float64 columns. Each recording has a
shared timestamp column and a time-range index for its chunks. Reads return
copies, so evaluation cannot mutate cached source buffers. The read cache has a
16 MiB limit. Committed raw data has no update or delete operation in the app.
This is application-level immutability, not a cryptographic archival guarantee.

Source metadata is published only after every chunk commits. A project revision
is checked inside the same IndexedDB write transaction to reject stale writers
from another window. Failed and cancelled imports delete only their own
unpublished chunks. A process crash during import can leave orphan chunks; safe
maintenance/garbage collection is deferred rather than risking another window's
active import. Electron permits one app instance per user profile.

Derived nodes form an append-only DAG with immutable IDs, operation versions,
parent IDs, parameters, units, and creation time. Operations always reference
existing nodes; modifying parameters creates a new node. Multiple-parent
calculations retain every dependency. The explorer starts with the recording file.
File segmentation appears once as an operation with file-segment children, each
containing all original channels cropped to the same interval. A sibling Original
signals folder contains the raw signals and their individual operation chains.
Signal-only segmentation stays under its data input; its trigger signal is a
linked dependency, not its display parent. Additional inputs remain linked in
the history. Signals are displayed once, and structural folders do not count as
processing steps.
Segmentation and multi-member derivation actions retain explicit batch IDs.
Shared processing is shown once above expandable member outputs; deviations
remain under individual members. Repeated actions create separate branches.
Selecting a collection captures its exact member IDs, and a batch publishes all
its independent outputs atomically. It never joins samples across segments.

Explorer rows are virtualized and full history is paginated in groups of 50.
Graph validation, bounds, history traversal, and streaming evaluation use
iterative algorithms, with no configured operation-depth limit. The evaluator
uses an explicit stack of pull frames, reuses owned unary buffers, and retains
filter state across chunks. Binary inputs align samples across unequal chunk
boundaries. Stateful processing before a crop sees its preceding history;
processing after a crop begins at that segment. A 5,000-operation fixture verifies
evaluation, immutable inputs, explorer ordering, and persistence/reopening.

Segments are virtual inclusive sample-time intervals. They reuse original
columns and skip chunks outside their range. Time shift and align-to-zero change
the evaluated axis. Derived evaluation streams chunks through filters and
calculations; it does not materialize an entire derived recording. A bounded
cache holds at most 64 plot summaries. There is no persistent derived-value cache
or disk-backed multiresolution plot pyramid yet.

## Implemented calculations

- Segmentation: independent start/end signal edge triggers, explicit time ranges,
  and fixed-duration windows. Generic thresholds work in each signal's own units;
  there is no implicit smoothing or engine-specific classification.
- Power: torque in Nm × rpm × 2π / 60,000 gives kW.
- BSFC: fuel in kg/h × 1,000 / power in kW gives g/kWh. Power at or below 0.1 kW,
  negative fuel, and missing inputs produce missing results.
- Segment BSFC is total fuel / total energy, using trapezoidal integration on
  intervals valid in both inputs. It is not the arithmetic mean of pointwise
  BSFC. Fuel used is integrated kg/h × seconds / 3.6, expressed in grams.
- Moving average: trailing sample window with a rolling sum/count. State spans
  storage chunk boundaries; missing samples are excluded.
- Median, exponential smoothing, and first-order low-pass/high-pass RC filters
  also retain state across chunks. RC filters use actual sample intervals.
  See [filter parameters and gap semantics](filters.md) for their contracts.
- Scale, offset, absolute value, backward derivative, and cumulative trapezoidal
  integral. Integral skips invalid intervals and exposes missing output at gaps;
  its unit explicitly includes seconds.
- Min / Max: a sparse signal containing the finite minimum and maximum at their
  original timestamps, sorted by time. Ties retain the first occurrence, a
  constant signal yields one point, and all-missing input yields none. The plot
  displays these extrema as points. Each segment produces its own extrema.
- Time shift, zero-time alignment, and linear resampling. Resampling preserves
  exact endpoints, limits gaps to five times the initial source spacing, rejects
  non-advancing floating-point grids, and caps output at 100 million samples.
  Linear interpolation is not anti-aliasing; filter before downsampling.

Signal units for the explicit segment power/BSFC step come from bracketed headers:
`[rpm]`, `[Nm]`, and `[kg/h]`. Other units are kept verbatim; there is no general
unit-conversion engine. A dyno cannot yield distance-based fuel economy from fuel
flow alone. The demo therefore uses brake-specific fuel consumption.

## Segmentation semantics

For rising edges, the preceding finite value must be at or below the threshold
and the next value strictly above it; falling edges reverse these comparisons.
Crossing times are linearly interpolated between adjacent finite samples. An
initially active signal does not fabricate a crossing. Missing samples reset
adjacency and cancel an open pair. The first start opens an interval; repeated
starts are ignored until the first strictly later end closes it. Unmatched starts
are omitted and counted. Different start and end signals are allowed within one
recording; both must have valid coverage. Apply a filter as an explicit derived
node if a trigger needs smoothing. Hysteresis and debounce are not implemented.

Triggers are paired before applying independent signed time offsets. Offsets may
create overlapping output intervals. Trigger times and all stored segment ranges
use recording time, translating zeroed/shifted derived inputs back to that axis.
Each output crop retains its own parent's displayed axis. The boundary policy
clips to shared output coverage or discards an interval extending outside it.
Minimum duration applies after offsets and clipping. Reversed, empty, and
too-short intervals are excluded. Crop membership is inclusive; a sample on a
shared endpoint can belong to adjacent segments. Boundaries need not coincide
with sample times, and duration describes the interval rather than sample count.

Manual ranges accept explicit start/end pairs in seconds. Windows accept a
duration, step between starts, and an optional shorter final window. A step
shorter than duration creates overlap; a larger step leaves gaps. Requests are
limited to 1,000 intervals and 10,000 generated crop nodes. Trigger detection
streams two bounded iterators without retaining every sample or crossing. A
single preview cache avoids rescanning immutable inputs when creating the same
recipe immediately afterward. Preview is read-only and reports clipping,
exclusions, and unpaired starts.

Each saved segment retains the complete definition, trigger events, requested
and actual boundaries. Crop parents include their data input first, followed by
distinct trigger dependencies for provenance. Definitions are shared across
segments in a batch. Earlier prototype segments preserve their legacy definition;
reopening does not silently recalculate or migrate them. Segmentation only
creates crops. Power/BSFC is a separate action which validates matching sample
grid recipes before publishing calculation nodes.

New segment records persist `scope: file | signals`. File scope requires the
complete set of original channels and shared boundaries, validated before preview
or publication. The editor defaults to Entire file; individual signals and existing
signal collections are explicit alternatives. A one-channel recording can still
distinguish file scope from signal scope. Legacy records without this marker
display as file segments when their crop data parents cover every original
channel, preserving stored recipes and IDs without a data migration.

Segmenting a selected collection evaluates each member separately. When a start
or end trigger selects the first member, that trigger follows the corresponding
member in each branch; an explicitly selected external trigger stays shared.
Preview lists identify their input member. Ranges still use recording time.

## Responsiveness and current limits

The UI receives metadata, 100-row data pages, and time-bucket min/max envelopes,
never the full raw recording. Envelopes retain extrema timestamps, chronological
order, endpoints, and a missing-value marker per bucket. Very many missing gaps
within one bucket cannot all be represented. Hover values are preview points.

CSV input and channel caches are bounded, but many channels and deep derivation
chains increase concurrent processing buffers. Cold whole-recording plots still
take a full scan; pagination also scans preceding derived values. Browser disk
quota and storage eviction apply. The architecture avoids a full-file UI load;
multi-gigabyte throughput and peak memory have not been benchmarked or certified.
There is no fixed operation-depth cap, but finite memory and processing time
still apply. The first next step for production scale should
be an on-disk summary pyramid, job prioritization, and a native columnar store.

The workbench includes fifteen selectable operations plus explicit power and BSFC.
FFT, higher-order filters, general formula parsing, arbitrary source generation,
native TDMS/MDF import, signed installers, project interchange/backup, and plugin
execution are not implemented. No user data is uploaded by analysis operations.

Security follows the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
and [custom protocol API](https://www.electronjs.org/docs/latest/api/protocol).
