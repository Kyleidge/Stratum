# Engineering plotting workspace

Implementation branch: `codex/engineering-plot-workspace`.

## Purpose and feature review

Plotting is an inspection workspace for immutable signals and scalar results.
It must remain fast to manipulate, explicit about units and time references,
and trustworthy at measurement boundaries. Plot settings never alter samples
or create processing history. Processing and exports keep their explicit scopes.

The feature inventory follows the direct manipulation and measurement patterns
in [DIAdem's band zoom](https://knowledge.ni.com/KnowledgeArticleDetails?id=kA0VU0000004JyX0AU&l=en-US),
[DIAdem's curve scaling](https://knowledge.ni.com/KnowledgeArticleDetails?id=kA0VU0000000quf0AA),
and [Signal Analyzer's measurements](https://www.mathworks.com/help/signal/ug/measure-signals.html).

| Expectation                 | Design for this implementation                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A useful Active document    | One Active tab contains the current signal/value plot and its operation's outputs. Selecting an operation shows its outputs immediately; selecting a member shows its plot with the output list still accessible below. No duplicate Step outputs tab.                                                                                                                                                                          |
| Persistent comparison plots | Keep, create, duplicate, rename, close and reopen plots. Preserve trace styles, axes, viewport and annotations locally. Existing saved layouts migrate with defaults.                                                                                                                                                                                                                                                           |
| Direct manipulation         | Drag to pan; wheel zoom about the pointer; select Zoom and drag a time band; double-click the plot to add an annotation at the pointer time. Escape cancels a gesture. Keyboard arrows pan, +/− zoom, Home fits and Backspace restores the previous view.                                                                                                                                                                       |
| Predictable navigation      | Toolbar equivalents for every gesture, bounded navigation history, explicit mode and visible selected range. A fit command restores the complete range. Zoom requests a new envelope from evaluated data.                                                                                                                                                                                                                       |
| Axis control                | Automatically name axes from signal names/units; double-click an axis to edit its name and limits. Wheel over an axis zooms it; dragging pans it independently. Add same-unit axes and assign compatible traces. Automatic or fixed Y limits, linear or logarithmic Y scaling, explicit time limits, grid and trace rendering settings. Invalid limits receive inline errors. Log plots exclude non-positive values and say so. |
| Honest comparisons          | Matching time references overlay with automatic unit axes plus optional independently scaled same-unit axes; unrelated clocks remain stacked. Matching time axes share navigation and cursors. Relative-start alignment stays an explicit display setting. Different clocks retain independent ranges.                                                                                                                          |
| Trace manipulation          | Drop history items on a plot or its tab; drop on New plot to create a comparison. Preserve exact existing batch membership. Drag trace rows to reorder; keyboard move controls are also available. Show/hide, isolate, restore all, color, line/point/step style, width and direct source inspection.                                                                                                                           |
| Plot manipulation           | Double-click a tab to rename. Drag saved tabs to reorder, with keyboard alternatives. Duplicate includes settings. Closing is reversible and never removes workflow outputs.                                                                                                                                                                                                                                                    |
| Measurement cursors         | Toggle A/B cursors, click or drag their handles, or enter times. A/B time, Δt, sampled values and Δvalue remain visible in a bounded table. Cursor measurements use actual evaluated samples, including missing values; no preview-point value is presented as an exact measurement.                                                                                                                                            |
| Region statistics           | Compute finite count, min, max, mean, RMS and time integral between cursors, using a cancellable worker read. Preserve missing-data discontinuities and return no result for an empty interval. Scalar results remain reference lines rather than synthetic sampled signals.                                                                                                                                                    |
| Annotations                 | Double-click the plot to add a time annotation; drag its label vertically while retaining its time; double-click its marker to edit or remove it. Notes are plot-local display metadata, bounded in number, and exported with the plot.                                                                                                                                                                                         |
| Delivery                    | Export the rendered plot as SVG or PNG with labels, units, cursors and annotations. Keep evaluated-sample CSV/report exports in their existing explicit workflow scope.                                                                                                                                                                                                                                                         |
| Dense layout                | Compact grouped toolbar, plot canvas, measurement tray and trace list. Output details are a collapsible dock within Active. No repeated instructional banner; gestures live in a concise help dialog and tooltips.                                                                                                                                                                                                              |
| Accessibility and recovery  | Labeled controls, focus rings, keyboard equivalents, visible loading/errors, retry, no mutation during measurement, stale-response protection, missing trace references retained for workflow Undo.                                                                                                                                                                                                                             |
| Large collections           | Preserve up to 10,000 trace references and 12 plots, render bounded trace pages and at most eight stacked panels. Measurement requests cover a page of traces; never create thousands of hidden rows or charts.                                                                                                                                                                                                                 |

## Interaction contracts

1. Inspection remains independent of checked processing inputs. Opening a saved
   plot does not change processing scope. Source links explicitly navigate history.
2. Plot dragging and history dragging are distinct types. Internal reorder never
   imports another trace or changes workflow order. Drops highlight destinations;
   duplicate IDs do not create duplicate traces. Unsupported drags do nothing.
3. Pan and zoom operate in display time. Per-trace source ranges add back any
   relative-start offset before worker evaluation. Shared clocks use the same
   display limits; unrelated clocks do not acquire a false common time reference.
4. Wheel handling is confined to a focused plot or an explicit axis hit region.
   Over a Y axis it zooms that scale; over time ticks it zooms time. Pointer capture
   keeps drags working outside the canvas.
5. Cursor A/B readings choose the nearest evaluated sample, prefer the earlier
   sample on ties, and show cursor time by default. Sample times exposes the
   nearest sample time. Out-of-range cursors return no sample. Missing samples
   stay missing rather than snapping past a gap.
6. Region statistics include samples at both cursor limits. Time integral uses
   adjacent finite samples within the region with positive time intervals; it
   does not bridge gaps or extrapolate clipped boundary samples. RMS and mean
   are sample statistics and are labeled accordingly.
7. Each completed pan/zoom is one navigation-history entry. Pointer movement does
   not create hundreds of entries. Escape restores the view at gesture start.
   Axis drags preserve linear spans or logarithmic ratios. Time may pan beyond
   the data extent; Fit restores it. Annotation drags preview height, commit once
   on release and cancel with Escape or pointer cancellation without changing time.
8. Saved plot settings validate finite ranges, safe colors, bounded text and
   counts. Layout storage is separate from workspace archives, as it is today.

## Engineering capability boundaries

The complete time-series inspection workflow above is the implementation plan.
The wider professional plotting inventory also includes X-Y/phase portraits,
spectra, spectrograms, order maps, polar plots, 3D surfaces, synchronized video,
and live acquisition. Those require explicit paired-sample alignment, transform
definitions, multidimensional records or live-data lifecycle support. They are
separate plot types and processing capabilities, not alternate labels for this
time-axis renderer. This change must not silently manufacture them from
decimated points. Existing derived signals remain plottable through the same
time-series workspace; future plot types can share its tabs, styles and export.

## Implementation sequence

1. Extend and validate plot metadata, including per-plot cursor state; add pure range/navigation and measurement
   helpers. Preserve old storage, normal batch semantics and missing references.
2. Add per-trace viewport evaluation and an independent coalescing measurement
   request lane in the worker. Test exactness, gaps, offsets and cancellation.
3. Extend the shared chart with opt-in gestures, scales, styles, cursor/annotation
   overlays and exports. Retained legacy callers keep their existing defaults.
4. Integrate tools, measurement/axis dialogs, trace/tab actions and unified Active
   outputs. Verify complete workflows, rather than isolated control appearance.
5. Run numerical tests, typechecking, changed-file lint, formatting and both
   builds. Extend native UI smoke for real gestures, limits, measurements,
   persistence, export and the merged Active document. Inspect wide and compact
   native/browser layouts, commit and push the branch, then open the desktop app.

## Acceptance scenarios

- Select a step, inspect a late paginated output, zoom it, and return to its output
  list within Active. Checked inputs are unchanged and there is no outputs tab.
- Drop a segmented batch on a plot, align starts, reorder/hide/isolate traces,
  drag-pan, box zoom, return to the previous range and fit with the toolbar or Home.
- Zoom a narrow interval in a dense recording and recover detail from a fresh
  envelope. Measurements match evaluated samples rather than old plot points.
- Move A/B across a missing-data gap and beyond a trace boundary; verify missing
  readings, sample times, Δt, RMS and non-bridging integral.
- Apply fixed/log axes, reject invalid limits, restore automatic axes, and retain
  settings after close/reopen and reload. Cancelled gestures leave no change.
- Add and edit a note, export SVG/PNG, and verify it contains the actual plotted
  labels without embedding scripts or external assets.
- A large batch retains every member while traces, measurements and stacked
  panels stay bounded. Deleted inputs show unavailable until workflow Undo.

## Implementation and review evidence

The time-series scope above is implemented. Active plots and operation outputs
share one document. Saved plots retain their viewport, trace styling, axes,
annotations, cursor positions and measurement visibility. Output table rows can
also be dragged directly into plots.

- 123 numerical and workflow tests pass, including independent unit axes,
  pointer-anchored logarithmic scaling, streaming measurement gaps,
  earlier-sample ties, cancellation, viewport boundary context and independent
  measurement/plot request coalescing.
- The native UI suite passes pan/box/wheel gestures, Escape cancellation,
  navigation history, independent axis drag, double-click annotations/axis
  editing, invalid and logarithmic limits, same-unit axis assignment,
  cursor/sample times, trace/tab drag reordering, duplication, vertical
  annotation drag with fixed time and verified SVG/PNG downloads, alongside
  the existing full workflow scenarios.
- TypeScript, changed-file lint, formatting, and browser/native production builds
  pass. Full lint retains the 19 documented starter-component issues.
- Visual review covers 1540×940 and 860×820 layouts, including the measurement
  tray and combined Active output dock. A browser reload restores saved A/B
  positions. Browser inspection used the compiled desktop renderer over local
  HTTP; the native suite uses the bundled custom-scheme application.

Plot images contain the currently rendered panels and a bounded trace legend.
Samples CSV remains an evaluated-data export. Measurement reads and zoom
refinement stream existing signals; they do not add an envelope pyramid or claim
constant-time access to arbitrary large recordings.

## Multiple-axis follow-up

Each exact unit gets a stable, independent Y scale on the shared time plot.
Add Y axis creates another independent scale with that unit. Trace properties
offers only compatible axes and can create and assign a new axis in one action.
Axes use stable IDs: automatic axes use unit keys, explicit axes use unique IDs.
Empty custom axes remain available for assignment and can be removed when unused.
Axis dialog changes publish only with Apply; trace properties apply immediately.
The plot retains at most 32 custom axes. Missing or incompatible saved assignments
fall back to the trace's automatic unit axis. No implicit unit conversion occurs.
Signal names and units supply automatic axis names; blank manual names restore
automatic naming. Wheel zoom targets the axis under the pointer, with logarithmic
zoom performed in log space. Axis limits/names persist, survive trace reordering
and duplication, and participate in Previous view. Legacy Y limits apply only
to the first unit. Unrelated clocks still require explicit display alignment.
For unusually large unit collections, each page draws at most eight Y axes;
horizontal scrolling preserves a useful data area without dropping trace membership.

All plot selectors use the application's themed popup, including in dark mode.
Cursor statistics default to cursor time, with actual nearest sample times
available through an explicit toggle and tooltips; values still use exact samples.
Double-clicking the plot opens annotation entry at the pointer's display time;
Fit remains available through the toolbar and Home. Notes retain their time
reference when unrelated clocks are stacked. Vertical label drag changes only a
normalized height, preserved on resize, editing, duplication and reload. The
annotation's time and the plot viewport remain unchanged.

## Continuous panning

The chart retains a full-domain min/max overview for immediate drawing during
gestures. When a pan leaves the detailed viewport, it uses that overview until
a buffered view arrives. The buffer extends half a viewport beyond each edge;
movement within it reuses the same points. New buffer reads run while the pointer
is moving, at most once per 100 ms, with one read in flight and only the latest
pending target. Slow derived evaluations finish instead of being repeatedly
cancelled by pointer events.

The renderer retains at most three envelopes per visible signal: overview,
committed viewport and current buffer. Each uses the existing bounded envelope
(up to 3,502 points including boundary context); only one is drawn per trace.
Overviews may look coarser during a fast pan. Releasing the pointer requests the
exact final viewport and saves one navigation entry. Escape and pointer
cancellation return to the previous view. Buffer points never replace exact
summary, measurement or sample-export data, and elapsed-time offsets are
translated back into each signal's evaluated time before requesting points.

The loader tests exercise rapid input, delayed reads, rate limits, buffer reuse,
missing-data breaks, cancellation and stale responses after disposal. The native
UI regression checks both curve edges throughout an open drag, and verifies that
intermediate positions do not reach persisted plot settings. Full-domain derived
overviews still require their normal initial evaluation; no new throughput claim
is made for large stateful derivations.
