import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { ValueAccumulator } from '../lib/value-statistics';
import {
  statisticTime,
  statisticValue,
  valueParameters,
  valueTitle,
  valueUnit,
  type ValueOperation,
  type ValueParameters,
} from '../lib/workflow-types';
import { WorkflowIndex, stepName } from '../lib/workflow-history';
import { extractWorkflow } from '../lib/workflow-extract';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { valueReference } from '../lib/plot-scratchpad';

// t: 0 1 4 5 7 8; the sample at 5 s is missing, so 4→7 s is not an interval.
const TIMES = [0, 1, 4, 5, 7, 8];
const TORQUE = [0, 10, 10, NaN, 30, 30];
const CSV =
  't,Torque [Nm],Speed [rpm]\n0,0,1000\n1,10,2000\n4,10,3000\n5,,4000\n7,30,5000\n8,30,6000';

function evaluate(operation?: ValueOperation, parameters?: ValueParameters) {
  const accumulator = new ValueAccumulator(
    'torque',
    0,
    8,
    operation,
    parameters,
  );
  TIMES.forEach((time, i) => accumulator.add(time, TORQUE[i]));
  return accumulator.finish();
}
const value = (operation: ValueOperation, parameters?: ValueParameters) =>
  statisticValue(evaluate(operation, parameters), operation);

async function fixture(database = crypto.randomUUID()) {
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([CSV], 'values.csv'));
  return { engine, source, database };
}

void test('level and spread values use every finite sample exactly', () => {
  assert.equal(value('sample-average'), 16);
  assert.equal(value('time-average'), 13);
  assert.equal(value('rms'), 20);
  // Deviations from 16: 256 + 36 + 36 + 196 + 196 = 720, over n − 1 = 4.
  assert.equal(value('standard-deviation'), Math.sqrt(180));
  assert.equal(value('peak-to-peak'), 30);
  // 5 + 30 + 30: no area is bridged across the missing sample.
  assert.equal(value('area'), 65);
  assert.equal(value('start-value'), 0);
  assert.equal(value('end-value'), 30);
  assert.equal(value('duration'), 8);
  assert.equal(value('time-of-minimum'), 0);
  // The first of the two maxima.
  assert.equal(value('time-of-maximum'), 7);
  const statistics = evaluate();
  assert.equal(statisticTime(statistics, 'end-value'), 8);
  assert.equal(statisticTime(statistics, 'time-of-maximum'), 7);
});

void test('a single sample or no samples leave spread values unavailable', () => {
  const one = new ValueAccumulator('x', 3, 3);
  one.add(3, 5);
  const single = one.finish();
  assert.equal(statisticValue(single, 'rms'), 5);
  assert.equal(statisticValue(single, 'standard-deviation'), null);
  assert.equal(statisticValue(single, 'area'), null);
  assert.equal(statisticValue(single, 'peak-to-peak'), 0);
  const none = new ValueAccumulator('x', 0, 1);
  none.add(0, NaN);
  none.add(1, NaN);
  const empty = none.finish();
  for (const operation of [
    'rms',
    'start-value',
    'end-value',
    'peak-to-peak',
    'time-of-maximum',
  ] as const)
    assert.equal(statisticValue(empty, operation), null, operation);
  assert.equal(statisticValue(empty, 'duration'), 1);
});

void test('value at a time interpolates within valid intervals only', () => {
  assert.equal(value('value-at', { time: 0.5 }), 5);
  assert.equal(value('value-at', { time: 2.5 }), 10);
  assert.equal(value('value-at', { time: 7 }), 30);
  // Inside the gap around the missing sample, and outside the input.
  assert.equal(value('value-at', { time: 4.5 }), null);
  assert.equal(value('value-at', { time: 6 }), null);
  assert.equal(value('value-at', { time: 9 }), null);
  const shifted = new ValueAccumulator('x', 10, 12, 'value-at', { time: 1 });
  shifted.add(10, 0);
  shifted.add(12, 4);
  const statistics = shifted.finish();
  // Times are measured from the input's start, then reported on its axis.
  assert.equal(statisticValue(statistics, 'value-at'), 2);
  assert.equal(statisticTime(statistics, 'value-at'), 11);
});

