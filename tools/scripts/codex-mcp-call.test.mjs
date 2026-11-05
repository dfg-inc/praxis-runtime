import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractZip } from "./claude-zip.mjs";

test("bridge discovers the shipped runtime and refuses protected writes, including inherited bypasses", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-codex-bridge-"));
  try {
    extractZip(readFileSync(new URL("../../claude-extensions/praxis-runtime.mcpb", import.meta.url)), join(root, "runtime"));
    const runtime = join(root, "runtime/server/praxis-mcp.cjs");
    const run = (tool, args = {}, env = {}) => spawnSync(process.execPath, [fileURLToPath(new URL("./codex-mcp-call.mjs", import.meta.url)), "--runtime", runtime], {
      input: JSON.stringify({ repo: root, tool, arguments: args }), encoding: "utf8", timeout: 15000,
      env: { ...process.env, ...env },
    });
    const doctor = run("praxis_doctor");
    assert.equal(doctor.status, 0, doctor.stderr);
    const result = JSON.parse(doctor.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.data.build.kind, "production");
    assert.equal(result.data.approval.mode, "no-dialog");

    const preview = run("praxis_project_init_preview");
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).ok, true);
    assert.equal(existsSync(join(root, ".project")), false);

    const denied = run("praxis_project_init_apply", { confirmation: "YES" }, {
      PRAXIS_APPROVAL_MODE: "trusted-client", PRAXIS_TEST_APPROVALS: "1",
    });
    assert.equal(denied.status, 1, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).code, "APPROVAL_CLIENT_UI_REQUIRED");
    assert.equal(existsSync(join(root, ".project")), false);

    const conflict = run("praxis_project_init_apply", { confirmation: "YES", repo: "/different/repository" });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /conflicting repositories/);
    assert.equal(existsSync(join(root, ".project")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
