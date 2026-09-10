import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { withWorkflowHistory, WorkflowIndex } from '../lib/workflow-history';
import { workflowRows } from '../lib/workflow-tree';
import type {
  EngineRequest,
  EngineResponse,
  Project,
  SignalNode,
} from '../lib/signal-types';
import { reportHtml, valuesCsv } from '../lib/workflow-delivery';
import { affectedOperations } from '../lib/workflow-lifecycle';
import { WORKFLOW_EXAMPLE } from '../lib/workflow-example';

void test('motor example creates chronological, executable signal lineage and five real values', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  try {
    const source = await engine.workflowExample();
    const project = engine.project;
    assert.equal(source.exampleKey, WORKFLOW_EXAMPLE);
    assert.equal(source.rows, 1801);
    assert.equal(project.nodes.length, 9);
    assert.equal(project.values!.length, 5);
    assert.deepEqual(
      project.workflowSteps!.map((step) => step.kind),
      ['import', 'derive', 'derive', 'segment', 'value', 'segment', 'value'],
    );
    assert.equal(project.regionSets?.length ?? 0, 0);
    const index = new WorkflowIndex(project);
    const find = (name: string) =>
      project.nodes.find((node) => index.label(node.id) === name)!;
    const smooth = find('Smoothed torque');
    const power = find('Brake power');
    assert.deepEqual(power.parents, [smooth.id, source.channels[0]]);
    const original = await samples(engine, source.channels[1]);
    const torque = await samples(engine, smooth.id);
    const speed = await samples(engine, source.channels[0]);
    const powerSamples = await samples(engine, power.id);
    for (const [i, point] of powerSamples.entries())
      assert.ok(
        Math.abs(
          point[1] - (torque[i][1] * speed[i][1] * 2 * Math.PI) / 60000,
        ) < 1e-9,
      );
    const run2 = find('Run 2 · Power');
    const first = find('Run 2 · First half · Power');
    assert.deepEqual(first.parents, [run2.id]);
    assert.deepEqual(engine.bounds(first.id), [65, 85]);
    for (const value of project.values!) {
      const points = await samples(engine, value.inputId);
      const expected =
        value.operation === 'maximum'
          ? Math.max(...points.map((point) => point[1]))
          : points
              .slice(1)
              .reduce(
                (sum, point, i) =>
                  sum +
                  ((point[1] + points[i][1]) / 2) * (point[0] - points[i][0]),
                0,
              ) /
            (points.at(-1)![0] - points[0][0]);
      assert.ok(Math.abs(value.value! - expected) < 1e-9);
      const lineage = index.lineage([value.id]);
      assert.equal(lineage.originals.length, 2);
      assert.ok(
        lineage.steps.every(
          (step, i) => i === 0 || step.sequence > lineage.steps[i - 1].sequence,
        ),
      );
    }
    assert.deepEqual(await samples(engine, source.channels[1]), original);
    assert.equal((await engine.workflowExample()).id, source.id);
    assert.equal(
      engine.project,
      project,
      'Reopening should preserve edits and IDs.',
    );
    const backup = await engine.backupWorkspace();
    await engine.restoreWorkspace(new File([backup], 'example.stratus'));
    assert.equal(engine.project.sources[0].exampleKey, WORKFLOW_EXAMPLE);
    assert.equal(engine.project.values!.length, 5);
  } finally {
    engine.close();
  }
});

void test('refresh replaces only the chosen synthetic recording and supports Undo after restart', async () => {
  const { engine, source, database } = await fixture();
  const importedSamples = await samples(engine, source.channels[0]);
  await engine.regionExample('ramps');
  const old = engine.project.sources.find((item) => item.synthetic)!;
  const before = structuredClone(engine.project);
  const fresh = await engine.workflowExample(true, old.id);
  assert.equal(engine.project.sources.length, 2);
  assert.ok(!engine.project.sources.some((item) => item.id === old.id));
  assert.equal(engine.project.regionSets?.length ?? 0, 0);
  assert.deepEqual(await samples(engine, source.channels[0]), importedSamples);
  assert.deepEqual(
    engine.project.workflowSteps!.filter((step) => step.sourceId === source.id),
    before.workflowSteps!.filter((step) => step.sourceId === source.id),
  );
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  try {
    await reopened.open();
    await reopened.recoverImports();
    await reopened.travel('undo');
    assert.deepEqual(reopened.project, before);
    assert.equal((await samples(reopened, old.channels[0])).length, old.rows);
    await reopened.travel('redo');
    assert.equal(reopened.project.sources[0].id, fresh.id);
    assert.equal((await samples(reopened, fresh.channels[0])).length, 1801);
    await assert.rejects(
      reopened.workflowExample(true, source.id),
      /Only a built-in example/,
    );
  } finally {
    reopened.close();
  }
});

