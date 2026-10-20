/**
 * Trusted local test harness for acceptance scripts that drive praxis_workflow_* through the MCP tools.
 *
 * What it is: approvals are fixtures written with installHostApproval, each bound to the exact preview
 * fingerprint of one command, in a throwaway repository. Story confirmation uses an EPHEMERAL key pair
 * generated here; it never reads or uses the owner's approval keys.
 *
 * What it proves: the real authorization gate is enforced (a write with no matching approval is refused)
 * and the workflow behaves correctly behind it.
 *
 * What it does NOT prove: a human approved anything, secure-mode broker isolation, or Claude Desktop
 * behaviour. Scripts must say so in their report (see HARNESS_NOTICE).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  encodeAuthorization,
  generateApprovalKeyPair,
  installHostApproval,
  signAuthorization,
  storyConfirmationDigest,
  storyContentFingerprint,
} from "@praxis/contracts";

export const HARNESS_NOTICE = {
  securityMode: "compatibility (trusted local test harness; approvals are fixtures bound to each preview fingerprint)",
  proves: "workflow behaviour through MCP tools with the authorization gate enforced",
  doesNotProve: "human approval, secure-mode broker isolation, or Claude Desktop behaviour",
};

export function createWorkflowHarness({ callTool, repo, version, role = "runtime" }) {
  // Explicit and visible: the fixture approval path only exists in compatibility mode.
  process.env.PRAXIS_SECURITY_MODE = "compatibility";
  let approvals = 0;
  const context = { role, version };
  const keys = generateApprovalKeyPair();
  process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
  delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;

  function approve(fingerprint) {
    approvals += 1;
    installHostApproval(repo, {
      planId: `harness-${approvals}-${fingerprint.slice(-8)}`,
      role: "developer",
      provider: "local",
      workItemIds: ["local-workflow"],
      repositories: [resolve(repo)],
      operations: ["repository_edit"],
      inScope: ["praxis_workflow_apply"],
      outOfScope: [],
      assumptions: [],
      risks: ["writes the local workflow file in a throwaway acceptance repository"],
      previewFingerprint: fingerprint,
    });
  }

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
    approve(fingerprint);
    const applied = await applyWith(command, fingerprint, extra);
    if (!applied.ok) throw new Error(`apply ${command.action} ${JSON.stringify(applied)}`);
    return applied.data;
  }

  /**
   * prepare-fix writes to a service repository, so it needs its own scoped approvals there:
   * git_commit for the patch and, when the service has a remote, git_push. Fixtures only.
   */
  function approveServiceFix(service, { push = false } = {}) {
    const root = resolve(service.localPath);
    const workItemIds = [...state().stories.map((story) => story.id), service.id];
    const grants = [["git_commit", "praxis_quality_service_fix"], ...(push ? [["git_push", "praxis_developer_git_publish"]] : [])];
    for (const [operation, action] of grants) {
      approvals += 1;
      installHostApproval(root, {
        planId: `harness-service-${approvals}`,
        role: "developer",
        provider: "local",
        workItemIds,
        repositories: [root],
        operations: [operation],
        inScope: [action],
        outOfScope: [],
        assumptions: [],
        risks: ["commits a reviewed patch to a throwaway acceptance repository"],
      });
    }
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

  /** Confirms a Story's exact revision with a token signed by the harness's ephemeral key. */
  async function confirmStory(storyId) {
    const story = state().stories.find((item) => item.id === storyId && item.status !== "superseded");
    if (!story) throw new Error(`story ${storyId} not found`);
    const contentFingerprint = storyContentFingerprint(story);
    const body = {
      contract: "praxis.approval.authorization",
      version: 1,
      planFingerprint: storyConfirmationDigest({ storyId: story.id, revision: story.revision, contentFingerprint }),
      provider: "local",
      instanceId: "local",
      operations: ["external_record_update"],
      workItemIds: [story.id],
      repositories: [],
      action: "confirm-story",
      approver: "acceptance-harness",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumptionId: `harness-confirm-${story.id}-${story.revision}-${Date.now()}`,
    };
    return apply({
      action: "confirm-story",
      id: story.id,
      revision: story.revision,
      contentFingerprint,
      authorization: encodeAuthorization(signAuthorization(body, keys.privateKeyPem)),
    });
  }

  return { approve, approveServiceFix, preview, applyWith, apply, state, confirmStory };
}
