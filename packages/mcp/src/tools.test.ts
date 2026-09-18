import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  type JiraConfig,
} from "@praxis/jira";
import { callTool, toolsForRole, TOOLS } from "./tools.js";
import { parseRoleArgv, PraxisMcpRoleError } from "./server.js";
import { PRAXIS_MCP_SDK } from "./protocol.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function restoreEnv(previous: {
  token?: string;
  base?: string;
  email?: string;
  project?: string;
}) {
  if (previous.token) process.env.PRAXIS_JIRA_TOKEN = previous.token;
  else delete process.env.PRAXIS_JIRA_TOKEN;
  if (previous.base) process.env.PRAXIS_JIRA_BASE_URL = previous.base;
  else delete process.env.PRAXIS_JIRA_BASE_URL;
  if (previous.email) process.env.PRAXIS_JIRA_EMAIL = previous.email;
  else delete process.env.PRAXIS_JIRA_EMAIL;
  if (previous.project) process.env.PRAXIS_JIRA_PROJECT_KEY = previous.project;
  else delete process.env.PRAXIS_JIRA_PROJECT_KEY;
}

function cfg(): JiraConfig {
  return {
    mode: "cloud",
    baseUrl: "https://acme.atlassian.net",
    token: "secret-jira-token-value",
    projectKey: "PRX",
    email: "dev@example.com",
    authMode: "cloud-basic",
    epicType: "Epic",
    storyType: "Story",
    taskType: "Task",
    bugType: "Bug",
    workPackageType: "",
    transitions: {},
    workPackageMaxHours: 16,
  };
}

function mockProvider(state = createMockJiraState()) {
  return {
    state,
    provider: createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    }),
  };
}

function seedWp(repo: string, id = "WP-20260914-002") {
  const dir = join(repo, "design", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "# Counter Reset\n\nreset() returns the counter to zero.\n");
  writeFileSync(join(dir, "change-spec.json"), `${JSON.stringify({ id }, null, 2)}\n`);
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", version: "1.0.0", workPackageId: id }, null, 2)}\n`,
  );
}

function seedProposal(repo: string, epicKey: string) {
  const dir = join(repo, ".praxis-jira", "proposals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${epicKey}.json`),
    `${JSON.stringify(
      {
        contract: "jira.ba.proposal",
        version: "1.0.0",
        epicKey,
        stories: [
          {
            logicalId: "E2-FR1",
            artifactId: `ba:${epicKey}:E2-FR1`,
            summary: "Counter library: add reset()",
            userStory: { asA: "developer", iWant: "reset", soThat: "I can zero the counter" },
            businessContext: "Counter library",
            acceptanceCriteria: [{ given: "a counter", when: "reset", then: "value is 0" }],
            outOfScope: [],
            dependencies: [],
            requirementIds: ["E2-FR1"],
          },
        ],
        nfrs: [],
        businessRules: [],
        openQuestions: [],
      },
      null,
      2,
    )}\n`,
  );
}

