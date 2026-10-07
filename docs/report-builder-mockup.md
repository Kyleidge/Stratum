# Report builder mockup

The main application includes a freeform report canvas connected to Data
Inspector. Reports capture workspace signals, calculated values and saved plots,
alongside editable text, images and tables. Report edits do not change signal
data, calculations or workflow history.

The draft is saved on this device: shortly after each edit it is written to its
own IndexedDB database (`stratum-report-drafts`, `lib/report-draft-store.ts`),
separate from the signal engine's storage and not part of workspace backups.
Reopening the application restores it. The header shows **Saved on this
device**, **Saving on this device…** or, when the browser refuses the write,
**Not saved: this device’s storage is unavailable**. A draft saved by a newer
Stratum is kept unchanged: the header shows **Not saved: the saved draft is
from a newer Stratum** and edits are not saved. In a browser, leaving the
page while a save is pending or has failed asks for confirmation; the desktop
app starts the pending write instead, because Electron would silently keep the
window open. Report Undo/Redo stays session-only (40 edits). The standalone
`/report-mockup` preview never saves.

## Open it

- Main application: run `pnpm dev` or `pnpm desktop`, then choose **Reports**
  beside **Data Inspector** in the top bar. Ctrl+K also offers **Open Reports**.
- Choose **Data Inspector** to return to your signals. Switching workspaces
  preserves the report, its undo history, the inspected item and checked inputs.
  Reports hides the signal tools; the theme and guide buttons stay available.
- **Add to report** in the top bar captures the viewed output or step. Drop a
  different history item onto it to capture that item without changing the
  inspected item or checked processing inputs. The same action is in a History
  item's context menu, the Outputs dock and Ctrl+K. Data Inspector stays shown;
  a notification offers **Open Reports**.
- **Export data…** is separate: it downloads exact CSV files or a quick HTML
  summary and does not touch the report.
- **Apply to** opens the checked-input review; choose **Add checked signals to
  report** to capture that explicit processing scope.
- Use the report button beside a plot's Export menu to capture its displayed
  panels. Saved plots also appear in the report's workspace library.
- Within Reports, search the workspace library and drag signals, values or saved
  plots onto a page, or add the selected library items. Dragging a history item
  over the top bar's **Reports** button opens the canvas for a direct drop.
- While Reports is shown, Ctrl+Z, Ctrl+Shift+Z/Ctrl+Y and Ctrl+D act on the
  report only; workflow Undo/Redo and Ctrl+K are inactive until you return.

Workspace captures are immutable report snapshots. Changes to a signal's
operation or a saved plot do not silently alter existing report blocks. Each new
capture records the library assets it came from and an identity of its data:
the outputs, every contributing step revision, the original recordings and the
value results. When that identity no longer matches the workspace, the block
shows **Data changed** on the canvas (never in the PDF), its Workspace snapshot
section says **Data changed since capture**, and the status bar counts the
out-of-date snapshots. **Update snapshot** (or **Update all**) captures the data
again and replaces only the block's data, keeping its position, size, title and
formatting; it is one undoable report edit. Nothing updates automatically. Undo
in Data Inspector restores the earlier revision, so the capture becomes current
again. Outputs that were deleted show **Data removed**. Captures without a
recorded identity show no state. Signal and plot captures use the
engine's bounded drawing data, retaining the current time axis and visible plot
settings. Calculated-value tables use stored scalar results, including missing
values, rather than deriving measurements from plot envelopes. They show values
in the Data Inspector value tiles' format (`lib/report-format.ts`: grouped digits,
three decimals, four significant digits for tiny or huge magnitudes); exact
values stay in the Values CSV export. Capturing one
output includes only that output; capturing an operation includes its explicit
output membership. All capture and PDF rendering stays on the device.

Plot snapshots follow the plot workspace: overlays split different units into
lanes on one time axis, **Y axes** draws independent scales in one chart, and
stacked plots or separate clocks give each trace its own panel. Values keep
their direct labels, such as `avg 12.3`. Snapshots use the current light or
dark theme, and their frame takes the plot's surface color. The editor follows
the application theme; report paper keeps its own document colors.

