import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import 'fake-indexeddb/auto';
import { createAppServer } from '../mcp/app-server';
import type { ToolResult } from '../mcp/protocol';
import { handleAssistantCall, type AssistantHost } from '../lib/assistant-host';
import {
  ASSISTANT_ENDPOINT_FILE,
  ASSISTANT_SETTINGS_FILE,
} from '../lib/assistant-protocol';
import { handleEngineRequest } from '../lib/engine-requests';
import { SignalEngine } from '../lib/signal-engine';
import type { EngineResponse } from '../lib/signal-types';
import {
  ASSISTANT_ENDPOINT_FILE as PIPE_ENDPOINT_FILE,
  startAssistantPipe,
} from '../desktop/assistant-pipe.mjs';

/**
 * The workbench's side without a window: the assistant host over a real
 * engine, as `components/desktop-assistant.tsx` builds it over the worker.
 */
async function workbench() {
  const engine = new SignalEngine(undefined, `assistant-${Math.random()}`);
  await handleEngineRequest(engine, { type: 'init-workflow' }, 0, () => {});
  const changes: string[] = [];
  let serial = 0;
  const host: AssistantHost = {
    state: () => ({
      project: engine.project,
      revision: engine.savedRevision,
      canUndo: engine.canUndo,
      canRedo: engine.canRedo,
      undoLabel: engine.undoLabel,
      redoLabel: engine.redoLabel,
    }),
    request: async (message) => {
      let reply: EngineResponse | undefined;
      await handleEngineRequest(engine, message as never, ++serial, (sent) => {
        if (sent.type !== 'progress') reply = sent;
      });
      if (reply?.type === 'error') throw new Error(reply.message);
      return reply!;
    },
    cancel: () => (engine.cancelled = true),
    show: (id) => `Showing ${id}.`,
    changed: (label) => changes.push(label),
  };
  return { engine, host, changes };
}

function profile(enabled?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-assistant-'));
  if (enabled !== undefined)
    writeFileSync(
      join(dir, ASSISTANT_SETTINGS_FILE),
      JSON.stringify({ enabled }),
    );
  return dir;
}

function client(userData: string, launch: () => void = () => {}) {
  const { server, backend } = createAppServer({
    userData,
    version: 'test',
    launch,
    startTimeout: 5000,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await server.handle('tools/call', {
      name,
      arguments: args,
    })) as ToolResult;
    const text = result.content.find((item) => item.type === 'text');
    const body = text?.type === 'text' ? text.text : '';
    if (result.isError) throw new Error(body);
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return body as never;
    }
  };
  return { server, backend, call };
}

void test('the app tools are the stable public interface', async () => {
  const { server } = client(profile());
  const { tools } = (await server.handle('tools/list')) as {
    tools: {
      name: string;
      inputSchema: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }[];
  };
  const shape = tools.map((tool) => ({
    name: tool.name,
    arguments: Object.keys(tool.inputSchema.properties ?? {}).sort(),
    required: [...(tool.inputSchema.required ?? [])].sort(),
  }));
  // Renaming or removing a tool or argument breaks users' assistants: add
  // instead, and update this file deliberately (docs/mcp-server.md).
  const fixture = new URL('./fixtures/mcp-app-tools.json', import.meta.url);
  if (process.env.UPDATE_MCP_TOOLS)
    writeFileSync(fixture, `${JSON.stringify(shape, null, 2)}\n`);
  const expected = JSON.parse(readFileSync(fixture, 'utf8')) as typeof shape;
  for (const old of expected) {
    const now = shape.find((tool) => tool.name === old.name);
    assert.ok(now, `Tool ${old.name} was removed or renamed.`);
    for (const name of old.arguments)
      assert.ok(
        now.arguments.includes(name),
        `${old.name} lost its "${name}" argument.`,
      );
    for (const name of now.required)
      assert.ok(
        old.required.includes(name),
        `${old.name} now requires "${name}".`,
      );
  }
  assert.deepEqual(shape, expected, 'Update tests/fixtures/mcp-app-tools.json');
  assert.ok(
    shape.every((tool) => !tool.arguments.includes('target')),
    'App tools take no developer target.',
  );
  for (const name of ['engine_request', 'get_project', 'workspace_reset'])
    assert.ok(!shape.some((tool) => tool.name === name), name);
  assert.ok(!shape.some((tool) => tool.name.startsWith('ui_')));
});

