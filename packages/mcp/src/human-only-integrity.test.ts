import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";
import { approvalMessage, elicitationChannel } from "./approval-channel.js";
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

describe("trusted-client mode and the remaining approvals", () => {
  it("with a real dialog, Trusted Client still asks the person for a rewording; without one it is refused", async () => {
    const { repo, id } = await lab();
    process.env.PRAXIS_APPROVAL_MODE = "trusted-client";
    const reword = { action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-01", statement: "A manager sees every order" }] };
    const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(reword), workItemId: id });
    const asked = dialog({ answer: "reject" });
    const rejected = await call("praxis_workflow_apply", repo, { command: JSON.stringify(reword), confirmation: "YES", previewFingerprint: p.data.fingerprint, workItemId: id }, asked.channel);
    expect(code(rejected)).toBe("APPROVAL_REJECTED");
    expect(asked.seen).toHaveLength(1);
    const ok = approve();
    const done = await call("praxis_workflow_apply", repo, { command: JSON.stringify(reword), confirmation: "YES", previewFingerprint: p.data.fingerprint, workItemId: id }, ok.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(ok.seen).toHaveLength(1);
    // the person's answer is labelled as the dialog's (client-ui), not as the standing Trusted Client permission
    expect(JSON.stringify(done.data)).toMatch(/"assurance":"client-ui"/);
    expect(JSON.stringify(done.data)).not.toMatch(/"assurance":"trusted-client"/);
    expect(state(repo, id).requirements[0].acceptanceCriteria[0].statement).toBe("A manager sees every order");
    const none = await call("praxis_workflow_apply", repo, { command: JSON.stringify({ action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-02", statement: "Search by number or customer" }] }), confirmation: "YES", previewFingerprint: "x", workItemId: id });
    expect(none.ok).toBe(false);
  });

  it("host-permission refuses the Quality fix commit approval (it needs a dialog)", async () => {
    const { hostPermissionChannel } = await import("./approval-channel.js");
    await expect(hostPermissionChannel("anything").ask({ action: "praxis_quality_service_fix", kind: "git_operation", summary: "Commit a Quality fix", description: "d", subject: "s" } as never)).rejects.toMatchObject({ code: "APPROVAL_CLIENT_UI_REQUIRED" });
  });

  it("verify-stories and prepare-fix are held to the command schema: a misspelt key is an error", async () => {
    const { repo, id } = await lab();
    for (const command of [{ action: "verify-stories", independentRerunn: true }, { action: "verify-stories", bogus: 1 }, { action: "prepare-fix", serviceId: "x", authorized: true, existingBrnch: "b" }]) {
      const res = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command), workItemId: id });
      expect(res.ok, JSON.stringify(command)).toBe(false);
      expect(code(res)).toBe("UNKNOWN_COMMAND_PARAMETER");
    }
  });
});

describe("praxis_review_apply: what the person approves is everything that is applied", () => {
  const writeFile = (repo: string, body: object) => {
    writeFileSync(join(repo, "decisions.json"), JSON.stringify(body));
    return "decisions.json";
  };
  const storyBody = async (repo: string, id: string, stories: Array<Record<string, unknown>>, items: Array<Record<string, unknown>> = []) => {
    const t = await tab(repo, id, "stories");
    return { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "stories", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, baseState: t.page.baseState, stories: { items, stories, accept: false } };
  };
  const NEW = "As a manager, I want orders fast, so that I work.";

  it("a story text edit alone needs the dialog: no dialog and a rejected dialog change nothing; the dialog shows the edit", async () => {
    const { repo, id } = await lab();
    const file = writeFile(repo, await storyBody(repo, id, [{ storyId: "US-ORD-001", revision: 1, narrative: NEW }]));
    const before = readFileSync(itemFile(repo, id), "utf8");
    const none = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id });
    expect(none.ok).toBe(false);
    expect(code(none)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    const no = dialog({ answer: "reject" });
    expect(code(await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, no.channel))).toBe("APPROVAL_REJECTED");
    expect(no.seen[0].description).toContain(NEW);
    expect(no.seen[0].description).toMatch(/EDIT narrative/);
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
    const yes = approve();
    const done = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, yes.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect((done.data as { applied: number }).applied).toBe(1);
    expect(state(repo, id).stories.find((s) => s.status !== "superseded")!.narrative).toBe(NEW);
  });

  it("a story exclusion next to a mark: one dialog, one approval for both, and the approved subject contains the exclusion", async () => {
    const { repo, id } = await lab();
    const body = await storyBody(repo, id, [{ storyId: "US-ORD-001", revision: 1, exclude: "not needed now" }]);
    const yes = approve();
    const done = await call("praxis_review_apply", repo, { file: writeFile(repo, body), confirmation: "YES", workItemId: id }, yes.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(yes.seen).toHaveLength(1);
    expect(yes.seen[0].description).toMatch(/EXCLUDE from scope \(not needed now\)/);
    expect(String(yes.seen[0].subject)).toContain("not needed now");
    expect(state(repo, id).stories[0].status).toBe("excluded");
  });

  it("the story changes while the dialog is open: what was shown is no longer what would apply, so nothing is recorded", async () => {
    const { repo, id } = await lab();
    const file = writeFile(repo, await storyBody(repo, id, [{ storyId: "US-ORD-001", revision: 1, narrative: NEW }]));
    const dlg = dialog({ answer: "approve" }, () => {
      applyRuntimeCommand(repo, { action: "update-story", id: "US-ORD-001", patch: { objective: "changed elsewhere" }, reason: "x" }, id);
    });
    const res = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, dlg.channel);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/REVIEW_CHANGED|changed while the approval dialog was open|story changed since/);
    expect(state(repo, id).stories.find((s) => s.status !== "superseded")!.narrative).not.toBe(NEW);
  });

  it("a waiver or mode change is applied only to the state it was made for, and replaying the file adds nothing", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const rendered = (await call("praxis_review_render", repo, { view: "requirements", serve: false, workItemId: id })).data as { baseState: string };
    const body = (extra: object) => ({ contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, ...extra });
    const waiver = { kind: "prototype", reason: "pure refactor, nothing to show" };
    // no baseState at all
    const bare = await call("praxis_review_apply", repo, { file: writeFile(repo, body({ waivers: [waiver] })), confirmation: "YES", workItemId: id }, approve().channel);
    expect(JSON.stringify(bare.data)).toMatch(/does not say which state/);
    expect(state(repo, id).waivers).toHaveLength(0);
    // the item moves after the file was made
    await record(repo, { action: "add-requirement", id: "REQ-ORD-002", statement: "More", acceptanceCriteria: ["x"] }, id);
    const asked = approve();
    const stale = await call("praxis_review_apply", repo, { file: writeFile(repo, body({ waivers: [waiver], modeChange: { to: "guided" }, baseState: rendered.baseState })), confirmation: "YES", workItemId: id }, asked.channel);
    expect(JSON.stringify(stale.data)).toMatch(/work item changed since.*render the review again/);
    expect(asked.seen).toHaveLength(0); // nothing to approve: no dialog for a plan that cannot apply
    expect(state(repo, id).waivers).toHaveLength(0);
    // made for the current state: shown, approved, applied once
    const fresh = (await call("praxis_review_render", repo, { view: "requirements", serve: false, workItemId: id })).data as { baseState: string };
    const file = writeFile(repo, body({ waivers: [waiver], baseState: fresh.baseState }));
    const ok1 = approve();
    const done = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, ok1.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(ok1.seen[0].description).toContain("WAIVE prototype");
    expect(state(repo, id).waivers).toHaveLength(1);
    const again = await call("praxis_review_apply", repo, { file, confirmation: "YES", workItemId: id }, approve().channel);
    expect(again.ok).toBe(true);
    expect(state(repo, id).waivers).toHaveLength(1);
  });
});

