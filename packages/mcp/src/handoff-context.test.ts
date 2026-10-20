import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installHostApproval } from "@praxis/contracts";
import { callTool } from "./tools.js";
import { readPersistedState } from "./workflow-test-helpers.js";

const VERSION = "test";

type Envelope = { ok: boolean; errors?: string[]; data: Record<string, unknown> };

/** Real MCP preview then apply, with a scoped host approval bound to the preview fingerprint. */
async function step(repo: string, role: string, command: object): Promise<Envelope> {
  const previewed = (await callTool(
    "praxis_workflow_preview",
    { repo, command: JSON.stringify(command) },
    { role, version: VERSION },
  )) as Envelope;
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  installHostApproval(repo, {
    planId: `wf-${fingerprint.slice(-12)}`,
    role: role as "ba",
    provider: "local",
    workItemIds: ["local-workflow"],
    repositories: [resolve(repo)],
    operations: ["repository_edit"],
    inScope: ["praxis_workflow_apply"],
    outOfScope: [],
    assumptions: [],
    risks: ["writes the local workflow file"],
    previewFingerprint: fingerprint,
  });
  const applied = (await callTool(
    "praxis_workflow_apply",
    { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: fingerprint },
    { role, version: VERSION },
  )) as Envelope;
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

type Persisted = {
  handoffs: Array<{
    handoffId: string;
    sourceRole: string;
    targetRole: string;
    risks: string[];
    openQuestions: string[];
    blockers: string[];
    assumptions: string[];
    notes?: string;
    resolved: string[];
    revision: number;
    decisionRecords: Array<{ id: string; rationale?: string }>;
  }>;
};

function persisted(repo: string): Persisted {
  return readPersistedState<Persisted>(repo);
}

describe("handoff context across roles through MCP workflow tools", () => {
  it("BA risks, questions, blockers and notes reach Quality in the persisted state", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-hof-"));
    await step(repo, "ba", { action: "open", projectId: "hof", title: "Handoff", request: "Carry context" });
    await step(repo, "ba", {
      action: "add-requirement",
      id: "REQ-HOF-101",
      statement: "Context survives handoffs.",
      acceptanceCriteria: ["Context is carried."],
    });
    await step(repo, "architect", {
      action: "record-decision",
      id: "DEC-HOF-101",
      statement: "Carry forward",
      confirmed: true,
      rationale: "history",
    });
    const common = { requirementIds: ["REQ-HOF-101"], readiness: "ready" };
    await step(repo, "ba", {
      action: "handoff",
      sourceRole: "ba",
      targetRole: "architect",
      ...common,
      risks: ["RISK-A"],
      openQuestions: ["Q-A"],
      blockers: ["B-A"],
      notes: "N-A",
    });
    await step(repo, "architect", { action: "handoff", sourceRole: "architect", targetRole: "developer", ...common });
    await step(repo, "developer", { action: "handoff", sourceRole: "developer", targetRole: "quality", ...common });

    const { handoffs } = persisted(repo);
    expect(handoffs.map((h) => `${h.sourceRole}>${h.targetRole}`)).toEqual([
      "ba>architect",
      "architect>developer",
      "developer>quality",
    ]);
    for (const hop of handoffs) {
      // Original defect: the installed runtime wrote risks: [] and later hops lost everything.
      expect(hop.risks, hop.handoffId).toEqual(["RISK-A"]);
      expect(hop.openQuestions, hop.handoffId).toEqual(["Q-A"]);
      expect(hop.blockers, hop.handoffId).toEqual(["B-A"]);
      expect(hop.notes, hop.handoffId).toBe("N-A");
    }
    // Decision snapshots exist for hops created after the decision (all three here).
    for (const hop of handoffs) expect(hop.decisionRecords[0]).toMatchObject({ id: "DEC-HOF-101", rationale: "history" });
    expect(handoffs.map((h) => h.revision)).toEqual([1, 2, 3]);
  });

  it("an explicitly resolved item is dropped from later hops and recorded", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-hof-"));
    await step(repo, "ba", { action: "open", projectId: "hof", title: "Handoff", request: "Carry context" });
    await step(repo, "ba", {
      action: "add-requirement",
      id: "REQ-HOF-101",
      statement: "Context survives handoffs.",
      acceptanceCriteria: ["Context is carried."],
    });
    const common = { requirementIds: ["REQ-HOF-101"], readiness: "ready" };
    await step(repo, "ba", {
      action: "handoff",
      sourceRole: "ba",
      targetRole: "architect",
      ...common,
      blockers: ["B-A"],
      risks: ["RISK-A"],
    });
    await step(repo, "architect", {
      action: "handoff",
      sourceRole: "architect",
      targetRole: "developer",
      ...common,
      resolved: ["B-A"],
    });
    const { handoffs } = persisted(repo);
    expect(handoffs[1]).toMatchObject({ blockers: [], risks: ["RISK-A"], resolved: ["B-A"] });
    expect(handoffs[0]?.blockers).toEqual(["B-A"]);
  });
});
