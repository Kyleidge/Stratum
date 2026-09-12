# Engineering workspace UI review

Branch: `codex/engineering-workspace-ui`. Prepared for review; no merge or hosted
deployment is part of this change.

The active browser and Electron workspace shared a website-like arrangement:
large section headings, inset plot cards, vertically stacked command tiles,
repeated explanatory text, and 48-pixel history rows. The revision uses compact
command bars, a chronological navigator, a working document and a properties
pane. The broad references are the data portal and plot organization in
[NI DIAdem](https://www.ni.com/en/shop/data-acquisition-and-control/application-software-for-data-acquisition-and-control-category/what-is-diadem/free-trial.html)
and the outline, details and graphics panes in
[Ansys Mechanical](https://ansyshelp.ansys.com/public/Views/Secured/corp/v252/en/wb_sim/ds_Window.html).

| Surface reviewed               | Change                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application shell              | Smaller product identity, system UI typography, neutral surfaces, blue command and selection accents, restrained borders and corners.                                                                                                                                                                |
| Commands                       | Derive, Segment, Value and Compare share a horizontal bar. Processing scope remains explicit and independent of inspection. Infrequent commands retain the labeled inspection menu and context menus.                                                                                                |
| History                        | 28-pixel rows replace 48-pixel rows. Operation names and counts share one line; output names and units share another row. Type and parent information remain accessible without repeated visible subtitles. Virtualization, numbering, membership and keyboard navigation are preserved.             |
| Plot document                  | Removed the extra scratchpad heading, LIVE badge and persistent selection tutorial. New plot shares the tab bar. Plots use available window height, with SVG geometry and pointer coordinates measured together. Axis ticks adapt to chart size.                                                     |
| Properties                     | A compact property grid exposes the selected output's type, producing operation, revision, time reference, evaluated time range, direct inputs and source recordings. Source provenance includes every original ancestor. Long input/source lists have bounded previews and access to the full list. |
| Output and sample tables       | Smaller headings, controls and cell padding; restrained alternating rows. Export shares the output heading. Exact samples, missing values, explicit checked scope and pagination remain intact.                                                                                                      |
| Derived functions and values   | Compact function choices and parameter forms replace large tiles. Formulas remain legible, controls retain labels, primary actions use ordinary compact buttons. Numerical definitions remain available.                                                                                             |
| Segmentation                   | Tighter paired boundary controls, scope and preview sections. The empty preview prompt is suppressed; actual results, clipping, exclusions and errors remain visible.                                                                                                                                |
| Compare and align              | Compact input and alignment groups, a wider usable dialog, readable chart labels and a single trace legend. Time-reference warnings and operation settings remain intact.                                                                                                                            |
| Export, storage and management | Compact dialogs, explicit scope and filename review, normal-sized actions, and a dim overlay without background blur. Confirmation, cancellation and recovery behavior is preserved.                                                                                                                 |
| Empty and status states        | Empty scope text no longer asks the user to clear nonexistent filters. Status reports readiness and saving without repeating the inventory and processing count.                                                                                                                                     |
| Smaller windows                | Below the wide desktop breakpoint, properties follow the document. On narrow screens the history can be toggled, commands wrap, and dialogs scroll within the viewport.                                                                                                                              |

The active workflow surface is the scope of this review. Retained legacy region
and signal workbenches are compatibility code, not extra navigation destinations.
No packages, processing algorithms, storage formats, export scope semantics or
workspace data were changed.

## Review evidence

- Visual checks cover a populated desktop workspace, compact desktop and narrow
  browser layouts, function/value choices, segmentation, comparison, output
  tables, and export/storage dialogs.
- The native UI suite covers keyboard and context menus, drag and drop, checked
  scope, nested segments, scalar outputs, large batches, editing and deletion,
  Undo/Redo, archive restore and actual downloads. Its resize checks also verify
  chart geometry and axis-label placement at two window sizes.
- The numerical suite contains 116 passing tests. TypeScript and lint on changed
  application files pass. Full-repository lint retains the 19 documented starter
  issues. Browser and desktop production builds compile.
- The compiled desktop renderer was also inspected through a local HTTP preview.
  The vinext development root did not respond in this environment; this review
  does not claim that its development-server route was verified.
- Review images are generated locally under ignored `outputs/`; they are not
  committed build artifacts. The Git branch is the reviewable deliverable.
