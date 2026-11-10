import { inputResponse } from "@modelcontextprotocol/server";
import { ApprovalError, ApprovalNeedsInput, logDecision, subjectDigest, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";
import { knownAutoAnswer, noteAutoAnswer } from "./dialog-observations.js";

/**
 * The user's approval, asked through the MCP client's own elicitation dialog.
 *
 * The client shows the message (what will happen, in full) and returns Accept / Decline / Cancel plus the form. That
 * answer comes back as a protocol response to this server: it is not a tool argument, so the agent cannot write it.
 * Accept with "approve" selected is an approval; Accept with "reject", Decline and Cancel all stop the action
 * (Cancel is reported as a dismissal, not a rejection).
 *
 * An answer that comes back faster than a person can read the dialog is not a person's answer. The Claude Desktop Code tab
 * declares elicitation and then answers `decline` itself within milliseconds, with nothing on screen (measured: 9 ms and
 * 34 ms; anthropics/claude-code#89858). Such an answer, `accept` included, is the client's: it is reported as "automatic",
 * never as the user's rejection or approval, and the approval page takes over when it is available.
 */

type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type ElicitInput = (params: {
  mode: "form";
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}, options?: { timeout?: number }) => Promise<ElicitResult>;

/**
 * The dialog must show the whole action: Approve binds everything in it. A message the dialog cannot carry in full is therefore
 * refused, never cut (a cut message leaves out the lines the person most needs, and the Approve button still binds them).
 */
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
  if (text.length > MAX_MESSAGE) {
    throw new ApprovalError(
      "APPROVAL_TOO_LARGE",
      `${request.summary} was NOT executed: what you would approve is ${text.length} characters, more than one approval dialog can show in full (${MAX_MESSAGE}). Approving something that is only partly shown is not allowed. Split it into smaller steps (fewer items per file or per command) and ask again.`,
      { executed: false },
    );
  }
  return text;
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

/**
 * The fastest answer accepted as a person's: below it the client answered by itself. An extension or launch setting, never
 * read from a repository; tests that script the dialog set it to 0.
 */
export const minAnswerMs = (): number => {
  const raw = Number(process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
};

/**
 * Maps the client's elicitation result to the user's answer: only Accept with "approve" selected approves. With the time the
 * answer took, one faster than minAnswerMs is the client's own ("automatic"), whatever it says.
 */
export function answerFrom(result: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }, latencyMs?: number, client?: string): AskAnswer {
  const reason = typeof result.content?.reason === "string" && result.content.reason.trim() ? result.content.reason.trim() : undefined;
  const evidence = latencyMs === undefined ? undefined : { latencyMs, via: "client-elicitation", ...(client ? { client } : {}) };
  if (latencyMs !== undefined && latencyMs < minAnswerMs()) {
    return { answer: "unavailable", channel: "client-elicitation", automatic: result.action, evidence: evidence!, reason: "no dialog reached the user" };
  }
  const tagged = { channel: "client-elicitation" as const, ...(reason ? { reason } : {}), ...(evidence ? { evidence } : {}) };
  if (result.action === "cancel") return { answer: "dismiss", ...tagged };
  if (result.action === "decline") return { answer: "reject", ...tagged };
  return { answer: result.content?.decision === "approve" ? "approve" : "reject", ...tagged };
}

/**
 * The key under which the client answers for this exact action. It is derived from the content that will run, so an
 * answer given for one plan can never satisfy a different plan: a changed plan has another key and is asked again.
 */
export const approvalKey = (request: ApprovalRequest): string => `approval-${subjectDigest(request.subject).slice(7, 23)}`;

/** Faster than any person reacts: the Desktop Code tab answers in 9-34 ms (160 ms over WSL). */
export const CLEARLY_AUTOMATIC_MS = 250;

/**
 * When each round-trip dialog was asked for (the input_required answer left this server). The retry carrying the answer is
 * timed against it; an answer for a key this process never asked for is not used, and the user is asked properly.
 */
const askedAt = new Map<string, number>();
export function noteDialogAsked(key: string, at: number = Date.now()): void {
  askedAt.set(key, at);
  for (const [k, t] of askedAt) if (at - t > 30 * 60_000) askedAt.delete(k);
}

/**
 * The 2026-07-28 protocol revision: the server cannot ask in the middle of a call. It returns input_required with the
 * dialog, the client shows it and RETRIES the same call with the answer. Nothing has been executed on the first pass
 * (asking comes before every write), so the retry simply runs the call again, now with the user's answer in hand.
 * The answer arrives in the protocol's own `inputResponses` field, which the host fills: it is not a tool argument.
 */
export function roundTripChannel(inputResponses: Record<string, unknown> | undefined, client?: string): UserApprovalChannel {
  return {
    kind: "client-elicitation",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      const key = approvalKey(request);
      const view = inputResponse(inputResponses, key);
      const asked = askedAt.get(key);
      if (view.kind !== "elicit" || asked === undefined) throw new ApprovalNeedsInput(request);
      askedAt.delete(key);
      return answerFrom({ action: view.action, ...(view.content ? { content: view.content } : {}) }, Date.now() - asked, client);
    },
  };
}

