'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  Hash,
  Layers2,
  Scissors,
  Sigma,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import MockupChart, {
  type ChartReference,
  type ChartTrace,
} from './mockup-chart';
import {
  compute,
  dependents,
  eligibleSignals,
  formatExact,
  formatNumber,
  stepRef,
  summary,
  type MockStep,
  type Recipe,
  type ValueFn,
  type Workspace,
} from '@/lib/mockup-data';

/** Native modal dialog: focus containment, Escape and the top layer for free. */
export function MockDialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'normal',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'small' | 'normal' | 'wide';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="mk-dialog"
      data-size={size}
      aria-labelledby={id}
      onClose={onClose}
    >
      <header className="mk-dialog-head">
        <div>
          <h2 id={id}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="mk-icon" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="mk-dialog-body">{children}</div>
      {footer && <footer className="mk-dialog-foot">{footer}</footer>}
    </dialog>
  );
}

export type OperationKind = 'derive' | 'segment' | 'value' | 'compare';

const KIND: Record<
  OperationKind,
  { title: string; icon: LucideIcon; verb: string }
> = {
  derive: { title: 'Derive signals', icon: Sigma, verb: 'Apply a function' },
  segment: { title: 'Segment signals', icon: Scissors, verb: 'Split' },
  value: { title: 'Calculate values', icon: Hash, verb: 'Reduce' },
  compare: {
    title: 'Compare & align',
    icon: Layers2,
    verb: 'Align in time',
  },
};

type DeriveOp =
  | 'smooth'
  | 'scale'
  | 'offset'
  | 'abs'
  | 'derivative'
  | 'multiply';
const DERIVE: {
  op: DeriveOp;
  name: string;
  formula: string;
  param?: string;
}[] = [
  {
    op: 'smooth',
    name: 'Moving average',
    formula: 'mean(A, n)',
    param: 'Window n (samples)',
  },
  { op: 'scale', name: 'Scale', formula: 'A × k', param: 'Factor k' },
  { op: 'offset', name: 'Offset', formula: 'A + k', param: 'Offset k' },
  { op: 'abs', name: 'Absolute value', formula: '|A|' },
  { op: 'derivative', name: 'Derivative', formula: 'dA/dt' },
  { op: 'multiply', name: 'Multiply signals', formula: 'A × B' },
];
const DEFAULTS: Record<string, number> = {
  smooth: 5,
  scale: 2,
  offset: 10,
};

function parseRanges(text: string): [number, number][] | string {
  const ranges: [number, number][] = [];
  for (const part of text.split(/[,;\n]+/).map((item) => item.trim())) {
    if (!part) continue;
    const match = /^(-?[\d.]+)\s*(?:-|–|to)\s*(-?[\d.]+)$/.exec(part);
    const [a, b] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
    if (!(b > a)) return `“${part}” is not a range like 10–50.`;
    ranges.push([a, b]);
  }
  return ranges.length ? ranges : 'Enter at least one range, e.g. 10–50.';
}

const rangesText = (ranges: [number, number][]) =>
  ranges.map(([a, b]) => `${a}–${b}`).join(', ');

/**
 * Settings for a new or edited operation, with a live preview computed by the
 * same function that creates the outputs.
 */