void test('failed example construction leaves the workspace and Undo journal unchanged', async () => {
  const { engine, source, database } = await fixture();
  const before = structuredClone(engine.project);
  const originalRename = engine.rename.bind(engine);
  engine.rename = () => Promise.reject(new Error('Injected example failure'));
  await assert.rejects(engine.workflowExample(), /Injected example failure/);
  assert.deepEqual(engine.project, before);
  engine.rename = originalRename;
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  try {
    await reopened.open();
    await reopened.recoverImports();
    assert.deepEqual(reopened.project, before);
    assert.equal((await samples(reopened, source.channels[0])).length, 6);
    await reopened.travel('undo');
    assert.equal(reopened.project.sources.length, 0);
    const fresh = await reopened.workflowExample();
    assert.equal(fresh.exampleKey, WORKFLOW_EXAMPLE);
  } finally {
    reopened.close();
  }
});

void test('cancelling example calculations never publishes partially built history', async () => {
  const database = crypto.randomUUID();
  const engine = new SignalEngine((message) => {
    if (message.startsWith('Calculating')) engine.cancelled = true;
  }, database);
  await engine.open();
  try {
    await assert.rejects(engine.workflowExample(), /cancelled/);
    assert.equal(engine.project.sources.length, 0);
    assert.equal(engine.canUndo, false);
    engine.cancelled = false;
    await engine.recoverImports();
    await engine.initializeWorkflow();
    assert.equal(engine.project.workflowSteps!.length, 0);
  } finally {
    engine.close();
  }
});

void test('trigger segments retain trigger provenance and mixed-input batches never absorb siblings', async () => {
  const { engine, source } = await fixture(
    't,Measured [V],Trigger [V]\n0,1,0\n1,2,2\n2,3,2\n3,4,0\n4,5,0',
  );
  try {
    const trigger = await engine.derive(source.channels[1], 'scale', 2);
    const parts = await engine.segment(
      source.id,
      {
        method: 'triggers',
        boundary: 'clip',
        minimumDuration: 0,
        start: {
          signalId: trigger.id,
          threshold: 2,
          edge: 'rising',
          offset: 0,
        },
        end: { signalId: trigger.id, threshold: 2, edge: 'falling', offset: 0 },
      },
      [source.channels[0]],
      false,
      'signals',
    );
    assert.equal(parts.length, 1);
    const segmentId = parts[0].nodes[0];
    const branch = await engine.deriveMany(
      [segmentId, source.channels[0]],
      'scale',
      3,
    );
    const index = new WorkflowIndex(engine.project);
    assert.deepEqual(
      new Set(index.lineage([segmentId]).originals.map((node) => node.id)),
      new Set(source.channels),
    );
    const step = index.owner.get(segmentId)!;
    assert.deepEqual(step.inputIds, [source.channels[0], trigger.id]);
    assert.deepEqual(
      index.owner.get(branch[0].id)?.outputIds,
      branch.map((node) => node.id),
    );
    assert.ok(index.label(branch[0].id).startsWith('Segment 01'));
    assert.ok(!index.label(branch[1].id).startsWith('Segment'));
    await engine.calculateValues([branch[1].id], 'maximum');
    const valueStep = engine.project.workflowSteps!.at(-1)!;
    assert.deepEqual(valueStep.inputIds, [branch[1].id]);
    const value = engine.project.values!.at(-1)!;
    assert.equal(value.value, 15);
    const valueLineage = new WorkflowIndex(engine.project).lineage([value.id]);
    assert.ok(!valueLineage.steps.some((item) => item.id === step.id));
  } finally {
    engine.close();
  }
});

void test('CSV exports keep formula-like raw names as text and unavailable summaries blank', async () => {
  const { engine, source } = await fixture(
    't,=1+1 [Nm],Missing [V]\n0,1,\n1,2,',
  );
  try {
    const raw = await (await engine.exportSamples([source.channels[0]])).text();
    assert.ok(raw.includes('"\'=1+1"'));
    const summary = await (await engine.exportSummary(source.channels)).text();
    assert.ok(summary.includes('"\'=1+1"'));
    assert.ok(!summary.includes('NaN'));
    assert.ok(!summary.includes('Infinity'));
  } finally {
    engine.close();
  }
});

