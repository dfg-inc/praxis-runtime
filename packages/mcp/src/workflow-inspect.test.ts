import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { channelForOpenClassic } from "./test-user-choice.js";
import { callTool, toolsForRole } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";

async function call(tool: string, repo: string, role: string, args: Record<string, unknown> = {}): Promise<McpEnvelope> {
  return (await callTool(tool, { repo, ...args }, { role: role as "ba", version: VERSION, approvalChannel: channelForOpenClassic(tool, args) })) as McpEnvelope;
}

/** Real MCP preview then apply with a host approval bound to the preview fingerprint. */
async function step(repo: string, role: string, command: object, workItemId?: string): Promise<McpEnvelope> {
  const extra = workItemId ? { workItemId } : {};
  const previewed = await call("praxis_workflow_preview", repo, role, { command: JSON.stringify(command), ...extra });
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  const applied = await call("praxis_workflow_apply", repo, role, {
    command: JSON.stringify(command),
    confirmation: "YES",
    previewFingerprint: fingerprint,
    ...extra,
  });
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

function snapshot(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(path).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** A work item that went through BA → Architect → Developer → Quality with every kind of context. */
async function populated(): Promise<{ repo: string; workItemId: string }> {
  const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
  const opened = await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "Inspect everything", request: "Show me the project" });
  const workItemId = opened.data.workItemId as string;
  await step(repo, "ba", {
    action: "add-requirement",
    id: "REQ-INS-101",
    statement: "Operators can inspect stored requirements.",
    acceptanceCriteria: ["Requirement text is returned.", "Acceptance criteria are returned."],
  });
  await step(repo, "ba", {
    action: "add-story",
    id: "US-INS-001",
    requirementIds: ["REQ-INS-101"],
    actor: "operator",
    narrative: "As a operator, I want to see stored stories, so that I can review them.",
    objective: "See stories",
    userValue: "Review without opening files",
    happyPath: ["ask for stories"],
    acceptanceCriteria: [{ id: "US-INS-001-AC-01", given: "a story exists", when: "inspected", then: "it is returned" }],
    expectedResults: ["story returned"],
    serviceIds: ["svc-inspect"],
    confirmedBehavior: false,
  });
  await step(repo, "architect", { action: "record-decision", id: "DEC-INS-101", statement: "One inspection tool.", rationale: "Fewer redundant tools." });
  await step(repo, "architect", {
    action: "set-service",
    service: {
      id: "svc-inspect",
      name: "Inspect service",
      kind: "module",
      localPath: join(repo, "packages", "inspect"),
      responsibilities: ["read state"],
      requirementIds: ["REQ-INS-101"],
      dependsOn: [],
      status: "in_progress",
    },
  });
  const common = { requirementIds: ["REQ-INS-101"], readiness: "ready" };
  await step(repo, "ba", {
    action: "handoff",
    sourceRole: "ba",
    targetRole: "architect",
    ...common,
    risks: ["RISK-A"],
    openQuestions: ["Q-A"],
    blockers: ["B-A"],
    notes: "N-A",
  });
  await step(repo, "architect", { action: "handoff", sourceRole: "architect", targetRole: "developer", ...common });
  await step(repo, "developer", { action: "handoff", sourceRole: "developer", targetRole: "quality", ...common });
  await step(repo, "quality", {
    action: "record-verification",
    scenarios: [
      {
        storyId: "US-INS-001",
        storyRevision: 1,
        requirementId: "REQ-INS-101",
        acceptanceCriterionId: "REQ-INS-101-AC-01",
        scenarioId: "US-INS-001-HAPPY-1",
        kind: "happy",
        serviceId: "svc-inspect",
        status: "PASS_WITH_RISKS",
        evidence: ["executed inspect against the stored state"],
      },
      {
        storyId: "US-INS-001",
        storyRevision: 1,
        requirementId: "REQ-INS-101",
        acceptanceCriterionId: "REQ-INS-101-AC-02",
        scenarioId: "US-INS-001-HAPPY-2",
        kind: "happy",
        serviceId: "svc-inspect",
        status: "PASS_WITH_RISKS",
        evidence: ["executed inspect against the stored state"],
      },
    ],
    findings: [],
  });
  return { repo, workItemId };
}

