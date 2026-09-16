import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { FUNCTIONS } from '../lib/signal-functions';
import { isBinaryOperation } from '../lib/signal-arithmetic';
import { WorkflowIndex } from '../lib/workflow-history';
import { validateWorkspace } from '../lib/workspace-archive';
import { EXAMPLES, exampleDefinition } from '../lib/signal-examples';
import {
  buildExplorer,
  explorerRows,
  revealExplorer,
} from '../lib/signal-explorer';
import { segmentationOperation } from '../lib/segmentation-operation';
import type { Operation, Point } from '../lib/signal-types';

async function collect(engine: SignalEngine, id: string): Promise<Point[]> {
  const output: Point[] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      output.push([chunk.time[i], chunk.values[i]]);
  return output;
}

const input: Point[] = [
  [10, -2],
  [11, 4],
  [12, 10],
  [13, -6],
];
const values = (samples: number[]): Point[] =>
  samples.map((value, index) => [10 + index, value]);
const expected: Partial<
  Record<Operation, { parameter: number; points: Point[] }>
> = {
  smooth: { parameter: 2, points: values([-2, 1, 7, 2]) },
  median: { parameter: 3, points: values([-2, 1, 4, 4]) },
  exponential: { parameter: 0.5, points: values([-2, 1, 5.5, -0.25]) },
  'low-pass': {
    parameter: 1 / (2 * Math.PI),
    points: values([-2, 1, 5.5, -0.25]),
  },
  'high-pass': {
    parameter: 1 / (2 * Math.PI),
    points: values([0, 3, 4.5, -5.75]),
  },
  scale: { parameter: 2, points: values([-4, 8, 20, -12]) },
  offset: { parameter: 3, points: values([1, 7, 13, -3]) },
  absolute: { parameter: 0, points: values([2, 4, 10, 6]) },
  derivative: { parameter: 0, points: values([NaN, 6, 6, -16]) },
  integral: { parameter: 0, points: values([0, 1, 8, 10]) },
  'min-max': {
    parameter: 0,
    points: [
      [12, 10],
      [13, -6],
    ],
  },
  'time-shift': { parameter: -10, points: input.map(([t, v]) => [t - 10, v]) },
  'zero-time': { parameter: 0, points: input.map(([t, v]) => [t - 10, v]) },
  resample: {
    parameter: 2,
    points: [-2, 1, 4, 7, 10, 2, -6].map((v, i) => [10 + i / 2, v]),
  },
};

void test('every arithmetic operation evaluates samples, units and missing values and survives backup restore', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  const restored = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  await restored.open();
  try {
    const source = await engine.importCsv(
      new File(
        [
          't,A [V],B [V]\n0,-2,2\n1,4,0\n2,10,-5\n3,-6,-3\n4,,2\n5,3,\n6,1e308,1e308',
        ],
        'math.csv',
      ),
    );
    const cases = [
      { operation: 'add', unit: 'V', values: [0, 4, 5, -9, NaN, NaN, NaN] },
      {
        operation: 'subtract',
        unit: 'V',
        values: [-4, 4, 15, -3, NaN, NaN, 0],
      },
      {
        operation: 'multiply',
        unit: 'V·V',
        values: [-4, 0, -50, 18, NaN, NaN, NaN],
      },
      { operation: 'divide', unit: '1', values: [-1, NaN, -2, 2, NaN, NaN, 1] },
    ] as const;
    assert.deepEqual(
      FUNCTIONS.filter((spec) => isBinaryOperation(spec.operation)).map(
        (spec) => spec.operation,
      ),
      cases.map((item) => item.operation),
    );
    const ids: string[] = [];
    for (const item of cases) {
      const run = await engine.applyRegionFunction({
        sourceId: source.id,
        operation: item.operation,
        parameter: 0,
        inputIds: [source.channels[0]],
        secondaryIds: [source.channels[1]],
      });
      const id = run.outputs[0].signalId;
      ids.push(id);
      assert.equal(engine.find(id).unit, item.unit);
      assert.deepEqual(engine.find(id).parents, source.channels);
      assert.deepEqual(
        await collect(engine, id),
        item.values.map((value, time) => [time, value]),
      );
      assert.deepEqual(
        new WorkflowIndex(engine.project).owner.get(id)!.inputIds,
        source.channels,
      );
    }
    // A is also a valid B: squaring a signal must round-trip two ordered operands.
    const square = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'multiply',
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [source.channels[0]],
    });
    ids.push(square.outputs[0].signalId);
    assert.deepEqual(
      (await collect(engine, ids.at(-1)!)).map((point) => point[1]),
      [4, 16, 100, 36, NaN, 9, NaN],
    );
    const backup = await engine.backupWorkspace();
    await restored.restoreWorkspace(new File([backup], 'math.stratum'));
    for (const id of ids)
      assert.deepEqual(await collect(restored, id), await collect(engine, id));
    const invalid = structuredClone(engine.project);
    invalid.nodes.find((node) => node.id === ids[0])!.parents.pop();
    assert.throws(() => validateWorkspace(invalid), /two inputs/);
  } finally {
    engine.close();
    restored.close();
  }
});