async function fixture(
  csv = 't,Torque [Nm],Speed [rpm]\n0,0,1000\n1,10,2000\n4,10,3000\n5,,4000\n7,30,5000\n8,30,6000',
) {
  const database = crypto.randomUUID();
  const engine = new SignalEngine(undefined, database);
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([csv], 'workflow.csv'));
  return { engine, source, database };
}
async function samples(engine: SignalEngine, id: string) {
  const values: [number, number][] = [];
  for await (const chunk of engine.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      values.push([chunk.time[i], chunk.values[i]]);
  return values;
}

void test('Undo to an empty workspace retains Redo after restart and initialization', async () => {
  const { engine, source, database } = await fixture();
  await engine.travel('undo');
  engine.close();
  const reopened = new SignalEngine(undefined, database);
  try {
    await reopened.open();
    await reopened.initializeWorkflow();
    assert.equal(reopened.project.sources.length, 0);
    assert.ok(reopened.canRedo);
    await reopened.travel('redo');
    assert.equal(reopened.project.sources[0].id, source.id);
    assert.equal((await samples(reopened, source.channels[0])).length, 6);
  } finally {
    reopened.close();
  }
});

void test('worker cancellation includes queued mutations, coalesces inspections, and recovers from lock rejection', async () => {
  const priorPost = globalThis.postMessage;
  const priorHandler = globalThis.onmessage;
  const priorLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const pending = new Map<number, (response: EngineResponse) => void>();
  let rejectLock = false;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, run: () => Promise<void>) => {
        if (rejectLock) {
          rejectLock = false;
          throw new Error('Injected lock failure');
        }
        await run();
      },
    },
  });
  globalThis.postMessage = (response: EngineResponse) => {
    if (response.type !== 'progress')
      pending.get(response.requestId)?.(response);
  };
  await import('../lib/signal.worker');
  let sequence = 0;
  const send = (message: EngineRequest) => {
    const requestId = ++sequence;
    const response = new Promise<EngineResponse>((resolve) =>
      pending.set(requestId, resolve),
    );
    const handler = globalThis.onmessage as (event: MessageEvent) => void;
    handler({ data: { ...message, requestId } } as MessageEvent);
    return { requestId, response };
  };
  try {
    assert.equal(
      (await send({ type: 'init-workflow' }).response).type,
      'project',
    );
    const loaded = await send({
      type: 'import',
      file: new File(['t,A [V]\n0,1\n1,2\n2,3'], 'worker.csv'),
    }).response;
    assert.equal(loaded.type, 'project');
    if (loaded.type !== 'project') throw new Error('Import failed.');
    const id = loaded.project.sources[0].channels[0];
    const first = send({ type: 'view', ids: [id], inspection: true });
    const second = send({ type: 'view', ids: [id], inspection: true });
    const third = send({ type: 'view', ids: [id], inspection: true });
    assert.equal((await first.response).type, 'error');
    assert.equal((await second.response).type, 'error');
    assert.equal((await third.response).type, 'plots');
    const backup = send({ type: 'backup-workspace' });
    const cancelled = send({
      type: 'derive-many',
      parentIds: [id],
      operation: 'scale',
      parameter: 2,
    });
    send({ type: 'cancel', requestIds: [cancelled.requestId] });
    assert.equal((await backup.response).type, 'export');
    const stopped = await cancelled.response;
    assert.equal(stopped.type, 'error');
    rejectLock = true;
    const failed = await send({ type: 'rename', id, name: 'Must not save' })
      .response;
    assert.equal(failed.type, 'error');
    const healthy = await send({ type: 'rename', id, name: 'Recovered' })
      .response;
    assert.equal(healthy.type, 'project');
    if (healthy.type === 'project') {
      assert.equal(
        healthy.project.nodes.length,
        1,
        'Cancelled queued mutation committed',
      );
      assert.equal(healthy.project.labels?.[id], 'Recovered');
    }
  } finally {
    globalThis.postMessage = priorPost;
    globalThis.onmessage = priorHandler;
    if (priorLocks) Object.defineProperty(navigator, 'locks', priorLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  }
});

void test('interrupted-import recovery preserves Redo sources and unknown legacy storage', async () => {
  const { engine, source, database } = await fixture();
  await engine.travel('undo');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction(['project', 'chunks'], 'readwrite');
    tx.objectStore('project').put(true, ['pending-import', 'orphan']);
    tx.objectStore('project').put(true, ['pending-import', source.id]);
    tx.objectStore('chunks').put(new Float64Array([1]), ['orphan', 0, 'time']);
    tx.objectStore('chunks').put(new Float64Array([1]), ['legacy', 0, 'time']);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await engine.recoverImports();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db
        .transaction('chunks')
        .objectStore('chunks')
        .getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.ok(!keys.some((key) => Array.isArray(key) && key[0] === 'orphan'));
    assert.ok(keys.some((key) => Array.isArray(key) && key[0] === 'legacy'));
    await engine.travel('redo');
    assert.equal((await samples(engine, source.channels[0])).length, 6);
  } finally {
    db.close();
    engine.close();
  }
});

