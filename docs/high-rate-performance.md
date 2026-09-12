# 100 kHz performance assessment

Measured 12 September 2026 against application revision
`79a46655158798cc0fd398f2bc5636b17ffc2c09`.

100 kHz recordings import and evaluate successfully at the tested sizes. Short
recordings are usable. Interactive inspection of a 60-second, four-channel
recording needs improvement: each new zoom or cursor request takes about
1.4–1.5 seconds on this machine. Sample rate alone does not determine the cost;
recording length, channel count, operation chain and cache state matter.

## Method

- Windows 10, AMD Ryzen 7 7800X3D, 16 logical CPUs, approximately 63 GiB usable RAM;
  Electron 44.2.0, production desktop worker bundle.
- Hidden, sandboxed Electron window, real disk-backed IndexedDB and disk-backed
  CSV Files selected through Chromium's file-input protocol. Temporary application
  profile, cleared IndexedDB between cases; the user's workspace was not opened.
- Deterministic 100 kHz timestamps, a 1 kHz sinusoid plus a second component with
  a 17-sample period, six decimal places and phase offsets between channels.
  Generation is excluded from operation timings.
- Two independently imported runs per case. Tables show medians of two runs;
  zoom and cursor columns show medians of six distinct requests. These are local
  measurements, not cross-hardware guarantees or statistical confidence intervals.
- Worker round trips include evaluation, storage, serialization and response
  transfer. They exclude React/SVG rendering and do not measure visual frame rate.
  Background throttling is disabled. This is an offline workflow benchmark,
  not a live acquisition or sustained streaming-ingest test.
- The worker is restarted before the first plot, clearing application caches.
  The operating system's disk cache is **not** flushed. Import and first-read
  throughput must not be described as cold physical-disk measurements.
- Every full plot and derived plot checks the complete sample count and bounded
  envelope size. Every 10 ms viewport checks 1,001 inclusive samples. Cursor
  endpoints match exact samples; RMS is finite. Scalar means agree with full-plot
  means to within 1e-9. Cancellation is followed by a successful new request.

## Results

All timings below are milliseconds. Full plots, zoom, cursors and mean calculations
include every channel in the case. A zoom requests a new 10 ms window halfway
through the recording; cursors measure a 10 ms interval.

| Duration | Channels | Samples per channel | Import | First full plot | New zoom | Cursor measurement | Mean calculation |
| -------- | -------: | ------------------: | -----: | --------------: | -------: | -----------------: | ---------------: |
| 1 s      |        1 |             100,000 |     82 |              11 |        8 |                  7 |                8 |
| 10 s     |        1 |           1,000,000 |    589 |              68 |      283 |                283 |              289 |
| 60 s     |        1 |           6,000,000 |  3,408 |             414 |      309 |                329 |              319 |
| 10 s     |        4 |           1,000,000 |  1,259 |             242 |      163 |                169 |              398 |
| 60 s     |        4 |           6,000,000 |  7,219 |           1,785 |    1,378 |              1,455 |            1,411 |

Repeating the identical full-plot request hits the envelope cache: 0.6–2.6 ms.
That is not representative of panning into a new interval. Creating a lazy
smoothing or scale operation costs approximately 0.6–1.6 ms; actually evaluating
a 101-sample moving average over six million samples takes about 0.47–0.49 s.
Adding a scale stage increases that to about 0.51–0.53 s. These derived timings
are for one channel, even in the four-channel cases.

The renderer's 20 ms heartbeat had a maximum observed gap of 22.1 ms during
timed operations. Cancellation acknowledgements were at most 5 ms in these runs.
The worker keeps the renderer available, but long worker responses still delay
the requested plot or measurement. Neither heartbeat nor cancellation timings
establish smooth dragging in the complete UI.

| Duration | Channels |  CSV size | Raw Float64 storage payload | Peak sampled process working sets |
| -------- | -------: | --------: | --------------------------: | --------------------------------: |
| 1 s      |        1 |   1.7 MiB |                     1.5 MiB |                           530 MiB |
| 10 s     |        1 |  16.7 MiB |                    15.3 MiB |                           634 MiB |
| 60 s     |        1 | 104.9 MiB |                    91.6 MiB |                           694 MiB |
| 10 s     |        4 |  43.9 MiB |                    38.1 MiB |                           722 MiB |
| 60 s     |        4 | 268.0 MiB |                   228.9 MiB |                           717 MiB |

Storage payload includes one shared Float64 timestamp column. It excludes
IndexedDB overhead and history. Memory is the maximum sum of this benchmark
application's process working sets sampled every 100 ms. It includes Electron,
GPU, fixture-generation allocations and the harness, can double-count shared
pages, and is not an isolated measurement of worker heap or a memory ceiling.

## Bottlenecks and proposals

### 1. Read only the requested interval for plots and measurements

`SignalEngine.plot()` calls `evaluate(id)` without passing the viewport.
The `measure-plot` worker handler likewise evaluates the entire signal even for
two nearby cursors. `raw()` already has chunk time bounds and optional range
skipping, but these inspection paths do not use it. Four displayed channels are
processed sequentially, multiplying the unnecessary reads.

Start with raw signals: select intersecting chunks, include the neighboring
samples needed for drawing and nearest-cursor lookup, and calculate statistics
only over exact samples inside the requested interval. This should make small
viewport cost depend on the selected interval rather than the full recording.
The expected improvement has not yet been benchmarked or implemented.

