/** Official MCP TypeScript SDK v2 protocol surface used by Praxis stdio. */
export const PRAXIS_MCP_SDK = {
  package: "@modelcontextprotocol/server",
  version: "2.0.0",
  clientPackage: "@modelcontextprotocol/client",
  clientVersion: "2.0.0",
  stdioApi: "serveStdio",
  legacyMode: "serve",
  modernRevision: "2026-07-28",
  legacyRevisions: [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
  ],
} as const;

export function bundleVersion(): string {
  return process.env.PRAXIS_BUNDLE_VERSION || "0.0.0";
}
