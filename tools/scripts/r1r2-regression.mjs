#!/usr/bin/env node
/**
 * R1/R2 regression harness: the attacks on the acceptance state (R2) and on the approval channel (R1) that
 * docs/approval-threat-model.md names, plus credential and compatibility checks, run against ONE Runtime bundle and judged
 * by effect only (does a gate open, what do status and inspect report, did a protected action run, did a secret leave).
 *
 *   node tools/scripts/r1r2-regression.mjs --bundle <praxis-mcp.cjs | candidate> --label <name> --out <dir>
 *                                         [--expect baseline|fixed] [--only id,id] [--keep]
 *
 * --bundle candidate  packs this checkout's MCPB (a production bundle) and runs its server, as CI does.
 * --expect baseline   0.1.0-alpha.49.2: every R1/R2 attack must work (observed vulnerable); the other rows must hold.
 * --expect fixed      0.1.0-alpha.49.3: the default. Both modes read tools/fixtures/r1r2/expectations.json, so the
 *                     expectations can follow the integrated bundle without touching the attacks.
 * Output: <out>/results.json and <out>/results.md (a table); exit 1 when a row FAILs.
 *
 * Threat tiers (BRIEF-COMMON): T-repo controls repository contents only; T-sandboxed-agent runs commands but writes only in
 * the workspace and temp dirs; T-same-user has the user's full OS privileges. Nothing local stops T-same-user: the rows that
 * stay open against it are marked residual and pass when observed as stated. Nothing here claims R1 is eliminated.
 *
 * Every attack runs in its own fixture under <out>/fixtures: a throwaway git repository, its own HOME and PRAXIS_STATE_HOME,
 * and a server started as `node <bundle> --role runtime` with an environment built from nothing (no credential and no PRAXIS_*
 * of the caller reaches it; rows that need a fake token set one). A production 0.1.0-alpha.49.3 bundle keeps its decision
 * ledger under the OS account's home (os.userInfo().homedir), whatever HOME says: there the harness may create, and deletes
 * afterwards, only ~/.praxis/ledger/<repoKey> and ~/.praxis/decisions/<repoKey>* entries derived from its own temp
 * repositories. It touches nothing else in ~/.praxis, and lists every path it created and removed in results.json.
 *
 * Run it outside an agent's session (CI, or an orphaned process): a Runtime refuses every dialog when a Claude Code session
 * started with --settings is among its ancestors. Every dialog answer here is the harness standing in for the person: a
 * scripted test action, never a person's consent.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const expectMode = opt("expect", "fixed");
const label = opt("label", "run");
const out = resolve(opt("out", join(root, "dist", "r1r2", label)));
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const keep = argv.includes("--keep");
if (!["baseline", "fixed"].includes(expectMode)) throw new Error("--expect baseline|fixed");
if (!opt("bundle")) throw new Error("--bundle <path to praxis-mcp.cjs> | candidate");
mkdirSync(out, { recursive: true });
const work = join(out, "fixtures");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// the stand-in browser (test-browser.mjs) makes its folder under the temp dir at import: keep it with the fixtures
process.env.TMPDIR = work;

const { connectOfficialMcp, parseDoctorEnvelope, versionNegotiationLegacy, versionNegotiationModern } = await import("./official-mcp-client.mjs");
const { openedLinks } = await import("./test-browser.mjs");
const contracts = await import("@praxis/contracts");
const EXPECTATIONS = JSON.parse(readFileSync(join(root, "tools", "fixtures", "r1r2", "expectations.json"), "utf8")).rows;

let bundle = opt("bundle");
if (bundle === "candidate") {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
  const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
  const dist = await packClaudeExtension(version);
  const dir = join(work, "candidate");
  extractMcpbRuntime(dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb"), dir);
  bundle = join(dir, "server", "praxis-mcp.cjs");
}
bundle = resolve(bundle);
if (!existsSync(bundle)) throw new Error(`no bundle at ${bundle}`);
const bundleSha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=harness@example.test", "-c", "user.name=harness", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// --- the account home: what a production 0.1.0-alpha.49.3 bundle writes there, and nothing else ---------------------------

const accountHome = realpathSync(userInfo().homedir);
const accountPraxis = join(accountHome, ".praxis");
const LEDGER_DIRS = ["ledger", "decisions"];
const homeLedger = { root: accountPraxis, created: [], removed: [], foreign: [] };
const homeDirsBefore = new Set([accountPraxis, ...LEDGER_DIRS.map((d) => join(accountPraxis, d))].filter((d) => existsSync(d)));
const listHome = () => new Set(LEDGER_DIRS.flatMap((d) => (existsSync(join(accountPraxis, d)) ? readdirSync(join(accountPraxis, d)).map((f) => join(d, f)) : [])));
const gitCommonDir = (repo) => {
  try {
    return realpathSync(resolve(repo, git(repo, "rev-parse", "--git-common-dir").trim()));
  } catch {
    return undefined;
  }
};
/**
 * Every key a Runtime may derive for one of the harness's repositories: 49.2 keys the journal by sha256(path.resolve(repo));
 * 49.3 keys its journal and ledger by repositoryKey (contracts user-approval.ts): sha256("git:" + the real path of the git
 * common dir), or sha256("dir:" + the real path) outside git. A home entry is the harness's own only when its name starts with
 * one of these keys, so an entry of any real project never matches.
 */
function repoKeys(repo) {
  const inputs = [resolve(repo)];
  try {
    const real = realpathSync(repo);
    inputs.push(real, `dir:${real}`);
  } catch {
    /* gone already */
  }
  const common = gitCommonDir(repo);
  if (common) inputs.push(common, dirname(common), `git:${common}`);
  return [...new Set(inputs.map((p) => sha256(p).slice(0, 16)))];
}

// --- fixtures and servers -----------------------------------------------------------------------------------------------

function newRepo(path) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), `${JSON.stringify({ name: "orders", private: true, scripts: { test: "node --test" } })}\n`);
  git(path, "init", "-q");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "initial");
  return path;
}

function fixture(id) {
  const base = join(work, id);
  const fx = { id, base, repo: newRepo(join(base, "repo")), home: join(base, "home"), state: join(base, "state"), tmp: join(base, "tmp"), repos: [], transcript: [], stderr: [] };
  for (const dir of [fx.home, fx.state, fx.tmp]) mkdirSync(dir, { recursive: true });
  fx.repos.push(fx.repo);
  return fx;
}

const CLIENTS = {
  // a client with a dialog the harness answers: approve, at a person's pace (49.2 takes an answer under 1 s as the client's own)
  dialog: { clientName: "claude-code", clientVersion: "2.1.314", answer: "approve", negotiation: versionNegotiationLegacy },
  decline: { clientName: "claude-code", clientVersion: "2.1.314", answer: "decline", negotiation: versionNegotiationLegacy },
  // a client that cannot ask anyone (no elicitation capability)
  chat: { clientName: "local-agent-mode-Praxis Runtime", clientVersion: "1.0.0", negotiation: versionNegotiationModern },
};

/**
 * A Runtime of the bundle for one fixture. `sandbox` is a sandbox-exec profile the server runs under (macOS only). The env is
 * built from nothing: PATH, the fixture's HOME / TMPDIR / PRAXIS_STATE_HOME, and only what the row adds.
 */
async function server(fx, { client = "dialog", env = {}, sandbox } = {}) {
  const c = CLIENTS[client];
  const baseEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: fx.home, TMPDIR: fx.tmp, LANG: "C", PRAXIS_STATE_HOME: fx.state, CLAUDE_CODE_ENTRYPOINT: "cli" };
  const command = sandbox ? "/usr/bin/sandbox-exec" : process.execPath;
  const args = sandbox ? ["-p", sandbox, process.execPath, bundle, "--role", "runtime"] : [bundle, "--role", "runtime"];
  const asked = [];
  const session = await connectOfficialMcp({
    command,
    args,
    cwd: fx.base,
    env: { ...baseEnv, ...env },
    versionNegotiation: c.negotiation(),
    timeoutMs: 20_000,
    clientName: c.clientName,
    clientVersion: c.clientVersion,
    ...(c.answer
      ? {
          elicit: async (params) => {
            asked.push(params?.message ?? "");
            return c.answer === "approve" ? { action: "accept", content: { decision: "approve" } } : { action: "decline" };
          },
          answerAfterMs: 1100,
        }
      : {}),
  });
  const call = async (name, args) => {
    let raw;
    try {
      raw = await session.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    } catch (error) {
      raw = { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] };
    }
    fx.transcript.push({ tool: name, args, raw });
    return parseDoctorEnvelope(raw) ?? { ok: false, code: "NO_ENVELOPE", errors: [raw?.content?.[0]?.text ?? ""], data: {} };
  };
  return {
    call,
    asked,
    async close() {
      fx.stderr.push(session.stderr());
      await session.close().catch(() => undefined);
    },
  };
}

