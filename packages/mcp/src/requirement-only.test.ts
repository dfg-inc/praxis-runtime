import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";

async function call(tool: string, repo: string, role: string, args: Record<string, unknown>): Promise<McpEnvelope> {
  return (await callTool(tool, { repo, ...args }, { role, version: VERSION })) as McpEnvelope;
}

async function step(repo: string, role: string, command: object): Promise<McpEnvelope> {
  const previewed = await call("praxis_workflow_preview", repo, role, { command: JSON.stringify(command) });
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  const applied = await call("praxis_workflow_apply", repo, role, {
    command: JSON.stringify(command),
    confirmation: "YES",
    previewFingerprint: fingerprint,
  });
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

const REQ = "REQ-QRO-101";

/** A work item with one requirement (two acceptance criteria), one service, and no Story. */
async function setup(checks: unknown[] | null, answer = 42) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-qro-"));
  const service = join(repo, "svc");
  mkdirSync(service, { recursive: true });
  writeFileSync(join(service, "mod.mjs"), `export const answer = () => ${answer};\nexport const name = () => "svc";\n`);
  if (checks) {
    mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
    writeFileSync(join(repo, ".praxis", "quality", "checks.json"), JSON.stringify({ checks }));
  }
  await step(repo, "ba", { action: "open", projectId: "qro", title: "Requirement only", request: "No Story" });
  await step(repo, "ba", {
    action: "add-requirement",
    id: REQ,
    statement: "The service answers 42 and reports its name.",
    acceptanceCriteria: ["Answers 42.", "Reports its name."],
    serviceIds: ["svc"],
  });
  await step(repo, "architect", {
    action: "set-service",
    service: {
      id: "svc",
      name: "svc",
      kind: "module",
      localPath: service,
      responsibilities: ["answer"],
      requirementIds: [REQ],
      dependsOn: [],
      status: "in_progress",
    },
  });
  return repo;
}

const check = (criterion: string, fn: string, expectValue: unknown) => ({
  scenarioId: `S-${criterion}`,
  requirementId: REQ,
  acceptanceCriterionId: criterion,
  kind: "happy",
  serviceId: "svc",
  module: "mod.mjs",
  call: { function: fn, args: [] },
  expect: expectValue,
});

const AC1 = `${REQ}-AC-01`;
const AC2 = `${REQ}-AC-02`;

function requirementVerdict(repo: string) {
  const state = readPersistedState<{ verdicts: Array<{ scope: string; scopeId: string; verdict: string; evidenceRefs: string[] }> }>(repo);
  return state.verdicts.filter((v) => v.scope === "requirement" && v.scopeId === REQ).at(-1);
}

describe("verifying a work item with requirements but no Story (through MCP tools)", () => {
  it("regression: verify-stories no longer throws STORY_MISSING and records a requirement verdict", async () => {
    const repo = await setup([check(AC1, "answer", 42), check(AC2, "name", "svc")]);
    // Original defect: STORY_MISSING, so the item could never reach a verdict from executed evidence.
    const verified = await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    expect((verified.data.result as { verdict: string }).verdict).toBe("PASS");
    const verdict = requirementVerdict(repo);
    expect(verdict?.verdict).toBe("PASS");
    expect(verdict?.evidenceRefs).toEqual(expect.arrayContaining([`requirement:${REQ}@1`, `S-${AC1}:PASS`, `S-${AC2}:PASS`]));
    const state = readPersistedState<{ coverage: Array<{ storyId?: string }> }>(repo);
    expect(state.coverage.every((entry) => entry.storyId === undefined)).toBe(true);
  });

  it("an acceptance criterion without a check keeps the requirement below PASS", async () => {
    const repo = await setup([check(AC1, "answer", 42)]);
    await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    const verdict = requirementVerdict(repo);
    expect(verdict?.verdict).toBe("PASS_WITH_RISKS");
    expect(verdict?.evidenceRefs).toContain(`ac-not-verified:${AC2}`);
  });

  it("a failing check fails the requirement and returns it to Developer", async () => {
    const repo = await setup([check(AC1, "answer", 42), check(AC2, "name", "wrong")]);
    await step(repo, "quality", { action: "verify-stories", independentRerun: false });
    expect(requirementVerdict(repo)?.verdict).toBe("FAIL");
    const state = readPersistedState<{ findings: Array<{ owner: string; status: string }>; stage: string }>(repo);
    expect(state.findings.some((f) => f.owner === "developer" && f.status === "open")).toBe(true);
    expect(state.stage).toBe("changes_requested");
  });

  it("no Story and no checks reports missing evidence, records nothing, and writes nothing at preview", async () => {
    const repo = await setup(null);
    const dir = join(repo, ".praxis", "workflow");
    const before = JSON.stringify(readdirSync(dir).sort());
    const previewed = await call("praxis_workflow_preview", repo, "quality", {
      command: JSON.stringify({ action: "verify-stories", independentRerun: true }),
    });
    expect(previewed.ok).toBe(false);
    expect(previewed.errors?.join(" ")).toMatch(/EVIDENCE_MISSING/);
    expect(JSON.stringify(readdirSync(dir).sort())).toBe(before);
    expect(requirementVerdict(repo)).toBeUndefined();
  });

  it("verify-stories preview writes no file even when it succeeds", async () => {
    const repo = await setup([check(AC1, "answer", 42), check(AC2, "name", "svc")]);
    const dir = join(repo, ".praxis", "workflow");
    const before = JSON.stringify(readdirSync(dir).sort());
    const previewed = await call("praxis_workflow_preview", repo, "quality", {
      command: JSON.stringify({ action: "verify-stories", independentRerun: true }),
    });
    expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
    expect(JSON.stringify(readdirSync(dir).sort())).toBe(before);
    expect(existsSync(join(dir, "last-verification.json"))).toBe(false);
  });

  it("a check that names no acceptance criterion is rejected rather than guessed", async () => {
    const repo = await setup([{ ...check(AC1, "answer", 42), acceptanceCriterionId: undefined }]);
    const previewed = await call("praxis_workflow_preview", repo, "quality", {
      command: JSON.stringify({ action: "verify-stories", independentRerun: true }),
    });
    expect(previewed.ok).toBe(false);
    expect(previewed.errors?.join(" ")).toMatch(/CHECKS_INVALID.*acceptanceCriterionId/);
  });
});