describe("role tool catalogs", () => {
  it("exposes typed tools and isolates roles", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("praxis_doctor");
    expect(names).toContain("praxis_architect_preview");
    expect(names).toContain("praxis_architect_apply");
    expect(toolsForRole("architect").map((t) => t.name)).not.toContain("praxis_developer_complete");
    expect(toolsForRole("ba").map((t) => t.name)).toContain("praxis_ba_apply");
    expect(toolsForRole("ba").map((t) => t.name)).not.toContain("praxis_architect_apply");
    expect(toolsForRole("developer").map((t) => t.name)).toContain("praxis_developer_claim");
    expect(toolsForRole("quality").map((t) => t.name)).toContain("praxis_quality_review");
    expect(toolsForRole("runtime").map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("parseRoleArgv reads --role and rejects invalid/missing", () => {
    expect(parseRoleArgv(["--role", "ba"])).toBe("ba");
    expect(parseRoleArgv(["--role", "architect"])).toBe("architect");
    expect(parseRoleArgv(["--role", "developer"])).toBe("developer");
    expect(parseRoleArgv(["--role", "quality"])).toBe("quality");
    expect(parseRoleArgv(["--role", "runtime"])).toBe("runtime");
    expect(() => parseRoleArgv([])).toThrow(PraxisMcpRoleError);
    expect(() => parseRoleArgv(["--role", "nope"])).toThrow(/PRAXIS_MCP_ROLE_INVALID/);
  });
});

describe("stdio protocol surface", () => {
  it("uses official SDK serveStdio dual-era, not a custom parser", () => {
    expect(PRAXIS_MCP_SDK.stdioApi).toBe("serveStdio");
    expect(PRAXIS_MCP_SDK.modernRevision).toBe("2026-07-28");
    expect(PRAXIS_MCP_SDK.legacyMode).toBe("serve");
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/serveStdio\(/);
    expect(src).not.toMatch(/encodeMcpFrame/);
    expect(src).not.toMatch(/Content-Length/);
  });

  it("never writes diagnostics to stdout", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), "utf8");
      expect(text, file).not.toMatch(/console\.log\(/);
    }
  });

  it("does not advertise MCP roots capability", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/capabilities: \{ tools: \{ listChanged: false \} \}/);
    expect(src).not.toMatch(/roots:/);
    expect(src).not.toMatch(/list_changed/);
  });
});

