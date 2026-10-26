#!/usr/bin/env node
/**
 * Quality acceptance for a desk-booking project.
 * The defect, modules, and patch live in this fixture. Runtime only executes checks and applies the host patch.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createWorkflowHarness, HARNESS_NOTICE } from "./trusted-workflow-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const home = mkdtempSync(join(tmpdir(), "praxis-generic-accept-"));
const workflowRepo = join(home, "workflow");
const bookingRepo = join(home, "booking");
const auditRepo = join(home, "audit");
const report = { ...HARNESS_NOTICE, checks: [], blocked: [], notExecuted: [] };

const buggy = `def book(request):
    return {"status": "confirmed", "desk": request["desk"], "guest": request["guest"], "day": request["day"]}

def cancel(request):
    return {"status": "cancelled", "desk": request["desk"], "day": request["day"]}
`;

const fixed = `bookings = []

def book(request):
    for existing in bookings:
        if existing["desk"] == request["desk"] and existing["day"] == request["day"] and existing["status"] == "confirmed":
            return {"status": "rejected", "reason": "desk-taken", "desk": request["desk"], "day": request["day"]}
    record = {"status": "confirmed", "desk": request["desk"], "guest": request["guest"], "day": request["day"]}
    bookings.append(record)
    return record

def cancel(request):
    for existing in bookings:
        if existing["desk"] == request["desk"] and existing["day"] == request["day"] and existing["status"] == "confirmed":
            existing["status"] = "cancelled"
            return {"status": "cancelled", "desk": request["desk"], "day": request["day"]}
    return {"status": "rejected", "reason": "not-found", "desk": request["desk"], "day": request["day"]}

def availability(request):
    for existing in bookings:
        if existing["desk"] == request["desk"] and existing["day"] == request["day"] and existing["status"] == "confirmed":
            return {"desk": request["desk"], "day": request["day"], "free": False}
    return {"desk": request["desk"], "day": request["day"], "free": True}
`;

function record(name, ok, detail) {
  report.checks.push({ name, result: ok ? "PASS" : "FAIL", detail });
  if (!ok) console.error(`FAIL ${name}: ${detail}`);
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout.trim();
}

const { callTool } = await import(pathToFileURL(join(root, "packages/mcp/dist/tools.js")).href);

const harness = createWorkflowHarness({ callTool, repo: workflowRepo, version });
const { apply, confirmStory } = harness;

function service(id, extra) {
  return {
    id,
    name: id,
    kind: id === "audit" ? "external" : "api",
    responsibilities: [id],
    requirementIds: ["REQ-DSK-001"],
    dependsOn: id === "audit" ? ["booking"] : [],
    status: "in_progress",
    ...extra,
  };
}

try {
  const engine = readFileSync(join(root, "packages/mcp/src/story-engine.ts"), "utf8");
  record(
    "runtime-has-no-product-template",
    !engine.includes("WORKER_FIX") && !engine.includes("FRONTEND_FIX") && !engine.includes("bulk-import-api") && !engine.includes("desk_booking"),
    "story-engine.ts",
  );
  mkdirSync(join(bookingRepo, "app"), { recursive: true });
  mkdirSync(join(bookingRepo, "tests"), { recursive: true });
  mkdirSync(join(auditRepo, "app"), { recursive: true });
  writeFileSync(join(bookingRepo, "app", "desk_booking.py"), buggy);
  writeFileSync(join(bookingRepo, "NOTES.txt"), "unrelated booking note\n");
  writeFileSync(
    join(bookingRepo, "tests", "test_smoke.py"),
    "import unittest\n\nclass Smoke(unittest.TestCase):\n    def test_arithmetic(self):\n        self.assertEqual(1 + 1, 2)\n",
  );
  writeFileSync(
    join(auditRepo, "app", "audit_log.py"),
    "def record(event):\n    return {\"recorded\": True, \"desk\": event[\"desk\"]}\n",
  );
  git(bookingRepo, ["init", "-b", "main"]);
  git(bookingRepo, ["add", "-A"]);
  git(bookingRepo, ["-c", "user.name=Praxis Acceptance", "-c", "user.email=acceptance@praxis.local", "commit", "-m", "initial booking"]);
  mkdirSync(join(workflowRepo, ".praxis", "quality"), { recursive: true });
  writeFileSync(
    join(workflowRepo, ".praxis", "quality", "checks.json"),
    JSON.stringify({
      checks: [
        {
          scenarioId: "US-DSK-001-HAPPY-BOOK",
          storyId: "US-DSK-001",
          requirementId: "REQ-DSK-001",
          acceptanceCriterionId: "US-DSK-001-AC-01",
          kind: "happy",
          serviceId: "booking",
          level: "unit",
          module: "app/desk_booking.py",
          call: { function: "book", args: [{ desk: "A1", guest: "ada", day: "2026-11-02" }] },
          expect: { status: "confirmed", desk: "A1", guest: "ada", day: "2026-11-02" },
        },
        {
          scenarioId: "US-DSK-001-NEGATIVE-TAKEN",
          storyId: "US-DSK-001",
          requirementId: "REQ-DSK-001",
          acceptanceCriterionId: "US-DSK-001-AC-02",
          kind: "negative",
          serviceId: "booking",
          level: "unit",
          module: "app/desk_booking.py",
          critical: true,
          steps: [
            { function: "book", args: [{ desk: "A1", guest: "ada", day: "2026-11-02" }] },
            { function: "book", args: [{ desk: "A1", guest: "bea", day: "2026-11-02" }] },
          ],
          expect: { status: "rejected", reason: "desk-taken", desk: "A1", day: "2026-11-02" },
        },
        {
          scenarioId: "US-DSK-001-EDGE-CANCEL",
          storyId: "US-DSK-001",
          requirementId: "REQ-DSK-001",
          acceptanceCriterionId: "US-DSK-001-AC-03",
          kind: "edge",
          serviceId: "booking",
          level: "unit",
          module: "app/desk_booking.py",
          critical: true,
          steps: [
            { function: "book", args: [{ desk: "B2", guest: "ada", day: "2026-11-03" }] },
            { function: "cancel", args: [{ desk: "B2", day: "2026-11-03" }] },
            { function: "availability", args: [{ desk: "B2", day: "2026-11-03" }] },
          ],
          expect: { desk: "B2", day: "2026-11-03", free: true },
        },
        {
          scenarioId: "US-DSK-001-CONTRACT-AUDIT",
          storyId: "US-DSK-001",
          requirementId: "REQ-DSK-001",
          acceptanceCriterionId: "US-DSK-001-AC-01",
          kind: "contract",
          serviceId: "audit",
          level: "contract",
          module: "app/audit_log.py",
          call: { function: "record", args: [{ desk: "A1", guest: "ada" }] },
          expect: { recorded: true, desk: "A1" },
        },
      ],
    }, null, 2),
  );

  await apply({
    action: "open",
    mode: "classic",
    projectId: "desk-booking",
    title: "Desk booking",
    request: "Reserve a desk for a day",
    source: "local",
  });
  await apply({
    action: "add-requirement",
    id: "REQ-DSK-001",
    statement: "A desk can have only one confirmed reservation for a given day.",
    acceptanceCriteria: ["A second reservation for the same desk and day is rejected."],
    serviceIds: ["booking", "audit"],
  });
  await apply({
    action: "add-story",
    id: "US-DSK-001",
    requirementIds: ["REQ-DSK-001"],
    actor: "guest",
    narrative: "As a guest, I want to reserve a desk for a day, so that I have a place to work.",
    objective: "Hold one desk for one day",
    userValue: "A guaranteed workspace",
    preconditions: ["The desk exists."],
    happyPath: ["Guest selects a free desk", "The reservation is confirmed"],
    alternatives: ["The guest chooses another day."],
    negative: ["A second guest cannot take the same desk on the same day."],
    edgeCases: ["Cancelling a reservation releases the desk."],
    businessRules: ["One confirmed reservation per desk per day."],
    acceptanceCriteria: [
      { id: "US-DSK-001-AC-01", given: "desk A1 is free", when: "Ada books it", then: "the reservation is confirmed" },
      { id: "US-DSK-001-AC-02", given: "Ada holds desk A1", when: "Bea books the same desk and day", then: "Bea is rejected" },
      { id: "US-DSK-001-AC-03", given: "a reservation was cancelled", when: "another guest books that desk", then: "the new reservation is confirmed" },
    ],
    expectedResults: ["One confirmed booking", "The audit record keeps the desk"],
    dependencies: [],
    assumptionIds: [],
    unresolvedDecisionIds: [],
    serviceIds: ["booking", "audit"],
    confirmedBehavior: false,
  });
  await confirmStory("US-DSK-001");
  await apply({ action: "set-service", service: service("booking", { repository: "desk-booking", localPath: bookingRepo }) });
  await apply({ action: "set-service", service: service("audit", { repository: "desk-audit" }) });
  const missing = await apply({ action: "locate-repositories" });
  record("asks-only-for-audit", missing.result.questions.map((item) => item.id).join(",") === "Q-REPO-AUDIT", missing.result.questions.map((item) => item.id).join(","));

  const first = await apply({ action: "verify-stories" });
  const byId = Object.fromEntries(first.result.scenarios.map((item) => [item.scenarioId, item.status]));
  const profile = first.result.profiles.find((item) => item.serviceId === "booking");
  record(
    "profile-detects-python",
    profile?.languages?.includes("python") && profile.testRunners.includes("unittest"),
    JSON.stringify({ languages: profile?.languages, tests: profile?.testRunners }),
  );
  record("different-from-bulk-import", first.result.strategy === "executable-checks" && !JSON.stringify(byId).includes("BUI"), first.result.strategy);
  record("defect-found", byId["US-DSK-001-NEGATIVE-TAKEN"] === "FAIL" && first.result.verdict === "FAIL", byId["US-DSK-001-NEGATIVE-TAKEN"]);
  record("missing-service-blocks-feature", byId["US-DSK-001-CONTRACT-AUDIT"] === "BLOCKED" && first.result.verdict === "FAIL", byId["US-DSK-001-CONTRACT-AUDIT"]);
  record("evidence-is-not-deployed", first.result.deployedEndToEnd === false && first.result.evidenceLevel === "unit", first.result.evidenceLevel);
  const bookingVerdict = first.result.serviceVerdicts.find((item) => item.serviceId === "booking");
  const featureState = harness.state();
  record(
    "service-and-feature-results",
    bookingVerdict?.verdict === "FAIL" && featureState.verdicts.some((item) => item.scope === "service" && item.scopeId === "booking") && featureState.verdicts.some((item) => item.scope === "feature"),
    bookingVerdict?.verdict,
  );

  await apply({ action: "set-service", service: service("audit", { repository: "desk-audit", localPath: auditRepo }) });
  const second = await apply({ action: "verify-stories" });
  const mid = Object.fromEntries(second.result.scenarios.map((item) => [item.scenarioId, item.status]));
  record(
    "audit-passes-while-booking-fails",
    mid["US-DSK-001-CONTRACT-AUDIT"] === "PASS" && mid["US-DSK-001-NEGATIVE-TAKEN"] === "FAIL" && second.result.verdict === "FAIL",
    JSON.stringify(mid),
  );
  const before = readFileSync(join(bookingRepo, "app", "desk_booking.py"), "utf8");
  const refused = await callTool(
    "praxis_workflow_apply",
    {
      repo: workflowRepo,
      command: JSON.stringify({ action: "prepare-fix", serviceId: "booking", authorized: true }),
      previewFingerprint: "none",
      confirmation: "YES",
    },
    { role: "runtime", version },
  );
  const afterRefusal = readFileSync(join(bookingRepo, "app", "desk_booking.py"), "utf8");
  record(
    "no-template-fix",
    refused.ok === false && JSON.stringify(refused.errors).includes("HOST_EDIT_UNAVAILABLE") && afterRefusal === before,
    refused.errors?.[0],
  );

  mkdirSync(join(workflowRepo, ".praxis", "quality", "proposals"), { recursive: true });
  writeFileSync(
    join(workflowRepo, ".praxis", "quality", "proposals", "booking.json"),
    JSON.stringify({ files: [{ path: "app/desk_booking.py", after: fixed }] }),
  );
  harness.approveServiceFix(harness.state().services.find((item) => item.id === "booking"));
  const committed = await apply({ action: "prepare-fix", serviceId: "booking", authorized: true });
  const notes = readFileSync(join(bookingRepo, "NOTES.txt"), "utf8");
  record(
    "host-patch-applied",
    committed.result.resolved === false && committed.result.commitSha !== "PLANNED" && git(bookingRepo, ["rev-parse", "--abbrev-ref", "HEAD"]) === "quality/booking-story-fix" && notes.includes("unrelated"),
    committed.result.commitSha,
  );
  record("branch-was-not-merged", !git(bookingRepo, ["log", "--oneline"]).includes("Merge"), git(bookingRepo, ["log", "--oneline"]));

  const reverified = await apply({ action: "verify-stories", independentRerun: true });
  const done = Object.fromEntries(reverified.result.scenarios.map((item) => [item.scenarioId, item.status]));
  record(
    "independent-reverify-pass",
    reverified.result.verdict === "PASS" && done["US-DSK-001-NEGATIVE-TAKEN"] === "PASS" && done["US-DSK-001-EDGE-CANCEL"] === "PASS" && reverified.result.deployedEndToEnd === false,
    reverified.result.verdict,
  );
} catch (err) {
  record("generic-acceptance", false, err instanceof Error ? err.stack ?? err.message : String(err));
  console.log(JSON.stringify(report, null, 2));
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const failed = report.checks.some((item) => item.result !== "PASS");
console.log(JSON.stringify(report, null, 2));
rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
