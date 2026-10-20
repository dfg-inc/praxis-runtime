#!/usr/bin/env node
/**
 * Where do the MCP tools a host shows come from? Read-only report.
 *
 * Starts each known Praxis Runtime build as a stdio MCP server in an empty temporary directory, asks it for its
 * tools and its doctor build record, and prints one row per origin: bundle sha256, build kind, tool count and a
 * digest of the sorted tool names. Rows with the same digest offer the same tools; a host whose tool list differs
 * from the row of the build it claims to run is holding a stale tool registry (a session opened before the
 * extension was updated) and needs a new session, not a new version number.
 *
 * It starts servers; it does not install, copy or change anything outside its own temp directory.
 *
 *   node tools/scripts/tool-origins-report.mjs [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } from "./official-mcp-client.mjs";
import { extractMcpbRuntime } from "./mcpb-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const split = resolve(root, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "praxis-origins-"));

const bundles = [
  ["Claude Desktop extension (used by Chat and Code)", join(homedir(), "Library/Application Support/Claude/Claude Extensions/local.mcpb.dfuture-co.praxis-runtime/server/praxis-mcp.cjs")],
  ["this repository: plugins/runtime bundle", join(root, "plugins/runtime/server/praxis-mcp.cjs")],
  ["marketplace staged runtime plugin", join(split, "praxis-marketplace/plugins/praxis-runtime/server/praxis-mcp.cjs")],
  ["marketplace release candidate", join(split, "praxis-marketplace/release-candidate/plugins/praxis-runtime/server/praxis-mcp.cjs")],
];
const mcpbs = [["tracked MCPB (claude-extensions/)", join(root, "claude-extensions/praxis-runtime.mcpb")], ["desktop-install MCPB", join(split, "desktop-install/praxis-runtime.mcpb")]];

async function probe(label, file) {
  if (!existsSync(file)) return { origin: label, path: file, present: false };
  const row = { origin: label, path: file, present: true, bundleSha256: sha(file) };
  try {
    const session = await connectOfficialMcp({
      command: process.execPath,
      args: [file, "--role", "runtime"],
      cwd: scratch,
      env: { ...hostedCleanEnv(dirname(file)), PRAXIS_SKIP_DOTENV: "1" },
      versionNegotiation: versionNegotiationModern(),
      timeoutMs: 20_000,
      clientVersion: version,
    });
    try {
      const names = (await session.client.listTools()).tools.map((t) => t.name).sort();
      const doctor = parseDoctorEnvelope(await session.client.callTool({ name: "praxis_doctor", arguments: { repo: scratch } }));
      row.tools = names.length;
      row.toolDigest = createHash("sha256").update(names.join("\n")).digest("hex");
      row.hasInspect = names.includes("praxis_workflow_inspect");
      row.hasSessionStart = names.includes("praxis_session_start");
      row.build = { kind: doctor?.data?.build?.kind ?? "unknown", sourceDigest: doctor?.data?.build?.sourceDigest ?? null, coreBaseline: doctor?.data?.build?.coreBaseline ?? null };
    } finally {
      await session.close();
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  return row;
}

const rows = [];
for (const [label, file] of bundles) rows.push(await probe(label, file));
for (const [label, file] of mcpbs) {
  if (!existsSync(file)) {
    rows.push({ origin: label, path: file, present: false });
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), "praxis-origins-mcpb-"));
  try {
    const extracted = extractMcpbRuntime(file, dir);
    const row = await probe(label, join(extracted.dest, "server/praxis-mcp.cjs"));
    row.path = file;
    row.mcpbSha256 = sha(file);
    rows.push(row);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What Claude Desktop recorded about the extension it installed and when it last (re)started the server.
const record = join(homedir(), "Library/Application Support/Claude/extensions-installations.json");
let installed = null;
try {
  const e = JSON.parse(readFileSync(record, "utf8")).extensions?.["local.mcpb.dfuture-co.praxis-runtime"];
  if (e) installed = { version: e.version, mcpbSha256: e.hash, installedAt: e.installedAt, signature: e.signatureInfo?.status };
} catch {
  /* not a Desktop host */
}
rmSync(scratch, { recursive: true, force: true });

const digests = new Set(rows.filter((r) => r.toolDigest).map((r) => r.toolDigest));
const report = { generatedAt: new Date().toISOString(), version, desktopExtensionRecord: installed, origins: rows, distinctToolSets: digests.size };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Praxis Runtime tool origins (version string ${version} says nothing about which build is which)\n`);
  for (const r of rows) {
    if (!r.present) console.log(`  absent   ${r.origin}`);
    else if (r.error) console.log(`  ERROR    ${r.origin}: ${r.error}`);
    else console.log(`  ${String(r.tools).padStart(2)} tools  sha ${r.bundleSha256.slice(0, 12)}  tools ${r.toolDigest.slice(0, 12)}  kind ${r.build.kind}  inspect=${r.hasInspect} session_start=${r.hasSessionStart}  ${r.origin}`);
  }
  if (installed) console.log(`\nDesktop recorded: MCPB ${installed.mcpbSha256.slice(0, 12)} installed ${installed.installedAt} (${installed.signature})`);
  console.log(`\n${digests.size} distinct tool set(s). A session that shows a different tool list than the build it runs opened before that build was installed: start a new session.`);
}
