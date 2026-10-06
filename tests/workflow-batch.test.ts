import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { parseYaml, stringifyYaml } from '../lib/workflow-yaml';
import {
  itemIdFromFileName,
  parseWorkflow,
  recipeHash,
  serializeWorkflow,
  WorkflowFileError,
} from '../lib/workflow-recipe';
import { extractWorkflow } from '../lib/workflow-extract';
import {
  isFlagged,
  liveRunStatus,
  runEdited,
  runProblems,
  runStatus,
  STATUS_LABELS,
  stepStatus,
  validateWorkflowRecords,
} from '../lib/workflow-checks';
import {
  batchColumns,
  batchSummaryCsv,
  headerSignature,
  preflightFile,
  preflightStatus,
  rankColumns,
  remapItem,
} from '../lib/workflow-batch';
import {
  fillPlaceholders,
  templateRefs,
} from '../lib/workflow-report-template';
import {
  componentFiles,
  componentRecording,
  EOL_COMPONENTS,
  EOL_WORKFLOW,
  EOL_WORKFLOW_NAME,
} from '../lib/eol-example';
import { WorkflowIndex } from '../lib/workflow-history';
import { workflowExampleFile } from '../lib/workflow-example';
import type { Project } from '../lib/signal-types';

async function open(database = crypto.randomUUID()) {
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  return { engine, database };
}

async function runBatch(
  engine: SignalEngine,
  files: File[],
  recipe = EOL_WORKFLOW,
  batchId = crypto.randomUUID(),
) {
  const parsed = parseWorkflow(recipe);
  for (const file of files)
    await engine.runWorkflow({
      recipe,
      batchId,
      batchName: 'Lot 42',
      itemId: itemIdFromFileName(parsed, file.name),
      file,
    });
  return batchId;
}

const stepsOf = (project: Project) =>
  new Map((project.workflowSteps ?? []).map((step) => [step.id, step]));

void test('the YAML subset round trips workflow values and rejects unsafe or ambiguous input', () => {
  const value = {
    name: 'Sweep {n} · Torque × speed',
    quoted: [
      "it's",
      'key: value',
      ' padded',
      'true',
      '12',
      '#hash',
      '- dash',
      '',
    ],
    nested: {
      ranges: [
        [10, 50],
        [65.5, 1e-7],
      ],
      flag: false,
      none: null,
    },
    multiline: 'Line one\nLine two',
    steps: [{ id: 'a', derive: { function: 'smooth', parameter: 5 } }],
  };
  const text = stringifyYaml(value);
  assert.deepEqual(parseYaml(text).value, value);
  assert.deepEqual(
    parseYaml('a: [1,\n  2, 3] # comment\nb: >-\n  folded\n  text\n').value,
    { a: [1, 2, 3], b: 'folded text' },
  );
  for (const [bad, message] of [
    ['a: &anchor 1', /Anchors, aliases and tags/],
    ['a: *alias', /Anchors, aliases and tags/],
    ['a: !!python/object 1', /Anchors, aliases and tags/],
    ['a: 1\na: 2', /appears twice/],
    ['constructor: 1', /not allowed/],
    ['a: { __proto__: 1 }', /not allowed/],
    ['a:\n\tb: 1', /tabs/],
    ['a: 1\n---\nb: 2', /one YAML document/],
    ['%YAML 1.2\na: 1', /directives/],
    ['a: [1, 2', /not closed/],
  ] as const)
    assert.throws(() => parseYaml(bad), message, bad);
  assert.throws(() => parseYaml('x'.repeat(8 * 1024 * 1024 + 1)), /8 MiB/);
});

