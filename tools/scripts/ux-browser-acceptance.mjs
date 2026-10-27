#!/usr/bin/env node
/**
 * Real-browser acceptance of the four HTML reviews. AUTOMATED: the browser is a real Chrome driven by Playwright; the
 * "user" is the script clicking and typing. This is not a manual user acceptance and says nothing about Claude Desktop or
 * Claude Code rendering. The Runtime is the packaged MCPB over stdio, the work item is the real on-disk state.
 *
 * Checks, per review: controls work (radios, checkboxes, inputs, selects), edits of one REQ / AC / story, nothing is
 * written before Save, Save updates the canonical state, a reopened page shows the saved state, links between REQ, AC,
 * prototype, plan and stories are consistent, HTML in content does not execute, odd paths and tokens do not write.
 * Usage: node tools/scripts/ux-browser-acceptance.mjs [--chrome <path>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const chromePath = process.argv.includes("--chrome") ? process.argv[process.argv.indexOf("--chrome") + 1] : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chromePath)) {
  console.error(`no Chrome at ${chromePath}; pass --chrome <path>`);
  process.exit(2);
}
const built = spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
if ((built.status ?? 1) !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(1);
}
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationLegacy } = await import("./official-mcp-client.mjs");
const dist = await packClaudeExtension(version);
const extracted = extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), mkdtempSync(join(tmpdir(), "praxis-br-")));

const results = [];
let cur;
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
  cur.checks += 1;
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
async function scenario(id, title, fn) {
  cur = { id, title, checks: 0, status: "PASS", error: null };
  try {
    await fn();
  } catch (e) {
    cur.status = "FAIL";
    cur.error = String(e.message ?? e).slice(0, 700);
  }
  results.push(cur);
  console.error(`${cur.status === "PASS" ? "  ok  " : "  FAIL"} ${id} ${title}${cur.error ? `\n        ${cur.error}` : ` (${cur.checks} checks)`}`);
}

async function open(elicit) {
  return connectOfficialMcp({ command: process.execPath, args: extracted.args, cwd: extracted.dest, env: { ...hostedCleanEnv(extracted.dest), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1", PRAXIS_TEST_REVIEW_NO_BROWSER: "1" }, versionNegotiation: versionNegotiationLegacy(), elicit, timeoutMs: 20_000, clientVersion: version });
}
const call = async (s, name, args) => parseDoctorEnvelope(await s.client.callTool({ name, arguments: args })) ?? { ok: false, code: "NO_ENVELOPE" };
const approve = async () => ({ action: "accept", content: { decision: "approve" } });

const agent = await open(approve);
const repo = mkdtempSync(join(tmpdir(), "praxis-br-repo-"));
const stateOf = (id) => JSON.parse(readFileSync(join(repo, ".praxis", "workflow", "items", `${id}.json`), "utf8"));
async function must(command, wi) {
  const extra = wi ? { workItemId: wi } : {};
  const p = await call(agent, "praxis_workflow_preview", { repo, command: JSON.stringify(command), ...extra });
  if (!p.ok) throw new Error(`${command.action} preview: ${p.code} ${JSON.stringify(p.errors)}`);
  const a = await call(agent, "praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...extra });
  if (!a.ok) throw new Error(`${command.action}: ${a.code} ${JSON.stringify(a.errors)}`);
  return a;
}
const XSS = "<img src=x onerror=\"window.__xss=1\"><script>window.__xss=2</script>";
const wi = (await must({ action: "open", projectId: "orders", title: "Order list", request: "Managers manage orders", mode: "guided" })).data.workItemId;
await must({ action: "add-requirement", id: "REQ-ORD-001", statement: `Managers can view and search orders ${XSS}`, acceptanceCriteria: ["The list shows all orders", "A manager can search by number", `Edit status ${XSS}`] }, wi);
await must({ action: "add-requirement", id: "REQ-ORD-002", statement: "Managers can export orders", acceptanceCriteria: ["Export has a header row"] }, wi);

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const linkOf = async (view, workItemId = wi) => {
  const r = await call(agent, "praxis_review_render", { repo, view, workItemId });
  if (!r.ok) throw new Error(`render ${view}: ${JSON.stringify(r.errors)}`);
  return { ...r.data, secret: readFileSync(join(dirname(r.data.file), `${view}.url`), "utf8"), offline: r.data.file };
};
async function page(urlOrFile) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  const dialogs = [];
  p.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  p.on("pageerror", (e) => (p.errors ??= []).push(String(e)));
  await p.goto(urlOrFile);
  p.dialogs = dialogs;
  return p;
}
/** Setup only: the user's Save as an HTTP post (the browser drives the stage under test). */
async function httpSave(view, workItemId, payload) {
  const l = await linkOf(view, workItemId);
  const html = await (await fetch(l.secret)).text();
  const data = JSON.parse(html.match(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/)[1]);
  const r = await fetch(l.secret.split("?")[0] + "/submit", { method: "POST", headers: { "content-type": "application/json", origin: new URL(l.secret).origin, "x-praxis-review-token": data.token }, body: JSON.stringify({ contract: "praxis.review.submission", version: 1, reviewId: data.reviewId, view, workItemId, baseFingerprint: data.baseFingerprint, baseStamp: data.baseStamp, ...payload }) });
  if (r.status !== 200) throw new Error("setup save " + view + ": " + r.status);
  return r.json();
}
async function newGuided(title) {
  const id = (await must({ action: "open", projectId: "orders", title, request: title, mode: "guided" })).data.workItemId;
  await must({ action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view and search orders", acceptanceCriteria: ["The list shows all orders", "A manager can search by number", "A manager can edit a status", "A viewer cannot edit"] }, id);
  await must({ action: "add-requirement", id: "REQ-ORD-002", statement: "Managers can export orders", acceptanceCriteria: ["Export has a header row"] }, id);
  await httpSave("requirements", id, { requirements: { requirements: [], acceptAll: true } });
  await must({ action: "advance-phase", to: "requirements_review" }, id);
  await must({ action: "advance-phase", to: "prototype" }, id);
  return id;
}
let wi3;
let wi4;
const toast = (p) => p.locator("#toast").innerText();

await scenario("B01", "Requirements review in Chrome: controls, point edits, no write before Save, Save writes, reopen shows the saved state", async () => {
  const link = await linkOf("requirements");
  const p = await page(link.secret);
  check(!(await p.evaluate(() => window.__xss)), "HTML in a requirement must not execute");
  check((await p.locator('[data-req="REQ-ORD-001"] [data-f=statement]').inputValue()).includes("<img src=x"), "the HTML is shown as text in the editable field");
  const before = readFileSync(join(repo, ".praxis", "workflow", "items", `${wi}.json`), "utf8");
  await p.locator('[data-ac="REQ-ORD-001-AC-01"] input[value=accepted]').check();
  await p.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=rejected]').check();
  await p.locator('[data-ac="REQ-ORD-001-AC-02"] [data-f=ac-comment]').fill("also by phone");
  await p.locator('[data-ac="REQ-ORD-001-AC-03"] [data-f=remove]').check();
  await p.locator('[data-req="REQ-ORD-001"] [data-f=add-ac]').fill("Filtering by status works");
  await p.locator('[data-req="REQ-ORD-001"] [data-f=statement]').fill("Managers can view, search and filter orders");
  await p.locator('[data-req="REQ-ORD-002"] [data-f=scope]').selectOption("deferred");
  eq(readFileSync(join(repo, ".praxis", "workflow", "items", `${wi}.json`), "utf8"), before, "nothing is written before Save");
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  const s = stateOf(wi);
  const r1 = s.requirements.find((r) => r.id === "REQ-ORD-001");
  eq(r1.statement, "Managers can view, search and filter orders", "statement edited by id");
  eq(r1.revision, 2, "revision");
  eq(r1.acceptanceCriteria.map((c) => c.review.status), ["accepted", "rejected", "pending"], "marks: AC-03 removed, the added one pending");
  eq(r1.acceptanceCriteria[2].statement, "Filtering by status works", "criterion added");
  eq(r1.acceptanceCriteria[1].review.comment, "also by phone", "comment");
  eq(s.requirements.find((r) => r.id === "REQ-ORD-002").scope, "deferred", "scope");
  check(s.requirements.every((r) => r.acceptanceCriteria.every((c) => c.review.via === undefined || c.review.via === "html-review")), "recorded as the page's own channel");
  // reopen: a fresh page load shows the saved state
  const link2 = await linkOf("requirements");
  const q = await page(link2.secret);
  eq(await q.locator('[data-ac="REQ-ORD-001-AC-01"] input[value=accepted]').isChecked(), true, "accepted mark persists");
  eq(await q.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=rejected]').isChecked(), true, "rejected mark persists");
  eq(await q.locator('[data-ac="REQ-ORD-001-AC-02"] [data-f=ac-comment]').inputValue(), "also by phone", "comment persists");
  eq(await q.locator('[data-req="REQ-ORD-002"] [data-f=scope]').inputValue(), "deferred", "scope persists");
  eq(await q.locator('[data-req="REQ-ORD-001"] [data-ac]').count(), 3, "AC-03 is gone");
  // accept the rest through the page, review completes
  await q.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=accepted]').check();
  await q.locator('[data-ac="REQ-ORD-001-AC-04"] input[value=accepted]').check();
  await q.locator("#btn-save").click();
  await q.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  check(stateOf(wi).phaseAcceptance.requirements_review?.via === "html-review", "marking every criterion accepted records the review as accepted by the user");
  // a stale page: edit elsewhere, save the old page
  await must({ action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "Changed by someone else" }] }, wi);
  await p.locator('[data-req="REQ-ORD-001"] [data-f=statement]').fill("My stale edit");
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /conflict/i.test(document.querySelector("#toast").textContent));
  eq(stateOf(wi).requirements.find((r) => r.id === "REQ-ORD-001").statement, "Changed by someone else", "a stale edit does not overwrite");
  check(!(await q.evaluate(() => window.__xss)) && !(p.errors ?? []).length, "no script ran or failed");
});