describe("the dialog shows everything it binds, or the action is refused", () => {
  const writeFile = (repo: string, body: object) => {
    writeFileSync(join(repo, "decisions.json"), JSON.stringify(body));
    return "decisions.json";
  };

  it("a plan that is too large for one dialog is refused (APPROVAL_TOO_LARGE), never cut; nothing is applied", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const state0 = state(repo, id);
    const rev = state0.requirements[0].revision;
    const addCriteria = Array.from({ length: 40 }, (_, i) => ({ statement: `criterion ${i} ${"padding ".repeat(48)}` }));
    const body = { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, baseState: t.page.baseState, requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, addCriteria, criteria: [], removeCriteria: [] }], acceptAll: false }, waivers: [{ kind: "prototype", reason: "pure refactor, nothing to show" }], modeChange: { to: "guided" } };
    const before = readFileSync(itemFile(repo, id), "utf8");
    // the client's real elicitation dialog: a message it cannot carry whole is refused before anything is asked
    const asked: string[] = [];
    const real = elicitationChannel({ supported: true, elicitInput: async (params) => (asked.push(params.message), { action: "accept", content: { decision: "approve" } }) })!;
    const res = await call("praxis_review_apply", repo, { file: writeFile(repo, body), confirmation: "YES", workItemId: id }, real);
    expect(res.ok).toBe(false);
    expect(code(res)).toBe("APPROVAL_TOO_LARGE");
    expect(asked).toHaveLength(0); // the dialog was never opened with a cut message
    expect(() => approvalMessage({ action: "x", kind: "development_action", summary: "s", description: "y".repeat(13_000), subject: "s" } as never)).toThrow(/more than one approval dialog can show in full/);
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
    // the same decisions in a size the dialog can carry are shown in full and applied
    const small = { ...body, requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, addCriteria: addCriteria.slice(0, 2), criteria: [], removeCriteria: [] }], acceptAll: false } };
    const ok2 = approve();
    const done = await call("praxis_review_apply", repo, { file: writeFile(repo, small), confirmation: "YES", workItemId: id }, ok2.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(ok2.seen[0].description).toMatch(/SWITCH this work item/);
    expect(ok2.seen[0].description).toContain("WAIVE prototype");
  });

  it("a plain requirement change that reaches a story is not applied quietly: it needs the dialog and the dialog says what happens to the story", async () => {
    const { repo, id } = await lab();
    const t = await tab(repo, id, "requirements");
    const rev = state(repo, id).requirements[0].revision;
    const body = { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: id, baseFingerprint: t.page.baseFingerprint, baseStamp: t.page.baseStamp, requirements: { requirements: [{ id: "REQ-ORD-001", revision: rev, scope: "excluded", fromScope: "in", criteria: [], addCriteria: [], removeCriteria: [] }], acceptAll: false } };
    const before = readFileSync(itemFile(repo, id), "utf8");
    const none = await call("praxis_review_apply", repo, { file: writeFile(repo, body), confirmation: "YES", workItemId: id });
    expect(code(none)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
    const dlg = approve();
    const done = await call("praxis_review_apply", repo, { file: writeFile(repo, body), confirmation: "YES", workItemId: id }, dlg.channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(dlg.seen[0].description).toMatch(/affects stories US-ORD-001.*confirmation is withdrawn/);
    expect(state(repo, id).requirements[0].scope).toBe("excluded");
  });

  it("a reused review page reports the state it was created for, not the current one", async () => {
    const { repo, id } = await lab();
    process.env.PRAXIS_TEST_REVIEW_NO_BROWSER = "1";
    const first = (await call("praxis_review_render", repo, { view: "requirements", workItemId: id, serve: false })).data as { baseState: string };
    await record(repo, { action: "add-requirement", id: "REQ-ORD-002", statement: "More", acceptanceCriteria: ["x"] }, id);
    const later = (await call("praxis_review_render", repo, { view: "requirements", workItemId: id, serve: false })).data as { baseState: string };
    expect(later.baseState).not.toBe(first.baseState); // an offline render describes the state it just wrote
  });
});

