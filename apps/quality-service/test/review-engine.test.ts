import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverTestFiles,
  parseNodeTestCounts,
  reviewPath,
} from "../src/review-engine.js";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "q-disc-"));
}

function write(root: string, rel: string, body: string) {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, body);
}

const readyHandoff = {
  contract: "developer.quality.handoff" as const,
  version: "0.1.0",
  workPackageId: "WP-1",
  mergeRequestRef: "local/WP-1",
  intention: "ship",
  requirementIds: ["E1-FR1"],
  decisionIds: ["ADR-1"],
  verification: {
    build: { status: "skipped" as const, required: false },
    tests: { status: "passed" as const, required: true },
    lint: { status: "skipped" as const, required: false },
    packageCriteria: { status: "passed" as const, required: true },
  },
};

describe("test discovery", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("discovers src/foo.test.js", () => {
    const root = tmpProject();
    dirs.push(root);
    write(root, "src/foo.test.js", "import test from 'node:test';\n");
    write(root, "src/foo.js", "export const x = 1;\n");
    const found = discoverTestFiles(root).map((p) => p.replace(/\\/g, "/"));
    expect(found.some((p) => p.endsWith("src/foo.test.js"))).toBe(true);
  });

  it("discovers src/foo.spec.js", () => {
    const root = tmpProject();
    dirs.push(root);
    write(root, "src/foo.spec.js", "export {};\n");
    expect(
      discoverTestFiles(root).some((p) => p.endsWith("src/foo.spec.js")),
    ).toBe(true);
  });

  it("discovers test/foo.test.js", () => {
    const root = tmpProject();
    dirs.push(root);
    write(root, "test/foo.test.js", "export {};\n");
    expect(
      discoverTestFiles(root).some((p) => p.endsWith("test/foo.test.js")),
    ).toBe(true);
  });

  it("discovers tests/foo.test.js", () => {
    const root = tmpProject();
    dirs.push(root);
    write(root, "tests/foo.test.js", "export {};\n");
    expect(
      discoverTestFiles(root).some((p) => p.endsWith("tests/foo.test.js")),
    ).toBe(true);
  });

  it("discovers __tests__/foo.test.js", () => {
    const root = tmpProject();
    dirs.push(root);
    write(root, "__tests__/foo.test.js", "export {};\n");
    expect(
      discoverTestFiles(root).some((p) => p.includes("__tests__/foo.test.js")),
    ).toBe(true);
  });
});

describe("parseNodeTestCounts", () => {
  it("parses node:test summary", () => {
    const out = `ℹ tests 4\nℹ pass 4\nℹ fail 0\n`;
    expect(parseNodeTestCounts(out)).toEqual({
      executedCount: 4,
      passedCount: 4,
      failedCount: 0,
    });
  });
});

describe("reviewPath execution semantics", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("passes when colocated src tests execute (required)", () => {
    const root = tmpProject();
    dirs.push(root);
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "t",
        type: "module",
        scripts: { test: "node --test src/*.test.js" },
      }),
    );
    write(
      root,
      "src/counter.js",
      "export function decrement(v){ return v-1; }\nexport function increment(v){ return v+1; }\n",
    );
    write(
      root,
      "src/counter.test.js",
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { decrement, increment } from './counter.js';
test('d5', () => assert.equal(decrement(5), 4));
test('d0', () => assert.equal(decrement(0), -1));
test('i', () => assert.equal(increment(1), 2));
test('ib', () => assert.equal(increment(0), 1));
`,
    );
    const r = reviewPath({
      path: root,
      handoff: readyHandoff,
      rerunTests: true,
    });
    expect(r.findings.find((f) => f.id === "has-tests")?.ok).toBe(true);
    expect(r.findings.find((f) => f.id === "rerun-tests")?.ok).toBe(true);
    expect(r.testExecution?.executedCount).toBe(4);
    expect(r.verdict).toBe("pass");
  });

  it("fails when npm test exits 0 but executes zero tests (required)", () => {
    const root = tmpProject();
    dirs.push(root);
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "t",
        type: "module",
        scripts: { test: "node -e \"process.exit(0)\"" },
      }),
    );
    write(root, "src/a.js", "export {};\n");
    const r = reviewPath({
      path: root,
      handoff: readyHandoff,
      rerunTests: true,
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "rerun-tests" && !f.ok)).toBe(true);
  });

  it("fails when test command fails", () => {
    const root = tmpProject();
    dirs.push(root);
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "t",
        type: "module",
        scripts: { test: "node --test src/*.test.js" },
      }),
    );
    write(root, "src/a.js", "export const x = 1;\n");
    write(
      root,
      "src/a.test.js",
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('fail', () => assert.equal(1, 2));
`,
    );
    const r = reviewPath({
      path: root,
      handoff: readyHandoff,
      rerunTests: true,
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.id === "rerun-tests" && !f.ok)).toBe(true);
  });

  it("fails when Developer claimed passed but Quality rerun fails", () => {
    const root = tmpProject();
    dirs.push(root);
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "t",
        type: "module",
        scripts: { test: "node --test src/*.test.js" },
      }),
    );
    write(root, "src/a.js", "export {};\n");
    write(
      root,
      "src/a.test.js",
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('x', () => assert.equal(0, 1));
`,
    );
    const r = reviewPath({
      path: root,
      handoff: readyHandoff,
      rerunTests: true,
    });
    const rerun = r.findings.find((f) => f.id === "rerun-tests");
    expect(rerun?.ok).toBe(false);
    expect(rerun?.detail).toMatch(/claimed tests passed/i);
  });
});
