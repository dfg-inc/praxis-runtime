#!/usr/bin/env node
/**
 * Secure Git authorization through the packaged MCPB, end to end.
 *
 * WHAT IS REAL
 *   - the packaged Runtime (a TEST VARIANT of the MCPB, see below), spoken to over the real MCP protocol
 *   - the real broker program, tools in praxis-core/tools/broker/praxis-broker.mjs, run as a separate process
 *     that alone holds the signing key; it shows nothing to a person here
 *   - real Git against temporary repositories and a bare remote; the hosting API is a local mock
 * WHAT IS A FIXTURE (and is labelled as one)
 *   - the human: the broker is told to sign with PRAXIS_BROKER_MACHINE_APPROVE=1. That path is the broker's
 *     test/automation channel; a person would approve with an authenticator at the operator page. Nothing here
 *     proves a person approved anything.
 *   - the keys: generated for this run, kept in a temp directory, never an operator key
 *   - the isolation: broker and Runtime run as the same OS user, so PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 is set. The
 *     test variant honours it; the PRODUCTION bundle does not (checked below). OS-level isolation is NOT proven.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, copyFileSync, cpSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateApprovalKeyPair } from "@praxis/contracts";
import { createMockGithubState } from "@praxis/vcs";
import { attachSshLikeRemote, buildConsumerLikeFixture, emptyBare, git, startGithubHttpMock, WP, writeFile } from "./git-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const split = resolve(root, "..");
const coreRoot = process.env.PRAXIS_CORE_ROOT ?? resolve(root, "../praxis-core");
const brokerScript = join(coreRoot, "tools/broker/praxis-broker.mjs");
const steps = [];
const blocked = [];

function fail(msg) {
  console.error(`FAIL git-authorization: ${msg}`);
  process.exit(1);
}
const ok = (name) => {
  steps.push(name);
  console.log(`  ok ${name}`);
};
const expect = (cond, msg) => cond || fail(msg);

if (!existsSync(brokerScript)) {
  console.log(`BLOCKED git-authorization: the real broker program is not at ${brokerScript} (set PRAXIS_CORE_ROOT)`);
  process.exit(2);
}

const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import("./official-mcp-client.mjs");

// --- artifacts: the test variant (honours the override) and the shipped production MCPB -------------------------
spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
const variantPack = await packClaudeExtension(version, { kind: "acceptance" });
const variantDir = mkdtempSync(join(tmpdir(), "praxis-ga-variant-"));
const variant = extractMcpbRuntime(variantPack.mcpbPath, variantDir);
const productionMcpb = join(root, "claude-extensions", "praxis-runtime.mcpb");
const productionDir = mkdtempSync(join(tmpdir(), "praxis-ga-prod-"));
const production = extractMcpbRuntime(productionMcpb, productionDir);

// --- the broker's world: trusted dir (key), shared inbox, ledger ---------------------------------------------------
const trusted = mkdtempSync(join(tmpdir(), "praxis-ga-trusted-"));
const shared = mkdtempSync(join(tmpdir(), "praxis-ga-shared-"));
const ledger = mkdtempSync(join(tmpdir(), "praxis-ga-ledger-"));
const keys = generateApprovalKeyPair();
writeFileSync(join(trusted, "private.pem"), keys.privateKeyPem, { mode: 0o600 });
writeFileSync(join(trusted, "public.pem"), keys.publicKeyPem);
writeFileSync(join(trusted, ".broker-identity"), "acceptance fixture broker\n");
const contractsEntry = join(root, "node_modules/@praxis/contracts/dist/index.js");

function broker(command, planId) {
  const r = spawnSync(process.execPath, [brokerScript, command, "--plan-id", planId, "--approver", "acceptance-owner"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PRAXIS_BROKER_TRUSTED_DIR: trusted,
      PRAXIS_BROKER_SHARED_DIR: shared,
      PRAXIS_APPROVAL_PRIVATE_KEY_PATH: join(trusted, "private.pem"),
      PRAXIS_BROKER_MACHINE_APPROVE: "1", // fixture: stands in for the owner's authenticated decision
      PRAXIS_CONTRACTS_ENTRY: contractsEntry,
    },
  });
  if ((r.status ?? 1) !== 0) fail(`broker ${command} ${planId}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}
const approve = (planId) => broker("approve", planId);
const reject = (planId) => broker("reject", planId);
const inbox = (kind) => (existsSync(join(shared, kind)) ? readdirSync(join(shared, kind)) : []);

// --- fixtures ---------------------------------------------------------------------------------------------------------
const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
const mock = await startGithubHttpMock(gh);
const fixture = buildConsumerLikeFixture();
const bare = emptyBare();
attachSshLikeRemote(fixture.repo, bare);
/** A fresh consumer-like repository with its own bare remote, with the Quality evidence for work package `wp`. */
function newFixture(wp = WP) {
  const f = buildConsumerLikeFixture();
  const b = emptyBare();
  attachSshLikeRemote(f.repo, b);
  if (wp !== WP) {
    const from = join(f.repo, "design", WP, "qa", "quality-review.json");
    const review = JSON.parse(readFileSync(from, "utf8"));
    mkdirSync(join(f.repo, "design", wp, "qa"), { recursive: true });
    writeFileSync(join(f.repo, "design", wp, "qa", "quality-review.json"), `${JSON.stringify({ ...review, workPackageId: wp }, null, 2)}\n`);
  }
  return { ...f, bare: b };
}
const REMOTE_IDENTITY = "github.com/hisagedru/praxis-acceptance-test";

