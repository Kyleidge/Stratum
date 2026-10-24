/**
 * The user-facing backend: the user's running Stratum, reached through the
 * private assistant channel (lib/assistant-protocol.ts). Nothing connects
 * until a tool is used; then, if the user allows AI assistants but Stratum is
 * closed, it is started. Every request runs in the workbench, so changes
 * appear in History and can be undone.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ASSISTANT_ENDPOINT_FILE,
  ASSISTANT_SETTINGS_FILE,
  fromBase64,
  toBase64,
  type AssistantEndpoint,
  type AssistantFile,
  type AssistantMethod,
  type AssistantRequestResult,
} from '../lib/assistant-protocol';
import type { EngineCommand } from '../lib/engine-requests';
import {
  fileBytes,
  withFiles,
  type Backend,
  type FileRef,
  type Reply,
  type WorkspaceState,
} from './backend';

export const ACCESS_OFF =
  'Stratum does not allow AI assistants yet. In Stratum, open Workspace → AI assistants and choose "Allow AI assistants", then try again.';

type Connection = {
  socket: Socket;
  waiting: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export type AppBackendOptions = {
  /** Stratum's profile folder (userData). */
  userData: string;
  /** Starts Stratum when it is not running. */
  launch: () => void;
  /** How long to wait for a started Stratum (ms). */
  startTimeout?: number;
};

export class AppBackend implements Backend {
  readonly target = 'app';
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private serial = 0;
  constructor(private readonly options: AppBackendOptions) {}

  private async enabled() {
    const settings = await readJson<{ enabled?: boolean }>(
      join(this.options.userData, ASSISTANT_SETTINGS_FILE),
    );
    return settings?.enabled === true;
  }

  /** Opens and authenticates a connection to the endpoint, if it answers. */
  private async open(): Promise<Connection | undefined> {
    const endpoint = await readJson<AssistantEndpoint>(
      join(this.options.userData, ASSISTANT_ENDPOINT_FILE),
    );
    if (!endpoint?.path || !endpoint.token) return undefined;
    const socket = await new Promise<Socket | undefined>((resolve) => {
      const attempt = connect(endpoint.path);
      attempt.once('connect', () => resolve(attempt));
      attempt.once('error', () => resolve(undefined));
    });
    if (!socket) return undefined;
    socket.setEncoding('utf8');
    const connection: Connection = { socket, waiting: new Map() };
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const ready = new Promise<boolean>((resolve) => {
      let first = true;
      lines.on('line', (line) => {
        let message: {
          ready?: boolean;
          id?: number;
          result?: unknown;
          error?: string;
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (first) {
          first = false;
          resolve(message.ready === true);
          return;
        }
        const call = connection.waiting.get(message.id ?? -1);
        if (!call) return;
        connection.waiting.delete(message.id!);
        if (typeof message.error === 'string')
          call.reject(new Error(message.error));
        else call.resolve(message.result);
      });
      socket.once('close', () => resolve(false));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const call of connection.waiting.values())
        call.reject(new Error('Stratum closed the connection.'));
      connection.waiting.clear();
      if (this.connection === connection) this.connection = undefined;
    });
    socket.write(`${JSON.stringify({ token: endpoint.token })}\n`);
    if (!(await ready)) {
      socket.destroy();
      return undefined;
    }
    return connection;
  }

  private connect(): Promise<Connection> {
    if (this.connection && !this.connection.socket.destroyed)
      return Promise.resolve(this.connection);
    this.connecting ??= (async () => {
      try {
        if (!(await this.enabled())) throw new Error(ACCESS_OFF);
        let connection = await this.open();
        if (!connection) {
          this.options.launch();
          const deadline = Date.now() + (this.options.startTimeout ?? 90_000);
          while (!connection && Date.now() < deadline) {
            await sleep(500);
            if (!(await this.enabled())) throw new Error(ACCESS_OFF);
            connection = await this.open();
          }
        }
        if (!connection)
          throw new Error(
            'Stratum did not open. Start Stratum, make sure AI assistants are allowed in Workspace → AI assistants, and try again.',
          );
        this.connection = connection;
        return connection;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Calls the workbench through the channel. */
  async call<T>(method: AssistantMethod, params?: Record<string, unknown>) {
    const connection = await this.connect();
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      connection.waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      connection.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async request(
    request: EngineCommand | Record<string, unknown>,
  ): Promise<Reply> {
    const files: AssistantFile[] = [];
    const message = await withFiles(request, async (ref: FileRef) => {
      const { name, bytes } = await fileBytes(ref);
      files.push({ name, data: toBase64(bytes) });
      return { $fileIndex: files.length - 1 };
    });
    const reply = await this.call<AssistantRequestResult>('request', {
      message,
      files,
    });
    if (reply.type === 'export') {
      const { bytesBase64, ...rest } = reply;
      return { ...rest, bytes: fromBase64(bytesBase64) } as unknown as Reply;
    }
    return reply as Reply;
  }

  state(): Promise<WorkspaceState> {
    return this.call<WorkspaceState>('state');
  }

  cancel() {
    void this.call('cancel').catch(() => {});
  }

  show(id: string): Promise<string> {
    return this.call<string>('show', { id });
  }

  async renderPng(svg: string): Promise<Uint8Array> {
    return fromBase64(await this.call<string>('render-png', { svg }));
  }

  close() {
    this.connection?.socket.end();
  }
}

/** Starts Stratum as a normal app (not as Node), detached from this server. */
export function launchStratum(appScript?: string) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(process.execPath, appScript ? [appScript] : [], {
    detached: true,
    stdio: 'ignore',
    env,
  }).unref();
}