void test('workflow files validate references, functions and checks with line numbers', () => {
  const base = EOL_WORKFLOW;
  const broken = (from: string, to: string) => base.replace(from, to);
  const cases: [string, RegExp][] = [
    [
      broken('function: smooth', 'function: smoothen'),
      /Line 2\d: Step "smoothed-torque": unknown function "smoothen"/,
    ],
    [
      broken('input: torque, parameter: 5', 'input: power, parameter: 5'),
      /uses "power", which is not a channel or an earlier step/,
    ],
    [
      broken('limits: { min: 78', 'limit: { min: 78'),
      /unknown setting "limit"/,
    ],
    [broken('version: 1', 'version: 2'), /newer Stratum/],
    [
      broken('format: stratum-workflow', 'format: something-else'),
      /not a Stratum workflow/,
    ],
    [
      broken('input: torque, parameter: 5', "input: 'torque[2]', parameter: 5"),
      /has one signal; remove \[2\]/,
    ],
    [
      broken('input: torque, parameter: 5', 'input: torque[2], parameter: 5'),
      /quote values with brackets, for example 'torque\[2\]'/,
    ],
    [
      broken(
        'value: { function: maximum, input: temperature }',
        'value: { function: maximum, input: sweep-torque }',
      ),
      /cannot process values/,
    ],
    [broken('count: 3', 'count: 2.5'), /whole numbers/],
    [
      broken('missing: { max: 0.01 }', 'missing: { max: 5 }'),
      /fraction between 0 and 1/,
    ],
    [broken('parameter: 5', 'parameter: 0'), /must be 1–100000/],
    [
      broken("pattern: '^(?<id>SN-[0-9]+)'", "pattern: '(['"),
      /not a valid regular expression/,
    ],
    [
      broken('{{item.id}}\n  page-size', '{{item.serial}}\n  page-size'),
      /unknown placeholder/,
    ],
    [
      broken('bind: { signal: smoothed-torque }', 'bind: { signal: nowhere }'),
      /report uses "nowhere"/,
    ],
    [
      broken('time-origin: input-start', 'time-origin: sideways'),
      /time-origin must be one of/,
    ],
  ];
  for (const [text, message] of cases) {
    assert.notEqual(text, base, `Case did not change the workflow: ${message}`);
    assert.throws(
      () => parseWorkflow(text),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowFileError, String(error));
        assert.match(error.message, message);
        return true;
      },
    );
  }
});

void test('the example workflow serialises losslessly and hashes independently of comments', async () => {
  const recipe = parseWorkflow(EOL_WORKFLOW);
  assert.equal(recipe.steps.length, 8);
  assert.equal(recipe.item.label, 'Serial number');
  assert.equal(itemIdFromFileName(recipe, 'SN-24003 retest.csv'), 'SN-24003');
  assert.equal(
    itemIdFromFileName({ item: { label: 'Item' } }, 'part 7.csv'),
    'part 7',
  );
  const again = parseWorkflow(serializeWorkflow(recipe));
  assert.deepEqual(again, recipe);
  assert.equal(await recipeHash(again), await recipeHash(recipe));
  const edited = parseWorkflow(
    EOL_WORKFLOW.replace('limits: { min: 78', 'limits: { min: 79'),
  );
  assert.notEqual(await recipeHash(edited), await recipeHash(recipe));
  assert.deepEqual([...new Set(templateRefs(recipe.report!))].sort(), [
    'average-current',
    'peak-temperature',
    'smoothed-torque',
    'sweep-torque',
  ]);
  assert.equal(
    fillPlaceholders(
      'Result for {{item.id}}: {{value sweep-torque[2]}} ({{unknown}})',
      { 'item.id': 'SN-1' },
      (ref) => `<${ref}>`,
    ),
    'Result for SN-1: <sweep-torque[2]> ({{unknown}})',
  );
});

void test('committed EOL example files match the deterministic generator', async () => {
  for (const component of EOL_COMPONENTS) {
    const { name, text } = componentRecording(
      component.serial,
      component.variant,
    );
    assert.equal(
      await readFile(
        new URL(`../examples/eol-rig/${name}`, import.meta.url),
        'utf8',
      ),
      text,
      `${name} is out of date. Run pnpm examples:eol.`,
    );
  }
  assert.equal(
    await readFile(
      new URL(`../examples/eol-rig/${EOL_WORKFLOW_NAME}`, import.meta.url),
      'utf8',
    ),
    EOL_WORKFLOW,
  );
});

