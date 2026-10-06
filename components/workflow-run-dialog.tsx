'use client';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  parseWorkflow,
  recipeHash,
  WORKFLOW_EXTENSION,
  type WorkflowRecipe,
} from '@/lib/workflow-recipe';
import {
  headerSignature,
  preflightFile,
  preflightRecording,
  preflightStatus,
  rankColumns,
  remapItem,
  type PreflightItem,
  type PreflightState,
} from '@/lib/workflow-batch';
import { formatCount } from '@/lib/format-count';
import type { Project } from '@/lib/signal-types';

export const MAX_BATCH_ITEMS = 500;

export type BatchPlan = {
  recipeText: string;
  recipe: WorkflowRecipe;
  batchName: string;
  items: PreflightItem[];
  exportSummary: boolean;
  exportReports: boolean;
};

const isWorkflowFile = (file: File) => /\.(ya?ml)$/i.test(file.name);
/** Problem rows first: can't be read, then will error, then ready. */
const STATE_ORDER: Record<PreflightState, number> = {
  unreadable: 0,
  error: 1,
  ready: 2,
};
const STATE_LABELS: Record<PreflightState, string> = {
  ready: 'Ready',
  error: 'Will error',
  unreadable: "Can't be read",
};
const columnLabel = (column: { name: string; unit: string }) =>
  `${column.name}${column.unit && column.unit !== '—' ? ` [${column.unit}]` : ''}`;

/** Pre-flight files before opening the dialog, so it starts fully checked. */
export async function prepareItems(
  text: string | undefined,
  files: File[],
): Promise<PreflightItem[]> {
  if (!text) return [];
  let recipe: WorkflowRecipe;
  try {
    recipe = parseWorkflow(text);
  } catch {
    return [];
  }
  const items = await Promise.all(
    files
      .filter((file) => !isWorkflowFile(file))
      .slice(0, MAX_BATCH_ITEMS)
      .map((file) => preflightFile(recipe, file)),
  );
  return items.filter(
    (item, position) =>
      items.findIndex((other) => other.key === item.key) === position,
  );
}