void test('editing atomically recalculates descendants and persistent Undo/Redo restores recipes and values', async () => {
  const { engine, source, database } = await fixture();
  try {
    const scaled = await engine.derive(source.channels[0], 'scale', 2);
    const [segment] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[1, 4]] },
      [scaled.id],
      false,
      'signals',
    );
    const [value] = await engine.calculateValues([segment.nodes[0]], 'maximum');
    const original = await samples(engine, source.channels[0]);
    const step = new WorkflowIndex(engine.project).owner.get(scaled.id)!;
    await engine.editOperation(step.id, {
      type: 'derive-many',
      parentIds: [source.channels[0]],
      operation: 'scale',
      parameter: 3,
    });
    assert.equal(
      engine.project.values!.find((item) => item.id === value.id)!.value,
      30,
    );
    assert.deepEqual(await samples(engine, source.channels[0]), original);
    assert.equal(
      new WorkflowIndex(engine.project).owner.get(scaled.id)!.revision,
      2,
    );
    assert.equal(engine.project.workflowSteps!.length, 4);
    const committed = structuredClone(engine.project);
    await assert.rejects(() =>
      engine.editOperation(step.id, {
        type: 'derive-many',
        parentIds: [segment.nodes[0]],
        operation: 'scale',
        parameter: 5,
      }),
    );
    assert.deepEqual(engine.project, committed);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    assert.ok(reopened.canUndo);
    await reopened.travel('undo');
    assert.equal(
      reopened.project.values!.find((item) => item.id === value.id)!.value,
      20,
    );
    await reopened.travel('redo');
    assert.equal(
      reopened.project.values!.find((item) => item.id === value.id)!.value,
      30,
    );
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('deletion previews and removes dependent invocations, retains unrelated branches, and is reversible', async () => {
  const { engine, source, database } = await fixture();
  try {
    const a = await engine.derive(source.channels[0], 'scale', 2);
    const b = await engine.derive(source.channels[1], 'offset', 10);
    await engine.calculateValues([a.id], 'maximum');
    const id = new WorkflowIndex(engine.project).owner.get(a.id)!.id;
    assert.equal(affectedOperations(engine.project, id).length, 2);
    await engine.deleteOperation(id);
    assert.ok(!engine.project.nodes.some((node) => node.id === a.id));
    assert.ok(engine.project.nodes.some((node) => node.id === b.id));
    assert.equal(engine.project.values!.length, 0);
    await engine.travel('undo');
    assert.ok(engine.project.nodes.some((node) => node.id === a.id));
    await engine.deleteOperation(`import:${source.id}`);
    assert.equal(engine.project.sources.length, 0);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    await reopened.initializeWorkflow();
    assert.equal(reopened.project.sources.length, 0);
    await reopened.travel('undo');
    assert.equal(reopened.project.sources.length, 1);
    assert.ok((await samples(reopened, a.id)).length);
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('segmentation edits reject unsafe cardinality changes and value edits preserve output identity', async () => {
  const { engine, source } = await fixture();
  try {
    const [segment] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[0, 4]] },
      [source.channels[0]],
      false,
      'signals',
    );
    const [value] = await engine.calculateValues(segment.nodes, 'minimum');
    const index = new WorkflowIndex(engine.project),
      before = structuredClone(engine.project);
    await assert.rejects(
      () =>
        engine.editOperation(index.owner.get(segment.nodes[0])!.id, {
          type: 'segment',
          sourceId: source.id,
          definition: {
            method: 'ranges',
            boundary: 'clip',
            ranges: [
              [0, 1],
              [1, 4],
            ],
          },
          targetIds: [source.channels[0]],
          independently: false,
          scope: 'signals',
        }),
      /number of outputs/,
    );
    assert.deepEqual(engine.project, before);
    await engine.editOperation(index.owner.get(value.id)!.id, {
      type: 'calculate-values',
      inputIds: segment.nodes,
      operation: 'maximum',
    });
    assert.equal(
      engine.project.values!.find((item) => item.id === value.id)!.value,
      10,
    );
  } finally {
    engine.close();
  }
});

void test('lifecycle dependencies include saved inputs that produced no segment output', async () => {
  const { engine, source } = await fixture();
  try {
    const [early] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[0, 1]] },
      [source.channels[0]],
      false,
      'signals',
    );
    const earlyStep = new WorkflowIndex(engine.project).owner.get(
      early.nodes[0],
    )!;
    const later = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[4, 7]] },
      [early.nodes[0], source.channels[1]],
      true,
      'signals',
    );
    assert.equal(later.length, 1);
    assert.equal(affectedOperations(engine.project, earlyStep.id).length, 2);
    await engine.deleteOperation(earlyStep.id);
    assert.equal(engine.project.segmentationOperations!.length, 0);
    assert.equal(engine.project.segments.length, 0);
    await engine.travel('undo');
    assert.ok((await samples(engine, later[0].nodes[0])).length);
  } finally {
    engine.close();
  }
});

void test('workspace backup round trips nested samples, gaps, aliases and values; invalid restores are atomic', async () => {
  const { engine, source } = await fixture();
  const target = new SignalEngine(undefined, crypto.randomUUID());
  await target.open();
  await target.initializeWorkflow();
  try {
    const derived = await engine.derive(source.channels[0], 'time-shift', 3);
    const [value] = await engine.calculateValues([derived.id], 'time-average');
    await engine.rename(derived.id, 'Reviewed signal');
    const backup = await engine.backupWorkspace();
    await target.restoreWorkspace(new File([backup], 'backup.stratus'));
    assert.deepEqual(
      await samples(target, derived.id),
      await samples(engine, derived.id),
    );
    assert.equal(
      new WorkflowIndex(target.project).label(derived.id),
      'Reviewed signal',
    );
    assert.equal(
      target.project.values!.find((item) => item.id === value.id)!.value,
      value.value,
    );
    const before = structuredClone(target.project);
    const truncated = (await backup.text()).split('\n').slice(0, -2).join('\n');
    await assert.rejects(() =>
      target.restoreWorkspace(new File([truncated], 'truncated.stratus')),
    );
    assert.deepEqual(target.project, before);
    assert.deepEqual(
      await samples(target, derived.id),
      await samples(engine, derived.id),
    );
    await target.travel('undo');
    assert.equal(target.project.sources.length, 0);
  } finally {
    engine.close();
    target.close();
  }
});

