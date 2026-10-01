import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { SignalGraph } from '../lib/signal-graph';
import { WorkflowIndex } from '../lib/workflow-history';
import {
  reportAssets,
  reportSource,
  reportTargetAssets,
  resolveReportAssets,
} from '../lib/report-data';
import { createBlock } from '../lib/report-mockup';
import type { EngineRequest, EngineResponse } from '../lib/signal-types';
import type { PlotSheet } from '../lib/plot-scratchpad';

async function fixture(t: TestContext) {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  t.after(() => engine.close());
  const a = await engine.importCsv(
    new File(
      [
        't,x [V],y [A],missing [V]\n10,1.23456789012345,2,\n11,2,4,\n12,,6,\n13,4,8,\n14,5,10,',
      ],
      'Logger A.csv',
    ),
  );
  const b = await engine.importCsv(
    new File(
      ['t,z [V]\n100,10\n101,20\n102,30\n103,40\n104,50'],
      'Logger B.csv',
    ),
  );
  await engine.initializeWorkflow();
  const requests: EngineRequest[] = [];
  const request = async (message: EngineRequest): Promise<EngineResponse> => {
    requests.push(message);
    assert.equal(message.type, 'view');
    if (message.type !== 'view') throw new Error('Unexpected request.');
    assert.equal(message.inspection, undefined);
    return {
      type: 'plots',
      requestId: requests.length,
      plots: await Promise.all(message.ids.map((id) => engine.plot(id))),
    };
  };
  return { engine, a, b, request, requests };
}

const noPlot = async () => {
  throw new Error('Unexpected saved plot capture.');
};

void test('report signal snapshots retain evaluated axes, renamed labels and explicit missing-data gaps', async (t) => {
  const { engine, a, request, requests } = await fixture(t);
  const derived = await engine.derive(a.channels[0], 'time-shift', 7.5);
  const project = {
    ...engine.project,
    labels: { [derived.id]: 'Measured voltage' },
  };
  const catalog = reportAssets(project, []);
  assert.equal(
    catalog.find((asset) => asset.id === `signal:${derived.id}`)?.name,
    'Measured voltage',
  );
  const [block] = await resolveReportAssets(
    project,
    [],
    [`signal:${derived.id}`],
    request,
    noPlot,
  );
  const evaluated = await engine.plot(derived.id);
  assert.equal(block.text, 'Measured voltage');
  assert.deepEqual(block.signalPlot?.range, [17.5, 21.5]);
  assert.deepEqual(
    block.signalPlot?.points,
    evaluated.points.map(([time, value]) => [
      time,
      Number.isFinite(value) ? value : null,
    ]),
  );
  assert.ok(
    block.signalPlot?.points.some(
      (point) => point[0] === 19.5 && point[1] === null,
    ),
  );
  assert.match(block.signalPlot!.timeLabel, /shifted/);
  assert.deepEqual(block.source?.sourceNames, ['Logger A.csv']);
  assert.deepEqual(block.source?.outputIds, [derived.id]);
  assert.equal(block.signalPlot?.unit, 'V');
  assert.deepEqual(requests, [{ type: 'view', ids: [derived.id] }]);
  const originalFirstPoint = [...block.signalPlot!.points[0]];
  evaluated.points[0][1] = 900;
  project.labels[derived.id] = 'Changed later';
  assert.deepEqual(block.signalPlot!.points[0], originalFirstPoint);
  assert.equal(block.text, 'Measured voltage');
});