void test('thresholds interpolate crossings and never cross a gap', () => {
  // 0→10 crosses 5 at 0.5 s; 1–4 s and 7–8 s are above.
  assert.equal(value('time-above', { threshold: 5 }), 4.5);
  assert.equal(value('time-below', { threshold: 5 }), 0.5);
  // A level held exactly at the threshold (1–4 s) is neither above nor below.
  assert.equal(value('time-above', { threshold: 10 }), 1);
  assert.equal(value('time-below', { threshold: 10 }), 1);
  const first = evaluate('first-crossing', { threshold: 5, edge: 1 });
  assert.equal(statisticValue(first, 'first-crossing'), 0.5);
  assert.equal(statisticTime(first, 'first-crossing'), 0.5);
  // 10 → missing → 30 is not a rising crossing of 20.
  assert.equal(value('first-crossing', { threshold: 20, edge: 1 }), null);
  assert.equal(value('crossing-count', { threshold: 20, edge: 1 }), 0);
  assert.equal(value('crossing-count', { threshold: 5, edge: 1 }), 1);
  assert.equal(value('crossing-count', { threshold: 5, edge: -1 }), 0);
});

void test('value settings are validated and named', () => {
  assert.deepEqual(valueParameters('crossing-count', { threshold: 3 }), {
    threshold: 3,
    edge: 1,
  });
  assert.deepEqual(valueParameters('value-at'), { time: 0 });
  assert.throws(() => valueParameters('time-above'), /threshold/);
  assert.throws(
    () => valueParameters('first-crossing', { threshold: 1, edge: 2 }),
    /rising or falling/,
  );
  assert.throws(
    () => valueParameters('value-at', { time: -1 }),
    /0 s or later/,
  );
  assert.throws(
    () => valueParameters('maximum', { threshold: 1 }),
    /no "threshold" setting/,
  );
  assert.equal(
    valueTitle('first-crossing', { threshold: 1500, edge: -1 }, 'rpm'),
    'First falling crossing of 1500 rpm',
  );
  assert.equal(valueTitle('value-at', { time: 2 }), 'Value at 2 s');
  assert.equal(valueUnit('area', 'Nm'), 'Nm·s');
  assert.equal(valueUnit('area', 'kg/h'), '(kg/h)·s');
  assert.equal(valueUnit('time-above', 'Nm'), 's');
  assert.equal(valueUnit('crossing-count', 'Nm'), '');
  assert.equal(valueUnit('rms', 'Nm'), 'Nm');
});

void test('plots draw time and count values at the level they refer to', () => {
  const format = (number: number) => String(number);
  assert.deepEqual(
    valueReference(
      { operation: 'maximum', value: 30, unit: 'Nm' },
      'Nm',
      format,
    ),
    { y: 30, unit: 'Nm', label: 'max 30' },
  );
  assert.deepEqual(
    valueReference(
      {
        operation: 'time-above',
        value: 4.5,
        unit: 's',
        parameters: { threshold: 5 },
      },
      'Nm',
      format,
    ),
    { y: 5, unit: 'Nm', label: 't> 4.5 s' },
  );
  assert.deepEqual(
    valueReference(
      { operation: 'time-of-maximum', value: 7, unit: 's', level: 30 },
      'Nm',
      format,
    ),
    { y: 30, unit: 'Nm', label: 't(max) 7 s' },
  );
  // Without a level, a value is a line on its own unit's axis.
  assert.deepEqual(
    valueReference(
      { operation: 'area', value: 65, unit: 'Nm·s' },
      'Nm',
      format,
    ),
    { y: 65, unit: 'Nm·s', label: '∫ 65' },
  );
});

void test('the engine stores parameterised values with units, names and settings', async () => {
  const { engine, source } = await fixture();
  try {
    const torque = source.channels[0];
    const [above] = await engine.calculateValues([torque], 'time-above', {
      threshold: 5,
    });
    assert.equal(above.value, 4.5);
    assert.equal(above.unit, 's');
    assert.deepEqual(above.parameters, { threshold: 5 });
    assert.match(above.name, /Time above 5 Nm$/);
    const [crossing] = await engine.calculateValues(
      [torque],
      'first-crossing',
      { threshold: 5 },
    );
    assert.equal(crossing.value, 0.5);
    assert.equal(crossing.timestamp, 0.5);
    assert.deepEqual(crossing.parameters, { threshold: 5, edge: 1 });
    const [peak] = await engine.calculateValues([torque], 'time-of-maximum');
    assert.equal(peak.value, 7);
    assert.equal(peak.timestamp, 7);
    assert.equal(peak.level, 30);
    assert.equal(peak.parameters, undefined);
    const [area] = await engine.calculateValues([torque], 'area');
    assert.equal(area.value, 65);
    assert.equal(area.unit, 'Nm·s');
    await assert.rejects(
      engine.calculateValues([torque], 'time-above'),
      /threshold/,
    );
    const index = new WorkflowIndex(engine.project);
    const step = index.owner.get(above.id)!;
    assert.deepEqual(step.parameters, { threshold: 5 });
    assert.equal(stepName(step), 'Time above 5');
    assert.equal(index.label(above.id), 'Time above 5 Nm · Torque');
    const [preview] = await engine.previewValues([torque], 'crossing-count', {
      threshold: 5,
      edge: 1,
    });
    assert.equal(statisticValue(preview, 'crossing-count'), 1);
  } finally {
    engine.close();
  }
});

