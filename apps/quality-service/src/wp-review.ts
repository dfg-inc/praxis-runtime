/**
 * Canonical Work Package Quality Review engine.
 * HTTP and in-process tests share this module. It does not talk to Jira.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseNodeTestCounts, runNpmTest } from "./review-engine.js";
import { spawnSync } from "node:child_process";

export type QaVerdict = "PASSED" | "FAILED" | "BLOCKED";

export type AcceptanceCheckResult = {
  id: string;
  requirementIds: string[];
  type: string;
  file?: string;
  command?: string;
  expected?: string;
  actual?: string;
  status: "PASSED" | "FAILED" | "BLOCKED";
  timestamp: string;
  detail?: string;
};

export type QualityFinding = {
  fingerprint: string;
  id: string;
  severity: "error" | "warn" | "info";
  blocking: boolean;
  requirementIds: string[];
  acceptanceCheckId?: string;
  expected?: string;
  actual?: string;
  summary: string;
  workPackageId: string;
  canonicalStoryKeys: string[];
  evidenceRef?: string;
};

export type ImplementationSnapshot = {
  files: Array<{ path: string; sha256?: string; missing?: boolean }>;
  digest: string;
};

export type QualityVerification = {
  command: string;
  exitCode: number;
  total: number | null;
  passed: number | null;
  failed: number | null;
  stdoutSnippet: string;
};

export type WorkPackageReviewResult = {
  workPackageId: string;
  jiraWorkPackageKey: string;
  canonicalStoryKeys: string[];
  requirementIds: string[];
  featureIds: string[];
  verdict: QaVerdict;
  acceptanceChecks: AcceptanceCheckResult[];
  verification: QualityVerification | null;
  findings: QualityFinding[];
  snapshot: ImplementationSnapshot;
  identityConflicts: string[];
  developerEvidence: {
    hasCompletionEvidence: boolean;
    hasQualityHandoff: boolean;
    evidencePath?: string;
    qualityHandoffPath?: string;
    readyForQuality: boolean;
  };
  jiraMutated: false;
  approvalApplied: false;
  blockedReason?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function loadQualityTestCommand(repo: string): string {
  const names = [".project", ".project.yaml", ".project.yml"];
  for (const name of names) {
    const p = join(repo, name);
    if (!existsSync(p)) continue;
    let inQ = false;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (/^quality:\s*$/.test(line)) {
        inQ = true;
        continue;
      }
      if (inQ && line.length && !/^\s/.test(line)) break;
      if (!inQ) continue;
      const m = line.match(/^\s+test:\s*(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  return "npm test";
}

function runConfiguredTest(repo: string, command: string): QualityVerification {
  const isNpmRunTest = /^npm(\s+run)?\s+test\b/.test(command);
  if (isNpmRunTest) {
    const run = runNpmTest(repo);
    return {
      command,
      exitCode: run.exitCode,
      total: run.executedCount,
      passed: run.passedCount,
      failed: run.failedCount,
      stdoutSnippet: `${run.stdout}\n${run.stderr}`.slice(0, 800),
    };
  }
  const r = spawnSync(command, {
    cwd: repo,
    encoding: "utf8",
    shell: true,
    timeout: 20_000,
    env: { ...process.env, CI: "1" },
  });
  const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const counts = parseNodeTestCounts(combined);
  return {
    command,
    exitCode: r.status ?? 1,
    total: counts.executedCount,
    passed: counts.passedCount,
    failed: counts.failedCount,
    stdoutSnippet: combined.slice(0, 800),
  };
}

function snapshotFiles(repo: string, files: string[]): ImplementationSnapshot {
  const uniq = [...new Set(files.filter(Boolean))].sort();
  const entries = uniq.map((rel) => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) return { path: rel, missing: true as const };
    return { path: rel, sha256: sha256(readFileSync(abs, "utf8")) };
  });
  const digest = sha256(JSON.stringify(entries));
  return { files: entries, digest };
}

function finding(partial: Omit<QualityFinding, "fingerprint">): QualityFinding {
  const fingerprint = sha256(
    `${partial.workPackageId}|${partial.acceptanceCheckId ?? partial.id}|${partial.summary}`,
  ).slice(0, 16);
  return { ...partial, fingerprint };
}

type RawCheck = {
  type?: string;
  file?: string;
  contains?: string;
  command?: string;
};

function normalizeChecks(raw: unknown): RawCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object") return { type: "invalid" };
    const o = item as Record<string, unknown>;
    return {
      type: asString(o.type) ?? (o.file && (o.contains || o.expected) ? "contains" : undefined),
      file: asString(o.file),
      contains: asString(o.contains) ?? asString(o.expected),
      command: asString(o.command),
    };
  });
}

export class WorkPackageReviewError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WorkPackageReviewError";
    this.code = code;
    this.details = details;
  }
}

export function reviewWorkPackage(input: {
  repo: string;
  workPackageId: string;
  runtimeVersion?: string;
}): WorkPackageReviewResult {
  const repo = resolve(input.repo);
  const wpId = input.workPackageId;
  const timestamp = nowIso();
  const manifestPath = join(repo, "work-packages", wpId, "manifest.json");
  const changeSpecPath = join(repo, "design", wpId, "change-spec.json");
  const archHandoffPath = join(repo, "design", wpId, "architect-developer.handoff.json");
  const evidencePath = join(repo, "design", wpId, "dev", "completion-evidence.json");
  const qualityHandoffPath = join(repo, "design", wpId, "dev", "quality-handoff.json");

  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw new WorkPackageReviewError(
      "QUALITY_MANIFEST_MISSING",
      `Work package manifest missing: ${manifestPath}`,
    );
  }
  const changeSpec = readJson(changeSpecPath);
  if (!changeSpec) {
    throw new WorkPackageReviewError(
      "QUALITY_CHANGE_SPEC_INVALID",
      `change-spec missing or unreadable: ${changeSpecPath}`,
    );
  }
  if (!Array.isArray(changeSpec.acceptanceChecks)) {
    throw new WorkPackageReviewError(
      "QUALITY_CHANGE_SPEC_INVALID",
      "change-spec.acceptanceChecks is required",
      { path: changeSpecPath },
    );
  }

  const evidence = readJson(evidencePath);
  const qualityHandoff = readJson(qualityHandoffPath);
  const archHandoff = readJson(archHandoffPath);

  const identityConflicts: string[] = [];
  const expectedWp = asString(manifest.id) ?? wpId;
  if (expectedWp !== wpId) identityConflicts.push(`manifest.id=${expectedWp} != ${wpId}`);
  for (const [label, obj] of [
    ["change-spec", changeSpec],
    ["architect-handoff", archHandoff],
    ["evidence", evidence],
    ["quality-handoff", qualityHandoff],
  ] as const) {
    const id = asString(obj?.workPackageId) ?? asString(obj?.id);
    if (id && id !== wpId) identityConflicts.push(`${label}.workPackageId=${id}`);
  }

  const jiraKey =
    asString(manifest.jiraIssueKey) ??
    asString(evidence?.jiraWorkPackageKey) ??
    asString(qualityHandoff?.jiraWorkPackageKey);
  if (!jiraKey) {
    throw new WorkPackageReviewError(
      "QUALITY_INPUTS_INCONSISTENT",
      "jiraWorkPackageKey is missing from manifest/evidence/handoff",
    );
  }
  for (const [label, obj] of [
    ["evidence", evidence],
    ["quality-handoff", qualityHandoff],
  ] as const) {
    const k = asString(obj?.jiraWorkPackageKey);
    if (k && k !== jiraKey) identityConflicts.push(`${label}.jiraWorkPackageKey=${k}`);
  }

  const storyKeys = asStringArray(manifest.storyKeys);
  const fromEvidence = asStringArray(evidence?.canonicalStoryKeys);
  const fromHandoff = asStringArray(qualityHandoff?.canonicalStoryKeys);
  if (fromEvidence.length && fromEvidence.join() !== storyKeys.join()) {
    identityConflicts.push("evidence.canonicalStoryKeys mismatch vs manifest");
  }
  if (fromHandoff.length && fromHandoff.join() !== storyKeys.join()) {
    identityConflicts.push("quality-handoff.canonicalStoryKeys mismatch vs manifest");
  }

  const requirementIds =
    asStringArray(changeSpec.requirementIds).length > 0
      ? asStringArray(changeSpec.requirementIds)
      : asStringArray(qualityHandoff?.requirementIds).length > 0
        ? asStringArray(qualityHandoff?.requirementIds)
        : asStringArray(evidence?.requirementIds);
  const featureIds = Array.isArray(changeSpec.features)
    ? changeSpec.features
        .map((f) => (f && typeof f === "object" ? asString((f as { id?: unknown }).id) : undefined))
        .filter((x): x is string => Boolean(x))
    : [];

  const hasEvidence = Boolean(evidence);
  const hasHandoff = Boolean(qualityHandoff);
  const readyForQuality =
    manifest.readyForQuality === true || evidence?.readyForQuality === true;

  const specChecks = normalizeChecks(changeSpec.acceptanceChecks);
  const handoffChecks = normalizeChecks(qualityHandoff?.acceptanceChecks);
  if (handoffChecks.length && handoffChecks.length !== specChecks.length) {
    identityConflicts.push(
      `acceptanceChecks count mismatch change-spec=${specChecks.length} handoff=${handoffChecks.length}`,
    );
  }

  const testCommand = loadQualityTestCommand(repo);
  const npmTestNeeded = specChecks.some((c) => c.type === "npm-test") || true;
  const verification = npmTestNeeded ? runConfiguredTest(repo, testCommand) : null;

  const snapshotTargets = [
    ...specChecks.map((c) => c.file).filter((x): x is string => Boolean(x)),
    ...asStringArray(
      Array.isArray(changeSpec.changes)
        ? changeSpec.changes.map((c) =>
            c && typeof c === "object" ? asString((c as { file?: unknown }).file) : undefined,
          )
        : [],
    ),
    ...asStringArray(evidence?.changedProductFiles),
  ];
  const snapshot = snapshotFiles(repo, snapshotTargets);

  const acceptanceChecks: AcceptanceCheckResult[] = [];
  const findings: QualityFinding[] = [];

  if (identityConflicts.length) {
    findings.push(
      finding({
        id: "identity",
        severity: "error",
        blocking: true,
        requirementIds,
        summary: `canonical identifier conflict: ${identityConflicts.join("; ")}`,
        workPackageId: wpId,
        canonicalStoryKeys: storyKeys,
      }),
    );
  }
  if (!hasHandoff || !hasEvidence || !readyForQuality) {
    findings.push(
      finding({
        id: "readiness",
        severity: "error",
        blocking: true,
        requirementIds,
        summary: `Developer handoff not ready (evidence=${hasEvidence} handoff=${hasHandoff} readyForQuality=${readyForQuality})`,
        workPackageId: wpId,
        canonicalStoryKeys: storyKeys,
        evidenceRef: qualityHandoffPath,
      }),
    );
  }

  if (specChecks.length === 0) {
    findings.push(
      finding({
        id: "acceptance.empty",
        severity: "error",
        blocking: true,
        requirementIds,
        summary: "change-spec has no acceptanceChecks",
        workPackageId: wpId,
        canonicalStoryKeys: storyKeys,
      }),
    );
  }

  for (const [i, check] of specChecks.entries()) {
    const id = `AC${i + 1}`;
    const ts = timestamp;
    if (!check.type) {
      acceptanceChecks.push({
        id,
        requirementIds,
        type: "unknown",
        status: "BLOCKED",
        timestamp: ts,
        detail: "acceptance check type missing",
      });
      findings.push(
        finding({
          id,
          acceptanceCheckId: id,
          severity: "error",
          blocking: true,
          requirementIds,
          summary: `${id} has no type`,
          workPackageId: wpId,
          canonicalStoryKeys: storyKeys,
        }),
      );
      continue;
    }
    if (check.type === "contains") {
      if (!check.file || check.contains === undefined) {
        acceptanceChecks.push({
          id,
          requirementIds,
          type: "contains",
          file: check.file,
          expected: check.contains,
          status: "BLOCKED",
          timestamp: ts,
          detail: "contains check missing file or expected string",
        });
        findings.push(
          finding({
            id,
            acceptanceCheckId: id,
            severity: "error",
            blocking: true,
            requirementIds,
            summary: `${id} malformed contains check`,
            workPackageId: wpId,
            canonicalStoryKeys: storyKeys,
          }),
        );
        continue;
      }
      const abs = join(repo, check.file);
      if (!existsSync(abs)) {
        acceptanceChecks.push({
          id,
          requirementIds,
          type: "contains",
          file: check.file,
          expected: check.contains,
          actual: "missing-file",
          status: "FAILED",
          timestamp: ts,
          detail: `file missing: ${check.file}`,
        });
        findings.push(
          finding({
            id,
            acceptanceCheckId: id,
            severity: "error",
            blocking: true,
            requirementIds,
            expected: check.contains,
            actual: "missing-file",
            summary: `${id} missing ${check.file}`,
            workPackageId: wpId,
            canonicalStoryKeys: storyKeys,
          }),
        );
        continue;
      }
      const text = readFileSync(abs, "utf8");
      const ok = text.includes(check.contains);
      acceptanceChecks.push({
        id,
        requirementIds,
        type: "contains",
        file: check.file,
        expected: check.contains,
        actual: ok ? check.contains : "not-found",
        status: ok ? "PASSED" : "FAILED",
        timestamp: ts,
      });
      if (!ok) {
        findings.push(
          finding({
            id,
            acceptanceCheckId: id,
            severity: "error",
            blocking: true,
            requirementIds,
            expected: check.contains,
            actual: "not-found",
            summary: `${id} ${check.file} missing expected snippet`,
            workPackageId: wpId,
            canonicalStoryKeys: storyKeys,
          }),
        );
      }
      continue;
    }
    if (check.type === "npm-test") {
      const v = verification;
      const ok = Boolean(v && v.exitCode === 0);
      acceptanceChecks.push({
        id,
        requirementIds,
        type: "npm-test",
        command: v?.command ?? testCommand,
        expected: "exitCode 0",
        actual: v ? `exitCode ${v.exitCode}` : "not-run",
        status: ok ? "PASSED" : "FAILED",
        timestamp: ts,
        detail: v
          ? `total=${v.total} passed=${v.passed} failed=${v.failed}`
          : "Quality test run missing",
      });
      if (!ok) {
        findings.push(
          finding({
            id,
            acceptanceCheckId: id,
            severity: "error",
            blocking: true,
            requirementIds,
            expected: "exitCode 0",
            actual: v ? `exitCode ${v.exitCode}` : "not-run",
            summary: `${id} Quality test command failed`,
            workPackageId: wpId,
            canonicalStoryKeys: storyKeys,
          }),
        );
      }
      continue;
    }
    acceptanceChecks.push({
      id,
      requirementIds,
      type: check.type,
      file: check.file,
      command: check.command,
      status: "BLOCKED",
      timestamp: ts,
      detail: `unsupported acceptance check type: ${check.type}`,
    });
    findings.push(
      finding({
        id,
        acceptanceCheckId: id,
        severity: "error",
        blocking: true,
        requirementIds,
        summary: `${id} unsupported type ${check.type}`,
        workPackageId: wpId,
        canonicalStoryKeys: storyKeys,
      }),
    );
  }

  const blocking = findings.filter((f) => f.blocking);
  const failedAc = acceptanceChecks.some((c) => c.status === "FAILED");
  const blockedAc = acceptanceChecks.some((c) => c.status === "BLOCKED");
  const testsFailed = verification ? verification.exitCode !== 0 : false;

  let verdict: QaVerdict = "PASSED";
  let blockedReason: string | undefined;
  if (identityConflicts.length) {
    verdict = "BLOCKED";
    blockedReason = "canonical identifier conflict";
  } else if (!hasHandoff || !hasEvidence || !readyForQuality) {
    verdict = "BLOCKED";
    blockedReason = "Developer handoff not ready";
  } else if (blockedAc || blocking.some((f) => f.id === "acceptance.empty" || f.summary.includes("unsupported"))) {
    verdict = "BLOCKED";
    blockedReason =
      acceptanceChecks.find((c) => c.status === "BLOCKED")?.detail ?? "verification blocked";
  } else if (failedAc || testsFailed || blocking.length) {
    verdict = "FAILED";
  }

  return {
    workPackageId: wpId,
    jiraWorkPackageKey: jiraKey,
    canonicalStoryKeys: storyKeys,
    requirementIds,
    featureIds,
    verdict,
    acceptanceChecks,
    verification,
    findings,
    snapshot,
    identityConflicts,
    developerEvidence: {
      hasCompletionEvidence: hasEvidence,
      hasQualityHandoff: hasHandoff,
      evidencePath: hasEvidence ? evidencePath : undefined,
      qualityHandoffPath: hasHandoff ? qualityHandoffPath : undefined,
      readyForQuality,
    },
    jiraMutated: false,
    approvalApplied: false,
    blockedReason,
  };
}
