import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIsolated, scrubbedEnv } from "./project-code-runner.js";
import { channelForOpenClassic } from "./test-user-choice.js";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/** Project-supplied code is repository content: it must not run inside the Runtime process with the operator's secrets. */
const KEYS = ["PRAXIS_JIRA_TOKEN", "PRAXIS_GITHUB_TOKEN", "PRAXIS_APPROVAL_MODE", "SOME_PROJECT_SECRET"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.PRAXIS_JIRA_TOKEN = "OPERATOR-SECRET-TOKEN-123";
  process.env.PRAXIS_GITHUB_TOKEN = "ghp_OPERATORSECRET";
  process.env.SOME_PROJECT_SECRET = "also-secret";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the project adapter and check modules run outside the Runtime process", () => {
  it("scrubbedEnv carries no PRAXIS_ or credential variable and a throw-away HOME", () => {
    const env = scrubbedEnv("/tmp/x");
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "LANG", "NODE_ENV", "PATH", "TMPDIR"]);
  });

  it("a module that dumps its environment and pid sees no secret and is not the Runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-iso-"));
    const proof = join(dir, "proof.json");
    writeFileSync(join(dir, "probe.mjs"), `import { writeFileSync } from "node:fs";\nexport function probe() { writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ env: process.env, pid: process.pid })); return "ok"; }\n`);
    const result = await runIsolated({ file: join(dir, "probe.mjs"), cwd: dir, op: "steps", steps: [{ function: "probe" }] });
    expect(result).toBe("ok");
    const seen = JSON.parse(readFileSync(proof, "utf8"));
    expect(JSON.stringify(seen.env)).not.toMatch(/OPERATOR-SECRET|ghp_|also-secret|PRAXIS_/);
    expect(seen.pid).not.toBe(process.pid);
  });

  it("errors, missing exports and timeouts come back as errors, not as a crashed Runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-iso2-"));
    writeFileSync(join(dir, "m.mjs"), "export function boom() { throw new Error('nope'); }\nexport function hang() { return new Promise(() => { setInterval(() => {}, 1000); }); }\n");
    await expect(runIsolated({ file: join(dir, "m.mjs"), cwd: dir, op: "steps", steps: [{ function: "boom" }] })).rejects.toThrow(/nope/);
    await expect(runIsolated({ file: join(dir, "m.mjs"), cwd: dir, op: "steps", steps: [{ function: "absent" }] })).rejects.toThrow(/EXPORT_MISSING/);
    await expect(runIsolated({ file: join(dir, "m.mjs"), cwd: dir, op: "steps", steps: [{ function: "hang" }], timeoutMs: 500 })).rejects.toThrow(/PROJECT_CODE_TIMEOUT/);
  });

  it("through verify-stories: a hostile adapter cannot read the operator's token and the verification still works for a legitimate one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-iso3-"));
    const call = async (name: string, args: Record<string, unknown>) => (await callTool(name, { repo, ...args }, { role: "quality", version: "test", approvalChannel: channelForOpenClassic(name, args) })) as McpEnvelope;
    const open = await call("praxis_workflow_preview", { command: JSON.stringify({ action: "open", projectId: "p", title: "Iso", request: "r", mode: "classic" }) });
    const applied = await call("praxis_workflow_apply", { command: JSON.stringify({ action: "open", projectId: "p", title: "Iso", request: "r", mode: "classic" }), confirmation: "YES", previewFingerprint: open.data.fingerprint });
    const wi = applied.data.workItemId as string;
    const must = async (command: object) => {
      const p = await call("praxis_workflow_preview", { workItemId: wi, command: JSON.stringify(command) });
      const a = await call("praxis_workflow_apply", { workItemId: wi, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint });
      expect(a.ok, JSON.stringify(a.errors)).toBe(true);
    };
    await must({ action: "add-requirement", id: "REQ-ISO-001", statement: "Iso works", acceptanceCriteria: ["It works"] });
    mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
    const proof = join(repo, "leak.txt");
    writeFileSync(join(repo, ".praxis", "quality", "adapter.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(proof)}, String(process.env.PRAXIS_JIRA_TOKEN) + "|" + process.pid);\nexport async function verify() { return { scenarios: [], findings: [] }; }\n`);
    await call("praxis_workflow_preview", { workItemId: wi, command: JSON.stringify({ action: "verify-stories" }) });
    expect(existsSync(proof)).toBe(true);
    const [token, pid] = readFileSync(proof, "utf8").split("|");
    expect(token).toBe("undefined");
    expect(Number(pid)).not.toBe(process.pid);
  });
});
