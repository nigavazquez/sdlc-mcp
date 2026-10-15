import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { ToolRegistry } from './tools/index.js';

export interface BuildMcpOptions {
  registry: ToolRegistry;
  /**
   * Resolves the TenantCtx for the current request. The transport layer must
   * authenticate and inject this before tool calls reach the registry.
   */
  resolveCtx: () => TenantCtx;
}

export function buildMcpServer(opts: BuildMcpOptions): McpServer {
  const server = new McpServer(
    {
      name: 'sdlc-mcp',
      version: '0.0.1',
    },
    {
      capabilities: { tools: {} },
    },
  );

  for (const tool of opts.registry.list()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
      },
      async (input: unknown) => {
        const ctx = opts.resolveCtx();
        const parsed = tool.inputSchema.parse(input ?? {});
        const result = await tool.handler(parsed, ctx);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          // Las guardas de rol y de negocio devuelven `{ ok: false }` en vez de tirar. Sin
          // `isError`, un cliente MCP lee ese rechazo como un resultado exitoso.
          ...(isRejection(result) ? { isError: true } : {}),
        };
      },
    );
  }

  return server;
}

function isRejection(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
}

export function describeTools(registry: ToolRegistry) {
  return registry.list().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { target: 'jsonSchema7' }),
  }));
}
