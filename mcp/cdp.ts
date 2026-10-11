/**
 * A minimal Chrome DevTools Protocol client over Node's built-in WebSocket,
 * for the Electron window a UI session drives.
 */
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class Cdp {
  private serial = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  closed = false;

  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
      } else if (message.method)
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params);
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const waiting of this.pending.values())
        waiting.reject(new Error('The Stratum window closed.'));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), {
        once: true,
      });
      socket.addEventListener(
        'error',
        () => reject(new Error(`Could not connect to ${url}.`)),
        { once: true },
      );
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('The Stratum window closed.'));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: unknown) => void) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  close() {
    this.socket.close();
  }
}
