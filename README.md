# Stratus

A desktop workbench for immutable measurement signals and traceable time-series
analysis. The included synthetic dyno recording contains three engine ramps.
Its regions, filters, brake power, and specific fuel consumption are calculated
by the same engine that processes imported recordings.

## Run

Use Node 24 and pnpm 11.19.0 in this local checkout:

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm desktop
```

For a browser preview, run `pnpm dev` and open its printed local URL. The desktop
build uses bundled assets and works offline. Browser and desktop workspaces have
separate local storage.

Create a portable desktop build with `pnpm desktop:package`. On Windows, launch
`build/releases/Stratus-win32-x64/Stratus.exe`. Keep the entire output folder
alongside the executable. Packaging on macOS/Linux produces the corresponding
native bundle. Packages are unsigned development builds.

## Explore

1. Choose **Worked examples** in the left panel: ramp filtering and statistics,
   nested 10-second windows, overlapping windows, or power and fuel consumption.
   These run real calculations. Selecting one again reopens its saved results.
2. **Function history** has one item per invocation. Region sets and calculations
   share a chronological list. Select an item to inspect its saved settings;
   input links let you follow earlier operations. Results stay in a table instead
   of multiplying the tree by every region and channel.
3. Use **Segment** to create reusable time regions. Configure rising/falling
   triggers (including signed offsets), manual ranges, or fixed-duration windows.
   Regions point to recording times and do not create signal copies.
4. To segment a segment, select a region set and choose **Segment within set**,
   or select a row and choose **Segment this region**. Choose all or one parent,
   and use recording times or times relative to each parent start. Each parent is
   scanned independently; child regions are clipped to it or discarded.
5. **Process regions** chooses signals or a result family and explicitly applies
   a function within a region set. Each new function has independent state per
   region. Filtering a whole signal before applying a region retains its earlier
   filter history. Processing scope is separate from the region selected for viewing.
6. Min / Max produces one table row per input and region. Other functions produce
   a signal or result family; the table shows their statistics. **Export results**
   includes region names, versions, boundaries, units, and provenance.
7. Changing a saved region operation creates a new version. Existing children and
   calculations keep their original version. Arbitrary operation depth and nested
   region depth are supported; a creation batch is limited to 1,000 regions or
   10,000 calculated results. Overlapping regions remain independent.

Older workspaces are adapted without deleting or changing signal recipes. Legacy
inclusive endpoints are retained; newly created regions include their start and
exclude their end, except at an inclusive recording/parent endpoint.

Import comma-separated UTF-8 files with time in seconds in the first column.
Use units in square brackets to enable the power and fuel calculation step:

```csv
Time [s],Engine speed [rpm],Torque [Nm],Fuel flow [kg/h]
0.00,1500,210,8.4
0.01,1502,211,8.5
```

Times must be strictly increasing; empty signal cells remain missing. Imports
are processed locally in chunks and saved in IndexedDB. Clearing application
storage deletes that workspace; project backup/interchange is not implemented.

## Validate

```powershell
pnpm test
pnpm test:preview # Requires pnpm dev running on localhost:3000
pnpm typecheck
pnpm lint
pnpm exec oxfmt --check
pnpm build
pnpm desktop:build
pnpm desktop:smoke
```

The test suite exercises numerical results and storage behavior; the native smoke
check runs the worker and IndexedDB inside a hidden Electron window. The original
starter has 19 lint issues in its unused UI primitives and mobile hook. New
application code is checked separately as well.
`signal-functions.test.ts` checks independently calculated values and defaults
for every single-input library function, plus all four persistent examples.
`regions.test.ts` checks nested pointers, version pinning, state boundaries,
family mapping, all new examples, and legacy migration. Legacy explorer
regressions cover keeping
one function item for partial or mixed input batches. The preview integration
also runs every selectable example through the actual HTTP worker module.

See [architecture and limitations](docs/architecture.md) for the processing model,
units, algorithm details, and path toward multi-gigabyte workloads. This is an
initial functional prototype, not a complete NI DIAdem replacement.
