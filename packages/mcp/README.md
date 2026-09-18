Praxis MCP is the Claude Desktop / Cowork protocol adapter over the same operations used by `@praxis/cli`.

It is bundled into **Praxis Runtime** (`claude-extensions/praxis-runtime.mcpb` as `server/praxis-mcp.cjs`). Role plugins no longer ship a duplicate MCP. It is not part of `make release-local` tgz distribution.

## Runtime

- Official MCP TypeScript SDK `@modelcontextprotocol/server` **2.0.0**
- Stdio entry: `serveStdio(factory, { legacy: "serve" })` (modern 2026-07-28 + legacy initialize)
- Node **>= 20**
- stdout is MCP protocol only; diagnostics go to stderr
- Heavy work (Jira, git, Quality service) runs only inside tool handlers
- `--role runtime` exposes the complete stable tool API; role isolation is in Skills

MCPB launches:

```
node ${__dirname}/server/praxis-mcp.cjs --role runtime
```

Jira settings are injected as `PRAXIS_JIRA_*` from `user_config`. Invalid `--role` exits immediately with `PRAXIS_MCP_ROLE_INVALID`.