async function withServer(fx, options, fn) {
  const s = await server(fx, options);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

// --- reading responses --------------------------------------------------------------------------------------------------

const KNOWN_CODES = ["ACCEPTANCE_UNVERIFIED", "ACCEPTANCE_INVALID", "DECISION_LEDGER_UNAVAILABLE", "INDEPENDENT_AUTHORITY_UNAVAILABLE"];
const INTEGRITY = ["proposed", "accepted", "unverified", "invalid", "stale", "independently-verified"];
function codesIn(envelope) {
  const codes = new Set();
  if (envelope?.code) codes.add(envelope.code);
  for (const e of envelope?.errors ?? []) {
    if (e && typeof e === "object" && e.code) codes.add(e.code);
    const lead = /^([A-Z][A-Z0-9_]{3,}):/.exec(typeof e === "string" ? e : (e?.message ?? ""))?.[1];
    if (lead) codes.add(lead);
  }
  const text = JSON.stringify(envelope ?? {});
  for (const code of KNOWN_CODES) if (text.includes(code)) codes.add(code);
  return [...codes];
}
const codeOf = (envelope) => (envelope?.ok ? "ok" : (codesIn(envelope)[0] ?? "refused"));
function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((v) => walk(v, visit));
  if (value && typeof value === "object") {
    visit(value);
    for (const v of Object.values(value)) walk(v, visit);
  }
}
const SUBJECT_KINDS = ["criterion", "phase", "story", "decision", "service", "contract", "waiver", "mode"];
/**
 * Integrity statuses reported for one subject anywhere in the responses: a field named like "integrity" on the subject (or
 * on its review), or an integrity report entry for it ({ kind, id | key "<kind>:<id>", status }, the shape 49.3 reports).
 */
function integrityOf(subjectId, ...responses) {
  const found = new Set();
  const collect = (v) => {
    if (typeof v === "string" && INTEGRITY.includes(v)) found.add(v);
    else if (v && typeof v === "object" && typeof v.status === "string" && INTEGRITY.includes(v.status)) found.add(v.status);
  };
  for (const response of responses) {
    walk(response, (node) => {
      const ids = [node.id, node.criterionId, node.storyId, node.decisionId, node.serviceId, node.contractId, node.subjectId, node.phase];
      const keyed = typeof node.key === "string" && SUBJECT_KINDS.some((k) => node.key === `${k}:${subjectId}`);
      if (!ids.includes(subjectId) && !keyed) return;
      if ((keyed || SUBJECT_KINDS.includes(node.kind)) && typeof node.status === "string" && INTEGRITY.includes(node.status) && ("reason" in node || keyed)) found.add(node.status);
      for (const holder of [node, node.review, node.acceptance].filter((h) => h && typeof h === "object")) for (const [k, v] of Object.entries(holder)) if (/integrity/i.test(k)) collect(v);
    });
  }
  return [...found];
}
/** The approval labels (BRIEF shared names) wherever a response carries them. */
function labelsIn(response) {
  const labels = {};
  walk(response, (node) => {
    for (const key of ["personVerified", "independentlyVerified", "channel", "decidedBy"]) if (key in node && !(key in labels)) labels[key] = node[key];
  });
  return labels;
}
/** The integrity summary objects of a response (status / inspect), as reported. */
function summariesIn(response) {
  const found = [];
  walk(response, (node) => {
    if (node.integrity && typeof node.integrity === "object" && !Array.isArray(node.integrity) && ["accepted", "unverified", "invalid", "stale"].some((k) => k in node.integrity)) found.push(node.integrity);
    if (typeof node.independentVerification === "string") found.push({ independentVerification: node.independentVerification });
  });
  return found.slice(0, 4);
}

// --- the workflow, as a client drives it --------------------------------------------------------------------------------

const itemPath = (repo, wi) => join(repo, ".praxis", "workflow", "items", `${wi}.json`);
const readItem = (repo, wi) => JSON.parse(readFileSync(itemPath(repo, wi), "utf8"));
/** T-repo: the attacker rewrites the work item file (no server running: a merged change, a script, an editor). */
function forge(repo, wi, mutate) {
  const item = readItem(repo, wi);
  mutate(item);
  writeFileSync(itemPath(repo, wi), `${JSON.stringify(item, null, 2)}\n`);
}

