import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { itemIdFromFileName, parseWorkflow } from '../lib/workflow-recipe';
import { runProblems } from '../lib/workflow-checks';
import {
  PHASER_UNITS,
  PHASER_WORKFLOW,
  PHASER_WORKFLOW_NAME,
  phaserFiles,
  phaserRecording,
} from '../lib/cam-phaser-example';

void test('committed cam phaser example files match the deterministic generator', async () => {
  const folder = new URL('../examples/cam-phaser-eol/', import.meta.url);
  for (const unit of PHASER_UNITS) {
    const { name, text } = phaserRecording(unit.serial, unit.variant);
    assert.equal(
      await readFile(new URL(name, folder), 'utf8'),
      text,
      `${name} is out of date. Run pnpm examples:phaser.`,
    );
  }
  assert.equal(
    await readFile(new URL(PHASER_WORKFLOW_NAME, folder), 'utf8'),
    PHASER_WORKFLOW,
  );
});

void test('the cam phaser workflow gives each example unit its expected status', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  const recipe = parseWorkflow(PHASER_WORKFLOW);
  const batchId = crypto.randomUUID();
  for (const file of phaserFiles())
    await engine.runWorkflow({
      recipe: PHASER_WORKFLOW,
      batchId,
      batchName: 'Phaser lot',
      itemId: itemIdFromFileName(recipe, file.name),
      file,
    });
  const project = engine.project;
  const steps = new Map(
    (project.workflowSteps ?? []).map((step) => [step.id, step]),
  );
  const runs = project.workflowBatches![0].runs;
  for (const unit of PHASER_UNITS) {
    const run = runs.find((item) => item.itemId === unit.serial)!;
    assert.equal(
      run.status,
      unit.expected,
      `${unit.serial}: ${JSON.stringify(runProblems(run, steps))}`,
    );
    // Every one of the five valve cycles is measured in both directions.
    for (const id of [
      'advance-steps',
      'retard-steps',
      'advance-held',
      'retard-held',
      'authority',
      'advance-response',
      'retard-response',
      'advance-leakage',
      'base-leakage',
      'supply-pressure',
    ])
      assert.equal(
        steps.get(run.steps[id])?.outputIds.length,
        5,
        `${unit.serial} ${id}`,
      );
  }
  const messages = (serial: string) =>
    runProblems(
      runs.find((run) => run.itemId === serial)!,
      steps,
    )
      .map((problem) => problem.message)
      .join('\n');
  assert.match(messages('CP-24103'), /responds too slowly/);
  assert.match(messages('CP-24104'), /full advance stop/);
  assert.match(messages('CP-24105'), /leakage is too high/);
  assert.match(messages('CP-24106'), /Advance 1 · Dead time/);
  assert.doesNotMatch(messages('CP-24106'), /Advance 2 · Dead time/);
  assert.match(messages('CP-24107'), /oil supply out of range/);
});
