import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  parseRoleArgv,
  PraxisMcpRoleError,
  toolsForRole,
  type PraxisRole,
} from "./catalog.js";
import { elicitationChannel } from "./approval-channel.js";
import { bundleVersion, PRAXIS_MCP_SDK } from "./protocol.js";
import { jsonSchemaToZod } from "./schema.js";
import { callTool } from "./tools.js";
import type { ToolDef } from "./catalog.js";

export { parseRoleArgv, PraxisMcpRoleError } from "./catalog.js";
export { PRAXIS_MCP_SDK } from "./protocol.js";
export { jsonSchemaToZod } from "./schema.js";

function logStderr(line: string): void {
  console.error(line);
}

/**
 * Hints for the client's own permission UI: a preview or status reads, an apply changes something outside the
 * agent's notes (so a client that prompts per tool call prompts here, in addition to Praxis asking for the decision).
 */
function annotationsFor(tool: ToolDef) {
  const applies = tool.kind === "apply";
  return {
    title: tool.name,
    readOnlyHint: !applies,
    destructiveHint: applies,
    idempotentHint: false,
    openWorldHint: applies || tool.name.includes("jira") || tool.name.includes("git"),
  };
}

/** The client's approval dialog for this call, when the client declared it can show one. */
function clientApprovalChannel(server: McpServer, extra: unknown) {
  const elicit = (extra as { mcpReq?: { elicitInput?: (params: never, options?: never) => Promise<never> } } | undefined)?.mcpReq?.elicitInput;
  const capabilities = server.server.getClientCapabilities?.();
  const declared = capabilities?.elicitation;
  // A bare `elicitation: {}` means form mode (the pre-mode rule); an explicit object without `form` means URL mode only.
  const form = declared !== undefined && (Object.keys(declared as object).length === 0 || "form" in (declared as object));
  if (!elicit) return undefined;
  // The 2026-07-28 revision replaces server-initiated requests with input_required results, which this server does not
  // implement: on such a connection there is no dialog to offer, and the client is treated as one that cannot ask.
  const negotiated = server.server.getNegotiatedProtocolVersion?.();
  if (negotiated && negotiated >= PRAXIS_MCP_SDK.modernRevision) return undefined;
  return elicitationChannel({
    supported: form,
    elicitInput: (params, options) => (elicit as unknown as (p: unknown, o?: unknown) => Promise<never>)(params, options),
  });
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
        annotations: annotationsFor(tool),
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
          approvalChannel: clientApprovalChannel(server, extra),
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