async function run(s, repo, command, wi) {
  const extra = wi ? { workItemId: wi } : {};
  const p = await s.call("praxis_workflow_preview", { repo, command: JSON.stringify(command), ...extra });
  if (!p.ok) return p;
  return s.call("praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data?.fingerprint ?? p.data?.previewFingerprint, ...extra });
}
async function must(s, repo, command, wi) {
  const r = await run(s, repo, command, wi);
  if (!r.ok) throw new Error(`${command.action}${command.to ? ` ${command.to}` : ""}: ${codeOf(r)} ${JSON.stringify(r.errors ?? []).slice(0, 400)}`);
  return r;
}
/** The gated step: preview, then apply. Open only when the apply succeeded (and, for a phase, the phase moved). */
async function gate(s, repo, wi, command) {
  const r = await run(s, repo, command, wi);
  const moved = command.action === "advance-phase" ? existsSync(itemPath(repo, wi)) && readItem(repo, wi).phase === command.to : true;
  return { open: Boolean(r.ok) && moved, code: codeOf(r), codes: codesIn(r), response: r };
}

/** The person's review in the page, played: render, read the page as a browser would, Save, then approve in the dialog. */
async function userSave(s, repo, wi, view, payload) {
  const before = openedLinks().length;
  // reopen: a page of the same view opened minutes ago would otherwise be reused, and the stand-in browser gets no new link
  const rendered = await s.call("praxis_review_render", { repo, view, workItemId: wi, reopen: true });
  if (!rendered.ok) throw new Error(`render ${view}: ${codeOf(rendered)} ${JSON.stringify(rendered.errors ?? []).slice(0, 300)}`);
  let link;
  for (let i = 0; i < 80 && !link; i += 1) {
    const links = openedLinks();
    if (links.length > before) link = links.at(-1);
    else await sleep(50);
  }
  if (!link) throw new Error(`render ${view}: no page was opened`);
  const html = await (await fetch(link)).text();
  const data = JSON.parse(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "{}");
  const submission = { contract: "praxis.review.submission", version: 1, reviewId: data.reviewId, view, workItemId: wi, baseFingerprint: data.baseFingerprint, ...(data.baseStamp ? { baseStamp: data.baseStamp } : {}), ...payload };
  const sent = await fetch(`${link.split("?")[0]}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(link).origin, "x-praxis-review-token": data.token }, body: JSON.stringify(submission) });
  if (sent.status !== 200) throw new Error(`save ${view}: HTTP ${sent.status} ${(await sent.text()).slice(0, 200)}`);
  const applied = await s.call("praxis_review_apply", { repo, fromPage: true, workItemId: wi, view, confirmation: "YES" });
  if (!applied.ok) throw new Error(`apply ${view}: ${codeOf(applied)} ${JSON.stringify(applied.errors ?? []).slice(0, 300)}`);
  return applied;
}

const REQ = "REQ-ORD-001";
const AC1 = `${REQ}-AC-01`;
const AC2 = `${REQ}-AC-02`;
const STORY = "US-ORD-001";
async function openItem(s, repo, { criteria = ["The search returns the orders matching a number"], mode = "guided" } = {}) {
  const wi = (await must(s, repo, { action: "open", projectId: "orders", title: "Order search", request: "Managers search orders by number", mode })).data.workItemId;
  await must(s, repo, { action: "add-requirement", id: REQ, statement: "Managers can search orders by number", acceptanceCriteria: criteria }, wi);
  return wi;
}
const acceptAll = (s, repo, wi) => userSave(s, repo, wi, "requirements", { requirements: { requirements: [], acceptAll: true } });
function markCriterion(s, repo, wi, id, status) {
  const item = readItem(repo, wi);
  const requirement = item.requirements.find((r) => r.id === REQ);
  const criterion = requirement.acceptanceCriteria.find((c) => c.id === id);
  return userSave(s, repo, wi, "requirements", { requirements: { requirements: [{ id: REQ, revision: requirement.revision, criteria: [{ id, revision: criterion.revision, from: criterion.review.status, status, ...(status === "rejected" ? { comment: "not what we need" } : {}) }], addCriteria: [], removeCriteria: [] }], acceptAll: false } });
}
/** Requirements with two criteria, accepted by the person, then AC-02 rejected by the person: the gate to the prototype is shut. */
async function acceptedThenRejected(s, repo) {
  const wi = await openItem(s, repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
  await must(s, repo, { action: "advance-phase", to: "requirements_review" }, wi);
  await acceptAll(s, repo, wi);
  await markCriterion(s, repo, wi, AC2, "rejected");
  return wi;
}
const PROTOTYPE = { kind: "ui", title: "Order search", startScreen: "list", roles: ["manager"], styles: { colors: { primary: "#0b6bcb" }, fonts: {}, sources: [] }, mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }, { key: "customer", label: "Customer", type: "string" }], rows: [{ number: "A-1", customer: "Acme" }, { number: "B-2", customer: "Globex" }] }], screens: [{ id: "list", title: "Orders", states: ["default", "empty", "error"], elements: [{ id: "search", kind: "search", collection: "orders", intent: "search", requirementIds: [REQ], acIds: [AC1] }, { id: "tbl", kind: "table", collection: "orders", columns: ["number", "customer"], intent: "view", requirementIds: [REQ], acIds: [AC1] }] }] };
/** Every BA stage accepted by the person, through `until`: "stories" (accepted, not confirmed), "architecture" (confirmed, entered). */
async function genuineBA(s, repo, until) {
  const wi = await openItem(s, repo);
  await acceptAll(s, repo, wi);
  await must(s, repo, { action: "advance-phase", to: "requirements_review" }, wi);
  await must(s, repo, { action: "advance-phase", to: "prototype" }, wi);
  await must(s, repo, { action: "set-prototype", prototype: PROTOTYPE }, wi);
  await userSave(s, repo, wi, "prototype", { prototype: { feedback: [], resolve: [], accept: true } });
  await must(s, repo, { action: "advance-phase", to: "story_plan" }, wi);
  await must(s, repo, { action: "set-story-plan", entries: [{ id: STORY, title: "Order search", implementation: "search box and list", userGets: "the matching orders", requirementIds: [REQ], acIds: [AC1], screenRefs: ["list"], capabilities: ["view", "search", "states"], dependsOn: [] }] }, wi);
  await userSave(s, repo, wi, "story-plan", { plan: { entries: [], agree: true } });
  await must(s, repo, { action: "add-story", id: STORY, requirementIds: [REQ], actor: "manager", narrative: "As a manager, I want to search orders by number, so that I find an order fast.", objective: "Order search", userValue: "speed", happyPath: ["enter a number", "see the matching orders"], alternatives: ["no match: empty state"], negative: ["backend error: error state"], acceptanceCriteria: [{ id: `${STORY}-AC-01`, given: "orders exist", when: "a manager searches by number", then: "matching orders are shown" }], expectedResults: ["matching orders"], confirmedBehavior: false }, wi);
  await must(s, repo, { action: "advance-phase", to: "stories_review" }, wi);
  await userSave(s, repo, wi, "stories", { stories: { items: [], stories: [{ storyId: STORY, revision: readItem(repo, wi).stories[0].revision, acceptAll: true }], accept: true } });
  if (until === "stories") return wi;
  await confirmStory(s, repo, wi);
  await must(s, repo, { action: "advance-phase", to: "architecture" }, wi);
  return wi;
}
async function confirmStory(s, repo, wi) {
  const view = await s.call("praxis_workflow_inspect", { repo, workItemId: wi, view: "stories" });
  const story = (view.data?.stories ?? []).find((st) => st.id === STORY);
  return must(s, repo, { action: "confirm-story", id: STORY, revision: story.revision, contentFingerprint: story.contentFingerprint }, wi);
}
const service = (id, kind, repo, dependsOn = []) => ({ action: "set-service", service: { id, name: id, kind, localPath: repo, responsibilities: ["order search"], requirementIds: [REQ], dependsOn, status: "in_progress" } });
const CONTRACT = { id: "C-ORDERS", name: "Orders search", providerServiceId: "svc-api", consumerServiceIds: ["svc-web"], schemaRef: "openapi.json#/paths/~1orders", requirementIds: [REQ], storyIds: [STORY], status: "proposed" };
async function servicesAndContract(s, repo, wi) {
  await must(s, repo, service("svc-api", "api", repo), wi);
  await must(s, repo, service("svc-web", "frontend", repo, ["svc-api"]), wi);
  await must(s, repo, { action: "set-contract", contract: CONTRACT }, wi);
}
/** The phase acceptance a T-repo attacker writes: the fingerprint is a public function of the file's own content. */
function forgedPhaseAcceptance(item, phase) {
  return { revision: item.workItem.revision, at: new Date().toISOString(), via: "approved", fingerprint: contracts.currentFingerprint(item, phase) };
}
function forgeRequirementsAccepted(item) {
  for (const r of item.requirements) {
    r.status = "approved";
    for (const c of r.acceptanceCriteria) c.review = { ...c.review, status: "accepted", at: new Date().toISOString(), via: "approved" };
  }
  item.phaseAcceptance = { ...item.phaseAcceptance, requirements_review: forgedPhaseAcceptance(item, "requirements_review") };
}
/** What status and inspect say about a subject after the attack, read by a fresh server (as the next session would). */
async function reportOn(s, repo, wi, view, subjectId) {
  const inspect = await s.call("praxis_workflow_inspect", { repo, workItemId: wi, view });
  const all = await s.call("praxis_workflow_inspect", { repo, workItemId: wi, view: "all" });
  const status = await s.call("praxis_workflow_status", { repo, workItemId: wi });
  return { inspect, all, status, integrity: integrityOf(subjectId, inspect, all, status), summaries: summariesIn(status).concat(summariesIn(inspect)) };
}
const criterionIn = (inspect, id) => (inspect.data?.requirements ?? []).flatMap((r) => r.acceptanceCriteria ?? []).find((c) => c.id === id);
/** A step that threw (userSave, must): its refusal as an envelope, with the error codes its message names. */
function refusal(error) {
  const text = String(error?.message ?? error);
  const codes = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return { ok: false, code: KNOWN_CODES.find((c) => codes.includes(c)) ?? codes[0] ?? "refused", errors: [text.slice(0, 300)] };
}
const short = (envelope) => (envelope?.ok ? "ok" : `${codeOf(envelope)}${envelope?.errors?.length ? ` ${JSON.stringify(envelope.errors).slice(0, 160)}` : ""}`);

/**
 * outcome of an R2 row: vulnerable when the forged acceptance opened its gate, or (no gate) was reported as accepted with no
 * integrity status that says otherwise; protected when neither.
 */
function r2Outcome({ gateResult, reportedAccepted, integrity }) {
  const downgraded = integrity.some((x) => ["unverified", "invalid", "stale"].includes(x));
  if (gateResult?.open) return "vulnerable";
  if (!gateResult && reportedAccepted && !downgraded) return "vulnerable";
  if (gateResult && reportedAccepted && !downgraded) return "misreported";
  return "protected";
}

// --- the rows -------------------------------------------------------------------------------------------------------------

const ROWS = [];
const row = (id, tier, attack, runRow) => ROWS.push({ id, tier, attack, run: runRow });

row("R2-field-criterion", "T-repo", "the person accepted every criterion, then rejected AC-02; the file is edited back to accepted for AC-02", async (fx) => {
  const wi = await withServer(fx, {}, (s) => acceptedThenRejected(s, fx.repo));
  forge(fx.repo, wi, (item) => {
    const c = item.requirements[0].acceptanceCriteria.find((x) => x.id === AC2);
    c.review = { status: "accepted", at: new Date().toISOString(), via: "approved" };
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", AC2);
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const reportedAccepted = criterionIn(report.inspect, AC2)?.review?.status === "accepted";
    return { outcome: r2Outcome({ gateResult, reportedAccepted, integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `inspect AC-02 ${criterionIn(report.inspect, AC2)?.review?.status}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-field-phase-acceptance", "T-repo", "no decision of the person: every criterion and phaseAcceptance.requirements_review written with a recomputed fingerprint", async (fx) => {
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    return id;
  });
  forge(fx.repo, wi, forgeRequirementsAccepted);
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", "requirements_review");
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const acceptance = report.inspect.data?.requirementReview?.acceptance;
    const integrity = [...report.integrity, ...(INTEGRITY.includes(acceptance) && acceptance !== "accepted" ? [acceptance] : []), ...integrityOf(AC1, report.inspect, report.all)];
    return { outcome: r2Outcome({ gateResult, reportedAccepted: acceptance === "accepted", integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: [...new Set(integrity)], summaries: report.summaries, detail: `inspect requirementReview.acceptance ${acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-field-story", "T-repo", "every BA stage accepted by the person, the story not confirmed; the file sets confirmedBehavior:true, status:confirmed", async (fx) => {
  const wi = await withServer(fx, {}, (s) => genuineBA(s, fx.repo, "stories"));
  forge(fx.repo, wi, (item) => {
    const story = item.stories.find((st) => st.id === STORY);
    story.confirmedBehavior = true;
    story.status = "confirmed";
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "stories", STORY);
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "architecture" });
    const confirmation = (report.inspect.data?.stories ?? []).find((st) => st.id === STORY)?.confirmation;
    return { outcome: r2Outcome({ gateResult, reportedAccepted: confirmation === "confirmed", integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `inspect story ${confirmation}; advance-phase architecture ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

async function decisionFixture(fx) {
  return withServer(fx, {}, async (s) => {
    const wi = await openItem(s, fx.repo);
    await must(s, fx.repo, { action: "record-decision", id: "D-001", statement: "Orders are searched by exact number", rationale: "numbers are unique" }, wi);
    return wi;
  });
}
async function decisionReport(fx, wi) {
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "decisions", "D-001");
    const approvals = await s.call("praxis_workflow_inspect", { repo: fx.repo, workItemId: wi, view: "approvals" });
    const confirmed = (report.inspect.data?.decisions?.decisions ?? []).find((d) => d.id === "D-001")?.confirmed === true;
    const handoff = await run(s, fx.repo, { action: "handoff", sourceRole: "architect", targetRole: "developer", requirementIds: [REQ], readiness: "ready" }, wi);
    const carried = handoff.ok && (readItem(fx.repo, wi).handoffs.at(-1)?.decisionRecords ?? []).some((d) => d.id === "D-001" && d.confirmed === true);
    const flagged = JSON.stringify(approvals.data?.approvals?.summary?.unverifiedProvenance ?? []).includes("D-001");
    const integrity = [...new Set([...report.integrity, ...integrityOf("D-001", approvals)])];
    return { report, confirmed, carried, flagged, integrity, approvals, handoff };
  });
}

row("R2-field-decision", "T-repo", "an agent records decision D-001 (unconfirmed); the file sets confirmed:true", async (fx) => {
  const wi = await decisionFixture(fx);
  forge(fx.repo, wi, (item) => {
    item.decisions.find((d) => d.id === "D-001").confirmed = true;
  });
  const r = await decisionReport(fx, wi);
  return { outcome: r2Outcome({ reportedAccepted: r.confirmed && r.carried, integrity: r.integrity }), gate: r.carried ? "handoff carries confirmed:true" : short(r.handoff), codes: codesIn(r.handoff), integrity: r.integrity, summaries: r.report.summaries, detail: `inspect confirmed ${r.confirmed}; handoff ${r.handoff.ok ? (r.carried ? "carries confirmed:true" : "does not carry it") : short(r.handoff)}; approvals.unverifiedProvenance ${r.flagged ? "lists it (49.2 detects the missing record)" : "silent"}` };
});

row("R2-field-approvals", "T-repo", "as R2-field-decision, plus a forged approvals[] record for the confirmation (client-response trust)", async (fx) => {
  const wi = await decisionFixture(fx);
  forge(fx.repo, wi, (item) => {
    const decision = item.decisions.find((d) => d.id === "D-001");
    decision.confirmed = true;
    item.approvals = [...(item.approvals ?? []), { id: `AP-${randomBytes(4).toString("hex")}`, at: new Date().toISOString(), action: "confirm-decision", subjects: [{ type: "decision", id: "D-001", revision: decision.revision, contentFingerprint: contracts.decisionContentFingerprint(decision) }], summary: "Confirm architecture decision D-001", subjectDigest: sha256("forged"), channel: "client-elicitation", assurance: "client-ui", trust: "client-response", workItemRevision: item.workItem.revision, personVerified: false, independentlyVerified: false }];
  });
  const r = await decisionReport(fx, wi);
  return { outcome: r2Outcome({ reportedAccepted: r.confirmed && !r.flagged, integrity: r.integrity }), gate: r.carried ? "handoff carries confirmed:true" : short(r.handoff), codes: codesIn(r.handoff), integrity: r.integrity, summaries: r.report.summaries, detail: `inspect confirmed ${r.confirmed}; approvals.unverifiedProvenance ${r.flagged ? "lists D-001" : "empty: the forged record hides it"}; clientResponse ${r.approvals.data?.approvals?.summary?.clientResponse}` };
});

row("R2-field-service", "T-repo", "an agent sets service svc-api in_progress; the file sets status:approved", async (fx) => {
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo);
    await must(s, fx.repo, service("svc-api", "api", fx.repo), id);
    return id;
  });
  forge(fx.repo, wi, (item) => {
    item.services.find((x) => x.id === "svc-api").status = "approved";
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "work", "svc-api");
    const ready = report.inspect.data?.work?.readiness?.ready === true;
    const verdict = await run(s, fx.repo, { action: "feature-verdict" }, wi);
    const gaps = JSON.stringify(verdict.data?.result?.readinessGaps ?? verdict.data?.result ?? verdict.errors ?? "");
    const counted = verdict.ok && !gaps.includes("services are not approved");
    const gateResult = { open: counted, code: verdict.ok ? (counted ? "ok: no readiness gap" : "readiness gap kept") : codeOf(verdict), codes: codesIn(verdict) };
    return { outcome: r2Outcome({ gateResult, reportedAccepted: ready, integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `inspect work readiness.ready ${ready}; feature-verdict ${verdict.ok ? (counted ? "counts the service as approved" : "still lists it as not approved") : short(verdict)}` };
  });
});

