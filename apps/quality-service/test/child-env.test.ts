/**
 * 0.1.0-alpha.49.3, Agent A (T-repo, T-sandboxed-agent): the Quality service runs the repository's tests. Whatever this
 * process inherited, the test run gets the allowlisted environment: no token, no PRAXIS_* setting. Fake tokens only.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNpmTest } from "../src/review-engine.js";

const KEYS = ["PRAXIS_JIRA_TOKEN", "PRAXIS_GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let repo: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "praxis-a-quality-child-")));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(repo, { recursive: true, force: true });
});

describe("npm test run by the Quality service", () => {
  it("sees PATH and CI=1, never a credential", () => {
    for (const k of KEYS) process.env[k] = `praxis-fake-token-${k.toLowerCase()}-0042`;
    const dump = join(repo, "env.json");
    writeFileSync(join(repo, "dump.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n`);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { test: "node dump.cjs" } }));
    const run = runNpmTest(repo);
    expect(run.exitCode).toBe(0);
    const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(env.CI).toBe("1");
    expect(JSON.stringify(env)).not.toMatch(/praxis-fake-token/);
    expect(Object.keys(env).filter((k) => k.startsWith("PRAXIS_"))).toEqual([]);
  });
});
