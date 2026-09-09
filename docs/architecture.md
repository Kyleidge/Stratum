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
calculations retain every dependency.

The active workspace (`region-workbench.tsx`) separates three concepts:

- Signals: raw columns and lazy derived recipes.
- Region sets: versioned collections of time intervals on the recording clock.
  Creating regions writes metadata only. A child records its parent region ID and
  parent set version. Editing appends a version; existing references stay pinned.
- Function runs: one invocation, its exact inputs, parameter, processing scope,
  and output family. Each output records its input and region ID. Min / Max is
  presented as a result table, backed by sparse extrema nodes for provenance.

The left history is virtualized with one item per region/function invocation.
Region/results tables are paginated (25 rows), and charts show at most six traces.
Input links expose prior operations; nested region tables identify their parents.
View selection never silently changes processing scope. Batch application uses
region ancestry to map each input family member to its own descendants, rather
than multiplying every member by every region. No operation concatenates regions.

Applying a function within regions creates internal crop recipes only for its
chosen inputs. A new filter resets at each region start. An already filtered
input retains its earlier history. Node creation and the function record publish
atomically. Empty scopes are excluded and counted; invalid batches leave no
partial graph. New interval membership is start-inclusive/end-exclusive, except
at an inclusive parent/recording endpoint. Overlap remains intentional.

Nested segmentation uses one or all selected parents independently. Manual ranges
and windows may be relative to each parent's start. Triggers always evaluate on
recording time; offsets apply after pairing, and pairs never cross parent bounds.
Windows can overlap or retain short tails. There is no nesting-depth cap. Each
request is limited to 1,000 regions or 10,000 function outputs.

Existing segmentation operations migrate to region sets without modifying their
signal recipes, IDs, samples or inclusive endpoint semantics. Old calculations
become function history records with their actual input IDs, including binary
inputs. Legacy tree/editor modules and worker requests remain for compatibility
and regression coverage; new UI entrypoints use the region workflow.

Graph validation, bounds, history traversal, and streaming evaluation use
iterative algorithms, with no configured operation-depth limit. The evaluator
uses an explicit stack of pull frames, reuses owned unary buffers, and retains
filter state across chunks. Binary inputs align samples across unequal chunk
boundaries. A 5,000-operation fixture verifies evaluation and persistence; a
5,000-level region fixture checks ancestry without recursion.

Raw crops and bounded raw trigger scans skip chunks outside their range. Stateful
predecessors still see their preceding history. Time shift and zero-time alignment
change the signal axis while region bounds stay on the recording clock. Evaluation
streams chunks without materializing whole derived recordings. At most 64 plot
summaries are cached. A persistent derived-value cache and disk-backed plot pyramid
remain future work; multi-gigabyte throughput has not been benchmarked.

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

## Trigger semantics and legacy segmentation compatibility

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
too-short intervals are excluded. Legacy crop membership is inclusive; a sample on a
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

The following describes the retained legacy segment protocol. New region sets use the model above.

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

Each successful segmentation request also saves one operation record, keyed by its
batch ID, containing the original definition, complete input IDs, scope, independent
processing mode, and output segment IDs. This retains inputs even if they produce
no intervals. The tree displays one Segment operation above its file segments.
Double-click, Enter/F2, or the settings button opens an isolated settings snapshot.
Expansion uses the separate disclosure arrow. Revised settings append a new
operation and outputs, preserving earlier results and dependencies. Older batches
without operation metadata recover their available settings from saved segments;
very early records with no complete recipe are identified as such.

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