row("R2-field-contract", "T-repo", "every BA stage accepted and the story confirmed by the person, services set, contract proposed; the file sets status:agreed", async (fx) => {
  const wi = await withServer(fx, {}, async (s) => {
    const id = await genuineBA(s, fx.repo, "architecture");
    await servicesAndContract(s, fx.repo, id);
    return id;
  });
  forge(fx.repo, wi, (item) => {
    item.contracts.find((c) => c.id === "C-ORDERS").status = "agreed";
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "work", "C-ORDERS");
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "development" });
    const agreed = readItem(fx.repo, wi).contracts?.find((c) => c.id === "C-ORDERS")?.status === "agreed";
    return { outcome: r2Outcome({ gateResult, reportedAccepted: agreed, integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `advance-phase development ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-replay", "T-repo", "the person accepted every criterion, then rejected AC-02; AC-01's genuine acceptance (all its fields) is copied onto AC-02", async (fx) => {
  const wi = await withServer(fx, {}, (s) => acceptedThenRejected(s, fx.repo));
  forge(fx.repo, wi, (item) => {
    const list = item.requirements[0].acceptanceCriteria;
    const source = list.find((x) => x.id === AC1);
    const target = list.find((x) => x.id === AC2);
    // everything that is not the criterion's identity or text: its review and any evidence field a Runtime stores beside it
    for (const [key, value] of Object.entries(source)) if (!["id", "statement", "revision", "requirementId"].includes(key)) target[key] = JSON.parse(JSON.stringify(value));
    // and the reference the file keeps elsewhere for AC-01 (49.3: acceptanceActions["criterion:<id>"] = actionId), under AC-02's key
    for (const map of Object.values(item)) {
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const key of Object.keys(map)) if (key.endsWith(AC1)) map[key.slice(0, -AC1.length) + AC2] = JSON.parse(JSON.stringify(map[key]));
    }
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", AC2);
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const reportedAccepted = criterionIn(report.inspect, AC2)?.review?.status === "accepted";
    return { outcome: r2Outcome({ gateResult, reportedAccepted, integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `inspect AC-02 ${criterionIn(report.inspect, AC2)?.review?.status}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-stale", "T-repo", "the person accepted the requirements; the file rewrites AC-01's text and recomputes the phase fingerprint", async (fx) => {
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    await acceptAll(s, fx.repo, id);
    return id;
  });
  forge(fx.repo, wi, (item) => {
    item.requirements[0].acceptanceCriteria.find((x) => x.id === AC1).statement = "The list shows every order of every customer, including deleted ones";
    item.phaseAcceptance.requirements_review = { ...item.phaseAcceptance.requirements_review, fingerprint: contracts.currentFingerprint(item, "requirements_review") };
  });
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", AC1);
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const c = criterionIn(report.inspect, AC1);
    return { outcome: r2Outcome({ gateResult, reportedAccepted: c?.review?.status === "accepted", integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `inspect AC-01 "${c?.statement?.slice(0, 40)}..." ${c?.review?.status}; acceptance ${report.inspect.data?.requirementReview?.acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-supersede", "T-repo", "the person accepted rev1, then approved a rewording of AC-01 (rev2, pending); the rev1 file is restored", async (fx) => {
  let snapshot;
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    await acceptAll(s, fx.repo, id);
    snapshot = readFileSync(itemPath(fx.repo, id), "utf8");
    await must(s, fx.repo, { action: "revise-acceptance", edits: [{ id: AC1, statement: "The list shows the orders of the manager's region" }] }, id);
    return id;
  });
  const revised = readItem(fx.repo, wi).requirements[0].acceptanceCriteria.find((x) => x.id === AC1);
  writeFileSync(itemPath(fx.repo, wi), snapshot);
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", AC1);
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const c = criterionIn(report.inspect, AC1);
    return { outcome: r2Outcome({ gateResult, reportedAccepted: c?.review?.status === "accepted", integrity: report.integrity }), gate: gateResult.code, codes: gateResult.codes, integrity: report.integrity, summaries: report.summaries, detail: `legitimate revision left AC-01 rev${revised?.revision} ${revised?.review?.status}; restored rev${c?.revision} reads ${c?.review?.status}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

/** The ledger files a Runtime keeps for a repository under a home: <home>/.praxis/ledger/<key>* (a file or a folder of files). */
function ledgerFilesFor(home, repo) {
  const dir = join(home, ".praxis", "ledger");
  if (!existsSync(dir)) return [];
  const keys = repoKeys(repo);
  return readdirSync(dir)
    .filter((name) => keys.some((k) => name.startsWith(k)))
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? readdirSync(p).map((f) => join(p, f)).filter((f) => statSync(f).isFile()) : [p];
    });
}

row("R2-journal", "T-repo / T-same-user", "the forged file of R2-field-phase-acceptance, plus forged 'approved' lines appended to the 49.2 journal and to the repository's ledger file (unchained), plus a mid-file tamper of a genuine ledger record", async (fx) => {
  const notes = [];
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    // two genuine decisions so a ledger (49.3) holds more than one record: one to tamper with mid-file
    await markCriterion(s, fx.repo, id, AC1, "accepted");
    await markCriterion(s, fx.repo, id, AC1, "pending");
    return id;
  });
  forge(fx.repo, wi, forgeRequirementsAccepted);
  // the 49.2 journal: $PRAXIS_STATE_HOME/decisions/<sha256(resolve(repo))[0..16]>.jsonl
  const journal = join(fx.state, "decisions", `${sha256(resolve(fx.repo)).slice(0, 16)}.jsonl`);
  mkdirSync(dirname(journal), { recursive: true });
  for (const action of ["review-decisions", "praxis_workflow_apply", "praxis_review_apply"]) appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), repository: resolve(fx.repo), action, subjectDigest: sha256(`forged-${action}`), decision: "approved", decidedBy: "client-dialog", channel: "client-elicitation" })}\n`);
  notes.push("49.2 journal: 3 forged lines");
  // the 49.3 journal (<account home>/.praxis/decisions/<repositoryKey>.jsonl), when this row's server wrote one for its repository
  const keys = repoKeys(fx.repo);
  const journals = existsSync(join(accountPraxis, "decisions")) ? readdirSync(join(accountPraxis, "decisions")).filter((f) => keys.some((k) => f.startsWith(k))) : [];
  for (const f of journals) appendFileSync(join(accountPraxis, "decisions", f), `${JSON.stringify({ v: 2, at: new Date().toISOString(), action: "review-decisions", decision: "approved", decidedBy: "client-dialog", channel: "client-elicitation", personVerified: false, independentlyVerified: false })}\n`);
  if (journals.length) notes.push(`49.3 journal ~/.praxis/decisions/${journals[0].slice(0, 12)}...: 1 forged line`);
  // the ledger (49.3): under the account home in a production bundle, under the fixture HOME in a test bundle
  for (const home of [accountHome, fx.home]) {
    const files = ledgerFilesFor(home, fx.repo);
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const tamper = lines.length >= 2;
      // mid-file tamper: the first genuine record now names AC-02 instead of AC-01; its chain fields are left as they were
      if (tamper) lines[0] = lines[0].includes(AC1) ? lines[0].split(AC1).join(AC2) : JSON.stringify({ ...JSON.parse(lines[0]), forged: true });
      // an appended record that does not chain (prev is not the hash of the line before)
      lines.push(JSON.stringify({ v: 1, seq: lines.length + 1, prev: "0".repeat(64), at: new Date().toISOString(), workItemId: wi, subject: { kind: "criterion", id: AC2, revision: 1 }, contentDigest: `sha256:${sha256("forged")}`, decision: "accept", actionId: randomBytes(16).toString("hex"), batchId: randomBytes(8).toString("hex"), approval: null, assurance: "client-response" }));
      writeFileSync(file, `${lines.join("\n")}\n`);
      notes.push(`ledger ${file.startsWith(accountHome) ? "~" + file.slice(accountHome.length) : file.replace(fx.base, "<fx>")}: ${tamper ? "record 1 tampered, " : ""}1 unchained record appended`);
    }
  }
  if (!notes.some((n) => n.startsWith("ledger"))) notes.push("no ledger file for this repository (none kept by this bundle)");
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", "requirements_review");
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const acceptance = report.inspect.data?.requirementReview?.acceptance;
    const integrity = [...new Set([...report.integrity, ...integrityOf(AC1, report.inspect, report.all), ...integrityOf(AC2, report.inspect, report.all), ...(INTEGRITY.includes(acceptance) && acceptance !== "accepted" ? [acceptance] : [])])];
    return { outcome: r2Outcome({ gateResult, reportedAccepted: acceptance === "accepted", integrity }), gate: gateResult.code, codes: gateResult.codes, integrity, summaries: report.summaries, detail: `${notes.join("; ")}; acceptance ${acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}. Not tested, by design: a well-formed record appended with a correct chain by T-same-user is not detectable locally` };
  });
});

row("R2-clone", "T-repo", "the person accepted the requirements; the repository is copied to a new path (a new git common dir) and read there", async (fx) => {
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    await acceptAll(s, fx.repo, id);
    return id;
  });
  const clone = join(fx.base, "clone");
  cpSync(fx.repo, clone, { recursive: true });
  fx.repos.push(clone);
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, clone, wi, "requirements", "requirements_review");
    const gateResult = await gate(s, clone, wi, { action: "advance-phase", to: "prototype" });
    const acceptance = report.inspect.data?.requirementReview?.acceptance;
    const integrity = [...new Set([...report.integrity, ...integrityOf(AC1, report.inspect, report.all), ...(INTEGRITY.includes(acceptance) && acceptance !== "accepted" ? [acceptance] : [])])];
    return { outcome: r2Outcome({ gateResult, reportedAccepted: acceptance === "accepted", integrity }), gate: gateResult.code, codes: gateResult.codes, integrity, summaries: report.summaries, detail: `in the copy: acceptance ${acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R2-statehome-in-repo", "T-repo", "PRAXIS_STATE_HOME=<repo>/.x and HOME=<repo> (what a repository's settings env can set), forged ledger/journal lines planted there, and the forged file", async (fx) => {
  const env = { PRAXIS_STATE_HOME: join(fx.repo, ".x"), HOME: fx.repo };
  // 1. a genuine acceptance attempt under that environment
  const first = await withServer(fx, { env }, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    let accepted;
    try {
      accepted = await acceptAll(s, fx.repo, id);
    } catch (error) {
      accepted = refusal(error);
    }
    return { id, accepted };
  });
  const wi = first.id;
  // 2. the attacker plants evidence where that environment points and forges the file
  // (HOME=<repo>: <repo>/.praxis/ledger/<key>/<work item>.jsonl is where a bundle honouring HOME would read its ledger)
  for (const p of [join(fx.repo, ".x", "decisions", `${sha256(resolve(fx.repo)).slice(0, 16)}.jsonl`), ...repoKeys(fx.repo).map((k) => join(fx.repo, ".praxis", "ledger", k, `${wi}.jsonl`))]) {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ v: 1, seq: 1, prev: "0".repeat(64), at: new Date().toISOString(), workItemId: wi, repository: resolve(fx.repo), action: "review-decisions", decision: "accept", subject: { kind: "phase", id: "requirements_review" }, contentDigest: `sha256:${sha256("forged")}`, actionId: randomBytes(16).toString("hex"), channel: "client-elicitation", decidedBy: "client-dialog" })}\n`);
  }
  forge(fx.repo, wi, forgeRequirementsAccepted);
  return withServer(fx, { env }, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", "requirements_review");
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const acceptance = report.inspect.data?.requirementReview?.acceptance;
    const integrity = [...new Set([...report.integrity, ...integrityOf(AC1, report.inspect, report.all), ...(INTEGRITY.includes(acceptance) && acceptance !== "accepted" ? [acceptance] : [])])];
    return { outcome: r2Outcome({ gateResult, reportedAccepted: acceptance === "accepted", integrity }), gate: gateResult.code, codes: [...new Set([...gateResult.codes, ...codesIn(first.accepted)])], integrity, summaries: report.summaries, detail: `genuine accept under that env: ${short(first.accepted)}; forged: acceptance ${acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
});

