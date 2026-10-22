/**
 * Claude Desktop Chat (3.1623.1, client `claude-ai`, protocol 2026-07-28) declared no elicitation. A protected apply must
 * be refused at once with the exact preview: no round trip, no waiting, no write, and `confirmation=YES` changes nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, McpServer, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeClient } from "./server.js";
import { callTool } from "./tools.js";
import { diagnosticsPath, recordDiagnostic } from "./diagnostics-log.js";
import { decisionLogPath } from "@praxis/contracts";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const desktopRequest = {
  mcpReq: {
    envelope: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_INFO_META_KEY]: { name: "claude-ai", version: "0.1.0" },
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: {} },
    },
  },
};
const server = () => new McpServer({ name: "praxis", version: "t" }, { capabilities: { tools: { listChanged: false } } });

let repo: string;
let savedMode: string | undefined;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "praxis-desktop-"));
  savedMode = process.env.PRAXIS_APPROVAL_MODE;
  delete process.env.PRAXIS_APPROVAL_MODE;
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.PRAXIS_APPROVAL_MODE;
  else process.env.PRAXIS_APPROVAL_MODE = savedMode;
  rmSync(repo, { recursive: true, force: true });
});

describe("Claude Desktop capabilities: no dialog", () => {
  it("is reported as no dialog, with the evidence", () => {
    const client = describeClient(server(), desktopRequest);
    expect(client).toMatchObject({ name: "claude-ai", protocolVersion: "2026-07-28", dialog: false, flow: "input-required-round-trip" });
    expect(client.elicitation).toEqual({ declared: null, form: false, url: false });
  });

  it("a protected apply is refused at once with the exact preview and writes nothing", async () => {
    const client = describeClient(server(), desktopRequest);
    // the server builds NO channel for such a client: there is nothing to wait for and no unsupported request to send
    const started = Date.now();
    const result = (await callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "developer", version: "t", client })) as McpEnvelope;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(result.errors.join(" ")).toMatch(/NOT executed/);
    expect(result.data).toMatchObject({ executed: false, preview: { action: expect.any(String) } });
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("no spelling of confirmation or tool arguments stands in for the dialog", async () => {
    const client = describeClient(server(), desktopRequest);
    for (const extra of [{ confirmation: "yes" }, { confirmation: "YES", approved: true, userApproval: { approved: true }, planText: "ok" }]) {
      const result = (await callTool("praxis_project_init_apply", { repo, ...extra }, { role: "developer", version: "t", client })) as McpEnvelope;
      expect(result.ok).toBe(false);
      expect(existsSync(join(repo, ".project"))).toBe(false);
    }
  });

  it("read-only project status still works", async () => {
    const client = describeClient(server(), desktopRequest);
    const result = (await callTool("praxis_project_status", { repo }, { role: "developer", version: "t", client })) as McpEnvelope;
    expect(result.ok).toBe(true);
  });

  it("the doctor tells the user where the call may be held and where the diagnostics are", async () => {
    const client = describeClient(server(), desktopRequest);
    const result = (await callTool("praxis_doctor", { repo }, { role: "developer", version: "t", client })) as McpEnvelope;
    const approval = (result.data as { approval: { mode: string; hostGate?: string; diagnosticsLog?: string } }).approval;
    expect(approval.mode).toBe("no-dialog");
    expect(approval.hostGate).toMatch(/tool-permission prompt/);
    expect(approval.diagnosticsLog).toBe(diagnosticsPath());
  });
});

describe("diagnostic events", () => {
  it("record names and codes, never arguments", () => {
    recordDiagnostic({ event: "tool_enter", callId: "t-1", tool: "praxis_project_init_apply", dialog: false });
    const line = readFileSync(diagnosticsPath(), "utf8").trim().split("\n").pop() as string;
    expect(JSON.parse(line)).toMatchObject({ event: "tool_enter", tool: "praxis_project_init_apply", dialog: false });
  });
});

describe("a declared dialog nobody answers", () => {
  it("is a timeout: not a refusal, not an approval, nothing executed", async () => {
    const { elicitationChannel } = await import("./approval-channel.js");
    const channel = elicitationChannel({ supported: true, elicitInput: async () => { throw new Error("Request timed out"); } })!;
    const result = (await callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "developer", version: "t", approvalChannel: channel })) as McpEnvelope;
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_TIMED_OUT");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });
});

describe("Trusted Client: an explicit opt-in, never the default", () => {
  const trusted = () => {
    process.env.PRAXIS_APPROVAL_MODE = "trusted-client";
    process.env.PRAXIS_TEST_APPROVALS = process.env.PRAXIS_TEST_APPROVALS ?? "1";
  };

  it("by default (Desktop-like client, no dialog) the same apply is still refused", async () => {
    const client = describeClient(server(), desktopRequest);
    const result = (await callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "developer", version: "t", client })) as McpEnvelope;
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("enabled: the apply writes, labelled trusted-client, and the journal says so", async () => {
    trusted();
    const client = describeClient(server(), desktopRequest);
    const result = (await callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "developer", version: "t", client })) as McpEnvelope;
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(existsSync(join(repo, ".project"))).toBe(true);
    expect((result.data as { approval: Array<{ channel: string; assurance: string }> }).approval[0]).toMatchObject({ channel: "trusted-client", assurance: "trusted-client" });
    expect(readFileSync(decisionLogPath(repo), "utf8")).toMatch(/"channel":"trusted-client"/);
  });

  it("enabled: confirmation=NO and a missing confirmation still write nothing", async () => {
    trusted();
    for (const confirmation of ["NO", undefined]) {
      const result = (await callTool("praxis_project_init_apply", { repo, ...(confirmation ? { confirmation } : {}) }, { role: "developer", version: "t" })) as McpEnvelope;
      expect(result.ok).toBe(false);
      expect(existsSync(join(repo, ".project"))).toBe(false);
    }
  });

  it("enabled: the doctor reports trusted-client, not client-ui", async () => {
    trusted();
    const client = describeClient(server(), desktopRequest);
    const result = (await callTool("praxis_doctor", { repo }, { role: "developer", version: "t", client })) as McpEnvelope;
    expect((result.data as { approval: { mode: string; note: string } }).approval.mode).toBe("trusted-client");
    expect((result.data as { approval: { note: string } }).approval.note).toMatch(/not proof/);
  });

  it("enabled: acts only a person may perform (confirming a Story) are still not run on a standing permission", async () => {
    trusted();
    const { trustedClientChannel } = await import("./approval-channel.js");
    await expect(
      trustedClientChannel.ask({ action: "confirm-story", kind: "story_behavior", summary: "Confirm story US-1", description: "d", subject: "s" }),
    ).rejects.toMatchObject({ code: "APPROVAL_CLIENT_UI_REQUIRED" });
    await expect(trustedClientChannel.ask({ action: "praxis_project_init_apply", kind: "development_action", summary: "x", description: "d", subject: "s" })).resolves.toMatchObject({ answer: "approve" });
  });
});
