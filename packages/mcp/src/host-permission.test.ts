import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserApprovalChannel } from "@praxis/contracts";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/**
 * praxis_approval_plan shows what the dialog will ask. The host-permission mode that took its text as an approval
 * (PRAXIS_APPROVAL_MODE=host-permission, released 0.1.0-alpha.48 to alpha.49.1) is removed: the environment is reachable
 * by a repository's Claude Code settings, so no variable makes approval weaker.
 */
const saved = process.env.PRAXIS_APPROVAL_MODE;
beforeEach(() => delete process.env.PRAXIS_APPROVAL_MODE);
afterEach(() => {
  if (saved === undefined) delete process.env.PRAXIS_APPROVAL_MODE;
  else process.env.PRAXIS_APPROVAL_MODE = saved;
});

const call = async (tool: string, repo: string, args: Record<string, unknown>, channel?: UserApprovalChannel) =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", approvalChannel: channel })) as McpEnvelope;

function project() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-hostperm-"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
  return repo;
}
const planFor = async (repo: string) => {
  const plan = await call("praxis_approval_plan", repo, { tool: "praxis_project_init_apply", toolArguments: "{}" });
  expect(plan.ok, JSON.stringify(plan.errors)).toBe(true);
  return plan.data as { required: boolean; planText: string; summary: string };
};

describe("praxis_approval_plan: what the user would be asked, running nothing", () => {
  it("returns the exact plan text, writes nothing, and works with no dialog and in any mode", async () => {
    const repo = project();
    const plan = await planFor(repo);
    expect(plan.required).toBe(true);
    expect(plan.planText).toContain(`Creates ${join(repo, ".project")} with exactly this content`);
    expect(plan.planText).toMatch(/requirementsFormat/);
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("only protected apply tools; an agent-authored record needs no approval; bad input is refused", async () => {
    const repo = project();
    expect((await call("praxis_approval_plan", repo, { tool: "praxis_doctor", toolArguments: "{}" })).ok).toBe(false);
    expect((await call("praxis_approval_plan", repo, { tool: "praxis_project_init_apply", toolArguments: "not json" })).ok).toBe(false);
    const open = await call("praxis_approval_plan", repo, { tool: "praxis_workflow_apply", toolArguments: JSON.stringify({ command: JSON.stringify({ action: "open", projectId: "p", title: "T", request: "r" }) }) });
    expect(open.ok && (open.data as { required: boolean }).required === false).toBe(true);
  });

  it("a plan is for `repo` only: another repository inside toolArguments is refused, not planned as `repo`", async () => {
    const repo = project();
    const other = project();
    const res = await call("praxis_approval_plan", repo, { tool: "praxis_project_init_apply", toolArguments: JSON.stringify({ repo: other }) });
    expect(res.ok).toBe(false);
    expect(res.errors?.join(" ")).toMatch(/toolArguments\.repo/);
    expect((await call("praxis_approval_plan", repo, { tool: "praxis_project_init_apply", toolArguments: JSON.stringify({ repo }) })).ok).toBe(true);
  });
});

describe("no dialog means nothing protected runs, whatever planText says", () => {
  it("a forged or even correct planText is ignored", async () => {
    const repo = project();
    const plan = await planFor(repo);
    for (const planText of [plan.planText, "anything", ""]) {
      const refused = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText });
      expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
      expect(existsSync(join(repo, ".project"))).toBe(false);
    }
  });
});

describe("PRAXIS_APPROVAL_MODE=host-permission is retired: whoever sets it, nothing protected runs without the dialog", () => {
  beforeEach(() => {
    process.env.PRAXIS_APPROVAL_MODE = "host-permission";
  });

  it("the exact plan text is not an approval, and nothing is written", async () => {
    const repo = project();
    const { planText } = await planFor(repo);
    for (const text of [planText, undefined]) {
      const refused = await call("praxis_project_init_apply", repo, { confirmation: "YES", ...(text === undefined ? {} : { planText: text }) });
      expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
      expect(JSON.stringify(refused)).not.toMatch(/host-prompt|"channel":"host-permission"/);
    }
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("confirmation=NO still stops it (as the agent's withdrawal), and the dialog decides", async () => {
    const repo = project();
    const { planText } = await planFor(repo);
    expect((await call("praxis_project_init_apply", repo, { confirmation: "NO", planText })).code).toBe("APPROVAL_WITHDRAWN");
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const rejecting: UserApprovalChannel = { kind: "client-elicitation", ask: async () => ({ answer: "reject" }) };
    expect((await call("praxis_project_init_apply", repo, { confirmation: "YES", planText }, rejecting)).code).toBe("APPROVAL_REJECTED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const approving: UserApprovalChannel = { kind: "client-elicitation", ask: async () => ({ answer: "approve" }) };
    const applied = await call("praxis_project_init_apply", repo, { confirmation: "YES" }, approving);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(applied.data.approval).toEqual([expect.objectContaining({ channel: "client-elicitation", assurance: "client-ui" })]);
  });

  it("the doctor reports no dialog", async () => {
    const repo = project();
    const doctor = await call("praxis_doctor", repo, {});
    expect(doctor.data.approval).toMatchObject({ mode: "no-dialog" }); // direct callTool has no client report; the MCP server adds it
  });
});
