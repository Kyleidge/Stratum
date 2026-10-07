// Native backup smoke (main side). The renderer (backup-ui-smoke.ts) saves,
// restores and auto-backs up through the bridge, then signals ready; this
// closes the window, which must write a close-time automatic backup before
// the app quits. Runs only with --backup-smoke and a temporary profile.
import { app } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { BACKUP_PATTERN } from './backup-files.mjs';

async function verify() {
  const folder = join(app.getPath('userData'), 'auto-backups');
  const names = await readdir(folder);
  assert.deepEqual(
    names.filter((name) => name.endsWith('.partial')),
    [],
    'A partial backup was left behind',
  );
  const backups = names.filter((name) => BACKUP_PATTERN.test(name)).sort();
  assert.equal(
    backups.length,
    2,
    `Expected two automatic backups: ${names.join(', ')}`,
  );
  const settings = JSON.parse(
    await readFile(
      join(app.getPath('userData'), 'desktop-settings.json'),
      'utf8',
    ),
  );
  assert.equal(
    settings.autoBackup.last.ok,
    true,
    settings.autoBackup.last.error,
  );
  assert.equal(settings.autoBackup.last.reason, 'close');
  assert.equal(settings.autoBackup.notice, undefined);
  for (const name of backups) {
    const lines = (await readFile(join(folder, name), 'utf8'))
      .trimEnd()
      .split('\n');
    const header = JSON.parse(lines[0]);
    assert.equal(header.format, 'stratus-workspace');
    assert.ok(header.project.sources.length >= 1);
    assert.equal(JSON.parse(lines.at(-1)).complete, true);
  }
  const saved = (await readdir(resolve('outputs'))).filter((name) =>
    /^Stratum-workspace-.*\.stratum$/.test(name),
  );
  assert.ok(saved.length, 'Missing the native workspace backup');
}

export function attachBackupSmoke(window) {
  let closing = false;
  window.webContents.on('console-message', ({ message }) => {
    if (message.startsWith('STRATUM_BACKUP_SMOKE_READY') && !closing) {
      closing = true;
      // An ordinary close: main must back up before the window goes.
      window.close();
    }
  });
  app.on('will-quit', (event) => {
    event.preventDefault();
    if (!closing) {
      process.stderr.write('The app quit before the backup smoke closed it.\n');
      app.exit(1);
      return;
    }
    verify()
      .then(() => {
        process.stdout.write(
          'STRATUM_SMOKE_OK: Native save, restore, invalid restore, automatic and close-time backups passed.\n',
        );
        app.exit(0);
      })
      .catch((error) => {
        process.stderr.write(`Backup smoke failed: ${error.message}\n`);
        app.exit(1);
      });
  });
}
