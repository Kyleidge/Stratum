/**
 * Native smoke check of the MCP server's UI sessions: launches the desktop
 * build through the server (hidden, offscreen window), imports a recording
 * through the real import dialog, runs an engine tool against the window,
 * uses the keyboard and captures screenshots. Run on the current
 * dist-desktop with `node tests/native-smokes.mjs mcp-ui` or directly with
 * `node tests/mcp-ui-smoke.mjs`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMcp } from './mcp-client.mjs';

const output = fileURLToPath(new URL('../outputs/', import.meta.url));
const started = Date.now();
const client = await startMcp();
const timer = setTimeout(() => {
  process.stderr.write('MCP UI smoke timed out.\n');
  process.exit(1);
}, 240_000);
/** Polls the UI workspace until `check` holds (imports finish after dialogs). */
async function status(check) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { value } = await client.call('stratum_status', { target: 'ui' });
    if (check(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
try {
  const launch = await client.call('ui_launch', { build: 'never' });
  assert.equal(launch.images.length, 1);
  const empty = await client.call('ui_snapshot');
  assert.match(empty.text, /button "Import recordings" \[e\d+\]/);

  await client.call('ui_upload', {
    target: 'role=button[name="Import recordings"]',
    paths: ['examples/eol-rig/SN-24001.csv'],
  });
  const dialog = await client.call('ui_snapshot', { target: 'role=dialog' });
  assert.match(dialog.text, /dialog "Import SN-24001\.csv"/);
  assert.match(
    dialog.text,
    /textbox "Name of Torque" \[e\d+\] \[value="Torque"\]/,
  );
  await client.call('ui_click', {
    target: 'role=button[name="Import 1 recording"]',
  });
  await client.call('ui_wait', { target: 'role=dialog', state: 'hidden' });
  const imported = await status((value) => value.recordings === 1);
  assert.equal(imported.recordings, 1);
  assert.equal(imported.undo, 'Import SN-24001.csv');

  // An engine tool through the window's own worker updates the screen.
  const example = await client.call('load_example', {
    example: 'motor-test',
    target: 'ui',
  });
  assert.equal(example.value.changed.length, 7);
  assert.equal((await status(() => true)).steps, 8);

  await client.call('ui_press', { keys: 'Control+k' });
  await client.call('ui_type', { text: 'torque' });
  const palette = await client.call('ui_snapshot', { target: 'role=dialog' });
  assert.match(palette.text, /option "[^"]*Torque/);
  await client.call('ui_press', { keys: 'Escape' });
  await client.call('ui_wait', { target: 'role=dialog', state: 'hidden' });

  await client.call('ui_press', { keys: 'Control+z' });
  assert.equal((await status((value) => value.steps === 1)).steps, 1);

  await client.call('ui_resize', { width: 800, height: 760 });
  const shot = await client.call('ui_screenshot');
  const png = Buffer.from(shot.images[0].data, 'base64');
  assert.equal(png.readUInt32BE(16), 800);
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}mcp-ui-smoke.png`, png);
  const errors = await client.call('ui_console', { errorsOnly: true });
  assert.equal(errors.text, 'No messages.');
  await client.call('ui_close');
  process.stdout.write(
    `MCP UI smoke passed: import dialog, UI-target engine tools, palette, Undo and resize in ${((Date.now() - started) / 1000).toFixed(1)} s.\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
}
