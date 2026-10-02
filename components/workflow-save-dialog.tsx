'use client';
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, Play, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { RegionSelect } from './region-controls';
import { stepName } from '@/lib/workflow-history';
import {
  itemIdFromFileName,
  parseWorkflow,
  serializeWorkflow,
  WORKFLOW_EXTENSION,
  type TimeOrigin,
} from '@/lib/workflow-recipe';
import {
  extractWorkflow,
  recordingSteps,
  type ExtractedWorkflow,
} from '@/lib/workflow-extract';
import { templateFromReport } from '@/lib/workflow-report-template';
import { downloadBlob } from '@/lib/workflow-batch';
import type { Project } from '@/lib/signal-types';
import type { ReportDocument } from '@/lib/report-mockup';

const ORIGINS: { value: TimeOrigin; label: string }[] = [
  { value: 'recording', label: 'Recording time (as saved)' },
  { value: 'recording-start', label: 'From the recording start' },
  { value: 'input-start', label: 'From its input’s start' },
];
type SaveResult =
  | { error: string }
  | { extracted: ExtractedWorkflow; problems: string[]; text: string };
const reference = (sequence: number) =>
  `#${String(sequence + 1).padStart(3, '0')}`;

/** Save the steps derived from one recording as a portable workflow file. */
export default function WorkflowSaveDialog({
  open,
  onOpenChange,
  project,
  initialSourceId,
  report,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  initialSourceId?: string;
  report: () => ReportDocument | undefined;
  onRun: (text: string, fileName: string) => void;
}) {
  const sources = project.sources;
  const [sourceId, setSourceId] = useState(
    initialSourceId && sources.some((source) => source.id === initialSourceId)
      ? initialSourceId
      : (sources[0]?.id ?? ''),
  );
  const source = sources.find((item) => item.id === sourceId) ?? sources[0];
  const [name, setName] = useState('');
  const [revision, setRevision] = useState('1');
  const [itemLabel, setItemLabel] = useState('Serial number');
  const [pattern, setPattern] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [origins, setOrigins] = useState<Record<string, TimeOrigin>>({});
  const [includeReport, setIncludeReport] = useState(true);
  const draft = useMemo(() => (open ? report() : undefined), [open, report]);
  const blockCount =
    draft?.pages.reduce((sum, page) => sum + page.blocks.length, 0) ?? 0;
  const candidates = useMemo(
    () => (source ? recordingSteps(project, source.id) : []),
    [project, source],
  );
  const workflowName =
    name.trim() || (source ? source.name.replace(/\.[^.]*$/, '') : 'Workflow');
  const result = useMemo((): SaveResult => {
    if (!source) return { error: 'Import a recording first.' };
    try {
      new RegExp(pattern || '.', 'u');
    } catch {
      return {
        error: 'The item ID pattern is not a valid regular expression.',
      };
    }
    try {
      const extracted = extractWorkflow(project, source.id, {
        name: workflowName,
        revision: revision.trim() || undefined,
        itemLabel: itemLabel.trim() || 'Item',
        pattern: pattern.trim() || undefined,
        stepIds: new Set(
          candidates
            .filter((step) => !excluded.has(step.id))
            .map((step) => step.id),
        ),
        timeOrigins: origins,
      });
      let problems: string[] = [];
      if (includeReport && draft && blockCount) {
        const converted = templateFromReport(draft, extracted.refs, [
          source.name,
        ]);
        problems = converted.problems;
        if (converted.template.pages.some((page) => page.blocks.length))
          extracted.recipe.report = converted.template;
      }
      const text = serializeWorkflow(extracted.recipe);
      // Never offer a file Stratum could not open again.
      parseWorkflow(text);
      return { extracted, problems, text };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This workflow cannot be saved.',
      };
    }
  }, [
    project,
    source,
    workflowName,
    revision,
    itemLabel,
    pattern,
    candidates,
    excluded,
    origins,
    includeReport,
    draft,
    blockCount,
  ]);
  const fileName = `${workflowName.replace(/[\\/:*?"<>|]/g, '_')}${WORKFLOW_EXTENSION}`;
  let preview = '';
  try {
    preview = source
      ? itemIdFromFileName(
          { item: { label: itemLabel, pattern: pattern.trim() || undefined } },
          source.name,
        )
      : '';
  } catch {
    preview = '';
  }
  const included = new Map(
    'extracted' in result
      ? result.extracted.included.map((item) => [item.stepId, item])
      : [],
  );
  const skipped = new Map(
    'extracted' in result
      ? result.extracted.skipped.map((item) => [item.stepId, item.reason])
      : [],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog workflow-batch-dialog">
        <DialogTitle>Save workflow</DialogTitle>
        <DialogDescription>
          Save the operations derived from a recording, with their checks and
          report layout, as a {WORKFLOW_EXTENSION} file. Inputs match other
          recordings by column name. Run it on more files now, or later with
          Workspace → Open workflow.
        </DialogDescription>
        <div className="workflow-batch-fields">
          <RegionSelect
            label="Save from recording"
            value={source?.id ?? ''}
            items={sources.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(value) => {
              setSourceId(value);
              setExcluded(new Set());
              setOrigins({});
            }}
          />
          <label className="region-field">
            <span>Workflow name</span>
            <input
              value={name}
              placeholder={workflowName}
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="region-field">
            <span>Revision</span>
            <input
              value={revision}
              maxLength={60}
              onChange={(event) => setRevision(event.target.value)}
            />
          </label>
          <label className="region-field">
            <span>Each recording is one…</span>
            <input
              value={itemLabel}
              maxLength={60}
              placeholder="Serial number"
              onChange={(event) => setItemLabel(event.target.value)}
            />
          </label>
          <label className="region-field workflow-batch-wide">
            <span>
              Item ID from file name{' '}
              <small>(optional regular expression)</small>
            </span>
            <input
              value={pattern}
              placeholder="^(?<id>SN-[0-9]+)"
              maxLength={200}
              spellCheck={false}
              onChange={(event) => setPattern(event.target.value)}
            />
            <small className="workflow-muted">
              {source ? `${source.name} → ${preview || 'invalid pattern'}` : ''}
            </small>
          </label>
        </div>
        <section className="workflow-batch-section">
          <h3>
            Steps{' '}
            <span>
              {included.size} of {candidates.length}
            </span>
          </h3>
          {!candidates.length ? (
            <p className="workflow-muted">
              This recording has no operations yet. Derive, segment or calculate
              values first, then save the workflow.
            </p>
          ) : (
            <ul className="workflow-batch-steps">
              {candidates.map((step) => {
                const item = included.get(step.id);
                const reason = skipped.get(step.id);
                return (
                  <li
                    key={step.id}
                    data-state={
                      item
                        ? 'included'
                        : excluded.has(step.id)
                          ? 'excluded'
                          : 'skipped'
                    }
                  >
                    <Checkbox
                      aria-label={`Include ${stepName(step)}`}
                      checked={!excluded.has(step.id)}
                      onCheckedChange={(checked) =>
                        setExcluded((old) => {
                          const next = new Set(old);
                          if (checked) next.delete(step.id);
                          else next.add(step.id);
                          return next;
                        })
                      }
                    />
                    <div>
                      <strong>
                        <code>{reference(step.sequence)}</code> {stepName(step)}
                      </strong>
                      <small>
                        {item
                          ? `Saved as “${item.recipeStepId}”${step.checks?.length ? ` · ${step.checks.length} ${step.checks.length === 1 ? 'check' : 'checks'}` : ''}`
                          : excluded.has(step.id)
                            ? 'Left out'
                            : (reason ?? '')}
                      </small>
                    </div>
                    {item?.origins && (
                      <select
                        aria-label={`Fixed times in ${stepName(step)}`}
                        value={item.timeOrigin}
                        onChange={(event) =>
                          setOrigins((old) => ({
                            ...old,
                            [step.id]: event.target.value as TimeOrigin,
                          }))
                        }
                      >
                        {ORIGINS.filter((origin) =>
                          item.origins!.includes(origin.value),
                        ).map((origin) => (
                          <option key={origin.value} value={origin.value}>
                            {origin.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {'extracted' in result && (
          <section className="workflow-batch-section">
            <h3>
              Inputs <span>{result.extracted.recipe.channels.length}</span>
            </h3>
            <p className="workflow-batch-channels">
              {result.extracted.recipe.channels.map((channel) => (
                <span key={channel.alias}>
                  <code>{channel.alias}</code> ← {channel.name}
                  {channel.unit ? ` [${channel.unit}]` : ''}
                </span>
              ))}
            </p>
            {!!result.extracted.warnings.length && (
              <ul className="workflow-batch-notes">
                {result.extracted.warnings.map((warning) => (
                  <li key={warning.message}>
                    <AlertTriangle size={13} /> {warning.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section className="workflow-batch-section">
          <div className="workflow-batch-check">
            <Checkbox
              aria-label="Include the current Reports draft as the report template"
              checked={includeReport && !!blockCount}
              disabled={!blockCount}
              onCheckedChange={(checked) => setIncludeReport(!!checked)}
            />
            <span>
              Include the current Reports draft as the report template
              {blockCount
                ? ` (${blockCount} ${blockCount === 1 ? 'block' : 'blocks'})`
                : ' · the draft is empty'}
            </span>
          </div>
          <p className="workflow-muted">
            Captured signals, values, plots and check tables are rebound to each
            item. Text can use {'{{item.id}}'}, {'{{run.status}}'},{' '}
            {'{{file.name}}'} and {'{{value step-id[1]}}'}.
          </p>
          {'problems' in result && !!result.problems.length && (
            <ul className="workflow-batch-notes">
              {result.problems.map((problem) => (
                <li key={problem}>
                  <AlertTriangle size={13} /> {problem}
                </li>
              ))}
            </ul>
          )}
        </section>
        {'error' in result && (
          <p className="workflow-batch-error" role="alert">
            <X size={14} /> {result.error}
          </p>
        )}
        <div className="workflow-batch-actions">
          <button
            className="secondary-button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className="secondary-button"
            disabled={!('text' in result)}
            onClick={() => {
              if ('text' in result) onRun(result.text, fileName);
            }}
          >
            <Play size={14} /> Run on other files…
          </button>
          <button
            className="primary-button"
            disabled={!('text' in result)}
            onClick={() => {
              if (!('text' in result)) return;
              downloadBlob(
                new Blob([result.text], { type: 'application/yaml' }),
                fileName,
              );
              onOpenChange(false);
            }}
          >
            {'text' in result ? <Download size={14} /> : <Check size={14} />}{' '}
            Download {fileName}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
