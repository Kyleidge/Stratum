// The app's end of the AI assistant channel (lib/assistant-protocol.ts): a
// local pipe (a named pipe on Windows, a user-only Unix socket elsewhere)
// that accepts a connection only after it presents the token written, with
// user-only permissions, to the endpoint file in the profile. Each JSON line
// is a call; `forward` answers it. Plain Node, so tests can run it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rm, writeFile, chmod, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const ASSISTANT_ENDPOINT_FILE = 'assistant-endpoint.json';
/** A line longer than this (a very large import) is refused. */
const MAX_LINE = 512 * 1024 * 1024;

/** The pipe for a profile: stable, and distinct per profile. */
export function endpointPath(userData) {
  const id = createHash('sha256').update(userData).digest('hex').slice(0, 16);
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\stratum-assistant-${id}`;
  // Unix socket paths are limited to about 100 bytes.
  const local = join(userData, 'assistant.sock');
  return local.length < 100
    ? local
    : join(tmpdir(), `stratum-assistant-${id}.sock`);
}

const same = (a, b) =>
  typeof a === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Opens the channel and writes the endpoint file. `forward(call)` returns a
 * result or throws; `onConnections(count)` reports connected assistants.
 */
export async function startAssistantPipe({
  userData,
  forward,
  onConnections = () => {},
}) {
  const path = endpointPath(userData);
  const token = randomBytes(32).toString('hex');
  const endpointFile = join(userData, ASSISTANT_ENDPOINT_FILE);
  const sockets = new Set();
  if (process.platform !== 'win32') await rm(path, { force: true });
  const server = createServer((socket) => {
    let authorised = false;
    socket.setEncoding('utf8');
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const send = (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    lines.on('line', async (line) => {
      if (line.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!authorised) {
        if (!same(message?.token, token)) {
          socket.destroy();
          return;
        }
        authorised = true;
        sockets.add(socket);
        onConnections(sockets.size);
        send({ ready: true });
        return;
      }
      const id = message?.id;
      try {
        send({ id, result: await forward(message) });
      } catch (error) {
        send({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (sockets.delete(socket)) onConnections(sockets.size);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(path, 0o600);
  const temp = `${endpointFile}.partial`;
  await writeFile(
    temp,
    JSON.stringify({ path, token, pid: process.pid }, null, 2),
    { mode: 0o600 },
  );
  await rename(temp, endpointFile);
  return {
    path,
    get connections() {
      return sockets.size;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      onConnections(0);
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(endpointFile, { force: true });
      if (process.platform !== 'win32') await rm(path, { force: true });
    },
  };
}
