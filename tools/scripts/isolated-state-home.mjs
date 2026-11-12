/**
 * Imported first by acceptance scripts that call the Runtime's built modules in-process (not a shipped bundle): a
 * throwaway PRAXIS_STATE_HOME for their decision journal, decision ledger and diagnostics, removed when the script exits.
 * Outside a production bundle the security state home honours PRAXIS_STATE_HOME; without it these scripts would write to
 * the developer's own ~/.praxis. A home set by the caller is kept.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PRAXIS_STATE_HOME) {
  const home = mkdtempSync(join(tmpdir(), "praxis-accept-state-"));
  process.env.PRAXIS_STATE_HOME = home;
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}
