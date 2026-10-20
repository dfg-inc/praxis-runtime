import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { adopt, BLOCK_BEGIN, BLOCK_END, scan } from "./praxis-state-policy.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "praxis-policy-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function put(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

const ignored = (root, path) => spawnSync("git", ["check-ignore", "-q", path], { cwd: root }).status === 0;

describe("gitignore block", () => {
  it("tracks work items and quality checks and ignores everything private, transient or per-operator", () => {
    const root = repo();
    adopt(root);
    for (const path of [
      ".praxis/workflow/items/WI-A-001.json",
      ".praxis/quality/checks.json",
      ".praxis/quality/WI-A-001/checks.json",
      ".praxis/quality/adapter.mjs",
      ".praxis/quality/proposals/svc.json",
    ]) {
      put(root, path, "{}");
      expect(ignored(root, path), `${path} must be tracked`).toBe(false);
    }
    for (const path of [
      ".praxis/workflow/index.json",
      ".praxis/workflow/state.json",
      ".praxis/workflow/.lock/owner",
      ".praxis/workflow/items/WI-A-001.json.123.tmp",
      ".praxis/workflow/last-verification.json",
      ".praxis/approvals/plan-1.json",
      ".praxis/local/session.json",
      ".praxis/approval.ledger",
      ".praxis/keys/private.pem",
      ".praxis/keys/signing.key",
      ".praxis/quality/run.log",
    ]) {
      put(root, path, "x");
      expect(ignored(root, path), `${path} must be ignored`).toBe(true);
    }
  });

  it("is idempotent, preserves existing rules, and refreshes an outdated block in place", () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
    expect(adopt(root).changed).toBe(true);
    const once = readFileSync(join(root, ".gitignore"), "utf8");
    expect(adopt(root).changed).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(once);
    expect(once.startsWith("node_modules/\n.env\n")).toBe(true);
    writeFileSync(join(root, ".gitignore"), once.replace(".praxis/approvals/", ".praxis/OLD/") + "\nafter-block\n");
    expect(adopt(root).changed).toBe(true);
    const refreshed = readFileSync(join(root, ".gitignore"), "utf8");
    expect(refreshed).toContain(".praxis/approvals/");
    expect(refreshed).not.toContain(".praxis/OLD/");
    expect(refreshed).toContain("after-block");
    expect(refreshed.split(BLOCK_BEGIN)).toHaveLength(2);
    expect(refreshed.split(BLOCK_END)).toHaveLength(2);
  });
});

describe("scan", () => {
  it("passes clean portable state", () => {
    const root = repo();
    put(root, ".praxis/workflow/items/WI-A-001.json", JSON.stringify({ services: [{ localPath: "../praxis-runtime" }] }));
    put(root, ".praxis/quality/checks.json", JSON.stringify({ checks: [{ module: "dist/x.js" }] }));
    expect(scan(root)).toMatchObject({ ok: true, files: 2, hits: [] });
  });

  it("finds absolute home paths and credentials, reporting kind and place but never the value", () => {
    const root = repo();
    const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
    put(root, ".praxis/workflow/items/WI-A-001.json", `{\n "localPath": "/Users/someone/work/x",\n "note": "${secret}"\n}`);
    put(root, ".praxis/quality/adapter.mjs", "// -----BEGIN RSA PRIVATE KEY-----\n");
    const result = scan(root);
    expect(result.ok).toBe(false);
    expect(result.hits.map((hit) => hit.kind).sort()).toEqual(["absolute-home-path", "github-token", "private-key"]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("someone");
    const cli = spawnSync(process.execPath, [new URL("./praxis-state-policy.mjs", import.meta.url).pathname, "scan", `--repo=${root}`], { encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/FAIL github-token\s+\.praxis\/workflow\/items\/WI-A-001\.json:3/);
    expect(cli.stderr + cli.stdout).not.toContain(secret);
  });

  it("does not scan ignored or transient files", () => {
    const root = repo();
    put(root, ".praxis/workflow/index.json", '{"p":"/Users/someone/x"}');
    put(root, ".praxis/quality/run.log", "Bearer abcdefghijklmnopqrstuvwxyz0123456789");
    put(root, ".praxis/approvals/p.json", '{"signature":"' + "A".repeat(60) + '"}');
    expect(scan(root)).toMatchObject({ ok: true, files: 0 });
  });
});
