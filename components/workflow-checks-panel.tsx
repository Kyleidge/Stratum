'use client';
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  CHECK_NAMES,
  currentResults,
  describeLimits,
  STATUS_LABELS,
} from '@/lib/workflow-checks';
import { StatusIcon } from './workflow-batch-view';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type {
  CheckDefinition,
  CheckKind,
  WorkflowStep,
} from '@/lib/workflow-types';

type Draft = {
  kind: CheckKind;
  min: string;
  max: string;
  unit: string;
  outputs: string;
  severity: 'warning' | 'fail';
  message: string;
};

const blank = (unit: string, values: boolean): Draft => ({
  kind: values ? 'limits' : 'count',
  min: '',
  max: '',
  unit,
  outputs: '',
  severity: 'fail',
  message: '',
});

function toDraft(check: CheckDefinition): Draft {
  const scale = check.kind === 'missing' ? 100 : 1;
  const text = (value?: number) =>
    value === undefined ? '' : String(value * scale);
  return {
    kind: check.kind,
    min: text(check.min),
    max: text(check.max),
    unit: check.unit ?? '',
    outputs: check.outputs?.join(', ') ?? '',
    severity: check.severity,
    message: check.message ?? '',
  };
}

function fromDraft(draft: Draft): CheckDefinition {
  const scale = draft.kind === 'missing' ? 100 : 1;
  const number = (text: string, name: string) => {
    if (!text.trim()) return undefined;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`Enter a number for ${name}.`);
    return value / scale;
  };
  const check: CheckDefinition = { kind: draft.kind, severity: draft.severity };
  const min = number(draft.min, 'the minimum');
  const max = number(draft.max, 'the maximum');
  if (min !== undefined) check.min = min;
  if (max !== undefined) check.max = max;
  if (min === undefined && max === undefined)
    throw new Error('Enter a minimum, a maximum or both.');
  if (draft.kind === 'limits' && draft.unit.trim())
    check.unit = draft.unit.trim();
  if (draft.kind !== 'count' && draft.outputs.trim()) {
    const outputs = draft.outputs
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (!outputs.every((item) => Number.isSafeInteger(item) && item >= 1))
      throw new Error('List output positions such as 1, 3.');
    check.outputs = outputs;
  }
  if (draft.message.trim()) check.message = draft.message.trim();
  return check;
}

