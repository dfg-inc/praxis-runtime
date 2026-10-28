import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const call = async (tool: string, repo: string, role: string, args: Record<string, unknown>): Promise<McpEnvelope> => (await callTool(tool, { repo, ...args }, { role, version: "test" })) as McpEnvelope;
async function step(repo: string, role: string, command: object, expectOk = true): Promise<McpEnvelope> {
  const previewed = await call("praxis_workflow_preview", repo, role, { command: JSON.stringify(command) });
  if (!previewed.ok) {
    if (!expectOk) return previewed;
    throw new Error(JSON.stringify(previewed.errors));
  }
  const applied = await call("praxis_workflow_apply", repo, role, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint: previewed.data.fingerprint as string });
  if (!expectOk) return applied;
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

type State = { coverage: Array<{ scenarioId: string; status: string; source?: { kind: string; runId?: string } }>; coverageRevision: number; verdicts: Array<{ scope: string; scopeId: string; verdict: string }> };
const R1 = "REQ-QEM-001";
const R2 = "REQ-QEM-002";

async function setup(opts: { registry?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-qem-"));
  const svc = join(repo, "svc");
  mkdirSync(svc, { recursive: true });
  writeFileSync(join(svc, "mod.mjs"), "export const a = () => 1;\nexport const b = () => 2;\n");
  await step(repo, "ba", { action: "open", projectId: "qem", title: "Evidence model", request: "evidence" });
  await step(repo, "ba", { action: "add-requirement", id: R1, statement: "one", acceptanceCriteria: ["a is 1", "b is 2"], serviceIds: ["svc"] });
  await step(repo, "ba", { action: "add-requirement", id: R2, statement: "two", acceptanceCriteria: ["c"], serviceIds: ["svc"] });
  if (opts.registry) {
    await step(repo, "architect", { action: "register-repository", repository: { id: "web", name: "web", localPath: svc } });
    await step(repo, "architect", { action: "set-service", service: { id: "svc", name: "svc", kind: "module", repositoryId: "web", responsibilities: ["x"], requirementIds: [R1, R2], dependsOn: [], status: "in_progress" } });
  } else {
    await step(repo, "architect", { action: "set-service", service: { id: "svc", name: "svc", kind: "module", localPath: svc, responsibilities: ["x"], requirementIds: [R1, R2], dependsOn: [], status: "in_progress" } });
  }
  return { repo, svc };
}

const checkFor = (ac: string, fn: string, expected: unknown, req = R1) => ({ scenarioId: `S-${ac}`, requirementId: req, acceptanceCriterionId: ac, kind: "happy", serviceId: "svc", module: "mod.mjs", call: { function: fn, args: [] }, expect: expected });
const writeChecks = (repo: string, checks: unknown[]) => {
  mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
  writeFileSync(join(repo, ".praxis", "quality", "checks.json"), JSON.stringify({ checks }));
};

describe("Quality evidence model through the MCP tools (S15, S17, S18, S19)", () => {
  it("checks that cover one requirement only: counts are reported, the feature is not PASS, evidence is marked executed", async () => {
    const { repo } = await setup();
    writeChecks(repo, [checkFor(`${R1}-AC-01`, "a", 1), checkFor(`${R1}-AC-02`, "b", 2)]);
    const verified = await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    const result = verified.data.result as { verdict: string; coverage: { totals: { total: number; passed: number; missing: number }; requirements: Array<{ id: string; verdict: string }> } };
    expect(result.verdict).toBe("FAIL");
    expect(result.coverage.totals).toMatchObject({ total: 3, passed: 2, missing: 1 });
    expect(result.coverage.requirements.find((r) => r.id === R1)?.verdict).toBe("PASS");
    expect(result.coverage.requirements.find((r) => r.id === R2)?.verdict).toBe("FAIL");
    const state = readPersistedState<State>(repo);
    expect(state.coverage.every((e) => e.source?.kind === "executed" && Boolean(e.source.runId))).toBe(true);
    // the same state, asked through feature-verdict, agrees about the evidence
    const feature = await call("praxis_workflow_preview", repo, "quality", { command: JSON.stringify({ action: "feature-verdict" }) });
    expect((feature.data.result as { evidence: { verdict: string; gaps: string[] } }).evidence.verdict).toBe("FAIL");
    expect((feature.data.result as { gaps: string[] }).gaps.join("\n")).toContain(`${R2}: no evidence for any of 1 acceptance criteria`);
  });

  it("an agent's own record-verification is stored as agent-attested, whatever source it claims, and never makes a requirement PASS", async () => {
    const { repo } = await setup();
    const scenario = (ac: string, id: string) => ({ requirementId: R2, acceptanceCriterionId: ac, scenarioId: id, kind: "happy", serviceId: "svc", status: "PASS", critical: true, evidence: ["i looked at it"], source: { kind: "executed", runId: "run-fake", artifacts: [] } });
    await step(repo, "quality", { action: "record-verification", independentRerun: true, scenarios: [scenario(`${R2}-AC-01`, "AGENT-1")] });
    const state = readPersistedState<State>(repo);
    expect(state.coverage[0]?.source?.kind).toBe("agent");
    expect(state.coverage[0]?.source?.runId).toBeUndefined();
    const verdict = state.verdicts.filter((v) => v.scope === "requirement" && v.scopeId === R2).at(-1);
    expect(verdict?.verdict).toBe("PASS_WITH_RISKS");
  });

  it("a verify-stories re-run keeps evidence from other sources and updates its own in place; a fixed bug can be verified again", async () => {
    const { repo, svc } = await setup();
    writeChecks(repo, [checkFor(`${R1}-AC-01`, "a", 1), checkFor(`${R1}-AC-02`, "b", 99)]);
    await step(repo, "quality", { action: "record-verification", independentRerun: true, scenarios: [{ requirementId: R2, acceptanceCriterionId: `${R2}-AC-01`, scenarioId: "AGENT-1", kind: "happy", serviceId: "svc", status: "PASS", critical: true, evidence: ["x"] }] });
    const first = await step(repo, "quality", { action: "verify-stories", independentRerun: false });
    expect((first.data.result as { coverage: { requirements: Array<{ id: string; verdict: string }> } }).coverage.requirements.find((r) => r.id === R1)?.verdict).toBe("FAIL");
    let state = readPersistedState<State>(repo);
    expect(state.coverage.find((e) => e.scenarioId === `S-${R1}-AC-02`)?.status).toBe("FAIL");
    // the Developer fixes b(); the same checks are run again
    writeFileSync(join(svc, "mod.mjs"), "export const a = () => 1;\nexport const b = () => 99;\n");
    await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    state = readPersistedState<State>(repo);
    expect(state.coverage.map((e) => e.scenarioId).sort()).toEqual(["AGENT-1", `S-${R1}-AC-01`, `S-${R1}-AC-02`]);
    expect(state.coverage.find((e) => e.scenarioId === `S-${R1}-AC-02`)?.status).toBe("PASS");
    expect(state.coverage.find((e) => e.scenarioId === "AGENT-1")?.source?.kind).toBe("agent");
    const requirementVerdicts = state.verdicts.filter((v) => v.scope === "requirement" && v.scopeId === R1);
    expect(requirementVerdicts.at(-1)?.verdict).toBe("PASS");
  });

  it("a service in a registered repository is verified without its own localPath (S15)", async () => {
    const { repo } = await setup({ registry: true });
    writeChecks(repo, [checkFor(`${R1}-AC-01`, "a", 1)]);
    const verified = await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    const state = readPersistedState<State>(repo);
    expect(state.coverage.find((e) => e.scenarioId === `S-${R1}-AC-01`)?.status).toBe("PASS");
    expect(JSON.stringify(verified.data.result)).not.toContain("repository location is missing");
  });
});
