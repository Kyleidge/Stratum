'use client';
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCount } from '@/lib/format-count';
import type { RecordingFile, RecordingTable } from '@/lib/formats/recording';

/** Files with more groups start with none chosen, so nothing floods History. */
const PRESELECT_LIMIT = 16;
/** Rows rendered at once; the filter narrows longer lists. */
const SHOWN = 100;

function tableSummary(table: RecordingTable) {
  const parts = [formatCount(table.channels.length, 'signal')];
  if (table.rows !== undefined) parts.push(formatCount(table.rows, 'sample'));
  if (table.start !== undefined && table.end !== undefined)
    parts.push(
      `${table.start.toLocaleString(undefined, { maximumSignificantDigits: 6 })}–${table.end.toLocaleString(undefined, { maximumSignificantDigits: 6 })} s`,
    );
  return parts.join(' · ');
}

/** Choose which groups of a multi-group file become recordings. */
export default function WorkflowImportDialog({
  fileName,
  recording,
  onClose,
}: {
  fileName: string;
  recording: RecordingFile;
  /** The chosen table indexes, or undefined when cancelled. */
  onClose: (tables?: number[]) => void;
}) {
  const { tables } = recording;
  const [chosen, setChosen] = useState<Set<number>>(
    () =>
      new Set(
        tables.length <= PRESELECT_LIMIT ? tables.map((_, index) => index) : [],
      ),
  );
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tables.flatMap((table, index) => {
      const text = [table.name, ...table.channels.map((c) => c.name)]
        .join(' ')
        .toLowerCase();
      return words.every((word) => text.includes(word)) ? [index] : [];
    });
  }, [tables, query]);
  const signals = [...chosen].reduce(
    (sum, index) => sum + tables[index].channels.length,
    0,
  );
  const toggle = (indexes: number[], on: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      for (const index of indexes)
        if (on) next.add(index);
        else next.delete(index);
      return next;
    });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="workflow-dialog workflow-batch-dialog workflow-import-dialog">
        <DialogTitle>Import {fileName}</DialogTitle>
        <DialogDescription>
          This {recording.format} file holds{' '}
          {formatCount(tables.length, 'group')}, each with its own time axis.
          Each group you choose becomes a recording; Compare &amp; align can
          bring them onto one time base later.
        </DialogDescription>
        {!!recording.notes?.length && (
          <ul className="workflow-batch-notes">
            {recording.notes.map((note) => (
              <li key={note}>
                <AlertTriangle size={13} /> {note}
              </li>
            ))}
          </ul>
        )}
        <section className="workflow-batch-section">
          <h3>
            Groups{' '}
            <span>
              {chosen.size} of {tables.length}
            </span>
            <button
              type="button"
              className="workflow-link"
              onClick={() => toggle(matches, true)}
            >
              {query.trim() ? 'Choose matching' : 'Choose all'}
            </button>
            <button
              type="button"
              className="workflow-link"
              disabled={!chosen.size}
              onClick={() =>
                toggle(query.trim() ? matches : [...chosen], false)
              }
            >
              Clear
            </button>
          </h3>
          {tables.length > 8 && (
            <label className="workflow-import-filter">
              <Search size={14} aria-hidden />
              <input
                type="search"
                value={query}
                placeholder="Filter groups and signals"
                aria-label="Filter groups and signals"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          <ul className="workflow-batch-steps workflow-import-groups">
            {matches.slice(0, SHOWN).map((index) => {
              const table = tables[index];
              const names = table.channels.map((channel) => channel.name);
              return (
                <li
                  key={index}
                  data-state={chosen.has(index) ? 'included' : 'excluded'}
                >
                  <Checkbox
                    aria-label={`Import ${table.name || `group ${index + 1}`}`}
                    checked={chosen.has(index)}
                    onCheckedChange={(checked) => toggle([index], !!checked)}
                  />
                  <div>
                    <strong>{table.name || `Group ${index + 1}`}</strong>
                    <small>{tableSummary(table)}</small>
                    <small
                      className="workflow-import-signals"
                      title={names.join(', ')}
                    >
                      {names.slice(0, 6).join(', ')}
                      {names.length > 6 ? `, +${names.length - 6} more` : ''}
                    </small>
                    {table.notes?.map((note) => (
                      <small key={note} className="workflow-import-note">
                        {note}
                      </small>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {matches.length > SHOWN && (
            <p className="workflow-muted">
              Showing {SHOWN} of {formatCount(matches.length, 'matching group')}
              . Filter to find others.
            </p>
          )}
          {!matches.length && (
            <p className="workflow-muted">No group or signal matches.</p>
          )}
        </section>
        <div className="workflow-batch-actions">
          <span className="workflow-muted" aria-live="polite">
            {chosen.size
              ? `${formatCount(chosen.size, 'recording')} · ${formatCount(signals, 'signal')}`
              : 'Choose at least one group'}
          </span>
          <button className="secondary-button" onClick={() => onClose()}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!chosen.size}
            onClick={() => onClose([...chosen].sort((a, b) => a - b))}
          >
            <ArrowDownToLine size={14} /> Import{' '}
            {formatCount(chosen.size, 'group')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