void test('a stale writer cannot delete or edit a newer workspace', async () => {
  const { engine, source, database } = await fixture();
  const stale = new SignalEngine(undefined, database);
  await stale.open();
  try {
    await engine.derive(source.channels[0], 'scale', 2);
    await assert.rejects(
      () => stale.deleteOperation(`import:${source.id}`),
      /another window/,
    );
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    assert.equal(reopened.project.nodes.length, 3);
    reopened.close();
  } finally {
    engine.close();
    stale.close();
  }
});

void test('archive validation rejects corrupt display, value, history and sample metadata before replacing work', async () => {
  const { engine, source } = await fixture();
  try {
    const scaled = await engine.derive(source.channels[0], 'scale', 2);
    await engine.derive(scaled.id, 'offset', 10);
    await engine.calculateValues([scaled.id], 'maximum');
    const lines = (await (await engine.backupWorkspace()).text())
      .trimEnd()
      .split('\n');
    const before = structuredClone(engine.project);
    const corruptions: ((project: Project) => void)[] = [
      (p) => {
        Reflect.set(p, 'labels', { [scaled.id]: { broken: true } });
      },
      (p) => {
        Reflect.deleteProperty(p.values![0], 'sampleCount');
      },
      (p) => {
        p.workflowSteps![2].inputIds = [];
      },
      (p) => {
        Reflect.deleteProperty(p.sources[0], 'chunkRanges');
      },
      (p) => {
        p.sources[0].chunkRanges[0][1] = 999;
      },
      (p) => {
        p.nodes.find((node) => node.id === scaled.id)!.parameters = {};
      },
      (p) => {
        p.workflowSteps![2].outputIds = [scaled.id];
      },
      (p) => {
        Reflect.set(p, 'functionRuns', { invalid: true });
      },
    ];
    for (const corrupt of corruptions) {
      const header = JSON.parse(lines[0]) as { project: Project };
      corrupt(header.project);
      await assert.rejects(() =>
        engine.restoreWorkspace(
          new File(
            [[JSON.stringify(header), ...lines.slice(1)].join('\n')],
            'invalid.stratus',
          ),
        ),
      );
      assert.deepEqual(engine.project, before);
      assert.equal((await samples(engine, scaled.id))[1][1], 20);
    }
  } finally {
    engine.close();
  }
});

void test('binary unit variants and legacy region workflows round trip through the same archive validator', async () => {
  const { engine, source } = await fixture(
    't,Torque [N·m],Speed [RPM],Fuel [kg/h]\n0,10,1000,2\n1,20,2000,3\n2,30,3000,4',
  );
  const restored = new SignalEngine(undefined, crypto.randomUUID());
  await restored.open();
  try {
    const power = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'power',
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [source.channels[1]],
    });
    const bsfc = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'bsfc',
      parameter: 0,
      inputIds: [source.channels[2]],
      secondaryIds: [power.outputs[0].signalId],
    });
    await restored.restoreWorkspace(
      new File([await engine.backupWorkspace()], 'binary.stratus'),
    );
    assert.deepEqual(
      await samples(restored, bsfc.outputs[0].signalId),
      await samples(engine, bsfc.outputs[0].signalId),
    );
    const set = await engine.createRegions({
      sourceId: source.id,
      name: 'Ranges',
      timeReference: 'recording',
      definition: {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [0, 1],
          [1, 2],
        ],
      },
    });
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 2,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    await restored.restoreWorkspace(
      new File([await engine.backupWorkspace()], 'regions.stratus'),
    );
    assert.deepEqual(
      await samples(restored, run.outputs[0].signalId),
      await samples(engine, run.outputs[0].signalId),
    );
  } finally {
    engine.close();
    restored.close();
  }
});

void test('deleting migrated segmentation removes owned region scopes while deleting a metric preserves shared ranges', async () => {
  const { engine, source } = await fixture();
  try {
    await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[0, 4]] },
      source.channels,
      false,
      'file',
    );
    const segmentation = engine.project.workflowSteps!.at(-1)!;
    await engine.initializeRegions();
    const set = engine.project.regionSets!.find(
      (set) => set.id === segmentation.segmentationId,
    )!;
    assert.ok(set);
    const first = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 2,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    const second = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 3,
      inputIds: [source.channels[0]],
      regionSetId: set.id,
    });
    const index = new WorkflowIndex(engine.project);
    await engine.deleteOperation(
      index.owner.get(first.outputs[0].signalId)!.id,
    );
    assert.ok(engine.project.regionSets!.some((item) => item.id === set.id));
    assert.ok(
      engine.project.nodes.some(
        (item) => item.id === second.outputs[0].signalId,
      ),
    );
    await engine.deleteOperation(segmentation.id);
    assert.ok(!engine.project.regionSets!.some((item) => item.id === set.id));
    assert.ok(
      !engine.project.workflowSteps!.some(
        (item) => item.regionSetId === set.id,
      ),
    );
    assert.ok(
      !engine.project.nodes.some(
        (item) => item.id === second.outputs[0].signalId,
      ),
    );
    await engine.travel('undo');
    assert.ok((await samples(engine, second.outputs[0].signalId)).length);
  } finally {
    engine.close();
  }
});