describe("praxis_workflow_inspect through the MCP tool entry point", () => {
  it("is offered to all four role plugins and to the full runtime", () => {
    for (const role of ["ba", "architect", "developer", "quality", "runtime"] as const) {
      const names = toolsForRole(role).map((tool) => tool.name);
      expect(names, role).toContain("praxis_workflow_inspect");
      expect(names, role).toContain("praxis_session_start");
    }
  });

  it("returns stored requirements with descriptions and acceptance criteria", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "quality", { view: "requirements" });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    const [req] = res.data.requirements;
    expect(req).toMatchObject({ id: "REQ-INS-101", statement: "Operators can inspect stored requirements.", revision: 1 });
    expect(req.acceptanceCriteria.map((c: { statement: string }) => c.statement)).toEqual([
      "Requirement text is returned.",
      "Acceptance criteria are returned.",
    ]);
    expect(req.storyIds).toEqual(["US-INS-001"]);
    // Evidence comes from the stored verification, with the unconfirmed Story keeping it at risk.
    expect(req.evidence).toMatchObject({ status: "executed", verdict: "PASS_WITH_RISKS" });
  });

  it("returns Stories with revision and confirmation state, and does not self-confirm", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "ba", { view: "stories" });
    const [story] = res.data.stories;
    expect(story).toMatchObject({ id: "US-INS-001", revision: 1, status: "proposed", confirmedBehavior: false, confirmation: "unconfirmed" });
    expect(story.coverage[0]).toMatchObject({ scenarioId: "US-INS-001-HAPPY-1", status: "PASS_WITH_RISKS", storyRevision: 1 });
    const one = await call("praxis_workflow_inspect", repo, "ba", { view: "stories", id: "US-INS-001" });
    expect(one.data.stories).toHaveLength(1);
  });

  it("returns architecture decisions with their rationales", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "architect", { view: "decisions" });
    expect(res.data.decisions.decisions[0]).toMatchObject({
      id: "DEC-INS-101",
      statement: "One inspection tool.",
      rationale: "Fewer redundant tools.",
      confirmed: false,
    });
  });

  it("shows risks, blockers, open questions and notes at every hop of the handoff chain", async () => {
    const { repo, workItemId } = await populated();
    // What is stored, read straight from disk…
    const stored = readPersistedState<{ handoffs: Array<{ risks: string[]; blockers: string[]; openQuestions: string[]; notes?: string }> }>(repo, workItemId);
    // …and what a later role sees through MCP must be the same: no loss in storage, none in inspection.
    for (const role of ["architect", "developer", "quality"]) {
      const res = await call("praxis_workflow_inspect", repo, role, { view: "handoffs" });
      expect(res.data.handoffs.chain).toEqual(["ba→architect", "architect→developer", "developer→quality"]);
      expect(res.data.handoffs.items).toHaveLength(3);
      res.data.handoffs.items.forEach((hop: Record<string, unknown>, index: number) => {
        expect(hop.risks, `${role} hop ${index}`).toEqual(["RISK-A"]);
        expect(hop.blockers).toEqual(["B-A"]);
        expect(hop.openQuestions).toEqual(["Q-A"]);
        expect(hop.notes).toBe("N-A");
        expect(hop.risks).toEqual(stored.handoffs[index]?.risks);
      });
      expect((res.data.handoffs.items[2].decisionRecords as unknown[])[0]).toMatchObject({ id: "DEC-INS-101", rationale: "Fewer redundant tools." });
    }
    const open = await call("praxis_workflow_inspect", repo, "quality", { view: "open-items" });
    expect(open.data["open-items"]).toMatchObject({ risks: ["RISK-A"], blockers: ["B-A"], openQuestions: ["Q-A"], notes: "N-A" });
    expect(open.data["open-items"].latestHandoff.route).toBe("developer→quality");
  });

  it("reports resolved items and revisions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "Resolve", request: "r" });
    await step(repo, "ba", { action: "add-requirement", id: "REQ-INS-201", statement: "S", acceptanceCriteria: ["A"] });
    const common = { requirementIds: ["REQ-INS-201"], readiness: "ready" };
    await step(repo, "ba", { action: "handoff", sourceRole: "ba", targetRole: "architect", ...common, blockers: ["B-1"] });
    await step(repo, "architect", { action: "handoff", sourceRole: "architect", targetRole: "developer", ...common, resolved: ["B-1"] });
    const res = await call("praxis_workflow_inspect", repo, "developer", { view: "open-items" });
    expect(res.data["open-items"].resolved).toEqual([expect.objectContaining({ text: "B-1" })]);
    expect(res.data["open-items"].blockers).toEqual([]);
    const hops = (await call("praxis_workflow_inspect", repo, "developer", { view: "handoffs" })).data.handoffs.items;
    expect(hops.map((h: { revision: number }) => h.revision)).toEqual([1, 2]);
  });

  it("returns Quality verdicts and evidence", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "ba", { view: "quality" });
    expect(res.data.quality.coverage.map((c: { scenarioId: string }) => c.scenarioId)).toContain("US-INS-001-HAPPY-1");
    expect(res.data.quality.featureVerdict.verdict).not.toBe("PASS");
    expect(res.data.quality.requirementEvidence[0]).toMatchObject({ requirementId: "REQ-INS-101", status: "executed" });
  });

  it("returns services and implementation with repository-relative paths", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "developer", { view: "work" });
    expect(res.data.work.services[0]).toMatchObject({ id: "svc-inspect", status: "in_progress" });
    expect(res.data.work.services[0].localPath).toBe("packages/inspect");
    expect(JSON.stringify(res.data)).not.toContain(repo);
  });

  it("overview lists every work item and marks the current one; no Jira key is invented", async () => {
    const { repo, workItemId } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "ba", {});
    expect(res.data.view).toBe("overview");
    expect(res.data.overview.workItem).toMatchObject({ id: workItemId, jiraIssueKey: null, provider: "local" });
    expect(res.data.overview.counts).toMatchObject({ requirements: 1, handoffs: 3 });
    expect(res.data.overview.workItems.filter((w: { current: boolean }) => w.current)).toHaveLength(1);
  });

  it("view=all returns every section in one call", async () => {
    const { repo } = await populated();
    const res = await call("praxis_workflow_inspect", repo, "ba", { view: "all" });
    expect(Object.keys(res.data).filter((k) => !["schema", "view", "present", "workItemId", "readOnly"].includes(k)).sort()).toEqual(
      ["decisions", "handoffs", "links", "open-items", "overview", "quality", "requirementReview", "requirements", "stories", "work"].sort(),
    );
  });

  it("scopes strictly to the addressed work item and shows links", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    const a = (await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "Item A", request: "a" })).data.workItemId as string;
    const b = (await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "Item B", request: "b" })).data.workItemId as string;
    await step(repo, "ba", { action: "add-requirement", id: "REQ-INS-301", statement: "Only A", acceptanceCriteria: ["x"] }, a);
    await step(repo, "ba", { action: "link-work-item", workItemId: b, link: { repository: "praxis-core", workItemId: "WI-OTHER-001", relation: "depends-on" } }, b).catch(() => undefined);
    const forB = await call("praxis_workflow_inspect", repo, "ba", { view: "requirements", workItemId: b });
    expect(forB.data.requirements).toEqual([]);
    const forA = await call("praxis_workflow_inspect", repo, "ba", { view: "requirements", workItemId: a });
    expect(forA.data.requirements.map((r: { id: string }) => r.id)).toEqual(["REQ-INS-301"]);
    const links = await call("praxis_workflow_inspect", repo, "ba", { view: "links", workItemId: b });
    expect(links.ok).toBe(true);
    for (const link of links.data.links.outgoing) expect(link.scope).toBe("other-repository");
  });

  it("returns clear errors: ambiguous selection, unknown item, unknown record, bad view, no workflow", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    expect((await call("praxis_workflow_inspect", repo, "ba", { view: "requirements" })).code).toBe("INSPECT_NOT_FOUND");
    const empty = await call("praxis_workflow_inspect", repo, "ba", {});
    expect(empty.ok).toBe(true);
    expect(empty.data.present).toBe(false);
    await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "One", request: "1" });
    await step(repo, "ba", { action: "open", mode: "classic", projectId: "ins", title: "Two", request: "2" });
    // The most recently opened item is current, so an unaddressed call answers for it, not for both.
    const unaddressed = await call("praxis_workflow_inspect", repo, "ba", { view: "overview" });
    expect(unaddressed.data.overview.workItem.title).toBe("Two");
    // A fresh clone has no per-operator selection: the Runtime must ask, never guess.
    const indexPath = join(repo, ".praxis", "workflow", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    writeFileSync(indexPath, JSON.stringify({ ...index, current: null }));
    const selection = await call("praxis_workflow_inspect", repo, "ba", { view: "stories" });
    expect(selection.code).toBe("WORK_ITEM_SELECTION_REQUIRED");
    expect(selection.errors?.[0]).toContain("pass workItemId");
    expect((await call("praxis_workflow_inspect", repo, "ba", { workItemId: "WI-NOPE-001" })).code).toBe("WORK_ITEM_NOT_FOUND");
    expect((await call("praxis_workflow_inspect", repo, "ba", { workItemId: "../../etc/passwd" })).code).toBe("WORK_ITEM_INVALID");
    const { repo: full, workItemId } = await populated();
    expect((await call("praxis_workflow_inspect", full, "ba", { view: "stories", id: "US-NOPE-999" })).code).toBe("INSPECT_NOT_FOUND");
    expect((await call("praxis_workflow_inspect", full, "ba", { view: "nope" })).code).toBe("INSPECT_VIEW_INVALID");
    expect((await call("praxis_workflow_inspect", full, "ba", { workItemId, view: "handoffs", id: "HO-NOPE" })).code).toBe("INSPECT_NOT_FOUND");
  });

  it("is read-only: it creates no state, files or services, in a populated or an empty repository", async () => {
    const { repo } = await populated();
    const before = snapshot(repo);
    for (const view of ["overview", "requirements", "stories", "decisions", "work", "handoffs", "open-items", "quality", "links", "all"]) {
      expect((await call("praxis_workflow_inspect", repo, "quality", { view })).ok, view).toBe(true);
    }
    expect((await call("praxis_session_start", repo, "quality", { role: "quality" })).ok).toBe(true);
    expect(snapshot(repo)).toBe(before);
    const empty = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    await call("praxis_workflow_inspect", empty, "ba", {});
    await call("praxis_session_start", empty, "ba", { role: "ba" });
    expect(readdirSync(empty)).toEqual([]);
  });

  it("works with no Jira or GitHub credentials in the environment", async () => {
    const { repo } = await populated();
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env).filter((k) => /^PRAXIS_(JIRA|GITHUB|GITLAB)/.test(k))) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      expect((await call("praxis_workflow_inspect", repo, "ba", { view: "all" })).ok).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    }
  });

  it("never returns approval tokens, key material or secret-looking values", async () => {
    const { repo } = await populated();
    const text = JSON.stringify((await call("praxis_workflow_inspect", repo, "ba", { view: "all" })).data);
    expect(text).not.toMatch(/-----BEGIN|"token"|signature|authorization|ledger/i);
  });
});

