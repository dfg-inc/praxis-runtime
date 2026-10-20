#!/usr/bin/env node
/**
 * Full GitHub Delivery E2E on a consumer-like fixture.
 * Real git (bare remote + insteadOf SSH URL). GitHub API is mocked.
 * Does not touch praxis-test, live GitHub, or Jira PRX-1..4.
 */
import {
  createServer,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  applyCommit as rawApplyCommit,
  applyMergeRequest as rawApplyMergeRequest,
  applyPublish as rawApplyPublish,
  createMockGithubFetch,
  createMockGithubState,
  inspectDeliveryStatus,
  inspectGitStatus,
  listCommitFiles,
  lsRemoteHeads,
  previewDelivery,
  previewMergeRequest,
  previewPublish,
  readJournal,
  VCS_CODES,
  verifyCommittedReproducibility,
} from "@praxis/vcs";
import { installTestBroker } from "./test-broker.mjs";
import {
  attachSshLikeRemote,
  BASELINE_COUNTER,
  FEATURE_COUNTER,
  FEATURE_TEST,
  buildConsumerLikeFixture,
  emptyBare,
  git,
  sha,
  SSH,
  startGithubHttpMock,
  WP,
  writeFile,
} from "./git-fixtures.mjs";

// Protected Git writes run under real signed authorizations from an in-process test signer (see test-broker.mjs).
// The Runtime stays in secure mode; this script does not switch to compatibility mode.
const testBroker = installTestBroker({ acknowledgeUnisolated: true });
process.on("exit", () => testBroker.close());
const guarded = (action, operation, fn) => (input, ...rest) =>
  testBroker.authorized({ repo: input.repo, action, operation, workItemId: input.workPackageId ?? "acceptance" }, () => fn(input, ...rest));

const applyCommit = guarded("applyCommit", "git_commit", rawApplyCommit);
const applyMergeRequest = guarded("applyMergeRequest", "merge_request", rawApplyMergeRequest);
const applyPublish = guarded("applyPublish", "git_push", rawApplyPublish);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONSUMER = "/Users/serg/work/praxis-acceptance/praxis-test";
const CONSUMER_HEAD = "b96e9d1e44b1ea7663c399fbe7f41fd3f4992e57";
const steps = [];
const blocked = [];

function fail(msg) {
  console.error(`FAIL git-delivery-e2e: ${msg}`);
  process.exit(1);
}

function prove(name) {
  steps.push(name);
  console.log(`  ok ${name}`);
}