await scenario("B02", "Offline copy and arbitrary requests do not write; handed-over decisions need the dialog", async () => {
  const link = await linkOf("requirements");
  const origin = new URL(link.secret).origin;
  const before = readFileSync(join(repo, ".praxis", "workflow", "items", `${wi}.json`), "utf8");
  const off = await page(`file://${link.offline}`);
  await off.locator('[data-req="REQ-ORD-002"] [data-f=comment]').fill("offline comment");
  await off.locator("#btn-save").click();
  check(/No live connection/.test(await toast(off)), "an offline page says it could not save");
  const decisions = await off.locator("#out textarea").inputValue();
  check(JSON.parse(decisions).contract === "praxis.review.submission", "decisions are produced for hand-over");
  eq(readFileSync(join(repo, ".praxis", "workflow", "items", `${wi}.json`), "utf8"), before, "the offline page wrote nothing");
  const noDialog = await open(undefined);
  const refused = await call(noDialog, "praxis_review_apply", { repo, workItemId: wi, submission: JSON.stringify({ ...JSON.parse(decisions), requirements: { requirements: [{ id: "REQ-ORD-002", revision: stateOf(wi).requirements.find((r) => r.id === "REQ-ORD-002").revision, criteria: [{ id: "REQ-ORD-002-AC-01", revision: 1, status: "accepted" }], addCriteria: [], removeCriteria: [] }], acceptAll: false } }), confirmation: "YES" });
  check(!refused.ok && refused.code === "APPROVAL_CLIENT_UI_REQUIRED", `no dialog: ${refused.code}`);
  eq(readFileSync(join(repo, ".praxis", "workflow", "items", `${wi}.json`), "utf8"), before, "nothing recorded without the dialog");
  await noDialog.close();
  // odd requests against the live server
  const base = link.secret.split("?")[0];
  for (const [path, method] of [["/r/../../../etc/passwd", "GET"], ["/r/aaaaaaaaaaaaaaaa", "GET"], ["/r/aaaaaaaaaaaaaaaa/submit", "POST"], ["/", "GET"], ["/../state.json", "GET"]]) {
    const r = await fetch(new URL(path, origin), { method, headers: { origin, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    check([403, 404, 405].includes(r.status), `${method} ${path} -> ${r.status}`);
  }
  const page2 = await page(link.secret);
  const res = await page2.evaluate(async ({ base }) => {
    const data = JSON.parse(document.getElementById("praxis-data").textContent);
    const body = { contract: "praxis.review.submission", version: 1, reviewId: data.reviewId, view: "requirements", workItemId: "../../../tmp/evil", baseFingerprint: data.baseFingerprint, baseStamp: data.baseStamp, requirements: { requirements: [], acceptAll: false } };
    const r = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/json", "x-praxis-review-token": data.token }, body: JSON.stringify(body) });
    return r.status;
  }, { base });
  check(res >= 400, `a submission for another work item path is refused (${res})`);
  check(!existsSync("/tmp/evil"), "nothing was created outside the work item");
});

await scenario("B03", "Prototype in Chrome: navigation, states, roles, mock data, search, comments, acceptance, links to REQ/AC", async () => {
  wi3 = await newGuided("Prototype item");
  const wi = wi3;
  const s0 = stateOf(wi);
  const acIds = s0.requirements.flatMap((r) => r.acceptanceCriteria.map((c) => c.id));
  await must({
    action: "set-prototype",
    summary: "first version",
    prototype: { kind: "ui", title: "Orders", startScreen: "list", roles: ["manager", "viewer"], styles: { colors: { primary: "#0b6bcb" }, fonts: {}, sources: [{ file: "src/theme.css" }] }, mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }, { key: "status", label: "Status", type: "string" }], rows: [{ number: "A-1", status: "new" }, { number: "B-2", status: "paid" }, { number: "A-3", status: "new" }] }], screens: [
      { id: "list", title: "Orders", states: ["default", "loading", "empty", "error", "denied"], stateMessages: { error: "Cannot load orders" }, elements: [{ id: "search", kind: "search", label: "Search", collection: "orders", intent: "search", requirementIds: ["REQ-ORD-001"], acIds: [acIds[1]] }, { id: "tbl", kind: "table", label: "Orders", collection: "orders", columns: ["number", "status"], intent: "view", requirementIds: ["REQ-ORD-001"], acIds: [acIds[0]] }, { id: "add", kind: "button", label: "Add order", action: "add-row", collection: "orders", allowedRoles: ["manager"] }, { id: "open", kind: "button", label: "Open", navigatesTo: "detail" }] },
      { id: "detail", title: "Order", states: ["default", "success"], elements: [{ id: "status", kind: "field", label: "Status", collection: "orders", field: "status", intent: "edit", allowedRoles: ["manager"], requirementIds: ["REQ-ORD-001"], acIds: [acIds[3]] }] },
    ], endpoints: [] },
  }, wi);
  const link = await linkOf("prototype", wi);
  const p = await page(link.secret);
  const rows = () => p.locator("#proto-screen tr").count();
  eq(await rows(), 4, "header + 3 mock rows");
  check((await p.locator("#proto-screen").innerText()).includes("REQ-ORD-001"), "elements show the requirement and criterion they cover");
  await p.locator("input[data-search]").pressSequentially("A-");
  eq(await p.locator("input[data-search]").inputValue(), "A-", "the search box keeps what is typed");
  eq(await rows(), 3, "search filters the table");
  await p.locator("input[data-search]").fill("");
  await p.locator("input[data-search]").pressSequentially("Z");
  check((await p.locator("#proto-screen").innerText()).includes("No rows"), "an empty result is shown");
  await p.locator("input[data-search]").fill("");
  await p.selectOption("#proto-state", "error");
  check((await p.locator("#proto-screen").innerText()).includes("Cannot load orders"), "error state");
  await p.selectOption("#proto-state", "default");
  await p.selectOption("#proto-role", "viewer");
  check(!(await p.locator("#proto-screen button", { hasText: "Add order" }).count()) || (await p.locator("#proto-screen").innerText()).includes("Not available for role"), "a viewer cannot use manager controls");
  await p.selectOption("#proto-role", "manager");
  await p.locator("#proto-screen button", { hasText: "Add order" }).click();
  eq(await rows(), 5, "add-row works on the in-memory copy");
  eq(stateOf(wi).prototype.mock[0].rows.length, 3, "the canonical mock data did not change");
  await p.locator("#proto-screen button", { hasText: "Open" }).click();
  check((await p.locator("#proto-screen").innerText()).includes("Order"), "navigation to the detail screen");
  await p.locator('[data-el="detail#status"] button[aria-label="Comment on status"]').click();
  await p.locator('[data-fb="detail#status"]').fill("make status a dropdown");
  await p.locator("#accept-proto").check();
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  const s = stateOf(wi);
  eq(s.prototype.feedback[0].target, "detail#status", "comment target");
  check(s.phaseAcceptance.prototype?.via === "html-review", "accepted by the user's save");
  // links are consistent with requirements
  const ids = new Set(s.requirements.flatMap((r) => r.acceptanceCriteria.map((c) => c.id)));
  for (const sc of s.prototype.screens) for (const e of sc.elements) for (const id of e.acIds) check(ids.has(id), `prototype ${sc.id}#${e.id} links ${id}`);
});