void test('Edit recalculates a value with new settings and Undo restores it', async () => {
  const { engine, source } = await fixture();
  try {
    const [above] = await engine.calculateValues(
      [source.channels[0]],
      'time-above',
      { threshold: 5 },
    );
    const step = new WorkflowIndex(engine.project).owner.get(above.id)!;
    await engine.editOperation(step.id, {
      type: 'calculate-values',
      inputIds: [source.channels[0]],
      operation: 'time-above',
      parameters: { threshold: 20 },
    });
    const edited = engine.project.values!.find((item) => item.id === above.id)!;
    assert.equal(edited.value, 1);
    assert.deepEqual(edited.parameters, { threshold: 20 });
    const saved = engine.project.workflowSteps!.find(
      (item) => item.id === step.id,
    )!;
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.parameters, { threshold: 20 });
    await engine.travel('undo');
    assert.equal(
      engine.project.values!.find((item) => item.id === above.id)!.value,
      4.5,
    );
  } finally {
    engine.close();
  }
});

void test('new values survive a workspace backup and restore', async () => {
  const { engine, source } = await fixture();
  const target = new SignalEngine(undefined, crypto.randomUUID());
  try {
    await engine.calculateValues(source.channels, 'value-at', { time: 0.5 });
    await engine.calculateValues([source.channels[0]], 'time-of-maximum');
    await engine.calculateValues(source.channels, 'standard-deviation');
    const backup = await engine.backupWorkspace();
    await target.open();
    await target.initializeWorkflow();
    await target.restoreWorkspace(new File([backup], 'values.stratum'));
    const restored = (target.project.values ?? []).map((item) => [
      item.operation,
      item.value,
      item.parameters,
      item.level,
    ]);
    assert.deepEqual(
      restored,
      (engine.project.values ?? []).map((item) => [
        item.operation,
        item.value,
        item.parameters,
        item.level,
      ]),
    );
    // Speed at 0.5 s is interpolated halfway between 1000 and 2000 rpm.
    assert.equal(target.project.values![1].value, 1500);
  } finally {
    engine.close();
    target.close();
  }
});

void test('workflow files save, read and replay value settings', async () => {
  const { engine, source } = await fixture();
  try {
    await engine.calculateValues([source.channels[1]], 'first-crossing', {
      threshold: 2500,
      edge: -1,
    });
    await engine.calculateValues([source.channels[1]], 'value-at', {
      time: 4,
    });
    await engine.calculateValues([source.channels[0]], 'rms');
    const extracted = extractWorkflow(engine.project, source.id, {
      name: 'Values',
      itemLabel: 'Run',
    });
    const text = serializeWorkflow(extracted.recipe);
    assert.match(text, /function: first-crossing/);
    assert.match(text, /edge: falling/);
    assert.match(text, /threshold: 2500/);
    assert.match(text, /time: 4/);
    const recipe = parseWorkflow(text);
    assert.deepEqual(recipe, extracted.recipe);
    assert.throws(
      () => parseWorkflow(text.replace('time: 4', 'threshold: 4')),
      /unknown setting "threshold"/,
    );
    assert.throws(
      () =>
        parseWorkflow(text.replace('function: rms', 'function: rms, time: 2')),
      /unknown setting "time"/,
    );
    assert.throws(
      () => parseWorkflow(text.replace('edge: falling', 'edge: sideways')),
      /edge must be one of: rising, falling/,
    );
    await engine.runWorkflow({
      recipe: text,
      batchId: crypto.randomUUID(),
      batchName: 'Replay',
      itemId: 'Copy',
      file: new File([CSV], 'copy.csv'),
    });
    const run = engine.project.workflowBatches![0].runs[0];
    const values = Object.values(run.steps).flatMap(
      (id) =>
        engine.project.workflowSteps!.find((step) => step.id === id)!.outputIds,
    );
    const replayed = values.map((id) =>
      engine.project.values!.find((item) => item.id === id)!,
    );
    // Speed never falls, so the falling crossing is unavailable.
    assert.deepEqual(
      replayed.map((item) => [item.operation, item.value, item.unit]),
      [
        ['first-crossing', null, 's'],
        ['value-at', 3000, 'rpm'],
        ['rms', 20, 'Nm'],
      ],
    );
  } finally {
    engine.close();
  }
});
