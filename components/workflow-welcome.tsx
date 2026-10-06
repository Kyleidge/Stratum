'use client';
import { useState } from 'react';
import {
  ArrowRight,
  Compass,
  FileSpreadsheet,
  Hash,
  ListChecks,
  Scissors,
  Upload,
  Waves,
} from 'lucide-react';
import { CSV_FORMAT_EXAMPLE } from '@/lib/csv-import-messages';
import { WorkflowAlert } from '@/components/workflow-alert';

/**
 * The empty workspace: what Stratum is for and three ways to start. Dropped
 * CSV files are imported by the workspace's own drop handler.
 */
export function WorkflowWelcome({
  busy,
  error,
  onDismissError,
  onExample,
  onImport,
  onBatchExample,
}: {
  busy: boolean;
  error: string;
  onDismissError: () => void;
  onExample: () => void;
  onImport: () => void;
  onBatchExample: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <section
      className="workflow-welcome"
      aria-labelledby="workflow-welcome-title"
    >
      <header className="workflow-welcome-header">
        <Waves size={28} aria-hidden />
        <h1 id="workflow-welcome-title">
          Turn test recordings into traceable results
        </h1>
        <p>
          Every result keeps the steps that made it, back to the original
          recording. Your data stays on this device.
        </p>
      </header>
      <ol className="workflow-welcome-flow" aria-label="How Stratum works">
        <li>
          <Upload size={15} aria-hidden />
          <strong>Import</strong>
          <span>a CSV recording</span>
        </li>
        <li aria-hidden className="workflow-welcome-arrow">
          <ArrowRight size={14} />
        </li>
        <li>
          <Waves size={15} aria-hidden />
          <strong>Process</strong>
          <span>derive and segment signals</span>
        </li>
        <li aria-hidden className="workflow-welcome-arrow">
          <ArrowRight size={14} />
        </li>
        <li>
          <Hash size={15} aria-hidden />
          <strong>Measure</strong>
          <span>values you can trace</span>
        </li>
      </ol>
      {error && (
        <WorkflowAlert
          message={error}
          onDismiss={onDismissError}
          className="workflow-welcome-alert"
        />
      )}
      <div className="workflow-welcome-cards">
        <article className="workflow-welcome-card" data-kind="example">
          <Compass size={22} aria-hidden />
          <h2>
            <button
              type="button"
              disabled={busy}
              aria-describedby="workflow-welcome-example"
              onClick={onExample}
            >
              Explore the example recording
            </button>
          </h2>
          <p id="workflow-welcome-example">
            A motor test with seven steps: smooth and multiply signals, split
            them into runs and measure each one. A short tour explains each
            step.
          </p>
          <ul className="workflow-welcome-tags" aria-label="Example contents">
            <li>1 recording</li>
            <li>7 steps</li>
            <li>3 runs</li>
            <li>5 values</li>
          </ul>
        </article>
        <div
          className="workflow-welcome-card"
          data-kind="import"
          data-dragging={dragging || undefined}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={() => setDragging(false)}
        >
          <FileSpreadsheet size={22} aria-hidden />
          <h2>
            <button
              type="button"
              disabled={busy}
              aria-describedby="workflow-welcome-import"
              onClick={onImport}
            >
              Import a CSV
            </button>
          </h2>
          <div id="workflow-welcome-import">
            <p>
              Time in seconds first, then one column per signal with its unit in
              brackets:
            </p>
            <code>{CSV_FORMAT_EXAMPLE},…</code>
            <p className="workflow-welcome-drop">
              <Upload size={13} aria-hidden /> Or drop .csv files here
            </p>
          </div>
        </div>
      </div>
      <article className="workflow-welcome-card" data-kind="batch">
        <ListChecks size={20} aria-hidden />
        <div>
          <h2>
            <button
              type="button"
              disabled={busy}
              aria-describedby="workflow-welcome-batch"
              onClick={onBatchExample}
            >
              Test many recordings
            </button>
          </h2>
          <p id="workflow-welcome-batch">
            Run one saved workflow on eight motor recordings and compare their
            pass and fail checks.
          </p>
        </div>
      </article>
    </section>
  );
}

/** Shown while a workspace holds only imports: what to try next. */
export function WorkflowNextSteps({
  disabled,
  onAction,
}: {
  disabled: boolean;
  onAction: (action: 'derive' | 'segment' | 'value') => void;
}) {
  const actions = [
    {
      action: 'derive',
      label: 'Derive',
      icon: <Waves size={14} aria-hidden />,
      text: 'Calculate a new signal.',
    },
    {
      action: 'segment',
      label: 'Segment',
      icon: <Scissors size={14} aria-hidden />,
      text: 'Cut signals into runs.',
    },
    {
      action: 'value',
      label: 'Value',
      icon: <Hash size={14} aria-hidden />,
      text: 'Measure an average or peak.',
    },
  ] as const;
  return (
    <section className="workflow-next-steps" aria-label="Next steps">
      <strong>Next:</strong>
      {actions.map((item) => (
        <button
          key={item.action}
          type="button"
          className="workflow-next-step"
          disabled={disabled}
          onClick={() => onAction(item.action)}
        >
          {item.icon}
          <span>{item.label}…</span>
          <small>{item.text}</small>
        </button>
      ))}
    </section>
  );
}
