import { readFileSync } from "node:fs";
import { QualityStore } from "./store.js";
import { reviewPath, type DevQualityHandoff } from "./review-engine.js";
import { groupFindingsByFingerprint } from "./fingerprint.js";

export type CliArgs = {
  command: string;
  flags: Record<string, string>;
};

export function parseArgs(argv: string[]): CliArgs {
  const [, , command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true";
      flags[key] = val;
    }
  }
  return { command, flags };
}

export function runCli(
  argv: string[],
  store: QualityStore,
): { ok: boolean; output: unknown } {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "review": {
      const mr = flags.mr;
      if (!mr) return { ok: false, output: { error: "missing --mr" } };
      const row = store.addReview({
        mrRef: mr,
        projectId: flags.project ?? "default",
        result: flags.result ?? "pass",
        notes: flags.notes ?? "",
      });
      return { ok: true, output: row };
    }
    case "review-path": {
      const path = flags.path;
      if (!path) return { ok: false, output: { error: "missing --path" } };
      let handoff: DevQualityHandoff | undefined;
      if (flags.handoff) {
        handoff = JSON.parse(
          readFileSync(flags.handoff, "utf8"),
        ) as DevQualityHandoff;
      }
      const reviewed = reviewPath({
        path,
        projectId: flags.project ?? "default",
        handoff,
        handoffPath: flags.handoff,
        rerunTests: flags["skip-tests"] === "true" ? false : true,
      });
      const groups = groupFindingsByFingerprint(reviewed.findings);
      const row = store.addReview({
        mrRef: reviewed.mrRef,
        projectId: reviewed.projectId,
        result: reviewed.verdict,
        notes: JSON.stringify({ findings: reviewed.findings, groups }),
      });
      store.addAudit({
        path,
        projectId: reviewed.projectId,
        findings: JSON.stringify(reviewed.findings),
      });
      if (reviewed.verdict === "pass" && handoff?.requirementIds?.[0]) {
        for (const req of handoff.requirementIds) {
          store.addTaskCompletion({
            projectId: reviewed.projectId,
            taskRef: req,
          });
        }
      }
      return {
        ok: reviewed.verdict === "pass",
        output: { review: row, groups, ...reviewed },
      };
    }
    case "audit": {
      const path = flags.path;
      if (!path) return { ok: false, output: { error: "missing --path" } };
      const row = store.addAudit({
        path,
        projectId: flags.project ?? "default",
        findings: flags.findings ?? "[]",
      });
      return { ok: true, output: row };
    }
    case "report": {
      const project = flags.project;
      if (!project) return { ok: false, output: { error: "missing --project" } };
      return { ok: true, output: store.report(project) };
    }
    case "metrics": {
      return { ok: true, output: store.metrics(flags.project) };
    }
    case "help":
    default:
      return {
        ok: command === "help",
        output: {
          usage: [
            "praxis-quality review --mr <ref> [--project <id>] [--result pass|fail]",
            "praxis-quality review-path --path <repo> [--handoff <json>] [--project <id>]",
            "praxis-quality audit --path <repo> [--project <id>]",
            "praxis-quality report --project <id>",
            "praxis-quality metrics [--project <id>]",
          ],
        },
      };
  }
}

export { QualityStore } from "./store.js";
export { createQualityApp, startServer } from "./server.js";
export { reviewPath } from "./review-engine.js";
export { groupFindingsByFingerprint } from "./fingerprint.js";