void test('arithmetic validates entire batches and rejects unmatched recordings, units and sample grids atomically', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  try {
    const source = await engine.importCsv(
      new File(['t,A [V],B [V],Current [A]\n0,1,2,3\n1,4,5,6'], 'inputs.csv'),
    );
    const other = await engine.importCsv(
      new File(['t,B [V]\n0,1\n1,2'], 'other.csv'),
    );
    const shifted = await engine.derive(source.channels[1], 'time-shift', 1);
    const before = structuredClone(engine.project);
    const settings = {
      sourceId: source.id,
      operation: 'subtract' as const,
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [source.channels[1]],
    };
    await assert.rejects(
      engine.applyRegionFunction({
        ...settings,
        inputIds: [source.channels[0], source.channels[2]],
      }),
      /matching unit labels/,
    );
    await assert.rejects(
      engine.applyRegionFunction({ ...settings, secondaryIds: [shifted.id] }),
      /matching sample grids/,
    );
    await assert.rejects(
      engine.applyRegionFunction({ ...settings, secondaryIds: other.channels }),
      /same recording/,
    );
    await assert.rejects(
      engine.applyRegionFunction({ ...settings, secondaryIds: [] }),
      /second input/,
    );
    assert.deepEqual(engine.project, before);
    const run = await engine.applyRegionFunction({
      ...settings,
      operation: 'multiply',
      inputIds: [source.channels[0], source.channels[2]],
    });
    assert.equal(run.outputs.length, 2);
    assert.deepEqual(
      run.outputs.map((output) => engine.find(output.signalId).unit),
      ['V·V', 'A·V'],
    );
    assert.deepEqual(await collect(engine, run.outputs[1].signalId), [
      [0, 6],
      [1, 30],
    ]);
  } finally {
    engine.close();
  }
});

void test('arithmetic edits rebuild dependent signals and values with persistent Undo and secondary-input lineage', async () => {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  try {
    const source = await engine.importCsv(
      new File(['t,A [V],B [V]\n0,2,1\n1,4,3\n2,6,2'], 'edit.csv'),
    );
    const second = await engine.derive(source.channels[1], 'scale', 2);
    const settings = {
      sourceId: source.id,
      operation: 'add' as const,
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [second.id],
    };
    const run = await engine.applyRegionFunction(settings);
    const id = run.outputs[0].signalId;
    const child = await engine.derive(id, 'scale', 3);
    const [value] = await engine.calculateValues([child.id], 'maximum');
    const index = new WorkflowIndex(engine.project);
    const step = index.owner.get(id)!;
    assert.ok(
      index
        .lineage([child.id])
        .steps.some((item) => item.id === index.owner.get(second.id)!.id),
    );
    await engine.editOperation(step.id, {
      type: 'region-function',
      settings: { ...settings, operation: 'subtract' },
    });
    assert.deepEqual(await collect(engine, child.id), [
      [0, 0],
      [1, -6],
      [2, 6],
    ]);
    assert.equal(
      engine.project.values!.find((item) => item.id === value.id)!.value,
      6,
    );
    assert.equal(new WorkflowIndex(engine.project).owner.get(id)!.revision, 2);
    engine.close();
    await engine.open();
    await engine.travel('undo');
    assert.equal(
      engine.project.values!.find((item) => item.id === value.id)!.value,
      30,
    );
    await engine.travel('redo');
    assert.equal(
      engine.project.values!.find((item) => item.id === value.id)!.value,
      6,
    );
    await engine.deleteOperation(
      new WorkflowIndex(engine.project).owner.get(second.id)!.id,
    );
    assert.ok(
      !engine.project.nodes.some(
        (node) => node.id === id || node.id === child.id,
      ),
    );
    assert.equal(engine.project.values!.length, 0);
  } finally {
    engine.close();
  }
});