row("R1-self-approval", "T-same-user", "the harness's own MCP client (elicitation declared, answers approve) accepts criteria (review_apply) and confirms a story (workflow_apply)", async (fx) => {
  return withServer(fx, {}, async (s) => {
    const wi = await openItem(s, fx.repo, { mode: "classic" });
    const accepted = await acceptAll(s, fx.repo, wi);
    await must(s, fx.repo, { action: "set-story-plan", entries: [{ id: STORY, title: "Order search", implementation: "list page", userGets: "orders", requirementIds: [REQ], capabilities: [] }] }, wi);
    await must(s, fx.repo, { action: "add-story", id: STORY, requirementIds: [REQ], actor: "manager", narrative: "As a manager, I want orders, so that I see them.", objective: "o", userValue: "v", happyPath: ["open", "search"], acceptanceCriteria: [{ id: `${STORY}-AC-01`, given: "g", when: "w", then: "t" }], expectedResults: ["shown"], confirmedBehavior: false }, wi);
    const confirmed = await confirmStory(s, fx.repo, wi);
    const item = readItem(fx.repo, wi);
    const ran = item.requirements[0].acceptanceCriteria.every((c) => c.review.status === "accepted") && item.stories[0].confirmedBehavior === true;
    const both = [labelsIn(accepted), labelsIn(confirmed)];
    // a verification label counts only when both results carry it with the same value
    const labels = Object.fromEntries(["personVerified", "independentlyVerified"].map((k) => [k, both.every((l) => k in l) && both[0][k] === both[1][k] ? both[0][k] : undefined]));
    return { outcome: ran ? "vulnerable" : "protected", gate: ran ? "self-approval recorded" : "refused", codes: [...codesIn(accepted), ...codesIn(confirmed)], labels, detail: `dialog asked ${s.asked.length}x, answered by the harness; criteria ${ran ? "accepted" : "not accepted"}, story ${item.stories[0].confirmedBehavior ? "confirmed" : "unconfirmed"}; labels on the results: ${JSON.stringify(both)}` };
  });
});