void test('sample exports contain evaluated nested and shifted samples, including missing values', async () => {
  const { engine, source } = await fixture();
  try {
    const [part] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[1, 8]] },
      [source.channels[0]],
      false,
      'signals',
    );
    const [nested] = await engine.segment(
      source.id,
      { method: 'ranges', boundary: 'clip', ranges: [[4, 7]] },
      [part.nodes[0]],
      false,
      'signals',
    );
    const shifted = await engine.derive(nested.nodes[0], 'time-shift', 10);
    const expected = await samples(engine, shifted.id);
    const blob = await engine.exportSamples([shifted.id]);
    const lines = (await blob.text()).trim().split('\r\n');
    assert.equal(lines[0], 'Signal,Signal ID,Recording,Unit,Time (s),Value');
    assert.equal(lines.length, expected.length + 1);
    assert.deepEqual(
      lines.slice(1).map((line) => line.split(',').slice(-2)),
      expected.map(([time, value]) => [
        String(time),
        Number.isFinite(value) ? String(value) : '',
      ]),
    );
    assert.ok(
      lines.some((line) => line.endsWith(',')),
      'missing sample remains blank',
    );
  } finally {
    engine.close();
  }
});

void test('delivery respects exact value scope, escapes labels and excludes sibling outputs from lineage', async () => {
  const { engine, source } = await fixture();
  try {
    const parts = await engine.segment(
      source.id,
      {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [0, 4],
          [7, 8],
        ],
      },
      [source.channels[0]],
      false,
      'signals',
    );
    const values = await engine.calculateValues(
      parts.map((part) => part.nodes[0]),
      'maximum',
    );
    const before = structuredClone(engine.project);
    const one = valuesCsv(engine.project, [values[0].id]);
    assert.equal(one.split('\r\n').length, 2);
    assert.equal(
      valuesCsv(
        engine.project,
        values.map((value) => value.id),
      ).split('\r\n').length,
      3,
    );
    const index = new WorkflowIndex(engine.project);
    const lineage = index.lineage([values[0].id]);
    const rows = workflowRows(
      lineage.steps,
      index,
      new Set(),
      '',
      values[0].id,
      lineage.outputIds,
    );
    assert.ok(rows.some((row) => row.outputId === parts[0].nodes[0]));
    assert.ok(!rows.some((row) => row.outputId === parts[1].nodes[0]));
    const report = reportHtml(
      engine.project,
      [values[0].id],
      [],
      new Date('2026-09-10T12:00:00Z'),
    );
    assert.ok(report.includes('Contributing operation history'));
    assert.ok(!report.includes(index.label(parts[1].nodes[0])));
    assert.deepEqual(
      engine.project,
      before,
      'delivery must never mutate history',
    );
    engine.project.sources[0].name = '<script>alert(1)</script>';
    engine.project.nodes.find((node) => node.id === parts[0].nodes[0])!.name =
      '=SUM(1)<img src=x>';
    const unsafe = reportHtml(engine.project, [values[0].id], []);
    assert.ok(!unsafe.includes('<script>'));
    assert.ok(unsafe.includes('&lt;script&gt;'));
    const signalCsv = await (
      await engine.exportSamples([parts[0].nodes[0]])
    ).text();
    assert.ok(!signalCsv.includes('\n"=SUM'));
    const plot = await engine.plot(parts[0].nodes[0]);
    const signalReport = reportHtml(
      engine.project,
      [parts[0].nodes[0]],
      [plot],
    );
    assert.ok(signalReport.includes('<svg'));
    assert.ok(signalReport.includes('min/max envelope'));
  } finally {
    engine.close();
  }
});

void test('time averages weight valid elapsed time; extrema and sample averages are separate scalar records', async () => {
  const { engine, source, database } = await fixture();
  try {
    const before = structuredClone(engine.project.nodes);
    const [time] = await engine.calculateValues(
      [source.channels[0]],
      'time-average',
    );
    const [mean] = await engine.calculateValues(
      [source.channels[0]],
      'sample-average',
    );
    const [minimum] = await engine.calculateValues(
      [source.channels[0]],
      'minimum',
    );
    const [maximum] = await engine.calculateValues(
      [source.channels[0]],
      'maximum',
    );
    // Integral = 5 + 30 + 30; valid duration = 1 + 3 + 1. No bridge across NaN.
    assert.equal(time.value, 13);
    assert.equal(time.validDuration, 5);
    assert.equal(time.sampleCount, 5);
    assert.equal(mean.value, 16);
    assert.equal(minimum.value, 0);
    assert.equal(minimum.timestamp, 0);
    assert.equal(maximum.value, 30);
    assert.equal(maximum.timestamp, 7);
    assert.deepEqual(engine.project.nodes, before);
    assert.equal(engine.project.workflowSteps?.length, 5);
    await assert.rejects(
      engine.derive(time.id, 'scale', 2),
      /Signal no longer exists/,
    );
    const saved = structuredClone(engine.project);
    engine.close();
    const reopened = new SignalEngine(undefined, database);
    await reopened.open();
    await reopened.initializeWorkflow();
    assert.deepEqual(reopened.project, saved);
    reopened.close();
  } finally {
    engine.close();
  }
});

