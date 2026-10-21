import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserApprovalChannel } from "@praxis/contracts";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/**
 * The OPT-IN mode for a client with no approval dialog (PRAXIS_APPROVAL_MODE=host-permission): the host's own
 * tool-permission prompt shows the exact plan in the apply tool's arguments. Off by default; labelled host-prompt.
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
});

describe("default: no dialog means nothing protected runs, whatever planText says", () => {
  it("a forged or even correct planText is ignored unless the mode is switched on", async () => {
    const repo = project();
    const plan = await planFor(repo);
    for (const planText of [plan.planText, "anything", ""]) {
      const refused = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText });
      expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
      expect(existsSync(join(repo, ".project"))).toBe(false);
    }
  });
});

describe("PRAXIS_APPROVAL_MODE=host-permission (opt-in)", () => {
  beforeEach(() => {
    process.env.PRAXIS_APPROVAL_MODE = "host-permission";
  });

  it("the exact plan runs, and the result is labelled host-prompt, never client-ui", async () => {
    const repo = project();
    const { planText } = await planFor(repo);
    const applied = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText });
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(existsSync(join(repo, ".project"))).toBe(true);
    expect(applied.data.approval).toEqual([expect.objectContaining({ channel: "host-permission", assurance: "host-prompt" })]);
    expect(readFileSync(join(repo, ".project"), "utf8")).toContain("requirementsFormat");
  });

  it("no planText, an edited planText and a plan that changed after it was shown are all refused with the current plan", async () => {
    const repo = project();
    const { planText } = await planFor(repo);
    const none = await call("praxis_project_init_apply", repo, { confirmation: "YES" });
    expect(none.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect((none.data as { planText: string }).planText).toBe(planText);
    const edited = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText: `${planText}\nand also something else` });
    expect(edited.code).toBe("APPROVAL_SCOPE_MISMATCH");
    expect(existsSync(join(repo, ".project"))).toBe(false);
    // the project changes after the plan was shown: the old text no longer matches
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "vitest", build: "tsc" } })}\n`);
    const stale = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText });
    expect(stale.code).toBe("APPROVAL_SCOPE_MISMATCH");
    expect((stale.data as { planText: string }).planText).not.toBe(planText);
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const fresh = (await planFor(repo)).planText;
    expect((await call("praxis_project_init_apply", repo, { confirmation: "YES", planText: fresh })).ok).toBe(true);
  });

  it("confirmation=NO still rejects, and a real dialog wins over the mode", async () => {
    const repo = project();
    const { planText } = await planFor(repo);
    expect((await call("praxis_project_init_apply", repo, { confirmation: "NO", planText })).code).toBe("APPROVAL_REJECTED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const rejecting: UserApprovalChannel = { kind: "client-elicitation", ask: async () => ({ answer: "reject" }) };
    const viaDialog = await call("praxis_project_init_apply", repo, { confirmation: "YES", planText }, rejecting);
    expect(viaDialog.code).toBe("APPROVAL_REJECTED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("the doctor says plainly what this mode is and is not", async () => {
    const repo = project();
    const doctor = await call("praxis_doctor", repo, {});
    expect(doctor.data.approval).toMatchObject({ mode: "no-dialog" }); // direct callTool has no client report; the MCP server adds it
  });
});
