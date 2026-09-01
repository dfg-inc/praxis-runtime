import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type Finding = {
  id: string;
  severity: "error" | "warn" | "info";
  ok: boolean;
  detail: string;
};

export type PathReviewResult = {
  verdict: "pass" | "fail";
  findings: Finding[];
  mrRef: string;
  projectId: string;
};

function walkJs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      walkJs(p, out);
    } else if (/\.(js|mjs|cjs|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

export type AcceptanceCheck = { file: string; contains: string };

export type VerificationCheck = {
  status: "passed" | "failed" | "skipped";
  required: boolean;
};

export type DevQualityHandoff = {
  contract: string;
  workPackageId?: string;
  mergeRequestRef: string;
  intention: string;
  requirementIds: string[];
  decisionIds: string[];
  verification: {
    build: VerificationCheck | boolean;
    tests: VerificationCheck | boolean;
    lint: VerificationCheck | boolean;
    packageCriteria: VerificationCheck | boolean;
  };
  acceptanceChecks?: AcceptanceCheck[];
};

function normalizeVerificationCheck(
  raw: VerificationCheck | boolean | undefined,
  name: string,
): { ok: boolean; detail: string; status: string } {
  if (raw && typeof raw === "object" && "status" in raw) {
    const status = raw.status;
    // skipped is not a failure for Quality intake; required+not-passed is
    const ok =
      status === "passed" ||
      (status === "skipped" && raw.required === false);
    return {
      ok,
      status,
      detail: `${status} (required=${raw.required})`,
    };
  }
  if (typeof raw === "boolean") {
    // Legacy boolean: cannot distinguish skipped — treat as pass/fail only
    return {
      ok: raw,
      status: raw ? "passed" : "failed",
      detail: `${raw} (legacy-boolean:${name})`,
    };
  }
  return { ok: false, status: "missing", detail: "missing verification check" };
}

/**
 * Local executable review: handoff verification + static path checks +
 * optional acceptanceChecks + optional re-run of product npm test.
 * Product-agnostic (no fixture-specific AC).
 */
export function reviewPath(input: {
  path: string;
  projectId?: string;
  handoff?: DevQualityHandoff;
  handoffPath?: string;
  rerunTests?: boolean;
}): PathReviewResult {
  const projectId = input.projectId ?? "default";
  const findings: Finding[] = [];
  let handoff = input.handoff;
  if (!handoff && input.handoffPath) {
    handoff = JSON.parse(readFileSync(input.handoffPath, "utf8")) as DevQualityHandoff;
  }

  const mrRef = handoff?.mergeRequestRef ?? `path://${input.path}`;

  if (!existsSync(input.path)) {
    findings.push({
      id: "path-exists",
      severity: "error",
      ok: false,
      detail: `path missing: ${input.path}`,
    });
    return { verdict: "fail", findings, mrRef, projectId };
  }
  findings.push({
    id: "path-exists",
    severity: "info",
    ok: true,
    detail: input.path,
  });

  if (handoff) {
    if (handoff.contract !== "developer.quality.handoff") {
      findings.push({
        id: "handoff-contract",
        severity: "error",
        ok: false,
        detail: `unexpected ${handoff.contract}`,
      });
    } else {
      findings.push({
        id: "handoff-contract",
        severity: "info",
        ok: true,
        detail: handoff.contract,
      });
    }
    const v = handoff.verification;
    for (const key of ["build", "tests", "lint", "packageCriteria"] as const) {
      const norm = normalizeVerificationCheck(v[key], key);
      findings.push({
        id: `verification.${key}`,
        severity: norm.ok ? "info" : "error",
        ok: norm.ok,
        detail: norm.detail,
      });
    }
    if (handoff.workPackageId) {
      findings.push({
        id: "workPackageId",
        severity: "info",
        ok: true,
        detail: handoff.workPackageId,
      });
    } else {
      findings.push({
        id: "workPackageId",
        severity: "error",
        ok: false,
        detail: "missing workPackageId on developer.quality.handoff",
      });
    }
    if (!handoff.intention?.trim()) {
      findings.push({
        id: "intention",
        severity: "error",
        ok: false,
        detail: "empty intention",
      });
    } else {
      findings.push({
        id: "intention",
        severity: "info",
        ok: true,
        detail: handoff.intention.slice(0, 120),
      });
    }
  } else {
    findings.push({
      id: "handoff",
      severity: "warn",
      ok: true,
      detail: "no handoff provided; path-only review",
    });
  }

  const srcFiles = walkJs(join(input.path, "src")).concat(
    walkJs(join(input.path, "lib")),
  );
  const testFiles = walkJs(join(input.path, "test")).concat(
    walkJs(join(input.path, "tests")),
  );
  const hasPkg = existsSync(join(input.path, "package.json"));
  findings.push({
    id: "has-sources",
    severity: srcFiles.length || hasPkg ? "info" : "error",
    ok: srcFiles.length > 0 || hasPkg,
    detail: `${srcFiles.length} src/lib file(s)`,
  });
  findings.push({
    id: "has-tests",
    severity: testFiles.length ? "info" : "error",
    ok: testFiles.length > 0,
    detail: `${testFiles.length} file(s)`,
  });

  let critical = false;
  for (const f of srcFiles) {
    const text = readFileSync(f, "utf8");
    if (text.includes("FIXME-CRITICAL")) {
      critical = true;
      findings.push({
        id: "fixme-critical",
        severity: "error",
        ok: false,
        detail: f,
      });
    }
  }
  if (!critical) {
    findings.push({
      id: "fixme-critical",
      severity: "info",
      ok: true,
      detail: "none",
    });
  }

  const checks = handoff?.acceptanceChecks ?? [];
  for (const [i, check] of checks.entries()) {
    const fp = join(input.path, check.file);
    if (!existsSync(fp)) {
      findings.push({
        id: `acceptance.${i}`,
        severity: "error",
        ok: false,
        detail: `missing ${check.file}`,
      });
      continue;
    }
    const text = readFileSync(fp, "utf8");
    const ok = text.includes(check.contains);
    findings.push({
      id: `acceptance.${i}`,
      severity: ok ? "info" : "error",
      ok,
      detail: ok
        ? `${check.file} contains expected snippet`
        : `${check.file} missing: ${check.contains.slice(0, 80)}`,
    });
  }

  if (input.rerunTests !== false && hasPkg) {
    const r = spawnSync("npm", ["run", "test"], {
      cwd: input.path,
      encoding: "utf8",
      shell: true,
    });
    findings.push({
      id: "rerun-tests",
      severity: r.status === 0 ? "info" : "error",
      ok: r.status === 0,
      detail: r.status === 0 ? "npm test PASS" : (r.stderr || r.stdout || "FAIL").slice(0, 200),
    });
  }

  const verdict = findings.some((f) => !f.ok && f.severity === "error")
    ? "fail"
    : "pass";
  return { verdict, findings, mrRef, projectId };
}
