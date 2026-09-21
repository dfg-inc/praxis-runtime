/**
 * Shared CLI + HTTP path-review orchestration (same engine, same persistence).
 */
import { QualityStore, type ReviewRow, type AuditRow } from "./store.js";
import {
  reviewPath,
  type DevQualityHandoff,
  type Finding,
  type PathReviewResult,
} from "./review-engine.js";
import { groupFindingsByFingerprint } from "./fingerprint.js";
import {
  asDevQualityHandoff,
  validateDeveloperQualityHandoff,
} from "./handoff-validate.js";
import {
  allowedRootFromEnv,
  resolveAllowedPath,
} from "./path-security.js";
import { type WorkPackageReviewResult } from "./wp-review.js";

export type PathReviewPersisted = {
  reviewId: number;
  projectId: string;
  workPackageId?: string;
  verdict: "pass" | "fail";
  findings: Finding[];
  groups: ReturnType<typeof groupFindingsByFingerprint>;
  mrRef: string;
  review: ReviewRow;
  audit: AuditRow;
  testExecution?: PathReviewResult["testExecution"];
};

export type PerformPathReviewInput = {
  path: string;
  projectId?: string;
  handoff?: unknown;
  /** When true (HTTP), require schema-valid + verification-ready handoff and ALLOWED_ROOT. */
  requireValidHandoff?: boolean;
  rerunTests?: boolean;
  /** Override env; `null` skips allowlist even if env is set. */
  allowedRoot?: string | null;
};

/**
 * Resolve path → reviewPath → persist review+audit. Used by CLI and HTTP.
 */
export function performPathReview(
  store: QualityStore,
  input: PerformPathReviewInput,
): PathReviewPersisted {
  const httpMode = input.requireValidHandoff === true;
  const root =
    input.allowedRoot === null
      ? undefined
      : (input.allowedRoot ?? allowedRootFromEnv());

  if (httpMode && !root) {
    const err = new Error(
      "PRAXIS_QUALITY_ALLOWED_ROOT is required for HTTP path reviews",
    );
    Object.assign(err, {
      statusCode: 400,
      code: "allowed_root_required",
    });
    throw err;
  }

  const resolvedPath = resolveAllowedPath(input.path, root);

  let handoff: DevQualityHandoff | undefined;
  if (input.handoff !== undefined) {
    if (httpMode) {
      handoff = asDevQualityHandoff(
        validateDeveloperQualityHandoff(input.handoff),
      );
    } else {
      handoff = input.handoff as DevQualityHandoff;
    }
  }

  const reviewed = reviewPath({
    path: resolvedPath,
    projectId: input.projectId ?? "default",
    handoff,
    rerunTests: input.rerunTests,
  });

  const groups = groupFindingsByFingerprint(reviewed.findings);
  const notes = JSON.stringify({
    findings: reviewed.findings,
    groups,
    workPackageId: reviewed.workPackageId,
    testExecution: reviewed.testExecution,
  });

  const review = store.addReview({
    mrRef: reviewed.mrRef,
    projectId: reviewed.projectId,
    result: reviewed.verdict,
    notes,
  });
  const audit = store.addAudit({
    path: resolvedPath,
    projectId: reviewed.projectId,
    findings: JSON.stringify(reviewed.findings),
  });

  if (reviewed.verdict === "pass" && handoff?.requirementIds?.length) {
    for (const req of handoff.requirementIds) {
      store.addTaskCompletion({
        projectId: reviewed.projectId,
        taskRef: req,
      });
    }
  }

  return {
    reviewId: review.id,
    projectId: reviewed.projectId,
    workPackageId: reviewed.workPackageId,
    verdict: reviewed.verdict,
    findings: reviewed.findings,
    groups,
    mrRef: reviewed.mrRef,
    review,
    audit,
    testExecution: reviewed.testExecution,
  };
}

export function persistWorkPackageReview(
  store: QualityStore,
  input: {
    projectId: string;
    path: string;
    reviewed: WorkPackageReviewResult;
    runtimeVersion?: string;
  },
): Record<string, unknown> {
  const notes = JSON.stringify({
    kind: "work-package-review",
    workPackageId: input.reviewed.workPackageId,
    jiraWorkPackageKey: input.reviewed.jiraWorkPackageKey,
    evidence: input.reviewed,
    runtimeVersion: input.runtimeVersion ?? null,
    applied: null,
  });
  const review = store.addReview({
    mrRef: `wp://${input.reviewed.workPackageId}`,
    projectId: input.projectId,
    result: input.reviewed.verdict,
    notes,
  });
  store.addAudit({
    path: input.path,
    projectId: input.projectId,
    findings: JSON.stringify(input.reviewed.findings),
    kind: "work-package-review",
    verdict: input.reviewed.verdict,
    scope: input.reviewed.workPackageId,
    reportJson: notes,
  });
  if (input.reviewed.verdict === "PASSED" && input.reviewed.requirementIds.length) {
    for (const req of input.reviewed.requirementIds) {
      store.addTaskCompletion({ projectId: input.projectId, taskRef: req });
    }
  }
  return {
    reviewId: review.id,
    projectId: input.projectId,
    createdAt: review.created_at,
    ...input.reviewed,
  };
}

/** Shape returned by GET /reviews/:id */
export function reviewResponseFromRow(row: ReviewRow): Record<string, unknown> {
  let findings: Finding[] = [];
  let workPackageId: string | undefined;
  let notesParsed: unknown;
  try {
    notesParsed = JSON.parse(row.notes || "{}");
    if (notesParsed && typeof notesParsed === "object") {
      const n = notesParsed as {
        kind?: string;
        findings?: Finding[];
        workPackageId?: string;
        evidence?: WorkPackageReviewResult & { findings?: Finding[] };
        applied?: unknown;
        runtimeVersion?: string | null;
      };
      workPackageId = n.workPackageId ?? n.evidence?.workPackageId;
      if (n.kind === "work-package-review" && n.evidence) {
        return {
          reviewId: row.id,
          projectId: row.project_id,
          createdAt: row.created_at,
          applied: n.applied ?? null,
          runtimeVersion: n.runtimeVersion ?? null,
          ...n.evidence,
        };
      }
      if (Array.isArray(n.findings)) findings = n.findings;
    }
  } catch {
    notesParsed = row.notes;
  }
  return {
    reviewId: row.id,
    projectId: row.project_id,
    workPackageId,
    verdict: row.result,
    findings,
    mrRef: row.mr_ref,
    createdAt: row.created_at,
    notes: notesParsed,
  };
}