/**
 * T-sandboxed-agent, played with sandbox-exec: the attacker's server may write anywhere but <account home>/.praxis. `ps`:
 * a seatbelt sandbox cannot exec the setuid /bin/ps, which the Runtime runs to read its client's launch flags, so a plain
 * profile makes every protected act fail closed for that reason alone (R1-sandboxed-strict). R1-sandboxed lets /bin/ps run
 * outside the sandbox, as `ps` does run inside a Linux sandbox, so the row exercises what it is about: the ledger.
 */
const sandboxProfile = (allowPs) => `(version 1)(allow default)${allowPs ? '(allow process-exec (literal "/bin/ps") (with no-sandbox))' : ""}(deny file-write* (subpath ${JSON.stringify(join(accountHome, ".praxis"))}))`;
async function sandboxedSelfApproval(fx, allowPs) {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return { outcome: "skipped", detail: `SKIP: sandbox-exec is macOS only (platform ${process.platform}); no Linux stand-in (a read-only bind of the ledger folder needs privileges this job does not take)` };
  const profile = sandboxProfile(allowPs);
  const inside = await withServer(fx, { sandbox: profile }, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders", "A manager can search orders by number"] });
    await must(s, fx.repo, { action: "advance-phase", to: "requirements_review" }, id);
    let accepted;
    try {
      accepted = await acceptAll(s, fx.repo, id);
    } catch (error) {
      accepted = refusal(error);
    }
    return { id, accepted };
  });
  const wi = inside.id;
  return withServer(fx, {}, async (s) => {
    const report = await reportOn(s, fx.repo, wi, "requirements", "requirements_review");
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "prototype" });
    const acceptance = report.inspect.data?.requirementReview?.acceptance;
    const integrity = [...new Set([...report.integrity, ...integrityOf(AC1, report.inspect, report.all), ...(INTEGRITY.includes(acceptance) && acceptance !== "accepted" ? [acceptance] : [])])];
    return { outcome: r2Outcome({ gateResult, reportedAccepted: acceptance === "accepted", integrity }), gate: gateResult.code, codes: [...new Set([...codesIn(inside.accepted), ...gateResult.codes])], integrity, summaries: report.summaries, detail: `${allowPs ? "/bin/ps allowed outside the sandbox" : "plain seatbelt (/bin/ps cannot run)"}; sandboxed accept: ${short(inside.accepted)}; unsandboxed read: acceptance ${acceptance}; advance-phase prototype ${gateResult.open ? "OPEN" : gateResult.code}` };
  });
}
row("R1-sandboxed", "T-sandboxed-agent", "the self-approval of R1-self-approval with the attacker's server under sandbox-exec, file-write* denied to <account home>/.praxis (/bin/ps allowed to run outside the sandbox); then an unsandboxed server reads the repository", (fx) => sandboxedSelfApproval(fx, true));
row("R1-sandboxed-strict", "T-sandboxed-agent", "as R1-sandboxed with a plain seatbelt profile: /bin/ps (setuid) cannot run inside it, as in a real macOS sandbox", (fx) => sandboxedSelfApproval(fx, false));