An independent synthetic preview is still available for design review:

- Browser: run `pnpm dev`, then open `/report-mockup`.
- Native app: run `pnpm desktop:report-mockup`. This builds the renderer and
  opens `--report-mockup` in a temporary profile, isolated from saved workspaces.
- When using the desktop renderer's Vite server, open `/?report-mockup=1`.

The standalone preview starts with a composed motor-test report and never reads
or writes the engine or saved workspace. The integrated Reports workspace starts
blank. In either version, choose **New blank report** to start with an empty
page, then drag plots, text, images, or tables
from the content library onto the page. Blocks can be moved, resized, and
formatted through the inspector. Uploaded images stay on the device.

## Templates and page designs

The **Templates** tab offers four page designs: **Classic** (double-rule border,
serif type), **Drawing sheet** (zoned engineering border with a title block),
**Banner** (a colour band with modern type) and **Sidebar** (an accent stripe).
Choosing a template for an empty draft starts a new draft with that design and
an editable title page: eyebrow, title, subtitle, prepared by/date/reference
details, and Summary and Results headings. It keeps the current paper size and
orientation, and a title you already typed. When the draft already has blocks,
the editor asks first: **Apply design only** keeps the content and changes the
border and header, and **Start over with this template** replaces the draft.
Undo restores the previous draft. A blank report's
canvas also offers **Browse templates**.

To restyle an existing report without replacing its content, choose a design
under **Page design** in the Templates tab or Page settings, and an accent
colour. The editor reports blocks that reach into the new border, header or
footer and offers **Move inside**, which moves (and if necessary shrinks) only
those blocks into the clear area as one undoable edit; it never moves them on
its own. A design is drawn behind every page's blocks and
cannot be selected. It repeats the report title and page numbers (the Banner
and Sidebar title pages leave the title to the page itself), so renaming the
report updates every page. Starter text uses neutral ink so it stays legible
when the design or accent changes. New blocks, captured data and overflow pages
are placed inside the design's clear area.

The canvas, page previews and PDF export draw the same artwork
(`components/report-frame.tsx`); `lib/report-templates.ts` holds the designs,
their clear areas and starter pages. Saved workflow report templates keep the
design as `frame: { style, accent }`, so batch reports share it.

## Pages and paper

The canvas supports multiple pages, A4 or Letter paper, and portrait or landscape
orientation. The report's page dimensions and block positions are shared by the
canvas and PDF renderer. The standalone preview's plots and values remain
illustrative; the main application's workspace library captures real results.

## PDF export

**Export PDF** creates an actual multipage `.pdf` download entirely on the
client. The file is named after the report title; an untitled report is named
after the recordings it captures and the date, such as
`SN-24001 · report · 2026-10-06.pdf`. Each page uses the same SVG content as the editor, rasterized at 192 dpi
for the standard paper sizes and embedded as a high-quality JPEG. Page size,
orientation, background, formatting, and block order are retained. Individual
raster canvases are capped at 16 million pixels and released after encoding.

This mockup's PDF pages are raster images. Text is not searchable or selectable;
plots and tables are not vector graphics or accessible tagged PDF content. A
production exporter could preserve text and vector content while keeping this
shared page representation. Nothing is uploaded, no report service is used,
and export does not open the browser's print dialog.

## Review and validation

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and
`pnpm desktop:build` after changing the prototype. The integrated report workspace
also needs coverage against real signals, saved plots and calculated values.

After the desktop build, `pnpm desktop:report-smoke` checks native move/resize
and undo, asset drops, local image uploads, text and table formatting, keyboard
deletion, multiple pages, preview, and actual PDF downloads in a hidden window
with temporary storage. It writes review artifacts under ignored `outputs/`.
Full repository lint retains the documented 19 starter-component issues; the
report builder files pass scoped lint.

