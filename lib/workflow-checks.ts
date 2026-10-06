import type {
  CheckDefinition,
  CheckResult,
  CheckStatus,
  RunFlag,
  RunStatus,
  WorkflowRun,
  WorkflowStep,
} from './workflow-types';

/** Exact statistics of one evaluated signal; never plot envelopes. */
export type OutputStatistics = {
  samples: number;
  finite: number;
  min: number | null;
  max: number | null;
  start: number;
  end: number;
};
export type CheckOutput = {
  id: string;
  label: string;
  unit: string;
  /** Scalar outputs carry their value; signals carry statistics. */
  value?: number | null;
  statistics?: OutputStatistics;
};

export const formatNumber = (value: number) =>
  Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 1e-3)
    ? value.toPrecision(4)
    : String(Number(value.toPrecision(6)));

const withUnit = (value: number, unit: string) =>
  `${formatNumber(value)}${unit && unit !== '—' ? ` ${unit}` : ''}`;

export function describeLimits(check: CheckDefinition, unit = ''): string {
  const format = (value: number) =>
    check.kind === 'missing'
      ? `${Number((value * 100).toPrecision(3))} %`
      : check.kind === 'duration'
        ? `${formatNumber(value)} s`
        : check.kind === 'count'
          ? String(value)
          : withUnit(value, check.unit ?? unit);
  if (check.min !== undefined && check.min === check.max)
    return check.kind === 'count'
      ? format(check.min)
      : `= ${format(check.min)}`;
  if (check.min !== undefined && check.max !== undefined)
    return `${format(check.min)} – ${format(check.max)}`;
  if (check.min !== undefined) return `≥ ${format(check.min)}`;
  return `≤ ${format(check.max!)}`;
}

export const CHECK_NAMES: Record<CheckDefinition['kind'], string> = {
  count: 'Output count',
  limits: 'Limits',
  missing: 'Missing samples',
  duration: 'Duration',
};

const within = (check: CheckDefinition, value: number) =>
  (check.min === undefined || value >= check.min) &&
  (check.max === undefined || value <= check.max);

/** Evaluate every check for one step's outputs, in check order. */
export function evaluateChecks(
  checks: CheckDefinition[],
  outputs: CheckOutput[],
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    const failed: CheckStatus = check.severity;
    const result = (
      status: CheckStatus,
      observed: number | null,
      message: string,
      outputId?: string,
    ) =>
      results.push({
        check: index,
        status,
        observed,
        message:
          status === 'pass' || !check.message
            ? message
            : `${check.message} ${message}`,
        ...(outputId ? { outputId } : {}),
      });
    if (check.kind === 'count') {
      const ok = within(check, outputs.length);
      result(
        ok ? 'pass' : failed,
        outputs.length,
        `${outputs.length} ${outputs.length === 1 ? 'output' : 'outputs'}${ok ? '' : `; expected ${describeLimits(check)}`}.`,
      );
      continue;
    }
    const positions =
      check.outputs ?? outputs.map((_, position) => position + 1);
    for (const position of positions) {
      const output = outputs[position - 1];
      if (!output) {
        result(failed, null, `Output ${position} does not exist.`);
        continue;
      }
      const name = output.label;
      if (check.kind === 'limits') {
        if (check.unit !== undefined && check.unit !== output.unit) {
          result(
            failed,
            null,
            `${name} is in ${output.unit}, but the limit is in ${check.unit}.`,
            output.id,
          );
          continue;
        }
        if (output.statistics === undefined) {
          const value = output.value ?? null;
          if (value === null) {
            result(failed, null, `${name} is unavailable.`, output.id);
            continue;
          }
          const ok = within(check, value);
          result(
            ok ? 'pass' : failed,
            value,
            `${name} = ${withUnit(value, output.unit)}${ok ? '' : `; expected ${describeLimits(check, output.unit)}`}.`,
            output.id,
          );
          continue;
        }
        const { min, max } = output.statistics;
        if (min === null || max === null) {
          result(failed, null, `${name} has no finite samples.`, output.id);
          continue;
        }
        const high = check.max !== undefined && max > check.max;
        const low = check.min !== undefined && min < check.min;
        const observed = high
          ? max
          : low
            ? min
            : check.max !== undefined
              ? max
              : min;
        result(
          high || low ? failed : 'pass',
          observed,
          high
            ? `${name} reaches ${withUnit(max, output.unit)}, above ${withUnit(check.max!, output.unit)}.`
            : low
              ? `${name} falls to ${withUnit(min, output.unit)}, below ${withUnit(check.min!, output.unit)}.`
              : `${name} stays within ${describeLimits(check, output.unit)} (${withUnit(min, output.unit)} to ${withUnit(max, output.unit)}).`,
          output.id,
        );
        continue;
      }
      const statistics = output.statistics;
      if (!statistics) {
        result(failed, null, `${name} is not a signal.`, output.id);
        continue;
      }
      if (check.kind === 'missing') {
        const fraction = statistics.samples
          ? (statistics.samples - statistics.finite) / statistics.samples
          : 1;
        const ok = within(check, fraction);
        result(
          ok ? 'pass' : failed,
          fraction,
          `${name}: ${Number((fraction * 100).toPrecision(3))} % of samples missing${ok ? '' : `; expected ${describeLimits(check)}`}.`,
          output.id,
        );
      } else {
        const duration = statistics.end - statistics.start;
        const ok = within(check, duration);
        result(
          ok ? 'pass' : failed,
          duration,
          `${name} lasts ${formatNumber(duration)} s${ok ? '' : `; expected ${describeLimits(check)}`}.`,
          output.id,
        );
      }
    }
  }
  return results;
}

