import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyWorkflow, capabilityRoute, previewWorkflow, workflowStatus } from "./workflow-store.js";

describe("local workflow store", () => {
  it("persists a Jira-free workflow and does not duplicate a resumed handoff", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-wf-"));
    const open = {
      action: "open",
      projectId: "PRJ-LOCAL",
      title: "Bulk User Import",
      request: "Import users from CSV",
    };
    const preview = previewWorkflow(repo, open);
    expect(workflowStatus(repo).present).toBe(false);
    const applied = applyWorkflow(repo, open, preview.fingerprint);
    expect(applied.workItemId).toBe("WI-BULK-USER-IMPORT-001");
    expect(workflowStatus(repo).jiraIssueKey).toBeNull();
    const requirement = {
      action: "add-requirement",
      id: "REQ-BUI-001",
      statement: "Invalid CSV rows must not prevent valid users from being imported.",
      acceptanceCriteria: ["Valid rows still import."],
    };
    const reqPreview = previewWorkflow(repo, requirement);
    applyWorkflow(repo, requirement, reqPreview.fingerprint);
    const handoff = {
      action: "handoff",
      sourceRole: "ba",
      targetRole: "architect",
      requirementIds: ["REQ-BUI-001"],
      readiness: "ready",
    };
    const handPreview = previewWorkflow(repo, handoff);
    applyWorkflow(repo, handoff, handPreview.fingerprint);
    // The state moved on, so the same command needs its own approval and is deduplicated by the
    // handoff itself rather than by replaying the first approval.
    const againPreview = previewWorkflow(repo, handoff);
    expect(againPreview.fingerprint).not.toBe(handPreview.fingerprint);
    expect(againPreview.duplicate).toBe(true);
    const again = applyWorkflow(repo, handoff, againPreview.fingerprint);
    expect(again.duplicate).toBe(true);
    expect(workflowStatus(repo).requirementIds).toEqual(["REQ-BUI-001"]);
    expect(workflowStatus(repo).requirementIds).toEqual(["REQ-BUI-001"]);
    expect(workflowStatus(repo).nextRole).toBe("architect");
  });

  it("routes security guidance without executing a Jira mutation", () => {
    const routed = capabilityRoute({
      request: "The authentication API needs security architecture before any jira update",
      role: "developer",
    });
    expect(routed.guidance.map((cap) => cap.id)).toContain("cap.architect.security");
    expect(routed.executed).toEqual([]);
    expect(routed.suggested.map((cap) => cap.id)).toContain("cap.jira.mutate");
  });
});
