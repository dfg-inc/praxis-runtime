/**
 * Quality governance layer (WBS 6.2 / 6.3 / 6.6 / 6.7 / 6.8).
 * Shared by CLI and HTTP. Does not replace reviewPath / performPathReview.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QualityHotfixEventSchema,
  QualityMrContextSchema,
  QualityRollbackEventSchema,
  type QualityAuditReport,
  type QualityMrContext,
} from "@praxis/contracts";
import {
  acceptFindingProposal,
  loadFindingStore,
  prepareFindingProposal,
  rejectFindingProposal,
  saveFindingStore,
  type FindingStore,
} from "@praxis/knowledge";
import { groupFindingsByFingerprint } from "./fingerprint.js";
import {
  changedFilesBetween,
  GitContextError,
  refExists,
  resolveSha,
} from "./git-context.js";
import { reviewPath, type DevQualityHandoff, type Finding } from "./review-engine.js";
import { performPathReview, type PathReviewPersisted } from "./review-orchestrator.js";
import type { QualityStore, ReturnRow, ReviewRow } from "./store.js";

export const REPEATED_FINDING_THRESHOLD = 3;

export class GovernanceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function toolVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function snapshotTree(root: string): Record<string, string> {
  const skip = new Set(["node_modules", ".git", "dist", "build", ".praxis-quality"]);
  const map: Record<string, string> = {};
  const walk = (dir: string, rel = "") => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else map[r] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return map;
}

function findingsFromReview(row: ReviewRow): Finding[] {
  try {
    const notes = JSON.parse(row.notes || "{}") as { findings?: Finding[] };
    return Array.isArray(notes.findings) ? notes.findings : [];
  } catch {
    return [];
  }
}

function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => !f.ok && f.severity === "error");
}

function persistReviewFromPath(
  store: QualityStore,
  reviewed: ReturnType<typeof reviewPath>,
  extraNotes?: Record<string, unknown>,
): PathReviewPersisted {
  const groups = groupFindingsByFingerprint(reviewed.findings);
  const notes = JSON.stringify({
    findings: reviewed.findings,
    groups,
    workPackageId: reviewed.workPackageId,
    testExecution: reviewed.testExecution,
    ...extraNotes,
  });
  const review = store.addReview({
    mrRef: reviewed.mrRef,
    projectId: reviewed.projectId,
    result: reviewed.verdict,
    notes,
  });
  const audit = store.addAudit({
    path: String(extraNotes?.repositoryPath ?? ""),
    projectId: reviewed.projectId,
    findings: JSON.stringify(reviewed.findings),
    kind: "path-review",
    verdict: reviewed.verdict,
  });
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

export function performMrReview(
  store: QualityStore,
  input: {
    context: unknown;
    handoff?: DevQualityHandoff;
    rerunTests?: boolean;
  },
): PathReviewPersisted {
  let context: QualityMrContext;
  try {
    context = QualityMrContextSchema.parse(input.context);
  } catch (err) {
    throw new GovernanceError(
      "invalid_mr_context",
      err instanceof Error ? err.message : String(err),
    );
  }
  const handoff = input.handoff ?? (context.qualityHandoff as DevQualityHandoff | undefined);
  const repo = context.repositoryPath;
  const gitFindings: Finding[] = [];
  let fatal = false;

  if (!refExists(repo, context.baseSha)) {
    gitFindings.push({
      id: "mr-base-ref",
      severity: "error",
      ok: false,
      detail: `unknown base SHA ${context.baseSha}`,
    });
    fatal = true;
  } else {
    gitFindings.push({
      id: "mr-base-ref",
      severity: "info",
      ok: true,
      detail: context.baseSha,
    });
  }

  if (!refExists(repo, context.headSha)) {
    gitFindings.push({
      id: "mr-head-ref",
      severity: "error",
      ok: false,
      detail: `unknown head SHA ${context.headSha}`,
    });
    fatal = true;
  } else {
    gitFindings.push({
      id: "mr-head-ref",
      severity: "info",
      ok: true,
      detail: context.headSha,
    });
  }

  if (handoff) {
    if (handoff.workPackageId !== context.workPackageId) {
      gitFindings.push({
        id: "mr-workPackageId",
        severity: "error",
        ok: false,
        detail: `handoff ${handoff.workPackageId} !== context ${context.workPackageId}`,
      });
    } else {
      gitFindings.push({
        id: "mr-workPackageId",
        severity: "info",
        ok: true,
        detail: context.workPackageId,
      });
    }
    if (handoff.mergeRequestRef !== context.mergeRequestRef) {
      gitFindings.push({
        id: "mr-mergeRequestRef",
        severity: "error",
        ok: false,
        detail: `handoff ${handoff.mergeRequestRef} !== context ${context.mergeRequestRef}`,
      });
    }
  }

  if (!fatal) {
    const actual = changedFilesBetween(
      repo,
      context.baseSha || context.baseBranch,
      context.headSha || context.headBranch,
    );
    const claimed = [...context.changedFiles].map((f) => f.replace(/\\/g, "/")).sort();
    const missing = actual.filter((f) => !claimed.includes(f));
    const extra = claimed.filter((f) => !actual.includes(f));
    if (missing.length || extra.length) {
      gitFindings.push({
        id: "changed-files-mismatch",
        severity: "error",
        ok: false,
        detail: `claimed=[${claimed.join(",")}] actual=[${actual.join(",")}] extra=[${extra.join(",")}] missing=[${missing.join(",")}]`,
      });
    } else {
      gitFindings.push({
        id: "changed-files-mismatch",
        severity: "info",
        ok: true,
        detail: actual.join(",") || "(none)",
      });
    }
  }

  if (fatal) {
    const reviewed = {
      verdict: "fail" as const,
      findings: gitFindings,
      mrRef: context.mergeRequestRef,
      projectId: context.projectId,
      workPackageId: context.workPackageId,
    };
    return persistReviewFromPath(store, reviewed, {
      repositoryPath: repo,
      mrContext: true,
      skippedEngine: true,
    });
  }

  const engine = reviewPath({
    path: repo,
    projectId: context.projectId,
    handoff,
    rerunTests: input.rerunTests,
  });
  engine.findings = [...gitFindings, ...engine.findings];
  engine.mrRef = context.mergeRequestRef;
  engine.workPackageId = context.workPackageId;
  engine.verdict = engine.findings.some((f) => !f.ok && f.severity === "error")
    ? "fail"
    : "pass";
  if (engine.verdict === "pass" && handoff?.requirementIds?.length) {
    for (const req of handoff.requirementIds) {
      store.addTaskCompletion({ projectId: context.projectId, taskRef: req });
    }
  }
  return persistReviewFromPath(store, engine, {
    repositoryPath: repo,
    mrContext: true,
  });
}

function remediationFor(f: Finding): string {
  if (f.id === "fixme-critical") {
    return "Remove FIXME-CRITICAL markers from product source before merge.";
  }
  if (f.id === "has-sources" && !f.ok) {
    return "Add source files under src/ or lib/, or a package.json.";
  }
  if (!f.ok) return `Address finding ${f.id}: ${f.detail}`;
  return "";
}

export function renderAuditMarkdown(report: QualityAuditReport): string {
  const findings = report.findings as Finding[];
  return `# Quality codebase audit ${report.auditId}

- project: ${report.projectId}
- path: ${report.auditedPath}
- timestamp: ${report.timestamp}
- scope: ${report.scope}
- verdict: **${report.verdict}**
- tool: ${report.tool.name}@${report.tool.version}

## Summary

- total: ${report.summary.total}
- blocking: ${report.summary.blocking}
- warnings: ${report.summary.warnings}

## Checks

${report.checksPerformed.map((c) => `- ${c}`).join("\n")}

## Findings by severity

${Object.entries(report.findingsBySeverity)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

## Findings

${findings.map((f) => `- [${f.severity}] ${f.id} ok=${f.ok} — ${f.detail}`).join("\n")}

## Unresolved high-risk

${
  report.unresolvedHighRisk.length
    ? (report.unresolvedHighRisk as Finding[])
        .map((f) => `- ${f.id}: ${f.detail}`)
        .join("\n")
    : "- none"
}

## Remediation

${report.remediation.map((r) => `- ${r}`).join("\n") || "- none"}
`;
}

export function performCodebaseAudit(
  store: QualityStore,
  input: {
    path: string;
    projectId?: string;
    outDir?: string;
    rerunTests?: boolean;
  },
): { auditId: number; report: QualityAuditReport; reportMd: string } {
  const projectId = input.projectId ?? "default";
  const before = snapshotTree(input.path);
  const reviewed = reviewPath({
    path: input.path,
    projectId,
    rerunTests: input.rerunTests === true,
  });
  const after = snapshotTree(input.path);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new GovernanceError("audit_mutated_source", "codebase audit mutated audited source");
  }
  const blocking = blockingFindings(reviewed.findings);
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const f of reviewed.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.id] = (byCategory[f.id] ?? 0) + 1;
  }
  const draft: Omit<QualityAuditReport, "auditId"> & { auditId: number } = {
    contract: "quality.audit.report",
    version: "0.1.0",
    auditId: 0,
    projectId,
    auditedPath: input.path,
    timestamp: new Date().toISOString(),
    scope: "full-tree (src/lib + detectors; no Developer handoff)",
    checksPerformed: [...new Set(reviewed.findings.map((f) => f.id))],
    findings: reviewed.findings,
    findingsBySeverity: bySeverity,
    findingsByCategory: byCategory,
    evidence: reviewed.findings.map((f) => `${f.id}:${f.detail}`),
    summary: {
      total: reviewed.findings.length,
      blocking: blocking.length,
      warnings: reviewed.findings.filter((f) => f.severity === "warn").length,
    },
    verdict: reviewed.verdict,
    remediation: reviewed.findings.map(remediationFor).filter(Boolean),
    unresolvedHighRisk: blocking,
    tool: { name: "@praxis/quality-service", version: toolVersion() },
  };
  const row = store.addAudit({
    path: input.path,
    projectId,
    findings: JSON.stringify(reviewed.findings),
    kind: "codebase",
    verdict: reviewed.verdict,
    scope: draft.scope,
  });
  const report: QualityAuditReport = { ...draft, auditId: row.id };
  const reportMd = renderAuditMarkdown(report);
  store.writeAuditReport(row.id, JSON.stringify(report, null, 2), reportMd);
  if (input.outDir) {
    mkdirSync(input.outDir, { recursive: true });
    writeFileSync(join(input.outDir, `audit-${row.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(input.outDir, `audit-${row.id}.md`), reportMd);
  }
  return { auditId: row.id, report, reportMd };
}

export function recordRollbackEvent(
  store: QualityStore,
  input: unknown,
  opts?: { repo?: string },
): ReturnType<QualityStore["addRollback"]> {
  const parsed = QualityRollbackEventSchema.parse(input);
  if (parsed.reviewId != null && !store.getReview(parsed.reviewId)) {
    throw new GovernanceError(
      "unknown_review",
      `review ${parsed.reviewId} not found`,
    );
  }
  if (opts?.repo && parsed.affectedRef && !refExists(opts.repo, parsed.affectedRef)) {
    throw new GovernanceError(
      "unknown_ref",
      `affected ref not in git fixture: ${parsed.affectedRef}`,
    );
  }
  const row = store.addRollback({
    projectId: parsed.projectId,
    mrRef: parsed.mergeRequestRef,
    reason: parsed.reason,
    workPackageId: parsed.workPackageId,
    affectedRef: parsed.affectedRef,
    trigger: parsed.trigger,
    reviewId: parsed.reviewId,
    status: parsed.status,
    evidence: parsed.evidence,
    payload: JSON.stringify(parsed),
  });
  return row;
}

export function recordHotfixEvent(
  store: QualityStore,
  input: unknown,
  opts: { repo: string },
): ReturnType<QualityStore["addHotfix"]> {
  const parsed = QualityHotfixEventSchema.parse(input);
  const rb = store.getRollback(parsed.rollbackId);
  if (!rb) {
    throw new GovernanceError("unknown_rollback", `rollback ${parsed.rollbackId} not found`);
  }
  if (!refExists(opts.repo, parsed.hotfixRef)) {
    throw new GovernanceError(
      "unknown_ref",
      `hotfix ref not in git fixture: ${parsed.hotfixRef}`,
    );
  }
  if (parsed.reviewId != null && !store.getReview(parsed.reviewId)) {
    throw new GovernanceError("unknown_review", `review ${parsed.reviewId} not found`);
  }
  return store.addHotfix({
    projectId: parsed.projectId,
    rollbackId: parsed.rollbackId,
    hotfixRef: parsed.hotfixRef,
    reason: parsed.reason,
    workPackageId: parsed.workPackageId,
    reviewId: parsed.reviewId,
    verification: parsed.verification,
    payload: JSON.stringify(parsed),
  });
}

export function createQualityReturn(
  store: QualityStore,
  input: {
    reviewId: number;
    source: "qa" | "code-review";
    blockingFindingIds: string[];
    reason: string;
  },
): ReturnRow {
  const review = store.getReview(input.reviewId);
  if (!review) {
    throw new GovernanceError("unknown_review", `review ${input.reviewId} not found`);
  }
  const findings = findingsFromReview(review);
  const blocking = blockingFindings(findings);
  for (const id of input.blockingFindingIds) {
    if (!blocking.some((f) => f.id === id) && !findings.some((f) => f.id === id && !f.ok)) {
      throw new GovernanceError(
        "unknown_finding",
        `finding ${id} is not a blocking finding on review ${input.reviewId}`,
      );
    }
  }
  const notes = (() => {
    try {
      return JSON.parse(review.notes || "{}") as { workPackageId?: string };
    } catch {
      return {};
    }
  })();
  const workPackageId = notes.workPackageId ?? review.mr_ref;
  const payload = {
    contract: "quality.return.event",
    version: "0.1.0",
    projectId: review.project_id,
    workPackageId,
    mergeRequestRef: review.mr_ref,
    reviewId: review.id,
    targetRole: "developer",
    blockingFindingIds: input.blockingFindingIds,
    reason: input.reason,
    source: input.source,
    status: "open",
    returnedAt: new Date().toISOString(),
  };
  return store.addReturnEvent({
    projectId: review.project_id,
    taskRef: workPackageId,
    source: input.source,
    reviewId: review.id,
    findingIds: input.blockingFindingIds,
    reason: input.reason,
    payload: JSON.stringify(payload),
  });
}

export function resolveQualityReturn(
  store: QualityStore,
  input: { returnId: number; followUpReviewId: number },
): ReturnRow {
  const ret = store.getReturn(input.returnId);
  if (!ret) throw new GovernanceError("unknown_return", `return ${input.returnId} not found`);
  const follow = store.getReview(input.followUpReviewId);
  if (!follow) {
    throw new GovernanceError("unknown_review", `follow-up review ${input.followUpReviewId} not found`);
  }
  if (follow.result !== "pass") {
    throw new GovernanceError("followup_not_pass", "follow-up review must pass to resolve return");
  }
  return store.resolveReturn(input.returnId, input.followUpReviewId);
}

function failingFingerprintsFromFindings(findings: Finding[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of findings) {
    if (f.ok) continue;
    const fp = `${f.id}:fail:${f.severity}`;
    map.set(fp, f.detail);
  }
  return map;
}

export function analyzeRepeatedFindings(
  store: QualityStore,
  input: {
    projectId: string;
    knowledgeStorePath: string;
    threshold?: number;
  },
): {
  threshold: number;
  proposals: unknown[];
  skipped: { fingerprint: string; reason: string }[];
} {
  const threshold = input.threshold ?? REPEATED_FINDING_THRESHOLD;
  const occ = new Map<string, { sources: Set<string>; evidence: string }>();
  for (const rev of store.listReviews(input.projectId)) {
    const fps = failingFingerprintsFromFindings(findingsFromReview(rev));
    for (const [fp, ev] of fps) {
      const cur = occ.get(fp) ?? { sources: new Set<string>(), evidence: ev };
      cur.sources.add(`review:${rev.id}`);
      occ.set(fp, cur);
    }
  }
  for (const aud of store.listCodebaseAudits(input.projectId)) {
    let findings: Finding[] = [];
    try {
      findings = JSON.parse(aud.findings || "[]") as Finding[];
    } catch {
      findings = [];
    }
    const fps = failingFingerprintsFromFindings(findings);
    for (const [fp, ev] of fps) {
      const cur = occ.get(fp) ?? { sources: new Set<string>(), evidence: ev };
      cur.sources.add(`audit:${aud.id}`);
      occ.set(fp, cur);
    }
  }

  const knowledge: FindingStore = loadFindingStore(input.knowledgeStorePath);
  const proposals: unknown[] = [];
  const skipped: { fingerprint: string; reason: string }[] = [];

  for (const [fp, rec] of occ) {
    if (rec.sources.size < threshold) continue;
    const existing = store.getNormProposal(input.projectId, fp);
    if (existing) {
      skipped.push({ fingerprint: fp, reason: `already ${existing.status}` });
      continue;
    }
    const sourceIds = [...rec.sources].sort();
    const proposedRuleId = `quality-norm-${fp.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}`;
    const prepared = prepareFindingProposal(knowledge, {
      kind: "repeated-choice",
      proposedRuleId,
      title: `Repeated quality finding ${fp}`,
      body: [
        `Quality observed fingerprint ${fp} in ${rec.sources.size} independent reviews/audits.`,
        `Sources: ${sourceIds.join(", ")}.`,
        `Evidence: ${rec.evidence}.`,
        `Created by quality. Not binding until Knowledge human accept.`,
      ].join(" "),
      sourceRefs: [`quality-finding:${fp}`],
    });
    if (prepared.status === "suppressed") {
      skipped.push({ fingerprint: fp, reason: prepared.reason });
      store.addNormProposal({
        projectId: input.projectId,
        fingerprint: fp,
        occurrenceCount: rec.sources.size,
        sourceIds,
        knowledgeRuleId: proposedRuleId,
        status: "suppressed",
      });
      continue;
    }
    saveFindingStore(input.knowledgeStorePath, knowledge);
    const qProposal = {
      contract: "quality.norm.proposal",
      version: "0.1.0",
      fingerprint: fp,
      occurrenceCount: rec.sources.size,
      sourceIds,
      evidence: rec.evidence,
      proposedRuleId,
      topic: fp,
      projectId: input.projectId,
      status: "proposed" as const,
      createdBy: "quality" as const,
      binding: false as const,
    };
    store.addNormProposal({
      projectId: input.projectId,
      fingerprint: fp,
      occurrenceCount: rec.sources.size,
      sourceIds,
      knowledgeRuleId: proposedRuleId,
      status: "proposed",
    });
    proposals.push(qProposal);
  }

  return { threshold, proposals, skipped };
}

export function knowledgeRejectByRuleId(
  knowledgeStorePath: string,
  proposedRuleId: string,
  reason: string,
): void {
  const knowledge = loadFindingStore(knowledgeStorePath);
  const proposal = [...knowledge.proposals]
    .reverse()
    .find((p) => p.proposedRuleId === proposedRuleId);
  if (!proposal) throw new GovernanceError("unknown_proposal", proposedRuleId);
  rejectFindingProposal(knowledge, proposal, reason);
  saveFindingStore(knowledgeStorePath, knowledge);
}

export function knowledgeAcceptByRuleId(
  knowledgeStorePath: string,
  proposedRuleId: string,
): void {
  const knowledge = loadFindingStore(knowledgeStorePath);
  const proposal = [...knowledge.proposals]
    .reverse()
    .find((p) => p.proposedRuleId === proposedRuleId);
  if (!proposal) throw new GovernanceError("unknown_proposal", proposedRuleId);
  acceptFindingProposal(knowledge, proposal);
  saveFindingStore(knowledgeStorePath, knowledge);
}

export { performPathReview, GitContextError, resolveSha };
