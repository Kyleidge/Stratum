import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { compileFormula, formulaProblem } from '../lib/formula';
import { conversionTargets, unitConversion } from '../lib/units';
import { WorkflowIndex } from '../lib/workflow-history';
import { savedCommand } from '../lib/workflow-lifecycle';
import { extractWorkflow } from '../lib/workflow-extract';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { validateWorkspace } from '../lib/workspace-archive';

const run = (
  expression: string,
  signals: number[] = [0],
  values: number[] = [],
) => compileFormula(expression).evaluate(signals, values);

void test('formulas follow arithmetic precedence and never evaluate code', () => {
  assert.equal(run('1 + 2 * 3 + A'), 7);
  assert.equal(run('-2 ^ 2 + A'), -4);
  assert.equal(run('2 ^ 3 ^ 2 + A'), 512);
  assert.equal(run('(1 + 2) * 3 + A'), 9);
  assert.equal(run('A % 3', [7]), 1);
  assert.equal(run('if(A > 2, 10, 20)', [3]), 10);
  assert.equal(run('and(A >= 1, A != 2) + or(0, 0) + not(A)', [1]), 1);
  assert.equal(run('min(A, B, 3) + max(A, B)', [5, 1]), 6);
  assert.equal(run('clamp(A, 0, 1) + hypot(3, 4)', [7]), 6);
  assert.equal(run('round(A * pi)', [1]), 3);
  assert.equal(run('A * k + B', [2, 1], [10]), 21);
  assert.equal(run('1.5e3 + .5 + A'), 1500.5);
  // Missing inputs and non-finite results are missing.
  assert.ok(Number.isNaN(run('A + B', [1, NaN])));
  assert.ok(Number.isNaN(run('A / 0', [1])));
  assert.ok(Number.isNaN(run('sqrt(A)', [-1])));
  // A missing input stays missing even where a comparison would hide it.
  assert.ok(Number.isNaN(run('A + (B > 1)', [1, NaN])));
  const formula = compileFormula('A * B / C + gain - offset_2');
  assert.deepEqual(formula.signals, ['A', 'B', 'C']);
  assert.deepEqual(formula.values, ['gain', 'offset_2']);
  for (const [text, problem] of [
    ['', /Enter a formula/],
    ['B + 1', /Use A, the input signal/],
    ['A + Torque', /"Torque" is not a variable/],
    ['A + foo(1)', /Unknown function "foo"/],
    ['A + sqrt(1, 2)', /sqrt takes 1 argument/],
    ['A + (1', /Expected "\)"/],
    ['A + 1)', /Unexpected "\)"/],
    ['A + $', /Unexpected "\$"/],
    ['A + max', /max needs \( \)/],
    ['A' + ' + 1'.repeat(200), /limited to 500 characters/],
    ['A + ' + '('.repeat(60) + '1' + ')'.repeat(60), /nested too deeply/],
    ['constructor.constructor("x")()', /is not a variable|Unexpected/],
  ] as const)
    assert.match(formulaProblem(text), problem, text);
});

void test('unit conversions are exact and only within one quantity', () => {
  const torque = unitConversion('lbf·ft', 'Nm')!;
  // One pound-force (exactly 4.4482216152605 N) at one foot (0.3048 m).
  assert.equal(torque.factor, 4.4482216152605 * 0.3048);
  assert.equal(torque.offset, 0);
  const temperature = unitConversion('°F', '°C')!;
  assert.ok(
    Math.abs(212 * temperature.factor + temperature.offset - 100) < 1e-12,
  );
  assert.ok(Math.abs(32 * temperature.factor + temperature.offset) < 1e-12);
  const back = unitConversion('°C', 'K')!;
  assert.deepEqual(back, { factor: 1, offset: 273.15 });
  assert.equal(unitConversion('Nm', 'rpm'), undefined);
  assert.equal(unitConversion('furlong', 'm'), undefined);
  // "g" is both a mass and an acceleration; each family offers its own units.
  assert.deepEqual(
    conversionTargets('g').map((item) => item.family),
    ['Mass', 'Acceleration'],
  );
  assert.ok(conversionTargets('rpm')[0].units.includes('rad/s'));
});