void test('assistants are refused until the user allows them', async () => {
  let launched = 0;
  for (const userData of [profile(), profile(false)]) {
    const { call } = client(userData, () => launched++);
    await assert.rejects(
      call('stratum_status'),
      /does not allow AI assistants/,
    );
    rmSync(userData, { recursive: true, force: true });
  }
  assert.equal(launched, 0, 'Stratum is not started while access is off.');
});

void test('the channel refuses a wrong token and unlisted requests', async () => {
  const userData = profile(true);
  const { host } = await workbench();
  const pipe = await startAssistantPipe({
    userData,
    forward: (call: never) => handleAssistantCall(call, host),
  });
  try {
    const endpoint = JSON.parse(
      readFileSync(join(userData, ASSISTANT_ENDPOINT_FILE), 'utf8'),
    ) as { path: string };
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(endpoint.path, () =>
        socket.write(`${JSON.stringify({ token: 'wrong' })}\n`),
      );
      socket.on('data', () => resolve(false));
      socket.on('close', () => resolve(true));
    });
    assert.equal(closed, true);
    const { backend } = client(userData);
    await assert.rejects(
      backend.call('request', { message: { type: 'init-regions' } }),
      /cannot send "init-regions"/,
    );
    await assert.rejects(
      backend.call('nonsense' as never),
      /Unknown assistant call/,
    );
    backend.close();
  } finally {
    await pipe.stop();
    rmSync(userData, { recursive: true, force: true });
  }
});

void test('an assistant works in the workspace through the channel', async () => {
  assert.equal(PIPE_ENDPOINT_FILE, ASSISTANT_ENDPOINT_FILE);
  const userData = profile(true);
  const { host, changes } = await workbench();
  let pipe: Awaited<ReturnType<typeof startAssistantPipe>> | undefined;
  // Stratum is "closed" until the server starts it; it then opens the pipe.
  const { call, backend } = client(userData, () => {
    void startAssistantPipe({
      userData,
      forward: (request: never) => handleAssistantCall(request, host),
    }).then((opened) => (pipe = opened));
  });
  try {
    assert.equal((await call('stratum_status')).steps, 0);
    assert.ok(pipe, 'The server started Stratum.');
    const example = await call('load_example', { example: 'motor-test' });
    assert.equal((example.changed as unknown[]).length, 7);
    assert.deepEqual(changes, ['Open example recording']);

    const recordings = (await call('list_recordings')) as unknown as {
      signals: { id: string; name: string }[];
    }[];
    const torque = recordings[0].signals.find(
      (signal) => signal.name === 'Torque',
    )!;
    const derived = await call('derive', {
      inputIds: [torque.id],
      operation: 'smooth',
      parameter: 5,
    });
    const output = (derived.changed as { outputs: { id: string }[] }[])[0]
      .outputs[0].id;
    const samples = await call('read_samples', { id: output, count: 2 });
    assert.equal((samples.rows as unknown[]).length, 2);
    assert.equal(
      await call('show_in_app', { id: output }),
      `Showing ${output}.`,
    );

    // Files: full paths only, never overwritten unasked.
    const backup = join(userData, 'backup.stratum');
    await call('workspace_save', { path: backup });
    await assert.rejects(
      call('workspace_save', { path: backup }),
      /already exists/,
    );
    await call('workspace_save', { path: backup, overwrite: true });
    await assert.rejects(
      call('workspace_save', { path: 'backup.stratum' }),
      /Give a full path/,
    );
    await assert.rejects(
      call('export_data', { ids: [output], kind: 'samples' }),
    );
    const csv = join(userData, 'samples.csv');
    await call('export_data', { ids: [output], kind: 'samples', path: csv });
    assert.match(readFileSync(csv, 'utf8'), /^Signal,/);

    const undone = await call('undo');
    assert.equal((undone.removed as unknown[]).length, 1);
    assert.match(changes.at(-1)!, /^Undo /);
    backend.close();
  } finally {
    await pipe?.stop();
    rmSync(userData, { recursive: true, force: true });
  }
});