/** Checks are expectations on a step's outputs; failures flag the step. */
export default function WorkflowChecksPanel({
  step,
  index,
  busy,
  onSave,
}: {
  step: WorkflowStep;
  index: WorkflowIndex;
  busy: boolean;
  onSave: (checks: CheckDefinition[]) => Promise<void>;
}) {
  const values = step.kind === 'value';
  const unit =
    index.values.get(step.outputIds[0])?.unit ??
    index.nodes.get(step.outputIds[0])?.unit ??
    '';
  const checks = step.checks ?? [];
  const results = currentResults(step);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(() => blank(unit, values));
  const [error, setError] = useState('');
  const kinds: CheckKind[] = values
    ? ['count', 'limits']
    : ['count', 'limits', 'missing', 'duration'];
  async function save(next: CheckDefinition[]) {
    setError('');
    try {
      await onSave(next);
      setEditing(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not save the check.',
      );
    }
  }
  const form = (
    <form
      className="workflow-check-form"
      onSubmit={(event) => {
        event.preventDefault();
        let check: CheckDefinition;
        try {
          check = fromDraft(draft);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Invalid check.');
          return;
        }
        void save(
          editing === 'new'
            ? [...checks, check]
            : checks.map((item, position) =>
                position === editing ? check : item,
              ),
        );
      }}
    >
      <label>
        <span>Check</span>
        <select
          value={draft.kind}
          onChange={(event) =>
            setDraft({ ...draft, kind: event.target.value as CheckKind })
          }
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind === 'count'
                ? 'Number of outputs'
                : kind === 'limits'
                  ? values
                    ? 'Value limits'
                    : 'Sample limits'
                  : kind === 'missing'
                    ? 'Missing samples (%)'
                    : 'Duration (s)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Minimum</span>
        <input
          inputMode="decimal"
          value={draft.min}
          onChange={(event) => setDraft({ ...draft, min: event.target.value })}
        />
      </label>
      <label>
        <span>Maximum</span>
        <input
          inputMode="decimal"
          value={draft.max}
          onChange={(event) => setDraft({ ...draft, max: event.target.value })}
        />
      </label>
      {draft.kind === 'limits' && (
        <label>
          <span>Unit</span>
          <input
            value={draft.unit}
            placeholder={unit}
            onChange={(event) =>
              setDraft({ ...draft, unit: event.target.value })
            }
          />
        </label>
      )}
      {draft.kind !== 'count' && step.outputIds.length > 1 && (
        <label>
          <span>Outputs</span>
          <input
            value={draft.outputs}
            placeholder="All"
            onChange={(event) =>
              setDraft({ ...draft, outputs: event.target.value })
            }
          />
        </label>
      )}
      <label>
        <span>When outside</span>
        <select
          value={draft.severity}
          onChange={(event) =>
            setDraft({
              ...draft,
              severity: event.target.value as Draft['severity'],
            })
          }
        >
          <option value="fail">Fail</option>
          <option value="warning">Warn</option>
        </select>
      </label>
      <label className="workflow-check-wide">
        <span>Message</span>
        <input
          value={draft.message}
          maxLength={300}
          placeholder="Shown with the result, such as “Torque is out of range.”"
          onChange={(event) =>
            setDraft({ ...draft, message: event.target.value })
          }
        />
      </label>
      <div className="workflow-check-wide workflow-check-actions">
        <button
          type="button"
          className="workflow-link"
          onClick={() => setEditing(null)}
        >
          Cancel
        </button>
        <button type="submit" className="secondary-button" disabled={busy}>
          Save check
        </button>
      </div>
    </form>
  );
  return (
    <section className="workflow-checks-panel">
      <h3>
        Checks {!!checks.length && <span>{checks.length}</span>}
        {editing === null && (
          <button
            className="workflow-link"
            disabled={busy}
            onClick={() => {
              setDraft(blank(unit, values));
              setError('');
              setEditing('new');
            }}
          >
            <Plus size={12} /> Add check
          </button>
        )}
      </h3>
      {!checks.length && editing === null && (
        <p className="workflow-muted">
          Add limits or an expected number of outputs. Failures are flagged
          here, in History and in batch results.
        </p>
      )}
      <ul>
        {checks.map((check, position) => {
          const own = results.filter((result) => result.check === position);
          const failing = own.filter((result) => result.status !== 'pass');
          return (
            <li
              key={position}
              data-status={
                failing[0]?.status ?? (own.length ? 'pass' : undefined)
              }
            >
              <div className="workflow-check-row">
                {own.length ? (
                  <StatusIcon status={failing[0]?.status ?? 'pass'} size={13} />
                ) : null}
                <strong>{CHECK_NAMES[check.kind]}</strong>
                <span>{describeLimits(check, unit)}</span>
                <small>{check.severity === 'fail' ? 'fails' : 'warns'}</small>
                <button
                  className="workflow-icon-button workflow-quiet"
                  aria-label={`Edit ${CHECK_NAMES[check.kind]} check`}
                  disabled={busy}
                  onClick={() => {
                    setDraft(toDraft(check));
                    setError('');
                    setEditing(position);
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  className="workflow-icon-button workflow-quiet"
                  aria-label={`Remove ${CHECK_NAMES[check.kind]} check`}
                  disabled={busy}
                  onClick={() =>
                    void save(checks.filter((_, item) => item !== position))
                  }
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {editing === position
                ? form
                : (failing.length ? failing : own.slice(0, 1))
                    .slice(0, 4)
                    .map((result, item) => (
                      <p
                        key={item}
                        className="workflow-check-result"
                        data-status={result.status}
                      >
                        <span className="sr-only">
                          {STATUS_LABELS[result.status]}:{' '}
                        </span>
                        {result.message}
                      </p>
                    ))}
              {editing !== position && failing.length > 4 && (
                <p className="workflow-muted">+{failing.length - 4} more</p>
              )}
            </li>
          );
        })}
      </ul>
      {editing === 'new' && form}
      {error && (
        <p className="workflow-batch-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