const CSV = [
  't,Torque [Nm],Speed [rpm],Oil [°F]',
  ...Array.from({ length: 10 }, (_, t) =>
    [t, 10 * (t + 1), 1000 * (t % 5 === 4 ? NaN : 1), 32 + 18 * t]
      .map((value) => (Number.isFinite(value) ? value : ''))
      .join(','),
  ),
].join('\n');
async function fixture() {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([CSV], 'formula.csv'));
  const [torque, speed, oil] = source.channels;
  return { engine, source, torque, speed, oil };
}
async function samples(engine: SignalEngine, id: string) {
  const values: number[] = [];
  for await (const chunk of engine.evaluate(id)) values.push(...chunk.values);
  return values.map((value) =>
    Number.isNaN(value) ? null : Number(value.toFixed(9)),
  );
}

void test('formula signals combine inputs and values on shared sample grids', async () => {
  const { engine, source, torque, speed } = await fixture();
  try {
    const [power] = await engine.deriveMany(
      [torque],
      'formula',
      0,
      true,
      undefined,
      {
        unit: 'kW',
        formula: { expression: 'A * B / 9549', signals: { B: [speed] } },
      },
    );
    assert.equal(power.unit, 'kW');
    assert.deepEqual(power.parents, [torque, speed]);
    assert.equal(power.expression, 'A * B / 9549');
    const values = await samples(engine, power.id);
    assert.equal(values[0], Number(((10 * 1000) / 9549).toFixed(9)));
    // Missing speed samples stay missing.
    assert.equal(values[4], null);
    // Segments of both channels share a grid, so B is matched per segment.
    const parts = await engine.segment(
      source.id,
      {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [0, 4.5],
          [5, 9],
        ],
      },
      source.channels,
      false,
      'file',
    );
    const torques = parts.map((part) => part.nodes[0]);
    const speeds = parts.map((part) => part.nodes[1]);
    const means = await engine.calculateValues(torques, 'sample-average');
    const outputs = await engine.deriveMany(
      torques,
      'formula',
      0,
      true,
      {
        mean: { valueIds: means.map((value) => value.id), factor: 1 },
      },
      {
        unit: 'Nm',
        formula: { expression: '(A - mean) * (B > 0)', signals: { B: speeds } },
      },
    );
    assert.deepEqual(
      outputs.map((node) => node.parents),
      [
        [torques[0], speeds[0]],
        [torques[1], speeds[1]],
      ],
    );
    // Speed is missing at 9 s, so that sample is missing too.
    assert.deepEqual(await samples(engine, outputs[1].id), [
      -20,
      -10,
      0,
      10,
      null,
    ]);
    assert.deepEqual(outputs[0].parameters, { mean: 30 });
    const index = new WorkflowIndex(engine.project);
    const step = index.owner.get(outputs[0].id)!;
    assert.deepEqual(step.inputIds, [
      ...new Set(outputs.flatMap((node) => node.parents)),
    ]);
    assert.deepEqual(
      step.valueInputIds,
      means.map((value) => value.id),
    );
    assert.deepEqual(savedCommand(engine.project, step), {
      type: 'derive-many',
      parentIds: torques,
      operation: 'formula',
      parameter: 0,
      bindings: {
        mean: { valueIds: means.map((value) => value.id), factor: 1 },
      },
      unit: 'Nm',
      formula: { expression: '(A - mean) * (B > 0)', signals: { B: speeds } },
    });
    await assert.rejects(
      engine.deriveMany([torques[0]], 'formula', 0, true, undefined, {
        unit: '',
        formula: { expression: 'A + B', signals: { B: [speed] } },
      }),
      /same sample grid/,
    );
    await assert.rejects(
      engine.deriveMany([torque], 'formula', 0, true, undefined, {
        unit: '',
        formula: { expression: 'A * gain' },
      }),
      /Choose a value for "gain"/,
    );
    await assert.rejects(
      engine.deriveMany([torque], 'formula', 0, true, undefined, {
        unit: '',
        formula: { expression: 'A + B' },
      }),
      /Choose a signal for B/,
    );
    // Edit changes the expression; output identities stay.
    await engine.editOperation(index.owner.get(power.id)!.id, {
      type: 'derive-many',
      parentIds: [torque],
      operation: 'formula',
      parameter: 0,
      unit: 'kW',
      formula: {
        expression: 'A * B * 2 * pi / 60000',
        signals: { B: [speed] },
      },
    });
    const edited = await samples(engine, power.id);
    assert.equal(
      edited[0],
      Number(((10 * 1000 * 2 * Math.PI) / 60000).toFixed(9)),
    );
  } finally {
    engine.close();
  }
});