const RANK: Record<RunStatus, number> = {
  none: 0,
  pass: 1,
  warning: 2,
  fail: 3,
  error: 4,
};
/** Warning, Fail and Error need attention; Pass and No checks do not. */
export const isFlagged = (status: RunStatus) => RANK[status] > RANK.pass;
export function worst<T extends RunStatus>(
  statuses: Iterable<T>,
  fallback: T,
): T {
  let current = fallback;
  for (const status of statuses)
    if (RANK[status] > RANK[current]) current = status;
  return current;
}

/** Results only count while they match the step's current revision. */
export function currentResults(step: WorkflowStep): CheckResult[] {
  return step.checkResults &&
    step.checkResults.revision === (step.revision ?? 1)
    ? step.checkResults.results
    : [];
}

export function stepStatus(step: WorkflowStep): CheckStatus | undefined {
  const results = currentResults(step);
  return results.length
    ? worst(
        results.map((result) => result.status),
        'pass',
      )
    : undefined;
}

/** Failed and warning results by output, for marking History rows. */
export function outputFlags(step: WorkflowStep): Map<string, CheckStatus> {
  const flags = new Map<string, CheckStatus>();
  for (const result of currentResults(step))
    if (result.outputId && result.status !== 'pass')
      flags.set(
        result.outputId,
        worst([flags.get(result.outputId) ?? 'pass', result.status], 'pass'),
      );
  return flags;
}

/**
 * Worst of processing flags and evaluated checks. An item without problems
 * whose steps evaluated no check is `none` (No checks), never Pass.
 */
export function runStatus(
  flags: RunFlag[],
  steps: (WorkflowStep | undefined)[],
): RunStatus {
  return worst<RunStatus>(
    [
      ...flags.map(
        (flag): RunStatus => (flag.severity === 'error' ? 'error' : 'warning'),
      ),
      ...steps.flatMap((step) => {
        const status = step && stepStatus(step);
        return status ? [status] : [];
      }),
    ],
    'none',
  );
}

/** Current status, including later edits to the run's steps. */
export function liveRunStatus(
  run: WorkflowRun,
  steps: ReadonlyMap<string, WorkflowStep>,
): RunStatus {
  return runStatus(
    run.flags,
    Object.values(run.steps).map((id) => steps.get(id)),
  );
}

export function runEdited(
  run: WorkflowRun,
  steps: ReadonlyMap<string, WorkflowStep>,
): boolean {
  return Object.values(run.steps).some(
    (id) => (steps.get(id)?.revision ?? 1) > 1,
  );
}

