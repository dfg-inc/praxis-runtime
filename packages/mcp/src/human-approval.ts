import {
  HUMAN_ACT_KIND,
  humanActApprovalRequest,
  humanActRequest,
  obtainUserApproval,
  subjectDigest,
  type UserApproval,
  type WorkflowCommand,
  type WorkflowState,
} from "@praxis/contracts";

/**
 * How a human act gets asked for. The Runtime never approves anything. For a confirmation or an approval it builds
 * the exact request from its own state and asks the user: in the MCP client's own dialog when the client supports
 * it (the answer cannot be written by the agent), otherwise from the agent's confirmation=YES, recorded as
 * unverified. The contract then verifies the approval against the act's content again before it changes anything.
 *
 * Agent-authored workflow records (requirements, handoffs, verdicts, implementation records) are the agent's own
 * work product and are written without an approval.
 */

/** What preview shows for a human act: no writes. */
export function humanApprovalView(state: WorkflowState | null, command: WorkflowCommand) {
  if (!state) return null;
  const request = humanActRequest(state, command);
  if (!request) return null;
  return {
    required: true,
    kind: HUMAN_ACT_KIND[request.action],
    action: request.action,
    summary: request.summary,
    description: request.description,
    risks: request.risks,
    contentDigest: subjectDigest(request.content),
    explanation:
      "Applying this asks the user to approve or reject exactly this, in the client's own dialog. A client without a dialog cannot ask: show the user this text, and apply with confirmation=YES only after they said yes (recorded as unverified). Reject or dismiss stops it; nothing is recorded.",
  };
}

/**
 * The user's approval for this human act, or undefined when the command is not one. Throws APPROVAL_REJECTED,
 * APPROVAL_REQUIRED or APPROVAL_CLIENT_UI_REQUIRED before anything is written.
 */
export async function requireUserApproval(
  repo: string,
  state: WorkflowState,
  command: WorkflowCommand,
  confirmation: string | undefined,
): Promise<UserApproval | undefined> {
  const request = humanActRequest(state, command);
  if (!request) return undefined;
  return obtainUserApproval(humanActApprovalRequest(request), { confirmation, repo });
}