`pnpm desktop:report-workspace-smoke` checks the integrated main application
with a real example workflow, top-bar captures, library assets, workspace
switching, the shared light/dark theme, report-only keyboard Undo, formatting
and PDF export. `pnpm desktop:report-plot-smoke` checks saved plot capture with
separate clocks, elapsed offsets, hidden traces, unit lanes, independent Y axes,
axis settings, annotations, value labels, scalar traces, cancellation and
capture limits. `pnpm desktop:ui-smoke` checks that the top bar keeps the
report action beside the operations. `pnpm test` includes engine-backed source
membership and provenance tests.

Blocks inserted from Insert or the toolbar go below the page's last block, as
captures do, continuing on a new page when the page is full. In Reports, the
**Plot** insert opens the Data library on signals and saved plots. **Add
selected** clears the library's check boxes once the items are added.

## Batch item reports

**Report** on a batch item opens that item's rendered report as a read-only
preview beside the draft, which stays unchanged. **Back to batch** returns to the
batch results, **Close preview** returns to the draft, **Export PDF** exports the
previewed report, and **Edit as draft…** replaces the draft with it, asking
first when the draft has blocks (Undo restores it).

Insert up to 30 library assets together. Value batches are limited to 330
results per insertion and split into tables of 11 results each, with repeated
headers. Larger batches should be selected in smaller groups. Saved plots
support up to 30 visible traces and 8 MiB per capture. Signal plots remain
editable in the report. Saved plot styling is captured as an SVG snapshot;
change its traces and axes in Data Inspector and insert it again. Source value
cells are read-only, with editable titles and table formatting. Content that
does not fit below the current page's blocks is added to new pages automatically.

Use the bottom-right handle to resize a selected block, or its exact Width and
Height fields. Arrow keys nudge a selected block by 1 px (Shift: 10 px).
Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes, Ctrl/Cmd+D duplicates, and Delete
removes the selected block. Escape cancels an active drag. The history retains
40 edits for this session; the draft itself is saved on the device. All report changes, including a new blank report,
can be undone. Image uploads accept PNG, JPEG, and WebP files up to 6 MiB and
24 million pixels.

For a focused manual review:

1. In the main app, import a recording or open the example workflow. Add a viewed
   signal and a whole values operation to a report. Check a different set of
   signals, add those from the checked-input dialog, and confirm neither capture
   changes the inspected item or checked scope. Format a saved plot, capture it,
   and verify its visible traces, axes and annotations. Switch workspaces, make
   an engine change and confirm earlier report snapshots remain unchanged.
2. Open the example, create a blank report, and add each block type. Move and
   resize blocks; change their content and formatting. Verify that the inspector
   reflects the selected block and that the preview matches the settings.
3. Upload a local PNG or JPEG. Check image fitting, borders, and opacity,
   then confirm the image appears in the exported PDF without network access.
4. Build a report with at least two pages, with visibly different text and
   content on each. Export it, reopen the `.pdf` in a PDF viewer, and verify
   both pages, their order, and correspondence with the canvas. Check accented
   text, symbols, and chart/table labels for correct rendering.
5. Repeat in landscape and Letter formats. Verify PDF page dimensions,
   block positioning, and absence of clipping at page edges. Zoom the PDF to
   inspect legibility at the export's raster resolution.
6. Launch the native mockup alongside the normal app and verify that exporting
   downloads a `.pdf`, closing the mockup leaves the saved workspace unchanged,
   and reopening the mockup starts a new draft.
7. In the main app, add snapshots, reload, and confirm the draft returns. Edit a
   step a snapshot depends on and confirm **Data changed** appears without the
   block changing; choose **Update snapshot**, then Undo.

Relevant implementation files are `components/report-builder-mockup.tsx`,
`components/report-content.tsx`, `lib/report-mockup.ts`, `lib/report-data.ts`,
`lib/report-plot.tsx`, `lib/report-integration.ts`, `lib/report-pdf.ts`,
`lib/report-draft-store.ts`, `lib/report-format.ts`, and
`app/report-builder-mockup.css`. `app/report-mockup/page.tsx` and the desktop
`report-mockup` entry point expose the prototype independently of the workspace.