/** Human summaries of every problem in a run, worst first. */
export function runProblems(
  run: WorkflowRun,
  steps: ReadonlyMap<string, WorkflowStep>,
): { status: RunStatus; message: string }[] {
  const problems = [
    ...run.flags.map((flag) => ({
      status: (flag.severity === 'error' ? 'error' : 'warning') as RunStatus,
      message: flag.message,
    })),
    ...Object.values(run.steps).flatMap((id) => {
      const step = steps.get(id);
      return step
        ? currentResults(step)
            .filter((result) => result.status !== 'pass')
            .map((result) => ({
              status: result.status as RunStatus,
              message: result.message,
            }))
        : [];
    }),
  ];
  return problems.sort((a, b) => RANK[b.status] - RANK[a.status]);
}

/** Validates checks from the inspector or a restored backup. */
export function validateChecks(
  checks: unknown,
  outputs: 'signals' | 'values',
): CheckDefinition[] {
  if (!Array.isArray(checks) || checks.length > 50)
    throw new Error('A step can have at most 50 checks.');
  return checks.map((raw: unknown) => {
    const check = raw as Partial<CheckDefinition> | null;
    const finite = (value: unknown) =>
      value === undefined ||
      (typeof value === 'number' && Number.isFinite(value));
    if (
      !check ||
      typeof check !== 'object' ||
      !['count', 'limits', 'missing', 'duration'].includes(check.kind ?? '') ||
      !['warning', 'fail'].includes(check.severity ?? '') ||
      !finite(check.min) ||
      !finite(check.max) ||
      (check.min === undefined && check.max === undefined) ||
      (check.min !== undefined &&
        check.max !== undefined &&
        check.min > check.max) ||
      (check.unit !== undefined &&
        (check.kind !== 'limits' ||
          typeof check.unit !== 'string' ||
          check.unit.length > 60)) ||
      (check.message !== undefined &&
        (typeof check.message !== 'string' || check.message.length > 300)) ||
      (check.outputs !== undefined &&
        (check.kind === 'count' ||
          !Array.isArray(check.outputs) ||
          !check.outputs.length ||
          check.outputs.length > 1000 ||
          !check.outputs.every(
            (item) => Number.isSafeInteger(item) && item >= 1,
          )))
    )
      throw new Error('Enter a valid check with a min or max limit.');
    if (
      check.kind === 'count' &&
      [check.min, check.max].some(
        (limit) =>
          limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0),
      )
    )
      throw new Error('Output counts must be whole numbers.');
    if (
      check.kind === 'missing' &&
      [check.min, check.max].some(
        (limit) => limit !== undefined && (limit < 0 || limit > 1),
      )
    )
      throw new Error('Missing samples are a fraction between 0 and 1.');
    if (
      outputs === 'values' &&
      (check.kind === 'missing' || check.kind === 'duration')
    )
      throw new Error('Values support count and limits checks.');
    const result: CheckDefinition = {
      kind: check.kind!,
      severity: check.severity!,
    };
    if (check.min !== undefined) result.min = check.min;
    if (check.max !== undefined) result.max = check.max;
    if (check.unit !== undefined) result.unit = check.unit;
    if (check.outputs !== undefined)
      result.outputs = [...new Set(check.outputs)];
    if (check.message?.trim()) result.message = check.message.trim();
    return result;
  });
}

