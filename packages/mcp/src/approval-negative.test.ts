import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { proposePlan, readApproval, saveProposal } from "@praxis/contracts";
import { createFixtureJiraProvider, createMockFetch, createMockJiraState } from "@praxis/jira";
import { callTool } from "./tools.js";

const VERSION = "test";

function repo() {
  return mkdtempSync(join(tmpdir(), "praxis-negative-"));
}

describe("direct MCP mutations fail closed", () => {
  it("does not apply a local workflow from confirmation=YES alone", async () => {
    const root = repo();
    const command = {
      action: "open",
      projectId: "PRJ-LOCAL",
      title: "Bulk User Import",
      request: "Import users from CSV",
    };
    const preview = await callTool(
      "praxis_workflow_preview",
      { repo: root, command: JSON.stringify(command) },
      { role: "ba", version: VERSION },
    );
    expect(preview.ok).toBe(true);
    const fingerprint = (preview.data as { fingerprint: string }).fingerprint;
    const applied = await callTool(
      "praxis_workflow_apply",
      { repo: root, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: fingerprint },
      { role: "ba", version: VERSION },
    );
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REQUIRED");
    expect(existsSync(join(root, ".praxis", "workflow", "state.json"))).toBe(false);
  });

  it("does not let a confirm tool or a model grant mutate Jira", async () => {
    const root = repo();
    const plan = proposePlan({
      planId: "plan-jira",
      role: "ba",
      provider: "jira",
      instanceId: "https://acme.atlassian.net",
      workItemIds: ["PRX-1"],
      repositories: [resolve(root)],
      operations: ["external_record_update"],
      inScope: ["praxis_ba_apply"],
      outOfScope: [],
      assumptions: [],
      risks: ["would create stories"],
      previewFingerprint: `sha256:${"ab".repeat(32)}`,
    });
    saveProposal(root, plan);
    const confirm = await callTool(
      "praxis_approval_confirm",
      { repo: root, planId: plan.planId, confirmation: "YES", state: "APPROVED", mac: "ab".repeat(32) },
      { role: "ba", version: VERSION },
    );
    expect(confirm.ok).toBe(true);
    expect((confirm.data as { approved: boolean }).approved).toBe(false);
    expect(readApproval(root, plan.planId).plan.state).toBe("AWAITING_APPROVAL");

    const state = createMockJiraState();
    const before = state.createIssueCount;
    const provider = createFixtureJiraProvider({
      config: {
        mode: "cloud",
        baseUrl: "https://acme.atlassian.net",
        token: "secret-jira-token-value",
        projectKey: "PRX",
        email: "dev@example.com",
        authMode: "cloud-basic",
        epicType: "Epic",
        storyType: "Story",
        taskType: "Task",
        bugType: "Bug",
        workPackageType: "",
        transitions: {},
        workPackageMaxHours: 16,
      },
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    process.env.PRAXIS_JIRA_BASE_URL = "https://acme.atlassian.net";
    const mutation = await callTool(
      "praxis_ba_apply",
      {
        repo: root,
        epic: "PRX-1",
        confirmation: "YES",
        planId: plan.planId,
        previewFingerprint: plan.previewFingerprint,
        grant: { state: "APPROVED", mac: "cd".repeat(32) },
      },
      { role: "ba", version: VERSION, extra: { provider } },
    );
    expect(mutation.ok).toBe(false);
    expect(mutation.code).toBe("APPROVAL_REQUIRED");
    expect(state.createIssueCount).toBe(before);
  });
});
