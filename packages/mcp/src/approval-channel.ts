import { inputResponse } from "@modelcontextprotocol/server";
import { ApprovalError, ApprovalNeedsInput, subjectDigest, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";

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

/** The form shown to the user: the exact action, approve or reject. Shared by both protocol eras. */
export function elicitParams(request: ApprovalRequest) {
  return {
    mode: "form" as const,
    message: approvalMessage(request),
    requestedSchema: {
      type: "object" as const,
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
  };
}

/** Maps the client's elicitation result to the user's answer: only Accept with "approve" selected approves. */
export function answerFrom(result: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }): AskAnswer {
  const reason = typeof result.content?.reason === "string" && result.content.reason.trim() ? result.content.reason.trim() : undefined;
  if (result.action === "cancel") return { answer: "dismiss", ...(reason ? { reason } : {}) };
  if (result.action === "decline") return { answer: "reject", ...(reason ? { reason } : {}) };
  return { answer: result.content?.decision === "approve" ? "approve" : "reject", ...(reason ? { reason } : {}) };
}

/**
 * The key under which the client answers for this exact action. It is derived from the content that will run, so an
 * answer given for one plan can never satisfy a different plan: a changed plan has another key and is asked again.
 */
export const approvalKey = (request: ApprovalRequest): string => `approval-${subjectDigest(request.subject).slice(7, 23)}`;

/**
 * The 2026-07-28 protocol revision: the server cannot ask in the middle of a call. It returns input_required with the
 * dialog, the client shows it and RETRIES the same call with the answer. Nothing has been executed on the first pass
 * (asking comes before every write), so the retry simply runs the call again, now with the user's answer in hand.
 * The answer arrives in the protocol's own `inputResponses` field, which the host fills: it is not a tool argument.
 */
export function roundTripChannel(inputResponses: Record<string, unknown> | undefined): UserApprovalChannel {
  return {
    kind: "client-elicitation",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      const view = inputResponse(inputResponses, approvalKey(request));
      if (view.kind !== "elicit") throw new ApprovalNeedsInput(request);
      return answerFrom({ action: view.action, ...(view.content ? { content: view.content } : {}) });
    },
  };
}

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
        result = await input.elicitInput(elicitParams(request), { timeout: input.timeoutMs ?? 10 * 60_000 });
      } catch (error) {
        // an unanswered dialog is neither a yes nor a no: report it as its own outcome, never as a refusal or an approval
        if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) {
          throw new ApprovalError("APPROVAL_TIMED_OUT", "No answer arrived in the approval dialog in time. Nothing was executed; ask again to get a new dialog.", { executed: false });
        }
        if (error instanceof Error && UNAVAILABLE.test(error.message)) return { answer: "unavailable", reason: error.message };
        throw error;
      }
      return answerFrom(result);
    },
  };
}

// --- OPT-IN: no client dialog, the host's own tool-permission prompt --------------------------------------------------------

/**
 * PRAXIS_APPROVAL_MODE=host-permission (an extension setting, never the default, never settable from a repository).
 * For a host with no elicitation dialog, the only built-in confirmation is the host's prompt before an MCP tool runs. It
 * shows the tool's arguments, so the apply tool must carry the EXACT plan text (`planText`, from praxis_approval_plan);
 * Praxis recomputes the plan itself and refuses unless the text matches, so the prompt shows what will really run, and a
 * changed plan needs a new planText and a new prompt.
 *
 * What this cannot do: Praxis cannot see whether the prompt was shown. An "always allow" setting for the tool removes it,
 * and then the agent has approved itself. The result is labelled `host-prompt`, never `client-ui`.
 */
export const hostPermissionMode = (): boolean => process.env.PRAXIS_APPROVAL_MODE?.trim() === "host-permission";

/** The text the user must see in the host's prompt for this action: the same text the dialog would show. */
export const planTextOf = (request: ApprovalRequest): string => approvalMessage(request);

export function hostPermissionChannel(planText: string | undefined): UserApprovalChannel {
  return {
    kind: "host-permission",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      if (PERSONAL_ACTS.has(request.action)) {
        throw new ApprovalError(
          "APPROVAL_CLIENT_UI_REQUIRED",
          `${request.summary} was NOT executed. Host-permission mode does not cover acts only you can perform (confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion, recording review decisions, opening a classic work item): the host's tool-permission prompt can be switched to "always allow", and then the agent would have approved itself. Do it in a client that shows an approval dialog (for example Claude Code).`,
          { executed: false, preview: { action: request.action, summary: request.summary, description: request.description, risks: request.risks } },
        );
      }
      const expected = planTextOf(request);
      if (planText === undefined) {
        throw new ApprovalError(
          "APPROVAL_CLIENT_UI_REQUIRED",
          `${request.summary} was NOT executed. This client has no approval dialog; in host-permission mode call praxis_approval_plan for this action, show the plan to the user, then call this tool with that exact text as planText so the host's permission prompt shows what will run.`,
          { executed: false, planText: expected },
        );
      }
      if (planText !== expected) {
        throw new ApprovalError(
          "APPROVAL_SCOPE_MISMATCH",
          `${request.summary} was NOT executed: planText is not the plan this call would run (the plan changed, or the text was edited). Show the user the current plan below and apply again with it.`,
          { executed: false, planText: expected },
        );
      }
      return { answer: "approve", reason: "the host's tool-permission prompt showed this exact plan (not verifiable by Praxis)" };
    },
  };
}

/**
 * PRAXIS_APPROVAL_MODE=trusted-client (an extension setting; never the default, never settable from a repository).
 * The owner's explicit decision to trust this client with protected actions without a separate confirmation of each one.
 * It is a standing permission, not an approval of the specific action, and is labelled "trusted-client" in results and
 * the journal. Unchanged: the agent's confirmation=YES, the preview and its fingerprint, argument checks, the journal.
 */
export const trustedClientMode = (): boolean => process.env.PRAXIS_APPROVAL_MODE?.trim() === "trusted-client";

/**
 * Acts only a person may perform. A standing "always allow", whether Trusted Client mode or the host's own tool-permission
 * prompt, is not the person doing them: only the client's own dialog (the answer an agent cannot write) can stand for them.
 */
export const PERSONAL_ACTS: ReadonlySet<string> = new Set(["confirm-story", "confirm-decision", "approve-service", "review-decisions", "revise-acceptance", "open-classic-work-item"]);

export const trustedClientChannel: UserApprovalChannel = {
  kind: "trusted-client",
  async ask(request: ApprovalRequest): Promise<AskAnswer> {
    if (PERSONAL_ACTS.has(request.action)) {
      throw new ApprovalError(
        "APPROVAL_CLIENT_UI_REQUIRED",
        `${request.summary} was NOT executed. Trusted Client mode does not cover acts only you can perform (confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion): a standing permission is not you doing it. Do it in a client that shows an approval dialog (for example Claude Code).`,
        { executed: false, preview: { action: request.action, summary: request.summary, description: request.description, risks: request.risks } },
      );
    }
    return { answer: "approve", reason: "Trusted Client mode, enabled by the user: no separate confirmation of this action" };
  },
};

/** A channel that never answers: used to compute what the user would be asked, without running anything. */
export const planOnlyChannel: UserApprovalChannel = {
  kind: "client-elicitation",
  async ask(request: ApprovalRequest): Promise<AskAnswer> {
    throw new ApprovalNeedsInput(request);
  },
};
