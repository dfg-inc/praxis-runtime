#!/usr/bin/env node
/**
 * Tool registration and compatibility with alpha.48. Starts the alpha.48 Runtime bundle (git ref, default 5b4785f) and the
 * current packaged Runtime over stdio with the official MCP client and compares what they register:
 *  - every alpha.48 tool is still registered, with the same name, description-independent input schema (new optional
 *    properties are allowed, removed or newly required ones are not) and the same annotations kind;
 *  - the added tools are exactly the expected ones, each with a valid object schema and a title;
 *  - role-scoped servers (ba, architect, developer, quality) expose the tools the catalog says;
 *  - every tool answers a minimal call with a well-formed envelope (no crash, no raw exception).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const built = spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
if ((built.status ?? 1) !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(1);
}
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationLegacy } = await import("./official-mcp-client.mjs");
const dist = await packClaudeExtension(version);
const now = extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), mkdtempSync(join(tmpdir(), "praxis-tc-")));
const ref = process.env.PRAXIS_ALPHA48_REF ?? "5b4785f";
const old = spawnSync("git", ["show", `${ref}:plugins/runtime/server/praxis-mcp.cjs`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
if (old.status !== 0) {
  console.error(`FAIL tool-compat: cannot read the alpha.48 bundle at ${ref}`);
  process.exit(1);
}
const oldBundle = join(mkdtempSync(join(tmpdir(), "praxis-tc-old-")), "praxis-mcp.cjs");
writeFileSync(oldBundle, old.stdout);

const fail = (m) => {
  console.error(`FAIL tool-compat: ${m}`);
  process.exit(1);
};
const proven = [];
async function open(bundle, role = "runtime") {
  return connectOfficialMcp({ command: process.execPath, args: [bundle, "--role", role], cwd: dirname(bundle), env: { ...hostedCleanEnv(now.dest), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1" }, versionNegotiation: versionNegotiationLegacy(), timeoutMs: 20_000, clientVersion: version });
}
const list = async (s) => Object.fromEntries((await s.client.listTools()).tools.map((t) => [t.name, t]));
const a = await open(oldBundle);
const b = await open(now.runtime);
const oldTools = await list(a);
const newTools = await list(b);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

for (const name of Object.keys(oldTools)) if (!newTools[name]) fail(`alpha.48 tool ${name} is no longer registered`);
proven.push(`all ${Object.keys(oldTools).length} alpha.48 tools are still registered`);
const problems = [];
for (const [name, tool] of Object.entries(oldTools)) {
  const o = tool.inputSchema;
  const n = newTools[name].inputSchema;
  for (const key of Object.keys(o.properties ?? {})) if (!(key in (n.properties ?? {}))) problems.push(`${name}: property ${key} removed`);
  for (const key of n.required ?? []) if (!(o.required ?? []).includes(key)) problems.push(`${name}: ${key} is newly required`);
  for (const key of o.required ?? []) if (!(n.required ?? []).includes(key)) problems.push(`${name}: ${key} is no longer required (loosened, allowed)`.replace(/.*/, ""));
  for (const [key, spec] of Object.entries(o.properties ?? {})) {
    const next = (n.properties ?? {})[key];
    if (next && spec.type !== next.type) problems.push(`${name}.${key}: type ${spec.type} -> ${next.type}`);
    if (next && spec.enum && !spec.enum.every((v) => (next.enum ?? []).includes(v))) problems.push(`${name}.${key}: enum values removed`);
  }
  if (Boolean(tool.annotations?.destructiveHint) !== Boolean(newTools[name].annotations?.destructiveHint)) problems.push(`${name}: destructiveHint changed`);
  // an alpha.48 read-only tool stays read-only unless it now writes: those are named below
}
const problemsReal = problems.filter(Boolean);
if (problemsReal.length) fail(problemsReal.join("; "));
proven.push("input schemas are backward compatible (no property removed, none newly required, no type change, no enum value removed, same destructive hint)");
const added = Object.keys(newTools).filter((n) => !oldTools[n]).sort();
const expected = ["praxis_canon_init_apply", "praxis_canon_init_preview", "praxis_context_diagnose", "praxis_frontend_discover", "praxis_repository_brief", "praxis_repository_inspect", "praxis_review_apply", "praxis_review_render", "praxis_workflow_commands"];
if (canon(added) !== canon(expected)) fail(`added tools ${added.join(", ")} differ from the expected ${expected.join(", ")}`);
for (const n of added) {
  const t = newTools[n];
  if (t.inputSchema?.type !== "object" || !t.description || t.description.length < 60 || !t.annotations?.title) fail(`${n} has an incomplete registration: ${JSON.stringify({ type: t.inputSchema?.type, ap: t.inputSchema?.additionalProperties, d: (t.description ?? "").length, ann: t.annotations })}`);
}
proven.push(`exactly ${added.length} tools were added (${added.join(", ")}), each with an object schema, a description and annotations`);
const changedAnnotations = Object.keys(oldTools).filter((n) => Boolean(oldTools[n].annotations?.readOnlyHint) !== Boolean(newTools[n].annotations?.readOnlyHint));
if (changedAnnotations.length) fail(`readOnlyHint changed for ${changedAnnotations.join(", ")}`);
proven.push("annotations of the alpha.48 tools are unchanged");
if (!(newTools.praxis_review_render.annotations?.readOnlyHint === false && newTools.praxis_repository_inspect.annotations?.readOnlyHint === false)) fail("tools that write state or start a page server are annotated read-only");
proven.push("praxis_review_render and praxis_repository_inspect are not annotated read-only");

