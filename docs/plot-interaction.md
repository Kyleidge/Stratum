# Plot interaction performance

What a user notices when panning and zooming a long, high-rate recording: how
smoothly the plot moves, and how long it shows placeholder data before the
real envelope arrives. Measured 6 October 2026.

## Summary

For a 15-minute, 100 kHz channel (90 million samples), the plot thread already
stayed at 60 frames per second, but the data behind it took seconds. The plot
index was only built for recordings up to about 54 million channel samples, so
every new window streamed raw samples. Two changes fix it:

- **Packed plot index (format v2).** Blocks are 13 doubles in a `Float64Array`
  instead of objects, about a third of the old per-block budget. The build
  budget is now 2.6 billion channel samples, so this recording is indexed at
  import.
  Workspaces with the old format rebuild it on their first full plot and
  delete the stale entries.
- **No coarse flash while a moved view loads.** When a pan or arrow-key step
  passes the loaded detail, the plot keeps that detail where it reaches and
  uses overview points only beyond it. Before, the whole view fell back to the
  full-recording overview, which is nearly empty at 1 s or 10 ms zoom.

| 15 min × 100 kHz, one channel          | Before |  After |
| -------------------------------------- | -----: | -----: |
| Open workspace → overview drawn        | 12.9 s | 0.59 s |
| Wheel zoom from full view: data ready  |  8.8 s |  87 ms |
| Zoom back out to full: data ready      | 10.5 s |   5 ms |
| Drag pan (56 s window): data refresh   | 1.66 s |  13 ms |
| Arrow-key pan (56 s window): refresh   | 1.41 s |  11 ms |
| Drag the full view: data ready         | 14.1 s |  60 ms |
| Fewest on-screen points, 1 s drag      |      4 |  1,298 |
| Fewest on-screen points, 10 ms drag    |      2 |    676 |
| Frames slower than 34 ms, any scenario |      0 |      0 |
| Import (CSV 1.65 GB)                   |   79 s |   83 s |

"Data ready" is the time from the last input until the plot loader is idle.
It includes the loader's deliberate 80–100 ms throttles. Worker
round trips for the same requests fell from 0.6–10.8 s to 2–44 ms. Before
the change, a 1 s window was already fast (exact reads), but its drag still
flashed to near-empty overview data.

A workspace imported before this change drew its first overview in 14.4 s
while rebuilding the index. After that, it matched the "After" column.

## Method

- Production desktop renderer (`pnpm desktop:build`) served over HTTP to
  Playwright's headless Chromium 1243. Isolated profile with disk-backed
  IndexedDB. Linux, 6 logical CPUs, 15 GiB RAM, software rendering.
- Deterministic one-channel 100 kHz CSV: a 50 Hz carrier, 0.05 Hz amplitude
  modulation, noise and rare spikes. It is imported through the actual file
  input.
- Real (trusted) mouse wheel, drag and key input. A drag is 60 moves at
  ~16 ms; "long" drags are three 45-move sweeps; wheel bursts are 6–16
  notches 40 ms apart; arrow-key pans are 10 presses 60 ms apart. Windows are
  set with the `+` key to 56 s, 0.88 s and 6.9 ms.
- Per scenario: `requestAnimationFrame` intervals and Long Tasks during the
  input; every `view` worker round trip; settle time after the last input. Every
  third frame also counts the drawn line vertices inside the plot area. Full
  detail draws about 1,400–2,800, and the panning buffer about 700. Fewer than
  400 at a coarse zoom means overview placeholders are on screen. At sample
  level (tens of samples visible) a low count is just the real samples.
- The probes were validated: a deliberate 120 ms main-thread block appeared as
  a 117 ms frame gap and a 120 ms long task.
- One run per build. "Before" is the unchanged `main` build (e10040f) on the
  same imported workspace, and "After" is a fresh import. The "Before" import
  time and a matching set of interaction numbers come from the previous
  revision's build (036a5bc). Headless frame timing covers
  the main thread, not GPU rasterization on the user's display.

## Reproduce

```sh
pnpm desktop:build
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  node tests/plot-interaction-benchmark.mjs
```

Playwright is not a project dependency. `BENCH_SECONDS` (default 900) sets the
recording length. `BENCH_LABEL` names the output file. `BENCH_PROFILE` reuses a
browser profile and skips the import. The CSV fixture and JSON results go to the
ignored `outputs/plot-interaction-benchmark/` directory. Expect around 1.7 GB for the
CSV, 1.3 GB of browser storage and roughly 80 s of import.

## Not covered

Derived signals with stateful filters still evaluate their complete input
history for each new window (see [high-rate implementation](high-rate-implementation.md)).
A moving average over 90 million samples takes seconds per view. Raw
recordings and stateless chains are fast. Exact cursor and region measurements
still read every sample in their interval by design. Multi-channel overlays
issue one request with every trace, so their cost scales with the visible trace count.