void test('workspace outputs capture all original recordings and the actual shared time reference', async (t) => {
  const { engine, a, b, request } = await fixture(t);
  const aligned = await engine.applyTimeOperation({
    kind: 'align',
    reference: {
      id: 'report-comparison',
      name: 'Ignition event',
      kind: 'relative',
    },
    target: 0,
    groups: [a.channels[0], b.channels[0]].map((id) => ({
      inputIds: [id],
      anchor: { kind: 'start' },
    })),
  });
  const [combined] = await engine.applyTimeOperation({
    kind: 'combine',
    inputIds: [aligned[0].id, aligned[1].id],
    operator: 'sum',
  });
  const derived = await engine.derive(combined.id, 'scale', 2);
  assert.equal(derived.sourceId, '');
  const [block] = await resolveReportAssets(
    engine.project,
    [],
    [`signal:${derived.id}`],
    request,
    noPlot,
  );
  assert.deepEqual(block.source?.sourceNames, ['Logger A.csv', 'Logger B.csv']);
  assert.deepEqual(block.source?.timeReferences, ['Ignition event (relative)']);
  assert.deepEqual(block.signalPlot?.range, [0, 4]);
  assert.equal(block.signalPlot?.points[0][0], 0);
  assert.equal(
    block.signalPlot?.timeLabel,
    'Ignition event (relative) · time (s)',
  );
  const [value] = await engine.calculateValues([derived.id], 'maximum');
  const valueSource = reportSource(
    engine.project,
    [value.id],
    'values',
    'Peak',
  );
  assert.deepEqual(valueSource.sourceNames, block.source?.sourceNames);
  assert.deepEqual(valueSource.timeReferences, block.source?.timeReferences);
  assert.equal(
    new SignalGraph(engine.project).timeReferences.get(derived.id)?.id,
    'report-comparison',
  );
});

void test('values preserve exact stored results, individual membership and deduplicated explicit batches', async (t) => {
  const { engine, a, request, requests } = await fixture(t);
  const values = await engine.calculateValues(a.channels, 'minimum');
  const step = engine.project.workflowSteps!.find((candidate) =>
    candidate.outputIds.includes(values[0].id),
  )!;
  const assets = reportAssets(engine.project, []);
  assert.deepEqual(
    assets.find((asset) => asset.id === `values:${step.id}`)?.outputIds,
    values.map((value) => value.id),
  );
  const [individual] = await resolveReportAssets(
    engine.project,
    [],
    [`value:${values[0].id}`],
    request,
    noPlot,
  );
  assert.equal(individual.tableData.length, 2);
  assert.equal(individual.tableData[1][1], String(values[0].value));
  assert.equal(individual.tableData[1][1], '1.23456789012345');
  assert.deepEqual(individual.source?.outputIds, [values[0].id]);
  const [batch] = await resolveReportAssets(
    engine.project,
    [],
    [`value:${values[0].id}`, `values:${step.id}`, `value:${values[0].id}`],
    request,
    noPlot,
  );
  assert.equal(batch.tableData.length, values.length + 1);
  assert.deepEqual(
    batch.source?.outputIds,
    values.map((value) => value.id),
  );
  assert.equal(batch.tableData.at(-1)?.[1], 'Unavailable');
  assert.equal(requests.length, 0);
  values[0].value = 777;
  assert.equal(batch.tableData[1][1], '1.23456789012345');
});

void test('large explicit value batches split into bounded tables without losing rows', async (t) => {
  const { engine, request } = await fixture(t);
  const columns = Array.from({ length: 35 }, (_, index) => `channel${index}`);
  const source = await engine.importCsv(
    new File(
      [
        `t,${columns.join(',')}\n0,${columns.map((_, index) => index).join(',')}\n1,${columns.map((_, index) => index + 1).join(',')}`,
      ],
      'Many channels.csv',
    ),
  );
  const values = await engine.calculateValues(source.channels, 'maximum');
  const step = engine.project.workflowSteps!.find((candidate) =>
    candidate.outputIds.includes(values[0].id),
  )!;
  const index = new WorkflowIndex(engine.project);
  const selection = reportTargetAssets(index, { kind: 'step', id: step.id });
  assert.deepEqual(selection, [`values:${step.id}`]);
  const blocks = await resolveReportAssets(
    engine.project,
    [],
    selection,
    request,
    noPlot,
  );
  assert.equal(blocks.length, 4);
  assert.ok(blocks.every((block) => block.tableData.length <= 12));
  assert.deepEqual(
    blocks.flatMap((block) => block.source!.outputIds),
    values.map((value) => value.id),
  );
  assert.deepEqual(
    blocks.flatMap((block) => block.tableData.slice(1).map((row) => row[1])),
    values.map((value) => String(value.value)),
  );
  const memberSelection = reportTargetAssets(index, {
    kind: 'output',
    id: values[3].id,
  });
  assert.deepEqual(memberSelection, [`value:${values[3].id}`]);
  const [member] = await resolveReportAssets(
    engine.project,
    [],
    memberSelection,
    request,
    noPlot,
  );
  assert.deepEqual(member.source?.outputIds, [values[3].id]);
  assert.equal(member.tableData.length, 2);
  const importStep = index.owner.get(source.channels[0])!;
  assert.deepEqual(
    reportTargetAssets(index, { kind: 'step', id: importStep.id }),
    source.channels.map((id) => `signal:${id}`),
  );
});

