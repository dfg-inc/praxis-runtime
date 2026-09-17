export const MCP_CONTRACT = "praxis.mcp.result";

export type McpEnvelope = {
  ok: boolean;
  operation: string;
  contract: string;
  version: string;
  data: unknown;
  warnings: string[];
  errors: string[];
  code?: string;
};

export function mcpEnvelope(opts: {
  ok: boolean;
  operation: string;
  version: string;
  data?: unknown;
  warnings?: string[];
  errors?: string[];
  code?: string;
}): McpEnvelope {
  const env: McpEnvelope = {
    ok: opts.ok,
    operation: opts.operation,
    contract: MCP_CONTRACT,
    version: opts.version,
    data: opts.data ?? {},
    warnings: opts.warnings ?? [],
    errors: opts.errors ?? [],
  };
  if (opts.code) env.code = opts.code;
  return env;
}