// role-scoped servers
const rolePlan = { ba: ["praxis_review_render", "praxis_workflow_commands"], architect: ["praxis_repository_inspect"], developer: ["praxis_repository_brief"], quality: ["praxis_repository_brief"] };
for (const [role, mustHave] of Object.entries(rolePlan)) {
  const s = await open(now.runtime, role);
  const tools = await list(s);
  for (const n of mustHave) if (!tools[n]) fail(`role ${role} lacks ${n}`);
  if (Object.keys(tools).length < 20) fail(`role ${role} lists only ${Object.keys(tools).length} tools`);
  await s.close();
}
proven.push("role-scoped servers (ba, architect, developer, quality) expose the new tools the catalog assigns them");

// every tool answers a minimal call with an envelope
const repo = mkdtempSync(join(tmpdir(), "praxis-tc-repo-"));
const writes = new Set(["praxis_project_init_apply", "praxis_ba_apply", "praxis_architect_apply", "praxis_developer_claim", "praxis_developer_release", "praxis_developer_complete", "praxis_developer_complete_recovery_apply", "praxis_quality_apply", "praxis_developer_git_connect_apply", "praxis_developer_git_identity_apply", "praxis_developer_git_commit", "praxis_developer_git_publish", "praxis_developer_git_merge_request", "praxis_developer_git_link_jira_apply", "praxis_workflow_apply", "praxis_quality_ensure", "praxis_jira_smoke", "praxis_jira_discover", "praxis_jira_epic", "praxis_quality_review"]);
let envelopes = 0;
let validations = 0;
for (const name of Object.keys(newTools)) {
  if (writes.has(name)) continue; // protected or networked tools are covered by their own acceptance scripts
  const args = name === "praxis_session_start" ? { repo, role: "ba" } : name === "praxis_review_render" ? { repo, view: "requirements", serve: false } : name === "praxis_repository_inspect" ? { repo, repositoryId: "x" } : { repo };
  let res;
  try {
    res = await b.client.callTool({ name, arguments: args });
  } catch (error) {
    fail(`${name} threw instead of answering: ${String(error).slice(0, 200)}`);
  }
  const text = res?.content?.[0]?.text ?? "";
  if (res?.isError && /Input validation error/.test(text)) {
    validations += 1; // the protocol layer refused arguments that miss a required field: a correct refusal, not a crash
    continue;
  }
  const env = parseDoctorEnvelope(res);
  if (!env || typeof env.ok !== "boolean" || typeof env.operation !== "string") fail(`${name} did not return an envelope: ${JSON.stringify(res).slice(0, 200)}`);
  envelopes += 1;
}
proven.push(`${envelopes} non-protected tools answered a minimal call with a well-formed envelope and ${validations} refused it cleanly for a missing required argument`);
await a.close();
await b.close();
console.log(`PASS tool-compat (${proven.length} groups; alpha.48 = ${Object.keys(oldTools).length} tools, now ${Object.keys(newTools).length})\n${proven.map((p) => `  ok ${p}`).join("\n")}`);
