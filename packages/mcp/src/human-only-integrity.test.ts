import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";
import { callTool } from "./tools.js";
import { applyRuntimeCommand, loadWorkflow } from "./workflow-store.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
  process.env.PRAXIS_TEST_REVIEW_NO_BROWSER = "1";
});
afterEach(() => delete process.env.PRAXIS_APPROVAL_MODE);

function dialog(answer: AskAnswer, beforeAnswer?: () => void) {
  const seen: ApprovalRequest[] = [];
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      beforeAnswer?.();
      return answer;
    },
  };
  return { channel, seen };
}
const call = async (tool: string, repo: string, args: Record<string, unknown> = {}, channel?: UserApprovalChannel): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", ...(channel ? { approvalChannel: channel } : {}) })) as McpEnvelope;
const code = (res: McpEnvelope) => res.code ?? (res.errors?.[0] as { code?: string } | undefined)?.code;
const approve = () => dialog({ answer: "approve" });

async function record(repo: string, command: object, id?: string, channel?: UserApprovalChannel) {
  const extra = id ? { workItemId: id } : {};
  const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command), ...extra });
  expect(p.ok, JSON.stringify(p.errors ?? p)).toBe(true);
  const a = await call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...extra }, channel);
  expect(a.ok, JSON.stringify(a.errors ?? a)).toBe(true);
  return a;
}
const state = (repo: string, id: string) => loadWorkflow(repo, id)!;
const itemFile = (repo: string, id: string) => join(repo, ".praxis", "workflow", "items", `${id}.json`);

