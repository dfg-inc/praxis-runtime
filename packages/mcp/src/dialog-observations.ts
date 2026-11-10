import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Clients seen answering the approval dialog by themselves: declared elicitation, then `decline` a few milliseconds after
 * being asked, with nothing on screen (the Claude Desktop Code tab, anthropics/claude-code#89858). Once seen, that client
 * version is not asked through its dialog again: approvals go to the approval page directly, instead of an attempt that is
 * known to fail. A new client version is tried once more, so a fixed client gets its dialog back.
 *
 * Stored in the user's Praxis home (never the repository). Editing it can only make Praxis use the approval page instead of
 * the client's dialog (a weaker channel when an agent controls the browser, see docs/approval-threat-model.md T15), or ask
 * the dialog again; it never approves anything.
 */

export type DialogObservation = { client: string; automatic: string; latencyMs: number; at: string; count: number };

const path = (): string => join(process.env.PRAXIS_STATE_HOME?.trim() || join(homedir(), ".praxis"), "clients", "approval-dialogs.json");

let cache: Record<string, DialogObservation> | undefined;

function load(): Record<string, DialogObservation> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as { observations?: Record<string, DialogObservation> };
    cache = parsed.observations && typeof parsed.observations === "object" ? parsed.observations : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** One key per client build and host: the same Claude Code version answers differently in a terminal and in Desktop. */
export function clientKey(client: { name?: string; version?: string } | undefined): string | undefined {
  if (!client?.name) return undefined;
  const host = process.env.CLAUDE_CODE_ENTRYPOINT?.trim();
  return `${client.name}@${client.version ?? "?"}${host ? ` (${host})` : ""}`;
}

/** Seen at least twice, each time far faster than a person: one fast answer never changes how a client is asked. */
export function knownAutoAnswer(key: string | undefined): DialogObservation | undefined {
  const seen = key ? load()[key] : undefined;
  return seen && seen.count >= 2 ? seen : undefined;
}

export function noteAutoAnswer(key: string | undefined, automatic: string, latencyMs: number): void {
  if (!key) return;
  const all = load();
  const previous = all[key];
  all[key] = { client: key, automatic, latencyMs, at: new Date().toISOString(), count: (previous?.count ?? 0) + 1 };
  try {
    const file = path();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ about: "Clients seen answering Praxis's approval dialog without showing it; Praxis uses its approval page for them instead.", observations: all }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {
    // the in-memory note still keeps this process from retrying
  }
}

/** Tests only: forget what was seen, so each test starts from a client nobody has observed. */
export function resetDialogObservations(): void {
  cache = undefined;
}
