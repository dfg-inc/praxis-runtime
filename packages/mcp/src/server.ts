import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, McpServer, PROTOCOL_VERSION_META_KEY, inputRequired } from "@modelcontextprotocol/server";
import { ApprovalNeedsInput } from "@praxis/contracts";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  parseRoleArgv,
  PraxisMcpRoleError,
  toolsForRole,
  type PraxisRole,
} from "./catalog.js";
import { approvalKey, elicitParams, elicitationChannel, roundTripChannel } from "./approval-channel.js";
import { bundleVersion, PRAXIS_MCP_SDK } from "./protocol.js";
import { jsonSchemaToZod } from "./schema.js";
import { callTool, type ClientReport } from "./tools.js";
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

/**
 * What this connection offers for approvals, from what the client declared and the protocol revision it negotiated.
 * Reported by `praxis_doctor` (approval.client) so the user and the agent can see the evidence instead of a guess:
 * MCP defines elicitation, but whether a particular host implements it is only known from its declaration.
 *
 * Two protocol eras carry the declaration differently. Up to 2025-11-25 the client sends its capabilities once, at
 * initialize. From 2026-07-28 it sends them in every request's _meta envelope (there is no initialize), and the server
 * asks by returning input_required (the client retries with the answer).
 */
export function describeClient(server: McpServer, extra: unknown): ClientReport {
  const ctx = (extra as { mcpReq?: { elicitInput?: unknown; envelope?: Record<string, unknown> } } | undefined)?.mcpReq;
  const negotiated = (ctx?.envelope?.[PROTOCOL_VERSION_META_KEY] as string | undefined) ?? server.server.getNegotiatedProtocolVersion?.();
  const modern = Boolean(negotiated && negotiated >= PRAXIS_MCP_SDK.modernRevision);
  const info = (modern ? (ctx?.envelope?.[CLIENT_INFO_META_KEY] as { name?: string; version?: string } | undefined) : undefined) ?? server.server.getClientVersion?.();
  const caps = (modern ? (ctx?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown> | undefined) : undefined) ?? (server.server.getClientCapabilities?.() as Record<string, unknown> | undefined);
  const declared = caps?.elicitation as Record<string, unknown> | undefined;
  // A bare `elicitation: {}` means form mode (the pre-mode rule); an explicit object without `form` means URL mode only.
  const form = declared !== undefined && (Object.keys(declared).length === 0 || "form" in declared);
  const url = declared !== undefined && "url" in declared;
  const reason = declared === undefined
    ? `the client did not declare the elicitation capability (${modern ? "in the request envelope" : "at initialize"})`
    : !form
      ? "the client declared URL-mode elicitation only; Praxis needs form mode to show the action and take an answer"
      : !modern && !ctx?.elicitInput
        ? "the SDK did not expose elicitInput for this request"
        : undefined;
  return {
    name: info?.name,
    version: info?.version,
    protocolVersion: negotiated,
    capabilities: caps ? Object.keys(caps).sort() : [],
    elicitation: { declared: declared ?? null, form, url },
    dialog: reason === undefined,
    flow: modern ? "input-required-round-trip" : "server-initiated-request",
    ...(reason ? { reason } : {}),
  };
}

function clientApprovalChannel(extra: unknown, client: ClientReport) {
  if (!client.dialog) return undefined;
  const ctx = (extra as { mcpReq?: { elicitInput?: (params: never, options?: never) => Promise<never>; inputResponses?: Record<string, unknown> } } | undefined)?.mcpReq;
  if (client.flow === "input-required-round-trip") return roundTripChannel(ctx?.inputResponses);
  const elicit = ctx?.elicitInput;
  if (!elicit) return undefined;
  return elicitationChannel({
    supported: true,
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
        const client = describeClient(server, extra);
        let envelope;
        try {
          envelope = await callTool(tool.name, args ?? {}, {
            role: opts.role,
            version: opts.version,
            extra: { signal },
            approvalChannel: clientApprovalChannel(extra, client),
            client,
          });
        } catch (error) {
          // 2026-07-28: nothing has run; ask the user in the client's dialog and let it retry the call with the answer
          if (error instanceof ApprovalNeedsInput) {
            return inputRequired({ inputRequests: { [approvalKey(error.request)]: inputRequired.elicit(elicitParams(error.request) as never) } });
          }
          throw error;
        }
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