void test('empty and single-sample value domains are explicit; invalid batches append nothing', async () => {
  const { engine, source } = await fixture(
    't,Empty [V],Single [V]\n0,,3\n1,,\n2,,',
  );
  try {
    const values = await engine.calculateValues(
      source.channels,
      'time-average',
    );
    assert.deepEqual(
      values.map((value) => value.value),
      [null, null],
    );
    const min = await engine.calculateValues(source.channels, 'minimum');
    assert.deepEqual(
      min.map((value) => value.value),
      [null, 3],
    );
    const saved = structuredClone(engine.project);
    await assert.rejects(
      engine.calculateValues([source.channels[0], 'missing'], 'maximum'),
    );
    await assert.rejects(
      engine.calculateValues(
        [source.channels[0], source.channels[0]],
        'minimum',
      ),
      /unique/,
    );
    engine.cancelled = true;
    await assert.rejects(
      engine.calculateValues(source.channels, 'maximum'),
      /cancelled/,
    );
    engine.cancelled = false;
    assert.deepEqual(engine.project, saved);
  } finally {
    engine.close();
  }
});

void test('original → derive → segment → derive → nested segment → value preserves inputs and chronology', async () => {
  const { engine, source } = await fixture(
    't,A [V]\n0,1\n1,2\n2,3\n3,4\n4,5\n5,6',
  );
  try {
    const original = await samples(engine, source.channels[0]);
    const originalNodes = structuredClone(engine.project.nodes);
    const derived = await engine.derive(source.channels[0], 'scale', 2);
    const parts = await engine.segment(
      source.id,
      {
        method: 'ranges',
        ranges: [
          [0, 2],
          [3, 5],
        ],
        boundary: 'clip',
      },
      [derived.id],
      false,
      'signals',
    );
    const filtered = await engine.deriveMany(
      parts.map((part) => part.nodes[0]),
      'smooth',
      2,
    );
    const nested = await engine.segment(
      source.id,
      { method: 'ranges', ranges: [[0.5, 1.5]], boundary: 'clip' },
      [filtered[0].id],
      false,
      'signals',
    );
    const [value] = await engine.calculateValues(
      [nested[0].nodes[0]],
      'maximum',
    );
    assert.equal(value.value, 3);
    assert.deepEqual(await samples(engine, source.channels[0]), original);
    assert.deepEqual(
      engine.project.nodes.slice(0, originalNodes.length),
      originalNodes,
    );
    assert.deepEqual(await samples(engine, nested[0].nodes[0]), [[1, 3]]);
    const index = new WorkflowIndex(engine.project);
    const steps = engine.project.workflowSteps!;
    assert.deepEqual(
      steps.map((step) => step.kind),
      ['import', 'derive', 'segment', 'derive', 'segment', 'value'],
    );
    assert.equal(steps[2].outputIds.length, 2);
    assert.equal(steps[3].outputIds.length, 2);
    assert.equal(steps[4].inputIds[0], filtered[0].id);
    assert.equal(index.owner.get(value.id)?.id, steps[5].id);
    assert.deepEqual(
      index.lineage([value.id]).steps.map((step) => step.id),
      steps.map((step) => step.id),
    );
    assert.deepEqual(
      index.lineage([value.id]).originals.map((node) => node.id),
      [source.channels[0]],
    );
    assert.equal(index.consumers.get(filtered[0].id)?.[0].id, steps[4].id);
    const snapshot = structuredClone(steps);
    await engine.segment(
      source.id,
      { method: 'ranges', ranges: [[0, 1]], boundary: 'clip' },
      [derived.id],
    );
    assert.deepEqual(engine.project.workflowSteps!.slice(0, -1), snapshot);
    assert.deepEqual(await samples(engine, nested[0].nodes[0]), [[1, 3]]);
  } finally {
    engine.close();
  }
});

void test('scalar batches commit atomically and reject concurrent writers', async () => {
  const { engine, source, database } = await fixture();
  const other = new SignalEngine(undefined, database);
  try {
    await other.open();
    const values = await engine.calculateValues(source.channels, 'maximum');
    const step = engine.project.workflowSteps!.at(-1)!;
    assert.equal(step.outputIds.length, 2);
    assert.deepEqual(
      step.outputIds,
      values.map((value) => value.id),
    );
    await assert.rejects(
      other.calculateValues(source.channels, 'minimum'),
      /another window/,
    );
    assert.equal(other.project.values, undefined);
    assert.equal(other.project.workflowSteps?.length, 1);
  } finally {
    engine.close();
    other.close();
  }
});

void test('time integration stays continuous across storage chunks', async () => {
  const { engine, source } = await fixture(
    't,A [V]\n' +
      Array.from({ length: 16400 }, (_, i) => `${i},${i}`).join('\n'),
  );
  try {
    const [value] = await engine.calculateValues(
      source.channels,
      'time-average',
    );
    assert.equal(value.value, 8199.5);
    assert.equal(value.validDuration, 16399);
  } finally {
    engine.close();
  }
});

