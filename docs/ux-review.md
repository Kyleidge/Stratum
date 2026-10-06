# UX review: findings and implementation plan

A six-part review of the Data Inspector, Reports and batch workflows, done
against the example workflow and the `examples/eol-rig` batch, with screenshots
in headless Chromium at 1920, 1440, 1280×720, 1200 and 800 px wide. Goal:
an inviting, user-friendly application with a clear workflow.

Severity: **P0** blocks or misleads most users, **P1** significant friction,
**P2** polish. IDs are referenced by commits and follow-up work.

## Glossary (one name per concept)

| Concept                                                      | Use                                                                | Avoid                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------- |
| One History entry (an invocation)                            | **step**                                                           | operation, invocation (in UI copy)        |
| Re-open a step's editor to make a new step from its settings | **New version…**                                                   | Duplicate, Repeat with new settings       |
| CSV/HTML download dialog                                     | **Export data…**                                                   | Export / report, Inspect / export         |
| Send a capture to the PDF editor                             | **Add to report**                                                  | Report (as a verb)                        |
| The two workspaces                                           | **Data** · **Reports** (switch label "Data Inspector" in tooltips) | unlabeled icons                           |
| Inputs that Derive/Segment/Value will use                    | **Apply to** (pill), **Input** (table column)                      | Use, processing scope                     |
| The imported file                                            | **recording**; its columns are **original signals**                | originals (alone)                         |
| The demo                                                     | **example recording**                                              | example workflow                          |
| A saved `.stratum.yaml`                                      | **workflow**                                                       | recipe (in UI copy)                       |
| Value step names                                             | describe the result ("Average product per run")                    | "Compare…"                                |
| Right-hand panel                                             | **Details**                                                        | Inspector (ambiguous with Data Inspector) |

Counts always agree in number: use `formatCount` from `lib/format-count.ts`
(`1 signal`, `3 signals`).

## 1. Processing inputs ("Apply to")