void test('stale assets fail before any reads, and cancelling a queued report capture never cancels the engine', async (t) => {
  const { engine, a, request, requests } = await fixture(t);
  await assert.rejects(
    resolveReportAssets(
      engine.project,
      [],
      [`signal:${a.channels[0]}`, 'signal:missing'],
      request,
      noPlot,
    ),
    /no longer available/,
  );
  assert.equal(requests.length, 0);
  await assert.rejects(
    resolveReportAssets(
      engine.project,
      [],
      Array.from({ length: 31 }, (_, i) => `signal:${i}`),
      request,
      noPlot,
    ),
    /at most 30/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    resolveReportAssets(
      engine.project,
      [],
      [`signal:${a.channels[0]}`],
      request,
      noPlot,
      abort.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(requests.length, 0);
  const queued = new AbortController();
  let complete: (() => void) | undefined;
  const pending = resolveReportAssets(
    engine.project,
    [],
    a.channels.slice(0, 2).map((id) => `signal:${id}`),
    async (message) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return request(message);
    },
    noPlot,
    queued.signal,
  );
  queued.abort();
  complete!();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'view');
  assert.ok((await engine.plot(a.channels[0])).points.length > 0);
});

void test('saved plot capture receives independent layout data and returns independent content', async (t) => {
  const { engine, a, request } = await fixture(t);
  const [value] = await engine.calculateValues([a.channels[0]], 'maximum');
  const sheet: PlotSheet = {
    id: 'plot:test',
    name: 'Run overlay',
    layout: 'overlay',
    grid: true,
    traces: [
      { id: a.channels[0], visible: true, color: '#123456' },
      { id: a.channels[1], visible: false, color: '#654321' },
      { id: value.id, visible: true, color: '#112233' },
    ],
  };
  const asset = reportAssets(engine.project, [sheet]).find(
    (item) => item.kind === 'plot',
  )!;
  assert.deepEqual(asset.outputIds, [a.channels[0], value.id]);
  assert.match(asset.detail, /2 visible traces/);
  const captured = createBlock('plot', {
    plotSnapshot: {
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width: 600,
      height: 300,
    },
    source: reportSource(engine.project, asset.outputIds, 'plot', sheet.name),
  });
  const [block] = await resolveReportAssets(
    engine.project,
    [sheet],
    [asset.id],
    request,
    async (snapshot) => {
      snapshot.traces[0].color = '#ffffff';
      return [captured];
    },
  );
  assert.equal(sheet.traces[0].color, '#123456');
  captured.source!.outputIds.push('later');
  captured.plotSnapshot!.svg = 'changed';
  assert.deepEqual(block.source?.outputIds, [a.channels[0], value.id]);
  assert.match(block.plotSnapshot!.svg, /^<svg/);
  const stale = { ...sheet, traces: [{ ...sheet.traces[0], id: 'missing' }] };
  await assert.rejects(
    resolveReportAssets(engine.project, [stale], [asset.id], request, noPlot),
    /no longer available/,
  );
});
