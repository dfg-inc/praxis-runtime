import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQualityApp } from "../src/server.js";
import { QualityStore } from "../src/store.js";
import type { AddressInfo } from "node:net";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "q-http-"));
}

function write(root: string, rel: string, body: string) {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, body);
}

const readyHandoff = {
  contract: "developer.quality.handoff",
  version: "0.1.0",
  workPackageId: "WP-HTTP-1",
  mergeRequestRef: "local/WP-HTTP-1",
  intention: "ship feature",
  requirementIds: ["E1-FR1"],
  decisionIds: ["ADR-1"],
  verification: {
    build: { status: "skipped", required: false },
    tests: { status: "passed", required: true },
    lint: { status: "skipped", required: false },
    packageCriteria: { status: "passed", required: true },
  },
  acceptanceChecks: [
    { file: "src/widget.js", contains: "export function scale" },
  ],
};

async function withServer(
  store: QualityStore,
  fn: (base: string) => Promise<void>,
) {
  const server = createQualityApp(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

describe("HTTP path reviews", () => {
  const dirs: string[] = [];
  const stores: QualityStore[] = [];
  afterEach(() => {
    delete process.env.PRAXIS_QUALITY_ALLOWED_ROOT;
    while (stores.length) stores.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function makeProduct(allowedRoot: string): string {
    const product = join(allowedRoot, "product");
    mkdirSync(product, { recursive: true });
    write(
      product,
      "package.json",
      JSON.stringify({
        name: "http-demo",
        type: "module",
        scripts: { test: "node --test src/*.test.js" },
      }),
    );
    write(
      product,
      "src/widget.js",
      "export function scale(v, f = 2) { return v * f; }\n",
    );
    write(
      product,
      "src/widget.test.js",
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { scale } from './widget.js';
test('scale', () => assert.equal(scale(5), 10));
`,
    );
    return product;
  }

  it("POST /reviews/path + GET /reviews/:id + restart persistence", async () => {
    const allowed = tmp();
    dirs.push(allowed);
    const dbPath = join(allowed, "q.sqlite");
    const product = makeProduct(allowed);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowed;

    const store = new QualityStore(dbPath);
    stores.push(store);

    let reviewId = 0;
    await withServer(store, async (base) => {
      const res = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "http-proj",
          path: product,
          handoff: readyHandoff,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        reviewId: number;
        projectId: string;
        workPackageId: string;
        verdict: string;
        findings: unknown[];
      };
      expect(body.reviewId).toBeGreaterThan(0);
      expect(body.projectId).toBe("http-proj");
      expect(body.workPackageId).toBe("WP-HTTP-1");
      expect(body.verdict).toBe("pass");
      expect(Array.isArray(body.findings)).toBe(true);
      reviewId = body.reviewId;

      const got = await fetch(`${base}/reviews/${reviewId}`);
      expect(got.status).toBe(200);
      const again = (await got.json()) as { reviewId: number; verdict: string };
      expect(again.reviewId).toBe(reviewId);
      expect(again.verdict).toBe("pass");

      const metrics = await fetch(`${base}/metrics?project=http-proj`);
      const m = (await metrics.json()) as { reviews: number; audits: number };
      expect(m.reviews).toBeGreaterThanOrEqual(1);
      expect(m.audits).toBeGreaterThanOrEqual(1);
    });

    store.close();
    stores.pop();

    // Survive store recreation (same DB file)
    const store2 = new QualityStore(dbPath);
    stores.push(store2);
    await withServer(store2, async (base) => {
      const got = await fetch(`${base}/reviews/${reviewId}`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as {
        reviewId: number;
        workPackageId?: string;
      };
      expect(body.reviewId).toBe(reviewId);
      expect(body.workPackageId).toBe("WP-HTTP-1");
    });
  });

  it("rejects wrong contract / missing workPackageId / failed verification", async () => {
    const allowed = tmp();
    dirs.push(allowed);
    const product = makeProduct(allowed);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowed;
    const store = new QualityStore(":memory:");
    stores.push(store);

    await withServer(store, async (base) => {
      const wrong = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: product,
          handoff: { ...readyHandoff, contract: "nope" },
        }),
      });
      expect(wrong.status).toBe(400);

      const missingWp = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: product,
          handoff: { ...readyHandoff, workPackageId: undefined },
        }),
      });
      expect(missingWp.status).toBe(400);

      const badVer = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: product,
          handoff: {
            ...readyHandoff,
            verification: {
              ...readyHandoff.verification,
              tests: { status: "failed", required: true },
            },
          },
        }),
      });
      expect(badVer.status).toBe(400);
    });
  });

  it("acceptance failure → 200 with verdict fail", async () => {
    const allowed = tmp();
    dirs.push(allowed);
    const product = makeProduct(allowed);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowed;
    const store = new QualityStore(":memory:");
    stores.push(store);

    await withServer(store, async (base) => {
      const res = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: product,
          handoff: {
            ...readyHandoff,
            acceptanceChecks: [
              { file: "src/widget.js", contains: "THIS_STRING_ABSENT" },
            ],
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { verdict: string };
      expect(body.verdict).toBe("fail");
    });
  });

  it("rejects path outside allowed root and traversal", async () => {
    const allowed = tmp();
    const outside = tmp();
    dirs.push(allowed, outside);
    makeProduct(allowed);
    const outsideProduct = makeProduct(outside);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowed;
    const store = new QualityStore(":memory:");
    stores.push(store);

    await withServer(store, async (base) => {
      const out = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: outsideProduct,
          handoff: readyHandoff,
        }),
      });
      expect(out.status).toBe(400);
      const body = (await out.json()) as { error: string };
      expect(body.error).toMatch(/path_outside|allowed/i);

      const trav = await fetch(`${base}/reviews/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p",
          path: join(allowed, "..", "..", "etc"),
          handoff: readyHandoff,
        }),
      });
      expect(trav.status).toBe(400);
    });
  });

  it("GET /reviews/:id → 404 for unknown", async () => {
    const store = new QualityStore(":memory:");
    stores.push(store);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = tmp();
    dirs.push(process.env.PRAXIS_QUALITY_ALLOWED_ROOT);
    await withServer(store, async (base) => {
      const res = await fetch(`${base}/reviews/99999`);
      expect(res.status).toBe(404);
    });
  });

  it("POST /reviews/work-package persists SQLite review without Jira", async () => {
    const allowed = tmp();
    dirs.push(allowed);
    process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowed;
    const product = join(allowed, "product");
    mkdirSync(product, { recursive: true });
    write(
      product,
      "package.json",
      JSON.stringify({ name: "p", type: "module", scripts: { test: "node --test src/*.test.js" } }),
    );
    write(product, ".project", "stack: [node]\nquality:\n  test: npm test\n");
    write(product, "src/widget.js", "export function scale(n){ return n*2; }\n");
    write(
      product,
      "src/widget.test.js",
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { scale } from './widget.js'; test('scale', () => assert.equal(scale(5), 10));\n",
    );
    write(
      product,
      "work-packages/WP-HTTP-WP/manifest.json",
      JSON.stringify({
        id: "WP-HTTP-WP",
        jiraIssueKey: "PRX-4",
        storyKeys: ["PRX-3"],
        readyForQuality: true,
      }),
    );
    write(
      product,
      "design/WP-HTTP-WP/change-spec.json",
      JSON.stringify({
        workPackageId: "WP-HTTP-WP",
        requirementIds: ["E2-FR1"],
        acceptanceChecks: [
          { type: "contains", file: "src/widget.js", expected: "export function scale" },
          { type: "npm-test" },
        ],
      }),
    );
    write(
      product,
      "design/WP-HTTP-WP/architect-developer.handoff.json",
      JSON.stringify({ workPackageId: "WP-HTTP-WP" }),
    );
    write(
      product,
      "design/WP-HTTP-WP/dev/completion-evidence.json",
      JSON.stringify({
        workPackageId: "WP-HTTP-WP",
        jiraWorkPackageKey: "PRX-4",
        canonicalStoryKeys: ["PRX-3"],
        readyForQuality: true,
      }),
    );
    write(
      product,
      "design/WP-HTTP-WP/dev/quality-handoff.json",
      JSON.stringify({
        workPackageId: "WP-HTTP-WP",
        jiraWorkPackageKey: "PRX-4",
        canonicalStoryKeys: ["PRX-3"],
        requirementIds: ["E2-FR1"],
      }),
    );
    const store = new QualityStore(":memory:");
    stores.push(store);
    await withServer(store, async (base) => {
      const res = await fetch(`${base}/reviews/work-package`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "WP-HTTP-WP",
          workPackageId: "WP-HTTP-WP",
          path: product,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        reviewId: number;
        verdict: string;
        jiraMutated: boolean;
        acceptanceChecks: Array<{ status: string }>;
      };
      expect(body.reviewId).toBeGreaterThan(0);
      expect(body.verdict).toBe("PASSED");
      expect(body.jiraMutated).toBe(false);
      expect(body.acceptanceChecks.every((c) => c.status === "PASSED")).toBe(true);
      const got = await fetch(`${base}/reviews/${body.reviewId}`);
      const again = (await got.json()) as { workPackageId?: string; verdict: string };
      expect(again.workPackageId).toBe("WP-HTTP-WP");
      expect(again.verdict).toBe("PASSED");
    });
  });
});
