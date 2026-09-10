'use client';
import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { RegionSelect } from './region-controls';
import { WorkflowIndex } from '@/lib/workflow-history';
import { reportHtml, valuesCsv } from '@/lib/workflow-delivery';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';
import type { WorkflowStep } from '@/lib/workflow-types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  viewedId?: string;
  checkedIds: string[];
  step?: WorkflowStep;
  request: (message: EngineRequest) => Promise<EngineResponse>;
  cancel: () => void;
  onSaved: (filename: string) => void;
};

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
        <DialogTitle>Export results or create a report</DialogTitle>
        <DialogDescription>
          Choose exactly what to include. Exports keep the original signals and
          workflow unchanged.
        </DialogDescription>
        <ExportForm {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
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
  const [scope, setScope] = useState(
    viewedId ? 'viewed' : checkedIds.length ? 'checked' : 'step',
  );
  const ids =
    scope === 'viewed' && viewedId
      ? [viewedId]
      : scope === 'checked'
        ? checkedIds
        : (step?.outputIds ?? []);
  const allValues = ids.length > 0 && ids.every((id) => index.values.has(id));
  const [format, setFormat] = useState('csv');
  const resolvedFormat =
    format === 'csv' ? (allValues ? 'values' : 'samples') : format;
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const filename = `Stratus-${resolvedFormat}-${ids.length}.${format === 'report' ? 'html' : 'csv'}`;
  const description =
    resolvedFormat === 'values'
      ? 'One row per calculated value, with its input, unit, calculation and sample coverage.'
      : resolvedFormat === 'samples'
        ? 'Every evaluated sample. Columns: signal, ID, recording, unit, time (s), value. Each signal keeps its own time axis; missing values are blank.'
        : resolvedFormat === 'summary'
          ? 'One summary row per signal: minimum, maximum, sample average and time integral. Individual samples are not included.'
          : 'A standalone HTML report with selected results, signal plots and contributing history. Open it in a browser to print or save as PDF.';

  async function download() {
    if (!ids.length) return;
    setBusy(true);
    setError('');
    cancelled.current = false;
    try {
      let blob: Blob;
      if (resolvedFormat === 'values')
        blob = new Blob([valuesCsv(project, ids)], {
          type: 'text/csv;charset=utf-8',
        });
      else if (resolvedFormat === 'report') {
        const signalIds = ids.filter((id) => index.nodes.has(id));
        const response = await request({ type: 'view', ids: signalIds });
        if (response.type !== 'plots')
          throw new Error('Could not prepare report plots.');
        blob = new Blob([reportHtml(project, ids, response.plots)], {
          type: 'text/html;charset=utf-8',
        });
      } else {
        const response = await request({
          type: resolvedFormat === 'samples' ? 'export-samples' : 'export',
          ids,
        });
        if (response.type !== 'export')
          throw new Error('Could not prepare the export.');
        blob = response.blob;
      }
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
          : caught instanceof Error
            ? caught.message
            : 'Export failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-export-form">
      <fieldset disabled={busy}>
        <RegionSelect
          label="Include"
          value={scope}
          items={[
            ...(viewedId
              ? [
                  {
                    value: 'viewed',
                    label: `Viewed ${index.values.has(viewedId) ? 'value' : 'signal'} · 1 output`,
                  },
                ]
              : []),
            ...(checkedIds.length
              ? [
                  {
                    value: 'checked',
                    label: `Checked signals · ${checkedIds.length} outputs`,
                  },
                ]
              : []),
            ...(step?.outputIds.length
              ? [
                  {
                    value: 'step',
                    label: `All outputs from #${String(step.sequence + 1).padStart(3, '0')} · ${step.outputIds.length} outputs`,
                  },
                ]
              : []),
          ]}
          onChange={(value) => {
            setScope(value);
            setFormat('csv');
            setError('');
          }}
        />
        <RegionSelect
          label="File format"
          value={format}
          items={[
            { value: 'csv', label: allValues ? 'Values CSV' : 'Samples CSV' },
            ...(!allValues
              ? [{ value: 'summary', label: 'Signal summary CSV' }]
              : []),
            { value: 'report', label: 'Printable report (HTML)' },
          ]}
          onChange={setFormat}
        />
      </fieldset>
      <p>{description}</p>
      {resolvedFormat === 'samples' && (
        <p className="workflow-muted">
          Samples CSV is limited to 64 MiB per file. For larger recordings,
          export shorter segments or fewer signals.
        </p>
      )}
      <div className="workflow-export-preview">
        <strong>
          {ids.length} {allValues ? 'values' : 'signals'} included
        </strong>
        <ul>
          {ids.slice(0, 30).map((id) => (
            <li key={id}>{index.label(id)}</li>
          ))}
        </ul>
        {ids.length > 30 && (
          <small>And {ids.length - 30} more outputs in this scope.</small>
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
          {busy ? 'Preparing file…' : 'Download file'}
        </button>
      </div>
    </div>
  );
}
