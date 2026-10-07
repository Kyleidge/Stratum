'use client';
import { useRef, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { stepName, WorkflowIndex } from '@/lib/workflow-history';
import {
  exportFileName,
  reportHtml,
  valuesCsv,
  type ExportKind,
} from '@/lib/workflow-delivery';
import { formatCount } from '@/lib/format-count';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';
import {
  desktopBridge,
  fileErrorMessage,
  streamToNativeFile,
} from '@/lib/desktop-bridge';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  viewedId?: string;
  checkedIds: string[];
  step?: WorkflowStep;
  request: (
    message: EngineRequest,
    transfer?: Transferable[],
  ) => Promise<EngineResponse>;
  cancel: () => void;
  /** `saved` is true when a native file was written, not a download. */
  onSaved: (filename: string, saved?: boolean) => void;
};

type Scope = 'viewed' | 'checked' | 'step';
type Format = 'csv' | 'summary' | 'report';

export default function WorkflowExport(props: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent className="workflow-dialog" showCloseButton={!busy}>
        <DialogTitle>Export data</DialogTitle>
        <DialogDescription>
          Download exact results as a file. Exporting never changes your
          recordings or steps.
        </DialogDescription>
        <ExportForm {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

/** One choice of a radio group, shown as a card with a plain description. */
function Choice({
  name,
  value,
  checked,
  title,
  children,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  title: string;
  children: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="workflow-choice-card" data-checked={checked}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      <strong>{title}</strong>
      <small>{children}</small>
    </label>
  );
}

function ExportForm({
  project,
  viewedId,
  checkedIds,
  step,
  request,
  cancel,
  onSaved,
  onOpenChange,
  busy,
  setBusy,
}: Props & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const index = new WorkflowIndex(project);
  const [scope, setScope] = useState<Scope>(
    viewedId ? 'viewed' : checkedIds.length ? 'checked' : 'step',
  );
  const ids =
    scope === 'viewed' && viewedId
      ? [viewedId]
      : scope === 'checked'
        ? checkedIds
        : (step?.outputIds ?? []);
  const allValues = ids.length > 0 && ids.every((id) => index.values.has(id));
  const [format, setFormat] = useState<Format>('csv');
  const kind: ExportKind =
    format === 'csv' ? (allValues ? 'values' : 'samples') : format;
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const stepRef = step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';
  const viewedKind =
    viewedId && index.values.has(viewedId) ? 'value' : 'signal';
  const checkedNoun = checkedIds.every((id) => index.values.has(id))
    ? 'value'
    : 'signal';
  const scopeName =
    scope === 'viewed' && viewedId
      ? index.label(viewedId)
      : scope === 'checked'
        ? `checked ${formatCount(checkedIds.length, checkedNoun)}`
        : step
          ? `${stepRef} ${stepName(step)}`
          : '';
  const filename = exportFileName(project, ids, scopeName, kind);

  async function download() {
    if (!ids.length) return;
    setBusy(true);
    setError('');
    cancelled.current = false;
    try {
      const bridge = desktopBridge();
      if (bridge && kind === 'samples') {
        // Desktop: stream straight to the chosen file, with no size limit.
        const file = await bridge.saveFile({
          kind: 'csv',
          defaultName: filename,
          title: 'Export samples CSV',
        });
        if (!file) return;
        // Cancelling before or during the request leaves no file behind:
        // throwing here makes the bridge discard the partial file.
        const guarded: typeof request = async (message, transfer) => {
          if (cancelled.current) throw new Error('Export cancelled.');
          const response = await request(message, transfer);
          if (cancelled.current) throw new Error('Export cancelled.');
          return response;
        };
        await streamToNativeFile(bridge, file, guarded, (stream) => ({
          type: 'export-samples',
          ids,
          stream,
        }));
        onSaved(file.name, true);
        onOpenChange(false);
        return;
      }
      let blob: Blob;
      if (kind === 'values')
        blob = new Blob([valuesCsv(project, ids)], {
          type: 'text/csv;charset=utf-8',
        });
      else if (kind === 'report') {
        const signalIds = ids.filter((id) => index.nodes.has(id));
        const response = await request({ type: 'view', ids: signalIds });
        if (response.type !== 'plots')
          throw new Error('Could not prepare the summary plots.');
        blob = new Blob([reportHtml(project, ids, response.plots)], {
          type: 'text/html;charset=utf-8',
        });
      } else {
        const response = await request({
          type: kind === 'samples' ? 'export-samples' : 'export',
          ids,
        });
        if (response.type !== 'export')
          throw new Error('Could not prepare the export.');
        blob = response.blob;
      }
      // A cancelled request may still resolve; it must never download.
      if (cancelled.current)
        throw new Error('Export cancelled. No file was downloaded.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      onSaved(filename);
      onOpenChange(false);
    } catch (caught) {
      setError(
        cancelled.current
          ? 'Export cancelled. No file was downloaded.'
          : fileErrorMessage(caught, 'Export failed. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  }
  const chooseScope = (value: string) => {
    setScope(value as Scope);
    setFormat('csv');
    setError('');
  };
  return (
    <div className="workflow-export-form">
      <fieldset disabled={busy} className="workflow-export-choices">
        <legend>What to export</legend>
        {viewedId && (
          <Choice
            name="export-scope"
            value="viewed"
            checked={scope === 'viewed'}
            title={`This ${viewedKind}`}
            onChange={chooseScope}
          >
            {index.label(viewedId)}
          </Choice>
        )}
        {checkedIds.length > 0 && (
          <Choice
            name="export-scope"
            value="checked"
            checked={scope === 'checked'}
            title={`Checked (${checkedIds.length})`}
            onChange={chooseScope}
          >
            The {formatCount(checkedIds.length, checkedNoun)} checked in History
          </Choice>
        )}
        {!!step?.outputIds.length && (
          <Choice
            name="export-scope"
            value="step"
            checked={scope === 'step'}
            title={`Whole step ${stepRef}`}
            onChange={chooseScope}
          >
            {stepName(step)} · {formatCount(step.outputIds.length, 'output')}
          </Choice>
        )}
      </fieldset>
      <fieldset disabled={busy} className="workflow-export-choices">
        <legend>Format</legend>
        {allValues ? (
          <Choice
            name="export-format"
            value="csv"
            checked={format === 'csv'}
            title="Values table (CSV)"
            onChange={(value) => setFormat(value as Format)}
          >
            One row per value with its unit, calculation and input. Exact
            numbers, for spreadsheets.
          </Choice>
        ) : (
          <>
            <Choice
              name="export-format"
              value="csv"
              checked={format === 'csv'}
              title="Every sample (CSV)"
              onChange={(value) => setFormat(value as Format)}
            >
              Time and value of every sample, exactly as evaluated. Missing
              samples stay blank.{' '}
              {desktopBridge()
                ? 'Written straight to disk, with no size limit.'
                : 'Up to 64 MiB per file in the browser.'}
            </Choice>
            <Choice
              name="export-format"
              value="summary"
              checked={format === 'summary'}
              title="Summary per signal (CSV)"
              onChange={(value) => setFormat(value as Format)}
            >
              Minimum, maximum, average and time integral of each signal, one
              row per signal.
            </Choice>
          </>
        )}
        <Choice
          name="export-format"
          value="report"
          checked={format === 'report'}
          title="Quick HTML summary"
          onChange={(value) => setFormat(value as Format)}
        >
          A single web page with results, simple plots and the steps behind
          them, to view or print. For a designed PDF, use Add to report.
        </Choice>
      </fieldset>
      <div className="workflow-export-preview">
        <strong>
          {formatCount(ids.length, allValues ? 'value' : 'signal')} included
        </strong>
        <ul>
          {ids.slice(0, 30).map((id) => (
            <li key={id}>{index.label(id)}</li>
          ))}
        </ul>
        {ids.length > 30 && (
          <small>And {formatCount(ids.length - 30, 'more output')}.</small>
        )}
        <p>
          File: <b>{filename}</b>
        </p>
      </div>
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      <div className="workflow-export-actions">
        {busy ? (
          <button
            className="secondary-button"
            onClick={() => {
              cancelled.current = true;
              cancel();
            }}
          >
            Cancel export
          </button>
        ) : (
          <button
            className="secondary-button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
        )}
        <button
          className="primary-button"
          disabled={busy || !ids.length}
          onClick={() => void download()}
        >
          <Download size={16} />
          {busy
            ? 'Preparing file…'
            : kind === 'samples' && desktopBridge()
              ? 'Save file…'
              : 'Download file'}
        </button>
      </div>
    </div>
  );
}