const PRIVILEGE_ENV = { PRAXIS_TEST_APPROVALS: "1", PRAXIS_TEST_ANCESTRY: "harness", PRAXIS_BUNDLE_KIND: "test", PRAXIS_APPROVAL_MODE: "trusted-client", PRAXIS_TEST_REVIEW_NO_BROWSER: "1", PRAXIS_APPROVAL_MIN_ANSWER_MS: "0", PRAXIS_APPROVAL_FORGED: "1", PRAXIS_APPROVAL_STRICT: "0" };
row("R1-env-privilege", "T-repo", "test and approval switches in the server env and in the repository's .claude/settings.json env; clients without a dialog and with a declining dialog try protected acts", async (fx) => {
  writeFileSync(join(fx.repo, ".env"), Object.entries(PRIVILEGE_ENV).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  mkdirSync(join(fx.repo, ".claude"), { recursive: true });
  writeFileSync(join(fx.repo, ".claude", "settings.json"), JSON.stringify({ env: PRIVILEGE_ENV }));
  // an unprotected item to act on, made by the harness's own dialog client without the switches
  const wi = await withServer(fx, {}, async (s) => {
    const id = await openItem(s, fx.repo, { criteria: ["The list shows orders"] });
    await must(s, fx.repo, { action: "record-decision", id: "D-001", statement: "Search by exact number" }, id);
    return id;
  });
  const before = readFileSync(itemPath(fx.repo, wi), "utf8");
  const attempts = [];
  for (const client of ["chat", "decline"]) {
    await withServer(fx, { client, env: PRIVILEGE_ENV }, async (s) => {
      const init = await s.call("praxis_project_init_apply", { repo: fx.repo, confirmation: "YES" });
      attempts.push(`${client} project_init_apply ${short(init).slice(0, 60)}`);
      const d = (await s.call("praxis_workflow_inspect", { repo: fx.repo, workItemId: wi, view: "decisions" })).data?.decisions?.decisions?.[0];
      const confirm = await run(s, fx.repo, { action: "confirm-decision", id: "D-001", revision: d?.revision ?? 1, contentFingerprint: d?.contentFingerprint ?? "x" }, wi);
      attempts.push(`${client} confirm-decision ${short(confirm).slice(0, 60)}`);
      // a submission as current as a page would send (fingerprint and stamp of the live item): only the dialog is missing
      const live = readItem(fx.repo, wi);
      const page = await s.call("praxis_review_apply", { repo: fx.repo, workItemId: wi, confirmation: "YES", submission: JSON.stringify({ contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: wi, baseFingerprint: contracts.fingerprintFor(live, "requirements"), baseStamp: contracts.reviewStamp(live, "requirements"), requirements: { requirements: [], acceptAll: true } }) });
      attempts.push(`${client} review_apply ${short(page).slice(0, 60)}`);
      const open = await run(s, fx.repo, { action: "open", projectId: "orders", title: "Classic", request: "r", mode: "classic" });
      attempts.push(`${client} open classic ${short(open).slice(0, 60)}`);
    });
  }
  const after = readFileSync(itemPath(fx.repo, wi), "utf8");
  const item = JSON.parse(after);
  const ran = existsSync(join(fx.repo, ".project")) || item.decisions[0].confirmed === true || item.requirements[0].acceptanceCriteria.some((c) => c.review.status === "accepted") || readdirSync(join(fx.repo, ".praxis", "workflow", "items")).length > 1;
  return { outcome: ran ? "vulnerable" : "protected", gate: ran ? "a protected act ran" : "every protected act refused", codes: [], detail: `${attempts.join("; ")}; item ${after === before ? "unchanged" : "changed"}` };
});

/** Every fake secret's forms a response could carry: the value, and the Basic credential a client builds from it. */
const secretForms = (values, email) => values.flatMap((v) => [v, Buffer.from(`${email}:${v}`).toString("base64"), Buffer.from(v).toString("base64")]);
const fakeToken = (kind) => `praxis-fake-token-${kind}-${randomBytes(6).toString("hex")}`;

row("CRED-redaction", "T-repo", "fake Jira/GitHub/GitLab tokens in the server env: doctor, status, previews and a failing Jira call; no response and no stderr may carry them", async (fx) => {
  const env = { PRAXIS_JIRA_TOKEN: fakeToken("jira"), PRAXIS_JIRA_EMAIL: "harness@example.test", PRAXIS_JIRA_BASE_URL: "http://127.0.0.1:9", PRAXIS_JIRA_PROJECT_KEY: "PRX", PRAXIS_GITHUB_TOKEN: fakeToken("github"), GITHUB_TOKEN: fakeToken("gh"), GH_TOKEN: fakeToken("ghcli"), GITLAB_TOKEN: fakeToken("gitlab") };
  const secrets = secretForms([env.PRAXIS_JIRA_TOKEN, env.PRAXIS_GITHUB_TOKEN, env.GITHUB_TOKEN, env.GH_TOKEN, env.GITLAB_TOKEN], env.PRAXIS_JIRA_EMAIL);
  const calls = [];
  await withServer(fx, { env }, async (s) => {
    const wi = await openItem(s, fx.repo);
    for (const [tool, args] of [
      ["praxis_doctor", { repo: fx.repo }],
      ["praxis_workflow_status", { repo: fx.repo, workItemId: wi }],
      ["praxis_workflow_inspect", { repo: fx.repo, workItemId: wi, view: "all" }],
      ["praxis_workflow_preview", { repo: fx.repo, workItemId: wi, command: JSON.stringify({ action: "add-requirement", id: "REQ-ORD-002", statement: "Export orders", acceptanceCriteria: ["CSV has a header"] }) }],
      ["praxis_project_init_preview", { repo: fx.repo }],
      ["praxis_developer_git_preview", { repo: fx.repo, workPackage: "WP-ORD-001" }],
      ["praxis_developer_git_connect_preview", { repo: fx.repo, workPackage: "WP-ORD-001", provider: "github", remoteUrl: "https://example.test/acme/orders.git" }],
      ["praxis_capabilities", { request: "accept the requirements review" }],
      ["praxis_session_start", { repo: fx.repo, role: "ba" }],
      ["praxis_jira_smoke", { repo: fx.repo }],
      ["praxis_jira_status", { repo: fx.repo, epic: "PRX-1" }],
      ["praxis_ba_status", { repo: fx.repo, epic: "PRX-1" }],
    ]) {
      const r = await s.call(tool, args);
      calls.push(`${tool} ${r.ok ? "ok" : codeOf(r)}`);
    }
  });
  const responses = JSON.stringify(fx.transcript.map((t) => t.raw));
  const stderr = fx.stderr.join("\n");
  const leaks = secrets.filter((v) => responses.includes(v) || stderr.includes(v));
  return { outcome: leaks.length ? "vulnerable" : "protected", gate: leaks.length ? `${leaks.length} secret form(s) leaked` : "no fake secret in any response or stderr", codes: [], detail: `${calls.join(", ")}; ${responses.length} response bytes, ${stderr.length} stderr bytes scanned` };
});

row("CRED-redirect", "T-repo", "the repository's .env, .env.praxis and .project point the Jira base URL at a capture server; the token comes from the server env", async (fx) => {
  const captured = [];
  const capture = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => capture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${capture.address().port}`;
  try {
    const env = { PRAXIS_JIRA_TOKEN: fakeToken("jira"), PRAXIS_JIRA_EMAIL: "harness@example.test", PRAXIS_JIRA_PROJECT_KEY: "PRX" };
    const secrets = secretForms([env.PRAXIS_JIRA_TOKEN], env.PRAXIS_JIRA_EMAIL);
    for (const file of [".env", ".env.praxis", ".env.praxis.local"]) writeFileSync(join(fx.repo, file), `PRAXIS_JIRA_BASE_URL=${url}\nPRAXIS_JIRA_EMAIL=attacker@example.test\nPRAXIS_JIRA_PROJECT_KEY=PRX\n`);
    writeFileSync(join(fx.repo, ".project"), `jira:\n  baseUrl: ${url}\n  projectKey: PRX\n`);
    mkdirSync(join(fx.repo, ".praxis"), { recursive: true });
    writeFileSync(join(fx.repo, ".praxis", "config.json"), JSON.stringify({ jira: { baseUrl: url, projectKey: "PRX" } }));
    const calls = [];
    await withServer(fx, { env }, async (s) => {
      for (const [tool, args] of [["praxis_doctor", { repo: fx.repo }], ["praxis_jira_smoke", { repo: fx.repo }], ["praxis_jira_discover", { repo: fx.repo }], ["praxis_jira_epic", { repo: fx.repo, epic: "PRX-1" }], ["praxis_jira_status", { repo: fx.repo, epic: "PRX-1" }]]) {
        const r = await s.call(tool, args);
        calls.push(`${tool} ${r.ok ? "ok" : codeOf(r)}`);
      }
    });
    await sleep(200);
    const seen = JSON.stringify(captured);
    const leaked = secrets.filter((v) => seen.includes(v));
    return { outcome: leaked.length ? "vulnerable" : "protected", gate: leaked.length ? "the capture server received the token" : `capture server: ${captured.length} request(s), no token`, codes: [], detail: `${calls.join(", ")}; requests to the repository's URL: ${captured.length}${captured.length ? ` (${captured.map((c) => `${c.method} ${c.url} auth:${c.headers.authorization ? "present" : "none"}`).join(", ").slice(0, 200)})` : ""}` };
  } finally {
    capture.close();
  }
});

row("COMPAT-doctor", "-", "praxis_doctor on a fresh repository", async (fx) => {
  return withServer(fx, {}, async (s) => {
    const r = await s.call("praxis_doctor", { repo: fx.repo });
    return { outcome: r.ok ? "works" : "broken", gate: short(r), codes: codesIn(r), detail: `doctor ${short(r)}; version ${r.version ?? "?"}` };
  });
});

row("COMPAT-workflow", "-", "open a work item, add a requirement, preview, status, inspect", async (fx) => {
  return withServer(fx, {}, async (s) => {
    const wi = await openItem(s, fx.repo, { criteria: ["The list shows orders"] });
    const preview = await s.call("praxis_workflow_preview", { repo: fx.repo, workItemId: wi, command: JSON.stringify({ action: "add-requirement", id: "REQ-ORD-002", statement: "Export orders", acceptanceCriteria: ["CSV has a header"] }) });
    const status = await s.call("praxis_workflow_status", { repo: fx.repo, workItemId: wi });
    const inspect = await s.call("praxis_workflow_inspect", { repo: fx.repo, workItemId: wi, view: "requirements" });
    const ok = preview.ok && status.ok && status.data?.requirementIds?.includes(REQ) && inspect.ok && criterionIn(inspect, AC1)?.review?.status === "pending";
    return { outcome: ok ? "works" : "broken", gate: ok ? "ok" : `preview ${short(preview)}, status ${short(status)}, inspect ${short(inspect)}`, codes: [], detail: `item ${wi}; preview ${short(preview)}; status ${short(status)}; inspect ${short(inspect)}` };
  });
});

