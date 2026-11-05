#!/usr/bin/env node
// Direct stdio fallback for an already-running Codex session whose MCP catalog
// predates registration. It never supplies or fabricates a human approval.
import { readFileSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { parseArgs } from "node:util";
import { connectOfficialMcp, parseDoctorEnvelope } from "./official-mcp-client.mjs";

const { values } = parseArgs({ options: { runtime: { type: "string" } } });
if (!values.runtime || !isAbsolute(values.runtime)) throw new Error("--runtime must be an absolute MCP bundle path");
const request = JSON.parse(readFileSync(0, "utf8"));
if (typeof request.repo !== "string" || !isAbsolute(request.repo)) throw new Error("repo must be absolute");
if (typeof request.tool !== "string" || !request.tool.startsWith("praxis_")) throw new Error("tool must name a Praxis tool");
if (request.arguments !== undefined && (request.arguments === null || typeof request.arguments !== "object" || Array.isArray(request.arguments))) throw new Error("arguments must be an object");
if (request.arguments?.repo !== undefined && request.arguments.repo !== request.repo) throw new Error("conflicting repositories");

const session = await connectOfficialMcp({
  command: process.execPath,
  args: [values.runtime, "--role", "runtime"],
  cwd: request.repo,
  // Do not inherit dotenv files, approval bypasses, tokens or test settings.
  env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, PRAXIS_SKIP_DOTENV: "1" },
  clientName: "codex-praxis-stdio-bridge",
});
try {
  const result = await session.client.callTool({ name: request.tool, arguments: { ...request.arguments, repo: request.repo } });
  const envelope = parseDoctorEnvelope(result);
  process.stdout.write(JSON.stringify(envelope ?? result, null, 2) + "\n");
  if (result.isError || envelope?.ok === false) process.exitCode = 1;
} finally {
  await session.close();
}
