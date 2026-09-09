import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { QualityStore } from "../src/store.js";
import {
  REPEATED_FINDING_THRESHOLD,
  analyzeRepeatedFindings,
  createQualityReturn,
  knowledgeAcceptByRuleId,
  knowledgeRejectByRuleId,
  performCodebaseAudit,
  performMrReview,
  recordHotfixEvent,
  recordRollbackEvent,
  resolveQualityReturn,
  snapshotTree,
} from "../src/quality-governance.js";
import { performPathReview } from "../src/review-orchestrator.js";

const dirs: string[] = [];
const stores: QualityStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "q-gov-"));
  dirs.push(d);
  return d;
}

function git(repo: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function writeProduct(root: string, broken = false) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "q-gov-demo",
      type: "module",
      scripts: { test: "node --test src/*.test.js" },
    }),
  );
  const src = broken
    ? "export function scale(v) { return v * 2 } // FIXME-CRITICAL\n"
    : "export function scale(v) { return v * 2 }\n";
  writeFileSync(join(root, "src/widget.js"), src);
  writeFileSync(
    join(root, "src/widget.test.js"),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { scale } from './widget.js';
test('scale', () => assert.equal(scale(5), 10));
`,
  );
}

function initGitWithFeature(root: string, broken = false) {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "feat"]);
  writeProduct(root, broken);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "feat"]);
  const baseSha = git(root, ["rev-parse", "main"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  const changed = git(root, ["diff", "--name-only", "main...HEAD"])
    .split("\n")
    .filter(Boolean);
  return { baseSha, headSha, changed };
}

const readyHandoff = {
  contract: "developer.quality.handoff" as const,
  version: "0.1.0",
  workPackageId: "WP-1",
  mergeRequestRef: "local/WP-1",
  intention: "ship widget",
  requirementIds: ["FR-1"],
  decisionIds: ["ADR-1"],
  verification: {
    build: { status: "skipped" as const, required: false },
    tests: { status: "passed" as const, required: true },
    lint: { status: "skipped" as const, required: false },
    packageCriteria: { status: "passed" as const, required: true },
  },
};

describe("6.2 MR context", () => {
  it("passes a valid git MR context", () => {
    const repo = tmp();
    const { baseSha, headSha, changed } = initGitWithFeature(repo);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const r = performMrReview(store, {
      context: {
        contract: "quality.mr.context",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-1",
        mergeRequestRef: "local/WP-1",
        repositoryPath: repo,
        baseBranch: "main",
        headBranch: "feat",
        baseSha,
        headSha,
        changedFiles: changed,
        requirementIds: ["FR-1"],
        decisionIds: ["ADR-1"],
      },
      handoff: readyHandoff,
    });
    expect(r.verdict).toBe("pass");
    expect(r.mrRef).toBe("local/WP-1");
    expect(store.getReview(r.reviewId)?.mr_ref).toBe("local/WP-1");
  });

  it("fails on changed-files mismatch", () => {
    const repo = tmp();
    const { baseSha, headSha } = initGitWithFeature(repo);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const r = performMrReview(store, {
      context: {
        contract: "quality.mr.context",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-1",
        mergeRequestRef: "local/WP-1",
        repositoryPath: repo,
        baseBranch: "main",
        headBranch: "feat",
        baseSha,
        headSha,
        changedFiles: ["not-a-real-file.js"],
        requirementIds: ["FR-1"],
        decisionIds: ["ADR-1"],
      },
      handoff: readyHandoff,
      rerunTests: false,
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "changed-files-mismatch" && !f.ok)).toBe(
      true,
    );
  });

  it("fails unknown head SHA without continuing as pass", () => {
    const repo = tmp();
    const { baseSha, changed } = initGitWithFeature(repo);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const r = performMrReview(store, {
      context: {
        contract: "quality.mr.context",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-1",
        mergeRequestRef: "local/WP-1",
        repositoryPath: repo,
        baseBranch: "main",
        headBranch: "feat",
        baseSha,
        headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        changedFiles: changed,
        requirementIds: ["FR-1"],
        decisionIds: ["ADR-1"],
      },
      handoff: readyHandoff,
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "mr-head-ref" && !f.ok)).toBe(true);
    expect(r.testExecution).toBeUndefined();
  });

  it("fails workPackageId mismatch", () => {
    const repo = tmp();
    const { baseSha, headSha, changed } = initGitWithFeature(repo);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const r = performMrReview(store, {
      context: {
        contract: "quality.mr.context",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-OTHER",
        mergeRequestRef: "local/WP-1",
        repositoryPath: repo,
        baseBranch: "main",
        headBranch: "feat",
        baseSha,
        headSha,
        changedFiles: changed,
        requirementIds: ["FR-1"],
        decisionIds: ["ADR-1"],
      },
      handoff: readyHandoff,
      rerunTests: false,
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "mr-workPackageId" && !f.ok)).toBe(true);
  });
});

describe("6.3 codebase audit", () => {
  it("clean audit writes JSON/MD, no blocking, persistable, byte-identical source", () => {
    const root = tmp();
    writeProduct(root, false);
    const before = snapshotTree(root);
    const db = join(tmp(), "q.sqlite");
    const store = new QualityStore(db);
    stores.push(store);
    const out = join(tmp(), "reports");
    const a = performCodebaseAudit(store, { path: root, projectId: "p", outDir: out });
    expect(a.report.verdict).toBe("pass");
    expect(a.report.summary.blocking).toBe(0);
    expect(readFileSync(join(out, `audit-${a.auditId}.json`), "utf8")).toContain(
      "quality.audit.report",
    );
    expect(readFileSync(join(out, `audit-${a.auditId}.md`), "utf8")).toContain("verdict");
    expect(snapshotTree(root)).toEqual(before);
    store.close();
    stores.pop();
    const store2 = new QualityStore(db);
    stores.push(store2);
    const row = store2.getAudit(a.auditId);
    expect(row?.report_json).toContain("quality.audit.report");
    expect(row?.report_md).toContain("Quality codebase audit");
  });

  it("failing audit counts blocking findings", () => {
    const root = tmp();
    writeProduct(root, true);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const a = performCodebaseAudit(store, { path: root, projectId: "p" });
    expect(a.report.verdict).toBe("fail");
    expect(a.report.summary.blocking).toBeGreaterThan(0);
    expect(a.report.findingsBySeverity.error).toBeGreaterThan(0);
    expect((a.report.unresolvedHighRisk as { id: string }[]).some((f) => f.id === "fixme-critical")).toBe(
      true,
    );
  });
});

describe("6.6 rollback/hotfix", () => {
  it("records rollback after pass, links hotfix, rejects bad refs, persists", () => {
    const repo = tmp();
    const { baseSha, headSha, changed } = initGitWithFeature(repo);
    const db = join(tmp(), "q.sqlite");
    const store = new QualityStore(db);
    stores.push(store);
    const review = performMrReview(store, {
      context: {
        contract: "quality.mr.context",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-1",
        mergeRequestRef: "local/WP-1",
        repositoryPath: repo,
        baseBranch: "main",
        headBranch: "feat",
        baseSha,
        headSha,
        changedFiles: changed,
        requirementIds: ["FR-1"],
        decisionIds: ["ADR-1"],
      },
      handoff: readyHandoff,
    });
    expect(review.verdict).toBe("pass");
    const beforeRate = store.metrics("p").rollbackRate;
    const rb = recordRollbackEvent(
      store,
      {
        contract: "quality.rollback.event",
        version: "0.1.0",
        projectId: "p",
        workPackageId: "WP-1",
        mergeRequestRef: "local/WP-1",
        affectedRef: headSha,
        reason: "incident",
        trigger: "ops",
        reviewId: review.reviewId,
        status: "recorded",
        evidence: "sev1",
      },
      { repo },
    );
    expect(rb.review_id).toBe(review.reviewId);
    expect(store.metrics("p").rollbackRate).toBeGreaterThan(beforeRate);
    const hf = recordHotfixEvent(
      store,
      {
        contract: "quality.hotfix.event",
        version: "0.1.0",
        projectId: "p",
        rollbackId: rb.id,
        hotfixRef: headSha,
        reason: "patch",
        verification: "pass",
      },
      { repo },
    );
    expect(hf.rollback_id).toBe(rb.id);
    expect(store.metrics("p").hotfixes).toBe(1);
    expect(() =>
      recordRollbackEvent(
        store,
        {
          contract: "quality.rollback.event",
          version: "0.1.0",
          projectId: "p",
          mergeRequestRef: "local/WP-1",
          affectedRef: headSha,
          reason: "x",
          trigger: "ops",
          reviewId: 99999,
          status: "recorded",
          evidence: "x",
        },
        { repo },
      ),
    ).toThrow(/review/);
    store.close();
    stores.pop();
    const store2 = new QualityStore(db);
    stores.push(store2);
    expect(store2.getRollback(rb.id)?.id).toBe(rb.id);
    expect(store2.listHotfixes("p")).toHaveLength(1);
  });
});

describe("6.7 returns", () => {
  it("creates qa and code-review returns, rejects bad finding, resolves on follow-up, persists", () => {
    const root = tmp();
    writeProduct(root, true);
    const db = join(tmp(), "q.sqlite");
    const store = new QualityStore(db);
    stores.push(store);
    const fail = performPathReview(store, {
      path: root,
      projectId: "p",
      handoff: { ...readyHandoff, workPackageId: "WP-1" },
      rerunTests: false,
    });
    expect(fail.verdict).toBe("fail");
    const blocking = fail.findings.filter((f) => !f.ok && f.severity === "error");
    const ids = [...new Set(blocking.map((f) => f.id))];
    const qa = createQualityReturn(store, {
      reviewId: fail.reviewId,
      source: "qa",
      blockingFindingIds: [ids[0]!],
      reason: "qa block",
    });
    expect(qa.source).toBe("qa");
    expect(qa.status).toBe("open");
    const cr = createQualityReturn(store, {
      reviewId: fail.reviewId,
      source: "code-review",
      blockingFindingIds: [ids[0]!],
      reason: "cr block",
    });
    expect(cr.source).toBe("code-review");
    expect(() =>
      createQualityReturn(store, {
        reviewId: fail.reviewId,
        source: "qa",
        blockingFindingIds: ["no-such-finding"],
        reason: "x",
      }),
    ).toThrow(/finding/);
    writeProduct(root, false);
    const pass = performPathReview(store, {
      path: root,
      projectId: "p",
      handoff: readyHandoff,
      rerunTests: false,
    });
    expect(pass.verdict).toBe("pass");
    const closed = resolveQualityReturn(store, {
      returnId: qa.id,
      followUpReviewId: pass.reviewId,
    });
    expect(closed.status).toBe("resolved");
    expect(closed.followup_review_id).toBe(pass.reviewId);
    expect(store.metrics("p").returnRate).toBeGreaterThan(0);
    store.close();
    stores.pop();
    const store2 = new QualityStore(db);
    stores.push(store2);
    expect(store2.getReturn(qa.id)?.status).toBe("resolved");
  });
});

describe("6.8 repeated findings", () => {
  it("thresholds, dedupe, reject suppression, accept lifecycle", () => {
    expect(REPEATED_FINDING_THRESHOLD).toBe(3);
    const root = tmp();
    writeProduct(root, true);
    const store = new QualityStore(":memory:");
    stores.push(store);
    const ks = join(tmp(), "findings.json");
    const run = () =>
      performPathReview(store, {
        path: root,
        projectId: "p",
        rerunTests: false,
      });
    run();
    let out = analyzeRepeatedFindings(store, { projectId: "p", knowledgeStorePath: ks });
    expect(out.proposals).toHaveLength(0);
    run();
    out = analyzeRepeatedFindings(store, { projectId: "p", knowledgeStorePath: ks });
    expect(out.proposals).toHaveLength(0);
    run();
    out = analyzeRepeatedFindings(store, { projectId: "p", knowledgeStorePath: ks });
    expect(out.proposals).toHaveLength(1);
    const prop = out.proposals[0] as { fingerprint: string; status: string; binding: boolean; sourceIds: string[]; proposedRuleId: string };
    expect(prop.status).toBe("proposed");
    expect(prop.binding).toBe(false);
    expect(prop.sourceIds.length).toBeGreaterThanOrEqual(3);
    run();
    const again = analyzeRepeatedFindings(store, { projectId: "p", knowledgeStorePath: ks });
    expect(again.proposals).toHaveLength(0);
    knowledgeRejectByRuleId(ks, prop.proposedRuleId, "not a norm");
    const afterReject = analyzeRepeatedFindings(store, {
      projectId: "p",
      knowledgeStorePath: ks,
    });
    expect(afterReject.proposals).toHaveLength(0);

    const storeB = new QualityStore(":memory:");
    stores.push(storeB);
    const root2 = tmp();
    writeProduct(root2, true);
    const ks2 = join(tmp(), "findings2.json");
    for (let i = 0; i < 3; i += 1) {
      performPathReview(storeB, { path: root2, projectId: "p2", rerunTests: false });
    }
    const proposed = analyzeRepeatedFindings(storeB, {
      projectId: "p2",
      knowledgeStorePath: ks2,
    });
    const rule = (proposed.proposals[0] as { proposedRuleId: string }).proposedRuleId;
    knowledgeAcceptByRuleId(ks2, rule);
    const saved = JSON.parse(readFileSync(ks2, "utf8")) as {
      proposals: { status: string }[];
    };
    expect(saved.proposals.some((p) => p.status === "accepted")).toBe(true);
  });
});