const baseEnv = (dir) => ({
  ...hostedCleanEnv(dir),
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
  PRAXIS_SKIP_DOTENV: "1",
  PRAXIS_GITHUB_TOKEN: "test-token-not-a-real-pat",
  PRAXIS_GITHUB_API_URL: mock.apiUrl,
  PRAXIS_GIT_PROVIDER: "github",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "false",
});
const brokerEnv = {
  PRAXIS_BROKER_SHARED_DIR: shared,
  PRAXIS_APPROVAL_PUBLIC_KEY_PATH: join(trusted, "public.pem"),
  PRAXIS_APPROVAL_LEDGER: ledger,
  PRAXIS_TEST_ALLOW_SAME_IDENTITY: "1", // honoured by the test variant only
  PRAXIS_APPROVAL_PLAN_TTL_MS: "4000",
};
async function open(extracted, env, label) {
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: { ...baseEnv(extracted.dest), ...env },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: 30_000,
    clientVersion: version,
  });
  const call = async (name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }));
  return { session, call, label };
}

/** Everything a Git operation could have changed, so "no side effect" is a comparison, not a hope. */
function snapshot(repo, remote = bare) {
  return JSON.stringify({
    head: git(repo, ["rev-parse", "HEAD"]).stdout,
    branch: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout,
    status: git(repo, ["status", "--porcelain"]).stdout,
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout,
    remoteRefs: git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout,
    remoteUrl: git(repo, ["config", "--get", "remote.origin.url"]).stdout,
    pullRequests: gh.pullRequests ? gh.pullRequests.length : JSON.stringify(Object.keys(gh)).length,
  });
}
const noToken = (value, label) => {
  const text = JSON.stringify(value);
  expect(!/BEGIN (PRIVATE|PUBLIC) KEY|"signature"|authorizations/.test(text) && !text.includes(readFileSync(join(trusted, "private.pem"), "utf8").slice(30, 60)), `${label} leaked token or key material`);
};
const codeIs = (res, prefix, label) => expect(res?.ok === false && String(res.code ?? "").startsWith(prefix), `${label}: expected ${prefix}*, got ${JSON.stringify(res).slice(0, 300)}`);

