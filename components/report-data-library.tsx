'use client';

import { useState } from 'react';
import { Check, GripVertical, Plus, Search, Table2, Waves } from 'lucide-react';
import type { ReportAsset } from '@/lib/report-integration';

export const REPORT_ASSET_DRAG_TYPE = 'application/x-stratum-report-asset';

export function ReportDataLibrary({
  assets,
  selectionIds,
  busy,
  capturing,
  kind,
  onKindChange,
  onAdd,
  onCancel,
}: {
  assets: ReportAsset[];
  selectionIds: string[];
  busy: boolean;
  capturing: boolean;
  /** Which assets to list: all, signal, plot, plottable or values. */
  kind: string;
  onKindChange: (kind: string) => void;
  onAdd: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const setKind = onKindChange;
  const [page, setPage] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  const matches = assets.filter(
    (asset) =>
      (kind === 'all' ||
        (kind === 'values'
          ? asset.kind === 'value' || asset.kind === 'values'
          : kind === 'plottable'
            ? asset.kind === 'signal' || asset.kind === 'plot'
            : asset.kind === kind)) &&
      `${asset.name} ${asset.detail}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(matches.length / 30));
  const currentPage = Math.min(page, pages - 1);
  const selected = checked.filter((id) =>
    assets.some((asset) => asset.id === id),
  );
  const disabled = busy || capturing;

  return (
    <>
      <div className="rb-section-heading">
        <h2>From Data Inspector</h2>
        <p>Drag data onto the page, or select items to add together.</p>
      </div>
      <label className="rb-data-search">
        <Search size={15} />
        <input
          aria-label="Search report data"
          placeholder="Find signals, plots, values…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </label>
      <label className="rb-field">
        <span>Show</span>
        <select
          aria-label="Report data type"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">All workspace data</option>
          <option value="plottable">Signals &amp; saved plots</option>
          <option value="signal">Signals</option>
          <option value="plot">Saved plots</option>
          <option value="values">Values &amp; value tables</option>
        </select>
      </label>
      <button
        className="rb-button rb-wide"
        disabled={disabled || !selectionIds.length}
        onClick={() => onAdd(selectionIds)}
      >
        <Plus size={14} /> Add inspected item
      </button>
      <div className="rb-data-summary">
        <span>{matches.length.toLocaleString()} available</span>
        <span>{selected.length} of 30 selected</span>
      </div>
      <div className="rb-data-list">
        {matches
          .slice(currentPage * 30, (currentPage + 1) * 30)
          .map((asset) => {
            const Icon =
              asset.kind === 'signal' || asset.kind === 'plot' ? Waves : Table2;
            const isChecked = selected.includes(asset.id);
            return (
              <div className="rb-data-asset" key={asset.id}>
                <input
                  type="checkbox"
                  aria-label={`Select ${asset.name} for report`}
                  checked={isChecked}
                  disabled={!isChecked && selected.length >= 30}
                  onChange={() =>
                    setChecked(
                      isChecked
                        ? selected.filter((id) => id !== asset.id)
                        : [...selected, asset.id],
                    )
                  }
                />
                <button
                  className="rb-data-item"
                  title={`${asset.name}\n${asset.detail}\nClick to add, or drag onto the page.`}
                  aria-label={`Add ${asset.name} to report`}
                  disabled={disabled}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      REPORT_ASSET_DRAG_TYPE,
                      JSON.stringify(isChecked ? selected : [asset.id]),
                    );
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAdd([asset.id])}
                >
                  <Icon size={15} />
                  <span>
                    <strong>{asset.name}</strong>
                    <small>{asset.detail}</small>
                  </span>
                  <GripVertical size={13} />
                </button>
              </div>
            );
          })}
        {!matches.length && (
          <p className="rb-field-note">
            {assets.length
              ? 'No matching data. Try another search.'
              : 'Import a recording or load the demo in Data Inspector to get started. Saved plots and calculated values will appear here too.'}
          </p>
        )}
      </div>
      {pages > 1 && (
        <div className="rb-data-paging">
          <button
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
      <button
        className="rb-button rb-primary rb-wide"
        disabled={disabled || !selected.length}
        onClick={() => {
          onAdd(selected);
          // Added items are on the page now; start the next selection afresh.
          setChecked([]);
        }}
      >
        <Check size={14} /> Add selected ({selected.length})
      </button>
      {capturing && (
        <output className="rb-capture-status">
          <span>Capturing workspace data…</span>
          <button onClick={onCancel}>Cancel</button>
        </output>
      )}
      <p className="rb-field-note rb-data-note">
        Snapshots stay as captured. When data changes, a snapshot shows “Data
        changed” with an Update snapshot action. Your draft stays here while you
        inspect data.
      </p>
    </>
  );
}