void test('a batch publishes each item atomically, flags checks and undoes as one action', async () => {
  const { engine, database } = await open();
  try {
    const before = structuredClone(engine.project);
    const batchId = await runBatch(engine, componentFiles());
    await engine.finishBatch(batchId, 'complete');
    const project = engine.project;
    const batch = project.workflowBatches![0];
    assert.equal(batch.state, 'complete');
    assert.equal(batch.runs.length, EOL_COMPONENTS.length);
    assert.equal(project.workflowRecipes!.length, 1);
    assert.equal(project.workflowRecipes![0].hash, batch.recipeHash);
    const steps = stepsOf(project);
    for (const component of EOL_COMPONENTS) {
      const run = batch.runs.find((item) => item.itemId === component.serial)!;
      assert.equal(run.status, component.expected, component.serial);
      assert.equal(liveRunStatus(run, steps), component.expected);
      // Every produced step is tagged with its run and recipe step.
      for (const [recipeStepId, stepId] of Object.entries(run.steps)) {
        const step = steps.get(stepId)!;
        assert.equal(step.runId, run.id);
        assert.equal(step.recipeStepId, recipeStepId);
      }
      assert.equal(steps.get(`import:${run.sourceId}`)?.runId, run.id);
      assert.equal(
        steps.get(`import:${run.sourceId}`)?.name,
        `Serial number ${component.serial}`,
      );
    }
    const problems = (serial: string) =>
      runProblems(
        batch.runs.find((run) => run.itemId === serial)!,
        steps,
      ).map((problem) => problem.message);
    assert.match(
      problems('SN-24003')[0],
      /Sweep 1 · Average torque = 74\.\d+ Nm; expected 78 Nm – 95 Nm/,
    );
    assert.deepEqual(problems('SN-24005'), [
      'The rig should record three speed sweeps. 2 outputs; expected 3.',
      'Stopped after a failed check in “Find the speed sweeps”; 5 later steps were skipped.',
    ]);
    assert.match(
      problems('SN-24006')[0],
      /Smoothed torque: 4\.78 % of samples missing/,
    );
    assert.match(
      problems('SN-24007')[0],
      /Peak winding temperature = 92\.95 °C; expected ≤ 90 °C/,
    );
    assert.deepEqual(problems('SN-24008'), [
      '"Torque" is in lbf·ft, but the workflow expects Nm.',
      'Skipped 6 steps that need “Torque”: Smooth measured torque, Multiply torque and speed, Find the speed sweeps and 3 more.',
    ]);
    // Independent branches still run when another input is missing.
    const wrongUnit = batch.runs.find((run) => run.itemId === 'SN-24008')!;
    assert.deepEqual(Object.keys(wrongUnit.steps), [
      'peak-temperature',
      'average-current',
    ]);
    // Labels follow the recipe and nested windows follow each item's own sweep.
    const index = new WorkflowIndex(project);
    const late = batch.runs.find((run) => run.itemId === 'SN-24004')!;
    const halves = steps.get(late.steps['sweep-2-halves'])!;
    assert.deepEqual(
      halves.outputIds.map((id) => index.label(id)),
      ['Sweep 2 · First half · Torque', 'Sweep 2 · Second half · Torque'],
    );
    const sweep2 = steps.get(late.steps.sweeps)!.outputIds[1];
    const [sweepStart] = engine.bounds(sweep2);
    assert.ok(
      Math.abs(sweepStart - 77) < 0.2,
      `Sweep 2 starts at ${sweepStart}`,
    );
    assert.ok(
      Math.abs(engine.bounds(halves.outputIds[0])[0] - sweepStart) < 1e-9,
    );
    // One Undo removes the whole batch; Redo restores it, including after restart.
    const runLabel = `Run 'Lot 42' on ${EOL_COMPONENTS.length} recordings`;
    assert.equal(engine.undoLabel, runLabel);
    await engine.travel('undo');
    assert.deepEqual(engine.project, before);
    assert.equal(engine.redoLabel, runLabel);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    try {
      await reopened.open();
      await reopened.recoverImports();
      assert.equal(reopened.redoLabel, runLabel);
      await reopened.travel('redo');
      assert.equal(reopened.undoLabel, runLabel);
      assert.equal(reopened.project.sources.length, EOL_COMPONENTS.length);
      assert.deepEqual(
        reopened.project.workflowBatches,
        project.workflowBatches,
      );
      await reopened.travel('undo');
      assert.equal(reopened.project.sources.length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    engine.close();
  }
});

void test('an interrupted batch keeps completed items; later work gets its own Undo entry', async () => {
  const { engine, database } = await open();
  const files = componentFiles();
  const first = crypto.randomUUID();
  await runBatch(engine, files.slice(0, 2), EOL_WORKFLOW, first);
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  try {
    await reopened.open();
    await reopened.recoverImports();
    assert.equal(reopened.project.sources.length, 2);
    assert.equal(reopened.project.workflowBatches![0].state, 'running');
    // Continuing the same batch after a restart still coalesces into its entry.
    await runBatch(reopened, files.slice(2, 3), EOL_WORKFLOW, first);
    await reopened.rename(reopened.project.sources[0].id, 'Renamed recording');
    await runBatch(reopened, files.slice(3, 4));
    assert.equal(reopened.project.workflowBatches!.length, 2);
    await reopened.travel('undo');
    assert.equal(reopened.project.workflowBatches!.length, 1);
    assert.equal(reopened.project.sources[0].name, 'Renamed recording');
    await reopened.travel('undo');
    assert.equal(reopened.project.sources[0].name, 'SN-24001.csv');
    await reopened.travel('undo');
    assert.equal(reopened.project.sources.length, 0);
    // Mixing workflow revisions in one batch is refused without side effects.
    const revised = EOL_WORKFLOW.replace("revision: '1'", "revision: '2'");
    await reopened.travel('redo');
    const before = reopened.project;
    await assert.rejects(
      runBatch(reopened, files.slice(4, 5), revised, first),
      /same workflow revision/,
    );
    assert.equal(reopened.project, before);
  } finally {
    reopened.close();
  }
});

void test('cancelling an item publishes nothing and keeps the Undo journal', async () => {
  const database = crypto.randomUUID();
  const engine = new SignalEngine((message) => {
    if (message.startsWith('Calculating')) engine.cancelled = true;
  }, database);
  await engine.open();
  await engine.initializeWorkflow();
  try {
    await assert.rejects(
      runBatch(engine, componentFiles().slice(0, 1)),
      /cancelled/,
    );
    assert.equal(engine.project.sources.length, 0);
    assert.equal(engine.canUndo, false);
    engine.cancelled = false;
    await engine.recoverImports();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    assert.equal(reopened.project.sources.length, 0);
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('a workflow saved from History replays to identical results on another recording', async () => {
  const { engine } = await open();
  try {
    const original = await engine.workflowExample();
    const extracted = extractWorkflow(engine.project, original.id, {
      name: 'Motor example',
      itemLabel: 'Run',
    });
    assert.equal(extracted.skipped.length, 0);
    assert.equal(extracted.recipe.steps.length, 6);
    assert.deepEqual(
      extracted.recipe.channels.map((channel) => [
        channel.alias,
        channel.name,
        channel.unit,
      ]),
      [
        ['torque', 'Torque', 'Nm'],
        ['motor-speed', 'Motor speed', 'rpm'],
      ],
    );
    const nested = extracted.recipe.steps[4];
    assert.equal(nested.operation.kind, 'segment');
    assert.equal(
      nested.operation.kind === 'segment' && nested.operation.timeOrigin,
      'input-start',
    );
    assert.ok(
      extracted.warnings.some((warning) =>
        /fixed recording times/.test(warning.message),
      ),
    );
    assert.ok(
      extracted.warnings.some((warning) => /output 2/.test(warning.message)),
    );
    const text = serializeWorkflow(extracted.recipe);
    const recipe = parseWorkflow(text);
    assert.deepEqual(recipe, extracted.recipe);
    const before = engine.project;
    const file = workflowExampleFile();
    await engine.runWorkflow({
      recipe: text,
      batchId: crypto.randomUUID(),
      batchName: 'Replay',
      itemId: 'Copy',
      file,
    });
    const run = engine.project.workflowBatches![0].runs[0];
    // The example has no checks: its items are No checks, never Pass.
    assert.equal(run.status, 'none');
    const steps = stepsOf(engine.project);
    assert.equal(liveRunStatus(run, steps), 'none');
    const index = new WorkflowIndex(engine.project);
    for (const included of extracted.included) {
      const old = before.workflowSteps!.find(
        (step) => step.id === included.stepId,
      )!;
      const replayed = steps.get(run.steps[included.recipeStepId])!;
      assert.equal(replayed.kind, old.kind);
      assert.equal(replayed.name, old.name);
      assert.deepEqual(
        replayed.outputIds.map((id) => index.label(id)),
        old.outputIds.map((id) => new WorkflowIndex(before).label(id)),
      );
      for (const [position, id] of replayed.outputIds.entries()) {
        const value = index.values.get(id);
        if (value)
          assert.equal(
            value.value,
            before.values!.find((item) => item.id === old.outputIds[position])!
              .value,
          );
        else
          assert.deepEqual(
            engine.bounds(id),
            engine.bounds(old.outputIds[position]),
          );
      }
    }
    // Leaving out a step reports the dependents that can no longer be saved.
    const runs = before.workflowSteps!.find(
      (step) => step.name === 'Split the product into three runs',
    )!;
    const partial = extractWorkflow(before, original.id, {
      name: 'Partial',
      stepIds: new Set(
        before
          .workflowSteps!.filter((step) => step.id !== runs.id)
          .map((step) => step.id),
      ),
    });
    assert.deepEqual(
      partial.recipe.steps.map((step) => step.name),
      ['Smooth measured torque', 'Multiply torque and speed'],
    );
    assert.equal(partial.skipped.length, 3);
    assert.match(
      partial.skipped[0].reason,
      /^Average product per run uses “Run 1 · Torque × speed”, which is not from this recording or an included step\.$/,
    );
    // Steps that depend on nothing from this recording cannot be saved at all.
    assert.throws(
      () =>
        extractWorkflow(before, original.id, {
          name: 'Empty',
          stepIds: new Set([runs.id]),
        }),
      /No steps from this recording can be saved/,
    );
  } finally {
    engine.close();
  }
});

void test('checks are undoable, survive Edit and re-evaluate against the new revision', async () => {
  const { engine } = await open();
  try {
    await engine.workflowExample();
    const step = engine.project.workflowSteps!.find(
      (item) => item.name === 'Average product per run',
    )!;
    await engine.setChecks(step.id, [
      { kind: 'limits', max: 1, severity: 'warning', message: 'Too high.' },
      { kind: 'count', min: 3, max: 3, severity: 'fail' },
    ]);
    let current = stepsOf(engine.project).get(step.id)!;
    assert.equal(stepStatus(current), 'warning');
    assert.equal(current.checkResults!.results.length, 4);
    assert.equal(current.checkResults!.results[3].status, 'pass');
    await assert.rejects(
      engine.setChecks(step.id, [
        { kind: 'missing', max: 0.1, severity: 'fail' },
      ]),
      /count and limits/,
    );
    await engine.travel('undo');
    assert.equal(stepsOf(engine.project).get(step.id)!.checks, undefined);
    await engine.travel('redo');
    // Rebuilding the upstream smoothing rebuilds this step; checks follow it.
    const smoothing = engine.project.workflowSteps!.find(
      (item) => item.name === 'Smooth measured torque',
    )!;
    await engine.editOperation(smoothing.id, {
      type: 'derive-many',
      parentIds: smoothing.inputIds,
      operation: 'smooth',
      parameter: 9,
    });
    current = stepsOf(engine.project).get(step.id)!;
    assert.equal(current.revision, 2);
    assert.equal(current.checks!.length, 2);
    assert.equal(current.checkResults!.revision, 2);
    assert.equal(stepStatus(current), 'warning');
    await engine.setChecks(step.id, []);
    current = stepsOf(engine.project).get(step.id)!;
    assert.equal(current.checks, undefined);
    assert.equal(current.checkResults, undefined);
  } finally {
    engine.close();
  }
});

void test('Edit within a batch item keeps its run, marks it edited and refreshes its status', async () => {
  const { engine } = await open();
  try {
    await runBatch(engine, componentFiles().slice(2, 3));
    const run = engine.project.workflowBatches![0].runs[0];
    assert.equal(run.status, 'fail');
    const smoothing = stepsOf(engine.project).get(
      run.steps['smoothed-torque'],
    )!;
    // A heavier smoothing does not lift the low-torque averages into limits.
    await engine.editOperation(smoothing.id, {
      type: 'derive-many',
      parentIds: smoothing.inputIds,
      operation: 'smooth',
      parameter: 7,
    });
    const steps = stepsOf(engine.project);
    assert.ok(runEdited(run, steps));
    assert.equal(steps.get(run.steps['sweep-torque'])!.runId, run.id);
    assert.equal(liveRunStatus(run, steps), 'fail');
  } finally {
    engine.close();
  }
});

void test('backups round trip batches, checks and recipes; inconsistent batch records are rejected', async () => {
  const { engine } = await open();
  try {
    await runBatch(engine, componentFiles().slice(0, 2));
    const backup = await engine.backupWorkspace();
    const project = engine.project;
    await engine.restoreWorkspace(new File([backup], 'lot.stratum'));
    const restored = engine.project;
    assert.equal(restored.workflowBatches![0].runs.length, 2);
    assert.deepEqual(
      restored.workflowBatches![0].runs.map((run) => run.itemId),
      ['SN-24001', 'SN-24002'],
    );
    // Restore remaps source IDs; runs follow their recordings.
    for (const run of restored.workflowBatches![0].runs)
      assert.ok(restored.sources.some((source) => source.id === run.sourceId));
    assert.notEqual(restored.sources[0].id, project.sources[0].id);
    const text = await backup.text();
    const lines = text.trimEnd().split('\n');
    const header = JSON.parse(lines[0]);
    header.project.workflowBatches[0].runs[0].steps = {
      smoothed: 'missing-step',
    };
    const tampered = [JSON.stringify(header), ...lines.slice(1)].join('\n');
    await assert.rejects(
      engine.restoreWorkspace(new File([tampered], 'bad.stratum')),
      /Invalid batch item/,
    );
    assert.equal(engine.project, restored);
  } finally {
    engine.close();
  }
});

void test('removing an item recording removes its batch run; empty batches disappear', async () => {
  const { engine } = await open();
  try {
    await runBatch(engine, componentFiles().slice(0, 2));
    const [first, second] = engine.project.workflowBatches![0].runs;
    await engine.deleteOperation(`import:${first.sourceId}`);
    assert.deepEqual(
      engine.project.workflowBatches![0].runs.map((run) => run.id),
      [second.id],
    );
    await engine.deleteOperation(`import:${second.sourceId}`);
    assert.deepEqual(engine.project.workflowBatches, []);
    assert.deepEqual(engine.project.workflowRecipes, []);
  } finally {
    engine.close();
  }
});

void test('running a workflow on an existing recording adds steps without importing again', async () => {
  const { engine } = await open();
  try {
    const source = await engine.importCsv(componentFiles()[0]);
    const batchId = crypto.randomUUID();
    await engine.runWorkflow({
      recipe: EOL_WORKFLOW,
      batchId,
      batchName: 'Single',
      itemId: 'SN-24001',
      sourceId: source.id,
    });
    await engine.finishBatch(batchId, 'complete');
    assert.equal(engine.project.sources.length, 1);
    const run = engine.project.workflowBatches![0].runs[0];
    assert.equal(run.sourceId, source.id);
    assert.equal(run.status, 'pass');
    await engine.travel('undo');
    assert.equal(engine.project.workflowBatches?.length ?? 0, 0);
    assert.equal(engine.project.sources.length, 1);
  } finally {
    engine.close();
  }
});

void test('items without evaluated checks are No checks, neither Pass nor flagged', () => {
  const plain = {
    id: 'a',
    kind: 'derive',
    sourceId: 's',
    sequence: 1,
    inputIds: [],
    outputIds: ['x'],
    createdAt: '',
  } as unknown as Parameters<typeof runStatus>[1][number];
  assert.equal(runStatus([], []), 'none');
  assert.equal(runStatus([], [plain]), 'none');
  assert.equal(
    runStatus([{ severity: 'warning', message: 'Odd.' }], [plain]),
    'warning',
  );
  assert.equal(STATUS_LABELS.none, 'No checks');
  assert.equal(isFlagged('none'), false);
  assert.equal(isFlagged('pass'), false);
  assert.equal(isFlagged('warning'), true);
  // Batch records with the new status, and older ones without it, validate.
  const record = (status: string, extra = {}) => [
    {
      id: 'b',
      name: 'Lot',
      createdAt: '',
      recipeHash: 'h',
      state: 'complete',
      runs: [
        {
          id: 'r',
          batchId: 'b',
          itemId: 'SN-1',
          fileName: 'SN-1.csv',
          sourceId: 's',
          status,
          steps: {},
          flags: [],
          ...extra,
        },
      ],
    },
  ];
  const recipes = [{ hash: 'h', name: 'W', text: '' }];
  for (const status of ['none', 'pass', 'error'])
    validateWorkflowRecords([], record(status), recipes, new Set(['s']));
  validateWorkflowRecords(
    [],
    record('pass', { channelMap: { torque: 'Shaft torque' } }),
    recipes,
    new Set(['s']),
  );
  assert.throws(
    () =>
      validateWorkflowRecords(
        [],
        record('pass', { channelMap: { torque: 7 } }),
        recipes,
        new Set(['s']),
      ),
    /Invalid batch item/,
  );
});

void test('pre-flight maps a missing channel to a column and the run matches a correctly named file', async () => {
  const recipe = parseWorkflow(EOL_WORKFLOW);
  const { name, text } = componentRecording(
    EOL_COMPONENTS[0].serial,
    EOL_COMPONENTS[0].variant,
  );
  const renamed = text.replace('Torque [Nm]', 'Shaft torque [Nm]');
  assert.notEqual(renamed, text);
  const odd = new File([renamed], name, { type: 'text/csv' });
  const item = await preflightFile(recipe, odd);
  assert.equal(preflightStatus(item), 'error');
  assert.match(
    item.bindings.find((binding) => binding.alias === 'torque')!.problem!,
    /Missing channel "Torque \[Nm\]"/,
  );
  // The columns found are listed; the best match for Torque comes first.
  assert.deepEqual(
    item.columns.map((column) => column.name),
    ['Motor speed', 'Shaft torque', 'Supply current', 'Winding temperature'],
  );
  const torque = recipe.channels.find((channel) => channel.alias === 'torque')!;
  assert.equal(rankColumns(torque, item.columns)[0].name, 'Shaft torque');
  const mapped = remapItem(recipe, item, { torque: 'Shaft torque' });
  assert.equal(preflightStatus(mapped), 'ready');
  assert.deepEqual(mapped.mapping, { torque: 'Shaft torque' });
  assert.equal(headerSignature(mapped), headerSignature(item));
  assert.equal(
    preflightStatus(remapItem(recipe, mapped, { torque: '' })),
    'error',
  );
  const unreadable = await preflightFile(
    recipe,
    new File(['just one column\n'], 'bad.csv'),
  );
  assert.equal(preflightStatus(unreadable), 'unreadable');

  const { engine } = await open();
  try {
    const batchId = crypto.randomUUID();
    await engine.runWorkflow({
      recipe: EOL_WORKFLOW,
      batchId,
      batchName: 'Mapped',
      itemId: 'Named',
      file: componentFiles()[0],
    });
    await engine.runWorkflow({
      recipe: EOL_WORKFLOW,
      batchId,
      batchName: 'Mapped',
      itemId: 'Mapped',
      file: odd,
      channelMap: mapped.mapping,
    });
    const project = engine.project;
    const batch = project.workflowBatches![0];
    const [named, other] = batch.runs;
    assert.equal(named.channelMap, undefined);
    assert.deepEqual(other.channelMap, { torque: 'Shaft torque' });
    assert.equal(other.status, named.status);
    assert.deepEqual(other.flags, named.flags);
    assert.deepEqual(Object.keys(other.steps), Object.keys(named.steps));
    const index = new WorkflowIndex(project);
    for (const [recipeStepId, stepId] of Object.entries(named.steps)) {
      const a = index.steps.get(stepId)!;
      const b = index.steps.get(other.steps[recipeStepId])!;
      assert.equal(a.outputIds.length, b.outputIds.length, recipeStepId);
      a.outputIds.forEach((id, position) => {
        const value = index.values.get(id);
        if (value)
          assert.equal(
            index.values.get(b.outputIds[position])!.value,
            value.value,
          );
        else
          assert.deepEqual(
            engine.bounds(b.outputIds[position]),
            engine.bounds(id),
          );
      });
    }
    // Columns follow the workflow's step order; the mapping is in the CSV.
    const order = recipe.steps.map((step) => step.id);
    const columns = batchColumns(project, batch);
    assert.deepEqual(
      columns.map((column) => order.indexOf(column.recipeStepId)),
      columns
        .map((column) => order.indexOf(column.recipeStepId))
        .sort((a, b) => a - b),
    );
    const csv = batchSummaryCsv(project, batch).split('\r\n');
    assert.match(csv[0], /,Problems,Mapped channels,/);
    assert.match(csv[2], /Torque ← Shaft torque/);
    // A backup keeps the mapping.
    const backup = await engine.backupWorkspace();
    await engine.restoreWorkspace(new File([backup], 'mapped.stratum'));
    assert.deepEqual(engine.project.workflowBatches![0].runs[1].channelMap, {
      torque: 'Shaft torque',
    });
  } finally {
    engine.close();
  }
});