Then propagate intervals through crops, time transforms and stateless arithmetic.
Stateful filters require preceding samples or saved state: a rolling mean needs
its history, an IIR filter and integral need correct prior state, and centered FIR
filtering needs both margins. Simply starting every derived evaluation at the
viewport would change results. Preserve display-time offsets, shared time grids,
missing samples, inclusive/exclusive endpoints and context-point statistics rules.

### 2. Replace timer-based cooperative yielding

The raw reader yields using `setTimeout(resolve, 0)` every 16,384 samples; the
iterative executor and time executor also use this pattern. When reads hit the
16 MiB column cache, repeated timer tasks incur browser timer clamping. The
[HTML timer specification](https://html.spec.whatwg.org/multipage/timers.html)
describes the minimum delay for nested timers. This explains the counterintuitive
slowdown in the cached 10-second, one-channel case.

A diagnostic variant replaced the three zero-delay promise expressions **only
in the worker response served by the benchmark**, using `scheduler.yield()`.
Application source and the production bundle on disk were unchanged. It passed
the same sample-count, cursor, scalar and cancellation checks for two runs each
of 10 s × 1 channel and 60 s × 4 channels.

| Case / operation                     | Baseline | Scheduling diagnostic |
| ------------------------------------ | -------: | --------------------: |
| 10 s × 1 channel: new zoom           |   283 ms |                 14 ms |
| 10 s × 1 channel: cursor measurement |   283 ms |                 14 ms |
| 10 s × 1 channel: mean calculation   |   289 ms |                 18 ms |
| 60 s × 4 channels: new zoom          |   1.38 s |                1.38 s |

This is a measured roughly 20-fold improvement for the cached small-window
case, not a general 20-fold engine speedup. The unchanged larger-case timings
point to full scans and storage access as the next bottleneck. A production
implementation should share a yield helper, detect
API availability, provide a fallback and preserve cancellation delivery. A
time budget could avoid yielding after every cheap chunk. Test active and queued
cancellation in the native and browser workers before adopting it. Chrome's
[scheduler.yield guidance](https://developer.chrome.com/blog/use-scheduler-yield)
explains the scheduling API.

### 3. Store a multiresolution plot envelope

Build a persistent min/max hierarchy while importing immutable raw columns.
Use an appropriate level for the visible pixel width and refine partial boundary
blocks from original samples. Cache derived envelopes by immutable signal recipe
and revision, with bounded eviction. This targets full-recording overviews and
repeated pan/zoom across large files.

Envelopes are display data. Exact cursor values, region statistics and sample
exports must continue to read original/evaluated samples. Preserve narrow spikes
and missing-data gaps. Budget index storage and include index recovery; do not
make partial index publication look like a completed import.

### 4. Address large-recording delivery and rate limits

- Samples CSV is capped at 64 MiB and workspace archives at 128 MiB of serialized
  output. These limits are independent of import capacity. Large imported files
  can therefore exceed available delivery paths. Stream exports and archives to
  disk with bounded buffers, atomic completion and cancellation before increasing
  limits. The baseline benchmark does not time export or archive creation.
- Both the unary resampling operation and uniform comparison grids currently cap
  output rate at 10,000 Hz. Importing 100 kHz works, but constructing a uniform
  100 kHz output grid is rejected. Replace a blanket rate cap with explicit output
  sample/resource budgets if maintaining 100 kHz through these operations is
  required. Verify timestamp precision and filtering behavior.
- The 1 kHz trigger fixture reaches the existing 1,000-segment preview limit in
  recordings longer than a second. Those runs record the explicit limit error;
  their short trigger timings are early rejection, not full successful segmentation.
  For cycle-by-cycle work, design bounded event/segment batches and a compact
  inspection UI before lifting the guardrail.

A native binary storage/import path may be useful for substantially larger
recordings. The present evidence does not justify starting with a wholesale
storage rewrite: interval reads and cooperative scheduling are more focused
first changes. Multi-gigabyte files, longer recordings, dense cross-file math,
alignment/resampling and full UI frame timing remain unmeasured.

## Reproduction and validation

Run from the repository root with the pinned dependencies and installed Electron:

```powershell
pnpm desktop:build
pnpm exec electron tests/high-rate-benchmark.mjs
```

To reproduce the isolated scheduling experiment:

```powershell
$env:BENCH_CASES = '10x1,60x4'
$env:BENCH_YIELD = 'scheduler'
pnpm exec electron tests/high-rate-benchmark.mjs
Remove-Item Env:BENCH_CASES, Env:BENCH_YIELD
```

The baseline writes `outputs/high-rate-benchmark/results.json`; the diagnostic
writes `outputs/high-rate-benchmark-scheduler/results.json`. Both include per-run
measurements and environment metadata. CSV fixtures remain in those ignored
directories, and Electron profiles use temporary directories. `BENCH_REPEATS`
defaults to 2; supported cases are 1–60 whole seconds and 1–4 channels. The
diagnostic deliberately checks the expected bundle pattern before replacing it.

On this host, the `pnpm exec` wrapper failed to locate local executables, so the
equivalent `node node_modules/electron/cli.js tests/high-rate-benchmark.mjs` was
used. Electron required execution outside the filesystem sandbox.

Validation: all ten baseline runs and four diagnostic runs completed; 125 existing
tests and TypeScript passed; the desktop production build passed. The benchmark
passes scoped lint and formatting checks. Full-repository lint reports the same
19 documented starter-component/mobile-hook issues. No application behavior or
dependencies were changed by this assessment.
