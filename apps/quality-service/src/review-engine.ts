/**
 * Local executable review engine for Quality (CLI + HTTP).
 * Product-agnostic: discovery + npm test execution, no fixture hardcoding.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
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
  workPackageId?: string;
  testExecution?: {
    exitCode: number;
    executedCount: number | null;
    passedCount: number | null;
    failedCount: number | null;
    outputSnippet: string;
  };
};

export type AcceptanceCheck = {
  type?: string;
  file?: string;
  contains?: string;
};

export type VerificationCheck = {
  status: "passed" | "failed" | "skipped";
  required: boolean;
};

export type DevQualityHandoff = {
  contract: string;
  version?: string;
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

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".praxis-quality",
]);

/** Colocated / conventional test file names. */
const TEST_FILE_RE = /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/i;

export function isTestFileName(name: string): boolean {
  return TEST_FILE_RE.test(name);
}

export function isUnderTestsDir(relPosix: string): boolean {
  return (
    /(^|\/)__tests__(\/|$)/.test(relPosix) ||
    /(^|\/)tests?(\/|$)/.test(relPosix)
  );
}

/**
 * Discover automated test files under normal layouts:
 * test/, tests/, __tests__/, src/**\/*.test|spec.*, colocated *.test|spec.*.
 */
export function discoverTestFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, root, (abs, rel) => {
    const base = abs.split(/[/\\]/).pop() ?? "";
    if (!/\.(js|mjs|cjs|ts|tsx)$/i.test(base)) return;
    if (isTestFileName(base)) {
      out.push(abs);
      return;
    }
    // Any JS/TS under __tests__/ (even without .test. suffix)
    if (/(^|\/)__tests__\//.test(rel)) {
      out.push(abs);
    }
  });
  return [...new Set(out)].sort();
}

/** Source files excluding test files. */
export function discoverSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const top of ["src", "lib"]) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    walk(dir, root, (abs, rel) => {
      const base = abs.split(/[/\\]/).pop() ?? "";
      if (!/\.(js|mjs|cjs|ts|tsx)$/i.test(base)) return;
      if (isTestFileName(base)) return;
      if (isUnderTestsDir(rel)) return;
      out.push(abs);
    });
  }
  return out;
}

function walk(
  dir: string,
  root: string,
  visit: (abs: string, relPosix: string) => void,
): void {
  if (!existsSync(dir)) return;
  let st;
  try {
    st = statSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(abs, root, visit);
      continue;
    }
    if (!ent.isFile()) continue;
    const rel = relative(root, abs).split("\\").join("/");
    visit(abs, rel);
  }
}

/**
 * Parse Node.js built-in test runner / common reporters for executed test count.
 * Returns null counts when the output cannot be interpreted.
 */
