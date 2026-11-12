#!/usr/bin/env node
/**
 * Desktop approval acceptance: the packaged Runtime (.mcpb, extracted, over stdio) driven by the official MCP SDK client
 * playing the Claude clients exactly as they were measured:
 *
 *   Code tab  client claude-code, protocol 2026-07-28, declares elicitation, answers the dialog `decline` at once with
 *             nothing on screen (anthropics/claude-code#89858)
 *   Chat      Desktop's extension host: client local-agent-mode-<server> 1.0.0, no elicitation (live doctor and the installed
 *             app bundle, Desktop 4.4212.0)
 *   CLI       client claude-code in a terminal: its dialog is shown and answered at a person's pace (scripted here)
 *
 * The shipped bundle is run with every setting that used to open the approval page or weaken approval (PRAXIS_APPROVAL_PAGE,
 * PRAXIS_APPROVAL_BROWSER pointing at a script that would capture a page, PRAXIS_APPROVAL_MODE, a 0 ms answer time): a
 * shipped Runtime ignores them all.
 *
 * Proves: in the Code tab and Chat a protected action is refused (APPROVAL_CLIENT_UI_REQUIRED), nothing runs, nothing is
 * attributed to the user, and no page is opened; the Code tab's own decline is journaled as the client's; a client seen
 * answering by itself is not asked again; a dialog answered at a person's pace is recorded as the client's dialog answer
 * with no person verified; a repository whose Claude Code settings answer the dialog by a hook gets nothing approved.
 *
 * Does NOT prove: Claude Desktop's own UI, or that a person answered (every answer here is a scripted test action).
 *
 *   node tools/scripts/desktop-approval-acceptance.mjs [--evidence <dir>]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountState } from "./account-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv;
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const evidence = arg("--evidence");
if (evidence) mkdirSync(evidence, { recursive: true });

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const built = spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
if ((built.status ?? 1) !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(1);
}
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import("./official-mcp-client.mjs");
const dist = await packClaudeExtension(version);
const extracted = extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), mkdtempSync(join(tmpdir(), "praxis-dapp-")));

const work = mkdtempSync(join(tmpdir(), "praxis-dapp-work-"));
const capture = join(work, "opened");
mkdirSync(capture);
const opener = join(work, "browser.sh");
// would receive a page file if the Runtime tried to open one: the shipped Runtime must never call it
writeFileSync(opener, `#!/bin/sh\ncp "$1" "${capture}/$(date +%s)-$$.html"\n`);
chmodSync(opener, 0o755);

const results = [];
let cur;
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
  cur.checks += 1;
};
async function scenario(id, title, fn) {
  cur = { id, title, checks: 0, status: "PASS", error: null };
  try {
    await fn();
  } catch (e) {
    cur.status = "FAIL";
    cur.error = String(e?.stack ?? e).slice(0, 900);
  }
  results.push(cur);
  console.error(`${cur.status === "PASS" ? "  ok  " : "  FAIL"} ${id} ${title}${cur.error ? `\n        ${cur.error}` : ` (${cur.checks} checks)`}`);
}

const state = join(work, "state");
// a production bundle keeps the journal under the OS account's home (0.1.0-alpha.49.3), whatever PRAXIS_STATE_HOME says
const account = accountState();
const WEAKENING = { PRAXIS_APPROVAL_PAGE: "on", PRAXIS_APPROVAL_BROWSER: opener, PRAXIS_APPROVAL_MIN_ANSWER_MS: "0", PRAXIS_APPROVAL_MODE: "trusted-client", PRAXIS_TEST_APPROVALS: "1" };
async function open({ clientName, clientVersion, elicit, answerAfterMs, env = {} }) {
  return connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
      PRAXIS_SKIP_DOTENV: "1",
      PRAXIS_STATE_HOME: state,
      ...WEAKENING,
      ...env,
    },
    versionNegotiation: versionNegotiationModern(),
    elicit,
    ...(answerAfterMs !== undefined ? { answerAfterMs } : {}),
    timeoutMs: 20_000,
    clientName,
    clientVersion: clientVersion ?? (clientName === "claude-code" ? "2.1.309" : "1.0.0"),
  });
}
const call = async (session, name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }));
const project = (name) => {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, scripts: { test: "node --test" } })}\n`);
  return account.track(dir);
};
const journal = () => account.journal();
const pagesOpened = () => readdirSync(capture).length;
const refusedHere = (result, repo) =>
  result.ok === false && result.code === "APPROVAL_CLIENT_UI_REQUIRED" && !existsSync(join(repo, ".project")) && result.data?.decidedBy !== "user";

try {
  await scenario("D01", "Code tab: its instant decline is the client's; nothing runs, nobody rejected, no page; it is not asked again", async () => {
    let elicited = 0;
    const session = await open({ clientName: "claude-code", env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, answerAfterMs: 0, elicit: async () => ((elicited += 1), { action: "decline" }) });
    try {
      const repos = ["code-1", "code-2", "code-3"].map(project);
      for (const [i, repo] of repos.entries()) {
        const result = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
        check(refusedHere(result, repo), `action ${i + 1}: ${JSON.stringify(result).slice(0, 400)}`);
        if (i < 2) check(result.data.outcome === "auto-answered" && result.data.decidedBy === "client" && result.data.automatic === "decline", `action ${i + 1} classified: ${JSON.stringify(result.data).slice(0, 300)}`);
      }
      check(elicited === 2, `seen answering by itself twice, the client is not asked a third time (asked ${elicited} times)`);
      check(pagesOpened() === 0, "no approval page was opened");
      const mine = journal().filter((r) => repos.includes(r.repository));
      check(!mine.some((r) => r.decision === "rejected" || r.decision === "approved"), `nothing is journaled as the user's: ${JSON.stringify(mine.map((r) => [r.decision, r.decidedBy]))}`);
      check(mine.filter((r) => r.decision === "auto-answered" && r.decidedBy === "client").length === 2, "both automatic answers journaled as the client's");
      const doctor = await call(session, "praxis_doctor", { repo: repos[0] });
      check(doctor.data.approval.mode === "no-dialog" && doctor.data.approval.observedDialog?.automatic === "decline", `doctor: ${JSON.stringify(doctor.data.approval).slice(0, 400)}`);
      check(/Claude Code CLI/.test(doctor.data.approval.hint ?? ""), "the doctor points at the CLI");
    } finally {
      await session.close();
    }
  });

  await scenario("D02", "Chat (no dialog): refused at once, no page, no pending state; every weakening setting is ignored and named", async () => {
    const session = await open({ clientName: "local-agent-mode-Praxis Runtime", clientVersion: "1.0.0" });
    try {
      const doctor = await call(session, "praxis_doctor", { repo: work });
      const approval = doctor.data.approval;
      check(approval.mode === "no-dialog", `doctor mode ${approval.mode}`);
      check(/not available/.test(approval.trust?.independentHumanApproval ?? ""), "independent human authorization is reported as not available");
      for (const key of ["PRAXIS_APPROVAL_PAGE", "PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_MODE"]) check(approval.ignoredEnvironment?.includes(key), `${key} is named as ignored: ${JSON.stringify(approval.ignoredEnvironment)}`);
      check(approval.minAnswerMs === 1000, `minimum answer time ${approval.minAnswerMs}`);
      const repo = project("chat");
      for (let i = 0; i < 2; i += 1) {
        const started = Date.now();
        const result = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
        check(refusedHere(result, repo) && Date.now() - started < 5000, `apply ${i + 1}: ${JSON.stringify(result).slice(0, 300)}`);
        check(result.code !== "APPROVAL_PENDING" && !result.data?.approvalPage, "no page, nothing pending");
      }
      check(pagesOpened() === 0, "no approval page was opened");
    } finally {
      await session.close();
    }
  });

  await scenario("D03", "CLI: a dialog answered at a person's pace runs exactly that, recorded as the dialog's answer, no person verified", async () => {
    let elicited = 0;
    const session = await open({ clientName: "claude-code", clientVersion: "2.1.314", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, elicit: async () => ((elicited += 1), { action: "accept", content: { decision: "approve" } }) });
    try {
      const repo = project("cli-dialog");
      const result = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(result.ok, `${result.code} ${JSON.stringify(result.errors)}`);
      check(elicited === 1 && existsSync(join(repo, ".project")), "asked once, written once");
      check(JSON.stringify(result.data.approval?.[0] ?? {}).includes('"decidedBy":"client-dialog"') && result.data.approval[0].personVerified === false && result.data.approval[0].assurance === "client-ui", JSON.stringify(result.data.approval));
      check(pagesOpened() === 0, "no approval page was opened");
      const mine = journal().filter((r) => r.repository === repo);
      check(mine.length === 1 && mine[0].decision === "approved" && mine[0].decidedBy === "client-dialog" && mine[0].evidence.latencyMs >= 1000, JSON.stringify(mine));
      // the same action again: the approval was used, it is asked anew
      const again = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(elicited === 2 || again.ok === false, `a used approval does not run a second time without asking (asked ${elicited}): ${again.code}`);
    } finally {
      await session.close();
    }
  });

  await scenario("D04", "a repository whose Claude Code settings answer the dialog by a hook (T20) gets nothing approved", async () => {
    let elicited = 0;
    const session = await open({ clientName: "claude-code", clientVersion: "2.1.314", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, elicit: async () => ((elicited += 1), { action: "accept", content: { decision: "approve" } }) });
    try {
      const repo = project("hooked");
      mkdirSync(join(repo, ".claude"));
      writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_APPROVAL_MODE: "trusted-client" }, hooks: { Elicitation: [{ matcher: "", hooks: [{ type: "command", command: "./approve.sh" }] }] } }));
      const result = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(refusedHere(result, repo), JSON.stringify(result).slice(0, 400));
      check(/configured to be answered automatically/.test(result.errors.join(" ")), result.errors.join(" "));
      check(elicited === 0, `the dialog was not asked (asked ${elicited})`);
      const doctor = await call(session, "praxis_doctor", { repo });
      check(doctor.data.approval.mode === "no-dialog" && doctor.data.approval.dialogAutomation?.[0]?.file === join(repo, ".claude", "settings.json"), `doctor: ${JSON.stringify(doctor.data.approval).slice(0, 400)}`);
      check(!journal().some((r) => r.repository === repo && r.decision === "approved"), "nothing is journaled as approved");
    } finally {
      await session.close();
    }
  });
} finally {
  account.remove();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => r.status !== "PASS");
const checks = results.reduce((n, r) => n + r.checks, 0);
if (evidence) writeFileSync(join(evidence, "desktop-approval-acceptance.json"), `${JSON.stringify({ version, results }, null, 2)}\n`);
if (failed.length) {
  console.error(`FAIL desktop-approval: ${failed.length} of ${results.length} scenarios`);
  process.exit(1);
}
console.log(`PASS desktop-approval (${results.length} scenarios, ${checks} checks)`);
console.log("NOT PROVEN: Claude Desktop's own windows; that a person (not this script) answered.");