let primary;
let withoutBroker;
let prodSession;
try {
  primary = await open(variant, brokerEnv, "test-variant");
  const { call } = primary;

  // 0. what is running
  const doctor = await call("praxis_doctor", { repo: fixture.repo });
  expect(doctor.data?.build?.kind === "acceptance" && doctor.data.build.tools?.count === 52, `variant identity ${JSON.stringify(doctor.data?.build)}`);
  expect(doctor.data.security?.mode === "secure", "variant must stay in secure mode");
  expect(doctor.data.security.deployment?.some((f) => f.id === "test-harness-override"), "the unisolated test override must be reported, not hidden");
  expect(!JSON.stringify(doctor).includes(keys.privateKeyPem.slice(40, 70)), "doctor leaked key material");
  ok("0. test variant runs in secure mode, reports the test override as an unisolated deployment, 52 tools");

  // 1. nothing approved yet: refused, plan proposed, nothing changes
  const baselinePreview = await call("praxis_developer_git_publish_preview", { workPackage: WP, repo: fixture.repo, mode: "baseline", provider: "github" });
  expect(baselinePreview.ok && baselinePreview.data.remoteIdentity === REMOTE_IDENTITY, `baseline preview ${JSON.stringify(baselinePreview).slice(0, 300)}`);
  const publishArgs = { workPackage: WP, repo: fixture.repo, mode: "baseline", confirmation: "YES", previewFingerprint: baselinePreview.data.previewFingerprint };
  const before = snapshot(fixture.repo);
  const noApproval = await call("praxis_developer_git_publish", publishArgs);
  codeIs(noApproval, "APPROVAL_REQUIRED", "publish without approval");
  const publishPlanId = noApproval.data?.planId;
  expect(/^git-git-push-[0-9a-f]{24}$/.test(publishPlanId ?? ""), `plan id ${publishPlanId}`);
  expect(snapshot(fixture.repo) === before, "an unapproved publish changed something");
  expect(inbox("pending").includes(`${publishPlanId}.json`) && inbox("authorizations").length === 0, "the exact plan must be pending and no token exist");
  const pendingPlan = JSON.parse(readFileSync(join(shared, "pending", `${publishPlanId}.json`), "utf8"));
  expect(pendingPlan.operations[0] === "git_push" && pendingPlan.instanceId === REMOTE_IDENTITY && pendingPlan.provider === "local" && pendingPlan.decisionKind === "git_operation", `plan binding ${JSON.stringify(pendingPlan).slice(0, 300)}`);
  expect(pendingPlan.actions[0].targets.some((t) => t.startsWith("refspec:") && t.includes(fixture.baselineSha)), "plan must bind the exact refspec and commit");
  noToken(noApproval, "unapproved response");
  ok("1. unapproved publish: APPROVAL_REQUIRED, exact plan proposed (operation, instance, refspec), repository and remote unchanged");

  // 2. the agent cannot approve: a self-made token in the inbox, or a pending plan, authorizes nothing
  mkdirSync(join(shared, "authorizations"), { recursive: true });
  writeFileSync(join(shared, "authorizations", `${publishPlanId}.token`), "forged-by-the-agent");
  const forged = await call("praxis_developer_git_publish", publishArgs);
  codeIs(forged, "APPROVAL", "forged token");
  expect(snapshot(fixture.repo) === before, "a forged token changed something");
  rmSync(join(shared, "authorizations", `${publishPlanId}.token`));
  const otherKey = generateApprovalKeyPair();
  const { signAuthorization, encodeAuthorization } = await import("@praxis/contracts");
  const body = { contract: "praxis.approval.authorization", version: 1, planId: publishPlanId, planFingerprint: pendingPlan.fingerprint, provider: "local", instanceId: pendingPlan.instanceId, operations: pendingPlan.operations, workItemIds: pendingPlan.workItemIds, repositories: pendingPlan.repositories, action: pendingPlan.actions[0].action, targets: pendingPlan.actions[0].targets, decisionKind: pendingPlan.decisionKind, content: pendingPlan.actions[0].content, contentDigest: (await import("@praxis/contracts")).approvedContentDigest(pendingPlan.actions[0].content), approver: "agent", issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), consumptionId: "c-forged-by-agent" };
  writeFileSync(join(shared, "authorizations", `${publishPlanId}.token`), encodeAuthorization(signAuthorization(body, otherKey.privateKeyPem)));
  codeIs(await call("praxis_developer_git_publish", publishArgs), "APPROVAL", "token signed by a key the Runtime does not trust");
  expect(snapshot(fixture.repo) === before, "a wrongly signed token changed something");
  rmSync(join(shared, "authorizations", `${publishPlanId}.token`));
  ok("2. a forged token and a well-formed token signed by another key authorize nothing");

  // 3. REJECT leaves everything untouched. Uses a separate request (another work package id) so the main flow stays open.
  const rejectWp = "WP-20260914-099";
  const rejectPreview = await call("praxis_developer_git_preview", { workPackage: rejectWp, repo: fixture.repo });
  expect(rejectPreview.ok, `reject preview ${JSON.stringify(rejectPreview).slice(0, 200)}`);
  const rejectArgs = { workPackage: rejectWp, repo: fixture.repo, confirmation: "YES", previewFingerprint: rejectPreview.data.previewFingerprint };
  const rejectProposal = await call("praxis_developer_git_commit", rejectArgs);
  codeIs(rejectProposal, "APPROVAL_REQUIRED", "commit proposal");
  reject(rejectProposal.data.planId);
  const afterReject = await call("praxis_developer_git_commit", rejectArgs);
  codeIs(afterReject, "APPROVAL_REJECTED", "commit after REJECT");
  expect(snapshot(fixture.repo) === before, "a rejected commit changed something");
  ok("3. REJECT: APPROVAL_REJECTED, HEAD, refs, tree and remote unchanged");

  // 4. approve the baseline publish: executes once, never returns the token, replays idempotently
  approve(publishPlanId);
  const published = await call("praxis_developer_git_publish", publishArgs);
  expect(published.ok && published.data?.ok !== false, `approved publish ${JSON.stringify(published).slice(0, 400)}`);
  expect(git(bare, ["rev-parse", "refs/heads/main"]).stdout === fixture.baselineSha, "baseline did not reach the remote main");
  noToken(published, "approved publish response");
  const afterPublish = snapshot(fixture.repo);
  const replay = await call("praxis_developer_git_publish", publishArgs);
  expect(replay.ok, `replay ${JSON.stringify(replay).slice(0, 300)}`);
  expect(snapshot(fixture.repo) === afterPublish, "replaying a completed approval changed something");
  expect(readdirSync(ledger).length === 1, `exactly one consumption expected, got ${readdirSync(ledger).length}`);
  ok("4. approved baseline publish ran once (remote main = baseline); replay returned the result and changed nothing; one ledger entry; no token in responses");

  // 5. commit: its approval is a commit approval, not a push approval
  const commitPreview = await call("praxis_developer_git_preview", { workPackage: WP, repo: fixture.repo });
  expect(commitPreview.ok && commitPreview.data.previewFingerprint, `commit preview ${JSON.stringify(commitPreview).slice(0, 300)}`);
  const commitArgs = { workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: commitPreview.data.previewFingerprint };
  const commitProposal = await call("praxis_developer_git_commit", commitArgs);
  codeIs(commitProposal, "APPROVAL_REQUIRED", "commit proposal");
  const commitPlanId = commitProposal.data.planId;
  expect(/^git-git-commit-/.test(commitPlanId), `commit plan id ${commitPlanId}`);
  const headBefore = git(fixture.repo, ["rev-parse", "HEAD"]).stdout;

  // 5a. changing the target after the owner was shown the plan: refused before the approval is used
  approve(commitPlanId);
  const counterPath = join(fixture.repo, "src/counter.js");
  const originalCounter = readFileSync(counterPath, "utf8");
  writeFileSync(counterPath, `${originalCounter}\n// tampered after approval\n`);
  const tamperedStale = await call("praxis_developer_git_commit", commitArgs);
  codeIs(tamperedStale, "GIT_PREVIEW_STALE", "commit after the files changed");
  expect(git(fixture.repo, ["rev-parse", "HEAD"]).stdout === headBefore, "a tampered commit moved HEAD");
  const tamperedPreview = await call("praxis_developer_git_preview", { workPackage: WP, repo: fixture.repo });
  const tamperedNew = await call("praxis_developer_git_commit", { ...commitArgs, previewFingerprint: tamperedPreview.data.previewFingerprint });
  codeIs(tamperedNew, "APPROVAL_REQUIRED", "commit of the changed files needs its own approval");
  expect(tamperedNew.data.planId !== commitPlanId, "a changed request must be a different plan");
  expect(git(fixture.repo, ["rev-parse", "HEAD"]).stdout === headBefore, "an unapproved changed commit moved HEAD");
  writeFileSync(counterPath, originalCounter);
  ok("5a. changed files after approval: stale preview refused, the changed request is a new plan needing its own approval, HEAD never moved");

  // 5b. restoring the approved state: the original approval was not burned and now executes once
  const committed = await call("praxis_developer_git_commit", commitArgs);
  expect(committed.ok && committed.data?.ok !== false, `approved commit ${JSON.stringify(committed).slice(0, 400)}`);
  expect(git(fixture.repo, ["rev-parse", "HEAD"]).stdout !== headBefore, "the approved commit did not create a commit");
  noToken(committed, "approved commit response");
  ok("5b. restored state: the commit approval was not consumed by the refusals and ran exactly once");

  // 6. a commit approval does not authorize a push; a copied token does not either
  const pushPreview = await call("praxis_developer_git_publish_preview", { workPackage: WP, repo: fixture.repo, mode: "branch", provider: "github" });
  expect(pushPreview.ok, `push preview ${JSON.stringify(pushPreview).slice(0, 300)}`);
  const pushArgs = { workPackage: WP, repo: fixture.repo, mode: "branch", confirmation: "YES", previewFingerprint: pushPreview.data.previewFingerprint };
  const remoteBeforePush = snapshot(fixture.repo);
  const pushProposal = await call("praxis_developer_git_publish", pushArgs);
  codeIs(pushProposal, "APPROVAL_REQUIRED", "push after only a commit approval");
  const pushPlanId = pushProposal.data.planId;
  expect(pushPlanId !== commitPlanId, "push must be its own plan");
  copyFileSync(join(shared, "authorizations", `${commitPlanId}.token`), join(shared, "authorizations", `${pushPlanId}.token`));
  const moved = await call("praxis_developer_git_publish", pushArgs);
  codeIs(moved, "APPROVAL", "commit token copied under the push plan");
  expect(snapshot(fixture.repo) === remoteBeforePush, "a copied commit token pushed something");
  rmSync(join(shared, "authorizations", `${pushPlanId}.token`));
  ok("6. commit approval is not a push approval, and a commit token copied under the push plan is refused; remote unchanged");

  // 7. a different repository state / remote identity cannot ride on an approval
  approve(pushPlanId);
  git(fixture.repo, ["remote", "set-url", "origin", "git@github.com:evil/other-repo.git"]);
  const wrongRemote = await call("praxis_developer_git_publish", pushArgs);
  expect(wrongRemote.ok === false, `push to a different remote identity must be refused: ${JSON.stringify(wrongRemote).slice(0, 300)}`);
  expect(git(bare, ["for-each-ref", "refs/heads/feature"]).stdout === "", "a push to the wrong remote reached the approved remote");
  git(fixture.repo, ["remote", "set-url", "origin", SSH_URL()]);
  ok("7. remote identity changed after approval: refused, nothing pushed");
  function SSH_URL() {
    return "git@github.com:hisagedru/praxis-acceptance-test.git";
  }

  // 8. approved push then merge request, each with its own approval
  const pushed = await call("praxis_developer_git_publish", pushArgs);
  expect(pushed.ok && pushed.data?.ok !== false, `approved push ${JSON.stringify(pushed).slice(0, 400)}`);
  expect(git(bare, ["for-each-ref", "refs/heads/feature"]).stdout !== "", "approved push did not reach the remote");
  const mrPreview = await call("praxis_developer_git_merge_request_preview", { workPackage: WP, repo: fixture.repo, provider: "github" });
  expect(mrPreview.ok, `mr preview ${JSON.stringify(mrPreview).slice(0, 300)}`);
  const mrArgs = { workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: mrPreview.data.previewFingerprint, provider: "github" };
  const mrProposal = await call("praxis_developer_git_merge_request", mrArgs);
  codeIs(mrProposal, "APPROVAL_REQUIRED", "merge request after only a push approval");
  const mrPlan = JSON.parse(readFileSync(join(shared, "pending", `${mrProposal.data.planId}.json`), "utf8"));
  expect(mrPlan.operations[0] === "merge_request" && mrPlan.instanceId === REMOTE_IDENTITY, "merge request plan must be its own operation on the remote identity");
  approve(mrProposal.data.planId);
  const mr = await call("praxis_developer_git_merge_request", mrArgs);
  expect(mr.ok && mr.data?.ok !== false, `approved merge request ${JSON.stringify(mr).slice(0, 400)}`);
  ok("8. approved push and then an approved merge request, three different plans, executed once each");

  // 9. several independent approvals in one session, across repositories and work packages
  const second = newFixture(WP);
  const third = newFixture("WP-20260914-101");
  const items = [
    { repo: second.repo, wp: WP, bare: second.bare },
    { repo: third.repo, wp: "WP-20260914-101", bare: third.bare },
  ];
  const prepared = [];
  for (const item of items) {
    const preview = await call("praxis_developer_git_preview", { workPackage: item.wp, repo: item.repo });
    const args = { workPackage: item.wp, repo: item.repo, confirmation: "YES", previewFingerprint: preview.data.previewFingerprint };
    const proposal = await call("praxis_developer_git_commit", args);
    codeIs(proposal, "APPROVAL_REQUIRED", `proposal for ${item.wp}`);
    prepared.push({ ...item, args, planId: proposal.data.planId, head: git(item.repo, ["rev-parse", "HEAD"]).stdout });
  }
  expect(new Set(prepared.map((p) => p.planId)).size === prepared.length, "independent requests must be independent plans");
  const ledgerBefore = readdirSync(ledger).length;
  for (const p of prepared) approve(p.planId);
  for (const p of prepared) {
    const res = await call("praxis_developer_git_commit", p.args);
    expect(res.ok && res.data?.ok !== false, `commit ${p.wp} ${JSON.stringify(res).slice(0, 300)}`);
    expect(git(p.repo, ["rev-parse", "HEAD"]).stdout !== p.head, `commit for ${p.wp} did not move HEAD`);
  }
  for (const p of prepared) await call("praxis_developer_git_commit", p.args); // replays
  expect(readdirSync(ledger).length === ledgerBefore + prepared.length, "each approval must be consumed exactly once");
  ok("9. two independent approvals (two repositories, two work packages) in one session: each executed once, replays changed nothing");

  // 10. expiry
  const expiring = newFixture("WP-20260914-102");
  const expWp = "WP-20260914-102";
  const expPreview = await call("praxis_developer_git_preview", { workPackage: expWp, repo: expiring.repo });
  const expArgs = { workPackage: expWp, repo: expiring.repo, confirmation: "YES", previewFingerprint: expPreview.data.previewFingerprint };
  const expProposal = await call("praxis_developer_git_commit", expArgs);
  codeIs(expProposal, "APPROVAL_REQUIRED", "expiry proposal");
  approve(expProposal.data.planId);
  await new Promise((r) => setTimeout(r, 4600));
  const expSnapshot = snapshot(expiring.repo, expiring.bare);
  const expired = await call("praxis_developer_git_commit", expArgs);
  expect(expired.ok === false, `expired approval must be refused: ${JSON.stringify(expired).slice(0, 300)}`);
  expect(snapshot(expiring.repo, expiring.bare) === expSnapshot, "an expired approval changed something");
  ok("10. an expired approval is refused and changes nothing");

  // 11. errors before authorization have no side effects and propose nothing
  const pendingBefore = inbox("pending").length;
  const noYes = await call("praxis_developer_git_commit", { ...commitArgs, confirmation: undefined });
  expect(!noYes || noYes.ok === false, "missing confirmation must be refused");
  const badFp = await call("praxis_developer_git_commit", { workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: "sha256:" + "0".repeat(64) });
  expect(!badFp || badFp.ok === false, "an unknown preview fingerprint must be refused");
  expect(inbox("pending").length === pendingBefore, "refused requests must not put plans in the inbox");
  ok("11. missing confirmation and unknown preview fingerprint: refused, no plan proposed");

  // 12. no broker configured: refused before any side effect
  withoutBroker = await open(variant, { PRAXIS_TEST_ALLOW_SAME_IDENTITY: "1" }, "no-broker");
  const fresh = newFixture(WP);
  const freshBare = fresh.bare;
  const nbPreview = await withoutBroker.call("praxis_developer_git_preview", { workPackage: WP, repo: fresh.repo });
  const nbBefore = snapshot(fresh.repo, freshBare);
  const nb = await withoutBroker.call("praxis_developer_git_commit", { workPackage: WP, repo: fresh.repo, confirmation: "YES", previewFingerprint: nbPreview.data.previewFingerprint });
  codeIs(nb, "APPROVAL_ISOLATION_UNAVAILABLE", "no broker configured");
  expect(snapshot(fresh.repo, freshBare) === nbBefore, "a commit without a broker changed something");
  ok("12. no broker configured: APPROVAL_ISOLATION_UNAVAILABLE, nothing changed");

  // 13. the production bundle ignores the override, even with a broker, a trust anchor and an approved token
  prodSession = await open(production, brokerEnv, "production");
  const prodFixture0 = () => fresh;
  const prodDoctor = await prodSession.call("praxis_doctor", { repo: prodFixture0().repo });
  expect(prodDoctor.data?.build?.kind === "production", `shipped MCPB kind ${prodDoctor.data?.build?.kind}`);
  expect(prodDoctor.data.security?.deployment?.some((f) => f.id === "test-override-ignored"), "the production bundle must say it ignored the override");
  const prodFixture = newFixture(WP);
  const prodPreview = await prodSession.call("praxis_developer_git_preview", { workPackage: WP, repo: prodFixture.repo });
  const prodArgs = { workPackage: WP, repo: prodFixture.repo, confirmation: "YES", previewFingerprint: prodPreview.data.previewFingerprint };
  const prodProposal = await prodSession.call("praxis_developer_git_commit", prodArgs);
  // Proposing is fine; executing under an approved token must be refused: the host is not isolated and the override is dead.
  if (prodProposal.data?.planId) approve(prodProposal.data.planId);
  const prodSnap = snapshot(prodFixture.repo, prodFixture.bare);
  const prodRun = await prodSession.call("praxis_developer_git_commit", prodArgs);
  expect(prodRun.ok === false && /APPROVAL_ISOLATION_UNAVAILABLE/.test(prodRun.code ?? ""), `production bundle must refuse: ${JSON.stringify(prodRun).slice(0, 300)}`);
  expect(snapshot(prodFixture.repo, prodFixture.bare) === prodSnap, "the production bundle executed under the test override");
  ok("13. the shipped production MCPB ignores the test override: a properly signed approval is still refused on this same-user host, nothing changed");

  // 14. a repository file cannot switch the override on
  writeFile(fresh.repo, ".env", "PRAXIS_TEST_ALLOW_SAME_IDENTITY=1\nPRAXIS_SECURITY_MODE=compatibility\n");
  const noOverride = await open(variant, { ...brokerEnv, PRAXIS_TEST_ALLOW_SAME_IDENTITY: "", PRAXIS_SKIP_DOTENV: "" });
  try {
    const envDoctor = await noOverride.call("praxis_doctor", { repo: fresh.repo });
    expect(envDoctor.data.dotenvRejected?.includes("PRAXIS_TEST_ALLOW_SAME_IDENTITY"), `dotenv rejection ${JSON.stringify(envDoctor.data.dotenvRejected)}`);
    expect(envDoctor.data.security.mode === "secure" && envDoctor.data.security.secureOperation === false, "a repository .env must not change the security mode or isolation");
  } finally {
    await noOverride.session.close();
  }
  ok("14. a repository .env cannot enable the test override or compatibility mode");

  // 15. distribution hygiene: no test signer, no key, no test override switch in what ships
  const scan = (dir) => {
    const hits = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (statSync(p).size < 30_000_000) {
          const text = readFileSync(p, "utf8");
          if (/test-broker|acknowledgeUnisolated|BEGIN (EC |RSA )?PRIVATE KEY|PRIVATE KEY-----/.test(text)) hits.push(p.replace(dir, ""));
        }
      }
    };
    walk(dir);
    return hits;
  };
  const prodHits = scan(production.dest);
  expect(prodHits.length === 0, `the shipped MCPB contains test-signer or key material: ${prodHits.join(", ")}`);
  // The role plugins are separate artifacts: nothing of the test signer or any key may ship in them either.
  const { parseZip, readLocalFile } = await import("./claude-zip.mjs");
  const roleHits = [];
  let roleZips = 0;
  for (const role of ["ba", "architect", "developer", "quality"]) {
    for (const candidate of [join(split, `praxis-${role}`, "dist/claude-plugins-full", `praxis-${role}.zip`), join(split, `praxis-${role}`, "claude-plugins", `praxis-${role}.zip`)]) {
      if (!existsSync(candidate)) continue;
      roleZips += 1;
      const buf = readFileSync(candidate);
      for (const entry of parseZip(buf).entries.filter((e) => e.fileType === "file")) {
        if (/test-broker|acknowledgeUnisolated|PRIVATE KEY-----|acceptance-test-signer/.test(readLocalFile(buf, entry).toString("utf8"))) roleHits.push(`${candidate}:${entry.name}`);
      }
    }
  }
  expect(roleHits.length === 0, `role ZIPs contain test-signer or key material: ${roleHits.join(", ")}`);
  console.log(`  (scanned ${roleZips} role ZIP(s))`);
  const prodBundle = readFileSync(join(production.dest, "server/praxis-mcp.cjs"), "utf8");
  // The kind is substituted at build time: there must be no run-time lookup of it left to override, and the
  // bundle must still contain the override's name (so the refusal in step 13 is the code path, not its absence).
  expect(!prodBundle.includes("process.env.PRAXIS_BUNDLE_KIND"), "the production bundle must not read its kind from the environment");
  expect(prodBundle.includes("PRAXIS_TEST_ALLOW_SAME_IDENTITY"), "expected the override name in the bundle (refused, not removed)");
  ok("15. the shipped MCPB carries no test signer or key material and has the production kind compiled in");

  // keep the live consumer fixture out of this: nothing here touched it
  blocked.push("OS-level isolation: broker, Runtime and agent are one user here. The test variant honours the same-identity override; a production bundle refuses to run without a separate identity (13).");
  blocked.push("A person's approval: the broker is driven with its machine-approve flag. The WebAuthn operator page path is covered by praxis-core broker tests, not by this script.");
  blocked.push("A privileged out-of-process executor: the Runtime process executes after verification.");
} finally {
  for (const s of [primary, withoutBroker, prodSession]) await s?.session.close().catch(() => undefined);
  mock.close();
  for (const d of [variantDir, productionDir, trusted, shared, ledger]) rmSync(d, { recursive: true, force: true });
}

console.log(`PASS git-authorization ${steps.join("; ")}`);
for (const item of blocked) console.log(`BLOCKED ${item}`);
