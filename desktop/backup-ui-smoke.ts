/**
 * Native backup smoke (renderer side): saves a backup and restores it through
 * the desktop bridge, rejects an invalid backup, turns on automatic backups
 * and writes one, then asks the main process to close the window so the
 * close-time automatic backup runs. `backup-smoke.mjs` verifies the files.
 */
import { desktopBridge } from '../lib/desktop-bridge';

export async function backupUiSmoke() {
  const delay = (ms = 30) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function until<T>(
    read: () => T | undefined | null | false,
    label: string,
    timeout = 20000,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = read();
      if (result) return result;
      await delay();
    }
    throw new Error(
      `Timed out: ${label}. ${document.querySelector('[role="alert"]')?.textContent ?? ''} Screen: ${document.body.innerText.slice(0, 800)}`,
    );
  }
  const button = (text: string, root: Document | HTMLElement = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) =>
        (item.textContent?.trim() === text ||
          item.getAttribute('aria-label') === text) &&
        !item.disabled &&
        !item.closest('[data-closed]'),
    );
  async function click(text: string, root: Document | HTMLElement = document) {
    (await until(() => button(text, root), `button ${text}`)).click();
    await delay();
  }
  const workspace = () =>
    until(
      () => document.querySelector<HTMLElement>('[role="dialog"]'),
      'Workspace dialog',
    );
  const confirmation = () =>
    until(
      () => document.querySelector<HTMLElement>('[role="alertdialog"]'),
      'restore confirmation',
    );
  const closeWorkspace = async () => {
    document
      .querySelector<HTMLButtonElement>(
        '[role="dialog"] [data-slot="dialog-close"]',
      )
      ?.click();
    await until(() => !document.querySelector('[role="dialog"]'), 'close');
  };
  try {
    const bridge = desktopBridge();
    if (!bridge) throw new Error('The desktop bridge is missing.');
    if ('require' in window || 'process' in window)
      throw new Error('The renderer must not have Node access.');
    await click('Workspace');
    await click('Open the example recording', await workspace());
    await until(
      () => !document.querySelector('[role="dialog"]'),
      'example opens',
      60000,
    );

    // Save a backup through the native dialog and restore it.
    await click('Workspace');
    let dialog = await workspace();
    await click('Save workspace backup…', dialog);
    await until(
      () => dialog.querySelector('output')?.textContent?.includes('saved to'),
      'native backup saved',
      60000,
    );
    await click('Restore workspace backup…', dialog);
    let confirm = await confirmation();
    if (!/Stratum-workspace-.*\.stratum/.test(confirm.textContent ?? ''))
      throw new Error('The restore did not name the saved backup.');
    await click('Restore and replace', confirm);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'restore finishes',
      60000,
    );
    if (
      !document
        .querySelector('button[aria-label="Undo last change"]:not(:disabled)')
        ?.getAttribute('title')
        ?.includes('Restore workspace backup')
    )
      throw new Error('The restore must remain undoable.');

    // A corrupt file chosen in the native dialog leaves the workspace as is.
    const invalid = await bridge.saveFile({
      kind: 'workspace',
      defaultName: 'invalid.stratum',
    });
    if (!invalid) throw new Error('Could not create the invalid backup.');
    await bridge.write(
      invalid.handle,
      new TextEncoder().encode('{"format":"stratus-workspace","version":1}\n'),
    );
    await bridge.finish(invalid.handle);
    await click('Workspace');
    dialog = await workspace();
    await click('Restore workspace backup…', dialog);
    confirm = await confirmation();
    await click('Restore and replace', confirm);
    await until(
      () => confirm.querySelector('[role="alert"]')?.textContent,
      'invalid backup error',
    );
    await click('Keep current workspace', confirm);
    await until(
      () => !document.querySelector('[role="alertdialog"]'),
      'keep workspace',
    );

    // Automatic backups: choose the folder and write one now.
    await click('Choose a backup folder…', dialog);
    await click('Back up now', dialog);
    await until(
      () =>
        dialog
          .querySelector('.workflow-storage-last')
          ?.textContent?.match(/Stratum-backup-[\d_-]+\.stratum/),
      'automatic backup written',
      60000,
    );
    await closeWorkspace();
    // A change after that backup makes the close-time backup necessary.
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Undo"]:not(:disabled)',
          ),
        'Undo',
      )
    ).click();
    await until(
      () => document.querySelector('button[aria-label^="Redo"]:not(:disabled)'),
      'undo restore',
      60000,
    );
    await delay(300);
    console.info('STRATUM_BACKUP_SMOKE_READY');
  } catch (error) {
    console.error(
      `STRATUM_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