describe("praxis_session_start through MCP", () => {
  it("reports project, knowledge, work items and role tools without running a script", async () => {
    const { repo } = await populated();
    const res = await call("praxis_session_start", repo, "architect", { role: "architect" });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    expect(res.data).toMatchObject({ role: "architect", stage: "plan", readOnly: true });
    expect(res.data.project.status).toBe("missing");
    expect(res.data.knowledge.status).toBe("skipped");
    expect(res.data.workflow.workItems).toHaveLength(1);
    expect(res.data.tools).toContain("praxis_workflow_inspect");
    expect(res.data.runtime.version).toBe(VERSION);
    expect(JSON.stringify(res.data)).not.toContain(repo);
  });

  it("maps each role to its own stage", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    const stages: Record<string, string> = {};
    for (const role of ["ba", "architect", "developer", "quality"]) stages[role] = (await call("praxis_session_start", repo, role, { role })).data.stage;
    expect(stages).toEqual({ ba: "research", architect: "plan", developer: "implement", quality: "quality" });
  });

  it("refuses a missing or unknown role", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-inspect-"));
    expect((await call("praxis_session_start", repo, "ba", { role: "janitor" })).code).toBe("SESSION_ROLE_INVALID");
  });
});

describe("praxis_developer_status identities through MCP (no Jira)", () => {
  it("answers for a Work Item without inventing a Jira key", async () => {
    const { repo, workItemId } = await populated();
    const res = await call("praxis_developer_status", repo, "developer", { workItemId });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    expect(res.data).toMatchObject({ identity: { kind: "work-item-id" }, workItemId, jiraIssueKey: null });
    expect(res.data.services[0]).toMatchObject({ id: "svc-inspect" });
  });

  it("refuses a Work Item id passed as workPackage, pointing to workItemId", async () => {
    const { repo, workItemId } = await populated();
    const res = await call("praxis_developer_status", repo, "developer", { workPackage: workItemId });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_INPUT");
    expect(res.errors?.[0]).toContain("workItemId");
  });

  it("refuses both identities at once and an unknown work item", async () => {
    const { repo, workItemId } = await populated();
    expect((await call("praxis_developer_status", repo, "developer", { workItemId, workPackage: "WP-20260914-002" })).code).toBe("IDENTITY_AMBIGUOUS");
    expect((await call("praxis_developer_status", repo, "developer", { workItemId: "WI-NOPE-001" })).code).toBe("WORK_ITEM_NOT_FOUND");
  });
});

