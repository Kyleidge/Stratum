'use client';
import { useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  FileSpreadsheet,
  Info,
  Search,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import UnitField, { unitState } from '@/components/unit-field';
import { formatCount } from '@/lib/format-count';
import {
  layoutProblem,
  layoutTables,
  timeScale,
} from '@/lib/formats/delimited-layout';
import type {
  DelimitedColumn,
  DelimitedLayout,
} from '@/lib/formats/delimited-layout';
import type { RecordingFile, RecordingTable } from '@/lib/formats/recording';
import { UNIT_GROUPS, UNSTATED_UNIT } from '@/lib/units';

/** Files with more groups start with none chosen, so nothing floods History. */
const PRESELECT_LIMIT = 16;
/** Rows rendered at once; the filter narrows longer lists. */
const SHOWN = 100;
const TIME_UNITS = UNIT_GROUPS.find((group) => group.family === 'Time')
  ?.units ?? ['s'];

/** What the import dialog decided; the engine validates it again. */
export type ImportSetup = {
  tables: number[];
  /** Delimited text: time axes and the signals on each. */
  layout?: DelimitedLayout;
  /** Each table's units by channel ('' is no unit). */
  units: (string[] | null)[];
  /** Unrecognised labels kept as custom units. */
  custom: string[];
};

/** True when importing the file needs choices: groups or units to fix. */
export function needsImportSetup(recording: RecordingFile) {
  return (
    !!recording.columns ||
    recording.tables.length > 1 ||
    recording.tables.some((table) =>
      table.channels.some((channel) => unfixed(channel.unit, new Set())),
    )
  );
}

/** The setup of a file that imports as it is: every table, its own units. */
export function plainImportSetup(recording: RecordingFile): ImportSetup {
  return {
    tables: recording.tables.map((_, index) => index),
    units: recording.tables.map((table) =>
      table.channels.map((channel) => channel.unit),
    ),
    custom: [],
  };
}

/**
 * Binary formats: the fix that applies to a channel. An unrecognised label
 * is fixed once for every signal using it; a missing unit per signal.
 */
const fixKey = (table: number, channel: number, unit: string) =>
  unit === UNSTATED_UNIT ? `#${table}:${channel}` : `=${unit}`;

/** True when every word of the query appears in the text. */
function matches(text: string, query: string) {
  const lower = text.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => lower.includes(word));
}

/** Units that stop an import until they are fixed. */
const unfixed = (unit: string, custom: ReadonlySet<string>) =>
  ['unstated', 'unknown'].includes(unitState(unit, custom));

function tableSummary(table: RecordingTable) {
  const parts = [formatCount(table.channels.length, 'signal')];
  if (table.rows !== undefined) parts.push(formatCount(table.rows, 'sample'));
  if (table.start !== undefined && table.end !== undefined)
    parts.push(
      `${table.start.toLocaleString(undefined, { maximumSignificantDigits: 6 })}–${table.end.toLocaleString(undefined, { maximumSignificantDigits: 6 })} s`,
    );
  return parts.join(' · ');
}

/** Moves signals to the nearest time axis when time axes change. */
function setRole(
  layout: DelimitedLayout,
  column: number,
  next: DelimitedColumn,
): DelimitedLayout {
  const was = layout[column];
  const result = layout.map((item, index) => (index === column ? next : item));
  const axes = result.flatMap((item, index) =>
    item.role === 'time' ? [index] : [],
  );
  const nearest = (index: number) =>
    axes.filter((axis) => axis < index).at(-1) ?? axes[0];
  return result.map((item, index) => {
    if (item.role !== 'signal') return item;
    // A new axis takes the signals to its right that used the axis before it.
    if (
      next.role === 'time' &&
      was.role !== 'time' &&
      index > column &&
      nearest(index) === column &&
      item.time < column
    )
      return { role: 'signal', time: column };
    if (result[item.time]?.role === 'time') return item;
    const axis = nearest(index);
    return axis === undefined ? item : { role: 'signal', time: axis };
  });
}

