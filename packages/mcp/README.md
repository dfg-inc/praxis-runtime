Praxis MCP is the Claude UI / Cowork protocol adapter over the same operations used by `@praxis/cli`.

It is bundled into hosted plugin ZIPs (`runtime/praxis-mcp.cjs`). It is not part of `make release-local` tgz distribution because claude.ai hosted plugins cannot install npm packages.

## Runtime

- Official MCP TypeScript SDK `@modelcontextprotocol/server` **2.0.0**
- Stdio entry: `serveStdio(factory, { legacy: "serve" })` (modern 2026-07-28 + legacy initialize)
- Node **>= 20** (Claude Desktop may select system Node 24 or 25; the bundle does not use Node 25-only features)
- stdout is MCP protocol only; diagnostics go to stderr
- Heavy work (Jira, git, Quality service) runs only inside tool handlers

`.mcp.json` launches:

```
node ${CLAUDE_PLUGIN_ROOT}/runtime/praxis-mcp.cjs --role <ba|architect|developer|quality>
```

The server does not read `CLAUDE_PLUGIN_ROOT`. Invalid `--role` exits immediately with `PRAXIS_MCP_ROLE_INVALID`.
