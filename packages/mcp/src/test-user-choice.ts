import type { UserApprovalChannel } from "@praxis/contracts";

/**
 * Test support: the user's own choice to open a work item in classic mode (an alpha.48-style item) is asked in the client's
 * dialog; tests whose subject is something else (inspection, approvals, quality evidence) play the user saying yes for that
 * one step only. Nothing else is approved by this channel.
 */
export const userChoosesClassic: UserApprovalChannel = {
  kind: "client-elicitation",
  async ask(request) {
    return request.action === "review-decisions" && /CLASSIC mode/.test(request.description) ? { answer: "approve" } : { answer: "reject" };
  },
};

export function channelForOpenClassic(tool: string, args: Record<string, unknown>): UserApprovalChannel | undefined {
  if (tool !== "praxis_workflow_apply") return undefined;
  const text = String(args.command ?? "");
  return /"action":"open"/.test(text) && /"mode":"classic"/.test(text) ? userChoosesClassic : undefined;
}
