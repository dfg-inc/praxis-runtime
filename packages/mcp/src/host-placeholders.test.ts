import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

// REQ-CFG-001 through the real MCP entry point: Claude Desktop passes every blank optional setting as a literal
// ${user_config.*} template, and no tool may treat that as configuration.
const SETTINGS = [
  "PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_EMAIL", "PRAXIS_JIRA_PROJECT_KEY", "PRAXIS_JIRA_TOKEN", "PRAXIS_SECURITY_MODE",
  "PRAXIS_BROKER_SHARED_DIR", "PRAXIS_APPROVAL_PUBLIC_KEY_PATH", "PRAXIS_APPROVAL_LEDGER", "PRAXIS_OPERATOR_URL",
  "PRAXIS_GITHUB_TOKEN", "PRAXIS_GITHUB_API_URL", "PRAXIS_GITLAB_TOKEN", "PRAXIS_GITLAB_BASE_URL",
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k]]));
  for (const key of SETTINGS) process.env[key] = `\${user_config.${key.slice(7).toLowerCase()}}`;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const call = async (tool: string, repo: string, args: Record<string, unknown> = {}) =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test" })) as McpEnvelope;

describe("unexpanded Desktop placeholders through MCP tools", () => {
  it("every read tool treats them as unset and never echoes a template", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-ph-"));
    for (const [tool, args] of [
      ["praxis_doctor", {}],
      ["praxis_workflow_status", {}],
      ["praxis_workflow_inspect", { view: "overview" }],
      ["praxis_session_start", { role: "ba" }],
      ["praxis_project_status", {}],
    ] as const) {
      const res = await call(tool, repo, args);
      expect(res.ok, `${tool}: ${JSON.stringify(res.errors)}`).toBe(true);
      expect(JSON.stringify(res), tool).not.toContain("${");
    }
    const doctor = await call("praxis_doctor", repo);
    expect(doctor.data.security).toMatchObject({ mode: "secure" });
    expect(doctor.data.jira.configured).toBe(false);
    expect(doctor.data.github.tokenConfigured).toBe(false);
  });

  it("a protected write is still refused: a blank approval setting does not weaken secure mode", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-ph-"));
    const res = await call("praxis_project_init_apply", repo, { confirmation: "YES" });
    expect(res.ok).toBe(false);
    expect(res.code).toMatch(/^APPROVAL_/);
  });
});
