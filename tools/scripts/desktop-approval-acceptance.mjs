#!/usr/bin/env node
/**
 * Desktop approval acceptance: the packaged Runtime (.mcpb, extracted, over stdio) driven by the official MCP SDK client
 * playing the two Claude Desktop clients exactly as they were measured, with a real Chrome in the user's place:
 *
 *   Code tab  client claude-code, protocol 2026-07-28, declares elicitation, answers the dialog `decline` at once with
 *             nothing on screen (anthropics/claude-code#89858)
 *   Chat      Desktop's extension host: client local-agent-mode-<server> 1.0.0, no elicitation (live doctor and the installed
 *             app bundle, Desktop 4.4212.0)
 *
 * Production defaults are kept (approval page on, PRAXIS_APPROVAL_MIN_ANSWER_MS 1000). The page is opened through
 * PRAXIS_APPROVAL_BROWSER, set to a small script that hands the page to this test, which opens it in Chrome and clicks.
 *
 * Proves: the Code tab's own decline is journaled as the client's answer and never as the user's; the same call asks in the
 * page; Approve there runs exactly the action and Reject runs nothing, each journaled as the user's with the page as
 * evidence; that client is not asked through its dialog again; Chat gets APPROVAL_PENDING without the link and runs after
 * the click; the link's secret is never in a tool result and leaves the address bar after load; a reload keeps working;
 * a client whose dialog really works (answers at a person's pace) still uses its dialog and no page.
 *
 * Does NOT prove: Claude Desktop's own UI (see docs/desktop-approvals.md for the manual run), or that a person clicked.
 *
 *   node tools/scripts/desktop-approval-acceptance.mjs [--chrome <path>] [--evidence <dir>]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv;
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const chromePath = arg("--chrome") ?? process.env.PRAXIS_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chromePath)) {
  console.error(`no Chrome at ${chromePath}; pass --chrome <path> or set PRAXIS_BROWSER_EXECUTABLE`);
  process.exit(2);
}
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
// stands in for the user's browser: receives the short-lived page file Praxis hands to a browser, and keeps a copy
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
async function open({ clientName, clientVersion, elicit, env = {} }) {
  return connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
      PRAXIS_SKIP_DOTENV: "1",
      PRAXIS_STATE_HOME: state,
      // production defaults, on purpose
      PRAXIS_APPROVAL_PAGE: "on",
      PRAXIS_APPROVAL_MIN_ANSWER_MS: "1000",
      PRAXIS_APPROVAL_BROWSER: opener,
      ...env,
    },
    versionNegotiation: versionNegotiationModern(),
    elicit,
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
  return dir;
};
const journal = () => {
  const dir = join(state, "decisions");
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))) : [];
};
const pagesOpened = () => readdirSync(capture).sort();
async function nextPage(count) {
  for (let i = 0; i < 300; i += 1) {
    const files = pagesOpened();
    if (files.length >= count) {
      const html = readFileSync(join(capture, files[count - 1]), "utf8");
      return /url=([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no approval page was opened (expected ${count})`);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const context = await browser.newContext();
async function decide(secretUrl, decision, { reason, shot } = {}) {
  const page = await context.newPage();
  await page.goto(secretUrl);
  await page.waitForSelector("#approve");
  if (shot && evidence) await page.screenshot({ path: join(evidence, `${shot}.png`), fullPage: true });
  const address = page.url();
  if (reason) await page.fill("#reason", reason);
  await page.click(decision === "approve" ? "#approve" : "#reject");
  await page.waitForFunction(() => /Approved\.|Rejected\.|Not recorded/.test(document.getElementById("result").textContent));
  const shown = await page.textContent("#result");
  if (shot && evidence) await page.screenshot({ path: join(evidence, `${shot}-decided.png`), fullPage: true });
  return { page, address, shown };
}

try {
  await scenario("D01", "Code tab: its instant decline is the client's; the page asks the person; Approve runs exactly that", async () => {
    let elicited = 0;
    const session = await open({ clientName: "claude-code", env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, elicit: async () => ((elicited += 1), { action: "decline" }) });
    try {
      const repo = project("code-approve");
      const applying = call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      const secret = await nextPage(1);
      const { page, address, shown } = await decide(secret, "approve", { shot: "code-tab-approval-page" });
      const result = await applying;
      check(elicited === 1, `the client's dialog was asked once (got ${elicited})`);
      check(result.ok, `apply after Approve: ${result.code} ${JSON.stringify(result.errors)}`);
      check(existsSync(join(repo, ".project")), ".project was written");
      check(JSON.stringify(result.data.approval) === JSON.stringify([{ ...result.data.approval[0], channel: "approval-page", assurance: "approval-page" }]), `approval says approval-page: ${JSON.stringify(result.data.approval)}`);
      check(!new URL(address).search, `the secret left the address bar: ${address}`);
      check(/Approved/.test(shown), shown);
      check((await page.textContent("#text")).includes(repo), "the page shows the exact file to be written");
      const mine = journal().filter((r) => r.repository === repo);
      check(JSON.stringify(mine.map((r) => [r.decision, r.decidedBy])) === JSON.stringify([["auto-answered", "client"], ["pending", "nobody"], ["approved", "approval-page"]]), `journal: ${JSON.stringify(mine.map((r) => [r.decision, r.decidedBy]))}`);
      check(!mine.some((r) => r.decision === "rejected"), "the client's decline is not a rejection");
      check(!JSON.stringify(result).includes(new URL(secret).searchParams.get("t")), "the secret is not in the tool result");

      // D02 on the same connection: a second instant decline, then a Reject by the person in the page
      const other = project("code-reject");
      const second = call(session, "praxis_project_init_apply", { repo: other, confirmation: "YES" });
      await decide(await nextPage(2), "reject", { reason: "wrong project", shot: "code-tab-reject" });
      const rejected = await second;
      check(elicited === 2, `one fast answer does not change how the client is asked (asked ${elicited} times)`);
      check(rejected.code === "APPROVAL_REJECTED", `reject: ${rejected.code}`);
      check(rejected.data.decidedBy === "approval-page" && rejected.data.personVerified === false && rejected.data.channel === "approval-page" && rejected.data.reason === "wrong project", JSON.stringify(rejected.data));
      check(!existsSync(join(other, ".project")), "nothing written after Reject");
      const doctor = await call(session, "praxis_doctor", { repo: other });
      check(doctor.data.approval.mode === "approval-page" && doctor.data.approval.observedDialog?.automatic === "decline", `doctor: ${JSON.stringify(doctor.data.approval).slice(0, 300)}`);
      // seen twice: the third action goes to the page without asking the dialog that is known to fail
      const third = project("code-third");
      const thirdCall = call(session, "praxis_project_init_apply", { repo: third, confirmation: "YES" });
      await decide(await nextPage(3), "approve");
      const thirdResult = await thirdCall;
      check(elicited === 2 && thirdResult.ok, `no dialog was attempted for the third action (asked ${elicited} times): ${thirdResult.code}`);
    } finally {
      await session.close();
    }
  });

  await scenario("D03", "Chat: APPROVAL_PENDING without the link; the person approves in the page; the same apply runs it", async () => {
    const session = await open({ clientName: "local-agent-mode-Praxis Runtime", clientVersion: "1.0.0", env: { PRAXIS_APPROVAL_PAGE_WAIT_MS: "1500" } });
    try {
      const doctor = await call(session, "praxis_doctor", { repo: work });
      check(doctor.data.approval.mode === "approval-page", `doctor mode ${doctor.data.approval.mode}`);
      const before = pagesOpened().length;
      const repo = project("chat-approve");
      const first = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(first.code === "APPROVAL_PENDING", `first apply: ${first.code}`);
      check(first.data.approvalPage?.requestId && first.data.decidedBy === "nobody", JSON.stringify(first.data));
      const secret = await nextPage(before + 1);
      check(!JSON.stringify(first).includes(new URL(secret).searchParams.get("t")), "the secret is not in the tool result");
      const again = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(again.code === "APPROVAL_PENDING" && pagesOpened().length === before + 1, "a second apply while the page is open opens no second page");
      // while it is undecided: a reload of the tab Praxis opened keeps working; the address without its secret opens
      // nothing in another tab
      const tab = await context.newPage();
      await tab.goto(secret);
      await tab.waitForSelector("#approve");
      await tab.reload();
      await tab.waitForSelector("#approve", { timeout: 5_000 });
      // the buttons stay disabled for the earliest-decision time after the first load (3 s), then the reloaded tab can decide
      check(await tab.isDisabled("#approve"), "the reloaded tab cannot decide before the earliest-decision time");
      await tab.waitForFunction(() => !document.getElementById("approve").disabled, null, { timeout: 8_000 });
      check(!(await tab.isDisabled("#approve")), "after a reload the opened tab can still decide");
      // another browser (no cookie from the first load): the address without its secret opens nothing, and the link
      // itself, used a second time, opens nothing either and warns
      const elsewhere = await browser.newContext();
      const stranger = await elsewhere.newPage();
      const bare = new URL(secret);
      bare.search = "";
      await stranger.goto(bare.toString());
      check(/does not open here/.test(await stranger.textContent("body")), "the address without its secret opens nothing in another browser");
      await stranger.goto(secret);
      check(/already opened somewhere else/.test(await stranger.textContent("body")), "the single-use link, used again in another browser, opens nothing and warns");
      await elsewhere.close();
      await tab.close();
      const bareAgain = new URL(secret);
      bareAgain.search = "";
      // the link was used twice (by the other browser): Praxis cannot tell which opener is the person, so Approve is refused
      const refused = await decide(bareAgain.toString(), "approve", { shot: "chat-approval-page-reused" });
      check(/Not recorded: .*used more than once/.test(refused.shown), `approve after the link was used twice: ${refused.shown}`);
      const rejected = await decide(bareAgain.toString(), "reject");
      check(/Rejected/.test(rejected.shown), `reject after the link was used twice: ${rejected.shown}`);
      check((await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" })).code === "APPROVAL_REJECTED", "that rejection is reported");
      // applying again opens a fresh page, and its Approve runs the action
      const pagesBefore = pagesOpened().length;
      const again2 = call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      await decide(await nextPage(pagesBefore + 1), "approve", { shot: "chat-approval-page" });
      // the call that opened the page waited 1.5 s and reported it pending; the next one takes the decision
      check((await again2).code === "APPROVAL_PENDING", "the call that opened the fresh page reported it pending");
      const applied = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(applied.ok, `apply after Approve: ${applied.code} ${JSON.stringify(applied.errors)}`);
      check(existsSync(join(repo, ".project")), ".project was written");
      check(journal().filter((r) => r.repository === repo && r.decision === "approved").length === 1, "one approval, used once");
    } finally {
      await session.close();
    }
  });

  await scenario("D04", "a client whose dialog works at a person's pace keeps its dialog: no page is opened", async () => {
    const session = await open({ clientName: "claude-code", env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, elicit: async () => (await new Promise((r) => setTimeout(r, 1300)), { action: "accept", content: { decision: "approve" } }) });
    try {
      const before = pagesOpened().length;
      const repo = project("cli-dialog");
      const result = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
      check(result.ok, `${result.code} ${JSON.stringify(result.errors)}`);
      check(result.data.approval?.[0]?.assurance === "client-ui", JSON.stringify(result.data.approval));
      check(pagesOpened().length === before, "no approval page was opened");
      const mine = journal().filter((r) => r.repository === repo);
      check(mine.length === 1 && mine[0].decision === "approved" && mine[0].decidedBy === "client-dialog" && mine[0].evidence.latencyMs >= 1000, JSON.stringify(mine));
    } finally {
      await session.close();
    }
  });
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => r.status !== "PASS");
const checks = results.reduce((n, r) => n + r.checks, 0);
if (evidence) writeFileSync(join(evidence, "desktop-approval-acceptance.json"), `${JSON.stringify({ version, chrome: chromePath, results }, null, 2)}\n`);
if (failed.length) {
  console.error(`FAIL desktop-approval: ${failed.length} of ${results.length} scenarios`);
  process.exit(1);
}
console.log(`PASS desktop-approval (${results.length} scenarios, ${checks} checks)`);
console.log("NOT PROVEN: Claude Desktop's own windows; that a person (not this script) clicked.");
