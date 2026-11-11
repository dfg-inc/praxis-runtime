import { inputResponse } from "@modelcontextprotocol/server";
import { ApprovalError, ApprovalNeedsInput, logDecision, subjectDigest, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";
import { knownAutoAnswer, noteAutoAnswer } from "./dialog-observations.js";
import { approvalSettings } from "./approval-settings.js";
import { dialogAutomation, type AutomationFinding } from "./dialog-automation.js";

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
 * never as the user's rejection or approval, and nothing runs.
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
 * The fastest answer taken as coming from the user's channel: below it the client answered by itself. It can be raised from
 * anywhere and lowered only by the test source, never in a shipped Runtime (approval-settings.ts). A slower answer is not
 * proof of a person either: it only rules out the client's own immediate answer.
 */
export const minAnswerMs = (): number => approvalSettings().minAnswerMs;

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
export const approvalKey = (request: ApprovalRequest): string => `approval-${subjectDigest(`${request.action}\n${request.subject}\n${approvalMessage(request)}`).slice(7, 39)}`;

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
 * The client's dialog, taken only while nothing is configured to answer it (dialog-automation.ts). Checked before the
 * dialog is asked for and again when its answer arrives: a hook added in between makes the answer the configuration's,
 * whatever it says. Any answer then counts for nothing: the action does not run and no decision is attributed to anyone.
 */
export function automationGuarded(dialog: UserApprovalChannel, repo?: string): UserApprovalChannel {
  const refused = (findings: AutomationFinding[]): AskAnswer => ({
    answer: "unavailable",
    channel: "client-elicitation",
    reason: `the client's approval dialog is configured to be answered automatically (${findings.map((f) => f.file).slice(0, 5).join("; ")}); a configured answer is not the user's. Remove that hook to approve here`,
  });
  return {
    get kind() {
      return dialog.kind;
    },
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      const before = dialogAutomation(repo ? { repo } : {});
      if (before.length) return refused(before);
      const answer = await dialog.ask(request);
      const after = dialogAutomation(repo ? { repo } : {});
      return after.length ? refused(after) : answer;
    },
  };
}

/**
 * A client dialog, with the approval page behind it in the test source only. A client already seen answering by itself is not
 * asked through its dialog again: without a page (a shipped Runtime) the action is refused at once, nothing runs and nobody
 * decided; with the test page, the page is used directly. One that answers by itself now is noted and its automatic answer
 * stands (nothing runs), or, with the test page, is journaled as the client's and the same request goes to the page.
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
      const known = page ? undefined : knownAutoAnswer(input.clientKey);
      if (known) {
        return { answer: "unavailable", channel: "client-elicitation", reason: `this client (${known.client}) was seen answering Praxis's approval dialog by itself (${known.automatic}, ${known.latencyMs} ms), without showing it, so it is not asked again` };
      }
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
        reason: `the client answered "${answer.automatic}" faster than a person could read the dialog; asking in the approval page instead`,
      });
      used = page;
      return page.ask(request);
    },
  };
}

// --- removed: standing permissions ------------------------------------------------------------------------------

/**
 * The opt-in host-permission and Trusted Client modes of 0.1.0-alpha.48 to alpha.49.1 are removed. Both let a protected
 * action run on the agent's own confirmation=YES (host-permission: with a planText the agent obtained from
 * praxis_approval_plan; Trusted Client: with nothing more), and both were switched on by configuration that a repository's
 * Claude Code settings, or an agent with a shell on the account, can write. No setting brings them back.
 */

/** The text a client's approval dialog shows for this action (praxis_approval_plan returns it, for the person to read). */
export const planTextOf = (request: ApprovalRequest): string => approvalMessage(request);

/**
 * Acts only a person may perform. They need the user's own channel like every protected action; listed so results and
 * plans can say which acts record a decision of the person.
 */
export const PERSONAL_ACTS: ReadonlySet<string> = new Set(["confirm-story", "confirm-decision", "approve-service", "review-decisions", "revise-acceptance", "open-classic-work-item", "amend-decision-journal"]);

/** A channel that never answers: used to compute what the user would be asked, without running anything. */
export const planOnlyChannel: UserApprovalChannel = {
  kind: "client-elicitation",
  async ask(request: ApprovalRequest): Promise<AskAnswer> {
    throw new ApprovalNeedsInput(request);
  },
};