describe("doctor and capability codes", () => {
  it("does not expose secrets and reports missing repo/jira", async () => {
    const missing = join(tmpdir(), "praxis-missing-repo-xyz");
    const env = {
      token: process.env.PRAXIS_JIRA_TOKEN,
      base: process.env.PRAXIS_JIRA_BASE_URL,
      email: process.env.PRAXIS_JIRA_EMAIL,
      project: process.env.PRAXIS_JIRA_PROJECT_KEY,
    };
    delete process.env.PRAXIS_JIRA_TOKEN;
    delete process.env.PRAXIS_JIRA_BASE_URL;
    delete process.env.PRAXIS_JIRA_EMAIL;
    delete process.env.PRAXIS_JIRA_PROJECT_KEY;
    try {
      const result = await callTool("praxis_doctor", { repo: missing }, { role: "runtime", version: VERSION });
      expect(result.ok).toBe(true);
      expect(result.contract).toBe("praxis.mcp.result");
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/secret-jira-token-value/);
      expect(text).not.toMatch(/Authorization/);
      expect(text).not.toMatch(/SECRET_FIXTURE_VALUE/);
      const data = result.data as {
        jira: {
          baseUrlConfigured: boolean;
          emailConfigured: boolean;
          projectKeyConfigured: boolean;
          tokenConfigured: boolean;
          missing: string[];
        };
        codes: { repository?: string; jira?: string };
        capabilities: { praxisRuntime?: string };
      };
      expect(data.capabilities.praxisRuntime).toBe("ok");
      expect(data.jira.baseUrlConfigured).toBe(false);
      expect(data.jira.emailConfigured).toBe(false);
      expect(data.jira.projectKeyConfigured).toBe(false);
      expect(data.jira.tokenConfigured).toBe(false);
      expect(data.jira.missing).toEqual([
        "jira_base_url",
        "jira_email",
        "jira_project_key",
        "jira_token",
      ]);
      expect(data.codes.repository).toBe("REPOSITORY_UNAVAILABLE");
      expect(data.codes.jira).toBe("JIRA_CONFIG_UNAVAILABLE");
      expect(data).not.toHaveProperty("connected");
    } finally {
      if (env.token) process.env.PRAXIS_JIRA_TOKEN = env.token;
      if (env.base) process.env.PRAXIS_JIRA_BASE_URL = env.base;
      if (env.email) process.env.PRAXIS_JIRA_EMAIL = env.email;
      if (env.project) process.env.PRAXIS_JIRA_PROJECT_KEY = env.project;
    }
  });

  it("reports configured flags from env without Jira network or token leak", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-doctor-cfg-"));
    const previous = {
      token: process.env.PRAXIS_JIRA_TOKEN,
      base: process.env.PRAXIS_JIRA_BASE_URL,
      email: process.env.PRAXIS_JIRA_EMAIL,
      project: process.env.PRAXIS_JIRA_PROJECT_KEY,
    };
    process.env.PRAXIS_SKIP_DOTENV = "1";
    process.env.PRAXIS_JIRA_BASE_URL = "https://example.invalid";
    process.env.PRAXIS_JIRA_EMAIL = "test@example.com";
    process.env.PRAXIS_JIRA_PROJECT_KEY = "PRX";
    process.env.PRAXIS_JIRA_TOKEN = "SECRET_FIXTURE_VALUE";
    try {
      const started = Date.now();
      const result = await callTool("praxis_doctor", { repo }, { role: "runtime", version: VERSION });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.ok).toBe(true);
      const jira = (result.data as { jira: Record<string, unknown> }).jira;
      expect(jira.baseUrlConfigured).toBe(true);
      expect(jira.emailConfigured).toBe(true);
      expect(jira.projectKeyConfigured).toBe(true);
      expect(jira.tokenConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/SECRET_FIXTURE_VALUE/);
      expect(JSON.stringify(result)).not.toMatch(/Authorization/);
    } finally {
      restoreEnv(previous);
    }
  });

  it("identifies missing token without a Jira network request", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-partial-jira-"));
    const previous = {
      token: process.env.PRAXIS_JIRA_TOKEN,
      base: process.env.PRAXIS_JIRA_BASE_URL,
      email: process.env.PRAXIS_JIRA_EMAIL,
      project: process.env.PRAXIS_JIRA_PROJECT_KEY,
    };
    process.env.PRAXIS_SKIP_DOTENV = "1";
    process.env.PRAXIS_JIRA_BASE_URL = "https://example.invalid";
    process.env.PRAXIS_JIRA_EMAIL = "test@example.com";
    process.env.PRAXIS_JIRA_PROJECT_KEY = "PRX";
    delete process.env.PRAXIS_JIRA_TOKEN;
    try {
      const started = Date.now();
      const result = await callTool(
        "praxis_jira_status",
        { epic: "PRX-1", repo },
        { role: "runtime", version: VERSION },
      );
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("JIRA_CONFIG_UNAVAILABLE");
      expect(result.errors.join(" ")).toMatch(/jira_token/);
      expect(JSON.stringify(result)).not.toMatch(/SECRET_FIXTURE_VALUE/);
    } finally {
      restoreEnv(previous);
    }
  });
});

