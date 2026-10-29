import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import { containedPath } from "./path-guard.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
});

/** A repository with a real file, a directory, and everything an attacker could use to point outside it. */
function lab() {
  const outside = mkdtempSync(join(tmpdir(), "praxis-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE");
  mkdirSync(join(outside, "dir"));
  writeFileSync(join(outside, "dir", "deep.txt"), "DEEP-OUTSIDE");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "praxis-guard-")));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "ok.ts"), "export const ok = 1;\n");
  mkdirSync(join(repo, "sub", "deeper"), { recursive: true });
  symlinkSync(join(outside, "secret.txt"), join(repo, "link-file.ts")); // a file link out
  symlinkSync(outside, join(repo, "link-dir")); // a directory link out
  symlinkSync(join(outside, "dir"), join(repo, "sub", "deeper", "inner-link")); // a nested one
  symlinkSync(join(repo, "does-not-exist"), join(repo, "dangling.ts")); // a dangling one
  symlinkSync("link-file.ts", join(repo, "chain.ts")); // a link to a link that leaves
  symlinkSync(join(repo, "src", "ok.ts"), join(repo, "inside-link.ts")); // a link that stays inside
  symlinkSync(join(repo, ".."), join(repo, "parent-link")); // a link to the parent of the repository
  return { repo, outside };
}

describe("containedPath: the check is on the real path", () => {
  it("accepts files and not-yet-existing files inside the repository, and links that stay inside", () => {
    const { repo } = lab();
    expect(containedPath(repo, "src/ok.ts")).toBe(join(repo, "src", "ok.ts"));
    expect(containedPath(repo, "src/new/file.ts")).toBe(join(repo, "src", "new", "file.ts")); // a file about to be written
    expect(containedPath(repo, "inside-link.ts")).toBe(join(repo, "src", "ok.ts"));
  });

  it("refuses links that leave the repository, however they are reached", () => {
    const { repo } = lab();
    for (const path of ["link-file.ts", "link-dir/secret.txt", "link-dir/dir/deep.txt", "sub/deeper/inner-link/deep.txt", "dangling.ts", "chain.ts", "parent-link/x", "link-dir/new-file.txt", "link-dir"]) {
      expect(() => containedPath(repo, path), path).toThrow("UNSAFE_PATH");
    }
  });

  it("refuses absolute paths, parent segments, NUL, empty and non-string input", () => {
    const { repo, outside } = lab();
    for (const path of [join(outside, "secret.txt"), "/etc/passwd", "../x", "src/../../x", "src/..\\..\\x", "a\0b", "", undefined, 5, {}]) {
      expect(() => containedPath(repo, path as never), String(path)).toThrow("UNSAFE_PATH");
    }
  });

  it("a repository that is itself reached through a link is judged by its real location", () => {
    const { repo } = lab();
    const alias = join(mkdtempSync(join(tmpdir(), "praxis-alias-")), "repo-alias");
    symlinkSync(repo, alias);
    expect(containedPath(alias, "src/ok.ts")).toBe(join(repo, "src", "ok.ts"));
    expect(() => containedPath(alias, "link-file.ts")).toThrow("UNSAFE_PATH");
  });
});

describe("praxis_workflow_preview: an implementation path cannot read outside the repository", () => {
  const call = async (repo: string, args: Record<string, unknown>) => (await callTool("praxis_workflow_preview", { repo, ...args }, { role: "quality", version: "test" })) as McpEnvelope;
  const apply = async (repo: string, command: object) => {
    const p = await call(repo, { command: JSON.stringify(command) });
    expect(p.ok, JSON.stringify(p.errors)).toBe(true);
    return (await callTool("praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint }, { role: "quality", version: "test" })) as McpEnvelope;
  };

  async function withRequirement() {
    const l = lab();
    expect((await apply(l.repo, { action: "open", projectId: "p", title: "Guard", request: "r", mode: "guided" })).ok).toBe(true);
    expect((await apply(l.repo, { action: "add-requirement", id: "REQ-G-001", statement: "S", acceptanceCriteria: ["a"] })).ok).toBe(true);
    return l;
  }
  const check = (path: string) => ({ action: "quality-check", requirementId: "REQ-G-001", implementationPath: path, serviceId: "svc" });

  it("a normal file is read; links out, absolute paths, directories and oversized files are refused with INVALID_INPUT", async () => {
    const { repo } = await withRequirement();
    const good = await call(repo, { command: JSON.stringify(check("src/ok.ts")) });
    expect(good.code).not.toBe("INVALID_INPUT");
    expect(JSON.stringify(good)).not.toMatch(/escapes the repository|regular file/);
    writeFileSync(join(repo, "big.ts"), "x".repeat(2 * 1024 * 1024 + 10));
    for (const path of ["link-file.ts", "link-dir/secret.txt", "sub/deeper/inner-link/deep.txt", "dangling.ts", "chain.ts", "/etc/passwd", "../outside.ts", "src", "big.ts"]) {
      const res = await call(repo, { command: JSON.stringify(check(path)) });
      expect(res.ok, path).toBe(false);
      expect(res.code, path).toBe("INVALID_INPUT");
      expect(JSON.stringify(res), path).not.toMatch(/TOP-SECRET-OUTSIDE|DEEP-OUTSIDE/);
    }
  });

  it("a FIFO inside the repository is not a regular file and is refused without being opened", async () => {
    const { repo } = await withRequirement();
    execFileSync("mkfifo", [join(repo, "pipe.ts")]);
    const res = await call(repo, { command: JSON.stringify(check("pipe.ts")) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
  });
});
