#!/usr/bin/env node
import { startStdioServer } from "./server.js";

try {
  startStdioServer();
} catch (err) {
  console.error(
    `[praxis-mcp] PRAXIS_MCP_START_FAILED ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
