import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criterionStatus } from "@praxis/contracts";
import { describe, expect, it } from "vitest";
import { bundleDigest } from "./browser-verification.js";
import { callTool } from "./tools.js";
import { loadWorkflow } from "./workflow-store.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const call = async (tool: string, repo: string, args: Record<string, unknown>): Promise<McpEnvelope> => (await callTool(tool, { repo, ...args }, { role: "ba", version: "test" })) as McpEnvelope;
const apply = async (repo: string, command: object) => {
  const text = JSON.stringify(command);
  const p = await call("praxis_workflow_preview", repo, { command: text });
  const a = await call("praxis_workflow_apply", repo, { command: text, confirmation: "YES", previewFingerprint: p.data.fingerprint });
  expect(a.ok, JSON.stringify(a.errors)).toBe(true);
};

describe("round 8: browser evidence follows the bundle it was recorded for", () => {
  it("a changed or missing bundle makes the result stale in memory, never in the file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-drift-"));
    await apply(repo, { action: "open", mode: "guided", projectId: "drift", title: "Drift", request: "r" });
    await apply(repo, { action: "add-requirement", id: "REQ-DRF-001", statement: "x", acceptanceCriteria: ["a"] });
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "index.html"), "<!doctype html><title>v1</title>");
    const item = join(repo, ".praxis", "workflow", "items", readdirSync(join(repo, ".praxis", "workflow", "items")).find((n) => n.endsWith(".json") && !n.includes(".bak"))!);
    const state = JSON.parse(readFileSync(item, "utf8"));
    const ac = state.requirements[0].acceptanceCriteria[0];
    state.coverage.push({ requirementId: "REQ-DRF-001", acceptanceCriterionId: ac.id, scenarioId: "B-1", kind: "happy", serviceId: "svc-web", status: "PASS", evidence: [], source: { kind: "browser", subjectDigest: bundleDigest(join(repo, "dist")), artifacts: [] } });
    writeFileSync(item, JSON.stringify(state));
    mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
    writeFileSync(join(repo, ".praxis", "quality", "checks.json"), JSON.stringify({ browser: { serve: { root: "dist" } }, checks: [] }));

    const status = () => { const s = loadWorkflow(repo)!; return criterionStatus(s, "REQ-DRF-001", { id: ac.id, revision: s.requirements[0]!.acceptanceCriteria[0]!.revision ?? 1 }, ac.id).state; };
    expect(status()).toBe("passed");
    const probe = JSON.stringify({ action: "add-requirement", id: "REQ-DRF-009", statement: "z", acceptanceCriteria: ["c"] });
    const before = (await call("praxis_workflow_preview", repo, { command: probe })).data.fingerprint;
    appendFileSync(join(repo, "dist", "index.html"), "<!-- changed -->");
    expect(status()).toBe("stale");
    // what a preview was bound to does not change because a build touched dist
    expect((await call("praxis_workflow_preview", repo, { command: probe })).data.fingerprint).toBe(before);
    // nothing about the drift is written when the state is saved by an unrelated command
    await apply(repo, { action: "add-requirement", id: "REQ-DRF-002", statement: "y", acceptanceCriteria: ["b"] });
    expect(readFileSync(item, "utf8")).not.toContain("drifted");
    // the bundle restored to what was recorded: current again
    writeFileSync(join(repo, "dist", "index.html"), "<!doctype html><title>v1</title>");
    expect(status()).toBe("passed");
  }, 30_000);
});
