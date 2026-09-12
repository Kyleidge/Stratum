# High-rate performance implementation

Branch: `codex/high-rate-performance`.

This implements interval-aware reads, cooperative worker scheduling and persisted
raw-signal plot summaries. No UI components, styling, controls, worker request
shapes, export formats, resampling limits or export-size limits change.

## Measured results

Measured on 12 September 2026 on the same Ryzen 7 7800X3D / Electron 44.2.0
machine as the baseline. All ten runs completed. Values are milliseconds;
import and first-plot columns are medians of two runs, while zoom and cursor
columns are medians of six requests across those runs.

| Duration | Channels | Import | First full plot | New zoom | Cursor measurement |
| -------- | -------: | -----: | --------------: | -------: | -----------------: |
| 1 s      |        1 |     84 |            12.1 |      2.6 |                1.0 |
| 10 s     |        1 |    622 |            14.9 |      1.9 |                2.4 |
| 60 s     |        1 |  3,581 |             6.1 |      1.6 |                1.4 |
| 10 s     |        4 |  1,270 |            57.2 |      6.7 |                3.5 |
| 60 s     |        4 |  7,441 |            18.1 |      5.4 |                3.3 |

For 60 seconds with four channels (24 million channel samples):

| Operation                                  | Original | Implemented |
| ------------------------------------------ | -------: | ----------: |
| First overview after restarting the worker | 1,785 ms |     18.1 ms |
| New 10 ms zoom                             | 1,378 ms |      5.4 ms |
| Exact 10 ms cursor measurement             | 1,455 ms |      3.3 ms |
| Import                                     |   7.22 s |      7.44 s |

The first zoom into uncached sample chunks took 13.6 ms for four channels;
subsequent nearby zooms took 4.1–5.5 ms. The median includes both states. Coarser
hierarchy levels explain why a 60-second overview can be faster than a 10-second
overview: the selected display level, rather than just total sample count,
determines the number of summaries visited.

Exact full-recording mean calculation still took 1.36 s for the four-channel
60-second case. One channel's 101-sample moving-average plot took approximately
0.49 s, and a new filtered viewport took 0.34 s; these still scan required filter
history. These changes target raw/stateless interaction and raw overviews, not a
universal speedup of every derived computation.

All eight million-sample-or-larger cancellation cases cancelled the active derived
request and successfully completed an already queued inspection. The two smallest
cases finished before cancellation arrived. Maximum cancellation acknowledgement
was 9 ms, and the renderer's 20 ms heartbeat had a maximum observed gap of 22.3 ms.
Peak sampled aggregate process working sets were approximately 373–560 MiB,
including the harness and Electron; they are not an isolated worker-memory figure.

Measured worker SHA-256:
`1c4de38c9caf8007e40237b3bf20962a5b8d522710952f1cd599bd2df04e422e`.
The build included this implementation over parent revision `98e28ee`; its result
file correctly records that the source changes were uncommitted during measurement.

## Changes

- Raw reads binary-search chunk time bounds and include neighboring chunks for
  exact cursor lookup and plot context. Stateless unary operations, crop operations,
  time shifts, zero-time transforms and explicit time alignment propagate the
  requested interval into their input reads.
- Stateful filters, derivatives, integrals, reductions, resampling and binary
  grids retain their complete required input history. This preserves their existing
  numerical behavior. Filter checkpointing and persistent derived-sample caches
  are not part of this change; uncached filtered inspection can still require a
  full recording pass.
- The worker uses a shared `scheduler.yield()` helper with a timer fallback.
  Yielding still creates a real task boundary, allowing cancellation and queued
  requests to proceed. There is no microtask-only busy loop.
- Import builds per-channel summaries in 256-sample leaves and groups of 16.
  Coarser levels summarize 4,096 samples and above. Queries choose a level suited
  to the displayed time span, refine partial boundary blocks from original data
  and retain actual first/last/min/max/gap sample coordinates. The renderer still
  receives the same bounded envelope format. At overview resolution, the set of
  drawing candidates can differ from the previous pixel-bucket scan.
- Plot summary counts, extrema, domain and integrals account for the original
  samples, including gaps. Summation grouping can differ at floating-point
  roundoff scale; tests compare sums/integrals within relative tolerance. Exact
  cursor and region measurements and all sample exports still evaluate samples,
  never display points. Extremely large amplitudes and unusable index metadata
  fall back to the original streaming path.

## Storage and recovery

The index is disposable metadata beside the source's original chunks, with a
versioned namespace. It does not change the IndexedDB schema or archive format.
Import writes each leaf index with its raw chunk and publishes the index root
after the leaves. An abandoned import is recovered using the existing source
ownership rules, including its index data. Undo/Redo retain indexes alongside
their original source columns.

The index read cache is capped at 8 MiB using conservative object accounting.
Root construction stops when its base-block accounting exceeds 4 MiB; those
recordings continue through the streaming path. Import accounts all channels
together; later rebuilds account one channel at a time. This keeps index
construction bounded rather than allowing unbounded auxiliary memory growth.
Index disk storage grows with imported samples and counts against browser quota.

Older and restored recordings use bounded interval reads immediately. Their first
full plot also builds a persistent index when within the budget. A missing or
unusable index falls back to raw samples; a failed optional rebuild does not alter
the workspace. Rebuilds never add Undo steps, revise operation history or enter
workspace backups. Import remains atomic if an index/storage write fails.

## Validation

- 130 numerical, workflow, archive and engine tests passed, including new 100 kHz
  cases for chunk boundaries, exact cursor ties, missing samples, timestamp gaps,
  stateless/time transforms, filter history, index recovery and cancellation.
- TypeScript, scoped lint, formatting and both production builds passed.
- Native worker smoke, native UI smoke and HTTP worker smoke passed. Native UI
  coverage includes edit/delete, Undo/Redo, nested segmentation, plotted gestures,
  export downloads and cancelled exports.
- Full-repository lint retains the 19 documented starter-component/mobile-hook
  issues. The changed application and benchmark files pass scoped lint.

## Reproduce

```powershell
pnpm desktop:build
pnpm exec electron tests/high-rate-benchmark.mjs
```

On hosts where `pnpm exec` cannot resolve its local executable, use
`node node_modules/electron/cli.js tests/high-rate-benchmark.mjs` instead. The
benchmark uses a hidden native window and isolated temporary storage. Results
include the worker bundle SHA-256, checkout revision and whether the checkout
contained uncommitted changes when measured.

Use the same machine and the default two repetitions when comparing with the
[original assessment](high-rate-performance.md). Timings include worker/storage
round trips and exclude React/SVG rendering and fixture generation. The OS disk
cache is not flushed. The benchmark also checks a cancelled long derived request
followed by an already queued inspection.