export function OperationDialog({
  kind,
  ws,
  inputs,
  editing,
  onApply,
  onClose,
}: {
  kind: OperationKind;
  ws: Workspace;
  inputs: string[];
  editing?: MockStep;
  onApply: (recipe: Recipe, name: string) => string | undefined;
  onClose: () => void;
}) {
  const [applyError, setApplyError] = useState('');
  const saved = editing?.recipe;
  const [op, setOp] = useState<DeriveOp>(
    saved && DERIVE.some((item) => item.op === saved.op)
      ? (saved.op as DeriveOp)
      : 'smooth',
  );
  const [param, setParam] = useState(() =>
    String(
      saved?.op === 'smooth'
        ? saved.width
        : saved?.op === 'scale'
          ? saved.factor
          : saved?.op === 'offset'
            ? saved.amount
            : DEFAULTS.smooth,
    ),
  );
  const signals = eligibleSignals(ws, editing?.id);
  const [by, setBy] = useState(
    saved?.op === 'multiply'
      ? saved.by
      : (signals.find((item) => !inputs.includes(item.id))?.id ??
          signals[0]?.id ??
          ''),
  );
  const first = signals.find((item) => item.id === inputs[0]);
  const [mode, setMode] = useState<'ranges' | 'windows'>(
    saved?.op === 'windows' ? 'windows' : 'ranges',
  );
  const [ranges, setRanges] = useState(() =>
    saved?.op === 'ranges'
      ? rangesText(saved.ranges)
      : first
        ? rangesText([
            [
              Math.round(first.t[0]),
              Math.round((first.t[0] + first.t[first.t.length - 1]) / 2),
            ],
          ])
        : '0–10',
  );
  const [windowLength, setWindowLength] = useState(
    String(saved?.op === 'windows' ? saved.length : 20),
  );
  const [fn, setFn] = useState<ValueFn>(
    saved?.op === 'value' ? saved.fn : 'Time average',
  );
  const [shift, setShift] = useState(
    String(saved?.op === 'shift' ? saved.seconds : 5),
  );
  const subject =
    inputs.length === 1
      ? (first?.label ?? '1 signal')
      : `${inputs.length} signals`;

  const recipe: Recipe | string = (() => {
    if (kind === 'derive') {
      const value = Number(param);
      if (op === 'abs' || op === 'derivative') return { op };
      if (op === 'multiply')
        return signals.some((item) => item.id === by)
          ? { op, by }
          : 'Choose the signal to multiply by.';
      if (!Number.isFinite(value)) return 'Enter a number.';
      if (op === 'smooth')
        return value >= 1 && Number.isInteger(value) && value % 2 === 1
          ? { op, width: value }
          : 'The window is a positive odd whole number of samples.';
      return op === 'scale' ? { op, factor: value } : { op, amount: value };
    }
    if (kind === 'segment') {
      if (mode === 'windows') {
        const length = Number(windowLength);
        return length > 0
          ? { op: 'windows', length }
          : 'Enter a window length.';
      }
      const parsed = parseRanges(ranges);
      return typeof parsed === 'string'
        ? parsed
        : { op: 'ranges', ranges: parsed };
    }
    if (kind === 'value') return { op: 'value', fn };
    const seconds = Number(shift);
    return Number.isFinite(seconds)
      ? { op: 'shift', seconds }
      : 'Enter a time shift in seconds.';
  })();
  // Cheap at mockup sizes, so the preview is recomputed on every change.
  const preview = (() => {
    if (typeof recipe === 'string') return { drafts: [], error: recipe };
    try {
      return { drafts: compute(ws, recipe, inputs), error: '' };
    } catch (error) {
      return {
        drafts: [],
        error: error instanceof Error ? error.message : 'Could not preview.',
      };
    }
  })();
  const drafts = preview.drafts;
  const describe = () =>
    typeof recipe === 'string'
      ? ''
      : summary(ws, {
          id: '',
          sequence: 0,
          name: '',
          revision: 1,
          recipe,
          inputs,
          outputs: drafts.map(() => ''),
        });
  const defaultName =
    typeof recipe === 'string'
      ? ''
      : kind === 'segment'
        ? `Split ${subject} into ${mode === 'windows' ? 'windows' : 'ranges'}`
        : kind === 'value'
          ? `${fn} of ${subject}`
          : kind === 'compare'
            ? `Align ${subject} in time`
            : `${DERIVE.find((item) => item.op === op)!.name} of ${subject}`;
  const [name, setName] = useState(editing?.name ?? '');
  const finalName = name.trim() || defaultName;
  const error = preview.error
    ? preview.error
    : !inputs.length
      ? 'Choose at least one signal first.'
      : !drafts.length
        ? 'These settings produce no outputs for the chosen signals.'
        : '';

  // Preview: the first input and up to two results, colour-slotted in order.
  const traces: ChartTrace[] = [];
  const references: ChartReference[] = [];
  if (first) {
    traces.push({
      id: 'input',
      label: `Input · ${first.label}`,
      short: 'Input',
      unit: first.unit,
      color: 'var(--mk-series-1)',
      t: first.t,
      v: first.v,
      offset: 0,
    });
    drafts.forEach((draft, k) => {
      if (draft.kind === 'value') {
        if (draft.inputs[0] === first.id && Number.isFinite(draft.value))
          references.push({
            id: `value-${k}`,
            traceId: 'input',
            value: draft.value,
            label: `${fn === 'Time average' ? 'avg' : fn === 'Maximum' ? 'max' : 'min'} ${formatNumber(draft.value)}`,
            t0: draft.at !== undefined ? draft.at - 2 : first.t[0],
            t1:
              draft.at !== undefined
                ? draft.at + 2
                : first.t[first.t.length - 1],
          });
      } else if (traces.length < 3 && draft.inputs[0] === first.id)
        traces.push({
          id: `draft-${k}`,
          label: draft.label,
          short: draft.short,
          unit: draft.unit,
          color: `var(--mk-series-${traces.length + 1})`,
          t: draft.t,
          v: draft.v,
          offset: 0,
        });
    });
  }
  const Icon = KIND[kind].icon;
  const count = drafts.length;
  const outputWord = kind === 'value' ? 'value' : 'signal';

  return (
    <MockDialog
      title={
        editing
          ? `Edit ${stepRef(editing)} · ${editing.name}`
          : KIND[kind].title
      }
      subtitle={`${KIND[kind].verb} · ${subject}`}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <span
            className={error || applyError ? 'mk-error' : 'mk-muted'}
            role={error || applyError ? 'alert' : undefined}
          >
            {error ||
              applyError ||
              `${count} ${outputWord}${count === 1 ? '' : 's'} · ${describe()}${
                editing ? ' · dependent steps are rebuilt' : ''
              }`}
          </span>
          <button className="mk-button mk-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="mk-button mk-primary"
            disabled={!!error}
            onClick={() => {
              if (typeof recipe !== 'string')
                setApplyError(onApply(recipe, finalName) ?? '');
            }}
          >
            <Icon size={14} />
            {editing
              ? 'Update and rebuild'
              : `Create ${count} ${outputWord}${count === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="mk-op-layout">
        <div className="mk-op-settings">
          <div className="mk-op-inputs">
            <span className="mk-label">Inputs</span>
            <div>
              {inputs.slice(0, 6).map((id) => (
                <span key={id} className="mk-chip">
                  <Activity size={12} />
                  {ws.outputs.get(id)?.label}
                </span>
              ))}
              {inputs.length > 6 && (
                <span className="mk-chip">+{inputs.length - 6} more</span>
              )}
            </div>
          </div>

          {kind === 'derive' && (
            <>
              <fieldset className="mk-choice-grid">
                <legend className="mk-label">Function</legend>
                {DERIVE.map((item) => (
                  <button
                    key={item.op}
                    aria-pressed={op === item.op}
                    onClick={() => {
                      setOp(item.op);
                      if (DEFAULTS[item.op] !== undefined)
                        setParam(String(DEFAULTS[item.op]));
                    }}
                  >
                    <code>{item.formula}</code>
                    <span>{item.name}</span>
                  </button>
                ))}
              </fieldset>
              {DERIVE.find((item) => item.op === op)?.param && (
                <label className="mk-form-field">
                  <span className="mk-label">
                    {DERIVE.find((item) => item.op === op)!.param}
                  </span>
                  <input
                    type="number"
                    value={param}
                    step={op === 'smooth' ? 2 : 'any'}
                    min={op === 'smooth' ? 1 : undefined}
                    onChange={(event) => setParam(event.target.value)}
                  />
                </label>
              )}
              {op === 'multiply' && (
                <label className="mk-form-field">
                  <span className="mk-label">Input B</span>
                  <select
                    value={by}
                    onChange={(event) => setBy(event.target.value)}
                  >
                    {signals.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label} [{item.unit}]
                      </option>
                    ))}
                  </select>
                  <small className="mk-muted">
                    B is interpolated onto each A sample where both exist.
                  </small>
                </label>
              )}
            </>
          )}

          {kind === 'segment' && (
            <>
              <fieldset className="mk-choice-grid" data-columns="2">
                <legend className="mk-label">Method</legend>
                <button
                  aria-pressed={mode === 'ranges'}
                  onClick={() => setMode('ranges')}
                >
                  <code>a–b, c–d</code>
                  <span>Time ranges</span>
                </button>
                <button
                  aria-pressed={mode === 'windows'}
                  onClick={() => setMode('windows')}
                >
                  <code>every L s</code>
                  <span>Windows</span>
                </button>
              </fieldset>
              {mode === 'ranges' ? (
                <label className="mk-form-field">
                  <span className="mk-label">Ranges (s)</span>
                  <textarea
                    rows={3}
                    value={ranges}
                    onChange={(event) => setRanges(event.target.value)}
                  />
                  <small className="mk-muted">
                    Comma or line separated. Each input is cut independently and
                    clipped to its available interval.
                  </small>
                </label>
              ) : (
                <label className="mk-form-field">
                  <span className="mk-label">Window length (s)</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={windowLength}
                    onChange={(event) => setWindowLength(event.target.value)}
                  />
                </label>
              )}
            </>
          )}

          {kind === 'value' && (
            <fieldset className="mk-choice-grid" data-columns="3">
              <legend className="mk-label">Function</legend>
              {(['Time average', 'Maximum', 'Minimum'] as const).map((item) => (
                <button
                  key={item}
                  aria-pressed={fn === item}
                  onClick={() => setFn(item)}
                >
                  <code>
                    {item === 'Time average'
                      ? '∫A dt ÷ T'
                      : item === 'Maximum'
                        ? 'max A'
                        : 'min A'}
                  </code>
                  <span>{item}</span>
                </button>
              ))}
            </fieldset>
          )}

          {kind === 'compare' && (
            <label className="mk-form-field">
              <span className="mk-label">Time shift (s)</span>
              <input
                type="number"
                step="any"
                value={shift}
                onChange={(event) => setShift(event.target.value)}
              />
              <small className="mk-muted">
                Moves each signal onto another recording&apos;s clock. Values
                are unchanged; the new signals keep their full lineage.
              </small>
            </label>
          )}

          <label className="mk-form-field">
            <span className="mk-label">Operation name</span>
            <input
              value={name}
              placeholder={defaultName}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <div className="mk-op-preview">
          <span className="mk-label">
            Preview
            {first && inputs.length > 1
              ? ` · first input of ${inputs.length}`
              : ''}
          </span>
          {kind === 'value' && (
            <ul className="mk-preview-values">
              {drafts.slice(0, 6).map((draft, k) => (
                <li key={k}>
                  <span>{draft.label}</span>
                  <strong>
                    {draft.kind === 'value' ? formatExact(draft.value) : ''}{' '}
                    <small>{draft.unit}</small>
                  </strong>
                </li>
              ))}
            </ul>
          )}
          <div className="mk-op-chart">
            {traces.length ? (
              <MockupChart
                traces={traces}
                references={references}
                layout="overlay"
                tool="zoom"
                grid
                holdY={false}
                fitKey={0}
                timeLabel="Recording time (s)"
              />
            ) : (
              <p className="mk-empty">No signal to preview.</p>
            )}
          </div>
        </div>
      </div>
    </MockDialog>
  );
}

export function DeleteDialog({
  ws,
  step,
  onConfirm,
  onClose,
}: {
  ws: Workspace;
  step: MockStep;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const later = dependents(ws, step.id);
  const outputs = [step, ...later].reduce(
    (sum, item) => sum + item.outputs.length,
    0,
  );
  return (
    <MockDialog
      title={`Delete ${stepRef(step)} ${step.name}?`}
      subtitle={
        step.recipe.op === 'import'
          ? 'Removes this recording and everything calculated from it.'
          : 'Removes the operation and every operation that depends on it.'
      }
      onClose={onClose}
      size="small"
      footer={
        <>
          <span className="mk-muted">Undo restores all of it.</span>
          <button className="mk-button mk-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="mk-button mk-danger-solid" onClick={onConfirm}>
            <Trash2 size={14} />
            Delete {later.length + 1} step{later.length ? 's' : ''}
          </button>
        </>
      }
    >
      <ul className="mk-impact">
        {[step, ...later].map((item) => (
          <li key={item.id}>
            <code>{stepRef(item)}</code>
            <span>{item.name}</span>
            <small>
              {item.outputs.length} output{item.outputs.length === 1 ? '' : 's'}
            </small>
          </li>
        ))}
      </ul>
      <p className="mk-muted">
        {outputs} output{outputs === 1 ? '' : 's'} in total. Operations that
        only share a parent are not affected.
      </p>
    </MockDialog>
  );
}

export function GuideDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Ctrl K', 'Search outputs and run commands'],
    ['Ctrl Z / Ctrl Y', 'Undo / redo'],
    ['F2', 'Rename the selection'],
    ['Delete', 'Delete the selected operation'],
    ['Arrow keys on the plot', 'Move the cursor; + / − zoom; 0 fits'],
    ['Drag an output onto a plot', 'Add it to a saved plot'],
  ];
  return (
    <MockDialog
      title="Guide"
      subtitle="Stratum workflow basics"
      onClose={onClose}
    >
      <ol className="mk-guide">
        <li>
          <strong>Select</strong> a step or output in History to plot it.
        </li>
        <li>
          <strong>Choose inputs</strong>: the viewed signals are used unless you
          check outputs in the table. “Apply to” shows what will run.
        </li>
        <li>
          <strong>Derive, Segment or Value</strong> creates a new step; Edit
          rebuilds it and everything that depends on it.
        </li>
      </ol>
      <dl className="mk-shortcuts">
        {rows.map(([keys, text]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </MockDialog>
  );
}

export type PaletteItem = {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
};

export function CommandPalette({
  items,
  onClose,
}: {
  items: PaletteItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Every typed word must appear, in any order.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items
    .filter((item) => {
      const text = `${item.label} ${item.hint}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 12);
  const current = Math.min(active, Math.max(0, shown.length - 1));
  function run(item?: PaletteItem) {
    if (!item) return;
    onClose();
    item.run();
  }
  return (
    <MockDialog title="Search and commands" onClose={onClose}>
      <input
        className="mk-palette-input"
        data-autofocus
        placeholder="Type a signal, step or command…"
        aria-label="Search outputs, steps and commands"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(Math.min(shown.length - 1, current + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(Math.max(0, current - 1));
          } else if (event.key === 'Enter') run(shown[current]);
        }}
      />
      <ul className="mk-palette">
        {shown.map((item, index) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                data-active={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(item)}
              >
                <Icon size={14} />
                <span>{item.label}</span>
                <small>{item.hint}</small>
                <ArrowRight size={13} />
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="mk-muted">No matches.</li>}
      </ul>
    </MockDialog>
  );
}