/** Choose a workflow and recordings, check their inputs, then start a batch. */
export default function WorkflowRunDialog({
  open,
  onOpenChange,
  project,
  initialText,
  initialName,
  initialItems,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  initialText?: string;
  initialName?: string;
  initialItems?: PreflightItem[];
  onStart: (plan: BatchPlan) => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [fileName, setFileName] = useState(initialName ?? '');
  const [items, setItems] = useState<PreflightItem[]>(initialItems ?? []);
  const [hash, setHash] = useState('');
  const [batchName, setBatchName] = useState('');
  const [exportSummary, setExportSummary] = useState(true);
  const [exportReports, setExportReports] = useState(false);
  // Problem rows show their column choices unless the user collapses them.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [shareHeader, setShareHeader] = useState(true);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [space, setSpace] = useState<number>();
  const workflowInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => {
    if (!text) return undefined;
    try {
      return { recipe: parseWorkflow(text) };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'This workflow cannot be read.',
      };
    }
  }, [text]);
  const recipe = parsed && 'recipe' in parsed ? parsed.recipe : undefined;
  useEffect(() => {
    if (!recipe) return;
    let alive = true;
    void recipeHash(recipe).then((value) => {
      if (alive) setHash(value);
    });
    return () => {
      alive = false;
    };
  }, [recipe]);
  useEffect(() => {
    let alive = true;
    void navigator.storage?.estimate?.().then((estimate) => {
      if (alive && estimate.quota !== undefined)
        setSpace(estimate.quota - (estimate.usage ?? 0));
    });
    return () => {
      alive = false;
    };
  }, []);
  async function addFiles(files: File[]) {
    setNotice('');
    const workflows = files.filter(isWorkflowFile);
    const csvs = files.filter((file) => !isWorkflowFile(file));
    let active = recipe;
    if (workflows.length) {
      const workflow = workflows[0];
      const content = await workflow.text();
      setText(content);
      setFileName(workflow.name);
      try {
        active = parseWorkflow(content);
      } catch {
        active = undefined;
      }
      // A different workflow re-checks every queued recording against its inputs.
      if (active && items.length) {
        const recipeNow = active;
        const next = await Promise.all(
          items.map((item) =>
            item.file
              ? preflightFile(recipeNow, item.file)
              : Promise.resolve(
                  preflightRecording(recipeNow, project, item.sourceId!),
                ),
          ),
        );
        setItems((current) =>
          next.map((item) => ({
            ...item,
            itemId:
              current.find((old) => old.key === item.key)?.itemId ??
              item.itemId,
          })),
        );
      }
    }
    if (!csvs.length) return;
    if (!active) {
      setNotice('Choose a valid workflow before adding recordings.');
      return;
    }
    const known = new Set(items.map((item) => item.key));
    const added = await Promise.all(
      csvs
        .filter((file) => /\.csv$/i.test(file.name) || file.type === 'text/csv')
        .map((file) => preflightFile(active!, file)),
    );
    const fresh = added.filter((item) => !known.has(item.key));
    if (items.length + fresh.length > MAX_BATCH_ITEMS) {
      setNotice(
        `A batch can process up to ${MAX_BATCH_ITEMS} recordings at a time.`,
      );
      return;
    }
    if (fresh.length < added.length)
      setNotice('Files already in the list were skipped.');
    setItems((old) => [...old, ...fresh]);
  }
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + 1);
  const processed = new Set(
    (project.workflowBatches ?? []).flatMap((batch) =>
      batch.runs.map((run) => run.itemId),
    ),
  );
  const states = new Map(
    items.map((item) => [item.key, preflightStatus(item)]),
  );
  const tally = { ready: 0, error: 0, unreadable: 0 };
  for (const state of states.values()) tally[state]++;
  // Problem rows first; the sort is stable, so files keep their added order.
  const ordered = items
    .map((item, position) => ({ item, position }))
    .sort(
      (a, b) =>
        STATE_ORDER[states.get(a.item.key)!] -
          STATE_ORDER[states.get(b.item.key)!] || a.position - b.position,
    )
    .map((entry) => entry.item);
  const signatures = new Map<string, number>();
  for (const item of items)
    if (!item.error) {
      const signature = headerSignature(item);
      signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
    }
  const unreadable = items.filter((item) => item.error);
  const runnable = items.filter((item) => !item.error && item.itemId.trim());
  const willError = runnable.filter(
    (item) => states.get(item.key) === 'error',
  ).length;
  const bytes = runnable.reduce((sum, item) => sum + (item.file?.size ?? 0), 0);
  const checks =
    recipe?.steps.reduce((sum, step) => sum + (step.checks?.length ?? 0), 0) ??
    0;
  const defaultName = recipe
    ? `${recipe.name} · ${new Date().toLocaleDateString()}`
    : '';
  const unused = project.sources.filter(
    (source) => !items.some((item) => item.sourceId === source.id),
  );
  const expanded = (item: PreflightItem) =>
    !item.error && (states.get(item.key) === 'error') !== toggled.has(item.key);
  /** Choose a column for a channel, here or in every file with this header. */
  function mapChannel(target: PreflightItem, alias: string, column: string) {
    if (!recipe) return;
    const signature = headerSignature(target);
    setItems((old) =>
      old.map((item) =>
        item.key === target.key ||
        (shareHeader && !item.error && headerSignature(item) === signature)
          ? remapItem(recipe, item, { [alias]: column })
          : item,
      ),
    );
  }
  function toggle(key: string) {
    setToggled((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="workflow-dialog workflow-batch-dialog"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={onDrop}
        data-drop={dragging || undefined}
      >
        <DialogTitle>Run a workflow on recordings</DialogTitle>
        <DialogDescription>
          Each recording is imported and processed with the same steps, then its
          checks are evaluated. Results appear in History as ordinary steps, and
          one Undo removes the whole batch.
        </DialogDescription>
        <section className="workflow-batch-section">
          <h3>
            Workflow
            <button
              className="workflow-link"
              onClick={() => workflowInput.current?.click()}
            >
              <FolderOpen size={13} />{' '}
              {text ? 'Open another…' : `Open ${WORKFLOW_EXTENSION}…`}
            </button>
          </h3>
          {!parsed ? (
            <p className="workflow-muted">
              Open a workflow file, or drop it here together with CSV
              recordings.
            </p>
          ) : 'error' in parsed ? (
            <p className="workflow-batch-error" role="alert">
              <XCircle size={14} /> {fileName ? `${fileName}: ` : ''}
              {parsed.error}
            </p>
          ) : (
            <div className="workflow-batch-summary">
              <strong>
                {recipe!.name}
                {recipe!.revision ? ` · revision ${recipe!.revision}` : ''}
              </strong>
              {recipe!.description && <p>{recipe!.description}</p>}
              <small>
                {formatCount(recipe!.steps.length, 'step')} ·{' '}
                {checks
                  ? formatCount(checks, 'check')
                  : 'no checks, so items show No checks'}{' '}
                · {formatCount(recipe!.channels.length, 'input')} ·{' '}
                {recipe!.report
                  ? 'report template included'
                  : 'no report template'}
                {hash ? ` · SHA-256 ${hash.slice(0, 12)}` : ''}
                {fileName ? ` · ${fileName}` : ''}
              </small>
              <small>
                Inputs:{' '}
                {recipe!.channels
                  .map(
                    (channel) =>
                      `${channel.name}${channel.unit ? ` [${channel.unit}]` : ''}`,
                  )
                  .join(', ')}
              </small>
            </div>
          )}
        </section>
        <section className="workflow-batch-section">
          <h3>
            Recordings <span>{items.length}</span>
            <button
              className="workflow-link"
              disabled={!recipe}
              onClick={() => csvInput.current?.click()}
            >
              <FilePlus2 size={13} /> Add CSV files…
            </button>
          </h3>
          {recipe && !!unused.length && (
            <details className="workflow-batch-existing">
              <summary>
                Use recordings already in this workspace ({unused.length})
              </summary>
              <ul>
                {unused.slice(0, 60).map((source) => (
                  <li key={source.id}>
                    <button
                      className="workflow-link"
                      onClick={() =>
                        setItems((old) => [
                          ...old,
                          preflightRecording(recipe, project, source.id),
                        ])
                      }
                    >
                      + {source.name}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!items.length ? (
            <p className="workflow-batch-drop">
              Drop CSV recordings here, or choose Add CSV files. Only each
              file&apos;s first line is read until you run the batch.
            </p>
          ) : (
            <>
              <p className="workflow-batch-tally" aria-live="polite">
                <span data-state="ready">
                  <CheckCircle2 size={13} aria-hidden="true" /> {tally.ready}{' '}
                  ready
                </span>
                {' · '}
                <span data-state="error">
                  <XCircle size={13} aria-hidden="true" /> {tally.error} will
                  error
                </span>
                {' · '}
                <span data-state="unreadable">
                  <XCircle size={13} aria-hidden="true" /> {tally.unreadable}{' '}
                  can&apos;t be read
                </span>
              </p>
              <div className="workflow-batch-items">
                <table aria-label="Recordings to process">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>{recipe?.item.label ?? 'Item'}</th>
                      <th>Recording</th>
                      <th>Inputs</th>
                      <th>
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map((item) => {
                      const status = states.get(item.key)!;
                      const problems = item.error
                        ? [item.error]
                        : item.bindings.flatMap((binding) =>
                            binding.problem ? [binding.problem] : [],
                          );
                      const mapped = Object.keys(item.mapping).length;
                      const duplicate = (counts.get(item.itemId) ?? 0) > 1;
                      const open = expanded(item);
                      const choosable =
                        !item.error && (problems.length || mapped);
                      const shared =
                        (signatures.get(headerSignature(item)) ?? 0) - 1;
                      return [
                        <tr key={item.key} data-status={status}>
                          <td>
                            <span className="workflow-batch-state">
                              {status === 'ready' ? (
                                <CheckCircle2 size={14} aria-hidden="true" />
                              ) : (
                                <XCircle size={14} aria-hidden="true" />
                              )}
                              {STATE_LABELS[status]}
                            </span>
                          </td>
                          <td>
                            <input
                              aria-label={`Item ID for ${item.name}`}
                              value={item.itemId}
                              maxLength={120}
                              onChange={(event) =>
                                setItems((old) =>
                                  old.map((entry) =>
                                    entry.key === item.key
                                      ? { ...entry, itemId: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td title={item.name}>
                            {item.name}
                            {item.sourceId ? ' · in workspace' : ''}
                          </td>
                          <td title={problems.join(' ')}>
                            {choosable ? (
                              <button
                                className="workflow-link workflow-batch-disclose"
                                aria-expanded={open}
                                onClick={() => toggle(item.key)}
                              >
                                {open ? (
                                  <ChevronDown size={13} aria-hidden="true" />
                                ) : (
                                  <ChevronRight size={13} aria-hidden="true" />
                                )}
                                {problems.length
                                  ? problems[0] +
                                    (problems.length > 1
                                      ? ` (+${problems.length - 1})`
                                      : '')
                                  : `All ${item.bindings.length} found · ${formatCount(mapped, 'column')} chosen`}
                              </button>
                            ) : problems.length ? (
                              problems[0]
                            ) : (
                              `All ${item.bindings.length} found`
                            )}
                            {duplicate ? ' · duplicate ID' : ''}
                            {processed.has(item.itemId)
                              ? ' · processed before'
                              : ''}
                          </td>
                          <td>
                            <button
                              className="workflow-icon-button workflow-quiet"
                              aria-label={`Remove ${item.name}`}
                              onClick={() =>
                                setItems((old) =>
                                  old.filter((entry) => entry.key !== item.key),
                                )
                              }
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>,
                        open && recipe && (
                          <tr
                            key={`${item.key}:map`}
                            className="workflow-batch-map"
                            data-status={status}
                          >
                            <td colSpan={5}>
                              <p>
                                <span>Columns found:</span>{' '}
                                {item.columns.map(columnLabel).join(', ') ||
                                  'none'}
                              </p>
                              {recipe.channels.map((channel, position) => {
                                const binding = item.bindings[position];
                                const chosen = item.mapping[channel.alias];
                                if (!binding?.problem && !chosen) return null;
                                const bound = new Set(
                                  item.bindings.flatMap((other) =>
                                    other.channel >= 0 &&
                                    other.alias !== channel.alias
                                      ? [
                                          item.columns[other.channel].name
                                            .trim()
                                            .toLowerCase(),
                                        ]
                                      : [],
                                  ),
                                );
                                const options = rankColumns(
                                  channel,
                                  item.columns,
                                  bound,
                                );
                                return (
                                  <label
                                    key={channel.alias}
                                    className="workflow-batch-map-row"
                                  >
                                    <span>
                                      {channel.name}
                                      {channel.unit ? ` [${channel.unit}]` : ''}
                                    </span>
                                    <select
                                      aria-label={`Use column for ${channel.name} in ${item.name}`}
                                      value={chosen ?? ''}
                                      onChange={(event) =>
                                        mapChannel(
                                          item,
                                          channel.alias,
                                          event.target.value,
                                        )
                                      }
                                    >
                                      <option value="">
                                        {chosen
                                          ? 'Use the workflow’s column name'
                                          : 'Use column…'}
                                      </option>
                                      {options.map((column) => (
                                        <option
                                          key={column.name}
                                          value={column.name}
                                        >
                                          {columnLabel(column)}
                                        </option>
                                      ))}
                                    </select>
                                    {binding?.problem && (
                                      <small>{binding.problem}</small>
                                    )}
                                  </label>
                                );
                              })}
                              {shared > 0 && (
                                <div className="workflow-batch-check">
                                  <Checkbox
                                    aria-label="Apply to all files with this header"
                                    checked={shareHeader}
                                    onCheckedChange={(checked) =>
                                      setShareHeader(!!checked)
                                    }
                                  />
                                  <span>
                                    Apply to all files with this header (
                                    {formatCount(shared, 'other file')})
                                  </span>
                                </div>
                              )}
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {willError > 0 && (
            <p className="workflow-muted">
              Recordings that will error still run: steps that need a missing or
              mismatched input are skipped and the item shows Error. Choose a
              column for a missing input to run every step.
            </p>
          )}
          {!!unreadable.length && (
            <output className="workflow-batch-error">
              <XCircle size={14} aria-hidden="true" />
              <span>
                Not run, because {unreadable.length === 1 ? 'it' : 'they'}{' '}
                can&apos;t be read:{' '}
                {unreadable.map((item) => item.name).join(', ')}.
              </span>
            </output>
          )}
        </section>
        <section className="workflow-batch-section workflow-batch-fields">
          <label className="region-field workflow-batch-wide">
            <span>Batch name</span>
            <input
              value={batchName}
              placeholder={defaultName}
              maxLength={160}
              onChange={(event) => setBatchName(event.target.value)}
            />
          </label>
          <div className="workflow-batch-check">
            <Checkbox
              aria-label="Download a summary CSV when the batch finishes"
              checked={exportSummary}
              onCheckedChange={(checked) => setExportSummary(!!checked)}
            />
            <span>Download a summary CSV when the batch finishes</span>
          </div>
          <div className="workflow-batch-check">
            <Checkbox
              aria-label="Export a PDF report for each item"
              checked={exportReports && !!recipe?.report}
              disabled={!recipe?.report}
              onCheckedChange={(checked) => setExportReports(!!checked)}
            />
            <span>
              Export a PDF report for each item
              {recipe && !recipe.report
                ? ' · this workflow has no report template'
                : ' · you can also export them later from the results'}
            </span>
          </div>
        </section>
        {space !== undefined && bytes * 3 > space && (
          <p className="workflow-batch-error" role="alert">
            <AlertTriangle size={14} /> These recordings may need more browser
            storage than is available on this device.
          </p>
        )}
        {notice && <output className="workflow-muted">{notice}</output>}
        <div className="workflow-batch-actions">
          <button
            className="secondary-button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!recipe || !runnable.length}
            onClick={() =>
              recipe &&
              onStart({
                recipeText: text,
                recipe,
                batchName: batchName.trim() || defaultName,
                items: runnable.map((item) => ({
                  ...item,
                  itemId: item.itemId.trim(),
                })),
                exportSummary,
                exportReports: exportReports && !!recipe.report,
              })
            }
          >
            <Play size={14} /> Run {formatCount(runnable.length, 'recording')}
            {willError ? ` (${willError} will error)` : ''}
          </button>
        </div>
        <input
          ref={workflowInput}
          className="sr-only"
          type="file"
          accept=".yaml,.yml,application/yaml"
          aria-label="Workflow file"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void addFiles(files);
          }}
        />
        <input
          ref={csvInput}
          className="sr-only"
          type="file"
          multiple
          accept=".csv,text/csv"
          aria-label="Recordings to process"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void addFiles(files);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
