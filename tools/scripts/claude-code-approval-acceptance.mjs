#!/usr/bin/env node
/**
 * Approval UX against the REAL Claude Code CLI as the MCP client (not a scripted SDK client).
 *
 *   npm run accept:claude-code-approval        (uses your Claude Code login: it makes a few short model calls)
 *
 * Claude Code runs headless here, so a hook stands in for the person: Claude Code's `Elicitation` hook event answers the
 * dialog as scripted (approve / reject / decline / cancel) and records what Claude Code was asked. That proves the real
 * client declares form elicitation, delivers Praxis' dialog (including the exact action) and honours every answer. It does
 * NOT prove that a person answered, and it says nothing about Claude Desktop (see desktop-install/INSTALL.md).
 * Results are judged from the filesystem and Praxis' decision journal, never from what the model says.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fail = (message) => {
  console.error(`FAIL claude-code-approval: ${message}`);
  process.exit(1);
};
const proven = [];
const prove = (line) => {
  proven.push(line);
  console.error(`  ok ${proven.length}. ${line}`);
};

function claudeBinary() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  if (which) return which;
  const base = join(homedir(), "Library/Application Support/Claude/claude-code");
  if (existsSync(base)) {
    for (const version of readdirSync(base).sort().reverse()) {
      for (const hash of readdirSync(join(base, version))) {
        const candidate = join(base, version, hash, "claude.app/Contents/MacOS/claude");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}
const claude = claudeBinary();
if (!claude) {
  console.log("SKIP claude-code-approval: no Claude Code binary found (set CLAUDE_BIN)");
  process.exit(0);
}

const bundle = join(root, "plugins/runtime/server/praxis-mcp.cjs");
if (!existsSync(bundle)) fail(`missing ${bundle}`);
const work = mkdtempSync(join(tmpdir(), "praxis-cc-"));
const home = join(work, "home");
mkdirSync(home);
const hook = join(work, "elicit-hook.sh");
writeFileSync(hook, `#!/bin/sh
cat > "${work}/last-elicitation.json"
case "$ANSWER" in
  approve) echo '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"decision":"approve"}}}' ;;
  reject) echo '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"decision":"reject"}}}' ;;
  decline) echo '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}' ;;
  cancel) echo '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"cancel"}}' ;;
esac
`);
chmodSync(hook, 0o755);
writeFileSync(join(work, "settings.json"), JSON.stringify({ hooks: { Elicitation: [{ hooks: [{ type: "command", command: hook }] }] } }));
writeFileSync(join(work, "mcp.json"), JSON.stringify({ mcpServers: { praxis: { command: process.execPath, args: [bundle, "--role", "runtime"], env: { PRAXIS_STATE_HOME: join(work, "state") } } } }));

function run(prompt, { answer, tools, cwd, withHook = true }) {
  const args = ["-p", prompt, "--mcp-config", join(work, "mcp.json"), "--strict-mcp-config", "--allowedTools", tools, "--max-turns", "5", "--output-format", "text"];
  if (withHook) args.push("--settings", join(work, "settings.json"));
  const result = spawnSync(claude, args, { cwd, encoding: "utf8", input: "", timeout: 240_000, env: { ...process.env, ANSWER: answer ?? "", PRAXIS_STATE_HOME: join(work, "state") } });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
const project = (name) => {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, scripts: { test: "node --test" } })}\n`);
  return dir;
};
const applyPrompt = (dir) => `Call the tool mcp__praxis__praxis_project_init_apply exactly once with repo ${dir} and confirmation YES. Do not call any other tool. Reply with one short line.`;
const journal = () => {
  const dir = join(work, "state", "decisions");
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))) : [];
};

try {
  // 1. what the real client declares, reported by the doctor
  const doc = project("doctor");
  const out = run(`Call mcp__praxis__praxis_doctor with repo ${doc}. Reply with ONLY a JSON object {"mode":<data.approval.mode>,"client":<data.approval.client>}.`, { tools: "mcp__praxis__praxis_doctor", cwd: doc, withHook: false });
  const json = out.match(/\{[\s\S]*\}/)?.[0];
  let report;
  try { report = JSON.parse(json); } catch { fail(`doctor reply was not JSON: ${out.slice(0, 400)}`); }
  if (report.mode !== "client-ui" || report.client?.name !== "claude-code" || report.client?.elicitation?.form !== true) fail(`Claude Code did not declare form elicitation: ${JSON.stringify(report)}`);
  prove(`Claude Code ${report.client.version} declares form elicitation (protocol ${report.client.protocolVersion}, flow ${report.client.flow}); Praxis reports client-ui`);

  // 2. Reject / Decline / Cancel run nothing; the dialog showed the exact action
  for (const answer of ["reject", "decline", "cancel"]) {
    const dir = project(`no-${answer}`);
    run(applyPrompt(dir), { answer, tools: "mcp__praxis__praxis_project_init_apply", cwd: dir });
    if (existsSync(join(dir, ".project"))) fail(`${answer} still wrote .project`);
    const asked = JSON.parse(readFileSync(join(work, "last-elicitation.json"), "utf8"));
    if (asked.mode !== "form" || !asked.message.includes(`Creates ${dir}`) || !/requirementsFormat/.test(asked.message)) fail(`${answer}: Claude Code was not shown the exact action: ${asked.message}`);
    prove(`${answer}: nothing written; Claude Code was shown the exact file to be written`);
  }
  // 3. Approve runs exactly that
  const ok = project("approve");
  run(applyPrompt(ok), { answer: "approve", tools: "mcp__praxis__praxis_project_init_apply", cwd: ok });
  if (!existsSync(join(ok, ".project"))) fail("approve did not write .project");
  prove("approve: .project written");
  // 4. Headless with no hook: nobody to ask, so nothing runs
  const none = project("nobody");
  run(applyPrompt(none), { tools: "mcp__praxis__praxis_project_init_apply", cwd: none, withHook: false });
  if (existsSync(join(none, ".project"))) fail("a headless run with nobody to answer wrote .project");
  prove("no answer available (headless, no hook): nothing written");
  // 5. the journal is outside the repositories and records the decisions
  const rows = journal();
  const decisions = rows.map((r) => r.decision);
  for (const want of ["rejected", "approved"]) if (!decisions.includes(want)) fail(`journal lacks ${want}: ${JSON.stringify(decisions)}`);
  if ([project("x")].some((d) => existsSync(join(d, ".praxis", "approvals")))) fail("a journal appeared inside a repository");
  prove(`decisions journaled outside the repositories (${decisions.join(", ")})`);
  console.log(`PASS claude-code-approval (${proven.length} checks) with ${claude}`);
  for (const line of proven) console.log(`  ok ${line}`);
  console.log("NOT PROVEN: that a person answered (an Elicitation hook answered); Claude Desktop behaviour.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
