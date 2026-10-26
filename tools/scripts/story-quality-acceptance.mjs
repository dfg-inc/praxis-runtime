#!/usr/bin/env node
/**
 * User-story and multi-repository Quality acceptance.
 * Mutates disposable git repositories only.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createWorkflowHarness, HARNESS_NOTICE } from "./trusted-workflow-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const home = mkdtempSync(join(tmpdir(), "praxis-story-accept-"));
const workflowRepo = join(home, "workflow");
const repos = {
  api: join(home, "api"),
  identity: join(home, "identity"),
  worker: join(home, "worker"),
  frontend: join(home, "frontend"),
};
const bare = join(home, "frontend.git");
const report = { ...HARNESS_NOTICE, checks: [], blocked: [], notExecuted: [] };

function record(name, ok, detail) {
  report.checks.push({ name, result: ok ? "PASS" : "FAIL", detail });
  if (!ok) console.error(`FAIL ${name}: ${detail}`);
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout.trim();
}

function commitAll(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=Praxis Acceptance", "-c", "user.email=acceptance@praxis.local", "commit", "-m", message]);
}

const { callTool } = await import(pathToFileURL(join(root, "packages/mcp/dist/tools.js")).href);

const harness = createWorkflowHarness({ callTool, repo: workflowRepo, version });
const { apply, confirmStory } = harness;
const state = harness.state;

function service(id, extra) {
  return {
    id,
    name: id,
    kind: id === "frontend" ? "frontend" : id === "worker" ? "worker" : id === "api" ? "api" : "external",
    responsibilities: [id],
    requirementIds: ["REQ-BUI-061"],
    dependsOn: id === "worker" ? ["api", "identity"] : id === "frontend" ? ["api"] : [],
    status: "in_progress",
    ...extra,
  };
}

try {
  mkdirSync(join(workflowRepo, ".praxis", "quality"), { recursive: true });
  copyFileSync(
    join(root, "tools/fixtures/bulk-user-import/adapter.mjs"),
    join(workflowRepo, ".praxis", "quality", "adapter.mjs"),
  );
  for (const repo of Object.values(repos)) mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repos.api, "src", "bulk-import-api.mjs"), `export function previewCsv(csv, actor) {
  if (!actor || actor.role !== "org-admin") return { ok: false, code: "ACCESS_DENIED" };
  if (!String(csv).startsWith("email,name,role")) return { ok: false, code: "MALFORMED" };
  const rows = String(csv).trim().split("\\n").slice(1).filter(Boolean).map((line) => {
    const [email, name, role] = line.split(",");
    return { email, name, role, invalid: !String(email).includes("@") };
  });
  return { ok: true, rows, users: rows };
}
export function startImport(preview, actor) {
  if (!preview?.ok || actor?.role !== "org-admin") return { ok: false, code: "ACCESS_DENIED" };
  return { ok: true, status: "queued", id: "job-1", rows: preview.rows };
}
export function rowEvent(row) {
  return { name: "import.row.completed", email: row.email, role: row.role, outcome: row.invalid ? "REJECTED" : "CREATED" };
}
export function audit(result) {
  return { recorded: true, jobId: result.id ?? "job-1", created: result.created?.length ?? 0 };
}
`);
  writeFileSync(join(repos.identity, "src", "identity.mjs"), `export function authorize(actor) { return actor?.role === "org-admin"; }
export function allowedRoles() { return ["org-admin", "member"]; }
`);
  writeFileSync(join(repos.worker, "src", "import-rows.mjs"), `export function importRows(rows) {
  const created = [];
  const run = () => {
    for (const row of rows) {
      if (row.invalid || row.role === "nope") throw new Error("invalid row aborts the import");
      created.push(row);
    }
  };
  run();
  return { created, rejected: [], status: "COMPLETED" };
}
export function acceptEvent(event) {
  return { email: event.email, outcome: event.outcome };
}
`);
  writeFileSync(join(repos.worker, "src", "placeholder.test.js"), `import test from "node:test";
import assert from "node:assert/strict";
test("existing suite is green", () => { assert.equal(1 + 1, 2); });
`);
  writeFileSync(join(repos.worker, "notes.txt"), "unrelated contributor note\n");
  git(repos.worker, ["init", "-b", "main"]);
  commitAll(repos.worker, "initial import");
  git(repos.worker, ["checkout", "-b", "feature/import"]);
  git(repos.frontend, ["init", "-b", "main"]);
  writeFileSync(join(repos.frontend, "README.md"), "frontend\n");
  commitAll(repos.frontend, "initial frontend");
  git(home, ["init", "--bare", "-b", "main", "frontend.git"]);

  await apply({
    action: "open",
    mode: "classic",
    projectId: "bulk-user-import",
    title: "Bulk User Import",
    request: "Import users from CSV",
    source: "local",
  });
  await apply({
    action: "add-requirement",
    id: "REQ-BUI-061",
    statement: "Invalid, duplicate or failed rows never prevent valid rows from being created.",
    acceptanceCriteria: ["AC-BUI-061 valid rows are created when other rows are invalid."],
    serviceIds: ["api", "worker", "identity", "frontend"],
  });
  const story = await apply({
    action: "add-story",
    id: "US-BUI-001",
    requirementIds: ["REQ-BUI-061"],
    actor: "organization admin",
    narrative: "As a organization admin, I want to import users from a CSV, so that onboarding does not require one-by-one entry.",
    objective: "Create the valid users from a confirmed CSV",
    userValue: "Faster onboarding",
    preconditions: ["The actor is an organization admin."],
    happyPath: [
      "Admin opens import",
      "Admin uploads a valid CSV",
      "Preview shows the users",
      "Admin confirms",
      "The job runs",
      "Users are created",
      "The summary is shown",
      "Audit is recorded",
    ],
    alternatives: ["A file with warnings still previews the valid rows."],
    negative: ["A malformed file is rejected.", "A member is denied."],
    edgeCases: ["Partial success", "Retry does not duplicate users", "A second import is locked."],
    businessRules: ["Invalid rows never prevent valid rows."],
    acceptanceCriteria: [{
      id: "US-BUI-001-AC-01",
      given: "an organization admin and a CSV",
      when: "the admin confirms the import",
      then: "valid users are created and the summary is shown",
    }],
    expectedResults: ["Valid users exist", "Invalid rows are reported", "The summary shows the outcome"],
    dependencies: ["identity role catalog"],
    assumptionIds: [],
    unresolvedDecisionIds: [],
    serviceIds: ["api", "worker", "identity", "frontend"],
    confirmedBehavior: false,
  });
  // Creating a story can never confirm it; confirm the exact revision with the harness's ephemeral grant.
  await confirmStory("US-BUI-001");
  record("A-story-created", story.result.storyId === "US-BUI-001" && state().stories[0].happyPath.length >= 8, story.result.storyId);

  await apply({ action: "set-service", service: service("api", { repository: "bulk-import-api", localPath: repos.api, remoteUrl: "file:///tmp/unused-api" }) });
  await apply({ action: "set-service", service: service("worker", { repository: "bulk-import-worker", localPath: repos.worker, branch: "feature/import" }) });
  await apply({ action: "set-service", service: service("identity") });
  await apply({ action: "set-service", service: service("frontend") });
  const missing = await apply({ action: "locate-repositories" });
  const missingIds = missing.result.questions.map((item) => item.id).sort();
  record("F-asks-missing-repositories", missingIds.join(",") === "Q-REPO-FRONTEND,Q-REPO-IDENTITY", missingIds.join(","));

  await apply({ action: "set-service", service: service("identity", { repository: "bulk-import-identity", localPath: repos.identity }) });
  const again = await apply({ action: "locate-repositories" });
  record(
    "G-reuses-known-repositories",
    again.result.questions.length === 1 && again.result.questions[0].id === "Q-REPO-FRONTEND",
    again.result.questions.map((item) => item.id).join(","),
  );
  await apply({
    action: "set-service",
    service: service("frontend", { repository: "bulk-import-frontend", localPath: repos.frontend, remoteUrl: bare }),
  });
  const complete = await apply({ action: "locate-repositories" });
  record("G-no-repeat-questions", complete.result.questions.length === 0, String(complete.result.questions.length));

  await apply({
    action: "handoff",
    sourceRole: "ba",
    targetRole: "architect",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
  });
  await apply({
    action: "handoff",
    sourceRole: "architect",
    targetRole: "developer",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
  });
  const developer = state().handoffs.at(-1);
  record(
    "B-ids-survive-handoff",
    developer.storyIds.includes("US-BUI-001") && developer.requirementIds.includes("REQ-BUI-061") && developer.acceptanceCriterionIds.includes("REQ-BUI-061-AC-01"),
    developer.storyIds.join(","),
  );

  const verified = await apply({ action: "verify-stories" });
  const byId = Object.fromEntries(verified.result.scenarios.map((item) => [item.scenarioId, item.status]));
  record("C-happy-path-executed", byId["US-BUI-001-HAPPY-PREVIEW"] === "PASS" && byId["US-BUI-001-HAPPY-PROCESS"] === "PASS", JSON.stringify(byId));
  record("D-partial-fails-despite-green-tests", byId["US-BUI-001-EDGE-PARTIAL"] === "FAIL" && verified.result.verdict === "FAIL", verified.result.verdict);
  record("E-missing-frontend", byId["US-BUI-001-HAPPY-SUMMARY"] === "NOT_VERIFIED", byId["US-BUI-001-HAPPY-SUMMARY"]);
  record("H-incompatible-event", byId["US-BUI-001-CONTRACT-EVENT"] === "FAIL", byId["US-BUI-001-CONTRACT-EVENT"]);
  const partial = state().findings.find((item) => item.suggestion === "worker.partial-success");
  record(
    "I-actionable-finding",
    partial?.storyIds?.includes("US-BUI-001") && partial.requirementIds.includes("REQ-BUI-061") && partial.severity === "critical" && partial.file.includes("import-rows"),
    partial?.id,
  );

  const refused = await callTool(
    "praxis_workflow_apply",
    {
      repo: workflowRepo,
      command: JSON.stringify({ action: "prepare-fix", serviceId: "worker", authorized: false, existingBranch: "main" }),
      previewFingerprint: "none",
      confirmation: "YES",
    },
    { role: "runtime", version },
  );
  record("refuses-unauthorized-fix", refused.ok === false, refused.code ?? refused.errors?.[0]);

  harness.approveServiceFix(state().services.find((item) => item.id === "worker"));
  const workerFix = await apply({ action: "prepare-fix", serviceId: "worker", authorized: true, existingBranch: "feature/import" });
  const workerLog = git(repos.worker, ["log", "--oneline"]);
  const notes = readFileSync(join(repos.worker, "notes.txt"), "utf8");
  record(
    "J-commits-on-authorized-branch",
    workerFix.result.resolved === false && workerFix.result.commitSha !== "PLANNED" && notes.includes("unrelated") && workerLog.split("\n").length >= 2,
    workerFix.result.commitSha,
  );
  record("L-keeps-unrelated-work", git(repos.worker, ["rev-parse", "--abbrev-ref", "HEAD"]) === "feature/import" && notes.includes("unrelated"), workerLog);

  harness.approveServiceFix(state().services.find((item) => item.id === "frontend"), { push: true });
  const frontendFix = await apply({ action: "prepare-fix", serviceId: "frontend", authorized: true });
  const pushed = spawnSync("git", ["ls-remote", "--heads", bare], { encoding: "utf8" });
  record(
    "K-opens-review-on-test-remote",
    frontendFix.result.mrStatus === "opened" && frontendFix.result.changeRequest === "mr:quality/frontend-story-fix" && pushed.stdout.includes("quality/frontend-story-fix"),
    frontendFix.result.changeRequest,
  );
  report.notExecuted.push({
    name: "gitlab-api-merge-request",
    result: "NOT EXECUTED",
    detail: "The review ref was pushed to a disposable local remote. No GitLab API token is available, so a hosted Merge Request was not opened.",
  });

  const reverified = await apply({ action: "verify-stories", independentRerun: true });
  const after = Object.fromEntries(reverified.result.scenarios.map((item) => [item.scenarioId, item.status]));
  record(
    "M-independent-reverify",
    reverified.result.verdict === "PASS" && after["US-BUI-001-EDGE-PARTIAL"] === "PASS" && after["US-BUI-001-HAPPY-SUMMARY"] === "PASS" && after["US-BUI-001-CONTRACT-EVENT"] === "PASS" && state().verdicts.filter((item) => item.scope === "feature").length >= 2,
    reverified.result.verdict,
  );
  record(
    "findings-updated",
    state().findings.some((item) => item.id === partial.id && item.status === "resolved"),
    state().findings.map((item) => `${item.id}:${item.status}`).join(","),
  );

  const statusModule = pathToFileURL(join(root, "packages/mcp/dist/workflow-store.js")).href;
  const resumed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { workflowStatus, loadWorkflow } from ${JSON.stringify(statusModule)};
     const state = loadWorkflow(process.argv[1]);
     process.stdout.write(JSON.stringify({
       workflowId: workflowStatus(process.argv[1]).workflowId,
       stories: state.stories.map((item) => item.id),
       changes: state.changes.map((item) => item.changeRequest ?? item.commitSha),
       findings: state.findings.map((item) => item.status),
       verdicts: state.verdicts.map((item) => item.verdict),
     }));`,
    workflowRepo,
  ], { encoding: "utf8" });
  const resumedState = resumed.status === 0 ? JSON.parse(resumed.stdout) : null;
  record(
    "N-resume-preserves-trace",
    resumedState?.stories?.includes("US-BUI-001") && resumedState.changes.length >= 2 && resumedState.verdicts.includes("FAIL") && resumedState.verdicts.includes("PASS"),
    resumed.stderr || resumed.stdout,
  );
} catch (err) {
  record("story-acceptance", false, err instanceof Error ? err.stack ?? err.message : String(err));
  console.log(JSON.stringify(report, null, 2));
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const failed = report.checks.some((item) => item.result !== "PASS");
console.log(JSON.stringify(report, null, 2));
rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