row("COMPAT-read-only", "-", "read-only tools: capabilities, project status, session start, status, every inspect view, commands, approval plan", async (fx) => {
  return withServer(fx, { client: "chat" }, async (s) => {
    const results = [];
    const wi = await (async () => {
      const r = await run(s, fx.repo, { action: "open", projectId: "orders", title: "Order search", request: "r", mode: "guided" });
      return r.data?.workItemId;
    })();
    for (const [tool, args] of [
      ["praxis_capabilities", { request: "accept the requirements review" }],
      ["praxis_project_status", { repo: fx.repo }],
      ["praxis_session_start", { repo: fx.repo, role: "ba" }],
      ["praxis_workflow_status", { repo: fx.repo }],
      ["praxis_workflow_commands", {}],
      ["praxis_approval_plan", { repo: fx.repo, tool: "praxis_project_init_apply", toolArguments: "{}" }],
      ...["overview", "requirements", "stories", "decisions", "work", "handoffs", "open-items", "quality", "links", "approvals", "all"].map((view) => ["praxis_workflow_inspect", { repo: fx.repo, workItemId: wi, view }]),
    ]) {
      const r = await s.call(tool, args);
      results.push([`${tool}${args.view ? `:${args.view}` : ""}`, r.ok]);
    }
    const broken = results.filter(([, ok]) => !ok).map(([name]) => name);
    return { outcome: wi && broken.length === 0 ? "works" : "broken", gate: broken.length ? `failed: ${broken.join(", ")}` : `${results.length} read-only calls ok`, codes: [], detail: `client without a dialog; ${results.length} calls; ${broken.length ? `failed: ${broken.join(", ")}` : "all ok"}` };
  });
});

row("COMPAT-e2e-accept", "-", "a genuine end-to-end: requirements, prototype, story plan, stories accepted, the story confirmed, a contract agreed by the person; every gate passes", async (fx) => {
  return withServer(fx, {}, async (s) => {
    const wi = await genuineBA(s, fx.repo, "architecture");
    await servicesAndContract(s, fx.repo, wi);
    await userSave(s, fx.repo, wi, "contracts", { contracts: { agree: ["C-ORDERS"] } });
    const gateResult = await gate(s, fx.repo, wi, { action: "advance-phase", to: "development" });
    const report = await reportOn(s, fx.repo, wi, "stories", STORY);
    const integrity = [...new Set([...report.integrity, ...integrityOf(AC1, report.all), ...integrityOf("C-ORDERS", report.all)])];
    return { outcome: gateResult.open ? "works" : "broken", gate: gateResult.code, codes: gateResult.codes, integrity, summaries: report.summaries, detail: `requirements, prototype, plan, stories accepted; story confirmed; contract agreed; advance-phase development ${gateResult.open ? "ok" : gateResult.code}; dialog asked ${s.asked.length}x` };
  });
});

// --- running and judging ------------------------------------------------------------------------------------------------

function judge(id, observed) {
  const expected = EXPECTATIONS[id]?.[expectMode];
  if (!expected) return { verdict: "FAIL", why: "no expectation for this row" };
  if (observed.outcome === "skipped") return { verdict: "SKIP", why: observed.detail };
  if (observed.outcome === "error") return { verdict: "FAIL", why: observed.detail };
  const why = [];
  if (observed.outcome !== expected.outcome) why.push(`outcome ${observed.outcome}, expected ${expected.outcome}`);
  if (expected.codes && !expected.codes.some((c) => (observed.codes ?? []).includes(c))) why.push(`none of ${expected.codes.join("|")} in ${JSON.stringify(observed.codes ?? [])}`);
  if (expected.integrity && !expected.integrity.some((x) => (observed.integrity ?? []).includes(x))) why.push(`integrity ${JSON.stringify(observed.integrity ?? [])}, expected one of ${expected.integrity.join("|")}`);
  for (const [k, v] of Object.entries(expected.labels ?? {})) if ((observed.labels ?? {})[k] !== v) why.push(`label ${k}=${JSON.stringify((observed.labels ?? {})[k])}, expected ${JSON.stringify(v)}`);
  return { verdict: why.length ? "FAIL" : "PASS", why: why.join("; ") };
}

const startedAt = new Date().toISOString();
const results = [];
// what each row's servers were asked and answered (fake secrets only), for whoever reads a FAIL
const transcripts = join(out, "transcripts");
rmSync(transcripts, { recursive: true, force: true });
mkdirSync(transcripts, { recursive: true });
for (const r of ROWS.filter((x) => !only.length || only.includes(x.id))) {
  const fx = fixture(r.id);
  const homeBefore = listHome();
  const started = Date.now();
  let observed;
  try {
    observed = await r.run(fx);
  } catch (error) {
    observed = { outcome: "error", detail: `ERROR: ${String(error?.stack ?? error).slice(0, 600)}` };
  }
  // the account home: what this row's servers created there, removed when it is the harness's own (its repositories' keys)
  const keys = fx.repos.flatMap(repoKeys);
  for (const entry of [...listHome()].filter((e) => !homeBefore.has(e))) {
    const name = entry.split("/").pop();
    const path = join(accountPraxis, entry);
    if (keys.some((k) => name.startsWith(k))) {
      homeLedger.created.push(path);
      rmSync(path, { recursive: true, force: true });
      homeLedger.removed.push(path);
    } else homeLedger.foreign.push(path);
  }
  const { verdict, why } = judge(r.id, observed);
  const expected = EXPECTATIONS[r.id] ?? {};
  results.push({ id: r.id, tier: r.tier, attack: r.attack, expected: { baseline: expected.baseline, fixed: expected.fixed }, observed, verdict, why, seconds: Math.round((Date.now() - started) / 100) / 10 });
  console.error(`  ${verdict.padEnd(4)} ${r.id.padEnd(26)} ${observed.outcome.padEnd(11)} ${String(observed.detail ?? "").slice(0, 220)}${why ? ` | ${why}` : ""}`);
  writeFileSync(join(transcripts, `${r.id}.json`), `${JSON.stringify({ transcript: fx.transcript.map((t) => ({ tool: t.tool, args: t.args, result: parseDoctorEnvelope(t.raw) ?? t.raw })), stderr: fx.stderr }, null, 1)}\n`);
}
// a folder a server created there for the harness's entries only (none existed before the run) goes too, once empty
for (const dir of [...LEDGER_DIRS.map((d) => join(accountPraxis, d)), accountPraxis]) {
  if (homeDirsBefore.has(dir) || !existsSync(dir) || readdirSync(dir).length) continue;
  homeLedger.created.push(dir);
  rmSync(dir, { recursive: true, force: true });
  homeLedger.removed.push(dir);
}
if (!keep) rmSync(work, { recursive: true, force: true });

const summary = results.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
const report = { label, bundle, bundleSha256, expect: expectMode, startedAt, finishedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, accountHome: homeLedger, summary, rows: results };
writeFileSync(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [
  `# R1/R2 regression: ${label}`,
  "",
  `Bundle \`${bundle}\` (sha256 \`${bundleSha256}\`), expectations: **${expectMode}**, ${report.platform}, node ${process.version}, ${startedAt}.`,
  "",
  `Result: ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(", ")}. Every dialog answer was the harness standing in for the person (a scripted test action).`,
  "",
  "| Row | Tier | Attack | Expected (baseline 49.2) | Expected (fixed 49.3) | Observed | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.id} | ${cell(r.tier)} | ${cell(r.attack)} | ${cell(r.expected.baseline ? `${r.expected.baseline.outcome}${r.expected.baseline.text ? `: ${r.expected.baseline.text}` : ""}` : "")} | ${cell(r.expected.fixed ? `${r.expected.fixed.outcome}${r.expected.fixed.text ? `: ${r.expected.fixed.text}` : ""}` : "")} | ${cell(`${r.observed.outcome}: ${r.observed.detail ?? ""}${r.observed.integrity?.length ? ` [integrity ${r.observed.integrity.join(",")}]` : ""}`)} | ${r.verdict}${r.why ? ` (${cell(r.why)})` : ""} |`),
  "",
  `Account home (${accountPraxis}): created ${homeLedger.created.length}, removed ${homeLedger.removed.length}, new entries not the harness's own (left untouched) ${homeLedger.foreign.length}.`,
  ...homeLedger.created.map((p) => `- created and removed: \`${p}\``),
  ...homeLedger.foreign.map((p) => `- not ours, untouched: \`${p}\``),
  "",
];
writeFileSync(join(out, "results.md"), `${md.join("\n")}\n`);
console.log(JSON.stringify(summary));
console.log(`results: ${join(out, "results.md")}`);
process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
