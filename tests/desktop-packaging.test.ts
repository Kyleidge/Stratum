import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageRoot } from '../desktop/notices.mjs';

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n',
  );

void test('every desktop build keeps the original Stratus profile and origin', () => {
  // Existing workspaces live in %APPDATA%\Stratus under the stratus://app
  // origin. Electron would otherwise derive the profile from the app name
  // (Stratum), so the installer, unpacked and development runs must all pin
  // it before the app is ready.
  const main = read('desktop/main.mjs');
  const pin = main.indexOf(
    "app.setPath('userData', resolve(app.getPath('appData'), 'Stratus'));",
  );
  assert.ok(pin > 0, 'main.mjs must pin userData to appData/Stratus');
  assert.ok(pin < main.indexOf('app\n    .whenReady()'));
  assert.match(main, /scheme: 'stratus',/);
  assert.match(main, /loadURL\(\s*`stratus:\/\/app\/index\.html/);
  // Uninstalling must never remove a workspace.
  assert.match(read('desktop/package.mjs'), /deleteAppDataOnUninstall: false/);
});

void test('licence notices attribute bundled modules to their packages', () => {
  assert.equal(packageRoot('/repo/lib/signal-engine.ts'), undefined);
  const react = packageRoot(
    fileURLToPath(new URL('../node_modules/react/index.js', import.meta.url)),
  );
  assert.ok(react?.replaceAll('\\', '/').endsWith('/node_modules/react'));
});
