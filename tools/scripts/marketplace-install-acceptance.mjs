#!/usr/bin/env node
/**
 * Clean-environment install of Praxis through the real Claude Code plugin CLI, from a git clone of the marketplace.
 * Uses a throwaway CLAUDE_CONFIG_DIR: the user's own Claude settings and plugins are never read or changed.
 *
 *   node tools/scripts/marketplace-install-acceptance.mjs [--marketplace <dir>] [--previous <git ref>]
 *
 * Proves (Claude Code CLI only; the Claude UI "Customize -> Plugins" flow is NOT exercised here):
 *   1. `praxis` installs its five dependencies; 2. a single role installs praxis-runtime by itself; 3. exactly one
 *   MCP server exists across all plugins; 4. skills are present; 5. the installed Runtime starts, lists the tools and
 *   answers praxis_doctor; 6. Approval Required refuses a write at once, Trusted Client (explicit) allows it, in an
 *   isolated project; 7. an older marketplace revision upgrades in place; 8. no absolute developer path is shipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectOfficialMcp, parseDoctorEnvelope, versionNegotiationModern } from "./official-mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => args.find((arg, i) => args[i - 1] === `--${name}`) ?? args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
// --marketplace may be a local directory, a git URL, or a GitHub shorthand (owner/repo). A URL or shorthand is also what the
// full-set and single-role installs add (exactly what a user types in Claude); a local directory is cloned first.
const marketplaceArg = option("marketplace");
const remoteSource = marketplaceArg && (/^https?:\/\//.test(marketplaceArg) || /^[\w.-]+\/[\w.-]+$/.test(marketplaceArg) ? marketplaceArg : undefined);
const marketplaceSource = remoteSource ? (/^https?:/.test(remoteSource) ? remoteSource : `https://github.com/${remoteSource}.git`) : resolve(marketplaceArg ?? join(here, "../../../praxis-marketplace"));
const previousRef = option("previous");

const proven = [];
const prove = (line) => proven.push(line);
const fail = (message) => {
  console.error(`FAIL marketplace-install: ${message}`);
  process.exit(1);
};
const expect = (condition, message) => {
  if (!condition) fail(message);
};

const work = mkdtempSync(join(tmpdir(), "praxis-install-"));
const run = (configDir, cmd, cmdArgs, cwd) => {
  const result = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const claude = (configDir, ...cmdArgs) => run(configDir, "claude", cmdArgs);
const git = (cwd, ...gitArgs) => {
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${gitArgs.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A git clone, like a user's marketplace add from GitHub (only committed content is visible).
const mk = join(work, "marketplace");
git(work, "clone", "-q", marketplaceSource, mk);
const marketplaceVersion = JSON.parse(readFileSync(join(mk, ".claude-plugin/marketplace.json"), "utf8")).metadata.version;
const names = JSON.parse(readFileSync(join(mk, ".claude-plugin/marketplace.json"), "utf8")).plugins.map((p) => p.name);
expect(["praxis", "praxis-runtime", "praxis-ba", "praxis-architect", "praxis-developer", "praxis-quality"].every((n) => names.includes(n)), `marketplace lists ${names.join(", ")}`);

function listInstalled(configDir) {
  const out = claude(configDir, "plugin", "list").out;
  // A marketplace read in place (local directory) prints "Read from"; a git-sourced one is copied into the plugin cache.
  return [...out.matchAll(/❯ (\S+)@praxis\s+Version: (\S+)(?:\s+Read from: (\S+))?/g)].map((m) => ({
    name: m[1],
    version: m[2],
    path: m[3] ?? join(configDir, "plugins", "cache", "praxis", m[1], m[2]),
  }));
}

// 1 + 3 + 4 + 5 + 6: the full set
const full = join(work, "config-full");
mkdirSync(full);
let r = claude(full, "plugin", "marketplace", "add", remoteSource ?? mk);
expect(r.ok, `marketplace add: ${r.out}`);
r = claude(full, "plugin", "install", "praxis@praxis");
expect(r.ok && /\+ 5 dependencies/.test(r.out), `install praxis: ${r.out}`);
const installed = listInstalled(full);
expect(installed.map((p) => p.name).sort().join() === "praxis,praxis-architect,praxis-ba,praxis-developer,praxis-quality,praxis-runtime", `installed: ${JSON.stringify(installed)}`);
expect(installed.every((p) => p.version === marketplaceVersion), `versions: ${JSON.stringify(installed)}`);
prove(`${remoteSource ? `marketplace added by "${remoteSource}"; ` : ""}installing only "praxis" also installed praxis-runtime, praxis-ba, praxis-architect, praxis-developer, praxis-quality (all ${marketplaceVersion})`);

const mcpConfigs = installed.filter((p) => existsSync(join(p.path, ".mcp.json")));
expect(mcpConfigs.length === 1 && mcpConfigs[0].name === "praxis-runtime", `MCP configs: ${mcpConfigs.map((p) => p.name)}`);
const health = claude(full, "mcp", "list").out;
expect((health.match(/Connected/g) ?? []).length === 1 && /plugin:praxis-runtime:praxis-runtime/.test(health), `mcp list: ${health}`);
prove("exactly one MCP server (praxis-runtime) exists and Claude Code connects to it; no duplicate Runtime");

for (const p of installed.filter((item) => item.name.startsWith("praxis-") && item.name !== "praxis-runtime")) {
  const skills = readdirSync(join(p.path, "skills")).filter((s) => existsSync(join(p.path, "skills", s, "SKILL.md")));
  expect(skills.includes("local-workflow") && skills.includes("present-plan"), `${p.name} skills: ${skills}`);
}
prove("every role plugin ships local-workflow and present-plan skills");

const baInstalled = installed.find((p) => p.name === "praxis-ba");
const baSkills = readdirSync(join(baInstalled.path, "skills")).filter((s) => existsSync(join(baInstalled.path, "skills", s, "SKILL.md")));
const wantedBa = ["capture-cr", "grill-cr", "ba-plan-slice", "shape-requirement", "prepare-wp", "approve-plan", "accept", "ba-lint", "one-pager", "requirements-review", "prototype", "story-plan", "stories-review", "change-request", "resume-work"];
expect(wantedBa.every((s) => baSkills.includes(s)), `installed praxis-ba lacks: ${wantedBa.filter((s) => !baSkills.includes(s)).join(", ")}`);
// every file a BA skill points at exists in the installed plugin
for (const s of baSkills) {
  for (const m of readFileSync(join(baInstalled.path, "skills", s, "SKILL.md"), "utf8").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g)) {
    const rel = m[1].replace(/[.,;:)]+$/, "");
    expect(existsSync(join(baInstalled.path, rel)), `BA skill ${s} points at ${rel}, which the installed plugin does not contain`);
  }
}
prove(`installed praxis-ba carries ${baSkills.length} skills including capture-cr, grill-cr, ba-plan-slice, shape-requirement, prepare-wp, approve-plan, accept and the review skills; every ${"$"}{CLAUDE_PLUGIN_ROOT} path they use exists`);

// Generated build outputs must be in what a user installs (they are build products, not source): BA's validator CLI and every
// role's session bootstrap, runnable with no npm install.
{
  const ba = installed.find((p) => p.name === "praxis-ba");
  expect(existsSync(join(ba.path, "canon-graph/dist/cli.js")) && existsSync(join(ba.path, "bin/praxis-ba.cjs")), "installed praxis-ba lacks canon-graph/dist or bin/praxis-ba.cjs");
  const bare = mkdtempSync(join(work, "canon-"));
  const status = spawnSync(process.execPath, [join(ba.path, "bin/praxis-ba.cjs"), "status", "--repo", bare], { cwd: bare, encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(/VERIFY-OK/.test(status.stdout), `installed BA CLI: ${status.stdout}${status.stderr}`);
  for (const role of ["ba", "architect", "developer", "quality"]) {
    const plugin = installed.find((p) => p.name === `praxis-${role}`);
    const dir = mkdtempSync(join(work, `${role}-`));
    const boot = spawnSync(process.execPath, [join(plugin.path, "tools/session-bootstrap.cjs"), dir], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(boot.status === 0, `installed ${role} session-bootstrap.cjs: ${boot.stderr}`);
  }
  prove("generated build outputs are in the installed plugins: BA canon-graph/dist and the self-contained bin/praxis-ba.cjs (runs, VERIFY-OK), session-bootstrap.cjs of all four roles (run)");
}

const runtime = installed.find((p) => p.name === "praxis-runtime");
const mcpJson = JSON.parse(readFileSync(join(runtime.path, ".mcp.json"), "utf8"));
const server = mcpJson["praxis-runtime"] ?? mcpJson.mcpServers?.["praxis-runtime"];
const bundle = join(runtime.path, "server/praxis-mcp.cjs");
expect(server.command === "node" && existsSync(bundle), "runtime launch config");

async function withRuntime(env, fn) {
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: [bundle, "--role", "runtime"],
    cwd: work,
    env: { ...process.env, ...env },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: 15000,
    clientName: "claude-ai",
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
const callEnvelope = async (session, name, toolArgs) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: toolArgs }));
const project = () => {
  const dir = mkdtempSync(join(work, "project-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "approval-test", version: "0.0.0" }));
  return dir;
};
const stateHome = join(work, "state");

await withRuntime({ PRAXIS_STATE_HOME: stateHome, PRAXIS_APPROVAL_MODE: "" }, async (session) => {
  const tools = (await session.client.listTools()).tools;
  expect(tools.length >= 50 && tools.some((t) => t.name === "praxis_doctor") && tools.some((t) => t.name === "praxis_project_init_apply"), `tools: ${tools.length}`);
  const repo = project();
  const doctor = await callEnvelope(session, "praxis_doctor", { repo });
  expect(doctor.ok && doctor.data.approval.mode === "no-dialog", `doctor: ${JSON.stringify(doctor.data?.approval)}`);
  const started = Date.now();
  const refused = await callEnvelope(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
  expect(refused.code === "APPROVAL_CLIENT_UI_REQUIRED" && !existsSync(join(repo, ".project")) && Date.now() - started < 5000, `default apply: ${JSON.stringify(refused)}`);
  prove(`the installed Runtime starts from the plugin cache, lists ${tools.length} tools and answers praxis_doctor`);
  prove("Approval Required (default, client without a dialog): praxis_project_init_apply is refused at once with APPROVAL_CLIENT_UI_REQUIRED; .project not written");
});

await withRuntime({ PRAXIS_STATE_HOME: stateHome, PRAXIS_APPROVAL_MODE: "trusted-client" }, async (session) => {
  const repo = project();
  const doctor = await callEnvelope(session, "praxis_doctor", { repo });
  expect(doctor.data.approval.mode === "trusted-client", `trusted doctor: ${JSON.stringify(doctor.data?.approval)}`);
  const ok = await callEnvelope(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
  expect(ok.ok && existsSync(join(repo, ".project")) && ok.data.approval?.[0]?.assurance === "trusted-client", `trusted apply: ${JSON.stringify(ok)}`);
  prove("Trusted Client (explicit opt-in): the same call writes .project in the isolated project, labelled trusted-client");
});

// 2: a single role pulls the Runtime by itself
const roleOnly = join(work, "config-role");
mkdirSync(roleOnly);
expect(claude(roleOnly, "plugin", "marketplace", "add", remoteSource ?? mk).ok, "role marketplace add");
r = claude(roleOnly, "plugin", "install", "praxis-quality@praxis");
expect(r.ok && /\+ 1 dependency: praxis-runtime/.test(r.out), `role install: ${r.out}`);
expect(listInstalled(roleOnly).map((p) => p.name).sort().join() === "praxis-quality,praxis-runtime", "role-only set");
prove("installing only praxis-quality installed praxis-runtime as its dependency (and nothing else)");

// 7: upgrade from an older marketplace revision
if (previousRef) {
  const upgrade = join(work, "config-upgrade");
  mkdirSync(upgrade);
  const old = join(work, "marketplace-old");
  git(work, "clone", "-q", mk, old);
  const currentSha = git(old, "rev-parse", "HEAD");
  git(old, "checkout", "-q", previousRef);
  const oldVersion = JSON.parse(readFileSync(join(old, ".claude-plugin/marketplace.json"), "utf8")).metadata.version;
  expect(claude(upgrade, "plugin", "marketplace", "add", old).ok, "upgrade: add old");
  for (const name of ["praxis-ba", "praxis-runtime"]) expect(claude(upgrade, "plugin", "install", `${name}@praxis`).ok, `upgrade: install old ${name}`);
  expect(listInstalled(upgrade).every((p) => p.version === oldVersion), "old versions installed");
  git(old, "checkout", "-q", currentSha);
  expect(claude(upgrade, "plugin", "marketplace", "update", "praxis").ok, "upgrade: marketplace update");
  for (const name of ["praxis-ba", "praxis-runtime"]) {
    r = claude(upgrade, "plugin", "update", `${name}@praxis`);
    expect(r.ok && new RegExp(`updated from ${oldVersion} to ${marketplaceVersion}`).test(r.out), `upgrade ${name}: ${r.out}`);
  }
  prove(`an existing install of ${oldVersion} updates in place to ${marketplaceVersion} (praxis-ba, praxis-runtime)`);
}

// 8: nothing machine-specific or secret in what is shipped
const offenders = [];
const scan = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "release-candidate") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else if (/\.(json|md|mjs|js|cjs|yml|yaml|txt)$/.test(name) && statSync(path).size < 3_000_000) {
      const text = readFileSync(path, "utf8");
      if (/\/Users\/serg\b/.test(text) && !/\/docs\//.test(path)) offenders.push(path.replace(mk, ""));
    }
  }
};
scan(join(mk, "plugins"));
scan(join(mk, ".claude-plugin"));
expect(offenders.length === 0, `developer paths in shipped plugins: ${offenders.slice(0, 5).join(", ")}`);
prove("no /Users/serg path in the shipped plugins or manifests");

rmSync(work, { recursive: true, force: true });
console.log(`PASS marketplace-install (${proven.length} checks, Claude Code CLI)`);
for (const line of proven) console.log(`  ok ${line}`);
console.log("NOT PROVEN: the Claude UI flow (Customize -> Plugins -> Add marketplace); Claude Desktop Chat.");
void dirname;
