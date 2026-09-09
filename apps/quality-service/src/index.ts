import { readFileSync } from "node:fs";
import { QualityStore } from "./store.js";
import { type DevQualityHandoff } from "./review-engine.js";
import { performPathReview } from "./review-orchestrator.js";
import {
  analyzeRepeatedFindings,
  createQualityReturn,
  GovernanceError,
  performCodebaseAudit,
  performMrReview,
  recordHotfixEvent,
  recordRollbackEvent,
  resolveQualityReturn,
} from "./quality-governance.js";

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

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(err: unknown): { ok: false; output: { error: string } } {
  return {
    ok: false,
    output: { error: err instanceof Error ? err.message : String(err) },
  };
}

export function runCli(
  argv: string[],
  store: QualityStore,
): { ok: boolean; output: unknown } {
  const { command, flags } = parseArgs(argv);
  try {
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
          handoff = loadJson(flags.handoff) as DevQualityHandoff;
        }
        const result = performPathReview(store, {
          path,
          projectId: flags.project ?? "default",
          handoff,
          requireValidHandoff: false,
          rerunTests: flags["skip-tests"] === "true" ? false : true,
        });
        return {
          ok: result.verdict === "pass",
          output: {
            reviewId: result.reviewId,
            projectId: result.projectId,
            workPackageId: result.workPackageId,
            verdict: result.verdict,
            findings: result.findings,
            groups: result.groups,
            testExecution: result.testExecution,
            review: result.review,
            mrRef: result.mrRef,
          },
        };
      }
      case "review-mr": {
        if (!flags.context) return { ok: false, output: { error: "missing --context" } };
        const context = loadJson(flags.context);
        const handoff = flags.handoff
          ? (loadJson(flags.handoff) as DevQualityHandoff)
          : undefined;
        const result = performMrReview(store, {
          context,
          handoff,
          rerunTests: flags["skip-tests"] === "true" ? false : true,
        });
        return {
          ok: result.verdict === "pass",
          output: {
            reviewId: result.reviewId,
            projectId: result.projectId,
            workPackageId: result.workPackageId,
            verdict: result.verdict,
            findings: result.findings,
            mrRef: result.mrRef,
            testExecution: result.testExecution,
          },
        };
      }
      case "audit": {
        const path = flags.path;
        if (!path) return { ok: false, output: { error: "missing --path" } };
        if (flags.findings) {
          const row = store.addAudit({
            path,
            projectId: flags.project ?? "default",
            findings: flags.findings,
          });
          return { ok: true, output: row };
        }
        const result = performCodebaseAudit(store, {
          path,
          projectId: flags.project ?? "default",
          outDir: flags["out-dir"],
          rerunTests: flags["skip-tests"] === "true" ? false : flags.tests === "true",
        });
        return { ok: result.report.verdict === "pass", output: result };
      }
      case "audit-report": {
        const id = Number(flags.id);
        if (!id) return { ok: false, output: { error: "missing --id" } };
        const row = store.getAudit(id);
        if (!row) return { ok: false, output: { error: `audit ${id} not found` } };
        return {
          ok: true,
          output: {
            audit: row,
            report: row.report_json ? JSON.parse(row.report_json) : null,
            reportMd: row.report_md,
          },
        };
      }
      case "report": {
        const project = flags.project;
        if (!project) return { ok: false, output: { error: "missing --project" } };
        return { ok: true, output: store.report(project) };
      }
      case "metrics": {
        return { ok: true, output: store.metrics(flags.project) };
      }
      case "record-rollback": {
        if (!flags.in) return { ok: false, output: { error: "missing --in" } };
        const row = recordRollbackEvent(store, loadJson(flags.in), {
          repo: flags.repo,
        });
        return { ok: true, output: row };
      }
      case "record-hotfix": {
        if (!flags.in) return { ok: false, output: { error: "missing --in" } };
        if (!flags.repo) return { ok: false, output: { error: "missing --repo" } };
        const row = recordHotfixEvent(store, loadJson(flags.in), { repo: flags.repo });
        return { ok: true, output: row };
      }
      case "list-rollbacks": {
        if (!flags.project) return { ok: false, output: { error: "missing --project" } };
        return {
          ok: true,
          output: {
            rollbacks: store.listRollbacks(flags.project),
            hotfixes: store.listHotfixes(flags.project),
          },
        };
      }
      case "create-return": {
        const reviewId = Number(flags.review);
        const source = flags.source as "qa" | "code-review";
        if (!reviewId) return { ok: false, output: { error: "missing --review" } };
        if (source !== "qa" && source !== "code-review") {
          return { ok: false, output: { error: "--source must be qa|code-review" } };
        }
        const ids = (flags.findings ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const row = createQualityReturn(store, {
          reviewId,
          source,
          blockingFindingIds: ids,
          reason: flags.reason ?? "blocking findings",
        });
        return { ok: true, output: row };
      }
      case "resolve-return": {
        const id = Number(flags.id);
        const follow = Number(flags["follow-up"]);
        if (!id || !follow) {
          return { ok: false, output: { error: "missing --id or --follow-up" } };
        }
        return { ok: true, output: resolveQualityReturn(store, {
          returnId: id,
          followUpReviewId: follow,
        }) };
      }
      case "list-returns": {
        if (!flags.project) return { ok: false, output: { error: "missing --project" } };
        return { ok: true, output: store.listReturns(flags.project) };
      }
      case "propose-norms": {
        if (!flags.project) return { ok: false, output: { error: "missing --project" } };
        if (!flags["knowledge-store"]) {
          return { ok: false, output: { error: "missing --knowledge-store" } };
        }
        return {
          ok: true,
          output: analyzeRepeatedFindings(store, {
            projectId: flags.project,
            knowledgeStorePath: flags["knowledge-store"],
            threshold: flags.threshold ? Number(flags.threshold) : undefined,
          }),
        };
      }
      case "help":
      default:
        return {
          ok: command === "help",
          output: {
            usage: [
              "praxis-quality review --mr <ref> [--project <id>] [--result pass|fail]",
              "praxis-quality review-path --path <repo> [--handoff <json>] [--project <id>]",
              "praxis-quality review-mr --context <json> [--handoff <json>]",
              "praxis-quality audit --path <repo> [--project <id>] [--out-dir <dir>]",
              "praxis-quality audit-report --id <n>",
              "praxis-quality report --project <id>",
              "praxis-quality metrics [--project <id>]",
              "praxis-quality record-rollback --in <json> [--repo <git>]",
              "praxis-quality record-hotfix --in <json> --repo <git>",
              "praxis-quality list-rollbacks --project <id>",
              "praxis-quality create-return --review <id> --source qa|code-review --findings <ids> [--reason t]",
              "praxis-quality resolve-return --id <n> --follow-up <reviewId>",
              "praxis-quality list-returns --project <id>",
              "praxis-quality propose-norms --project <id> --knowledge-store <json>",
            ],
          },
        };
    }
  } catch (err) {
    if (err instanceof GovernanceError) return fail(err);
    return fail(err);
  }
}

export { QualityStore } from "./store.js";
export { createQualityApp, startServer } from "./server.js";
export { reviewPath, discoverTestFiles, parseNodeTestCounts } from "./review-engine.js";
export { groupFindingsByFingerprint } from "./fingerprint.js";
export { performPathReview, reviewResponseFromRow } from "./review-orchestrator.js";
export { validateDeveloperQualityHandoff } from "./handoff-validate.js";
export { resolveAllowedPath } from "./path-security.js";
export {
  REPEATED_FINDING_THRESHOLD,
  analyzeRepeatedFindings,
  createQualityReturn,
  performCodebaseAudit,
  performMrReview,
  recordHotfixEvent,
  recordRollbackEvent,
  resolveQualityReturn,
  snapshotTree,
} from "./quality-governance.js";
