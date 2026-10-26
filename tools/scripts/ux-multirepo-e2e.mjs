#!/usr/bin/env node
/**
 * One work item across three independent git repositories (backend API, web, mobile), through every role, over the packaged
 * Runtime and the official MCP client.
 *
 * REAL: the Runtime, the work-item state, three git repositories, the code the "Developer" writes and commits in each of
 * them, the tests it runs there, and the cross-repository contract check Quality executes against the actual files.
 * PLAYED by the script: the agents' decisions and edits, the user's Save clicks (HTTP, with the page's own tokens) and the
 * user's answers in the approval dialog (scripted).
 * Not proven: model behaviour, Claude UI, a person answering.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const extracted = extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), mkdtempSync(join(tmpdir(), "praxis-mr-")));

let checks = 0;
const log = [];
const step = (line) => {
  log.push(line);
  console.error(`  ok ${log.length}. ${line}`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL multi-repo: ${msg}`);
    process.exit(1);
  }
  checks += 1;
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const sessions = [];
async function open(elicit) {
  const s = await connectOfficialMcp({ command: process.execPath, args: extracted.args, cwd: extracted.dest, env: { ...hostedCleanEnv(extracted.dest), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1", PRAXIS_TEST_REVIEW_NO_BROWSER: "1" }, versionNegotiation: versionNegotiationLegacy(), elicit, timeoutMs: 20_000, clientVersion: version });
  sessions.push(s);
  return s;
}
const call = async (s, name, args) => parseDoctorEnvelope(await s.client.callTool({ name, arguments: args })) ?? { ok: false, code: "NO_ENVELOPE", errors: [] };
const approve = async () => ({ action: "accept", content: { decision: "approve" } });

// --- three independent repositories ------------------------------------------------------------------------------------
function gitRepo(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `praxis-mr-${name}-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
  return dir;
}
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=dev@example.test", "-c", "user.name=dev", ...args], { cwd, encoding: "utf8" });
const commitsOf = (dir) => git(dir, "log", "--format=%s").trim().split("\n").reverse();
const filesOfLastCommit = (dir) => git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();

const backend = gitRepo("backend", { "package.json": '{"type":"module"}\n', "orders.js": 'export const orders = [{ number: "A-1", customer: "Acme", status: "new" }, { number: "B-2", customer: "Globex", status: "paid" }];\nexport function listOrders() { return orders; }\n' });
const web = gitRepo("web", { "package.json": '{"type":"module","dependencies":{"react":"18.0.0"}}\n', "src/index.css": ":root{--color-primary:#0b6bcb;--radius:6px}\n", "src/pages/Orders.jsx": "export const Orders = () => null;\n" });
const mobile = gitRepo("mobile", { "package.json": '{"type":"module","dependencies":{"react-native":"0.74.0"}}\n', "src/screens/Orders.js": "export const Orders = () => null;\n" });
const repo = mkdtempSync(join(tmpdir(), "praxis-mr-workspace-"));
const stateOf = (id) => JSON.parse(readFileSync(join(repo, ".praxis", "workflow", "items", `${id}.json`), "utf8"));

const agent = await open(approve);
async function must(command, wi) {
  const extra = wi ? { workItemId: wi } : {};
  const p = await call(agent, "praxis_workflow_preview", { repo, command: JSON.stringify(command), ...extra });
  check(p.ok, `${command.action} preview: ${p.code} ${JSON.stringify(p.errors)}`);
  const a = await call(agent, "praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...extra });
  check(a.ok, `${command.action}: ${a.code} ${JSON.stringify(a.errors)}`);
  return a;
}
async function userSave(view, wi, payload) {
  const r = await call(agent, "praxis_review_render", { repo, view, workItemId: wi });
  check(r.ok, `render ${view}`);
  const secret = readFileSync(join(dirname(r.data.file), `${view}.url`), "utf8");
  const html = await (await fetch(secret)).text();
  const data = JSON.parse(html.match(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/)[1]);
  const res = await fetch(`${secret.split("?")[0]}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(secret).origin, "x-praxis-review-token": data.token }, body: JSON.stringify({ contract: "praxis.review.submission", version: 1, reviewId: data.reviewId, view, workItemId: wi, baseFingerprint: data.baseFingerprint, ...payload }) });
  const body = await res.json();
  check(res.status === 200 && body.conflicts.length === 0, `save ${view}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ===== BA ===============================================================================================================
const wi = (await must({ action: "open", projectId: "orders", title: "Order search on web and mobile", request: "Managers search orders by number on web and mobile; one backend", mode: "guided" })).data.workItemId;
for (const [id, name, role, path] of [["api", "Orders API", "backend", backend], ["web", "Orders web", "web frontend", web], ["mobile", "Orders mobile", "mobile app", mobile]]) {
  await must({ action: "register-repository", repository: { id, name, role, localPath: path } }, wi);
  const inspected = await call(agent, "praxis_repository_inspect", { repo, repositoryId: id, workItemId: wi });
  check(inspected.ok, `inspect ${id}`);
}
await must({ action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can search orders by number on web and on mobile, served by one backend", acceptanceCriteria: ["The backend returns orders matching a number", "The web page shows the matching orders", "The mobile screen shows the matching orders"] }, wi);
await userSave("requirements", wi, { requirements: { requirements: [], acceptAll: true } });
await must({ action: "advance-phase", to: "requirements_review" }, wi);
await must({ action: "advance-phase", to: "prototype" }, wi);
const acs = stateOf(wi).requirements[0].acceptanceCriteria.map((c) => c.id);
await must({ action: "set-prototype", prototype: { kind: "ui", title: "Order search", startScreen: "list", roles: ["manager"], styles: { colors: { primary: "#0b6bcb" }, fonts: {}, sources: [{ file: "src/index.css", repositoryId: "web" }] }, mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }, { key: "customer", label: "Customer", type: "string" }], rows: [{ number: "A-1", customer: "Acme" }, { number: "B-2", customer: "Globex" }] }], screens: [{ id: "list", title: "Orders", states: ["default", "empty", "error"], elements: [{ id: "search", kind: "search", collection: "orders", intent: "search", requirementIds: ["REQ-ORD-001"], acIds: [acs[0]] }, { id: "tbl", kind: "table", collection: "orders", columns: ["number", "customer"], intent: "view", requirementIds: ["REQ-ORD-001"], acIds: [acs[1], acs[2]] }] }] } }, wi);
await userSave("prototype", wi, { prototype: { feedback: [], resolve: [], accept: true } });
await must({ action: "advance-phase", to: "story_plan" }, wi);
const planLine = (id, title, impl, ac, repoId) => ({ id, title, implementation: impl, userGets: title, requirementIds: ["REQ-ORD-001"], acIds: [ac], screenRefs: ["list"], repositoryIds: [repoId], serviceIds: [`svc-${repoId}`], capabilities: ["view", "search", "states"], dependsOn: repoId === "api" ? [] : ["US-ORD-001"] });
await must({ action: "set-story-plan", entries: [planLine("US-ORD-001", "Backend order search", "GET /orders?q=", acs[0], "api"), planLine("US-ORD-002", "Web order search", "search box and list", acs[1], "web"), planLine("US-ORD-003", "Mobile order search", "search field and list", acs[2], "mobile")] }, wi);
await userSave("story-plan", wi, { plan: { entries: [], agree: true } });
const story = (id, ac, title) => ({ action: "add-story", id, requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: `As a manager, I want ${title.toLowerCase()}, so that I find an order fast.`, objective: title, userValue: "speed", happyPath: ["enter a number", "see the matching orders"], alternatives: ["no match: empty state"], negative: ["backend error: error state"], acceptanceCriteria: [{ id: `${id}-AC-01`, given: "orders exist", when: "a manager searches by number", then: "matching orders are shown" }], expectedResults: ["matching orders"], confirmedBehavior: false });
await must(story("US-ORD-001", acs[0], "Backend order search"), wi);
await must(story("US-ORD-002", acs[1], "Web order search"), wi);
await must(story("US-ORD-003", acs[2], "Mobile order search"), wi);
await must({ action: "advance-phase", to: "stories_review" }, wi);
await userSave("stories", wi, { stories: { items: [], stories: ["US-ORD-001", "US-ORD-002", "US-ORD-003"].map((id) => ({ storyId: id, revision: 1, acceptAll: true })), accept: true } });
eq(stateOf(wi).phaseAcceptance.stories_review?.via, "html-review", "stories accepted by the user's save");
await must({ action: "advance-phase", to: "architecture" }, wi);
step("BA: requirements, prototype, plan and stories accepted by the user (page saves); stories carry repositories and services from the plan");

// ===== Architect ========================================================================================================
const found = (await call(agent, "praxis_frontend_discover", { repo, repositoryId: "web", workItemId: wi })).data;
eq(found.styles.colors.primary, "#0b6bcb", "the web repository's own css supplies the prototype styles");
check(found.screenCandidates.includes("src/pages/Orders.jsx"), "its screens are found");
const heads = Object.fromEntries(stateOf(wi).repositories.map((r) => [r.id, r.inspection.headSha]));
eq(heads.api, git(backend, "rev-parse", "HEAD").trim(), "the Runtime read the backend's head commit itself");
await must({ action: "assign-repositories", repositoryIds: ["api"], storyIds: ["US-ORD-001"], requirementIds: ["REQ-ORD-001"] }, wi);
await must({ action: "assign-repositories", repositoryIds: ["web"], storyIds: ["US-ORD-002"] }, wi);
await must({ action: "assign-repositories", repositoryIds: ["mobile"], storyIds: ["US-ORD-003"] }, wi);
const svc = (id, rid, kind, deps) => ({ action: "set-service", service: { id, name: id, kind, repositoryId: rid, responsibilities: ["order search"], requirementIds: ["REQ-ORD-001"], dependsOn: deps, status: "in_progress" } });
await must(svc("svc-api", "api", "api", []), wi);
await must(svc("svc-web", "web", "frontend", ["svc-api"]), wi);
await must(svc("svc-mobile", "mobile", "frontend", ["svc-api"]), wi);
await must({ action: "set-contract", contract: { id: "C-ORDERS", name: "Orders search", providerServiceId: "svc-api", consumerServiceIds: ["svc-web", "svc-mobile"], schemaRef: "openapi.json#/paths/~1orders", requirementIds: ["REQ-ORD-001"], storyIds: ["US-ORD-001"], status: "proposed" } }, wi);
const agentAgrees = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi, command: JSON.stringify({ action: "set-contract", contract: { id: "C-ORDERS", name: "Orders search", providerServiceId: "svc-api", consumerServiceIds: ["svc-web", "svc-mobile"], status: "agreed" } }) });
check(!agentAgrees.ok && agentAgrees.code === "USER_DECISION_REQUIRED", "the agent cannot agree its own contract");
const blockedDev = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi, command: JSON.stringify({ action: "advance-phase", to: "development" }) });
check(!blockedDev.ok && blockedDev.code === "PHASE_GATE" && /not agreed by the user/.test(blockedDev.errors.join()), "development waits for the user's agreement of the contract");
await userSave("contracts", wi, { contracts: { agree: ["C-ORDERS"] } });
eq(stateOf(wi).contracts[0].status, "agreed", "the user agreed the contract on the contracts page");
await must({ action: "advance-phase", to: "development" }, wi);
const overview = (await call(agent, "praxis_repository_brief", { repo, workItemId: wi })).data;
eq(overview.order.order[0], "svc-api", "the backend is implemented first");
check(overview.progress.every((p) => !p.entered), "nothing is marked done before anyone worked");
step("Architect: three repositories registered and read by the Runtime, services with cross-repository dependencies, an agreed contract, order api -> web/mobile");

// ===== Developer: real code in each repository ============================================================================
const before = { api: commitsOf(backend), web: commitsOf(web), mobile: commitsOf(mobile) };
async function implement(rid, dir, files, implId, serviceId) {
  const brief = (await call(agent, "praxis_repository_brief", { repo, workItemId: wi, repositoryId: rid })).data.brief;
  check(brief.services.some((s) => s.id === serviceId), `brief for ${rid} lists ${serviceId}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const tested = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" });
  check(tested.status === 0, `${rid} tests: ${tested.stdout}${tested.stderr}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `Implement ${serviceId}: order search`);
  const main = Object.keys(files).find((f) => !f.endsWith(".test.js"));
  await must({ action: "record-implementation", id: implId, serviceId, requirementIds: ["REQ-ORD-001"], path: main, summary: `order search in ${rid}`, contractRef: "C-ORDERS" }, wi);
}
await implement("api", backend, {
  "orders.js": 'export const orders = [{ number: "A-1", customer: "Acme", status: "new" }, { number: "B-2", customer: "Globex", status: "paid" }];\nexport function listOrders() { return orders; }\nexport function searchOrders(q = "") { return orders.filter((o) => o.number.toLowerCase().includes(String(q).toLowerCase())); }\n',
  "openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/orders": { get: { parameters: [{ name: "q", in: "query" }], responses: { 200: { description: "orders", content: { "application/json": { schema: { type: "array", items: { type: "object", required: ["number", "customer", "status"] } } } } } } } } } }, null, 2),
  "orders.test.js": 'import test from "node:test";\nimport assert from "node:assert";\nimport { searchOrders } from "./orders.js";\ntest("search by number", () => { assert.deepEqual(searchOrders("a-1").map((o) => o.number), ["A-1"]); });\n',
}, "IMPL-API", "svc-api");
await implement("web", web, {
  "src/client.js": 'export function renderRows(provider, q) { return provider.searchOrders(q).map((o) => `${o.number} ${o.customer} ${o.status}`); }\n',
  "src/client.test.js": 'import test from "node:test";\nimport assert from "node:assert";\nimport { renderRows } from "./client.js";\ntest("renders rows", () => { assert.deepEqual(renderRows({ searchOrders: () => [{ number: "A-1", customer: "Acme", status: "new" }] }, "a"), ["A-1 Acme new"]); });\n',
}, "IMPL-WEB", "svc-web");
// the mobile developer reads the contract wrongly: order_number instead of number (a real cross-repository defect)
await implement("mobile", mobile, {
  "src/client.js": 'export function renderRows(provider, q) { return provider.searchOrders(q).map((o) => `${o.order_number} ${o.customer}`); }\n',
  "src/client.test.js": 'import test from "node:test";\nimport assert from "node:assert";\nimport { renderRows } from "./client.js";\ntest("renders rows", () => { assert.deepEqual(renderRows({ searchOrders: () => [{ order_number: "A-1", customer: "Acme" }] }, "a"), ["A-1 Acme"]); });\n',
}, "IMPL-MOBILE-1", "svc-mobile");
const after = { api: commitsOf(backend), web: commitsOf(web), mobile: commitsOf(mobile) };
for (const k of ["api", "web", "mobile"]) eq(after[k].length, before[k].length + 1, `${k} got exactly one commit`);
eq(filesOfLastCommit(backend), ["openapi.json", "orders.js", "orders.test.js"], "the backend commit touches only backend files");
eq(filesOfLastCommit(mobile), ["src/client.js", "src/client.test.js"], "the mobile commit touches only mobile files");
const prog = Object.fromEntries((await call(agent, "praxis_repository_brief", { repo, workItemId: wi })).data.progress.map((p) => [p.repositoryId, p]));
check(prog.api.entered && prog.web.entered && prog.mobile.entered, "all three repositories are entered, each by its own record");
step("Developer: real code, tests and a commit in each repository; each commit touches only its repository; implementation records point at real files");

// ===== Quality: executes the contract across the repositories ============================================================
await must({ action: "advance-phase", to: "quality" }, wi);
const contractCheck = () => {
  const script = `
    import { searchOrders } from ${JSON.stringify(`file://${backend}/orders.js`)};
    import { renderRows as webRows } from ${JSON.stringify(`file://${web}/src/client.js`)};
    import { renderRows as mobileRows } from ${JSON.stringify(`file://${mobile}/src/client.js`)};
    const provider = { searchOrders };
    const out = { api: searchOrders("b-2").length === 1, web: webRows(provider, "b-2").join() === "B-2 Globex paid", mobile: mobileRows(provider, "b-2").join().startsWith("B-2 ") };
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  return { out: JSON.parse(r.stdout.trim() || "{}"), raw: r.stdout + r.stderr };
};
const first = contractCheck();
eq(first.out, { api: true, web: true, mobile: false }, "Quality's executed contract check catches the mobile defect");
const scenarios = (res, rerun) => [["US-ORD-001", "api", "svc-api", "orders.js"], ["US-ORD-002", "web", "svc-web", "src/client.js"], ["US-ORD-003", "mobile", "svc-mobile", "src/client.js"]].map(([sid, k, svcId, path]) => ({ storyId: sid, storyRevision: 1, requirementId: "REQ-ORD-001", acceptanceCriterionId: `${sid}-AC-01`, scenarioId: `${sid}-HAPPY-1`, kind: "happy", serviceId: svcId, repository: k, implementationPath: path, evidence: [`contract check ${rerun ? "rerun " : ""}output: ${JSON.stringify(res.out)}`], status: res.out[k] ? "PASS" : "FAIL", critical: true }));
await must({ action: "record-verification", scenarios: scenarios(first, false), findings: [] }, wi);
const failing = stateOf(wi).verdicts.filter((v) => v.scope === "feature").at(-1);
eq(failing.verdict, "FAIL", "the feature verdict is FAIL while one repository fails the contract");
const blocked = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi, command: JSON.stringify({ action: "advance-phase", to: "delivery" }) });
check(!blocked.ok && blocked.code === "PHASE_GATE", "delivery is refused while the feature fails");
step("Quality: executed a cross-repository contract check, found the mobile defect, recorded a FAIL feature verdict; delivery is refused");

// return to Developer, fix in the mobile repository only
await must({ action: "return-to-phase", to: "development", reason: "Quality: mobile reads order_number, the contract says number" }, wi);
eq(stateOf(wi).phase, "development", "back in development");
const apiHead = git(backend, "rev-parse", "HEAD").trim();
writeFileSync(join(mobile, "src/client.js"), 'export function renderRows(provider, q) { return provider.searchOrders(q).map((o) => `${o.number} ${o.customer}`); }\n');
writeFileSync(join(mobile, "src/client.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\nimport { renderRows } from "./client.js";\ntest("renders rows", () => { assert.deepEqual(renderRows({ searchOrders: () => [{ number: "A-1", customer: "Acme" }] }, "a"), ["A-1 Acme"]); });\n');
check(spawnSync(process.execPath, ["--test"], { cwd: mobile }).status === 0, "mobile tests pass after the fix");
git(mobile, "add", "-A");
git(mobile, "commit", "-qm", "Fix svc-mobile: read number from the contract");
await must({ action: "record-implementation", id: "IMPL-MOBILE-2", serviceId: "svc-mobile", requirementIds: ["REQ-ORD-001"], path: "src/client.js", summary: "reads number as the contract says", contractRef: "C-ORDERS" }, wi);
eq(git(backend, "rev-parse", "HEAD").trim(), apiHead, "the fix did not touch the backend repository");
eq(commitsOf(mobile).length, before.mobile.length + 2, "the mobile repository has the original and the fix");
await must({ action: "advance-phase", to: "quality" }, wi);

// Quality verifies again, independently; the user confirms the stories in the dialog
const second = contractCheck();
eq(second.out, { api: true, web: true, mobile: true }, "the executed contract check now passes everywhere");
const inspect = (await call(agent, "praxis_workflow_inspect", { repo, workItemId: wi, view: "stories" })).data;
const fps = {};
(function walk(v) {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === "object") {
    if (typeof v.id === "string" && /^US-ORD-\d+$/.test(v.id) && typeof v.contentFingerprint === "string" && v.status !== "superseded") fps[v.id] = v.contentFingerprint;
    Object.values(v).forEach(walk);
  }
})(inspect);
check(Object.keys(fps).length === 3, `three story fingerprints: ${JSON.stringify(fps)}`);
const noDialog = await open(undefined);
const refused = await call(noDialog, "praxis_workflow_apply", { repo, workItemId: wi, command: JSON.stringify({ action: "confirm-story", id: "US-ORD-001", revision: 1, contentFingerprint: fps["US-ORD-001"] }), confirmation: "YES", previewFingerprint: "x" });
check(!refused.ok, "without a dialog a story cannot be confirmed");
for (const id of ["US-ORD-001", "US-ORD-002", "US-ORD-003"]) {
  const command = { action: "confirm-story", id, revision: 1, contentFingerprint: fps[id] };
  const p = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi, command: JSON.stringify(command) });
  const a = await call(agent, "praxis_workflow_apply", { repo, workItemId: wi, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint });
  check(a.ok, `confirm ${id}: ${JSON.stringify(a.errors)}`);
}
await must({ action: "record-verification", independentRerun: true, scenarios: scenarios(second, true), findings: [] }, wi);
const verdicts = stateOf(wi).verdicts;
check(verdicts.some((v) => v.scope === "feature" && v.verdict === "PASS" && !v.stale), `a current PASS feature verdict: ${JSON.stringify(verdicts.map((v) => [v.scope, v.verdict, v.stale]))}`);
const gate = await call(agent, "praxis_workflow_preview", { repo, workItemId: wi, command: JSON.stringify({ action: "advance-phase", to: "delivery" }) });
check(gate.ok, `delivery gate after a passing feature: ${JSON.stringify(gate.errors)}`);
await must({ action: "advance-phase", to: "delivery" }, wi);
step("Developer fixed only the mobile repository; Quality re-ran the contract independently; the user confirmed the stories in the dialog; feature PASS; delivery reached");

// ===== switching tasks, going back, new session ===========================================================================
const wi2 = (await must({ action: "open", projectId: "orders", title: "Invoice export", request: "Export invoices", mode: "guided" })).data.workItemId;
await must({ action: "add-requirement", id: "REQ-INV-001", statement: "Export invoices", acceptanceCriteria: ["CSV has a header"] }, wi2);
const status = (await call(agent, "praxis_workflow_status", { repo })).data;
check(/ask which to continue/.test(status.choose), "two work items: the agent is told to ask");
eq(stateOf(wi).phase, "delivery", "the first work item is untouched by work on the second");
await must({ action: "select-work-item", workItemId: wi });
eq((await call(agent, "praxis_workflow_status", { repo })).data.workItemId, wi, "switching back selects the first item");
// a requirement changes: return to BA, everything that depended on it goes stale, nothing is lost
await must({ action: "return-to-phase", to: "requirements_review", reason: "the user wants search by customer too" }, wi);
await must({ action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: acs[0], statement: "The backend returns orders matching a number or a customer name" }] }] }, wi);
const changed = stateOf(wi);
eq(changed.phase, "requirements_review", "back at the requirements review");
check(changed.verdicts.filter((v) => v.requirementIds.includes("REQ-ORD-001")).every((v) => v.stale), "earlier verdicts no longer count");
check(changed.stories.length === 3 && changed.implementationUnits.length >= 3, "implementation records and stories are kept");
const fresh = await open(approve);
const resumed = (await call(fresh, "praxis_session_start", { repo, role: "ba" })).data;
check(/ask which to continue/.test(resumed.resume.choose), "a new session is told to ask which work item");
await call(fresh, "praxis_workflow_status", { repo, workItemId: wi }).then((r) => {
  eq(r.data.phase, "requirements_review", "a new session restores the stage");
  eq(r.data.briefing.repositories.map((x) => x.id).sort(), ["api", "mobile", "web"], "a new session restores the repositories");
  check(r.data.briefing.lastSessions.length > 0, "and the session notes");
});
step("Task switching, return to BA after a requirement change (verdicts stale, records kept) and a new session restoring stage, repositories and notes");

for (const s of sessions) await s.close().catch(() => undefined);
console.error(`\nPASS multi-repo E2E: ${log.length} stages, ${checks} checks, 3 repositories, 1 work item through BA, Architect, Developer, Quality; played: agents, user's saves and dialog answers`);