/** A classic item (the plan and story pages are open to it without the earlier stages) with requirements, a plan and a story. */
async function lab() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-human-only-"));
  const opened = await record(repo, { action: "open", projectId: "orders", title: "Orders", request: "r", mode: "classic" }, undefined, approve().channel);
  const id = opened.data.workItemId as string;
  await record(repo, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["The list shows orders", "A manager can search"] }, id);
  await record(repo, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "View orders", implementation: "List page", userGets: "all orders", requirementIds: ["REQ-ORD-001"], capabilities: [] }] }, id);
  await record(repo, { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want orders, so that I see them.", objective: "o", userValue: "v", happyPath: ["open", "search"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["shown"], confirmedBehavior: false }, id);
  return { repo, id };
}

/** One browser tab: the served page, what it showed, and its Save. */
async function tab(repo: string, id: string, view: "requirements" | "story-plan" | "stories") {
  const res = await call("praxis_review_render", repo, { view, workItemId: id });
  expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  const data = res.data as { url: string; file: string };
  const secret = readFileSync(join(dirname(data.file), `${view}.url`), "utf8");
  const html = await (await fetch(secret)).text();
  const page = JSON.parse(html.match(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/)![1]);
  return {
    page,
    async save(payload: Record<string, unknown>) {
      const body = { contract: "praxis.review.submission", version: 1, reviewId: page.reviewId, view, workItemId: id, baseFingerprint: page.baseFingerprint, baseStamp: page.baseStamp, ...payload };
      const sent = await fetch(`${data.url.split("?")[0]}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(secret).origin, "x-praxis-review-token": page.token }, body: JSON.stringify(body) });
      expect(sent.status).toBe(200);
      return (await sent.json()) as { applied?: number; conflicts?: Array<{ item: string; reason: string }> };
    },
  };
}

describe("host-permission mode never stands in for the person", () => {
  it("rewording, confirming a Story, recording review decisions and opening a classic item are refused even with a matching plan text", async () => {
    const { repo, id } = await lab();
    const before = readFileSync(itemFile(repo, id), "utf8");
    process.env.PRAXIS_APPROVAL_MODE = "host-permission";
    const reword = { action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-01", statement: "A manager sees every order" }] };
    const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(reword), workItemId: id });
    expect(p.ok).toBe(true);
    // the plan tool does not even offer a text for it
    const plan = await call("praxis_approval_plan", repo, { tool: "praxis_workflow_apply", toolArguments: JSON.stringify({ command: JSON.stringify(reword), workItemId: id }) });
    expect(plan.ok, JSON.stringify(plan.errors)).toBe(true);
    expect(plan.data).toMatchObject({ planText: null, available: false });
    for (const planText of [undefined, "anything", "Reword 1 acceptance criterion(a)"]) {
      const res = await call("praxis_workflow_apply", repo, { command: JSON.stringify(reword), confirmation: "YES", previewFingerprint: p.data.fingerprint, workItemId: id, ...(planText ? { planText } : {}) });
      expect(res.ok).toBe(false);
      expect(code(res)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    }
    // confirming a story
    const fp = state(repo, id).stories[0];
    const confirm = { action: "confirm-story", id: "US-ORD-001", revision: fp.revision, contentFingerprint: (await import("@praxis/contracts")).storyContentFingerprint(fp) };
    const pc = await call("praxis_workflow_preview", repo, { command: JSON.stringify(confirm), workItemId: id });
    const rc = await call("praxis_workflow_apply", repo, { command: JSON.stringify(confirm), confirmation: "YES", previewFingerprint: pc.data.fingerprint, workItemId: id, planText: "x" });
    expect(code(rc)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    // recording the user's decisions handed over as a file
    const tabA = await tab(repo, id, "requirements");
    const submission = JSON.stringify({ contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: tabA.page.baseFingerprint, baseStamp: tabA.page.baseStamp, requirements: { requirements: [{ id: "REQ-ORD-001", revision: 1, criteria: [{ id: "REQ-ORD-001-AC-01", revision: 1, from: "pending", status: "accepted" }], addCriteria: [], removeCriteria: [] }], acceptAll: false } });
    const ra = await call("praxis_review_apply", repo, { submission, confirmation: "YES", planText: "x", workItemId: id });
    expect(ra.ok).toBe(false);
    expect(code(ra)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    // opening a new classic item
    const open = { action: "open", projectId: "orders", title: "Another", request: "r", mode: "classic" };
    const po = await call("praxis_workflow_preview", repo, { command: JSON.stringify(open) });
    const ro = await call("praxis_workflow_apply", repo, { command: JSON.stringify(open), confirmation: "YES", previewFingerprint: po.data.fingerprint, planText: "x" });
    expect(code(ro)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
  });

  it("a real dialog still works in that mode, and an agent record still needs none", async () => {
    const { repo, id } = await lab();
    process.env.PRAXIS_APPROVAL_MODE = "host-permission";
    const reword = { action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-01", statement: "A manager sees every order" }] };
    await record(repo, reword, id, approve().channel);
    expect(state(repo, id).requirements[0].acceptanceCriteria[0].statement).toBe("A manager sees every order");
    await record(repo, { action: "record-context", notes: "an agent note" }, id);
  });
});

describe("two tabs: every editable field of every review keeps what the other tab saved", () => {
  it("Requirements Review: scope, scope note and requirement remark", async () => {
    const { repo, id } = await lab();
    const a = await tab(repo, id, "requirements");
    const b = await tab(repo, id, "requirements");
    const rev = state(repo, id).requirements[0].revision;
    const edit = (extra: Record<string, unknown>) => ({ requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, criteria: [], addCriteria: [], removeCriteria: [], ...extra }], acceptAll: false } });
    expect((await a.save(edit({ comment: "tab A remark", fromComment: "", scopeNote: "tab A note", fromScopeNote: "" }))).conflicts ?? []).toEqual([]);
    const lost = await b.save(edit({ comment: "tab B remark", fromComment: "", scopeNote: "tab B note", fromScopeNote: "" }));
    expect(lost.conflicts?.length).toBeGreaterThan(0);
    expect(JSON.stringify(lost.conflicts)).toMatch(/reload/i);
    expect(state(repo, id).requirements[0]).toMatchObject({ comment: "tab A remark", scopeNote: "tab A note" });
    // the same tab without its base values is refused too
    const noBase = await b.save(edit({ comment: "tab B remark again" }));
    expect(noBase.conflicts?.length).toBeGreaterThan(0);
    expect(state(repo, id).requirements[0].comment).toBe("tab A remark");
  });

  it("Story Plan: a line edited in one tab is not overwritten by the other, with or without its base", async () => {
    const { repo, id } = await lab();
    const a = await tab(repo, id, "story-plan");
    const b = await tab(repo, id, "story-plan");
    const entryBase = (await import("@praxis/contracts")).planEntryBase(state(repo, id).storyPlan!.entries[0]);
    expect((await a.save({ plan: { entries: [{ id: "US-ORD-001", base: entryBase, implementation: "List page with paging" }], agree: false } })).conflicts ?? []).toEqual([]);
    const lost = await b.save({ plan: { entries: [{ id: "US-ORD-001", base: entryBase, userGets: "tab B's text" }], agree: false } });
    expect(lost.conflicts?.length).toBeGreaterThan(0);
    const noBase = await b.save({ plan: { entries: [{ id: "US-ORD-001", userGets: "tab B's text, no base" }], agree: false } });
    expect(noBase.conflicts?.length).toBeGreaterThan(0);
    expect(state(repo, id).storyPlan!.entries[0]).toMatchObject({ implementation: "List page with paging", userGets: "all orders" });
  });

  it("Story Review: a remark and a decision on the same item", async () => {
    const { repo, id } = await lab();
    const a = await tab(repo, id, "stories");
    const b = await tab(repo, id, "stories");
    const item = (extra: Record<string, unknown>) => ({ stories: { items: [{ storyId: "US-ORD-001", revision: 1, key: "step:0", ...extra }], stories: [], accept: false } });
    expect((await a.save(item({ status: "rejected", from: "pending", comment: "tab A", fromComment: "" }))).conflicts ?? []).toEqual([]);
    const lost = await b.save(item({ status: "accepted", from: "pending", comment: "tab B", fromComment: "" }));
    expect(lost.conflicts?.length).toBeGreaterThan(0);
    const noBase = await b.save(item({ status: "accepted", comment: "tab B, no base" }));
    expect(noBase.conflicts?.length).toBeGreaterThan(0);
    expect(state(repo, id).stories[0].review["step:0"]).toMatchObject({ status: "rejected", comment: "tab A" });
  });
});

describe("praxis_review_apply: a saved or handed-over file gets no way around the checks", () => {
  const fileFor = (repo: string, body: object) => {
    const path = join(repo, "decisions.json");
    writeFileSync(path, JSON.stringify(body));
    return "decisions.json";
  };

  it("a file made before another change, without base values, is reported as conflicts and records nothing; with the page's base values it is judged field by field", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const rev = state(repo, id).requirements[0].revision;
    const decisions = (criterion: Record<string, unknown>) => ({ contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, criteria: [criterion], addCriteria: [], removeCriteria: [] }], acceptAll: false } });
    // another tab changes the remark after the file was made
    await t.save({ requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, criteria: [{ id: "REQ-ORD-001-AC-01", revision: 1, comment: "newer remark", fromComment: "" }], addCriteria: [], removeCriteria: [] }], acceptAll: false } });
    for (const criterion of [{ id: "REQ-ORD-001-AC-01", revision: 1, comment: "old file remark" }, { id: "REQ-ORD-001-AC-01", revision: 1, comment: "old file remark", fromComment: "" }]) {
      const res = await call("praxis_review_apply", repo, { file: fileFor(repo, decisions(criterion)), confirmation: "YES", workItemId: id });
      expect(res.ok, JSON.stringify(res.errors ?? res)).toBe(true);
      expect(JSON.stringify(res.data)).toMatch(/conflicts/);
      expect((res.data as { applied?: number }).applied ?? 0).toBe(0);
      expect(state(repo, id).requirements[0].acceptanceCriteria[0].review.comment).toBe("newer remark");
    }
  });

  it("a misspelt key in the file (a base value, an approval) is an error, never ignored", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const body = { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, requirements: { requirements: [{ id: "REQ-ORD-001", revision: 1, criteria: [{ id: "REQ-ORD-001-AC-01", revision: 1, comment: "x", fromcomment: "" }], addCriteria: [], removeCriteria: [] }], acceptAll: false } };
    const res = await call("praxis_review_apply", repo, { file: fileFor(repo, body), confirmation: "YES", workItemId: id });
    expect(res.ok).toBe(false);
    expect(code(res)).toBe("UNKNOWN_COMMAND_PARAMETER");
    const forged = await call("praxis_review_apply", repo, { file: fileFor(repo, { ...body, requirements: { requirements: [], acceptAll: false }, approved: true, userApproval: { decision: "approved" } }), confirmation: "YES", workItemId: id });
    expect(forged.ok).toBe(false);
    expect(code(forged)).toBe("UNKNOWN_COMMAND_PARAMETER");
  });

  it("the work item changes while the approval dialog is open: nothing is recorded", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const rev = state(repo, id).requirements[0].revision;
    const body = { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, criteria: [{ id: "REQ-ORD-001-AC-01", revision: 1, from: "pending", status: "accepted" }], addCriteria: [], removeCriteria: [] }], acceptAll: false } };
    const file = fileFor(repo, body);
    // while the dialog is open another tab rejects that same criterion
    const dlg = dialog({ answer: "approve" }, () => {
      applyRuntimeCommand(repo, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "rejected", comment: "no" }] }] }, id, { via: "html-review" });
    });
    const res = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, dlg.channel);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/REVIEW_CHANGED|changed while the approval dialog was open/);
    expect(dlg.seen).toHaveLength(1);
    expect(state(repo, id).requirements[0].acceptanceCriteria[0].review).toMatchObject({ status: "rejected", comment: "no" });
  });
});

describe("approval plans are held to the target tool's own arguments", () => {
  it("a misspelt workItemId in the plan request is refused instead of planning the current item", async () => {
    const { repo, id } = await lab();
    const res = await call("praxis_approval_plan", repo, { tool: "praxis_workflow_apply", toolArguments: JSON.stringify({ command: "{}", workitemId: id }) });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain("workItemId");
  });
});
