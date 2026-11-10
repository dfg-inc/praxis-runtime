#!/usr/bin/env node
/**
 * Compatibility with the released 0.1.0-alpha.49.1: state written by that Runtime is read, continued and audited by this one.
 *
 * 1. The alpha.49.1 bundle (from the git tag) creates a work item, a requirement and a story, and confirms the story through a
 *    scripted client dialog. It also leaves the two journal entries that blamed the user: the agent's confirmation=NO, and a
 *    dialog declined at once.
 * 2. This Runtime, on the same repository and Praxis home: the work item, its story confirmation and its approval record are
 *    unchanged; the workflow continues; praxis_approval_journal finds the two entries, amends them after an approval, and
 *    every alpha.49.1 journal line is byte for byte as it was.
 * 3. Every alpha.49.1 tool is still registered, and every Praxis tool the alpha.49.1 role skills name exists.
 *
 *   node tools/scripts/alpha49-1-compat-acceptance.mjs [--ref v0.1.0-alpha.49.1]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ref = process.argv.includes("--ref") ? process.argv[process.argv.indexOf("--ref") + 1] : "v0.1.0-alpha.49.1";
const proven = [];
const fail = (m) => {
  console.error(`FAIL alpha49-1-compat: ${m}`);
  process.exit(1);
};
const prove = (m) => {
  proven.push(m);
  console.error(`  ok ${proven.length}. ${m}`);
};

const built = spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
if ((built.status ?? 1) !== 0) fail(built.stderr || built.stdout);
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import("./official-mcp-client.mjs");

const work = mkdtempSync(join(tmpdir(), "praxis-compat-"));
const oldDir = join(work, "alpha49.1");
mkdirSync(oldDir);
for (const file of ["praxis-mcp.cjs", "sql-wasm.wasm"]) {
  writeFileSync(join(oldDir, file), execFileSync("git", ["show", `${ref}:plugins/runtime/server/${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
}
const newBundle = join(root, "plugins/runtime/server/praxis-mcp.cjs");
const state = join(work, "state");
const repo = join(work, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "compat", scripts: { test: "node --test" } })}\n`);

const answerAfter = (ms, action, decision) => async () => (await new Promise((r) => setTimeout(r, ms)), { action, ...(decision ? { content: { decision } } : {}) });
async function open(bundle, elicit) {
  return connectOfficialMcp({
    command: process.execPath,
    args: [bundle, "--role", "runtime"],
    cwd: work,
    env: { ...hostedCleanEnv(work), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PRAXIS_SKIP_DOTENV: "1", PRAXIS_STATE_HOME: state, PRAXIS_APPROVAL_MIN_ANSWER_MS: "1000" },
    versionNegotiation: versionNegotiationModern(),
    elicit,
    timeoutMs: 20_000,
    clientName: "praxis-compat",
    clientVersion: "1.0",
  });
}
const call = async (session, name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }));
async function apply(session, command, extra = {}) {
  const preview = await call(session, "praxis_workflow_preview", { repo, command: JSON.stringify(command), ...extra });
  if (!preview.ok) fail(`${command.action} preview: ${preview.code} ${JSON.stringify(preview.errors)}`);
  return call(session, "praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: preview.data.fingerprint, ...extra });
}
const journalFile = () => join(state, "decisions", readdirSync(join(state, "decisions"))[0]);

try {
  // --- 1. alpha.49.1 writes the state ----------------------------------------------------------------------------
  let next = answerAfter(1200, "accept", "approve");
  const old = await open(join(oldDir, "praxis-mcp.cjs"), (p) => next(p));
  let workItemId;
  try {
    const version = (await call(old, "praxis_doctor", { repo })).data.version;
    if (version !== "0.1.0-alpha.49.1") fail(`the old bundle reports ${version}`);
    const opened = await apply(old, { action: "open", mode: "classic", projectId: "compat", title: "Compatibility", request: "r" });
    if (!opened.ok) fail(`alpha.49.1 open: ${opened.code} ${JSON.stringify(opened.errors)}`);
    workItemId = opened.data.workItemId;
    const extra = { workItemId };
    if (!(await apply(old, { action: "add-requirement", id: "REQ-CMP-001", statement: "Old state stays valid.", acceptanceCriteria: ["It loads."] }, extra)).ok) fail("alpha.49.1 add-requirement");
    const story = await apply(old, { action: "add-story", id: "US-CMP-001", requirementIds: ["REQ-CMP-001"], actor: "user", narrative: "As a user, I want old state read, so that nothing is lost.", objective: "Old state stays valid", userValue: "Nothing is lost", happyPath: ["Open it."], acceptanceCriteria: [{ id: "US-CMP-001-AC-01", given: "old state", when: "read", then: "it is the same" }], expectedResults: ["same"], confirmedBehavior: false }, extra);
    if (!story.ok) fail(`alpha.49.1 add-story: ${story.code} ${JSON.stringify(story.errors)}`);
    const inspect = await call(old, "praxis_workflow_inspect", { repo, workItemId, view: "stories" });
    const items = inspect.data.stories ?? inspect.data.items ?? [];
    const s1 = items.find((s) => s.id === "US-CMP-001");
    const confirm = await apply(old, { action: "confirm-story", id: "US-CMP-001", revision: s1?.revision, contentFingerprint: s1?.contentFingerprint }, extra);
    if (!confirm.ok) fail(`alpha.49.1 confirm-story through the dialog: ${confirm.code} ${JSON.stringify(confirm.errors)}`);
    // the two misattributions alpha.49.1 wrote
    const no = await call(old, "praxis_project_init_apply", { repo, confirmation: "NO" });
    if (no.code !== "APPROVAL_REJECTED") fail(`alpha.49.1 confirmation=NO: ${no.code}`);
    next = async () => ({ action: "decline" });
    const declined = await call(old, "praxis_project_init_apply", { repo, confirmation: "YES" });
    if (declined.code !== "APPROVAL_REJECTED") fail(`alpha.49.1 instant decline: ${declined.code}`);
    prove("alpha.49.1 created a work item, a requirement and a story, confirmed the story in a dialog, and journaled confirmation=NO and an instant decline as the user's rejections");
  } finally {
    await old.close();
  }
  const itemFile = join(repo, ".praxis", "workflow", "items", `${workItemId}.json`);
  const itemBefore = readFileSync(itemFile, "utf8");
  const journalBefore = readFileSync(journalFile(), "utf8");
  const oldLines = journalBefore.trim().split("\n").map((l) => JSON.parse(l));
  if (oldLines.some((l) => l.v === 2)) fail("alpha.49.1 wrote journal v2 entries");

  // --- 2. this Runtime continues -------------------------------------------------------------------------------
  let approvals = 0;
  const approveAfterDelay = answerAfter(1200, "accept", "approve");
  const now = await open(newBundle, async (p) => ((approvals += 1), approveAfterDelay(p)));
  try {
    const status = await call(now, "praxis_workflow_status", { repo, workItemId });
    if (!status.ok) fail(`status of the alpha.49.1 work item: ${status.code}`);
    const stories = await call(now, "praxis_workflow_inspect", { repo, workItemId, view: "stories" });
    const story = (stories.data.stories ?? stories.data.items ?? []).find((s) => s.id === "US-CMP-001");
    if (!story?.confirmedBehavior && story?.status !== "confirmed") fail(`the confirmed story is no longer confirmed: ${JSON.stringify(story).slice(0, 300)}`);
    const persisted = JSON.parse(readFileSync(itemFile, "utf8"));
    const record = (persisted.approvals ?? []).find((a) => a.action === "confirm-story");
    if (!record || record.trust !== "independent-human" || record.assurance !== "client-ui") fail(`the alpha.49.1 approval record changed: ${JSON.stringify(record)}`);
    if (readFileSync(itemFile, "utf8") !== itemBefore) fail("reading the alpha.49.1 work item rewrote it");
    prove("this Runtime reads the alpha.49.1 work item unchanged: the story stays confirmed and its approval record (client-ui, independent-human) is untouched");
    const more = await apply(now, { action: "add-requirement", id: "REQ-CMP-002", statement: "And continues.", acceptanceCriteria: ["It continues."] }, { workItemId });
    if (!more.ok) fail(`continuing the alpha.49.1 work item: ${more.code} ${JSON.stringify(more.errors)}`);
    prove("the alpha.49.1 work item continues under this Runtime (a new requirement is recorded)");

    const audit = await call(now, "praxis_approval_journal", { repo });
    const rules = (audit.data.toAmend ?? []).map((f) => f.rule).sort();
    if (JSON.stringify(rules) !== JSON.stringify(["agent-reported-decline", "client-answered-without-dialog"])) fail(`the audit of the alpha.49.1 journal found ${JSON.stringify(rules)}`);
    prove("praxis_approval_journal finds both alpha.49.1 misattributions (agent-reported-decline, client-answered-without-dialog)");
    const amended = await call(now, "praxis_approval_journal", { repo, amend: true, confirmation: "YES" });
    if (!amended.ok || amended.data.appended !== 2 || approvals !== 1) fail(`amend: ${amended.code} appended ${amended.data?.appended}, asked ${approvals}`);
    const journalAfter = readFileSync(journalFile(), "utf8");
    if (!journalAfter.startsWith(journalBefore)) fail("an alpha.49.1 journal line changed");
    const effective = await call(now, "praxis_approval_journal", { repo });
    if (effective.data.byDecision["withdrawn/agent"] !== 1 || effective.data.byDecision["auto-answered/client"] !== 1) fail(`after amending: ${JSON.stringify(effective.data.byDecision)}`);
    prove("after one approval the two corrections are appended; every alpha.49.1 journal line is byte for byte as it was");
  } finally {
    await now.close();
  }

  // --- 3. tools ------------------------------------------------------------------------------------------------
  const list = async (bundle) => {
    const s = await open(bundle);
    try {
      return (await s.client.listTools()).tools;
    } finally {
      await s.close();
    }
  };
  const oldTools = await list(join(oldDir, "praxis-mcp.cjs"));
  const newTools = new Map((await list(newBundle)).map((t) => [t.name, t]));
  const missing = oldTools.filter((t) => !newTools.has(t.name)).map((t) => t.name);
  if (missing.length) fail(`alpha.49.1 tools no longer registered: ${missing.join(", ")}`);
  for (const t of oldTools) {
    const before = Object.keys(t.inputSchema?.properties ?? {});
    const after = Object.keys(newTools.get(t.name).inputSchema?.properties ?? {});
    const lost = before.filter((k) => !after.includes(k));
    if (lost.length) fail(`${t.name} lost arguments ${lost.join(", ")}`);
    const requiredNow = (newTools.get(t.name).inputSchema?.required ?? []).filter((k) => !(t.inputSchema?.required ?? []).includes(k));
    if (requiredNow.length) fail(`${t.name} now requires ${requiredNow.join(", ")}`);
  }
  prove(`all ${oldTools.length} alpha.49.1 tools are registered with every argument they had and no new required one (now ${newTools.size})`);
  const skillTools = new Set();
  for (const roleRepo of ["praxis-ba", "praxis-architect", "praxis-developer", "praxis-quality"]) {
    const dir = resolve(root, "..", roleRepo);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "plugins"], { cwd: dir, encoding: "utf8" }).split("\n").filter((f) => f.endsWith("SKILL.md"));
    for (const file of files) {
      const text = execFileSync("git", ["show", `${ref}:${file}`], { cwd: dir, encoding: "utf8" });
      for (const m of text.matchAll(/\bpraxis_[a-z_]+\b/g)) skillTools.add(m[0]);
    }
  }
  const unknown = [...skillTools].filter((n) => !newTools.has(n) && !n.endsWith("_"));
  if (unknown.length) fail(`alpha.49.1 role skills name tools this Runtime lacks: ${unknown.join(", ")}`);
  prove(`every Praxis tool the alpha.49.1 role skills name (${skillTools.size}) is registered`);
  console.log(`PASS alpha49-1-compat (${proven.length} checks) against ${ref}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
