import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { createServer } from '../mcp/server';
import {
  formatJson,
  PROTOCOL_VERSIONS,
  type ToolResult,
} from '../mcp/protocol';
import { EOL_COMPONENTS } from '../lib/eol-example';
import { startMcp } from './mcp-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** A server in this process; `call` returns a tool's parsed JSON. */
function server() {
  const { server, context } = createServer(root);
  const raw = async (name: string, args: Record<string, unknown> = {}) =>
    (await server.handle('tools/call', {
      name,
      arguments: args,
    })) as ToolResult;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    const text = result.content.find((item) => item.type === 'text');
    const body = text?.type === 'text' ? text.text : '';
    if (result.isError) throw new Error(body);
    try {
      return JSON.parse(body) as Record<string, unknown> & unknown[];
    } catch {
      return body as never;
    }
  };
  return { server, context, raw, call };
}

type Output = { id: string; name: string; kind: string; value?: number };
type Step = { id: string; ref: string; name: string; outputs: Output[] };

void test('MCP initialisation, tool listing and argument checks', async () => {
  const { server: mcp, raw } = server();
  const init = (await mcp.handle('initialize', {
    protocolVersion: '2025-03-26',
  })) as { protocolVersion: string; capabilities: { tools: object } };
  assert.equal(init.protocolVersion, '2025-03-26');
  assert.ok(init.capabilities.tools);
  const newer = (await mcp.handle('initialize', {
    protocolVersion: '2099-01-01',
  })) as { protocolVersion: string };
  assert.equal(newer.protocolVersion, PROTOCOL_VERSIONS[0]);

  const { tools } = (await mcp.handle('tools/list')) as {
    tools: { name: string; description: string; inputSchema: object }[];
  };
  assert.ok(tools.length >= 50);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z_]*$/);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(
      (tool.inputSchema as { type: string }).type,
      'object',
      tool.name,
    );
  }
  await assert.rejects(mcp.handle('tools/call', { name: 'no_such_tool' }));
  await assert.rejects(mcp.handle('no/such/method'));

  const missing = await raw('describe', {});
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.content), /"id\\" is required/);
  const wrongType = await raw('read_samples', { id: 'x', count: 'many' });
  assert.match(JSON.stringify(wrongType.content), /must be integer/);
  const unknown = await raw('undo', { colour: 'red' });
  assert.match(JSON.stringify(unknown.content), /unknown argument \\"colour/);
  const target = await raw('stratum_status', { target: 'ui' });
  assert.match(JSON.stringify(target.content), /ui_launch first/);

  assert.equal(
    formatJson({ rows: [[0, 1.5]], names: ['a', 'b'] }),
    '{\n "rows": [\n  [0, 1.5]\n ],\n "names": ["a", "b"]\n}',
  );
});

