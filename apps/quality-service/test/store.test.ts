import { describe, expect, it, afterEach } from "vitest";
import { QualityStore, runCli } from "../src/index.js";

describe("QualityStore", () => {
  const stores: QualityStore[] = [];
  afterEach(() => {
    while (stores.length) stores.pop()!.close();
  });

  function mem(): QualityStore {
    const s = new QualityStore(":memory:");
    stores.push(s);
    return s;
  }

  it("persists reviews and audits", () => {
    const store = mem();
    store.addReview({ mrRef: "!1", projectId: "p1", result: "pass" });
    store.addAudit({
      path: "/repo",
      projectId: "p1",
      findings: JSON.stringify([{ rule: "lint", ok: true }]),
    });
    const report = store.report("p1");
    expect(report.reviews).toHaveLength(1);
    expect(report.audits).toHaveLength(1);
  });

  it("counts rollback only within 7 days after merge", () => {
    const store = mem();
    const merge = "2026-08-01T00:00:00.000Z";
    store.addReview({
      mrRef: "!1",
      projectId: "p1",
      result: "pass",
      mergedAt: merge,
    });
    store.addReview({
      mrRef: "!2",
      projectId: "p1",
      result: "pass",
      mergedAt: merge,
    });
    // within window
    store.addRollback({
      projectId: "p1",
      mrRef: "!1",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    // outside window (8 days)
    store.addRollback({
      projectId: "p1",
      mrRef: "!2",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    const m = store.metrics("p1");
    expect(m.reviews).toBe(2);
    expect(m.rollbacks).toBe(2);
    expect(m.rollbacksWithinWindow).toBe(1);
    expect(m.rollbackRate).toBe(0.5);
    expect(m.windowDays).toBe(7);
  });

  it("returnRate uses distinct tasks as denominator", () => {
    const store = mem();
    store.addTaskCompletion({ projectId: "p1", taskRef: "T-1" });
    store.addTaskCompletion({ projectId: "p1", taskRef: "T-2" });
    store.addTaskCompletion({ projectId: "p1", taskRef: "T-3" });
    store.addReturn({ projectId: "p1", taskRef: "T-1", source: "qa" });
    const m = store.metrics("p1");
    expect(m.tasksObserved).toBe(3);
    expect(m.returnRate).toBeCloseTo(1 / 3);
  });

  it("cli review and metrics", () => {
    const store = mem();
    const r = runCli(
      ["node", "praxis-quality", "review", "--mr", "!9", "--project", "p2"],
      store,
    );
    expect(r.ok).toBe(true);
    const m = runCli(
      ["node", "praxis-quality", "metrics", "--project", "p2"],
      store,
    );
    expect(m.ok).toBe(true);
    expect((m.output as { reviews: number }).reviews).toBe(1);
  });
});

describe("review-path engine", () => {
  it("fails when verification flags are false", async () => {
    const { reviewPath } = await import("../src/review-engine.js");
    const { groupFindingsByFingerprint } = await import("../src/fingerprint.js");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "q-rev-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "src", "a.js"), "export const x = 1;\n");
    writeFileSync(join(dir, "test", "a.test.js"), "export {};\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "t",
        type: "module",
        scripts: { test: "node -e \"process.exit(1)\"" },
      }),
    );
    const r = reviewPath({
      path: dir,
      rerunTests: false,
      handoff: {
        contract: "developer.quality.handoff",
        workPackageId: "WP-TEST-001",
        mergeRequestRef: "local/x",
        intention: "fix",
        requirementIds: ["E1-FR1"],
        decisionIds: ["ADR-1"],
        verification: {
          build: { status: "passed", required: false },
          tests: { status: "failed", required: true },
          lint: { status: "passed", required: false },
          packageCriteria: { status: "failed", required: true },
        },
      },
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "verification.tests" && !f.ok)).toBe(
      true,
    );
    const groups = groupFindingsByFingerprint(r.findings);
    expect(groups.length).toBeGreaterThan(0);
  });
});