describe("Architect MCP fixture", () => {
  it("preview fingerprint + apply gates + canonical WP", async () => {
    const { provider, state } = mockProvider();
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-mcp-arch-"));
    seedProposal(repo, epic.key);
    const extra = { provider };
    const baPreview = await callTool(
      "praxis_ba_preview",
      { epic: epic.key, repo },
      { role: "ba", version: VERSION, extra },
    );
    expect(baPreview.ok).toBe(true);
    const baFp = (baPreview.data as { previewFingerprint: string }).previewFingerprint;
    expect(baFp).toMatch(/^sha256:/);
    const baNoConfirm = await callTool(
      "praxis_ba_apply",
      { epic: epic.key, repo, previewFingerprint: baFp },
      { role: "ba", version: VERSION, extra },
    );
    expect(baNoConfirm.ok).toBe(false);
    expect(baNoConfirm.code).toBe("CONFIRMATION_REQUIRED");
    const baApply = await callTool(
      "praxis_ba_apply",
      { epic: epic.key, repo, confirmation: "YES", previewFingerprint: baFp },
      { role: "ba", version: VERSION, extra },
    );
    expect(baApply.ok).toBe(true);
    seedWp(repo);
    const preview = await callTool(
      "praxis_architect_preview",
      { epic: epic.key, repo },
      { role: "architect", version: VERSION, extra },
    );
    expect(preview.ok).toBe(true);
    const data = preview.data as {
      previewFingerprint: string;
      plan: Array<{ action: string; kind: string; summary?: string }>;
      planText?: string;
      taskKeys?: string[];
    };
    expect(data.previewFingerprint).toMatch(/^sha256:/);
    expect(data.plan.filter((p) => p.action === "CREATE" && p.kind === "work-package")).toHaveLength(1);
    expect(data.taskKeys ?? []).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(/Technical implementation for/);
    expect(JSON.stringify(preview)).not.toMatch(/flowchart LR\s*A-->B/);
    expect(JSON.stringify(preview)).not.toMatch(/wp:PRX-/);
    const blocked = await callTool(
      "praxis_architect_apply",
      { epic: epic.key, repo, previewFingerprint: data.previewFingerprint },
      { role: "architect", version: VERSION, extra },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("CONFIRMATION_REQUIRED");
    const stale = await callTool(
      "praxis_architect_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: "sha256:deadbeef",
      },
      { role: "architect", version: VERSION, extra },
    );
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("CONFLICT");
    const first = await callTool(
      "praxis_architect_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: data.previewFingerprint,
      },
      { role: "architect", version: VERSION, extra },
    );
    expect(first.ok).toBe(true);
    const wps = (first.data as { workPackages: Array<{ id: string; jiraIssueKey: string }> }).workPackages;
    expect(wps).toHaveLength(1);
    expect(wps[0]!.id).toBe("WP-20260914-002");
    const created = state.createIssueCount;
    const preview2 = await callTool(
      "praxis_architect_preview",
      { epic: epic.key, repo },
      { role: "architect", version: VERSION, extra },
    );
    const fp2 = (preview2.data as { previewFingerprint: string }).previewFingerprint;
    const second = await callTool(
      "praxis_architect_apply",
      { epic: epic.key, repo, confirmation: "YES", previewFingerprint: fp2 },
      { role: "architect", version: VERSION, extra },
    );
    expect(second.ok).toBe(true);
    expect(state.createIssueCount).toBe(created);
    expect(
      (second.data as { workPackages: unknown[] }).workPackages,
    ).toHaveLength(1);
  });
});

describe("Developer MCP fixture", () => {
  it("resolves local WP, claim gate, no auto quality", async () => {
    const { provider } = mockProvider();
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-mcp-dev-"));
    seedProposal(repo, epic.key);
    const extra = { provider };
    const baPreview = await callTool(
      "praxis_ba_preview",
      { epic: epic.key, repo },
      { role: "ba", version: VERSION, extra },
    );
    await callTool(
      "praxis_ba_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: (baPreview.data as { previewFingerprint: string }).previewFingerprint,
      },
      { role: "ba", version: VERSION, extra },
    );
    seedWp(repo);
    const archPreview = await callTool(
      "praxis_architect_preview",
      { epic: epic.key, repo },
      { role: "architect", version: VERSION, extra },
    );
    const applied = await callTool(
      "praxis_architect_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: (archPreview.data as { previewFingerprint: string }).previewFingerprint,
      },
      { role: "architect", version: VERSION, extra },
    );
    const wp = (applied.data as { workPackages: Array<{ id: string; jiraIssueKey: string }> }).workPackages[0]!;
    const statusLocal = await callTool(
      "praxis_developer_status",
      { workPackage: "WP-20260914-002", repo },
      { role: "developer", version: VERSION, extra },
    );
    const statusRemote = await callTool(
      "praxis_developer_status",
      { workPackage: wp.jiraIssueKey, repo },
      { role: "developer", version: VERSION, extra },
    );
    expect(statusLocal.ok).toBe(true);
    expect((statusLocal.data as { local: string }).local).toBe("WP-20260914-002");
    expect((statusRemote.data as { local?: string }).local).toBe("WP-20260914-002");
    const denied = await callTool(
      "praxis_developer_claim",
      { workPackage: "WP-20260914-002", repo },
      { role: "developer", version: VERSION, extra },
    );
    expect(denied.code).toBe("CONFIRMATION_REQUIRED");
    const claimed = await callTool(
      "praxis_developer_claim",
      { workPackage: "WP-20260914-002", repo, confirmation: "YES" },
      { role: "developer", version: VERSION, extra },
    );
    expect(claimed.ok).toBe(true);
    const again = await callTool(
      "praxis_developer_claim",
      { workPackage: "WP-20260914-002", repo, confirmation: "YES" },
      { role: "developer", version: VERSION, extra },
    );
    expect(again.ok).toBe(true);
    expect(JSON.stringify(claimed)).not.toMatch(/secret-jira-token-value/);
    const completeDenied = await callTool(
      "praxis_developer_complete",
      { workPackage: "WP-20260914-002", repo },
      { role: "developer", version: VERSION, extra },
    );
    expect(completeDenied.code).toBe("CONFIRMATION_REQUIRED");
    const complete = await callTool(
      "praxis_developer_complete",
      { workPackage: "WP-20260914-002", repo, confirmation: "YES" },
      { role: "developer", version: VERSION, extra },
    );
    expect(complete.ok).toBe(true);
    expect(JSON.stringify(complete)).not.toMatch(/praxis_quality/);
  });
});