void test('legacy region crops become usable derived outputs without changing recipes or duplicating migration', async () => {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  try {
    await engine.open();
    const source = await engine.demo(false);
    const set = await engine.createRegions({
      sourceId: source.id,
      name: 'Saved ranges',
      timeReference: 'recording',
      definition: {
        method: 'ranges',
        boundary: 'clip',
        ranges: [
          [15, 20],
          [25, 30],
        ],
      },
    });
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'scale',
      parameter: 2,
      inputIds: [source.channels[1]],
      regionSetId: set.id,
    });
    const before = structuredClone(engine.project);
    await engine.initializeWorkflow();
    assert.deepEqual(engine.project.nodes, before.nodes);
    assert.deepEqual(engine.project.regionSets, before.regionSets);
    assert.deepEqual(engine.project.functionRuns, before.functionRuns);
    const index = new WorkflowIndex(engine.project);
    for (const node of engine.project.nodes)
      assert.ok(index.owner.has(node.id));
    assert.equal(
      engine.project.workflowSteps!.filter((step) => step.kind === 'segment')
        .length,
      1,
    );
    const parent = engine.project.nodes.find(
      (node) => node.id === run.outputs[0].signalId,
    )!.parents[0];
    assert.equal(index.kind(parent), 'Derived signal');
    const history = structuredClone(engine.project.workflowSteps);
    await engine.initializeWorkflow();
    assert.deepEqual(engine.project.workflowSteps, history);
    const [value] = await engine.calculateValues([parent], 'maximum');
    assert.ok(value.value !== null && value.value > 0);
  } finally {
    engine.close();
  }
});

void test('binary and trigger lineage retains all parents; ties and backwards clocks cannot reorder saved steps', async () => {
  const { engine, source } = await fixture();
  try {
    const run = await engine.applyRegionFunction({
      sourceId: source.id,
      operation: 'power',
      parameter: 0,
      inputIds: [source.channels[0]],
      secondaryIds: [source.channels[1]],
    });
    const step = engine.project.workflowSteps!.at(-1)!;
    const old = structuredClone(engine.project.workflowSteps);
    assert.deepEqual(new Set(step.inputIds), new Set(source.channels));
    const [value] = await engine.calculateValues(
      [run.outputs[0].signalId],
      'minimum',
    );
    const lineage = new WorkflowIndex(engine.project).lineage([value.id]);
    assert.deepEqual(
      new Set(lineage.originals.map((node) => node.id)),
      new Set(source.channels),
    );
    assert.deepEqual(engine.project.workflowSteps!.slice(0, -1), old);
    const newNode: SignalNode = {
      ...engine.project.nodes[0],
      id: 'clock-reset',
      operation: 'scale',
      parents: [run.outputs[0].signalId],
      parameters: { value: 2 },
      createdAt: '1900-01-01',
    };
    const migrated = withWorkflowHistory({
      ...engine.project,
      nodes: [...engine.project.nodes, newNode],
    });
    assert.equal(migrated.workflowSteps!.at(-1)!.outputIds[0], newNode.id);
    assert.deepEqual(
      migrated.workflowSteps!.slice(0, -1),
      engine.project.workflowSteps,
    );
  } finally {
    engine.close();
  }
});

void test('5,000 deep operations stay two levels; large batches remain bounded and every member is findable', () => {
  const source = {
    id: 'source',
    name: 'Data',
    rows: 1,
    chunks: 1,
    bytes: 8,
    start: 0,
    end: 1,
    channels: ['raw'],
    synthetic: false,
    chunkRanges: [[0, 1] as [number, number]],
  };
  const raw: SignalNode = {
    id: 'raw',
    name: 'A',
    unit: 'V',
    sourceId: source.id,
    operation: 'raw',
    parents: [],
    parameters: {},
    channel: 0,
    color: '#fff',
    createdAt: '',
    version: 1,
  };
  const nodes = [raw];
  for (let i = 0; i < 5000; i++)
    nodes.push({
      ...raw,
      id: `derived-${i}`,
      operation: 'scale',
      parents: [nodes.at(-1)!.id],
      parameters: { value: 2 },
    });
  for (let i = 0; i < 1000; i++)
    nodes.push({
      ...raw,
      id: `batch-${i}`,
      name: `Window ${i}`,
      operation: 'crop',
      parents: ['raw'],
      parameters: { start: 0, end: 1 },
      batchId: 'batch',
    });
  const project: Project = withWorkflowHistory({
    sources: [source],
    nodes,
    segments: [],
  });
  const index = new WorkflowIndex(project),
    steps = project.workflowSteps!;
  assert.equal(steps.length, 5002);
  assert.equal(index.lineage(['derived-4999']).steps.length, 5001);
  const rows = workflowRows(steps, index, new Set());
  const referenceMatch = workflowRows(steps, index, new Set(), '#5002');
  assert.equal(referenceMatch.filter((row) => row.kind === 'step').length, 1);
  assert.equal(referenceMatch[0].step.sequence, 5001);
  assert.equal(rows.length, 10007); // 5,001 pairs + batch step + 3 outputs + more.
  const found = workflowRows(steps, index, new Set(), 'Window 999');
  assert.ok(found.some((row) => row.outputId === 'batch-999'));
  const reveal = workflowRows(steps, index, new Set(), '', 'batch-999');
  assert.ok(reveal.some((row) => row.outputId === 'batch-999'));
  assert.equal(
    reveal.filter((row) => row.step.outputIds.length === 1000).length,
    6,
  );
  assert.deepEqual(project.nodes, nodes);
});
