'use client';
import { Compass } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CSV_FORMAT_EXAMPLE } from '@/lib/csv-import-messages';

// Every entry is implemented in workflow-workbench.tsx (global keys),
// workflow-history.tsx (the History tree) or signal-chart.tsx (plots).
// Each entry lists alternative key combinations.
type Shortcut = [combos: string[][], action: string];
const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: 'Anywhere in Data',
    items: [
      [[['Ctrl', 'K']], 'Open the command palette and search every step'],
      [[['Ctrl', 'Z']], 'Undo the last change'],
      [
        [
          ['Ctrl', 'Y'],
          ['Ctrl', 'Shift', 'Z'],
        ],
        'Redo',
      ],
      [
        [
          ['Alt', '←'],
          ['Alt', '→'],
        ],
        'Previous or next item while viewing a batch item',
      ],
      [[['Esc']], 'Close the History or Details drawer'],
    ],
  },
  {
    group: 'History',
    items: [
      [[['↑'], ['↓']], 'Move between steps and outputs'],
      [[['→'], ['←']], 'Expand or collapse a step'],
      [[['Home'], ['End']], 'First or last row'],
      [[['Enter']], 'Show the focused row'],
      [[['F2']], 'Rename the focused step or output'],
      [[['Shift', 'F10']], 'Open the row menu, as right-click does'],
      [[['Double-click']], 'Edit the step’s settings'],
      [
        [['Ctrl', 'click']],
        'Check a signal as an input; on a step, all its signals',
      ],
      [[['Shift', 'click']], 'Check a range of signals'],
      [
        [
          ['Shift', '↑'],
          ['Shift', '↓'],
        ],
        'Extend the checked signals row by row',
      ],
    ],
  },
  {
    group: 'Focused plot',
    items: [
      [[['+'], ['−']], 'Zoom time in or out; the mouse wheel also zooms'],
      [[['←'], ['→']], 'Pan time'],
      [[['Shift', 'drag']], 'Pan; drag on a Y axis to pan only that axis'],
      [[['Home']], 'Fit all data'],
      [[['Backspace']], 'Previous view'],
      [[['Double-click']], 'Add an annotation; on an axis, edit its limits'],
    ],
  },
];

function Keys({ combos }: { combos: string[][] }) {
  return (
    <span className="workflow-guide-keys">
      {combos.map((combo, i) => (
        <span key={combo.join('+')}>
          {i > 0 && <span className="workflow-guide-or">or</span>}
          {combo.map((key, j) => (
            <span key={key}>
              {j > 0 && <span aria-hidden>+</span>}
              <kbd>{key}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** The tabbed guide opened from the top bar, the palette or the welcome. */
export function WorkflowGuide({
  open,
  onOpenChange,
  onStartTour,
  canStartTour,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartTour: () => void;
  canStartTour: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog workflow-guide-dialog">
        <DialogTitle>Guide</DialogTitle>
        <DialogDescription>
          Stratum turns test recordings into traceable results. Every step keeps
          its inputs, so each result leads back to the original recording.
        </DialogDescription>
        <Tabs defaultValue="start" className="workflow-guide-tabs">
          <TabsList variant="line" aria-label="Guide sections">
            <TabsTrigger value="start">Getting started</TabsTrigger>
            <TabsTrigger value="concepts">Concepts</TabsTrigger>
            <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
            <TabsTrigger value="batch">Batch</TabsTrigger>
          </TabsList>
          <TabsContent value="start" className="workflow-guide-panel">
            <ol className="workflow-guide-steps">
              <li>
                <strong>Import a recording.</strong> Choose Import and pick a
                CSV file, or drop it on the window. Time in seconds comes first,
                then one column per signal with its unit in brackets:{' '}
                <code>{CSV_FORMAT_EXAMPLE},…</code>
              </li>
              <li>
                <strong>Process it.</strong> Select a signal in History, then
                choose <em>Derive</em> to calculate a new signal or{' '}
                <em>Segment</em> to cut it into runs or windows. Each dialog
                shows a live preview before you create anything.
              </li>
              <li>
                <strong>Measure.</strong> Choose <em>Value</em> for a minimum,
                maximum or average of each input. Select any result to see its
                lineage in Details.
              </li>
              <li>
                <strong>Share it.</strong> <em>Export data…</em> downloads
                samples and values as CSV. <em>Add to report</em> places plots
                and values on a page in Reports for a PDF.
              </li>
            </ol>
            <button
              type="button"
              className="primary-button"
              onClick={onStartTour}
              disabled={!canStartTour}
            >
              <Compass size={14} aria-hidden /> Start the example tour
            </button>
          </TabsContent>
          <TabsContent value="concepts" className="workflow-guide-panel">
            <dl className="workflow-guide-terms">
              <dt>Recording and original signals</dt>
              <dd>
                An imported CSV file is a recording; its columns are original
                signals. They are stored on this device and never change.
              </dd>
              <dt>Step</dt>
              <dd>
                One entry in History: an import, Derive, Segment or Value with
                its settings, inputs and outputs. Steps are numbered oldest
                first and coloured by kind.
              </dd>
              <dt>Derived signals and segments</dt>
              <dd>
                Derive and Segment create new signals. A segment is an ordinary
                signal, so it can be derived, segmented again or measured.
              </dd>
              <dt>Values</dt>
              <dd>
                One number per input signal. A time average weights by elapsed
                time; a sample average weights each sample equally.
              </dd>
              <dt>Apply to</dt>
              <dd>
                The inputs the next Derive, Segment or Value will use: the
                selected item, or the signals you check in History.
              </dd>
              <dt>Lineage and Used by</dt>
              <dd>
                Details shows where the selection came from and which later
                steps use it. A dot in History marks items used to make the
                selection.
              </dd>
              <dt>Edit and New version…</dt>
              <dd>
                Edit changes a step and recalculates everything after it. New
                version… keeps the step and adds another with new settings.
                Ctrl+Z undoes either, also after a restart.
              </dd>
              <dt>Reports</dt>
              <dd>
                Report plots and values are snapshots; they do not change when
                the data does.
              </dd>
            </dl>
          </TabsContent>
          <TabsContent value="shortcuts" className="workflow-guide-panel">
            <p className="workflow-guide-note">
              On macOS, use ⌘ in place of Ctrl.
            </p>
            {SHORTCUTS.map((section) => (
              <section
                key={section.group}
                className="workflow-guide-keys-group"
              >
                <h3>{section.group}</h3>
                <dl>
                  {section.items.map(([combos, action]) => (
                    <div key={action}>
                      <dt>
                        <Keys combos={combos} />
                      </dt>
                      <dd>{action}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </TabsContent>
          <TabsContent value="batch" className="workflow-guide-panel">
            <ol className="workflow-guide-steps">
              <li>
                <strong>Save a workflow.</strong> Build the steps on one
                recording, then save that recording&apos;s workflow from the
                Import menu as a <code>.stratum.yaml</code> file. Add checks to
                steps in Details to flag results outside limits.
              </li>
              <li>
                <strong>Run it on many recordings.</strong> Choose Run a
                workflow on recordings…, or drop a workflow file together with
                CSV files. A check before running lists missing signals.
              </li>
              <li>
                <strong>Review the results.</strong> The batch table shows one
                row per recording with its status and values. Open an item to
                see its steps; Alt+← and Alt+→ move between items.
              </li>
              <li>
                <strong>Report.</strong> Export a summary CSV, or one PDF per
                recording when the workflow includes a report.
              </li>
            </ol>
            <p className="workflow-guide-note">
              The batch example in the Import menu runs a motor test workflow on
              eight recordings.
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
