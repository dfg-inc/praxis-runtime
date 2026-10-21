/**
 * Acceptance-script helper: plays the user's approval for product code that is called directly (Git delivery,
 * Quality apply, mock-Jira seeding). The library functions refuse to write outside an approved action, so a script
 * that calls them directly runs each write as if the user had approved it.
 *
 * It is a test helper and says so: it needs PRAXIS_TEST_APPROVALS=1 in the environment, set by the npm script that runs
 * the scenario (so the switch is visible in package.json), and a repository .env can never set it. It proves the
 * product code behind the approval; it is not evidence that a person approved anything.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasMutationLease, runApprovedForTest } from "@praxis/contracts";

export function installTestApprovals() {
  if (process.env.PRAXIS_TEST_APPROVALS !== "1") {
    throw new Error("test approvals: PRAXIS_TEST_APPROVALS=1 must be set by the caller (see the accept:* scripts in package.json)");
  }
  // The "workspace" for fixture writes that have no repository of their own.
  const scratch = mkdtempSync(join(tmpdir(), "praxis-test-scratch-"));
  const approvals = {
    /** Runs `write` as if the user had approved `spec.action`. */
    authorized(spec, write) {
      return runApprovedForTest(spec.action, write);
    },
    /** Seeds an in-memory mock tracker. The mock is a fixture; the write still runs inside an approved action. */
    seed(_repo, write) {
      return approvals.authorized({ action: "acceptance_fixture_seed" }, write);
    },
    /** A tracker provider whose write methods run as approved when the caller holds no lease. */
    leasedProvider(provider, scratchRepo = scratch) {
      const writes = new Set(["createIssue", "updateIssue", "addComment", "transitionIssue", "setIssueProperty", "createIssueLink", "writePraxisState", "writeArchitectureMetadata"]);
      return new Proxy(provider, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof prop !== "string" || !writes.has(prop) || typeof value !== "function") return value;
          return (...args) => (hasMutationLease() ? value.apply(target, args) : approvals.seed(scratchRepo, () => value.apply(target, args)));
        },
      });
    },
    close() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return approvals;
}
