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

/** Shape returned by GET /reviews/:id */
export function reviewResponseFromRow(row: ReviewRow): {
  reviewId: number;
  projectId: string;
  workPackageId?: string;
  verdict: string;
  findings: Finding[];
  mrRef: string;
  createdAt: string;
  notes?: unknown;
} {
  let findings: Finding[] = [];
  let workPackageId: string | undefined;
  let notesParsed: unknown;
  try {
    notesParsed = JSON.parse(row.notes || "{}");
    if (
      notesParsed &&
      typeof notesParsed === "object" &&
      Array.isArray((notesParsed as { findings?: unknown }).findings)
    ) {
      findings = (notesParsed as { findings: Finding[] }).findings;
      workPackageId = (notesParsed as { workPackageId?: string }).workPackageId;
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