void test('conversions change units exactly and are validated in backups', async () => {
  const { engine, torque, oil } = await fixture();
  try {
    const [celsius] = await engine.deriveMany(
      [oil],
      'convert',
      0,
      true,
      undefined,
      {
        unit: '°C',
      },
    );
    assert.equal(celsius.unit, '°C');
    assert.deepEqual(
      (await samples(engine, celsius.id)).slice(0, 3),
      [0, 10, 20],
    );
    await assert.rejects(
      engine.deriveMany([torque], 'convert', 0, true, undefined, {
        unit: 'kW',
      }),
      /no conversion from Nm to kW/,
    );
    await engine.deriveMany([torque], 'convert', 0, true, undefined, {
      unit: 'lbf·ft',
    });
    const [scaled] = await engine.deriveMany(
      [torque],
      'formula',
      0,
      true,
      undefined,
      {
        unit: 'Nm',
        formula: { expression: 'A * 2' },
      },
    );
    const project = engine.project;
    assert.doesNotThrow(() => validateWorkspace(structuredClone(project)));
    const factor = structuredClone(project);
    factor.nodes.find(
      (node) => node.operation === 'convert',
    )!.parameters.factor = 2;
    assert.throws(() => validateWorkspace(factor), /Invalid unit conversion/);
    const expression = structuredClone(project);
    expression.nodes.find((node) => node.id === scaled.id)!.expression =
      'B * 2';
    assert.throws(() => validateWorkspace(expression), /Invalid formula/);
  } finally {
    engine.close();
  }
});

void test('workflow files save formulas and conversions and replay them', async () => {
  const { engine, source, torque, speed, oil } = await fixture();
  try {
    const [peak] = await engine.calculateValues([torque], 'maximum');
    await engine.deriveMany(
      [torque],
      'formula',
      0,
      true,
      {
        peak: { valueIds: [peak.id], factor: 1 },
      },
      {
        unit: '',
        formula: { expression: 'A / peak + 0 * B', signals: { B: [speed] } },
      },
    );
    await engine.deriveMany([oil], 'convert', 0, true, undefined, {
      unit: '°C',
    });
    const recipe = extractWorkflow(engine.project, source.id, {
      name: 'Formula',
      itemLabel: 'Run',
    }).recipe;
    const text = serializeWorkflow(recipe);
    assert.match(text, /function: formula/);
    assert.match(text, /expression: A \/ peak \+ 0 \* B/);
    assert.match(text, /signals: \{ B: speed \}/);
    assert.match(text, /values: \{ peak: maximum \}/);
    assert.match(text, /function: convert/);
    assert.deepEqual(parseWorkflow(text), recipe);
    assert.throws(
      () =>
        parseWorkflow(text.replace('values: { peak: maximum }', 'values: {}')),
      /uses peak; list it under values/,
    );
    assert.throws(
      () =>
        parseWorkflow(
          text.replace('expression: A / peak + 0 * B', 'expression: A / ('),
        ),
      /expression:/,
    );
    const before = new Set(engine.project.nodes.map((node) => node.id));
    await engine.runWorkflow({
      recipe: text,
      batchId: crypto.randomUUID(),
      batchName: 'Replay',
      itemId: 'Copy',
      file: new File([CSV], 'copy.csv'),
    });
    const run = engine.project.workflowBatches![0].runs[0];
    assert.deepEqual(run.flags, []);
    const added = engine.project.nodes.filter((node) => !before.has(node.id));
    const ratio = added.find((node) => node.operation === 'formula')!;
    const converted = added.find((node) => node.operation === 'convert')!;
    assert.equal((await samples(engine, ratio.id))[0], 0.1);
    assert.deepEqual(
      (await samples(engine, converted.id)).slice(0, 2),
      [0, 10],
    );
  } finally {
    engine.close();
  }
});

void test('random IDs are version-4 UUIDs even without crypto.randomUUID', async () => {
  const { randomId } = await import('../lib/random-id');
  const pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(randomId(), pattern);
  // An insecure context (plain HTTP from another computer) lacks randomUUID.
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', {
    value: undefined,
    configurable: true,
  });
  try {
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    assert.equal(ids.size, 1000);
    for (const id of ids) assert.match(id, pattern);
  } finally {
    if (original) Object.defineProperty(crypto, 'randomUUID', original);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});
