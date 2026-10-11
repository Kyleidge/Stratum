import { app } from 'electron';

/**
 * An automation window (`--automation`, the MCP developer harness's UI
 * sessions) quits when the process that started it is gone, so no hidden
 * window outlives its controller. That process passes its PID; polling it
 * works on every platform, unlike stdin, which a Windows GUI app lacks.
 */
export function watchAutomationParent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(timer);
      app.exit(0);
    }
  }, 2000);
  timer.unref?.();
}
