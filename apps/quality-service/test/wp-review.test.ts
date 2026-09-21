import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewWorkPackage, WorkPackageReviewError } from "../src/wp-review.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "q-wp-"));
}

function write(root: string, rel: string, body: string) {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, body);
}

function seedPassing(root: string) {
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "counter",
      type: "module",
      scripts: { test: "node --test src/*.test.js" },
    }),
  );
  write(root, ".project", "stack: [node]\nquality:\n  test: npm test\n");
  write(
    root,
    "src/counter.js",
    "export function reset() {\n  return 0;\n}\nexport function inc(n){ return n+1; }\n",
  );
  write(
    root,
    "src/counter.test.js",
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, inc } from './counter.js';
test('reset() returns 0', () => assert.equal(reset(), 0));
test('inc 1', () => assert.equal(inc(1), 2));
test('inc 0', () => assert.equal(inc(0), 1));
test('inc 2', () => assert.equal(inc(2), 3));
test('reset again', () => assert.equal(reset(), 0));
`,
  );
  write(
    root,
    "work-packages/WP-20260914-002/manifest.json",
    JSON.stringify({
      id: "WP-20260914-002",
      jiraIssueKey: "PRX-4",
      storyKeys: ["PRX-3"],
      readyForQuality: true,
      qualityState: "pending",
    }),
  );
  write(
    root,
    "design/WP-20260914-002/change-spec.json",
    JSON.stringify({
      workPackageId: "WP-20260914-002",
      requirementIds: ["E2-FR1"],
      features: [{ id: "FEAT-RESET-IMPL" }, { id: "FEAT-RESET-TESTS" }],
      changes: [{ file: "src/counter.js" }, { file: "src/counter.test.js" }],
      acceptanceChecks: [
        { type: "contains", file: "src/counter.js", expected: "export function reset() {" },
        { type: "contains", file: "src/counter.js", expected: "return 0;" },
        { type: "contains", file: "src/counter.test.js", expected: "reset() returns 0" },
        { type: "npm-test", command: "npm test" },
      ],
    }),
  );
  write(
    root,
    "design/WP-20260914-002/architect-developer.handoff.json",
    JSON.stringify({ contract: "architect.developer.handoff", workPackageId: "WP-20260914-002" }),
  );
  write(
    root,
    "design/WP-20260914-002/dev/completion-evidence.json",
    JSON.stringify({
      contract: "developer.completion.evidence",
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: "PRX-4",
      canonicalStoryKeys: ["PRX-3"],
      requirementIds: ["E2-FR1"],
      readyForQuality: true,
    }),
  );
  write(
    root,
    "design/WP-20260914-002/dev/quality-handoff.json",
    JSON.stringify({
      contract: "developer.quality.handoff",
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: "PRX-4",
      canonicalStoryKeys: ["PRX-3"],
      requirementIds: ["E2-FR1"],
      acceptanceChecks: [
        { type: "contains", file: "src/counter.js", expected: "export function reset() {" },
        { type: "contains", file: "src/counter.js", expected: "return 0;" },
        { type: "contains", file: "src/counter.test.js", expected: "reset() returns 0" },
        { type: "npm-test", command: "npm test" },
      ],
    }),
  );
}

describe("reviewWorkPackage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("passes four acceptance checks and own npm test counts", () => {
    const root = tmp();
    dirs.push(root);
    seedPassing(root);
    const r = reviewWorkPackage({ repo: root, workPackageId: "WP-20260914-002" });
    expect(r.verdict).toBe("PASSED");
    expect(r.jiraWorkPackageKey).toBe("PRX-4");
    expect(r.canonicalStoryKeys).toEqual(["PRX-3"]);
    expect(r.requirementIds).toEqual(["E2-FR1"]);
    expect(r.acceptanceChecks.map((c) => c.status)).toEqual(["PASSED", "PASSED", "PASSED", "PASSED"]);
    expect(r.verification?.exitCode).toBe(0);
    expect(r.verification?.total).toBe(5);
    expect(r.verification?.passed).toBe(5);
    expect(r.verification?.failed).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.jiraMutated).toBe(false);
    expect(r.approvalApplied).toBe(false);
    expect(r.developerEvidence.hasCompletionEvidence).toBe(true);
  });

  it("fails missing expected string", () => {
    const root = tmp();
    dirs.push(root);
    seedPassing(root);
    write(root, "src/counter.js", "export function inc(n){ return n+1; }\n");
    const r = reviewWorkPackage({ repo: root, workPackageId: "WP-20260914-002" });
    expect(r.verdict).toBe("FAILED");
    expect(r.acceptanceChecks[0]?.status).toBe("FAILED");
  });

  it("blocks unsupported check type", () => {
    const root = tmp();
    dirs.push(root);
    seedPassing(root);
    write(
      root,
      "design/WP-20260914-002/change-spec.json",
      JSON.stringify({
        workPackageId: "WP-20260914-002",
        requirementIds: ["E2-FR1"],
        acceptanceChecks: [{ type: "screenshot", file: "shot.png" }],
      }),
    );
    const r = reviewWorkPackage({ repo: root, workPackageId: "WP-20260914-002" });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.acceptanceChecks[0]?.status).toBe("BLOCKED");
  });

  it("throws on malformed change-spec", () => {
    const root = tmp();
    dirs.push(root);
    seedPassing(root);
    write(root, "design/WP-20260914-002/change-spec.json", "{not-json");
    expect(() => reviewWorkPackage({ repo: root, workPackageId: "WP-20260914-002" })).toThrow(
      WorkPackageReviewError,
    );
  });

  it("blocks missing developer evidence", () => {
    const root = tmp();
    dirs.push(root);
    seedPassing(root);
    rmSync(join(root, "design/WP-20260914-002/dev"), { recursive: true, force: true });
    const r = reviewWorkPackage({ repo: root, workPackageId: "WP-20260914-002" });
    expect(r.verdict).toBe("BLOCKED");
  });
});
