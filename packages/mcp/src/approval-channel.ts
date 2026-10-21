import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";

/**
 * The user's approval, asked through the MCP client's own elicitation dialog.
 *
 * The client shows the message (what will happen, in full) and returns Accept / Decline / Cancel plus the form. That
 * answer comes back as a protocol response to this server: it is not a tool argument, so the agent cannot write it.
 * Accept with "approve" selected is an approval; Accept with "reject", Decline and Cancel all stop the action
 * (Cancel is reported as a dismissal, not a rejection).
 */

type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type ElicitInput = (params: {
  mode: "form";
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}, options?: { timeout?: number }) => Promise<ElicitResult>;

/** A long preview (a Story, a plan) must still be readable; the dialog gets all of it, bounded. */
const MAX_MESSAGE = 12_000;

export function approvalMessage(request: ApprovalRequest): string {
  const lines = [
    "Praxis asks you to approve this action. Nothing runs until you do.",
    "",
    request.summary,
    "",
    request.description,
    ...(request.risks?.length ? ["", "Risks:", ...request.risks.map((risk) => `- ${risk}`)] : []),
    "",
    "Choose Approve to run exactly this. Choose Reject (or decline) to stop it.",
  ];
  const text = lines.join("\n");
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE)}\n… (truncated: ask the agent to show the full preview before you approve)`;
}

/** Error text that means "this connection cannot show the dialog", as opposed to a failure while showing it. */
const UNAVAILABLE = /elicit|capabilit|not supported|unsupported|era\b|input_required|method not found/i;

export function elicitationChannel(input: {
  /** Whether the client declared the elicitation (form) capability. */
  supported: boolean;
  elicitInput: ElicitInput;
  timeoutMs?: number;
}): UserApprovalChannel | undefined {
  if (!input.supported) return undefined;
  return {
    kind: "client-elicitation",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      let result: ElicitResult;
      try {
        result = await input.elicitInput(
          {
            mode: "form",
            message: approvalMessage(request),
            requestedSchema: {
              type: "object",
              properties: {
                decision: {
                  type: "string",
                  title: "Your decision",
                  description: "Approve runs exactly the action above. Reject stops it.",
                  enum: ["approve", "reject"],
                },
                reason: { type: "string", title: "Reason (optional)" },
              },
              required: ["decision"],
            },
          },
          { timeout: input.timeoutMs ?? 10 * 60_000 },
        );
      } catch (error) {
        if (error instanceof Error && UNAVAILABLE.test(error.message)) return { answer: "unavailable", reason: error.message };
        throw error;
      }
      const reason = typeof result.content?.reason === "string" && result.content.reason.trim() ? result.content.reason.trim() : undefined;
      if (result.action === "cancel") return { answer: "dismiss", ...(reason ? { reason } : {}) };
      if (result.action === "decline") return { answer: "reject", ...(reason ? { reason } : {}) };
      return { answer: result.content?.decision === "approve" ? "approve" : "reject", ...(reason ? { reason } : {}) };
    },
  };
}
