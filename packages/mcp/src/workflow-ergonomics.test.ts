import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const call = async (tool: string, repo: string, args: Record<string, unknown>): Promise<McpEnvelope> => (await callTool(tool, { repo, ...args }, { role: "ba", version: "test" })) as McpEnvelope;

async function opened() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-erg-"));
  const open = { action: "open", mode: "guided", projectId: "erg", title: "Ergonomics", request: "r" };
  const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(open) });
  await call("praxis_workflow_apply", repo, { command: JSON.stringify(open), confirmation: "YES", previewFingerprint: p.data.fingerprint });
  return repo;
}

describe("S9 / W2: a preview that fits, and a command that does not have to be retyped", () => {
  it("the preview answer is compact by default and carries the briefing only on request", async () => {
    const repo = await opened();
    const command = JSON.stringify({ action: "add-requirement", id: "REQ-ERG-001", statement: "x", acceptanceCriteria: ["a", "b"] });
    const compact = await call("praxis_workflow_preview", repo, { command });
    expect(compact.ok).toBe(true);
    expect(Object.keys(compact.data)).toEqual(expect.arrayContaining(["fingerprint", "duplicate", "result"]));
    expect(compact.data).not.toHaveProperty("resume");
    const verbose = await call("praxis_workflow_preview", repo, { command, verbose: true });
    expect(verbose.data).toHaveProperty("resume");
    expect(JSON.stringify(verbose.data).length).toBeGreaterThan(JSON.stringify(compact.data).length);
    expect(verbose.data.fingerprint).toBe(compact.data.fingerprint);
  });

  it("a command file inside the repository previews and applies like the same text; a file outside, a link out, or both forms are refused", async () => {
    const repo = await opened();
    const command = { action: "add-requirement", id: "REQ-ERG-002", statement: "from a file", acceptanceCriteria: Array.from({ length: 40 }, (_, i) => `criterion ${i + 1}`) };
    mkdirSync(join(repo, ".praxis", "drafts"), { recursive: true });
    writeFileSync(join(repo, ".praxis", "drafts", "req.json"), JSON.stringify(command));
    const p = await call("praxis_workflow_preview", repo, { commandFile: ".praxis/drafts/req.json" });
    expect(p.ok, JSON.stringify(p.errors)).toBe(true);
    const same = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command) });
    expect(p.data.fingerprint).toBe(same.data.fingerprint);
    const a = await call("praxis_workflow_apply", repo, { commandFile: ".praxis/drafts/req.json", confirmation: "YES", previewFingerprint: p.data.fingerprint });
    expect(a.ok, JSON.stringify(a.errors)).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), "praxis-erg-out-"));
    writeFileSync(join(outside, "x.json"), JSON.stringify(command));
    symlinkSync(join(outside, "x.json"), join(repo, "link.json"));
    for (const bad of ["../x.json", join(outside, "x.json"), "link.json", "missing.json"]) {
      const r = await call("praxis_workflow_preview", repo, { commandFile: bad });
      expect(r.ok, bad).toBe(false);
    }
    const both = await call("praxis_workflow_preview", repo, { commandFile: ".praxis/drafts/req.json", command: JSON.stringify(command) });
    expect(both.ok).toBe(false);
    expect(JSON.stringify(both.errors)).toMatch(/not both/);
    const neither = await call("praxis_workflow_preview", repo, {});
    expect(neither.ok).toBe(false);
  });

  it("praxis_workflow_inspect view=approvals answers for a work item with no recorded decisions", async () => {
    const repo = await opened();
    const res = await call("praxis_workflow_inspect", repo, { view: "approvals" });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    expect(res.data.approvals.summary).toMatchObject({ total: 0, testOnly: 0, unverifiedProvenance: [] });
    expect(res.data.approvals.note).toContain("No client identifies the person");
  });

  it("P4: the address of a review without its secret says why it does not open and what to do, and the result says the url is not a working link", async () => {
    process.env.PRAXIS_TEST_REVIEW_NO_BROWSER = "1";
    const repo = await opened();
    const rendered = await call("praxis_review_render", repo, { view: "requirements" });
    expect(rendered.ok, JSON.stringify(rendered.errors)).toBe(true);
    const response = await fetch(rendered.data.url as string);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain("does not open here");
    expect(text).toContain("reopen: true");
    expect(JSON.stringify(rendered.data)).not.toMatch(/\?t=[a-f0-9]{20}/);
  });
});
