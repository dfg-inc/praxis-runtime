import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/**
 * Through the real tool entry point: a repository .env (a file the agent can write) cannot turn a protected action into one
 * that runs without the user, whatever it contains.
 */
const KEYS = ["PRAXIS_APPROVAL_MODE", "PRAXIS_TEST_APPROVALS", "PRAXIS_APPROVAL_FORGED", "PRAXIS_APPROVAL_STRICT", "PRAXIS_SKIP_DOTENV", "PRAXIS_STATE_HOME"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "praxis-envrt-"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  return repo;
}
const initApply = async (repo: string) => (await callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "ba", version: "test" })) as McpEnvelope;

describe("a repository .env cannot relax approvals through the Runtime", () => {
  for (const [name, body] of [
    ["trusted-client", "PRAXIS_APPROVAL_MODE=trusted-client\n"],
    ["host-permission", "PRAXIS_APPROVAL_MODE=host-permission\n"],
    ["test approvals", "PRAXIS_TEST_APPROVALS=1\n"],
    ["forged approvals", "PRAXIS_APPROVAL_FORGED=1\nPRAXIS_APPROVAL_STRICT=0\n"],
    ["everything at once", "PRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_TEST_APPROVALS=1\nPRAXIS_APPROVAL_FORGED=1\nPRAXIS_STATE_HOME=/tmp/elsewhere\n"],
  ] as const) {
    for (const file of [".env", ".env.praxis", ".env.praxis.local"]) {
      it(`${file} with ${name}: a protected write is refused for lack of a dialog and nothing is written`, async () => {
        const repo = repoWith({ [file]: body });
        const res = await initApply(repo);
        expect(res.ok).toBe(false);
        expect(res.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
        expect(existsSync(join(repo, ".project"))).toBe(false);
        expect(process.env.PRAXIS_APPROVAL_MODE).toBeUndefined();
        expect(process.env.PRAXIS_TEST_APPROVALS).toBeUndefined();
      });
    }
  }

  it("a nested .env and a .project file cannot do it either", async () => {
    const repo = repoWith({ "sub/.env": "PRAXIS_APPROVAL_MODE=trusted-client\n", ".praxis/.env": "PRAXIS_TEST_APPROVALS=1\n", ".project": "PRAXIS_APPROVAL_MODE=trusted-client\n" });
    const res = await initApply(repo);
    expect(res.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
  });

  it("priority: the operator's real environment is the only source of trusted-client mode", async () => {
    const repo = repoWith({ ".env": "PRAXIS_APPROVAL_MODE=host-permission\n" });
    process.env.PRAXIS_APPROVAL_MODE = "trusted-client"; // set by the operator (extension settings or shell)
    const res = await initApply(repo);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.data)).toMatch(/trusted-client/);
    expect(existsSync(join(repo, ".project"))).toBe(true);
  });

  it("the doctor names the refused keys (names only)", async () => {
    const repo = repoWith({ ".env": "PRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_JIRA_TOKEN=do-not-print-me\n" });
    const res = (await callTool("praxis_doctor", { repo }, { role: "ba", version: "test" })) as McpEnvelope;
    const text = JSON.stringify(res);
    expect(text).toMatch(/PRAXIS_APPROVAL_MODE/);
    expect(text).not.toMatch(/do-not-print-me/);
  });
});