/** Backups carry checks, runs and recipes; reject inconsistent records. */
export function validateWorkflowRecords(
  steps: WorkflowStep[],
  batches: unknown,
  recipes: unknown,
  sourceIds: ReadonlySet<string>,
): void {
  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    if (
      (step.runId !== undefined && typeof step.runId !== 'string') ||
      (step.recipeStepId !== undefined && typeof step.recipeStepId !== 'string')
    )
      throw new Error('Invalid workflow run reference.');
    if (step.checks !== undefined)
      validateChecks(step.checks, step.kind === 'value' ? 'values' : 'signals');
    if (step.checkResults !== undefined) {
      const results = step.checkResults;
      if (
        !results ||
        !Number.isSafeInteger(results.revision) ||
        !Array.isArray(results.results) ||
        results.results.some(
          (result) =>
            !result ||
            !Number.isSafeInteger(result.check) ||
            !['pass', 'warning', 'fail'].includes(result.status) ||
            typeof result.message !== 'string' ||
            (result.observed !== null && !Number.isFinite(result.observed)) ||
            (result.outputId !== undefined &&
              !step.outputIds.includes(result.outputId)),
        )
      )
        throw new Error('Invalid check results.');
    }
  }
  const hashes = new Set<string>();
  if (recipes !== undefined) {
    if (!Array.isArray(recipes)) throw new Error('Invalid saved workflows.');
    for (const recipe of recipes as Record<string, unknown>[])
      if (
        !recipe ||
        typeof recipe.hash !== 'string' ||
        typeof recipe.name !== 'string' ||
        typeof recipe.text !== 'string' ||
        (recipe.revision !== undefined && typeof recipe.revision !== 'string')
      )
        throw new Error('Invalid saved workflow.');
      else hashes.add(recipe.hash);
  }
  if (batches === undefined) return;
  if (!Array.isArray(batches)) throw new Error('Invalid batch records.');
  for (const batch of batches as WorkflowBatchLike[]) {
    if (
      !batch ||
      typeof batch.id !== 'string' ||
      typeof batch.name !== 'string' ||
      typeof batch.createdAt !== 'string' ||
      !hashes.has(batch.recipeHash) ||
      !['running', 'complete', 'cancelled'].includes(batch.state) ||
      !Array.isArray(batch.runs) ||
      (batch.failures !== undefined &&
        (!Array.isArray(batch.failures) ||
          batch.failures.some(
            (failure) =>
              !failure ||
              typeof failure.name !== 'string' ||
              typeof failure.message !== 'string',
          )))
    )
      throw new Error('Invalid batch record.');
    for (const run of batch.runs)
      if (
        !run ||
        typeof run.id !== 'string' ||
        run.batchId !== batch.id ||
        typeof run.itemId !== 'string' ||
        typeof run.fileName !== 'string' ||
        !sourceIds.has(run.sourceId) ||
        !['none', 'pass', 'warning', 'fail', 'error'].includes(run.status) ||
        !run.steps ||
        typeof run.steps !== 'object' ||
        Object.values(run.steps).some((id) => !stepIds.has(id as string)) ||
        !validChannelMap(run.channelMap) ||
        !Array.isArray(run.flags) ||
        run.flags.some(
          (flag) =>
            !flag ||
            !['warning', 'error'].includes(flag.severity) ||
            typeof flag.message !== 'string',
        )
      )
        throw new Error('Invalid batch item.');
  }
}
/** Optional pre-flight mapping: recipe channel alias → column name. */
function validChannelMap(map: unknown): boolean {
  if (map === undefined) return true;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const entries = Object.entries(map);
  return (
    entries.length <= 500 &&
    entries.every(
      ([alias, column]) =>
        alias.length <= 120 &&
        typeof column === 'string' &&
        !!column &&
        column.length <= 255,
    )
  );
}
type WorkflowBatchLike = {
  id: string;
  name: string;
  createdAt: string;
  recipeHash: string;
  state: string;
  runs: (WorkflowRun & { status: string })[];
  failures?: { name: unknown; message: unknown }[];
};

/** Table rows for a report: one row per evaluated check, worst first. */
export function checkTableRows(
  steps: WorkflowStep[],
  stepLabel: (step: WorkflowStep) => string,
  options: { flaggedOnly?: boolean; flags?: RunFlag[] } = {},
): string[][] {
  const rows: { rank: number; cells: string[] }[] = [];
  for (const flag of options.flags ?? [])
    rows.push({
      rank: RANK[flag.severity],
      cells: ['Processing', flag.message, STATUS_LABELS[flag.severity]],
    });
  for (const step of steps)
    for (const result of currentResults(step)) {
      if (options.flaggedOnly && result.status === 'pass') continue;
      const check = step.checks?.[result.check];
      rows.push({
        rank: RANK[result.status],
        cells: [
          `${stepLabel(step)} · ${check ? CHECK_NAMES[check.kind] : 'Check'}`,
          result.message,
          STATUS_LABELS[result.status],
        ],
      });
    }
  return [
    ['Check', 'Result', 'Status'],
    ...rows.sort((a, b) => b.rank - a.rank).map((row) => row.cells),
  ];
}

export const STATUS_LABELS: Record<RunStatus, string> = {
  none: 'No checks',
  pass: 'Pass',
  warning: 'Warning',
  fail: 'Fail',
  error: 'Error',
};
