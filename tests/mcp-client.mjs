/**
 * A minimal MCP client over stdio for tests: starts `node mcp/start.mjs`,
 * initialises and calls tools. `call` returns the parsed JSON of a tool's
 * first text block (or the text), with `images` alongside.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function startMcp() {
  const child = spawn(process.execPath, ['mcp/start.mjs'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  const waiting = new Map();
  let serial = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  child.on('exit', () => {
    for (const resolve of waiting.values())
      resolve({ error: { message: `The server exited.\n${stderr}` } });
    waiting.clear();
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++serial;
      waiting.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stratum-tests', version: '1' },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
  /** Calls a tool; throws with its message when it reports an error. */
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    if (reply.error) throw new Error(reply.error.message);
    const content = reply.result.content;
    const text = content.find((item) => item.type === 'text')?.text ?? '';
    if (reply.result.isError) throw new Error(`${name}: ${text}`);
    const images = content.filter((item) => item.type === 'image');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return { value, text, images };
  };
  return {
    initialized: initialized.result,
    rpc,
    call,
    close: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
      }),
  };
}
