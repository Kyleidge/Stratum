# Stratus

A desktop workbench for immutable measurement signals and traceable time-series
analysis. The included synthetic dyno recording contains three engine ramps.
Its segments, brake power, fuel use, and specific fuel consumption are calculated
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

1. Open **Full recording** to view the three synchronized channels and ramps.
2. Select any raw signal in **Signal Explorer** to inspect it.
3. Select **Segment** and choose **Signal edge triggers**. Choose a start signal,
   rising/falling edge, threshold, and offset, then configure the end independently.
   For example: speed rising above 900 rpm with a −20 s start offset, followed by
   speed falling below 900 rpm. **Preview** shows intervals and clipping before
   **Create segments** saves immutable crop branches. Manual time ranges and
   fixed-duration windows are also available. Raw and derived signals are valid
   trigger inputs and output targets.
4. Follow numbered steps in **Signal Explorer**: raw → filter → segment → moving
   average → Min / Max. Select a collection row to apply the next operation
   independently to every member. Expand it to inspect members or select just
   one to create its own branch. Shared steps stay visible once; segments are
   never concatenated. Creating segments automatically selects their collection.
   Repeating a function from an earlier step creates a separate branch.
5. Use **Compare segments** for a time-aligned overlay, **Data table** for samples,
   and **Operation history** for the selected signal's complete history and
   linked inputs. Arrow keys navigate the explorer; its toolbar can reveal the
   selection or collapse other branches.
6. **Power & fuel metrics** explicitly adds engineering calculations to compatible
   segments. The demo already includes this calculation step. **Export results**
   downloads summary statistics and parent IDs as CSV.

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

See [architecture and limitations](docs/architecture.md) for the processing model,
units, algorithm details, and path toward multi-gigabyte workloads. This is an
initial functional prototype, not a complete NI DIAdem replacement.