export function elicitationChannel(input: {
  /** Whether the client declared the elicitation (form) capability. */
  supported: boolean;
  elicitInput: ElicitInput;
  timeoutMs?: number;
  client?: string;
}): UserApprovalChannel | undefined {
  if (!input.supported) return undefined;
  return {
    kind: "client-elicitation",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      let result: ElicitResult;
      const started = Date.now();
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
      return answerFrom(result, Date.now() - started, input.client);
    },
  };
}

/**
 * A client dialog with the approval page behind it. A client already seen answering by itself is not asked through its
 * dialog again (the page is used directly); one that answers by itself now is noted, the automatic answer is journaled as the
 * client's, and the same request goes to the page. Without a page, the automatic answer stands: nothing runs, nobody decided.
 */
export function dialogWithPageFallback(dialog: UserApprovalChannel, page: UserApprovalChannel | undefined, input: { clientKey?: string; repo?: string }): UserApprovalChannel {
  // only a client seen answering by itself repeatedly and far faster than any person goes to the page without asking
  let used: UserApprovalChannel = page && knownAutoAnswer(input.clientKey) ? page : dialog;
  return {
    get kind() {
      return used.kind;
    },
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      if (used === page) return page.ask(request);
      const answer = await dialog.ask(request);
      if (answer.answer !== "unavailable" || !answer.automatic) return answer;
      // An answer under minAnswerMs is not taken as the person's either way; the page asks again with clear evidence, so a
      // person who really pressed Reject that fast only has to reject once more. Only a decline far faster than a person
      // (CLEARLY_AUTOMATIC_MS) counts towards sending this client version to the page from now on.
      if (answer.automatic !== "accept" && (answer.evidence?.latencyMs ?? Infinity) < CLEARLY_AUTOMATIC_MS) noteAutoAnswer(input.clientKey, answer.automatic, answer.evidence?.latencyMs ?? -1);
      if (!page) return answer;
      logDecision(input.repo, {
        at: new Date().toISOString(),
        action: request.action,
        summary: request.summary,
        subjectDigest: subjectDigest(request.subject),
        decision: "auto-answered",
        decidedBy: "client",
        channel: "client-elicitation",
        ...(answer.evidence ? { evidence: answer.evidence } : {}),
        reason: `the client answered "${answer.automatic}" without showing a dialog; asking in the approval page instead`,
      });
      used = page;
      return page.ask(request);
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

export function hostPermissionChannel(planText: string | undefined, personal?: UserApprovalChannel): UserApprovalChannel {
  return {
    kind: "host-permission",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      if (PERSONAL_ACTS.has(request.action) || request.action === "praxis_quality_service_fix") {
        // an act only the person may perform is asked in the approval page (or a dialog), and each answer is labelled with
        // the channel that gave it: a later ordinary approval in the same call stays a host-prompt approval
        if (personal) {
          const answer = await personal.ask(request);
          return { ...answer, channel: answer.channel ?? personal.kind };
        }
        throw new ApprovalError(
          "APPROVAL_CLIENT_UI_REQUIRED",
          `${request.summary} was NOT executed, and nobody rejected it. Host-permission mode does not cover acts only you can perform (confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion, recording review decisions, opening a classic work item): the host's tool-permission prompt can be switched to "always allow", and then the agent would have approved itself. Do it where Praxis can ask you itself: a client that shows an approval dialog (for example Claude Code), or the Praxis approval page (on by default when the Runtime runs on your computer).`,
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
      return { answer: "approve", channel: "host-permission", reason: "the host's tool-permission prompt showed this exact plan (not verifiable by Praxis)" };
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
export const PERSONAL_ACTS: ReadonlySet<string> = new Set(["confirm-story", "confirm-decision", "approve-service", "review-decisions", "revise-acceptance", "open-classic-work-item", "amend-decision-journal"]);

/**
 * The Trusted Client channel. Acts only a person may perform are not covered by the standing permission: when the client has
 * a real dialog, or the approval page is available, the person is asked there for those (the permission only replaces the
 * confirmation of ordinary protected actions); when there is neither they are refused.
 */
export function trustedClientChannelWith(dialog: UserApprovalChannel | undefined): UserApprovalChannel {
  return {
    kind: "trusted-client",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      if (PERSONAL_ACTS.has(request.action)) {
        // the person's own answer is recorded as the dialog's or the page's, never as the weaker standing permission
        if (dialog) {
          const answer = await dialog.ask(request);
          return { ...answer, channel: answer.channel ?? dialog.kind };
        }
        throw new ApprovalError(
          "APPROVAL_CLIENT_UI_REQUIRED",
          `${request.summary} was NOT executed, and nobody rejected it. Trusted Client mode does not cover acts only you can perform (confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion): a standing permission is not you doing it. Do it where Praxis can ask you itself: a client that shows an approval dialog (for example Claude Code), or the Praxis approval page (on by default when the Runtime runs on your computer).`,
          { executed: false, preview: { action: request.action, summary: request.summary, description: request.description, risks: request.risks } },
        );
      }
      return { answer: "approve", channel: "trusted-client", reason: "Trusted Client mode, enabled by the user: no separate confirmation of this action" };
    },
  };
}
export const trustedClientChannel: UserApprovalChannel = trustedClientChannelWith(undefined);

/** A channel that never answers: used to compute what the user would be asked, without running anything. */
export const planOnlyChannel: UserApprovalChannel = {
  kind: "client-elicitation",
  async ask(request: ApprovalRequest): Promise<AskAnswer> {
    throw new ApprovalNeedsInput(request);
  },
};
