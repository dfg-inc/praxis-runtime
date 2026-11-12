/**
 * 0.1.0-alpha.49.3, Agent A: no credential value the server process holds leaves it through Praxis's own output.
 *
 * Fake tokens are planted in the server environment under every credential variable Praxis reads, and also reach output on
 * purpose: a Jira server (a local capture server) answers every request with an error body that echoes the token, and a
 * work item title contains another. Every tool of the runtime role is then called; no result, error, doctor report,
 * diagnostics line or stderr line may contain a token in any form, and the planted ones must show up as [REDACTED:<NAME>].
 * Redaction keeps values out of the model context; it does not take them out of the inherited environment (an agent's own
 * shell can still read them), which praxis_doctor states.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOLS } from "./catalog.js";
import { diagnosticsPath, recordDiagnostic } from "./diagnostics-log.js";
import { installOutputRedaction } from "./secret-redaction.js";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const FAKE: Record<string, string> = {
  PRAXIS_JIRA_TOKEN: "praxis-fake-token-jira-7d3e1a9b44",
  PRAXIS_GITHUB_TOKEN: "praxis-fake-token-github-0b8f22c1",
  PRAXIS_GITLAB_TOKEN: "praxis-fake-token-gitlab-91aa0c3d",
  PRAXIS_GIT_TOKEN: "praxis-fake-token-git-55e0d1f2",
  GITHUB_TOKEN: "praxis-fake-token-ghenv-6c6c1d1d",
  GH_TOKEN: "praxis-fake-token-ghcli-3a3a9e9e",
  GITLAB_TOKEN: "praxis-fake-token-glenv-2b2b7f7f",
};
const forms = (value: string) => [value, Buffer.from(value).toString("base64").replace(/=+$/, ""), encodeURIComponent(value)];
const leaks = (text: string): string[] => Object.entries(FAKE).filter(([, v]) => forms(v).some((f) => text.includes(f))).map(([k]) => k);

const KEYS = [...Object.keys(FAKE), "PRAXIS_JIRA_BASE_URL", "PRAXIS_JIRA_PROJECT_KEY", "PRAXIS_JIRA_MODE", "PRAXIS_JIRA_RETRY_BACKOFF_MS", "PRAXIS_GITHUB_API_URL", "PRAXIS_QUALITY_URL", "PRAXIS_SKIP_DOTENV", "PRAXIS_TEST_REVIEW_NO_BROWSER"];
let saved: Record<string, string | undefined>;
let server: Server;
let repo: string;
const results: Array<{ tool: string; text: string }> = [];

beforeAll(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  server = createServer((req, res) => {
    // a hostile or broken Jira that echoes the credential it was sent, inside an error body
    const auth = String(req.headers.authorization ?? "");
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ errorMessages: [`token rejected: ${auth.replace(/^Bearer\s+/i, "")} for ${req.url}`] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  Object.assign(process.env, FAKE, {
    PRAXIS_JIRA_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    PRAXIS_JIRA_PROJECT_KEY: "PRX",
    PRAXIS_JIRA_MODE: "datacenter",
    PRAXIS_JIRA_RETRY_BACKOFF_MS: "0",
    PRAXIS_GITHUB_API_URL: "http://127.0.0.1:9/api/v3",
    PRAXIS_QUALITY_URL: "http://127.0.0.1:9/health",
    PRAXIS_SKIP_DOTENV: "1",
    PRAXIS_TEST_REVIEW_NO_BROWSER: "1",
  });
  repo = realpathSync(mkdtempSync(join(tmpdir(), "praxis-a-redact-")));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(repo, { recursive: true, force: true });
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const envelope = (await callTool(tool, { repo, ...args }, { role: "runtime", version: "test" })) as McpEnvelope;
  const text = JSON.stringify(envelope);
  results.push({ tool, text });
  return { envelope, text };
};

describe("no tool result or error carries a credential value", () => {
  it("planted through a work item title, it comes back redacted", async () => {
    const command = { action: "open", mode: "classic", projectId: "redact", title: `Ticket ${FAKE.PRAXIS_GITHUB_TOKEN}`, request: `See ${FAKE.GH_TOKEN}` };
    const preview = await call("praxis_workflow_preview", { command: JSON.stringify(command) });
    expect(leaks(preview.text)).toEqual([]);
    expect(preview.text).toContain("[REDACTED:PRAXIS_GITHUB_TOKEN]");
    const status = await call("praxis_workflow_status", {});
    expect(leaks(status.text)).toEqual([]);
  });

  it("echoed by the Jira server inside an error, it comes back redacted", async () => {
    const smoke = await call("praxis_jira_smoke", {});
    expect(smoke.envelope.ok).toBe(false);
    expect(leaks(smoke.text)).toEqual([]);
    expect(smoke.text).toContain("[REDACTED:PRAXIS_JIRA_TOKEN]");
  });

  it("praxis_doctor names the inherited credential variables and shows no value", async () => {
    const doctor = await call("praxis_doctor", {});
    expect(leaks(doctor.text)).toEqual([]);
    const exposure = (doctor.envelope.data as { credentialExposure: { inheritedCredentialVariables: string[]; note: string } }).credentialExposure;
    expect(exposure.inheritedCredentialVariables).toEqual(Object.keys(FAKE).sort());
    expect(exposure.note).toMatch(/cannot remove them from an environment that was already inherited/);
  });

  it("every tool of the runtime role, called as an agent would, returns nothing that contains one", async () => {
    // the Quality service is not started here (praxis_quality_ensure would start a real process); its startup errors are
    // covered by the doctor and status calls
    const skip = new Set(["praxis_quality_ensure"]);
    for (const tool of TOOLS) {
      if (skip.has(tool.name)) continue;
      const args: Record<string, unknown> = {};
      for (const key of tool.inputSchema.required ?? []) {
        args[key] = key === "confirmation" ? "YES" : key === "reviewId" ? 1 : key === "command" ? JSON.stringify({ action: "add-requirement", text: FAKE.GITLAB_TOKEN }) : `WP-${FAKE.PRAXIS_GIT_TOKEN}`;
      }
      if ("serve" in tool.inputSchema.properties) args.serve = false;
      const { text } = await call(tool.name, args);
      expect(leaks(text), tool.name).toEqual([]);
    }
    expect(results.length).toBeGreaterThan(TOOLS.length - 2);
  }, 120_000);
});

describe("logs and the diagnostics file", () => {
  it("a diagnostics line is redacted before it is written", () => {
    recordDiagnostic({ event: "test_redaction", note: `value ${FAKE.PRAXIS_JIRA_TOKEN}` });
    const file = diagnosticsPath();
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(leaks(text)).toEqual([]);
    expect(text).toContain("[REDACTED:PRAXIS_JIRA_TOKEN]");
  });

  it("every chunk written to a protected stream is redacted: protocol lines stay valid JSON", () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        done();
      },
    }) as unknown as NodeJS.WriteStream;
    installOutputRedaction([sink]);
    sink.write(`[praxis-mcp] error ${FAKE.GH_TOKEN}\n`);
    sink.write(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", result: { text: `x ${FAKE.PRAXIS_GITLAB_TOKEN} "q"` } })}\n`));
    const all = chunks.join("");
    expect(leaks(all)).toEqual([]);
    expect(() => JSON.parse(chunks[1]!)).not.toThrow();
    expect(all).toContain("[REDACTED:GH_TOKEN]");
  });
});
