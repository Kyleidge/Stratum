'use client';

import type { ReactNode } from 'react';
import { PanelBottom } from 'lucide-react';

export type DockTab = 'outputs' | 'samples' | 'settings';

/** Outputs, exact samples and saved settings of the selection, below Active. */
export default function WorkflowDock({
  tab,
  onTab,
  open,
  onOpen,
  outputCount,
  context,
  children,
}: {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  outputCount: number;
  context?: ReactNode;
  children: ReactNode;
}) {
  const tabs: [DockTab, string, number?][] = [
    ['outputs', 'Outputs', outputCount],
    ['samples', 'Samples'],
    ['settings', 'Settings'],
  ];
  return (
    <section
      className="plot-output-dock"
      data-open={open}
      aria-label="Operation panel"
    >
      <div className="plot-dock-head">
        <div role="tablist" aria-label="Operation panel views">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              id={`plot-dock-${key}`}
              aria-selected={open && tab === key}
              aria-controls="plot-dock-panel"
              onClick={() => {
                onTab(key);
                onOpen(true);
              }}
            >
              {label}
              {count !== undefined && <span>{count}</span>}
            </button>
          ))}
        </div>
        {context && <span className="plot-dock-context">{context}</span>}
        <button
          className="workflow-icon-button workflow-quiet"
          aria-label={
            open ? 'Collapse operation panel' : 'Expand operation panel'
          }
          aria-expanded={open}
          aria-controls="plot-dock-panel"
          onClick={() => onOpen(!open)}
        >
          <PanelBottom size={15} />
        </button>
      </div>
      {open && (
        <div
          id="plot-dock-panel"
          role="tabpanel"
          aria-labelledby={`plot-dock-${tab}`}
          className="plot-dock-body"
        >
          {children}
        </div>
      )}
    </section>
  );
}
