import { app } from 'electron';
import { createInterface } from 'node:readline';

/**
 * The control channel of an automation window (`--automation`, used by the
 * MCP server's UI sessions): JSON lines on stdin, replies on stdout marked
 * with `STRATUM_AUTOMATION `. Hidden windows draw only when captured, so
 * screenshots go through `capturePage` as the native smoke tests do; resizes
 * change the real window, so layouts match a user's. The app quits when its
 * controller goes away (stdin closes), so no hidden window outlives it.
 */
export function attachAutomation(window) {
  // Narrow layouts (History and Details drawers) must stay reachable.
  window.setMinimumSize(320, 240);
  const lines = createInterface({ input: process.stdin });
  lines.on('close', () => app.exit(0));
  lines.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (body) =>
      process.stdout.write(
        `STRATUM_AUTOMATION ${JSON.stringify({ id: request.id, ...body })}\n`,
      );
    try {
      if (window.isDestroyed()) throw new Error('The window is closed.');
      if (request.command === 'capture') {
        const rect = request.rect
          ? {
              x: Math.round(request.rect.x),
              y: Math.round(request.rect.y),
              width: Math.max(1, Math.round(request.rect.width)),
              height: Math.max(1, Math.round(request.rect.height)),
            }
          : undefined;
        const image = await window.webContents.capturePage(rect, {
          stayHidden: true,
        });
        reply({ png: image.toPNG().toString('base64') });
      } else if (request.command === 'resize') {
        window.setContentSize(
          Math.round(request.width),
          Math.round(request.height),
        );
        const [width, height] = window.getContentSize();
        reply({ width, height });
      } else reply({ error: `Unknown command: ${request.command}` });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
