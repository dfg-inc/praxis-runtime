#!/usr/bin/env node
/**
 * Isolated Claude Code host integration for Runtime MCP.
 * Uses CLAUDE_CONFIG_DIR temp profile. Distinguishes:
 *  - host plugin install + MCP binary start (automated)
 *  - interactive Claude Code chat tool calls (manual / BLOCKED if not run)
 */
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const marketplace = resolve(process.argv[2] || join(import.meta.dirname, "../../../praxis-marketplace/release-candidate"));
const config = mkdtempSync(join(tmpdir(), "praxis-host-"));
process.env.CLAUDE_CONFIG_DIR = config;

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", env: process.env });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

if (!existsSync(join(marketplace, ".claude-plugin/marketplace.json"))) {
  console.error(`missing marketplace at ${marketplace}; build RC first`);
  process.exit(1);
}

const validate = run("claude", ["plugin", "validate", marketplace]);
check("marketplace_validate", (validate.status ?? 1) === 0);

const add = run("claude", ["plugin", "marketplace", "add", marketplace, "--scope", "user"]);
check("marketplace_add", (add.status ?? 1) === 0);

for (const name of ["praxis-runtime", "praxis-ba", "praxis-architect", "praxis-developer", "praxis-quality"]) {
  const install = run("claude", ["plugin", "install", `${name}@praxis`, "--scope", "user"]);
  check(`install_${name}`, (install.status ?? 1) === 0);
}

const details = run("claude", ["plugin", "details", "praxis-runtime@praxis"]);
check("runtime_mcp_registered", /MCP servers \(1\)/.test(details.stdout || ""));

const mcp = spawnSync("bash", ["-lc", `find "${config}/plugins/cache" -name praxis-mcp.cjs | head -1`], {
  encoding: "utf8",
}).stdout.trim();
check("runtime_mcp_binary_cached", Boolean(mcp));

if (mcp) {
  await new Promise((resolvePromise) => {
    const child = spawn("node", [mcp, "--role", "runtime"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "host-integration", version: "0" },
        },
      })}\n`,
    );
    setTimeout(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    }, 200);
    setTimeout(() => {
      child.kill("SIGTERM");
      const tools = (out.match(/"name":"praxis_/g) || []).length;
      check("mcp_stdio_ready", err.includes("[praxis-mcp] ready"));
      check("mcp_tools_discoverable", tools >= 40, `tools=${tools}`);
      // read-only doctor via direct JSON-RPC (not Claude chat)
      resolvePromise();
    }, 900);
  });
}

const project = mkdtempSync(join(tmpdir(), "praxis-project-"));
mkdirSync(join(project, ".praxis"), { recursive: true });
writeFileSync(
  join(project, "MANUAL-CLAUDE-CHAT.md"),
  `# Manual Claude Code chat acceptance

CLAUDE_CONFIG_DIR was ${config}
Marketplace ${marketplace}

In an interactive Claude Code session with this config:

1. Ask Claude to call praxis_doctor
2. Ask Claude to call praxis_project_status on ${project}
3. Attempt a protected apply without broker approval — expect refusal
4. Record PASS/FAIL below

Interactive chat tool invocation: PENDING
`,
);
check("interactive_claude_chat_tools", false, "BLOCKED pending manual session; see MANUAL-CLAUDE-CHAT.md");

const failed = results.filter((r) => !r.ok && !r.detail.includes("BLOCKED"));
const blocked = results.filter((r) => String(r.detail).includes("BLOCKED"));
console.log(`config=${config}`);
console.log(`project=${project}`);
console.log(`BLOCKED=${blocked.length}`);
console.log(failed.length ? "HOST_INTEGRATION FAIL" : "HOST_INTEGRATION PASS_WITH_BLOCKED");
process.exit(failed.length ? 1 : 0);