export function parseNodeTestCounts(output: string): {
  executedCount: number | null;
  passedCount: number | null;
  failedCount: number | null;
} {
  // node --test default reporter: "ℹ tests 4" / "# tests 4"
  const tests =
    output.match(/(?:^|\n)\s*(?:ℹ\s*)?#?\s*tests\s+(\d+)\s*(?:\n|$)/i) ??
    output.match(/(?:^|\n)\s*ℹ\s*tests\s+(\d+)/i);
  const pass =
    output.match(/(?:^|\n)\s*(?:ℹ\s*)?#?\s*pass\s+(\d+)\s*(?:\n|$)/i) ??
    output.match(/(?:^|\n)\s*ℹ\s*pass\s+(\d+)/i);
  const fail =
    output.match(/(?:^|\n)\s*(?:ℹ\s*)?#?\s*fail\s+(\d+)\s*(?:\n|$)/i) ??
    output.match(/(?:^|\n)\s*ℹ\s*fail\s+(\d+)/i);

  const executedCount = tests ? Number(tests[1]) : null;
  const passedCount = pass ? Number(pass[1]) : null;
  const failedCount = fail ? Number(fail[1]) : null;
  return { executedCount, passedCount, failedCount };
}

export function runNpmTest(cwd: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedCount: number | null;
  passedCount: number | null;
  failedCount: number | null;
} {
  const r = spawnSync("npm run test", {
    cwd,
    encoding: "utf8",
    shell: true,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const counts = parseNodeTestCounts(combined);
  return {
    exitCode: r.status ?? 1,
    stdout,
    stderr,
    executedCount: counts.executedCount,
    passedCount: counts.passedCount,
    failedCount: counts.failedCount,
  };
}

function normalizeVerificationCheck(
  raw: VerificationCheck | boolean | undefined,
  name: string,
): { ok: boolean; detail: string; status: string; required: boolean } {
  if (raw && typeof raw === "object" && "status" in raw) {
    const status = raw.status;
    const ok =
      status === "passed" ||
      (status === "skipped" && raw.required === false);
    return {
      ok,
      status,
      required: !!raw.required,
      detail: `${status} (required=${raw.required})`,
    };
  }
  if (typeof raw === "boolean") {
    return {
      ok: raw,
      status: raw ? "passed" : "failed",
      required: true,
      detail: `${raw} (legacy-boolean:${name})`,
    };
  }
  return {
    ok: false,
    status: "missing",
    required: true,
    detail: "missing verification check",
  };
}

function testsRequired(handoff: DevQualityHandoff | undefined): boolean {
  if (!handoff?.verification?.tests) return false;
  const t = handoff.verification.tests;
  if (typeof t === "boolean") return true;
  return t.required === true || t.status === "passed";
}

/**
 * Local executable review: handoff verification + discovery + acceptance + npm test.
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
    handoff = JSON.parse(
      readFileSync(input.handoffPath, "utf8"),
    ) as DevQualityHandoff;
  }

  const mrRef = handoff?.mergeRequestRef ?? `path://${input.path}`;
  const workPackageId = handoff?.workPackageId;

  if (!existsSync(input.path)) {
    findings.push({
      id: "path-exists",
      severity: "error",
      ok: false,
      detail: `path missing: ${input.path}`,
    });
    return { verdict: "fail", findings, mrRef, projectId, workPackageId };
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
      const norm = normalizeVerificationCheck(v?.[key], key);
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

  const srcFiles = discoverSourceFiles(input.path);
  const testFiles = discoverTestFiles(input.path);
  const hasPkg = existsSync(join(input.path, "package.json"));
  const required = testsRequired(handoff);

  findings.push({
    id: "has-sources",
    severity: srcFiles.length || hasPkg ? "info" : "error",
    ok: srcFiles.length > 0 || hasPkg,
    detail: `${srcFiles.length} src/lib file(s)`,
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

  const checks = (handoff?.acceptanceChecks ?? []).filter(
    (c) => c && typeof c.file === "string" && typeof c.contains === "string",
  ) as Array<{ file: string; contains: string }>;
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

  let testExecution: PathReviewResult["testExecution"];

  const shouldRerun =
    input.rerunTests !== false &&
    hasPkg &&
    (required || input.rerunTests === true || !!handoff);

  if (shouldRerun) {
    const run = runNpmTest(input.path);
    testExecution = {
      exitCode: run.exitCode,
      executedCount: run.executedCount,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      outputSnippet: (run.stdout + run.stderr).slice(0, 400),
    };

    const claimedPassed =
      handoff &&
      normalizeVerificationCheck(handoff.verification?.tests, "tests")
        .status === "passed";

    if (run.exitCode !== 0) {
      findings.push({
        id: "rerun-tests",
        severity: "error",
        ok: false,
        detail: claimedPassed
          ? `Developer claimed tests passed but Quality rerun failed: ${(run.stderr || run.stdout || "FAIL").slice(0, 200)}`
          : (run.stderr || run.stdout || "FAIL").slice(0, 200),
      });
    } else if (run.executedCount === 0) {
      // Exit 0 but zero tests — fail when tests are required / claimed
      if (required || claimedPassed) {
        findings.push({
          id: "rerun-tests",
          severity: "error",
          ok: false,
          detail:
            "npm test exited 0 but executed 0 test cases (required tests)",
        });
      } else {
        findings.push({
          id: "rerun-tests",
          severity: "warn",
          ok: true,
          detail: "npm test exited 0 with 0 parsed test cases (not required)",
        });
      }
    } else if (run.executedCount === null) {
      // Could not parse count — do not treat exit 0 alone as proof when required
      if (required || claimedPassed) {
        if (testFiles.length > 0) {
          findings.push({
            id: "rerun-tests",
            severity: "info",
            ok: true,
            detail: `npm test PASS (exit 0); execution count unavailable; ${testFiles.length} test file(s) discovered`,
          });
        } else {
          findings.push({
            id: "rerun-tests",
            severity: "error",
            ok: false,
            detail:
              "npm test exited 0 but could not prove any tests executed (no count, no discovered files)",
          });
        }
      } else {
        findings.push({
          id: "rerun-tests",
          severity: "info",
          ok: true,
          detail: "npm test PASS (exit 0); execution count unavailable",
        });
      }
    } else {
      findings.push({
        id: "rerun-tests",
        severity: "info",
        ok: true,
        detail: `npm test PASS — ${run.executedCount} test(s) executed` +
          (run.passedCount != null ? ` (${run.passedCount} pass)` : ""),
      });
    }
  }

  // has-tests: static discovery OR proven execution — never fail solely on
  // discovery miss when required execution proved tests ran.
  const executed =
    testExecution &&
    testExecution.exitCode === 0 &&
    ((testExecution.executedCount != null &&
      testExecution.executedCount > 0) ||
      (testExecution.executedCount === null && testFiles.length > 0));

  if (testFiles.length > 0) {
    findings.push({
      id: "has-tests",
      severity: "info",
      ok: true,
      detail: `${testFiles.length} file(s)`,
    });
  } else if (executed) {
    findings.push({
      id: "has-tests",
      severity: "info",
      ok: true,
      detail:
        testExecution?.executedCount != null
          ? `0 static file(s); ${testExecution.executedCount} executed via npm test`
          : "0 static file(s); npm test proved execution",
    });
  } else if (required) {
    findings.push({
      id: "has-tests",
      severity: "error",
      ok: false,
      detail: "0 file(s); required tests not proven",
    });
  } else {
    findings.push({
      id: "has-tests",
      severity: "info",
      ok: true,
      detail: "0 file(s) (tests not required)",
    });
  }

  const verdict = findings.some((f) => !f.ok && f.severity === "error")
    ? "fail"
    : "pass";
  return {
    verdict,
    findings,
    mrRef,
    projectId,
    workPackageId,
    testExecution,
  };
}
