/**
 * Native smoke check of AI assistant access: a Stratum window that allows
 * assistants (temporary profile, through the MCP harness's UI session), and
 * the bundled assistant server (dist-desktop/assistant-server.mjs) run by
 * Electron as Node, as an MCP client such as Claude Desktop runs it. Run on
 * the current dist-desktop with `node tests/native-smokes.mjs mcp-app`.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcp } from './mcp-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'outputs');
const electron = createRequire(import.meta.url)('electron');
const started = Date.now();
const timer = setTimeout(() => {
  process.stderr.write('MCP app smoke timed out.\n');
  process.exit(1);
}, 240_000);
const harness = await startMcp();
let assistant;
try {
  // A window with assistant access allowed in its temporary profile.
  await harness.call('ui_launch', { build: 'never', assistant: true });
  const { value: status } = await harness.call('stratum_status', {
    target: 'ui',
  });
  const userData = join(status.ui.filesDir, '..', 'profile');
  assert.ok(existsSync(join(userData, 'assistant-endpoint.json')));

  assistant = await startMcp({
    command: electron,
    args: [
      join(root, 'dist-desktop', 'assistant-server.mjs'),
      '--user-data',
      userData,
      '--version',
      'smoke',
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(assistant.initialized.serverInfo.version, 'smoke');
  const { result } = await assistant.rpc('tools/list');
  assert.ok(!result.tools.some((tool) => tool.name.startsWith('ui_')));

  const example = await assistant.call('load_example', {
    example: 'motor-test',
  });
  assert.equal(example.value.changed.length, 7);
  const toast = await harness.call('ui_text', {
    target: '.workflow-assistant-toast',
  });
  assert.match(toast.text, /AI assistant: /);
  const window = await harness.call('stratum_status', { target: 'ui' });
  assert.equal(window.value.steps, 7);

  const history = await assistant.call('list_history', { outputLimit: 1 });
  const speed = history.value.steps[0].outputs[0].id;
  const plot = await assistant.call('plot', { ids: [speed] });
  const png = Buffer.from(plot.images[0].data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const shown = await assistant.call('show_in_app', {
    id: history.value.steps[2].id,
  });
  assert.match(shown.text, /^Showing #003 /);
  const backup = join(status.ui.filesDir, 'assistant.stratum');
  await assistant.call('workspace_save', { path: backup });
  await assert.rejects(
    assistant.call('workspace_save', { path: backup }),
    /already exists/,
  );
  await assistant.call('undo');
  assert.equal(
    (await harness.call('stratum_status', { target: 'ui' })).value.steps,
    0,
  );
  const shot = await harness.call('ui_screenshot');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'mcp-app-smoke.png'),
    Buffer.from(shot.images[0].data, 'base64'),
  );
  await harness.call('ui_close');
  process.stdout.write(
    `MCP app smoke passed: the bundled assistant server as Node, the private channel, changes in the window with a notice, plots drawn by the app, show, safe saves and Undo in ${((Date.now() - started) / 1000).toFixed(1)} s.\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await assistant?.close();
  await harness.close();
}
