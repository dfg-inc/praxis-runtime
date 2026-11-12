import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactCredentials } from "@praxis/contracts";

/**
 * A small local event log for the MCP server, so "the call hung" can be answered from evidence: did the tool handler run,
 * what did the client declare, how did the approval end, how long did it take.
 *
 * Events carry names, ids, durations, codes and the client's declared capability keys. They never carry tool arguments,
 * plan text, tokens or file contents, and each line passes credential redaction before it is written (secret-redaction.ts).
 * Location: ~/.praxis/diagnostics/mcp.jsonl, rotated at 1 MB. PRAXIS_STATE_HOME moves it in any build: it is a debugging log,
 * not security state. Nothing reads it as approval evidence; the journal audit only uses it to take a claimed decision of the
 * user back (approval-journal.ts), never to add one, so moving or editing it cannot approve anything.
 */
const MAX_BYTES = 1_000_000;

export const diagnosticsPath = (): string => join(process.env.PRAXIS_STATE_HOME?.trim() || join(homedir(), ".praxis"), "diagnostics", "mcp.jsonl");

export type DiagnosticEvent = { event: string } & Record<string, string | number | boolean | null | string[] | undefined>;

export function recordDiagnostic(entry: DiagnosticEvent): void {
  try {
    const file = diagnosticsPath();
    mkdirSync(join(file, ".."), { recursive: true });
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(file, `${redactCredentials(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }))}\n`);
  } catch {
    // diagnostics must never break a tool call
  }
}