await scenario("B04", "Story plan in Chrome: edit a line, exclude one, agree", async () => {
  wi4 = await newGuided("Plan item");
  const wi = wi4;
  const s0 = stateOf(wi);
  const ac = (i) => s0.requirements.find((r) => r.id === "REQ-ORD-001").acceptanceCriteria[i].id;
  await must({ action: "set-prototype", prototype: { kind: "ui", title: "P", startScreen: "list", mock: [{ id: "o", name: "O", fields: [{ key: "n", label: "N", type: "string" }], rows: [{ n: "A" }] }], screens: [{ id: "list", title: "L", elements: [{ id: "t", kind: "table", collection: "o", columns: ["n"], requirementIds: ["REQ-ORD-001"], acIds: [ac(0)] }] }] } }, wi);
  await httpSave("prototype", wi, { prototype: { feedback: [], resolve: [], accept: true } });
  await must({ action: "advance-phase", to: "story_plan" }, wi);
  await must({ action: "set-story-plan", entries: [
    { id: "US-ORD-001", title: "View and search", implementation: "list page", userGets: "orders found by number", requirementIds: ["REQ-ORD-001"], acIds: [ac(0), ac(1)], screenRefs: ["list"], capabilities: ["view", "search", "states", "edit", "permissions"] },
    { id: "US-ORD-002", title: "Export (draft)", implementation: "CSV", userGets: "a file", requirementIds: ["REQ-ORD-002"], capabilities: ["filter", "states"] },
    { id: "US-ORD-003", title: "Export", implementation: "CSV of the filtered rows", userGets: "a file", requirementIds: ["REQ-ORD-002"], acIds: [s0.requirements.find((r) => r.id === "REQ-ORD-002").acceptanceCriteria[0].id], capabilities: ["filter", "states"] },
  ] }, wi);
  const link = await linkOf("story-plan", wi);  const p = await page(link.secret);
  eq(await p.locator("[data-entry]").count(), 3, "three plan lines");
  await p.locator('[data-entry="US-ORD-001"] [data-f=implementation]').fill("list page with paging");
  await p.locator('[data-entry="US-ORD-001"] input[value=accepted]').check();
  await p.locator('[data-entry="US-ORD-002"] [data-f=exclude]').fill("next release");
  await p.locator("#agree-plan").check();
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /Saved|conflict/i.test(document.querySelector("#toast").textContent));
  const plan = stateOf(wi).storyPlan;
  eq(plan.entries[0].implementation, "list page with paging", "line edited");
  eq(plan.entries[1].status, "excluded", "line excluded with a reason");
  eq(plan.entries[0].review.status, "accepted", "line accepted");
  eq(plan.status, "agreed", "the plan is agreed by the user's save");
  // consistency: plan lines point at real requirements and criteria
  const all = stateOf(wi);
  const ids = new Set(all.requirements.flatMap((r) => r.acceptanceCriteria.map((c) => c.id)));
  for (const e of plan.entries) {
    check(e.requirementIds.every((id) => all.requirements.some((r) => r.id === id)), "plan requirement ids exist");
    check(e.acIds.every((id) => ids.has(id)), "plan criterion ids exist");
  }
});