void test('every exposed single-input function produces independently calculated values, units and one function row', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  try {
    const source = await engine.importCsv(
      new File(['t,a [V]\n10,-2\n11,4\n12,10\n13,-6'], 'functions.csv'),
    );
    const specs = FUNCTIONS.filter(
      (spec) =>
        spec.operation !== 'segment' && !isBinaryOperation(spec.operation),
    );
    assert.equal(
      new Set(specs.map((spec) => spec.operation)).size,
      specs.length,
    );
    assert.equal(
      specs.length,
      Object.keys(expected).length,
      'Every library function needs an independent expected result',
    );
    for (const spec of specs) {
      if (spec.operation === 'segment') continue;
      const expectation = expected[spec.operation];
      assert.ok(expectation, spec.name);
      const output = await engine.derive(
        source.channels[0],
        spec.operation,
        expectation.parameter,
      );
      const points = await collect(engine, output.id);
      assert.equal(points.length, expectation.points.length, spec.name);
      points.forEach((point, index) =>
        point.forEach((value, axis) => {
          const wanted = expectation.points[index][axis];
          assert.ok(
            Number.isNaN(wanted)
              ? Number.isNaN(value)
              : Math.abs(value - wanted) < 1e-10,
            `${spec.name}: sample ${index}, axis ${axis}: ${value} != ${wanted}`,
          );
        }),
      );
      assert.equal(
        output.unit,
        spec.operation === 'integral'
          ? 'V·s'
          : spec.operation === 'derivative'
            ? 'V/s'
            : 'V',
      );
      assert.deepEqual(output.parents, [source.channels[0]]);
      const model = buildExplorer(engine.project, source.id);
      assert.equal(
        [...model.entries.values()].filter(
          (entry) => entry.node?.batchId === output.batchId && !entry.output,
        ).length,
        1,
      );
      const withDefault = await engine.derive(
        source.channels[0],
        spec.operation,
        spec.defaultValue,
      );
      assert.ok(
        (await engine.plot(withDefault.id)).summary.count > 0,
        `${spec.name} default must work`,
      );
    }
    assert.deepEqual(
      await collect(engine, source.channels[0]),
      input,
      'Raw samples remain unchanged',
    );
    const count = engine.project.nodes.length;
    for (const operation of [
      'unknown',
      'segment',
      'raw',
      'crop',
      'power',
      'bsfc',
      'add',
      'subtract',
      'multiply',
      'divide',
    ])
      await assert.rejects(
        engine.derive(source.channels[0], operation as Operation, 1),
        /implemented single-input/,
      );
    assert.equal(
      engine.project.nodes.length,
      count,
      'Unsupported operations must never publish passthrough results',
    );
  } finally {
    engine.close();
  }
});

void test('selectable examples compute real results, preserve user data, and reopen without duplicate operations', async () => {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  try {
    const user = await engine.importCsv(
      new File(['t,User signal\n0,17\n1,19'], 'user.csv'),
    );
    for (const spec of EXAMPLES) {
      const run = await engine.example(spec.key);
      const source = engine.project.sources.find(
        (item) => item.id === run.sourceId,
      )!;
      const saved = segmentationOperation(engine.project, run.segmentationId)!;
      assert.equal(saved.segmentIds.length, 3);
      assert.deepEqual(
        saved.definition,
        exampleDefinition(spec.key, saved.targetIds[0]),
      );
      const model = buildExplorer(engine.project, source.id);
      const items = [...model.entries.values()].filter(
        (entry) => entry.segmentationId === saved.id,
      );
      assert.equal(items.length, 1, `${spec.name}: one Segment function item`);
      assert.equal(items[0].members.length, 3);
      const revealed = revealExplorer(model, items[0].id, {
        query: 'nonexistent signal',
        closed: new Set(model.entries.keys()),
        expanded: new Set(),
      });
      const rows = explorerRows(model, revealed.expanded, revealed.query);
      assert.ok(rows.some((row) => row.entry.id === items[0].id));
      assert.ok(
        items[0].members.every((id) => rows.some((row) => row.entry.id === id)),
        'Creation must reveal all three outputs even after search/collapse',
      );
      assert.ok(
        items[0].members.every(
          (id) => !revealed.closed.has(id) || !revealed.expanded.has(id),
        ),
        'Do not expand every output channel list',
      );
      for (const id of run.outputIds) {
        const actual = await collect(engine, id);
        assert.ok(actual.length > 0);
        if (spec.chain) {
          assert.equal(actual.length, 2);
          const parent = await collect(engine, engine.find(id).parents[0]);
          const finite = parent
            .map((point) => point[1])
            .filter(Number.isFinite);
          assert.deepEqual(
            actual.map((point) => point[1]).sort((a, b) => a - b),
            [Math.min(...finite), Math.max(...finite)],
          );
        }
      }
      const count = engine.project.nodes.length;
      assert.deepEqual(await engine.example(spec.key), run);
      assert.equal(engine.project.nodes.length, count);
    }
    assert.deepEqual(await collect(engine, user.channels[0]), [
      [0, 17],
      [1, 19],
    ]);
    assert.equal(
      engine.project.sources.length,
      2,
      'Examples share one immutable demo source',
    );
    const snapshot = structuredClone(engine.project);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    try {
      for (const spec of EXAMPLES)
        assert.deepEqual(
          await reopened.example(spec.key),
          snapshot.examples!.find((item) => item.key === spec.key),
        );
      assert.equal(reopened.project.nodes.length, snapshot.nodes.length);
    } finally {
      reopened.close();
    }
  } finally {
    engine.close();
  }
});