void test('MCP engine tools create, inspect, edit and undo steps', async () => {
  const { call, raw, context } = server();
  const example = await call('load_example', { example: 'motor-test' });
  assert.equal((example.changed as Step[]).length, 7);
  const history = await call('list_history', {});
  assert.equal(history.totalSteps, 7);

  const recording = (await call('list_recordings'))[0] as {
    id: string;
    signals: { id: string; name: string }[];
  };
  const torque = recording.signals.find((item) => item.name === 'Torque')!;
  const preview = await call('derive', {
    inputIds: [torque.id],
    operation: 'smooth',
    parameter: 5,
    preview: true,
  });
  assert.ok((preview.preview as { summary: { count: number } }).summary.count);

  const created = await call('derive', {
    inputIds: [torque.id],
    operation: 'smooth',
    parameter: 5,
    name: 'Quick smooth',
  });
  const step = (created.changed as Step[])[0];
  assert.equal(step.outputs[0].name, 'Quick smooth');
  assert.equal(created.undo, `Add ${step.ref} Moving average`);

  const samples = await call('read_samples', {
    id: step.outputs[0].id,
    count: 150,
  });
  assert.equal((samples.rows as number[][]).length, 150);
  assert.equal(samples.next, 150);
  const [statistics] = (await call('signal_statistics', {
    ids: [step.outputs[0].id],
  })) as { sampleCount: number; name: string }[];
  assert.equal(statistics.sampleCount, samples.totalSamples);
  assert.equal(statistics.name, 'Quick smooth');

  const values = await call('calculate_values', {
    inputIds: [step.outputs[0].id],
    operation: 'maximum',
  });
  const value = (values.changed as Step[])[0].outputs[0];
  assert.equal(value.kind, 'Value');
  assert.equal(
    value.value,
    Number(
      (
        (await call('signal_statistics', { ids: [step.outputs[0].id] })) as {
          maximum: number;
        }[]
      )[0].maximum.toPrecision(12),
    ),
  );

  const details = await call('describe', { id: step.id });
  assert.deepEqual(details.deleteImpact, [
    `${(values.changed as Step[])[0].ref} Maximum`,
  ]);
  const command = details.savedCommand as { parameter: number };
  command.parameter = 9;
  const edited = await call('edit_step', { stepId: step.id, command });
  assert.equal((edited.changed as { revision: number }[])[0].revision, 2);

  const deleted = await call('delete_step', { stepId: step.id });
  assert.equal((deleted.removed as Step[]).length, 2);
  const restored = await call('undo');
  assert.equal((restored.changed as Step[]).length, 2);
  assert.equal(
    ((await call('search', { text: 'quick smooth' })).outputs as Output[])[0]
      .id,
    step.outputs[0].id,
  );

  const plot = await raw('plot', { ids: [torque.id, step.outputs[0].id] });
  const image = plot.content.find((item) => item.type === 'image');
  assert.equal(image?.type === 'image' && image.mimeType, 'image/png');

  // A backup round trip through files, then the raw protocol.
  const saved = await call('workspace_save', {
    path: `outputs/mcp/test-${process.pid}.stratum`,
  });
  await call('workspace_reset');
  assert.equal((await call('stratum_status')).steps, 0);
  const opened = await call('workspace_open', { path: saved.path });
  assert.equal((opened.restored as { steps: number }).steps, 9);
  const count = await call('engine_request', {
    request: { type: 'sample-count', id: torque.id },
  });
  assert.equal(count.count, samples.totalSamples);
  await assert.rejects(
    call('engine_request', { request: { type: 'no-such-request' } }),
    /Unknown engine request/,
  );
  const requests = await call('catalog', { section: 'requests' });
  assert.match(String(requests.EngineRequest), /'derive-many'/);
  context.engine.close();
});

void test('MCP batch runs report the expected item statuses', async () => {
  const { call } = server();
  const result = await call('load_example', { example: 'eol-rig' });
  const runs = (result.batch as { runs: { itemId: string; status: string }[] })
    .runs;
  assert.deepEqual(
    Object.fromEntries(runs.map((run) => [run.itemId, run.status])),
    Object.fromEntries(
      EOL_COMPONENTS.map((item) => [item.serial, item.expected]),
    ),
  );
  const extracted = await call('workflow_extract', {
    recording: 'SN-24001',
    name: 'Extracted',
  });
  assert.deepEqual(extracted.skipped, []);
  const valid = await call('workflow_validate', {
    recipe: 'examples/eol-rig/Motor EOL test.stratum.yaml',
  });
  assert.equal(valid.valid, true);
  await assert.rejects(
    call('workflow_validate', { recipe: 'format: nope\nsteps: []\n' }),
  );
});

void test('MCP server answers over stdio', async () => {
  const client = await startMcp();
  try {
    assert.equal(client.initialized.serverInfo.name, 'stratum');
    const { result } = (await client.rpc('tools/list')) as {
      result: { tools: { name: string }[] };
    };
    assert.equal(
      result.tools.length,
      ((await server().server.handle('tools/list')) as { tools: [] }).tools
        .length,
    );
    const status = await client.call('stratum_status');
    assert.equal(status.value.steps, 0);
    const resources = (await client.rpc('resources/list')) as {
      result: { resources: { uri: string }[] };
    };
    assert.ok(
      resources.result.resources.some(
        (item) => item.uri === 'stratum://docs/mcp-server.md',
      ),
    );
  } finally {
    await client.close();
  }
});