/**
 * Sets up an import: for delimited text, which columns are time axes, which
 * axis each signal uses and each signal's unit; for files with several
 * groups, which groups to import. Units Stratum does not recognise, and
 * signals without a unit, must be fixed before the import.
 */
export default function WorkflowImportDialog({
  fileName,
  recording,
  onClose,
}: {
  fileName: string;
  recording: RecordingFile;
  /** The chosen setup, or undefined when cancelled. */
  onClose: (setup?: ImportSetup) => void;
}) {
  const { tables, columns } = recording;
  const [layout, setLayout] = useState<DelimitedLayout>(
    () => recording.layout ?? [],
  );
  const [columnUnits, setColumnUnits] = useState<string[]>(
    () => columns?.headers.map((header) => header.unit) ?? [],
  );
  // Binary formats: one fix per unrecognised label covers every signal using
  // it; a signal without a unit gets its own, keyed `#table:channel`.
  const [fixes, setFixes] = useState<Map<string, string>>(() => new Map());
  const [custom, setCustom] = useState<Set<string>>(() => new Set());
  const [chosen, setChosen] = useState<Set<number>>(
    () =>
      new Set(
        tables.length <= PRESELECT_LIMIT ? tables.map((_, index) => index) : [],
      ),
  );
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  // Opening focuses the column filter, not the first toolbar button.
  const searchRef = useRef<HTMLInputElement>(null);
  const keep = (label: string) => setCustom((old) => new Set(old).add(label));

  const groupMatches = useMemo(
    () =>
      tables.flatMap((table, index) =>
        matches(
          [table.name, ...table.channels.map((c) => c.name)].join(' '),
          query,
        )
          ? [index]
          : [],
      ),
    [tables, query],
  );

  // The tables the setup imports, with their channel names and units.
  const setup = useMemo(() => {
    if (columns) {
      const derived = layoutTables(layout);
      return derived.map((table, index) => ({
        index,
        name: derived.length > 1 ? columns.headers[table.time].name : '',
        channels: table.signals.map((c) => ({
          name: columns.headers[c].name,
          unit: columnUnits[c],
        })),
      }));
    }
    return [...chosen]
      .sort((a, b) => a - b)
      .map((index) => ({
        index,
        name: tables[index].name,
        channels: tables[index].channels.map((channel, c) => ({
          name: channel.name,
          unit: fixes.get(fixKey(index, c, channel.unit)) ?? channel.unit,
        })),
      }));
  }, [columns, layout, columnUnits, chosen, tables, fixes]);
  const signals = setup.reduce((sum, table) => sum + table.channels.length, 0);
  const unitProblems = setup.reduce(
    (sum, table) =>
      sum +
      table.channels.filter((channel) => unfixed(channel.unit, custom)).length,
    0,
  );
  const unstated = columns
    ? layout.flatMap((column, c) =>
        column.role === 'signal' && columnUnits[c] === UNSTATED_UNIT ? [c] : [],
      )
    : [];
  // Binary formats: what needs a fix in the chosen groups, by fix key.
  const fixRows = useMemo(() => {
    if (columns) return [];
    const rows = new Map<string, { title: string; detail: string[] }>();
    for (const index of [...chosen].sort((a, b) => a - b))
      tables[index].channels.forEach((channel, c) => {
        if (!unfixed(channel.unit, new Set())) return;
        const key = fixKey(index, c, channel.unit);
        const group =
          tables.length > 1 ? tables[index].name || `Group ${index + 1}` : '';
        const row = rows.get(key) ?? {
          title: channel.unit === UNSTATED_UNIT ? channel.name : channel.unit,
          detail: [],
        };
        row.detail.push(
          channel.unit === UNSTATED_UNIT
            ? group || 'No unit stated'
            : channel.name,
        );
        rows.set(key, row);
      });
    return [...rows];
  }, [columns, chosen, tables]);
  const unstatedFixes = fixRows.flatMap(([key]) =>
    key.startsWith('#') &&
    unitState(fixes.get(key) ?? UNSTATED_UNIT, custom) === 'unstated'
      ? [key]
      : [],
  );
  const layoutIssue = columns
    ? layoutProblem(columns.headers, layout)
    : undefined;
  const problem = !setup.length
    ? columns
      ? (layoutIssue ?? 'Choose at least one signal.')
      : 'Choose at least one group'
    : (layoutIssue ??
      (unitProblems
        ? `${formatCount(unitProblems, 'signal')} ${unitProblems === 1 ? 'needs' : 'need'} a unit Stratum recognises`
        : undefined));

  const toggle = (indexes: number[], on: boolean) =>
    setChosen((old) => {
      const next = new Set(old);
      for (const index of indexes)
        if (on) next.add(index);
        else next.delete(index);
      return next;
    });
  const finish = () =>
    onClose({
      tables: setup.map((table) => table.index),
      ...(columns ? { layout } : {}),
      units: (columns ? setup : tables).map((_, index) => {
        const table = setup.find((item) => item.index === index);
        return table ? table.channels.map((channel) => channel.unit) : null;
      }),
      custom: [...custom],
    });

  const axes = layout.flatMap((column, index) =>
    column.role === 'time' ? [index] : [],
  );
  const columnMatches = columns
    ? columns.headers.flatMap((header, index) =>
        matches(`${header.name} ${header.unit}`, query) ? [index] : [],
      )
    : [];

  // Columns that stop the import: units to fix, time units, missing axes.
  const columnProblem = (c: number) => {
    const column = layout[c];
    if (column.role === 'time') return timeScale(column.unit) === undefined;
    if (column.role === 'signal')
      return (
        layout[column.time]?.role !== 'time' || unfixed(columnUnits[c], custom)
      );
    return false;
  };
  const attention = columns
    ? columns.headers.flatMap((_, c) => (columnProblem(c) ? [c] : []))
    : [];
  const shown = attentionOnly
    ? columnMatches.filter((c) => attention.includes(c))
    : columnMatches;
  const chooseRole = (c: number, role: DelimitedColumn['role']) =>
    setLayout((old) =>
      old[c].role === role
        ? old
        : setRole(
            old,
            c,
            role === 'time'
              ? {
                  role: 'time',
                  unit:
                    timeScale(columnUnits[c]) !== undefined &&
                    columnUnits[c] !== UNSTATED_UNIT &&
                    columnUnits[c]
                      ? columnUnits[c]
                      : 's',
                }
              : role === 'skip'
                ? { role: 'skip' }
                : // setRole moves it onto the nearest time axis.
                  { role: 'signal', time: -1 },
          ),
    );
  const fixedSignals = fixRows.reduce(
    (sum, [, row]) => sum + row.detail.length,
    0,
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="workflow-dialog workflow-import-dialog"
        initialFocus={searchRef}
      >
        <header className="import-head">
          <span className="import-head-icon" aria-hidden>
            <FileSpreadsheet size={18} />
          </span>
          <div>
            <DialogTitle>Import {fileName}</DialogTitle>
            <p className="import-head-meta">
              {recording.format}
              {columns
                ? ` · ${formatCount(columns.headers.length, 'column')}`
                : ` · ${formatCount(tables.length, 'group')}`}
            </p>
          </div>
        </header>
        <DialogDescription className="import-lede">
          {columns
            ? 'Say how each column is used and which unit its values are in. Values import exactly as they are; convert units afterwards with Derive.'
            : tables.length === 1
              ? 'Say which unit each signal’s values are in. Values import exactly as they are; convert units afterwards with Derive.'
              : 'Each group has its own time axis and becomes a recording. Compare & align can bring them onto one time base later.'}
        </DialogDescription>
        {!!recording.notes?.length && (
          <ul className="import-notes">
            {recording.notes.map((note) => (
              <li key={note}>
                <Info size={14} aria-hidden /> {note}
              </li>
            ))}
          </ul>
        )}
        {columns ? (
          <>
            <section className="import-recordings" aria-label="Recordings">
              {setup.map((table) => {
                const time = layoutTables(layout)[table.index]?.time ?? 0;
                const unit = (layout[time] as { unit?: string }).unit ?? 's';
                const names = table.channels.map((channel) => channel.name);
                const broken = table.channels.some((channel) =>
                  unfixed(channel.unit, custom),
                );
                return (
                  <article
                    key={table.index}
                    className="import-recording"
                    data-problem={broken || undefined}
                  >
                    <Clock size={15} aria-hidden />
                    <div>
                      <strong>{table.name || fileName}</strong>
                      <small>
                        Clock in {unit} ·{' '}
                        {formatCount(table.channels.length, 'signal')}
                      </small>
                      <small className="import-recording-signals">
                        {names.slice(0, 4).join(', ')}
                        {names.length > 4 ? ` +${names.length - 4}` : ''}
                      </small>
                    </div>
                  </article>
                );
              })}
              {!setup.length && (
                <p className="import-recordings-empty">
                  No recording yet. Make a column a time axis and give it
                  signals.
                </p>
              )}
            </section>
            <section className="import-panel">
              <div className="import-toolbar">
                <fieldset className="import-tabs">
                  <legend className="sr-only">Show columns</legend>
                  <button
                    type="button"
                    aria-pressed={!attentionOnly}
                    onClick={() => setAttentionOnly(false)}
                  >
                    All columns <span>{columns.headers.length}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={attentionOnly}
                    data-problem={attention.length > 0 || undefined}
                    disabled={!attention.length && !attentionOnly}
                    onClick={() => setAttentionOnly(true)}
                  >
                    Needs attention <span>{attention.length}</span>
                  </button>
                </fieldset>
                <label className="import-search">
                  <Search size={14} aria-hidden />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    placeholder="Filter columns"
                    aria-label="Filter columns"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {unstated.length > 0 && (
                  <button
                    type="button"
                    className="import-bulk"
                    onClick={() =>
                      setColumnUnits((old) =>
                        old.map((unit, c) =>
                          unstated.includes(c) ? '' : unit,
                        ),
                      )
                    }
                  >
                    No unit for {formatCount(unstated.length, 'signal')} without
                    one
                  </button>
                )}
              </div>
              <div className="import-list-head" aria-hidden>
                <span />
                <span>Column</span>
                <span>Use as</span>
                <span>Time axis</span>
                <span>Unit in the file</span>
              </div>
              <ul className="import-list">
                {shown.slice(0, SHOWN).map((c) => {
                  const header = columns.headers[c];
                  const column = layout[c];
                  const problem = columnProblem(c);
                  const values = columns.rows
                    .slice(0, 3)
                    .map((row) => row[c]?.trim() || '–');
                  const users =
                    column.role === 'time'
                      ? layout.filter(
                          (item) => item.role === 'signal' && item.time === c,
                        ).length
                      : 0;
                  return (
                    <li
                      key={c}
                      className="import-row"
                      data-role={column.role}
                      data-problem={problem || undefined}
                    >
                      <span className="import-row-status" aria-hidden>
                        {column.role === 'time' ? (
                          <Clock size={15} />
                        ) : column.role === 'skip' ? (
                          <CircleMinus size={15} />
                        ) : problem ? (
                          <CircleAlert size={15} />
                        ) : (
                          <CircleCheck size={15} />
                        )}
                      </span>
                      <div className="import-row-name" title={header.name}>
                        <strong>{header.name}</strong>
                        <small>
                          {columns.numeric[c] ? values.join('  ') : 'Text'}
                        </small>
                      </div>
                      <fieldset className="import-segmented">
                        <legend className="sr-only">
                          Use of {header.name}
                        </legend>
                        {(['time', 'signal', 'skip'] as const).map((role) => (
                          <button
                            key={role}
                            type="button"
                            aria-pressed={column.role === role}
                            disabled={
                              role !== 'skip' &&
                              !columns.numeric[c] &&
                              column.role !== role
                            }
                            onClick={() => chooseRole(c, role)}
                          >
                            {role === 'time'
                              ? 'Time'
                              : role === 'signal'
                                ? 'Signal'
                                : 'Skip'}
                          </button>
                        ))}
                      </fieldset>
                      <div className="import-row-axis">
                        {column.role === 'signal' ? (
                          axes.length > 1 || !axes.includes(column.time) ? (
                            <select
                              value={column.time}
                              aria-label={`Time axis of ${header.name}`}
                              onChange={(event) =>
                                setLayout((old) =>
                                  old.map((item, index) =>
                                    index === c
                                      ? {
                                          role: 'signal',
                                          time: Number(event.target.value),
                                        }
                                      : item,
                                  ),
                                )
                              }
                            >
                              {!axes.includes(column.time) && (
                                <option value={column.time}>
                                  Choose a time axis
                                </option>
                              )}
                              {axes.map((axis) => (
                                <option key={axis} value={axis}>
                                  {columns.headers[axis].name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span>{columns.headers[column.time].name}</span>
                          )
                        ) : column.role === 'time' ? (
                          <span className="import-muted">
                            {users
                              ? `Clock for ${formatCount(users, 'signal')}`
                              : 'No signals use it'}
                          </span>
                        ) : (
                          <span className="import-muted">Not imported</span>
                        )}
                      </div>
                      <div className="import-row-unit">
                        {column.role === 'time' ? (
                          <div
                            className="unit-field"
                            data-state={
                              timeScale(column.unit) === undefined
                                ? 'unknown'
                                : 'known'
                            }
                          >
                            <select
                              value={column.unit}
                              aria-label={`Time unit of ${header.name}`}
                              aria-invalid={
                                timeScale(column.unit) === undefined
                              }
                              onChange={(event) =>
                                setLayout((old) =>
                                  old.map((item, index) =>
                                    index === c
                                      ? {
                                          role: 'time',
                                          unit: event.target.value,
                                        }
                                      : item,
                                  ),
                                )
                              }
                            >
                              {!TIME_UNITS.includes(column.unit) && (
                                <option value={column.unit}>
                                  {column.unit}
                                </option>
                              )}
                              {TIME_UNITS.map((unit) => (
                                <option key={unit} value={unit}>
                                  {unit}
                                </option>
                              ))}
                            </select>
                            <small>
                              {timeScale(column.unit) === undefined ? (
                                <span className="unit-field-problem">
                                  Not a unit of time
                                </span>
                              ) : column.unit === 's' ? null : (
                                'Clock kept in seconds'
                              )}
                            </small>
                          </div>
                        ) : column.role === 'signal' ? (
                          <UnitField
                            value={columnUnits[c]}
                            custom={custom}
                            label={`Unit of ${header.name} in the file`}
                            onKeep={keep}
                            onChange={(unit) =>
                              setColumnUnits((old) =>
                                old.map((item, index) =>
                                  index === c ? unit : item,
                                ),
                              )
                            }
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {shown.length > SHOWN && (
                <p className="import-muted import-list-more">
                  Showing {SHOWN} of {formatCount(shown.length, 'column')}.
                  Filter to find others.
                </p>
              )}
              {!shown.length && (
                <p className="import-muted import-list-more">
                  {attentionOnly
                    ? 'Every column is ready.'
                    : 'No column matches.'}
                </p>
              )}
            </section>
          </>
        ) : (
          <>
            {tables.length > 1 && (
              <section className="import-panel">
                <div className="import-toolbar">
                  <h3>
                    Groups{' '}
                    <span>
                      {chosen.size} of {tables.length}
                    </span>
                  </h3>
                  {tables.length > 8 && (
                    <label className="import-search">
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
                  <button
                    type="button"
                    className="import-bulk"
                    onClick={() => toggle(groupMatches, true)}
                  >
                    {query.trim() ? 'Choose matching' : 'Choose all'}
                  </button>
                  <button
                    type="button"
                    className="import-bulk"
                    disabled={!chosen.size}
                    onClick={() =>
                      toggle(query.trim() ? groupMatches : [...chosen], false)
                    }
                  >
                    Clear
                  </button>
                </div>
                <ul className="import-list import-groups">
                  {groupMatches.slice(0, SHOWN).map((index) => {
                    const table = tables[index];
                    const names = table.channels.map((channel) => channel.name);
                    return (
                      <li
                        key={index}
                        className="import-group"
                        data-state={chosen.has(index) ? 'included' : 'excluded'}
                      >
                        <Checkbox
                          aria-label={`Import ${table.name || `group ${index + 1}`}`}
                          checked={chosen.has(index)}
                          onCheckedChange={(checked) =>
                            toggle([index], !!checked)
                          }
                        />
                        <div className="import-row-name">
                          <strong>{table.name || `Group ${index + 1}`}</strong>
                          <small>{tableSummary(table)}</small>
                          <small title={names.join(', ')}>
                            {names.slice(0, 6).join(', ')}
                            {names.length > 6
                              ? `, +${names.length - 6} more`
                              : ''}
                          </small>
                          {table.notes?.map((note) => (
                            <small key={note} className="import-group-note">
                              {note}
                            </small>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {groupMatches.length > SHOWN && (
                  <p className="import-muted import-list-more">
                    Showing {SHOWN} of{' '}
                    {formatCount(groupMatches.length, 'matching group')}. Filter
                    to find others.
                  </p>
                )}
                {!groupMatches.length && (
                  <p className="import-muted import-list-more">
                    No group or signal matches.
                  </p>
                )}
              </section>
            )}
            {fixRows.length > 0 && (
              <section className="import-panel">
                <div className="import-toolbar">
                  <h3>
                    Units to identify{' '}
                    <span>{formatCount(fixedSignals, 'signal')}</span>
                  </h3>
                  {unstatedFixes.length > 0 && (
                    <button
                      type="button"
                      className="import-bulk"
                      onClick={() =>
                        setFixes((old) => {
                          const next = new Map(old);
                          for (const key of unstatedFixes) next.set(key, '');
                          return next;
                        })
                      }
                    >
                      No unit for {formatCount(unstatedFixes.length, 'signal')}{' '}
                      without one
                    </button>
                  )}
                </div>
                <ul className="import-list import-units">
                  {fixRows.slice(0, SHOWN).map(([key, row]) => {
                    const original = key.startsWith('#')
                      ? UNSTATED_UNIT
                      : key.slice(1);
                    const value = fixes.get(key) ?? original;
                    const problem = unfixed(value, custom);
                    return (
                      <li
                        key={key}
                        className="import-row"
                        data-problem={problem || undefined}
                      >
                        <span className="import-row-status" aria-hidden>
                          {problem ? (
                            <CircleAlert size={15} />
                          ) : (
                            <CircleCheck size={15} />
                          )}
                        </span>
                        <div
                          className="import-row-name"
                          title={row.detail.join(', ')}
                        >
                          <strong>{row.title}</strong>
                          <small>
                            {row.detail.slice(0, 4).join(', ')}
                            {row.detail.length > 4
                              ? `, +${row.detail.length - 4} more`
                              : ''}
                          </small>
                        </div>
                        <div className="import-row-unit">
                          <UnitField
                            value={value}
                            custom={custom}
                            label={
                              original === UNSTATED_UNIT
                                ? `Unit of ${row.title} in the file`
                                : `Unit meant by ${row.title}`
                            }
                            onKeep={keep}
                            onChange={(unit) =>
                              setFixes((old) => new Map(old).set(key, unit))
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {fixRows.length > SHOWN && (
                  <p className="import-muted import-list-more">
                    Showing {SHOWN} of {fixRows.length}. Use No unit for signals
                    without one, or import fewer groups.
                  </p>
                )}
              </section>
            )}
          </>
        )}
        <footer className="import-footer">
          <span
            className="import-status"
            aria-live="polite"
            data-problem={problem ? '' : undefined}
          >
            {problem ? (
              <CircleAlert size={15} aria-hidden />
            ) : (
              <CircleCheck size={15} aria-hidden />
            )}
            {problem ??
              `Ready: ${formatCount(setup.length, 'recording')} · ${formatCount(signals, 'signal')}`}
          </span>
          <button className="secondary-button" onClick={() => onClose()}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!!problem}
            onClick={finish}
          >
            <ArrowDownToLine size={14} /> Import{' '}
            {formatCount(setup.length, columns ? 'recording' : 'group')}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
