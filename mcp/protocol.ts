/**
 * A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0
 * with tools and read-only resources. Kept dependency-free; see
 * docs/mcp-server.md. Everything but protocol messages goes to stderr.
 */
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export type ToolResult = {
  content: Content[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
/** A JSON Schema object, as MCP clients read it. */
export type JsonSchema = Record<string, unknown>;

export type CallContext = {
  /** Reports progress when the client asked for it. */
  progress: (message: string, fraction?: number) => void;
  /** Set when the client cancels the call. */
  signal: AbortSignal;
};

export type Tool = {
  name: string;
  /**
   * Developer harness only (raw access, the engine reset, UI driving); the
   * user-facing app server leaves it out.
   */
  developer?: true;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /**
   * Returns a full result, text, or any other value as JSON text. A thrown
   * error becomes an `isError` result the model can read and correct.
   */
  run: (
    args: Record<string, unknown>,
    context: CallContext,
  ) => Promise<unknown>;
};

export type Resource = {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  read: () => Promise<string>;
};

type Message = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const PRIMITIVE = String.raw`(?:-?[\d.eE+-]+|null|true|false|"[^"\n]{0,60}")`;
const FLAT_ARRAY = new RegExp(
  String.raw`\[\n\s*(${PRIMITIVE}(?:,\n\s*${PRIMITIVE})*)\n\s*\]`,
  'g',
);

/** Indented JSON with short arrays of numbers or names on one line. */
export function formatJson(value: unknown) {
  return JSON.stringify(value, null, 1).replace(
    FLAT_ARRAY,
    (_, inner: string) => `[${inner.replace(/,\n\s*/g, ', ')}]`,
  );
}

export function asResult(value: unknown): ToolResult {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as ToolResult).content)
  )
    return value as ToolResult;
  if (typeof value === 'string')
    return { content: [{ type: 'text', text: value }] };
  if (value === undefined)
    return { content: [{ type: 'text', text: 'Done.' }] };
  return {
    content: [{ type: 'text', text: formatJson(value) }],
  };
}

/** Checks required properties and primitive types against a tool's schema. */
function checkArguments(tool: Tool, args: Record<string, unknown>) {
  const schema = tool.inputSchema as {
    required?: string[];
    properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
  };
  for (const name of schema.required ?? [])
    if (args[name] === undefined)
      throw new Error(`${tool.name}: "${name}" is required.`);
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    if (!property) {
      if (schema.properties)
        throw new Error(
          `${tool.name}: unknown argument "${name}". Expected one of: ${Object.keys(schema.properties).join(', ') || 'none'}.`,
        );
      continue;
    }
    if (property.enum && !property.enum.includes(value))
      throw new Error(
        `${tool.name}: "${name}" must be one of ${property.enum.map((item) => JSON.stringify(item)).join(', ')}.`,
      );
    const types = [property.type ?? []].flat();
    if (!types.length) continue;
    const actual = Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : typeof value;
    const ok = types.some(
      (type) =>
        type === actual ||
        (type === 'integer' &&
          typeof value === 'number' &&
          Number.isInteger(value)) ||
        (type === 'number' && actual === 'number'),
    );
    if (!ok)
      throw new Error(
        `${tool.name}: "${name}" must be ${types.join(' or ')}, not ${actual}.`,
      );
  }
}

export class McpServer {
  private tools = new Map<string, Tool>();
  private resources = new Map<string, Resource>();
  private running = new Map<string | number, AbortController>();
  private closing: (() => Promise<void>)[] = [];
  constructor(
    private info: { name: string; version: string; instructions: string },
  ) {}

  addTools(tools: Tool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name))
        throw new Error(`Duplicate MCP tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }
  addResources(resources: Resource[]) {
    for (const resource of resources)
      this.resources.set(resource.uri, resource);
  }
  onClose(close: () => Promise<void>) {
    this.closing.push(close);
  }
  get toolList(): Tool[] {
    return [...this.tools.values()];
  }

  private write(message: Message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** Handles one request and returns its result (also used by tests). */
  async handle(
    method: string,
    params: Record<string, unknown> = {},
    id?: string | number,
  ): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested =
          typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : '';
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: { name: this.info.name, version: this.info.version },
          instructions: this.info.instructions,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.toolList.map((tool) => ({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        };
      case 'tools/call': {
        const tool = this.tools.get(String(params.name));
        if (!tool)
          throw new RpcError(
            -32602,
            `Unknown tool: ${JSON.stringify(params.name)}`,
          );
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const token = (params._meta as { progressToken?: string | number })
          ?.progressToken;
        const controller = new AbortController();
        if (id !== undefined) this.running.set(id, controller);
        let step = 0;
        try {
          checkArguments(tool, args);
          return asResult(
            await tool.run(args, {
              signal: controller.signal,
              progress: (message, fraction) => {
                if (token === undefined) return;
                this.write({
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: {
                    progressToken: token,
                    progress: fraction === undefined ? ++step : fraction,
                    ...(fraction === undefined ? {} : { total: 1 }),
                    message,
                  },
                });
              },
            }),
          );
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        } finally {
          if (id !== undefined) this.running.delete(id);
        }
      }
      case 'resources/list':
        return {
          resources: [...this.resources.values()].map(
            ({ uri, name, description, mimeType }) => ({
              uri,
              name,
              description,
              mimeType,
            }),
          ),
        };
      case 'resources/read': {
        const resource = this.resources.get(String(params.uri));
        if (!resource)
          throw new RpcError(
            -32002,
            `Resource not found: ${JSON.stringify(params.uri)}`,
          );
        return {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: await resource.read(),
            },
          ],
        };
      }
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async dispatch(message: Message) {
    if (!message.method) return; // A response to nothing we sent.
    if (message.id === undefined || message.id === null) {
      if (message.method === 'notifications/cancelled') {
        const id = message.params?.requestId as string | number | undefined;
        if (id !== undefined) this.running.get(id)?.abort();
      }
      return;
    }
    try {
      const result = await this.handle(
        message.method,
        message.params,
        message.id,
      );
      this.write({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Serves stdin until it closes, then runs the close handlers. */
  async serve() {
    const lines = createInterface({ input: process.stdin });
    const calls: Promise<void>[] = [];
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        this.write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        continue;
      }
      // Calls run concurrently; the backends serialise their own work.
      const call = this.dispatch(message);
      calls.push(call);
      void call.finally(() => calls.splice(calls.indexOf(call), 1));
    }
    await Promise.allSettled(calls);
    for (const close of this.closing) await close().catch(() => {});
  }
}
