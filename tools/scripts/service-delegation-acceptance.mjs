#!/usr/bin/env node
/**
 * The Runtime delegating protected Git operations to the Approval Service, through the packaged MCPB.
 *
 * WHAT IS REAL
 *   - the packaged Runtime (a TEST VARIANT of the MCPB and the shipped production MCPB), over the real MCP protocol
 *   - the Approval Service as its own process (praxis-core/tools/approval-service), its real IPC socket, its real
 *     operator page, its real WebAuthn verification, real Git against temporary repositories and a bare remote
 *   - the Runtime holds no signing key and no credential: it only submits, reads status, and asks for execution
 * WHAT IS A FIXTURE (and is labelled as one)
 *   - the human: the operator's WebAuthn assertion is produced by a SOFTWARE authenticator (test-authenticator.mjs).
 *     The service verifies it for real; it proves nothing about a person or about Touch ID.
 *   - the isolation: service, Runtime and this script run as ONE OS user. The service runs in development mode and
 *     reports itself unisolated; the test variant honours PRAXIS_TEST_ALLOW_SAME_IDENTITY, the production bundle does
 *     not (step 8). OS-level isolation is NOT proven here; see praxis-core docs/approval-service/ISOLATION-ACCEPTANCE.md.
 *   - the hosting provider: merge requests go to the service's fixture provider, not to GitHub
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createMockGithubState } from "@praxis/vcs";
import { buildConsumerLikeFixture, emptyBare, attachSshLikeRemote, git, startGithubHttpMock, WP } from "./git-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const coreRoot = process.env.PRAXIS_CORE_ROOT ?? resolve(root, "../praxis-core");
// By default the service runs from source under this script's Node. PRAXIS_SERVICE_NODE and PRAXIS_SERVICE_BUNDLE run the packaged
// bundle under the packaged runtime instead (the test variant of the bundle: the production one refuses to run unisolated).
const serviceCli = process.env.PRAXIS_SERVICE_BUNDLE ?? join(coreRoot, "tools/approval-service/praxis-approval-service.mjs");
const serviceNode = process.env.PRAXIS_SERVICE_NODE ?? process.execPath;
const authenticatorModule = join(coreRoot, "tools/broker/test-authenticator.mjs");
const steps = [];
const blocked = [];
const fail = (msg) => {
  console.error(`FAIL service-delegation: ${msg}`);
  process.exit(1);
};
const ok = (name) => {
  steps.push(name);
  console.log(`  ok ${name}`);
};
const expect = (cond, msg) => cond || fail(msg);

console.log(`service under test: ${serviceNode} ${serviceCli}`);
if (!existsSync(serviceCli)) {
  console.log(`BLOCKED service-delegation: the approval service is not at ${serviceCli} (set PRAXIS_CORE_ROOT)`);
  process.exit(2);
}

const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import("./official-mcp-client.mjs");
const { createSoftwareAuthenticator } = await import(pathToFileURL(authenticatorModule).href);

spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
const variantPack = await packClaudeExtension(version, { kind: "acceptance" });
const variantDir = mkdtempSync(join(tmpdir(), "praxis-sd-variant-"));
const variant = extractMcpbRuntime(variantPack.mcpbPath, variantDir);
const productionDir = mkdtempSync(join(tmpdir(), "praxis-sd-prod-"));
const production = extractMcpbRuntime(join(root, "claude-extensions", "praxis-runtime.mcpb"), productionDir);

// --- fixtures ---------------------------------------------------------------------------------------------------
const gh = createMockGithubState({ empty: false, defaultBranch: "main", hasReadme: false });
const mock = await startGithubHttpMock(gh);
const bare = emptyBare();
const fixture = buildConsumerLikeFixture();
attachSshLikeRemote(fixture.repo, bare);
// the remote already has its baseline (as for any repository that is not brand new); the service pushes feature branches
git(fixture.repo, ["push", bare, `${fixture.baselineSha}:refs/heads/main`]);

const bare2 = emptyBare();
const second = buildConsumerLikeFixture();
attachSshLikeRemote(second.repo, bare2);
git(second.repo, ["push", bare2, `${second.baselineSha}:refs/heads/main`]);

const work = mkdtempSync("/tmp/praxis-sd-");
const state = join(work, "state");
const endpoint = join(work, "svc.sock");
mkdirSync(state, { mode: 0o700 });
const port = await new Promise((resolvePort) => {
  import("node:net").then(({ createServer }) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolvePort(p));
    });
  });
});
const origin = `http://localhost:${port}`;
const configFile = join(work, "config.json");
writeFileSync(
  configFile,
  JSON.stringify({
    mode: "development",
    principal: "test",
    paths: { stateDir: state, endpoint, codeDir: work, configFile },
    repositories: [
      { path: fixture.repo, remotes: { origin: bare }, branches: ["*"], provider: { kind: "fixture", instanceId: "fixture/demo" } },
      { path: second.repo, remotes: { origin: bare2 }, branches: ["*"], provider: { kind: "fixture", instanceId: "fixture/demo" } },
    ],
    providers: { fixture: { instances: { "fixture/demo": { actions: ["create_merge_request"] } } } },
    operator: { port, origin },
  }),
);

let service;
const startService = () =>
  new Promise((resolveStart, reject) => {
    const child = spawn(serviceNode, [serviceCli, "run", "--config", configFile], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, PRAXIS_APPROVAL_PLAN_TTL_MS: "120000" } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolveStart(child);
    });
    child.stderr.on("data", (d) => reject(new Error(String(d))));
    child.on("exit", (code) => reject(new Error(`service exited ${code}`)));
  });
service = await startService();

// --- the operator: the real page, a software authenticator -------------------------------------------------------
const device = createSoftwareAuthenticator({ rpId: "localhost", origin });
const post = async (path, body) => {
  const r = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
{
  const enroll = spawnSync(serviceNode, [serviceCli, "enroll-code", "--config", configFile], { encoding: "utf8" });
  const code = /: ([a-f0-9]{20})\n/.exec(enroll.stdout)?.[1];
  expect(code, `enrollment code: ${enroll.stdout}${enroll.stderr}`);
  const c = await post("/api/enroll/challenge", { secret: code, label: "acceptance" });
  const reg = device.register({ challenge: c.json.publicKey.challenge });
  const fin = await post("/api/enroll/finish", { secret: code, challengeId: c.json.challengeId, credential: { id: reg.id, response: { clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject } } });
  expect(fin.status === 200, `enroll ${JSON.stringify(fin.json)}`);
}
const decide = async (requestId, decision = "approve") => {
  const c = await post("/api/challenge", { planId: requestId, decision });
  expect(c.status === 200, `challenge ${JSON.stringify(c.json)}`);
  const a = device.assert({ challenge: c.json.publicKey.challenge });
  const r = await post("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
  expect(r.status === 200, `decide ${JSON.stringify(r.json)}`);
};

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
async function open(extracted, env) {
  const session = await connectOfficialMcp({ command: process.execPath, args: extracted.args, cwd: extracted.dest, env: { ...baseEnv(extracted.dest), ...env }, versionNegotiation: versionNegotiationModern(), timeoutMs: 30_000, clientVersion: version });
  return { session, call: async (name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args })) };
}

const snapshot = () =>
  JSON.stringify({
    head: git(fixture.repo, ["rev-parse", "HEAD"]).stdout,
    branch: git(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout,
    status: git(fixture.repo, ["status", "--porcelain"]).stdout,
    refs: git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout,
    remote: git(bare, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout,
  });
const codeIs = (res, prefix, label) => expect(res?.ok === false && String(res.code ?? "").startsWith(prefix), `${label}: expected ${prefix}*, got ${JSON.stringify(res).slice(0, 400)}`);
const noSecrets = (value, label) => {
  const text = JSON.stringify(value);
  expect(!/BEGIN (PRIVATE|PUBLIC) KEY|"signature"|\.token/.test(text), `${label} leaked token or key material`);
};

let primary;
let prodSession;
try {
  primary = await open(variant, { PRAXIS_APPROVAL_SERVICE_ENDPOINT: endpoint, PRAXIS_TEST_ALLOW_SAME_IDENTITY: "1" });
  const { call } = primary;

  // 0. what the Runtime says about the service: reachable, development mode, NOT isolated, and why
  const doctor = await call("praxis_doctor", { repo: fixture.repo });
  const svc = doctor.data?.approvalService;
  expect(svc?.reachable === true && svc.delegating === true && svc.isolated === false, `doctor approvalService ${JSON.stringify(svc)}`);
  expect(svc.mode === "development" && svc.protocolCompatible === true && svc.reasons.length >= 2, `doctor reasons ${JSON.stringify(svc)}`);
  expect(doctor.data.build?.kind === "acceptance", "variant identity");
  const toolNames = doctor.data.build?.tools?.names ?? [];
  expect(!toolNames.some((n) => /approve|sign|enroll|grant_|operator/i.test(n.replace("praxis_approval_confirm", ""))), `no tool may approve: ${toolNames.filter((n) => /approv/i.test(n))}`);
  ok("0. doctor: service reachable and delegating, reported development-mode and NOT isolated with reasons; no MCP tool approves");

  // 1. commit: the Runtime asks, the service shows the owner, nothing changes
  const preview = await call("praxis_developer_git_preview", { workPackage: WP, repo: fixture.repo });
  expect(preview.ok, `preview ${JSON.stringify(preview).slice(0, 300)}`);
  const commitArgs = { workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: preview.data.previewFingerprint };
  const before = snapshot();
  const proposed = await call("praxis_developer_git_commit", commitArgs);
  codeIs(proposed, "APPROVAL_REQUIRED", "commit proposal");
  const requestId = proposed.data?.requestId ?? proposed.details?.requestId ?? proposed.data?.details?.requestId;
  expect(/^git-git-commit-[0-9a-f]{24}$/.test(requestId ?? ""), `request id in ${JSON.stringify(proposed).slice(0, 500)}`);
  expect(snapshot() === before, "a commit that is waiting for the owner changed the repository (no staging, no branch)");
  noSecrets(proposed, "proposal");
  const page = await (await fetch(`${origin}/plan/${requestId}`)).text();
  expect(page.includes("src/counter.js") && page.includes(WP) && page.includes("Approve with authenticator") && /Fingerprint/.test(page), "operator page must show the service-derived plan");
  expect(!page.includes("lib/mod-"), "files that are not part of the commit must not be listed");
  ok("1. commit: APPROVAL_REQUIRED with the service's request id; branch, index, tree and refs unchanged; the operator page shows the exact files");

  // 2. approve through the real operator page; the Runtime executes through the service and journals the result
  await decide(requestId);
  const committed = await call("praxis_developer_git_commit", commitArgs);
  expect(committed.ok && committed.data?.ok !== false, `approved commit ${JSON.stringify(committed).slice(0, 500)}`);
  noSecrets(committed, "approved commit");
  const featureBranch = git(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  expect(featureBranch !== "master" && git(fixture.repo, ["rev-list", "--count", `${fixture.baselineSha}..HEAD`]).stdout === "1", `one new commit on a new branch, got ${featureBranch}`);
  expect(git(fixture.repo, ["log", "-1", "--format=%an"]).stdout === "Praxis Approval Service", "the commit must be authored by the service, not the agent's identity");
  const committedFiles = git(fixture.repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.split("\n").sort().join(",");
  expect(committedFiles === "src/counter.js,src/counter.test.js", `committed exactly the selected files, got ${committedFiles}`);
  ok("2. approved commit executed by the service (service identity as author, exactly the selected files, new branch created by it); journal updated");

  // 3. replay: the same request again changes nothing
  const afterCommit = snapshot();
  const replay = await call("praxis_developer_git_commit", commitArgs);
  // The same logical operation asked again after it completed returns what the service recorded: HEAD has moved, nothing runs twice.
  expect(replay.ok === true && replay.data?.replayed === true && replay.data?.executedBy === "approval-service", `replay ${JSON.stringify(replay).slice(0, 400)}`);
  expect(snapshot() === afterCommit, "replaying a completed commit changed something");
  expect(replay.data.serviceResult?.commit === git(fixture.repo, ["rev-parse", "HEAD"]).stdout, "the replay must return the recorded commit");
  ok("3. replay of the completed commit by execution id: the recorded result, HEAD had moved, nothing changed, no second commit")

  // 4. a commit approval does not authorize a push
  const pushPreview = await call("praxis_developer_git_publish_preview", { workPackage: WP, repo: fixture.repo, mode: "branch", provider: "github" });
  expect(pushPreview.ok, `push preview ${JSON.stringify(pushPreview).slice(0, 400)}`);
  const pushArgs = { workPackage: WP, repo: fixture.repo, mode: "branch", confirmation: "YES", previewFingerprint: pushPreview.data.previewFingerprint };
  const remoteBefore = git(bare, ["for-each-ref", "refs/heads"]).stdout;
  const pushProposal = await call("praxis_developer_git_publish", pushArgs);
  codeIs(pushProposal, "APPROVAL_REQUIRED", "push after only a commit approval");
  const pushId = pushProposal.data?.requestId ?? pushProposal.details?.requestId ?? pushProposal.data?.details?.requestId;
  expect(/^git-git-push-/.test(pushId ?? "") && pushId !== requestId, `push is its own request: ${pushId}`);
  expect(git(bare, ["for-each-ref", "refs/heads"]).stdout === remoteBefore, "nothing may be pushed before the push is approved");
  ok("4. push after only a commit approval: its own request, APPROVAL_REQUIRED, remote untouched");

  // 5. approved push (service credentials/URL, not the agent's), then merge request through the provider interface
  await decide(pushId);
  const pushed = await call("praxis_developer_git_publish", pushArgs);
  expect(pushed.ok && pushed.data?.ok !== false, `approved push ${JSON.stringify(pushed).slice(0, 500)}`);
  expect(git(bare, ["rev-parse", `refs/heads/${featureBranch}`]).stdout === git(fixture.repo, ["rev-parse", "HEAD"]).stdout, "the remote branch must equal the approved commit");
  const mrPreview = await call("praxis_developer_git_merge_request_preview", { workPackage: WP, repo: fixture.repo, provider: "github" });
  expect(mrPreview.ok, `mr preview ${JSON.stringify(mrPreview).slice(0, 400)}`);
  // push replay: the same push again returns the recorded result even though the remote and local history have moved on
  const remoteAfterPush = git(bare, ["for-each-ref", "refs/heads"]).stdout;
  const pushReplay = await call("praxis_developer_git_publish", pushArgs);
  expect(pushReplay.ok && pushReplay.data?.replayed === true, `push replay ${JSON.stringify(pushReplay).slice(0, 300)}`);
  expect(git(bare, ["for-each-ref", "refs/heads"]).stdout === remoteAfterPush, "a push replay changed the remote");
  const mrArgs = { workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: mrPreview.data.previewFingerprint, provider: "github" };
  const mrProposal = await call("praxis_developer_git_merge_request", mrArgs);
  codeIs(mrProposal, "APPROVAL_REQUIRED", "merge request proposal");
  const mrId = mrProposal.data?.requestId ?? mrProposal.details?.requestId ?? mrProposal.data?.details?.requestId;
  await decide(mrId);
  const mr = await call("praxis_developer_git_merge_request", mrArgs);
  expect(mr.ok && mr.data?.ok !== false && /^fixture:\/\//.test(mr.data?.mergeRequestUrl ?? mr.data?.pullRequestUrl ?? ""), `merge request ${JSON.stringify(mr).slice(0, 500)}`);
  const mrReplay = await call("praxis_developer_git_merge_request", mrArgs);
  expect(mrReplay.ok && mrReplay.data?.replayed === true, `merge request replay ${JSON.stringify(mrReplay).slice(0, 300)}`);
  ok("5. approved push (remote branch = approved commit) and approved merge request through the provider interface, each its own approval; replays of the push and the merge request return the recorded results");

  // 6. a rejection leaves everything untouched (a second repository with its own work to commit)
  const p2 = await call("praxis_developer_git_preview", { workPackage: WP, repo: second.repo });
  expect(p2.ok, `second preview ${JSON.stringify(p2).slice(0, 300)}`);
  const args2 = { workPackage: WP, repo: second.repo, confirmation: "YES", previewFingerprint: p2.data.previewFingerprint };
  const prop2 = await call("praxis_developer_git_commit", args2);
  codeIs(prop2, "APPROVAL_REQUIRED", "second commit proposal");
  const id2 = prop2.data?.requestId ?? prop2.details?.requestId ?? prop2.data?.details?.requestId;
  expect(/^git-git-commit-/.test(id2 ?? "") && id2 !== requestId, `second request id in ${JSON.stringify(prop2).slice(0, 700)}`);
  const snapSecond = () => JSON.stringify({ head: git(second.repo, ["rev-parse", "HEAD"]).stdout, branch: git(second.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout, status: git(second.repo, ["status", "--porcelain"]).stdout, remote: git(bare2, ["for-each-ref"]).stdout });
  const snap = snapSecond();
  await decide(id2, "reject");
  const after = await call("praxis_developer_git_commit", args2);
  codeIs(after, "APPROVAL_REJECTED", "commit after reject");
  expect(snapSecond() === snap, "a rejected commit changed something");
  // the approval for the first repository cannot be used for this one: it is a different request id and needs its own decision
  expect(id2 !== requestId, "independent repositories are independent requests");
  ok("6. rejected request in a second repository: APPROVAL_REJECTED, repository and remote unchanged; independent of the first repository's approvals");

  // 7. fail closed: the service goes away
  service.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  const down = snapshot();
  const noService = await call("praxis_developer_git_publish", { ...pushArgs, previewFingerprint: pushPreview.data.previewFingerprint });
  expect(noService.ok === false, `with the service down a protected operation must not succeed: ${JSON.stringify(noService).slice(0, 300)}`);
  expect(/APPROVAL_ISOLATION_UNAVAILABLE|GIT_PREVIEW_STALE|APPROVAL/.test(noService.code ?? ""), `code ${noService.code}`);
  const doctorDown = await call("praxis_doctor", { repo: fixture.repo });
  expect(doctorDown.data.approvalService.reachable === false && doctorDown.data.approvalService.isolated === false, "doctor must report the service as unreachable");
  const downSecond = snapSecond();
  const commitDown = await call("praxis_developer_git_commit", args2);
  codeIs(commitDown, "APPROVAL_ISOLATION_UNAVAILABLE", "commit with the service down");
  expect(snapshot() === down && snapSecond() === downSecond, "an operation with the service down changed something");
  service = await startService();
  ok("7. service stopped: protected operations are refused (never executed by the Runtime), doctor reports unreachable, nothing changed; restart restores service");

  // 8. the shipped production MCPB refuses a service whose isolation it cannot establish (the test override is dead there)
  prodSession = await open(production, { PRAXIS_APPROVAL_SERVICE_ENDPOINT: endpoint, PRAXIS_TEST_ALLOW_SAME_IDENTITY: "1" });
  const prodDoctor = await prodSession.call("praxis_doctor", { repo: fixture.repo });
  expect(prodDoctor.data.build.kind === "production" && prodDoctor.data.approvalService.reachable === true && prodDoctor.data.approvalService.isolated === false, `production doctor ${JSON.stringify(prodDoctor.data.approvalService)}`);
  const f2 = buildConsumerLikeFixture();
  const prodPreview = await prodSession.call("praxis_developer_git_preview", { workPackage: WP, repo: f2.repo });
  const prodRun = await prodSession.call("praxis_developer_git_commit", { workPackage: WP, repo: f2.repo, confirmation: "YES", previewFingerprint: prodPreview.data?.previewFingerprint ?? "sha256:" + "0".repeat(64) });
  expect(prodRun.ok === false && /APPROVAL_ISOLATION_UNAVAILABLE/.test(prodRun.code ?? ""), `production bundle must refuse an unisolated service: ${JSON.stringify(prodRun).slice(0, 300)}`);
  expect(git(f2.repo, ["rev-parse", "HEAD"]).stdout === f2.baselineSha, "the production bundle committed through an unisolated service");
  ok("8. production MCPB: reports the same-user service as not isolated and refuses to delegate to it; nothing changed");

  // 9. nothing leaked into the user repository: no approval branches, refs or files
  const refs = git(fixture.repo, ["for-each-ref", "--format=%(refname)"]).stdout.split("\n").sort();
  expect(refs.every((r) => ["refs/heads/master", `refs/heads/${featureBranch}`].includes(r) || /refs\/remotes\//.test(r)), `unexpected refs ${refs.join(",")}`);
  const tracked = git(fixture.repo, ["ls-files"]).stdout;
  expect(!/approv|token|ledger|authoriz/i.test(tracked), "an approval artifact was committed to the repository");
  const delivery = readdirSync(join(fixture.repo, ".praxis-git")).map((f) => readFileSync(join(fixture.repo, ".praxis-git", f), "utf8")).join("\n");
  expect(!/PRIVATE KEY|"signature"|\.token/.test(delivery), "the delivery journal must hold no credential material");
  ok("9. the user repository gained only the agent's feature branch: no approval branches, refs, files or secrets");

  blocked.push("OS-level isolation: the service, the Runtime and this script are one user. The service reports itself unisolated and the production bundle refuses it (8). Independent-identity tests are in praxis-core docs/approval-service/ISOLATION-ACCEPTANCE.md.");
  blocked.push("A person's approval: the assertion comes from a software authenticator. Real Touch ID / security key acceptance needs the operator.");
} finally {
  for (const s of [primary, prodSession]) await s?.session.close().catch(() => undefined);
  service?.kill("SIGKILL");
  mock.close();
  for (const d of [variantDir, productionDir, work]) rmSync(d, { recursive: true, force: true });
}

console.log(`PASS service-delegation ${steps.join("; ")}`);
for (const item of blocked) console.log(`BLOCKED ${item}`);