describe("Quality MCP fixture", () => {
  it("review confirmation + localized numeric bug type", async () => {
    const state = createMockJiraState({
      issueTypes: [
        { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
        { id: "10001", name: "История", hierarchyLevel: 0, subtask: false },
        { id: "10002", name: "Задача", hierarchyLevel: 0, subtask: false },
        { id: "10012", name: "Баг", hierarchyLevel: 0, subtask: false },
      ],
    });
    const { provider } = mockProvider(state);
    const extra = { provider };
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-mcp-qa-"));
    seedProposal(repo, epic.key);
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: \"node -e process.exit(0)\"\n  test: \"node -e process.exit(0)\"\n",
    );
    const baPreview = await callTool(
      "praxis_ba_preview",
      { epic: epic.key, repo },
      { role: "ba", version: VERSION, extra },
    );
    await callTool(
      "praxis_ba_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: (baPreview.data as { previewFingerprint: string }).previewFingerprint,
      },
      { role: "ba", version: VERSION, extra },
    );
    seedWp(repo);
    const archPreview = await callTool(
      "praxis_architect_preview",
      { epic: epic.key, repo },
      { role: "architect", version: VERSION, extra },
    );
    const applied = await callTool(
      "praxis_architect_apply",
      {
        epic: epic.key,
        repo,
        confirmation: "YES",
        previewFingerprint: (archPreview.data as { previewFingerprint: string }).previewFingerprint,
      },
      { role: "architect", version: VERSION, extra },
    );
    const wpKey = (applied.data as { workPackages: Array<{ jiraIssueKey: string }> }).workPackages[0]!
      .jiraIssueKey;
    const denied = await callTool(
      "praxis_quality_review",
      { workPackage: wpKey, repo },
      { role: "quality", version: VERSION, extra },
    );
    expect(denied.code).toBe("CONFIRMATION_REQUIRED");
    const meta = await callTool("praxis_jira_discover", { repo }, { role: "quality", version: VERSION, extra });
    expect((meta.data as { bugTypeId: string }).bugTypeId).toBe("10012");
    const review = await callTool(
      "praxis_quality_review",
      { workPackage: wpKey, repo, confirmation: "YES" },
      { role: "quality", version: VERSION, extra },
    );
    expect(review.ok).toBe(true);
    expect(JSON.stringify(review)).not.toMatch(/secret-jira-token-value/);
  });
});
