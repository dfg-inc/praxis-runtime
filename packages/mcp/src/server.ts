import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  parseRoleArgv,
  PraxisMcpRoleError,
  toolsForRole,
  type JsonSchema,
  type PraxisRole,
} from "./catalog.js";
import { bundleVersion, PRAXIS_MCP_SDK } from "./protocol.js";
import { callTool } from "./tools.js";

export { parseRoleArgv, PraxisMcpRoleError } from "./catalog.js";
export { PRAXIS_MCP_SDK } from "./protocol.js";

function jsonSchemaToZod(schema: JsonSchema) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(schema.properties)) {
    const prop = (raw ?? {}) as { type?: string; description?: string; enum?: string[] };
    let field: z.ZodTypeAny =
      prop.enum && prop.enum.length > 0
        ? z.enum(prop.enum as [string, ...string[]])
        : z.string();
    if (prop.description) field = field.describe(prop.description);
    if (!schema.required?.includes(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

function logStderr(line: string): void {
  console.error(line);
}

export function createPraxisMcpServer(opts: { role: PraxisRole; version: string }): McpServer {
  const server = new McpServer(
    { name: "praxis", version: opts.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const tool of toolsForRole(opts.role)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchemaToZod(tool.inputSchema),
      },
      async (args, extra) => {
        const signal =
          extra && typeof extra === "object" && "signal" in extra
            ? (extra as { signal?: AbortSignal }).signal
            : undefined;
        const envelope = await callTool(tool.name, args ?? {}, {
          role: opts.role,
          version: opts.version,
          extra: { signal },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
          isError: !envelope.ok,
        };
      },
    );
  }
  return server;
}

function failStart(code: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  logStderr(`[praxis-mcp] ${code} ${message}`);
  process.exit(code === "PRAXIS_MCP_ROLE_INVALID" ? 2 : 1);
}

export function startStdioServer(opts?: {
  role?: PraxisRole;
  version?: string;
}): StdioServerHandle {
  const version = opts?.version ?? bundleVersion();
  let role: PraxisRole;
  try {
    role = opts?.role ?? parseRoleArgv(process.argv.slice(2));
  } catch (err) {
    failStart("PRAXIS_MCP_ROLE_INVALID", err instanceof PraxisMcpRoleError ? err : err);
  }
  logStderr("[praxis-mcp] starting");
  logStderr(`[praxis-mcp] version=${version}`);
  logStderr(`[praxis-mcp] role=${role}`);
  logStderr("[praxis-mcp] transport=stdio");
  logStderr("[praxis-mcp] protocol=modern+legacy");
  try {
    const handle = serveStdio(() => createPraxisMcpServer({ role, version }), {
      legacy: PRAXIS_MCP_SDK.legacyMode,
      onerror: (error) => {
        logStderr(`[praxis-mcp] PRAXIS_MCP_RUNTIME_ERROR ${error.message}`);
      },
    });
    logStderr("[praxis-mcp] ready");
    const shutdown = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return handle;
  } catch (err) {
    failStart("PRAXIS_MCP_START_FAILED", err);
  }
}
