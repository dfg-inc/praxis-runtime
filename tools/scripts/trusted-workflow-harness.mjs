/**
 * Local test harness for acceptance scripts that drive praxis_workflow_* through the MCP tools.
 *
 * What it is: the user's answer is played by a scripted client dialog (the same UserApprovalChannel the MCP server
 * builds from a client's elicitation) that approves every request it is shown, in a throwaway repository. It keeps a
 * list of what it was shown, so a script can check that the user would have seen the right thing.
 *
 * What it proves: the approval flow is enforced (a confirmation or an approval needs the dialog's answer, and the
 * contract verifies it against the exact content) and the workflow behaves correctly behind it.
 *
 * What it does NOT prove: that a person approved anything, or Claude Desktop's behaviour. Scripts must say so in
 * their report (see HARNESS_NOTICE).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const HARNESS_NOTICE = {
  approvals: "a scripted client dialog approves every request it is shown (test harness; no person is involved)",
  proves: "workflow behaviour through MCP tools with the user-approval flow enforced",
  doesNotProve: "that a person approved anything, or Claude Desktop behaviour",
};

export function createWorkflowHarness({ callTool, repo, version, role = "runtime" }) {
  /** What the scripted dialog was shown, in order. */
  const shown = [];
  const approvalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      shown.push(request);
      return { answer: "approve" };
    },
  };
  const context = { role, version, approvalChannel };

  /** Kept for scripts written against the old fixture approvals: the dialog answers at apply time, nothing to install. */
  function approve() {}
  function approveServiceFix() {}

  async function preview(command, extra = {}) {
    const result = await callTool("praxis_workflow_preview", { repo, command: JSON.stringify(command), ...extra }, context);
    if (!result.ok) throw new Error(`preview ${command.action} ${JSON.stringify(result)}`);
    if (!result.data?.fingerprint) throw new Error(`preview ${command.action} missing fingerprint`);
    return result.data.fingerprint;
  }

  function applyWith(command, fingerprint, extra = {}) {
    return callTool(
      "praxis_workflow_apply",
      { repo, command: JSON.stringify(command), previewFingerprint: fingerprint, confirmation: "YES", ...extra },
      context,
    );
  }

  async function apply(command, extra = {}) {
    const fingerprint = await preview(command, extra);
    const applied = await applyWith(command, fingerprint, extra);
    if (!applied.ok) throw new Error(`apply ${command.action} ${JSON.stringify(applied)}`);
    return applied.data;
  }

  /**
   * Persisted state of a work item (default: current), read from disk, not through the store.
   * services[].localPath is persisted relative to the workflow repository (so committed state carries no
   * machine path); it is resolved here exactly as the store resolves it on load.
   */
  function state(workItemId) {
    const dir = join(repo, ".praxis", "workflow");
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    const persisted = JSON.parse(readFileSync(join(dir, "items", `${workItemId ?? index.current}.json`), "utf8"));
    return {
      ...persisted,
      services: persisted.services.map((service) =>
        service.localPath && !isAbsolute(service.localPath) ? { ...service, localPath: resolve(repo, service.localPath) } : service,
      ),
    };
  }

  /** Confirms a Story's exact revision; the dialog is shown that Story. */
  async function confirmStory(storyId) {
    const story = state().stories.find((item) => item.id === storyId && item.status !== "superseded");
    if (!story) throw new Error(`story ${storyId} not found`);
    const { storyContentFingerprint } = await import("@praxis/contracts");
    return apply({ action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) });
  }

  /** Confirms a recorded decision's exact revision. A decision cannot be recorded as confirmed. */
  async function confirmDecision(decisionId) {
    const decision = state().decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`decision ${decisionId} not found`);
    const { decisionContentFingerprint } = await import("@praxis/contracts");
    return apply({ action: "confirm-decision", id: decision.id, revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision) });
  }

  /** Marks a service approved/completed; the dialog is shown the service as recorded and its implementation. */
  async function approveService(service) {
    return apply({ action: "set-service", service });
  }

  return { approve, approveServiceFix, preview, applyWith, apply, state, confirmStory, confirmDecision, approveService, shown, approvalChannel };
}