describe("a Quality patch may touch only the file it was approved for", () => {
  it("assertDiffTouchesOnly reads the diff the way git does: other files, renames, a different prefix, spaces and header-like hunk lines", async () => {
    const { diffPaths, assertDiffTouchesOnly } = await import("./story-engine.js");
    const dir = mkdtempSync(join(tmpdir(), "praxis-diff-"));
    const out = mkdtempSync(join(tmpdir(), "praxis-diff-out-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "other"));
    for (const [path, text] of [["a.txt", "a\n"], ["src/target.txt", "t\n"], ["target.txt", "root\n"], ["other/file", "o\n"], ["sp ace.txt", "s\n"], ["notes.sql", "keep\n-- note\n"]] as const) writeFileSync(join(dir, path), text);
    const one = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    expect(diffPaths(one, dir)).toEqual(["a.txt"]);
    expect(() => assertDiffTouchesOnly(dir, { path: "a.txt", diff: one })).not.toThrow();
    // a second file in the same diff
    const sneaky = `${one}diff --git a/other/file b/other/file\n--- a/other/file\n+++ b/other/file\n@@ -1 +1 @@\n-o\n+EVIL\n`;
    expect(() => assertDiffTouchesOnly(dir, { path: "a.txt", diff: sneaky })).toThrow(/also changes other\/file/);
    // a diff without the a/ b/ prefix: git strips one component, so this edits the ROOT target.txt, not src/target.txt
    const prefixless = "--- src/target.txt\n+++ src/target.txt\n@@ -1 +1 @@\n-root\n+PWNED\n";
    expect(diffPaths(prefixless, dir)).toEqual(["target.txt"]);
    expect(() => assertDiffTouchesOnly(dir, { path: "src/target.txt", diff: prefixless })).toThrow(/also changes target.txt/);
    // a rename
    const rename = "diff --git a/a.txt b/other/renamed\nsimilarity index 100%\nrename from a.txt\nrename to other/renamed\n";
    expect(() => assertDiffTouchesOnly(dir, { path: "a.txt", diff: rename })).toThrow(/PROPOSAL_INVALID/);
    // legitimate shapes still work: a path with a space, and a removed line that looks like a header
    const spaced = "diff --git a/sp ace.txt b/sp ace.txt\n--- a/sp ace.txt\n+++ b/sp ace.txt\n@@ -1 +1 @@\n-s\n+t\n";
    expect(() => assertDiffTouchesOnly(dir, { path: "sp ace.txt", diff: spaced })).not.toThrow();
    const headerLike = "diff --git a/notes.sql b/notes.sql\n--- a/notes.sql\n+++ b/notes.sql\n@@ -1,2 +1,1 @@\n keep\n--- note\n";
    expect(() => assertDiffTouchesOnly(dir, { path: "notes.sql", diff: headerLike })).not.toThrow();
    // a link out of the checkout, and a path that climbs out
    symlinkSync(out, join(dir, "out-link"));
    expect(() => assertDiffTouchesOnly(dir, { path: "out-link/x.txt", diff: "--- a/out-link/x.txt\n+++ b/out-link/x.txt\n@@ -1 +1 @@\n-x\n+y\n" })).toThrow();
    expect(() => assertDiffTouchesOnly(dir, { path: "a.txt", diff: "not a diff at all" })).toThrow(/PROPOSAL_INVALID/);
  });
});