describe("praxis_developer_status identities through MCP: every identifier type", () => {
  const JIRA = ["BASE_URL", "TOKEN", "PROJECT_KEY", "EMAIL"].map((n) => `PRAXIS_JIRA_${n}`);
  const withoutJira = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = JIRA.map((k) => [k, process.env[k]] as const);
    for (const k of JIRA) delete process.env[k];
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  };
  const repoWithWp = (key?: string) => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-ident-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(join(repo, "work-packages", "WP-20260914-002", "manifest.json"), JSON.stringify({ id: "WP-20260914-002", ...(key ? { jiraIssueKey: key } : {}) }));
    return repo;
  };

  it("local Work Package id: ok, jiraIssueKey null unless the manifest records one", async () => {
    await withoutJira(async () => {
      const plain = await call("praxis_developer_status", repoWithWp(), "developer", { workPackage: "WP-20260914-002" });
      expect(plain.ok, JSON.stringify(plain.errors)).toBe(true);
      expect(plain.data).toMatchObject({ jiraIssueKey: null, identity: { kind: "work-package-id" } });
      const keyed = await call("praxis_developer_status", repoWithWp("PRX-7"), "developer", { workPackage: "WP-20260914-002" });
      expect(keyed.data.jiraIssueKey).toBe("PRX-7");
    });
  });

  it("Jira issue key: recognised as a Jira key, local WP found through it", async () => {
    await withoutJira(async () => {
      const res = await call("praxis_developer_status", repoWithWp("PRX-7"), "developer", { workPackage: "PRX-7" });
      expect(res.ok, JSON.stringify(res.errors)).toBe(true);
      expect(res.data).toMatchObject({ jiraIssueKey: "PRX-7", identity: { kind: "jira-issue-key" }, local: "WP-20260914-002" });
    });
  });

  it("an unknown or malformed identifier is refused, not echoed back as a key", async () => {
    await withoutJira(async () => {
      for (const bad of ["hello world", "wp-1", "PRX", "WI-NOT-A-REAL-ONE--999x"]) {
        const res = await call("praxis_developer_status", repoWithWp(), "developer", { workPackage: bad });
        expect(res.ok, bad).toBe(false);
        expect(res.data?.jiraIssueKey, bad).toBeUndefined();
      }
    });
  });

  it("work_package_show refuses a Work Item id too", async () => {
    const { repo, workItemId } = await populated();
    const res = await call("praxis_work_package_show", repo, "developer", { workPackage: workItemId });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]).toContain("Work Item id");
  });
});