- **P0 1.1** Checking a History box while viewing a signal silently adds the
  viewed signal (`workflow-workbench.tsx` "The first check keeps a viewed
  signal"). A check box click starts from an empty set; only Ctrl/Shift+click
  extends from the viewed item.
- **P0 1.2** Outputs table "Use" box is ticked for the viewed item while its
  History box is empty. One state, one look: tick only explicit inputs; show
  the viewed item with an "in view" marker. Rename the column **Input**.
- **P1 1.3** History check boxes are 14 px and hidden until hover. Show them at
  rest (muted), 16 px inside a 24×24 hit area.
- **P1 1.4** Dialogs hide inputs behind "N input signals · review selection".
  Show input chips under the title ("Applies to: Run 1, Run 2, Run 3"); keep a
  collapsible list only beyond ~5 inputs.
- **P2 1.5** Selecting a value silently retargets Apply to its input. Label
  it "… (input of selected value)".
- **P2 1.6** Selection and checked inputs reset on reload. Persist the last
  selection per device.

## 2. First run and onboarding

- **P0 2.1** Empty state: small left-aligned text, the example is a minor link,
  no CSV format, History shows filters for nothing, disabled operations say
  "Drop a signal…". Build a centred welcome: purpose line ("Turn test
  recordings into traceable results"), Import → Process → Measure strip, equal
  cards **Explore the example recording** / **Import a CSV** (show the expected
  format `Time [s],Speed [rpm],…`, accept drag and drop), and a third card
  **Test many recordings** (batch example). Hide History filters while empty;
  disabled operations say "Import a recording first".
- **P0 2.2** The example opens on its least interesting signal with no
  guidance. Add a dismissible Back/Next example tour card that selects each
  step with one sentence about its concept, ending on a value result.
- **P0 2.3** After the first import nothing suggests a next step. While only
  import steps exist, show a "Next: Derive · Segment · Value" strip with one
  plain sentence each. "No later operations use this yet." becomes "Nothing
  uses this yet. Try Derive, Segment or Value."
- **P1 2.4** Every import is called "Import recording". Name the step after
  the file ("Import SN-24001.csv").
- **P1 2.5** CSV errors are vague ("Use unique headers…" for a semicolon
  file) and appear with a **Reload workspace** button. Name the file, the row
  and the cause; detect `;`/tab delimiters and date strings; show a CSV format
  link; show Reload only for engine/storage failures. Warn when headers have no
  units.
- **P1 2.6** The guide is ten dense paragraphs. Use tabs: Getting started,
  Concepts, Shortcuts (Ctrl+K, Ctrl+Z/Y, Ctrl/Shift+click, Enter/F2, arrows),
  Batch. Offer "Start the example tour".
- **P2 2.7** Operation Settings render raw JSON. Render a readable table with
  a "Show raw" disclosure.
- **P2 2.8** `docs/beginners-guide.md` refers to removed labels. Refresh it.

## 3. Operation dialogs

- **P1 3.1** Derive defaults to Multiply (needs Input B), so the preview starts
  empty. Default to the last-used operation, else Moving average.
- **P1 3.2** Category tabs don't change the selected operation; the dialog
  jumps in height. Selecting a tab selects its first operation; fixed palette
  height.
- **P1 3.3** Create stays enabled when the preview reports an error; the error
  then shows a global Reload banner. Disable Create while the preview is
  invalid; group Input B options into compatible and "different time grid —
  use Compare & align".
- **P1 3.4** Segment trigger defaults are threshold 900 and offset −20 s.
  Default to the midpoint of the input's range and offset 0.
- **P1 3.5** Create buttons scroll out of view (Segment at 1280×720). Dialogs
  use header / scrolling body / sticky footer with a one-line result summary
  ("3 segments · 13.6–160.0 s · 0 clipped").
- **P1 3.6** Segment outputs are named "Segment 06 · Smoothed torque × Motor
  speed…" with numbering continued across the recording. Number per step and
  use the parent's display label.
- **P1 3.7** Compare & align defaults to Overlay (no output), lacks the
  settings-beside-preview layout, repeats the recording name on every row and
  uses jargon. Default to Align, match the other dialogs' layout and footer,
  drop repeated prefixes, plain wording; Derive's Math tab links to Compare &
  align for different recordings or grids.
- **P2 3.8** Edit dialog title names the step ("Edit #009 Segment signals");
  impact text names steps ("Saving recalculates #010 Maximum").

## 4. Layout at laptop sizes

- **P0 4.1** Below 1700 px the Data/Reports switch is two unlabeled icons;
  below 1500 px Export is "…"; below 1240 px "Apply to" disappears. Keep the
  workspace switch, Import and the Apply to label always labeled; collapse
  secondary labels first.
- **P1 4.2** The top bar overflows at 1250–1300 px (the scope pill grows with
  names). Fixed-width, truncating recording and Apply to pills; never clip the
  end controls.
- **P1 4.3** Details actions (Edit/New version/Delete) are cut off. Sticky
  action footer.
- **P1 4.4** "Add to report" jumps to Reports. Stay; toast "Added to report ·
  Open Reports" and a count badge on Reports.
- **P2 4.5** Details repeats itself (Type: Operation, self-link). Remove;
  move Checks below Used by. The dock repeats its title and changes height
  between tabs.
- **P2 4.6** Workflow commands are spread over the Import menu and the
  Workspace dialog with different names. One set of labels in the Import menu;
  the Workspace dialog keeps backup and restore.

## 5. Wording and feedback

- **P0 5.1** Delete on a signal opens "Remove this recording?" with "Keep
  operation" / "Delete listed operations". Button names its target; dialog
  buttons "Cancel" / "Remove recording and 6 steps".
- **P1 5.2** Undo says "Undid last change." and loses the selection. Name the
  action in the tooltip and status ("Undid: Edit #009 Segment signals") and
  keep the affected step selected.
- **P1 5.3** Value steps in the example are named "Compare …". Rename.
- **P2 5.4** Plurals ("1 signals", "1 outputs", "1 input signals").
- **P2 5.5** History legend shows "Contributes to the selection · drag outputs
  onto a plot or command" even when empty. Show "● Used to make the selected
  item" only when dots are visible.

## 6. Reports and export

- **P0 6.1** Report drafts are lost on reload with no warning. Persist the
  draft on the device and warn before unload while a save is pending.
- **P0 6.2** Two "report" systems. Rename the CSV/HTML dialog "Export data";
  the HTML option is "Quick HTML summary" with a pointer to Add to report.
- **P1 6.3** Values in reports show raw floats (`272608.4105695499`). Use the
  app's value formatting; exact values stay in CSV.
- **P1 6.4** Choosing a template replaces the draft. When the draft has
  blocks, offer "Apply design only" or "Start over with this template".
- **P1 6.5** Inserted blocks stack at the top-left. Place them below the last
  block, as captures do. The Plot insert opens a picker or the Data library.
- **P1 6.6** No sign a snapshot is out of date. Show "Data changed since
  capture" with an explicit **Update snapshot** (never automatic).
- **P1 6.7** File names (`Stratum-values-3.csv`, `Untitled report.pdf`) say
  nothing. Name exports after recording, step and kind.
- **P1 6.8** Export scope and format are closed selects with technical help.
  Radio cards in plain language; scope shows "Checked (3)".
- **P2 6.9** Library names truncate; boxes stay checked after adding; the
  status bar keeps the empty-state text; ambiguous dates; overlap warning has
  no fix; Reports font sizes bypass the type scale (down to 8 px).

## 7. Batch workflows

- **P0 7.1** No checks = "All checks passed.". Add a neutral **No checks**
  status; the Save dialog says when a workflow has no checks.
- **P0 7.2** Pre-flight names a missing channel but not the columns found,
  offers no mapping and shows amber that becomes red Error. List found
  columns, allow mapping a missing channel to a column (per file or all files
  with that header), one Error style, a summary line and an honest Run label.
- **P1 7.3** Results columns depend on the first item; failing cells are
  plain; Report is off-screen. Recipe-order columns, units on a second header
  line, sticky ID/actions, highlighted failing cells.
- **P1 7.4** Status chips overlap (Flagged ⊃ Failed). Exclusive Pass / Warning
  / Fail / Error chips and a headline count.
- **P1 7.5** Batches vanish after reload and Undo removes a batch silently.
  Restore the open batch, label navigation ("← All 8 items"), name the Undo.
- **P1 7.6** "Reload saved workspace" is a page reload; the tooltip promises a
  reset that doesn't exist. Honest labels; Restore suggests a backup first.
- **P2 7.7** Run dialog: problem rows first, PDFs per item off by default,
  side-by-side buttons. Save dialog: item-ID presets instead of a raw regular
  expression, no internal IDs. Plot across items explains missing items.

## 8. Visual design and accessibility

- **P1 8.1** Most text is 11–12 px. Raise the scale one step (xs 12, sm 13,
  md 14, lg 16, xl 20); 11 px only for plot ticks.
- **P1 8.2** Targets under 24 px (row checks, disclosures, dismiss buttons,
  Compact history). Minimum 24×24 hit areas.
- **P1 8.3** Light theme: plot colours are hard-coded dark-theme values; light
  series tokens reach only 2.1–2.7:1; primary ~4.1:1. Read plot colours from
  the theme, draw tick labels in ink, darken the light palette to ≥3:1 for
  graphics and ≥4.5:1 for text.
- **P2 8.4** Hover, selected and field borders are nearly invisible
  (1.0–1.5:1). Stronger `--hover`, `--selected`, `--line-strong`.
- **P2 8.5** Y-axis titles concatenate trace names; use the unit when traces
  share it. The plot toolbar clips at 1200 px; add overflow.

## Keep

The Value dialog's per-option results, the trigger segmentation plot, impact
and delete confirmation lists, Undo across restarts, the Ctrl+K palette,
kind-coloured badges and lineage dots, batch item navigation, focus rings and
the History tree's keyboard model.