await scenario("B05", "Stories review in Chrome: per-item checkboxes, edit one story, exclude and restore, reopen", async () => {
  const wi = wi4;
  // the plan line US-ORD-002 was excluded in B04; US-ORD-001 is detailed here
  const story = (id, req, ac) => ({ action: "add-story", id, requirementIds: [req], actor: "manager", narrative: "As a manager, I want orders, so that I work.", objective: "see orders", userValue: "speed", happyPath: ["open", "search"], alternatives: ["nothing found"], negative: ["no permission"], businessRules: ["numbers are unique"], acceptanceCriteria: [{ id: `${id}-AC-01`, given: "orders exist", when: "opened", then: "listed" }], expectedResults: ["list shown"], confirmedBehavior: false });
  await must(story("US-ORD-001", "REQ-ORD-001"), wi);
  const link = await linkOf("stories", wi);
  const p = await page(link.secret);
  const keys = await p.locator('[data-story="US-ORD-001"] [data-key]').count();
  eq(keys, 1 + 2 + 1 + 1 + 1 + 1, "a control for every criterion, step, alternative, negative case, rule and result");
  await p.locator('[data-story="US-ORD-001"] [data-key="step:0"] input[value=accepted]').check();
  await p.locator('[data-story="US-ORD-001"] [data-key="neg:0"] input[value=rejected]').check();
  await p.locator('[data-story="US-ORD-001"] [data-key="neg:0"] [data-f=comment]').fill("what does a viewer see?");
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  let s = stateOf(wi).stories.find((x) => x.id === "US-ORD-001");
  eq([s.review["step:0"].status, s.review["neg:0"].status, s.review["neg:0"].comment], ["accepted", "rejected", "what does a viewer see?"], "item marks");
  // edit the story: new revision, its marks start over
  const link2 = await linkOf("stories", wi);
  const q = await page(link2.secret);
  eq(await q.locator('[data-story="US-ORD-001"] [data-key="step:0"] input[value=accepted]').isChecked(), true, "mark persists after reopening");
  await q.locator('[data-story="US-ORD-001"] [data-f=objective]').fill("see and find orders quickly");
  await q.locator("#btn-save").click();
  await q.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  s = stateOf(wi).stories.find((x) => x.id === "US-ORD-001" && x.status !== "superseded");
  eq([s.revision, s.objective, s.review["step:0"]?.status, s.confirmedBehavior], [2, "see and find orders quickly", "accepted", false], "edit by id makes a revision; marks of untouched items are kept, confirmation is not");
  // exclude, then restore
  const l3 = await linkOf("stories", wi);
  const r = await page(l3.secret);
  await r.locator('[data-story="US-ORD-001"] [data-f=exclude]').fill("not needed");
  await r.locator("#btn-save").click();
  await r.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  eq(stateOf(wi).stories.find((x) => x.id === "US-ORD-001" && x.status !== "superseded").status, "excluded", "excluded");
  const l4 = await linkOf("stories", wi);
  const t = await page(l4.secret);
  check((await t.locator('[data-story="US-ORD-001"]').innerText()).includes("Restore this story"), "an excluded story offers Restore after reopening");
  await t.locator('[data-story="US-ORD-001"] [data-f=restore]').check();
  await t.locator("#btn-save").click();
  await t.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  eq(stateOf(wi).stories.find((x) => x.id === "US-ORD-001" && x.status !== "superseded").status, "proposed", "restored");
  const fin = stateOf(wi);
  for (const sx of fin.stories) check(sx.requirementIds.every((id) => fin.requirements.some((rq) => rq.id === id)), "story requirement ids exist");
});

