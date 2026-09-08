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
calculations retain every dependency. The UI presents an expandable tree and a
recursive lineage view. Repeated segmentation creates another revision.

Segments are virtual inclusive sample-time intervals. They reuse original
columns and skip chunks outside their range. Time shift and align-to-zero change
the evaluated axis. Derived evaluation streams chunks through filters and
calculations; it does not materialize an entire derived recording. A bounded
cache holds at most 64 plot summaries. There is no persistent derived-value cache
or disk-backed multiresolution plot pyramid yet.

## Implemented calculations

- Ramp detection: 15-sample trailing mean, configured threshold and minimum
  duration, and a minimum positive speed gain. Boundaries are resolved against
  raw threshold crossings. This is a transparent heuristic, not a general
  engine-event classifier; plateau splitting and hysteresis are future work.
- Power: torque in Nm × rpm × 2π / 60,000 gives kW.
- BSFC: fuel in kg/h × 1,000 / power in kW gives g/kWh. Power at or below 0.1 kW,
  negative fuel, and missing inputs produce missing results.
- Segment BSFC is total fuel / total energy, using trapezoidal integration on
  intervals valid in both inputs. It is not the arithmetic mean of pointwise
  BSFC. Fuel used is integrated kg/h × seconds / 3.6, expressed in grams.
- Moving average: trailing sample window with a rolling sum/count. State spans
  storage chunk boundaries; missing samples are excluded.
- Scale, offset, absolute value, backward derivative, and cumulative trapezoidal
  integral. Integral skips invalid intervals and exposes missing output at gaps;
  its unit explicitly includes seconds.
- Time shift, zero-time alignment, and linear resampling. Resampling preserves
  exact endpoints, limits gaps to five times the initial source spacing, rejects
  non-advancing floating-point grids, and caps output at 100 million samples.
  Linear interpolation is not anti-aliasing; filter before downsampling.

Signal units for automatic segment power/BSFC are read from bracketed CSV headers:
`[rpm]`, `[Nm]`, and `[kg/h]`. Other units are kept verbatim; there is no general
unit-conversion engine. A dyno cannot yield distance-based fuel economy from fuel
flow alone. The demo therefore uses brake-specific fuel consumption.

## Responsiveness and current limits

The UI receives metadata, 100-row data pages, and time-bucket min/max envelopes,
never the full raw recording. Envelopes retain extrema timestamps, chronological
order, endpoints, and a missing-value marker per bucket. Very many missing gaps
within one bucket cannot all be represented. Hover values are preview points.

CSV input and channel caches are bounded, but many channels and deep derivation
chains increase concurrent processing buffers. Cold whole-recording plots still
take a full scan; pagination also scans preceding derived values. Browser disk
quota and storage eviction apply. The architecture avoids a full-file UI load;
multi-gigabyte throughput, peak memory, and arbitrary-depth pipelines have not
been benchmarked or certified. The first next step for production scale should
be an on-disk summary pyramid, job prioritization, and a native columnar store.

The starter includes ten selectable operations plus automatic power and BSFC.
FFT, advanced filters, general formula parsing, arbitrary source generation,
native TDMS/MDF import, signed installers, project interchange/backup, and plugin
execution are not implemented. No user data is uploaded by analysis operations.

Security follows the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
and [custom protocol API](https://www.electronjs.org/docs/latest/api/protocol).