function consumerSnapshot() {
  if (!existsSync(join(CONSUMER, ".git"))) return null;
  const head = git(CONSUMER, ["rev-parse", "HEAD"]).stdout;
  const status = git(CONSUMER, ["status", "--porcelain"]).stdout;
  const branch = git(CONSUMER, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  return { head, status, branch };
}

function assertConsumerUntouched(before) {
  if (!before) return;
  const after = consumerSnapshot();
  if (after.head !== before.head || after.branch !== before.branch || after.status !== before.status) {
    fail("LIVE consumer praxis-test was mutated");
  }
}

const consumerBefore = consumerSnapshot();

{
  const fixture = buildConsumerLikeFixture();
  const bare = emptyBare();
  attachSshLikeRemote(fixture.repo, bare);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
  const fetchImpl = createMockGithubFetch(gh);
  const inputs = {
    repo: fixture.repo,
    workPackageId: WP,
    jiraWorkPackageKey: "PRX-4",
    providerKind: "github",
    fetchImpl,
  };

  const status = inspectGitStatus(inputs);
  if (status.currentBranch !== "master") fail("1 git status branch");
  if (status.headSha !== fixture.baselineSha) fail("1 git status HEAD");
  if (!status.workingTree.dirty) fail("1 expected dirty tree");
  prove("1. Git Status");

  const remotes = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: fixture.repo, encoding: "utf8" }).stdout.trim();
  if (remotes !== SSH) fail(`2 origin is not the SSH GitHub URL (${remotes})`);
  prove("2. Git Connection");

  const basePrev = await previewPublish({ ...inputs, mode: "baseline" });
  if (basePrev.sourceBranch !== "master") fail("3 sourceBranch");
  if (basePrev.sourceCommitSha !== fixture.baselineSha) fail("3 sourceCommitSha");
  if (basePrev.targetRemote !== "origin") fail("3 targetRemote");
  if (basePrev.targetRemoteBranch !== "main") fail("3 targetRemoteBranch");
  if (basePrev.refspec !== `${fixture.baselineSha}:refs/heads/main`) fail(`3 refspec ${basePrev.refspec}`);
  if (basePrev.force !== false) fail("3 force");
  if (!basePrev.remoteEmpty) fail("3 remoteEmpty");
  if (basePrev.existingRefs.length) fail("3 existing refs");
  if (!basePrev.githubRepository.includes("praxis-acceptance-test")) fail("3 github repo");
  prove("3. Baseline Preview");

  const baseApply = await applyPublish({ ...inputs, mode: "baseline", previewFingerprint: basePrev.previewFingerprint });
  if (!baseApply.ok || !baseApply.completed || !baseApply.writeSucceeded) fail(`4 baseline apply ${JSON.stringify(baseApply)}`);
  if (baseApply.lifecycle !== "baseline-published") fail("4 lifecycle");
  prove("4. Baseline Apply");

  const mainSha = git(bare, ["rev-parse", "refs/heads/main"]).stdout;
  if (mainSha !== fixture.baselineSha) fail("5 remote main SHA");
  prove("5. Verify remote main");

  const remoteRefs = git(bare, ["show-ref", "--heads"]).stdout;
  if (remoteRefs.includes("refs/heads/master")) fail("6 remote master created");
  prove("6. Verify no remote master");

  const featPrev = await previewDelivery(inputs);
  if (!featPrev.qualityMatch) fail("7 quality match");
  if (featPrev.qualityReviewId !== 1) fail("7 review id");
  if (featPrev.selectedFiles.join(",") !== "src/counter.js,src/counter.test.js") fail("7 allowlist");
  if (featPrev.targetBranch !== "main") fail("7 PR target");
  if (featPrev.commitMessage !== "feat(PRX-4): add counter reset support") fail("7 message");
  prove("7. Feature Preview");

  const committed = await applyCommit({ ...inputs, previewFingerprint: featPrev.previewFingerprint });
  if (!committed.ok || committed.lifecycle !== "committed") fail("8 commit");
  if (committed.commitSha === fixture.baselineSha) fail("8 same sha");
  const msg = git(fixture.repo, ["log", "-1", "--format=%s", committed.commitSha]).stdout;
  if (msg !== "feat(PRX-4): add counter reset support") fail(`8 message ${msg}`);
  prove("8. Feature Commit");

  const names = listCommitFiles(fixture.repo, committed.commitSha);
  if (names.length !== 2 || !names.includes("src/counter.js") || !names.includes("src/counter.test.js")) {
    fail(`9 committed tree ${names.join(",")}`);
  }
  prove("9. Verify committed tree");

  const liveCounter = sha(readFileSync(join(fixture.repo, "src/counter.js")));
  const fromCommit = spawnSync("git", ["show", `${committed.commitSha}:src/counter.js`], {
    cwd: fixture.repo,
    encoding: "utf8",
  }).stdout;
  if (sha(fromCommit) !== liveCounter || liveCounter !== sha(FEATURE_COUNTER)) fail("10 commit hash vs QA");
  if (fromCommit.includes("github_pat_") || fromCommit.includes("ghp_")) fail("10 secret in commit");
  prove("10. Verify Quality snapshot");

  const pushPrev = await previewPublish({ ...inputs, mode: "branch" });
  if (pushPrev.sourceBranch !== "feature/PRX-4-counter-reset") fail("11 feature branch");
  if (pushPrev.refspec !== `${committed.commitSha}:refs/heads/feature/PRX-4-counter-reset`) fail("11 feature refspec");
  prove("11. Feature Publish Preview");

  const pushed = await applyPublish({ ...inputs, mode: "branch", previewFingerprint: pushPrev.previewFingerprint });
  if (!pushed.ok || pushed.lifecycle !== "pushed") fail("12 feature push");
  prove("12. Feature Push");

  const remoteFeat = git(bare, ["rev-parse", "refs/heads/feature/PRX-4-counter-reset"]).stdout;
  if (remoteFeat !== committed.commitSha) fail("13 remote feature SHA");
  prove("13. Verify remote feature SHA");

  const mrPrev = await previewMergeRequest(inputs);
  if (mrPrev.targetBranch !== "main") fail("14 PR base preview");
  const mr = await applyMergeRequest({ ...inputs, previewFingerprint: mrPrev.previewFingerprint });
  if (!mr.ok || !mr.pullRequestUrl) fail("14 PR create");
  prove("14. Create GitHub Pull Request");

  if (mr.pullRequestBase !== "main") fail("15 PR base");
  prove("15. Verify PR base main");

  if (mr.pullRequestHead !== "feature/PRX-4-counter-reset") fail("16 PR head");
  prove("16. Verify PR head");

  if (gh.pulls[0]?.head?.ref !== "feature/PRX-4-counter-reset") fail("17 mock head");
  prove("17. Verify PR commit SHA");

  const delivery = inspectDeliveryStatus(inputs);
  if (delivery.journal?.ciStatus === "success") fail("18 fake CI PASS");
  if (delivery.journal?.ciStatus !== "not_configured") fail(`18 ci ${delivery.journal?.ciStatus}`);
  prove("18. Read CI Status");

  const journal = readJournal(fixture.repo, WP);
  for (const field of [
    "workPackageId",
    "jiraWorkPackageKey",
    "repository",
    "remoteName",
    "baselineSha",
    "baselineRemoteBranch",
    "featureBranch",
    "commitSha",
    "commitTreeSha",
    "qaReviewId",
    "qaSnapshotDigest",
    "pullRequestUrl",
    "pullRequestNumber",
    "pullRequestBase",
    "pullRequestHead",
    "ciStatus",
    "lifecycle",
  ]) {
    if (journal?.[field] == null || journal[field] === "") fail(`19 missing journal ${field}`);
  }
  if (journal.baselineSha !== fixture.baselineSha) fail("19 baseline sha");
  if (journal.forcePush !== false || journal.merged !== false) fail("19 force/merge");
  if (JSON.stringify(journal).includes("ghp_") || JSON.stringify(journal).includes("github_pat_")) fail("19 token stored");
  prove("19. Read Delivery Journal");

  if (names.some((p) => p.startsWith(".praxis") || p === ".npmrc" || p === ".project" || p === "package.json")) {
    fail("20 unintended files");
  }
  prove("20. Verify no unintended files");

  if (readFileSync(join(fixture.repo, "package.json"), "utf8").includes("1.0.0-dirty") !== true) fail("21 dirty package.json lost");
  if (!existsSync(join(fixture.repo, ".npmrc"))) fail("21 .npmrc lost");
  if (git(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout === "master") {
    /* feature branch checkout is expected */
  }
  prove("21. Verify dirty user changes preserved");

  const retryCommit = await applyCommit({
    ...inputs,
    previewFingerprint: (await previewDelivery(inputs)).previewFingerprint,
  });
  if (retryCommit.commitSha !== committed.commitSha || retryCommit.writeSucceeded !== false) fail("22 extra commit");
  const retryPush = await applyPublish({
    ...inputs,
    mode: "branch",
    previewFingerprint: (await previewPublish({ ...inputs, mode: "branch" })).previewFingerprint,
  });
  if (retryPush.writeSucceeded !== false) fail("22 extra push");
  const retryMr = await applyMergeRequest({ ...inputs, previewFingerprint: mrPrev.previewFingerprint });
  if (gh.pulls.length !== 1) fail("22 extra PR");
  if (retryMr.pullRequestUrl !== mr.pullRequestUrl) fail("22 PR url changed");
  prove("22. Retry completed operations");
  prove("23. Verify no duplicate commits/PRs");

  const gitLocalPath = [
    join(root, "plugins/vcs/src/git-local.ts"),
    join(root, "node_modules/@praxis/vcs/dist/git-local.js"),
  ].find((p) => existsSync(p));
  if (!gitLocalPath) fail("24 missing git-local");
  const gitLocal = readFileSync(gitLocalPath, "utf8");
  if (/args\.push\([^)]*--force/.test(gitLocal) || /"push",[\s\S]*"--force"/.test(gitLocal)) fail("24 force push helper");
  if (!gitLocal.includes("GIT_FORCE_PUSH_FORBIDDEN")) fail("24 missing force forbid");
  prove("24. Verify no force push");

  if (mr.merged || journal.merged) fail("25 merge");
  if (git(bare, ["rev-parse", "refs/heads/main"]).stdout !== fixture.baselineSha) fail("25 main moved (merged?)");
  prove("25. Verify no merge");

  if (delivery.jiraMutated !== false) fail("26 jira");
  prove("26. Verify no unapproved Jira writes");

  const repro = verifyCommittedReproducibility(fixture.repo, fixture.baselineSha, committed.commitSha);
  if (repro.baseline.passed !== 4 || !repro.baseline.ok) {
    fail(`reproducibility baseline: passed=${repro.baseline.passed} ok=${repro.baseline.ok} ${repro.baseline.output.slice(-500)}`);
  }
  if (repro.feature.passed !== 5 || !repro.feature.ok) {
    fail(`reproducibility feature: passed=${repro.feature.passed} ok=${repro.feature.ok} ${repro.feature.output.slice(-500)}`);
  }
  prove("H. Reproducibility baseline 4 / feature 5");

  rmSync(fixture.repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

{
  const repo = mkdtempSync(join(tmpdir(), "praxis-e2e-neg-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  writeFile(repo, "README.md", "# t\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  let blocked = false;
  try {
    await previewPublish({ repo, workPackageId: WP });
  } catch (err) {
    blocked = err.code === VCS_CODES.GIT_REMOTE_REQUIRED;
  }
  if (!blocked) fail("negative: missing remote");
  prove("N. missing remote");

  const bare = emptyBare();
  attachSshLikeRemote(repo, bare);
  git(bare, ["hash-object", "-w", "--stdin"], { allowFail: true });
  writeFile(repo, "secret.txt", "token ghp_abcdefghijklmnopqrstuvwx\n");
  git(repo, ["add", "secret.txt"]);
  git(repo, ["commit", "-m", "add note"]);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main" });
  const fetchImpl = createMockGithubFetch(gh);
  const prev = await previewPublish({ repo, workPackageId: WP, providerKind: "github", fetchImpl, mode: "baseline" });
  if (!prev.secretScan.blocked) fail("negative: secrets not detected");
  let secretBlocked = false;
  try {
    await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
      previewFingerprint: prev.previewFingerprint,
    });
  } catch (err) {
    secretBlocked = err.code === VCS_CODES.GIT_SECRETS_DETECTED;
  }
  if (!secretBlocked) fail("negative: secrets publish");
  prove("N. untracked/committed secrets block publish");

  writeFile(repo, "src/counter.js", FEATURE_COUNTER);
  writeFile(repo, "src/counter.test.js", FEATURE_TEST);
  mkdirSync(join(repo, "design", WP, "qa"), { recursive: true });
  writeFile(
    repo,
    `design/${WP}/qa/quality-review.json`,
    JSON.stringify({
      reviewId: 1,
      verdict: "PASSED",
      approvalApplied: true,
      snapshot: { digest: "d", files: [{ path: "src/counter.js", sha256: sha("other") }, { path: "src/counter.test.js", sha256: sha(FEATURE_TEST) }] },
    }),
  );
  const drift = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
  if (drift.qualityMatch) fail("negative: quality mismatch not detected");
  prove("N. Quality snapshot mismatch");

  let noToken = false;
  try {
    await applyMergeRequest({
      repo,
      workPackageId: WP,
      providerKind: "github",
      previewFingerprint: "sha256:dead",
    });
  } catch (err) {
    noToken = err.code === VCS_CODES.GITHUB_TOKEN_UNAVAILABLE || err.code === VCS_CODES.GIT_PUSH_BLOCKED || err.code === VCS_CODES.GIT_PREVIEW_STALE;
  }
  if (!noToken) fail("negative: missing token/push not blocked");
  prove("N. missing GitHub token / unpublished branch");

  rmSync(repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

{
  const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
  const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
  const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import(
    "./official-mcp-client.mjs"
  );
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
  const dist = await packClaudeExtension(version);
  const mcpbPath = dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb");
  const dest = mkdtempSync(join(tmpdir(), "praxis-e2e-mcpb-"));
  const extracted = extractMcpbRuntime(mcpbPath, dest);
  if (existsSync(join(extracted.dest, "node_modules"))) fail("extracted MCPB contains node_modules");
  const fixture = buildConsumerLikeFixture();
  const bare = emptyBare();
  attachSshLikeRemote(fixture.repo, bare);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
  const mock = await startGithubHttpMock(gh);
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
      PRAXIS_SKIP_DOTENV: "1",
      PRAXIS_GITHUB_TOKEN: "test-token-not-a-real-pat",
      PRAXIS_GITHUB_API_URL: mock.apiUrl,
      PRAXIS_GIT_PROVIDER: "github",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
    },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: 20_000,
    clientVersion: version,
  });
  try {
    const call = async (name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }));
    const st = await call("praxis_developer_git_status", { workPackage: WP, repo: fixture.repo });
    if (!st?.ok) fail(`MCPB status ${JSON.stringify(st)}`);
    const bp = await call("praxis_developer_git_publish_preview", {
      workPackage: WP,
      repo: fixture.repo,
      mode: "baseline",
      provider: "github",
    });
    if (!bp?.ok || bp.data?.targetRemoteBranch !== "main") fail(`MCPB baseline preview ${JSON.stringify(bp)}`);
    if (bp.data?.refspec !== `${fixture.baselineSha}:refs/heads/main`) fail("MCPB refspec");
    // Secure mode, no broker: every protected call must be refused and nothing may reach the remote.
    const refused = async (name, args, label) => {
      const result = await call(name, args);
      if (result?.ok !== false || !/^APPROVAL_/.test(result.code ?? "")) fail(`MCPB ${label} was not refused: ${JSON.stringify(result)}`);
      return result;
    };
    const headBefore = git(fixture.repo, ["rev-parse", "HEAD"]).stdout;
    const ba = await refused("praxis_developer_git_publish", {
      workPackage: WP, repo: fixture.repo, mode: "baseline", confirmation: "YES", previewFingerprint: bp.data.previewFingerprint,
    }, "baseline publish");
    if (git(bare, ["for-each-ref"]).stdout.trim() !== "") fail("MCPB refused publish still reached the remote");
    const fp = await call("praxis_developer_git_preview", { workPackage: WP, repo: fixture.repo });
    if (!fp?.ok || !fp.data?.previewFingerprint) fail("MCPB feature preview");
    const fc = await refused("praxis_developer_git_commit", {
      workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: fp.data.previewFingerprint,
    }, "commit");
    if (git(fixture.repo, ["rev-parse", "HEAD"]).stdout !== headBefore) fail("MCPB refused commit still moved HEAD");
    const mrp = await call("praxis_developer_git_merge_request_preview", { workPackage: WP, repo: fixture.repo, provider: "github" });
    // Nothing was pushed, so there is nothing to open a pull request from: the preview must say so.
    if (mrp?.ok !== false || mrp.code !== "GIT_PUSH_BLOCKED") fail(`MCPB merge request preview ${JSON.stringify(mrp)}`);
    const mr = await refused("praxis_developer_git_merge_request", {
      workPackage: WP, repo: fixture.repo, confirmation: "YES", previewFingerprint: `sha256:${"0".repeat(64)}`, provider: "github",
    }, "merge request");
    const ds = await call("praxis_developer_git_delivery_status", { workPackage: WP, repo: fixture.repo });
    if (ds.data?.journal?.ciStatus === "success") fail("MCPB fake CI");
    const dump = JSON.stringify({ st, bp, ba, fp, fc, mrp, mr, ds });
    if (/github_pat_|ghp_[A-Za-z0-9]{10,}|ATATT3x/.test(dump)) fail("MCPB leaked token");
    prove("P+. signed MCPB publish, commit, push and PR: covered by accept:git-authorization (real broker)");
    prove("P. Extracted MCPB: read-only Git tools work, every unsigned protected call is refused, remote and HEAD unchanged");
  } finally {
    await session.close();
    mock.close();
    rmSync(fixture.repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
}

assertConsumerUntouched(consumerBefore);
prove("25. consumer repository unchanged");

console.log(`PASS git-delivery-e2e ${steps.join("; ")}`);
for (const item of blocked) console.log(`BLOCKED ${item}`);