await scenario("B06", "Contracts review in Chrome: the user agrees a contract; reopening shows it agreed; the agent cannot", async () => {
  const wi6 = await newGuided("Contracts item");
  const svc = (id, deps) => ({ action: "set-service", service: { id, name: id, kind: "module", responsibilities: ["x"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress" } });
  await must(svc("svc-api", []), wi6);
  await must(svc("svc-web", ["svc-api"]), wi6);
  await must({ action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"], schemaRef: "openapi.json", status: "proposed" } }, wi6);
  const forged = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi6, command: JSON.stringify({ action: "set-contract", contract: { id: "C-1", name: "Orders API", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"], status: "agreed" } }) });
  check(!forged.ok && forged.code === "USER_DECISION_REQUIRED", "the agent cannot agree it");
  const link = await linkOf("contracts", wi6);
  const p = await page(link.secret);
  check((await p.locator('[data-contract="C-1"]').innerText()).includes("svc-api"), "provider is shown");
  eq(stateOf(wi6).contracts[0].status, "proposed", "nothing is agreed before Save");
  await p.locator('[data-contract="C-1"] [data-f=agree]').check();
  eq(stateOf(wi6).contracts[0].status, "proposed", "ticking is not enough: nothing is written before Save");
  await p.locator("#btn-save").click();
  await p.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  eq(stateOf(wi6).contracts[0].status, "agreed", "agreed by the user's Save");
  eq(stateOf(wi6).contracts[0].agreement.via, "html-review", "recorded as the user's");
  const q = await page((await linkOf("contracts", wi6)).secret);
  check((await q.locator('[data-contract="C-1"]').innerText()).includes("agreed"), "reopened: shown as agreed");
  eq(await q.locator('[data-contract="C-1"] [data-f=agree]').count(), 0, "no Agree box once agreed");
});

await scenario("B07", "Two tabs in Chrome: the second Save does not overwrite the first, says the page is out of date, and a reload shows the current state", async () => {
  const w = await newGuided("Two tabs item");
  const tabA = await page((await linkOf("requirements", w)).secret);
  const tabB = await page((await linkOf("requirements", w)).secret);
  // tab A: a remark on a criterion and on the requirement, a decision on the other criterion
  await tabA.locator('[data-ac="REQ-ORD-001-AC-01"] [data-f=ac-comment]').fill("tab A remark");
  await tabA.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=rejected]').check();
  await tabA.locator('[data-req="REQ-ORD-001"] [data-f=comment]').fill("tab A requirement remark");
  await tabA.locator("#btn-save").click();
  await tabA.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  // tab B, opened before A saved, edits the same three things
  await tabB.locator('[data-ac="REQ-ORD-001-AC-01"] [data-f=ac-comment]').fill("tab B remark");
  await tabB.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=pending]').check();
  await tabB.locator('[data-req="REQ-ORD-001"] [data-f=comment]').fill("tab B requirement remark");
  await tabB.locator("#btn-save").click();
  await tabB.waitForFunction(() => /Saved/.test(document.querySelector("#toast").textContent));
  const toast = await tabB.locator("#toast").innerText();
  check(/out of date/.test(toast) && /Reload the page/.test(toast), `tab B must be told the page is out of date and to reload: ${toast.slice(0, 300)}`);
  const stored = stateOf(w).requirements[0];
  eq([stored.acceptanceCriteria[0].review.comment, stored.acceptanceCriteria[1].review.status, stored.comment], ["tab A remark", "rejected", "tab A requirement remark"], "tab A's remarks and decision survive tab B's Save");
  // a reload shows what is stored now
  const fresh = await page((await linkOf("requirements", w)).secret);
  eq(await fresh.locator('[data-ac="REQ-ORD-001-AC-01"] [data-f=ac-comment]').inputValue(), "tab A remark", "the reloaded page shows tab A's remark");
  eq(await fresh.locator('[data-ac="REQ-ORD-001-AC-02"] input[value=rejected]').isChecked(), true, "and tab A's decision");
});

await browser.close();
await agent.close();
const failed = results.filter((r) => r.status !== "PASS");
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "ux-browser-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), automated: true, browser: "Google Chrome via Playwright (headless)", scenarios: results, notProven: ["manual user acceptance", "Claude Desktop / Claude Code rendering", "other browsers", "phone-size touch behaviour"] }, null, 2)}\n`);
console.error(`\n${results.length - failed.length}/${results.length} browser scenarios passed (automated, real Chrome); ${results.reduce((n, r) => n + r.checks, 0)} checks`);
if (failed.length) process.exit(1);
