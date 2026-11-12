import { existsSync, readFileSync } from "node:fs";
import {
  appendDecisionAmendments,
  approvalLabels,
  auditDecisionJournal,
  canonicalText,
  decisionLogPath,
  effectiveDecisions,
  obtainUserApproval,
  readDecisionJournal,
  type JournalFinding,
  type ObservedRoundTrip,
} from "@praxis/contracts";
import { minAnswerMs } from "./approval-channel.js";
import { diagnosticsPath } from "./diagnostics-log.js";

/**
 * The decision journal, audited against what the Runtime observed. Entries written before journal v2 could say "rejected"
 * for two things that were not the user's decision: the agent's confirmation=NO, and a client that answered its dialog by
 * itself. The audit finds them; amending appends a correction per entry (after the client's dialog approves exactly those
 * corrections) and never changes a line that is there.
 *
 * What amend can influence: only the journal's own display of past entries, and only downward. The two rules in
 * contracts decision-journal.ts turn a claimed rejection into "withdrawn" or "auto-answered"; no rule produces or upgrades
 * an "approved" outcome, and a hand-written amendment line that claims one is ignored by every reader. Nothing downstream
 * trusts the journal: approvals are the in-memory objects obtainUserApproval issues for the call being served, and no gate,
 * acceptance or protected action reads a journal line. Reads and writes are refused when the journal would be inside the
 * repository (DECISION_LEDGER_UNAVAILABLE).
 */

type Diag = { at: string; pid?: number; event: string; callId?: string; tool?: string; client?: string | null };

function readDiagnostics(): Diag[] {
  const rows: Diag[] = [];
  for (const file of [`${diagnosticsPath()}.1`, diagnosticsPath()]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Diag);
      } catch {
        // a torn line is skipped; the rest of the log is still evidence
      }
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Each dialog round trip in the diagnostics log: the call that returned input_required (asked), and the retry of the same tool
 * by the same server process that carried the client's answer (answered).
 */
export function observedRoundTrips(rows: Diag[] = readDiagnostics()): ObservedRoundTrip[] {
  const trips: ObservedRoundTrip[] = [];
  const enters = rows.filter((r) => r.event === "tool_enter");
  for (const asked of rows.filter((r) => r.event === "input_required")) {
    const first = enters.find((r) => r.callId === asked.callId);
    const retry = enters.find((r) => r.pid === asked.pid && r.tool === asked.tool && r.callId !== asked.callId && Date.parse(r.at) >= Date.parse(asked.at) && Date.parse(r.at) - Date.parse(asked.at) <= 15 * 60_000);
    if (!retry) continue;
    trips.push({ askedAt: asked.at, answeredAt: retry.at, tool: asked.tool ?? "", ...(first?.client ? { client: first.client } : {}) });
  }
  return trips;
}

export function journalAudit(repo: string) {
  const lines = readDecisionJournal(repo);
  const findings = auditDecisionJournal(lines, { roundTrips: observedRoundTrips(), minAnswerMs: minAnswerMs() });
  const effective = effectiveDecisions(lines);
  return {
    path: decisionLogPath(repo),
    entries: effective.length,
    amendments: lines.filter((l) => l.amendment).length,
    unreadable: lines.filter((l) => l.unreadable).length,
    toAmend: findings.filter((f) => f.kind === "amend"),
    unverified: findings.filter((f) => f.kind === "unverified"),
    byDecision: effective.reduce<Record<string, number>>((acc, e) => ((acc[`${e.decision}/${e.decidedBy}`] = (acc[`${e.decision}/${e.decidedBy}`] ?? 0) + 1), acc), {}),
  };
}

const describeFinding = (f: JournalFinding): string =>
  `- line ${f.line} (${f.at}, ${f.action}): recorded "${f.claimed.decision}" via ${f.claimed.channel}; corrected to "${f.corrected?.decision}" by ${f.corrected?.decidedBy} (${f.rule}: ${f.note})`;

/** Appends the amendments the audit found, after the client's approval dialog approves exactly that list. */
export async function amendJournal(repo: string, confirmation: string | undefined, version: string) {
  const audit = journalAudit(repo);
  if (audit.toAmend.length === 0) return { ...audit, appended: 0, note: "Nothing to amend: no entry claims a decision of the user that the evidence contradicts." };
  const approval = await obtainUserApproval(
    {
      action: "amend-decision-journal",
      kind: "development_action",
      summary: `Append ${audit.toAmend.length} correction(s) to the Praxis decision journal`,
      description: [
        `Journal: ${audit.path}`,
        "Each correction is a new line naming the entry it corrects. No existing line is changed or removed.",
        "",
        ...audit.toAmend.map(describeFinding),
      ].join("\n"),
      subject: canonicalText(audit.toAmend.map((f) => ({ line: f.line, sha256: f.sha256, rule: f.rule, corrected: f.corrected }))),
    },
    { confirmation, repo },
  );
  // obtainUserApproval threw unless the client's dialog approved exactly this list; the journal is outside the repository
  const result = appendDecisionAmendments(repo, audit.toAmend, `praxis-runtime ${version} (approval-journal audit)`, new Date(), approvalLabels(approval.channel, approval.decidedBy));
  return { ...journalAudit(repo), appended: result.appended, skipped: result.skipped };
}
