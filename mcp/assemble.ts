/**
 * Builds an MCP server from tool groups for a mode. The app server leaves
 * out developer tools and the developer `target` argument, so its tools are
 * the public interface (see docs/mcp-server.md on keeping them stable).
 */
import type { ServerContext } from './context';
import { McpServer, type Resource, type Tool } from './protocol';

export type ToolGroup = (context: ServerContext) => Tool[];

export function assemble(
  context: ServerContext,
  info: { name: string; version: string; instructions: string },
  groups: ToolGroup[],
  resources: Resource[] = [],
) {
  const server = new McpServer(info);
  for (const group of groups) {
    const tools = group(context);
    server.addTools(
      context.mode === 'app'
        ? tools.filter((tool) => !tool.developer).map(withoutTarget)
        : tools,
    );
  }
  server.addResources(resources);
  server.onClose(() => context.closeAll());
  return server;
}

function withoutTarget(tool: Tool): Tool {
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
  };
  if (!schema.properties?.target) return tool;
  const { target: _target, ...properties } = schema.properties;
  return { ...tool, inputSchema: { ...schema, properties } };
}
