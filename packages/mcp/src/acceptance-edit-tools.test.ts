import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./tools.js";
import { loadWorkflow } from "./workflow-store.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
  process.env.PRAXIS_TEST_REVIEW_NO_BROWSER = "1";
});

import type { ApprovalRequest, AskAnswer, UserApprovalChannel } from "@praxis/contracts";

/** The client's approval dialog: answers with what the (scripted) user chose and keeps what was shown. */
function dialog(answer: AskAnswer) {
  const seen: ApprovalRequest[] = [];
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      return answer;
    },
  };
  return { channel, seen };
}
const call = async (tool: string, repo: string, args: Record<string, unknown> = {}, channel?: UserApprovalChannel): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", ...(channel ? { approvalChannel: channel } : {}) })) as McpEnvelope;
const preview = (repo: string, command: object, id: string) => call("praxis_workflow_preview", repo, { command: JSON.stringify(command), workItemId: id });
const apply = (repo: string, command: object, id: string, previewFingerprint: string, channel?: UserApprovalChannel) =>
  call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint, workItemId: id }, channel);
const approve = () => dialog({ answer: "approve" });
async function record(repo: string, command: object, id?: string, channel?: UserApprovalChannel) {
  const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command), ...(id ? { workItemId: id } : {}) });
  expect(p.ok, JSON.stringify(p.errors ?? p)).toBe(true);
  const a = await call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...(id ? { workItemId: id } : {}) }, channel);
  expect(a.ok, JSON.stringify(a.errors ?? a)).toBe(true);
  return a;
}

const AC6 = "REQ-ORD-002-AC-06";
const AC5 = "REQ-ORD-005-AC-05";
const NEW6 = "В боковой панели отображается только текущий статус заказа. История изменений статуса в панели не выводится";
const NEW5 = "Для работы фильтра и карточки заказа используется текущее значение status. Данные истории смены статусов для этой функциональности не требуются";
const SIZES: Record<string, number> = { "REQ-ORD-001": 6, "REQ-ORD-002": 6, "REQ-ORD-003": 5, "REQ-ORD-004": 5, "REQ-ORD-005": 6, "REQ-ORD-006": 3 }; // 31 criteria

async function lab() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-acedit-"));
  const opened = await record(repo, { action: "open", projectId: "orders", title: "Order list", request: "Managers manage orders", mode: "guided" });
  const id = opened.data.workItemId as string;
  for (const [req, n] of Object.entries(SIZES)) {
    await record(repo, { action: "add-requirement", id: req, statement: `Requirement ${req}`, acceptanceCriteria: Array.from({ length: n }, (_, i) => `${req} criterion ${i + 1}`) }, id);
  }
  return { repo, id };
}
const state = (repo: string, id: string) => loadWorkflow(repo, id)!;
const criteria = (repo: string, id: string) => state(repo, id).requirements.flatMap((r) => r.acceptanceCriteria);
const itemFile = (repo: string, id: string) => join(repo, ".praxis", "workflow", "items", `${id}.json`);

/** A review page open in one browser tab: what it showed, and how its Save posts. */
async function openPage(repo: string, id: string) {
  const res = await call("praxis_review_render", repo, { view: "requirements", workItemId: id });
  expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  const data = res.data as { url: string; file: string };
  const secret = readFileSync(join(dirname(data.file), "requirements.url"), "utf8");
  const html = await (await fetch(secret)).text();
  const page = JSON.parse(html.match(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/)![1]);
  const shown = JSON.parse(JSON.stringify(state(repo, id).requirements));
  return {
    html,
    async save(requirements: Array<Record<string, unknown>>) {
      const body = { contract: "praxis.review.submission", version: 1, reviewId: page.reviewId, view: "requirements", workItemId: id, baseFingerprint: page.baseFingerprint, requirements: { requirements, acceptAll: false } };
      const sent = await fetch(`${data.url.split("?")[0]}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(secret).origin, "x-praxis-review-token": page.token }, body: JSON.stringify(body) });
      expect(sent.status).toBe(200);
      return (await sent.json()) as { applied?: number; conflicts?: Array<{ item: string; reason: string }> };
    },
    /** Marks every criterion as the page showed it: rejected for the ones named, accepted for the rest. */
    marks(rejected: Record<string, string>) {
      return shown.map((r: { id: string; revision: number; acceptanceCriteria: Array<{ id: string; revision: number }> }) => ({
        id: r.id,
        revision: r.revision,
        criteria: r.acceptanceCriteria.map((c) => (rejected[c.id] !== undefined ? { id: c.id, revision: c.revision, from: "pending", status: "rejected", comment: rejected[c.id], fromComment: "" } : { id: c.id, revision: c.revision, from: "pending", status: "accepted" })),
        addCriteria: [],
        removeCriteria: [],
      }));
    },
  };
}
const userMarks = async (repo: string, id: string, rejected: Record<string, string>) => {
  const page = await openPage(repo, id);
  const saved = await page.save(page.marks(rejected));
  expect(saved.conflicts ?? []).toEqual([]);
};
async function pageHtml(repo: string, id: string) {
  return (await openPage(repo, id)).html;
}

const edit = { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }, { id: AC5, statement: NEW5 }] };
const REMARK = "Не нравится решение";
const code = (res: McpEnvelope) => res.code ?? (res.errors?.[0] as { code?: string } | undefined)?.code;

describe("one acceptance criterion changes by its id: preview, the user's approval in the dialog, apply", () => {
  it("E2E: two rejected criteria get r2 and pending, the rejections stay as previous, the other 29 are untouched, the page shows it", async () => {
    const { repo, id } = await lab();
    expect(criteria(repo, id)).toHaveLength(31);
    await userMarks(repo, id, { [AC6]: REMARK, [AC5]: "Историю статусов не показываем" });
    const before = criteria(repo, id);
    const seen = (await call("praxis_workflow_inspect", repo, { workItemId: id, view: "requirements" })).data as any;
    expect(seen.requirementReview.rejected.map((r: any) => r.criterionId).sort()).toEqual([AC6, AC5].sort());

    const p = await preview(repo, edit, id);
    expect(p.ok, JSON.stringify(p.errors ?? p)).toBe(true);
    expect(p.data.humanApproval ?? (p.data as any).humanApproval).toBeDefined();
    const result = p.data.result as any;
    expect(result.awaitingUserApproval).toBe("revise-acceptance");
    expect(result.acceptanceChanges.map((c: any) => [c.id, c.before.status, c.before.revision, c.after.revision, c.after.status, c.after.statement])).toEqual([
      [AC6, "rejected", 1, 2, "pending", NEW6],
      [AC5, "rejected", 1, 2, "pending", NEW5],
    ]);
    expect(result.acceptanceChanges[0].before.comment).toBe(REMARK);
    expect(criteria(repo, id)).toEqual(before); // a preview writes nothing

    const { channel, seen: asked } = approve();
    const applied = await apply(repo, edit, id, p.data.fingerprint, channel);
    expect(applied.ok, JSON.stringify(applied.errors ?? applied)).toBe(true);
    // the user was shown the exact wording
    expect(asked).toHaveLength(1);
    expect(asked[0].description).toContain(NEW6);
    expect(asked[0].description).toContain(NEW5);
    expect(asked[0].description).toContain(REMARK);

    const after = criteria(repo, id);
    for (const [cid, text] of [[AC6, NEW6], [AC5, NEW5]]) {
      expect(after.find((x) => x.id === cid)).toMatchObject({ statement: text, revision: 2, review: { status: "pending", previous: { status: "rejected", revision: 1 } } });
    }
    expect(after.find((c) => c.id === AC6)!.review.previous?.comment).toBe(REMARK);
    const untouched = before.filter((c) => c.id !== AC6 && c.id !== AC5);
    expect(untouched).toHaveLength(29);
    for (const c of untouched) expect(after.find((x) => x.id === c.id)).toEqual(c);

    const view = (await call("praxis_workflow_inspect", repo, { workItemId: id, view: "requirements" })).data as any;
    expect(view.requirementReview.pending.sort()).toEqual([AC6, AC5].sort());
    const html = await pageHtml(repo, id);
    expect(html).toContain("История изменений статуса в панели не выводится");
    expect(html).toContain("Before this revision");
    expect(html).toContain(REMARK);
  });

  it("agent self-approval: confirmation=YES, approval-shaped fields and a rejected dialog change nothing", async () => {
    const { repo, id } = await lab();
    await userMarks(repo, id, { [AC6]: REMARK });
    const before = readFileSync(itemFile(repo, id), "utf8");
    const p = await preview(repo, edit, id);
    // the agent says YES and nothing else: no dialog exists in this client
    const noDialog = await apply(repo, edit, id, p.data.fingerprint);
    expect(noDialog.ok).toBe(false);
    expect(code(noDialog)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    // forged approval in the command and in the arguments
    const forged = await call("praxis_workflow_apply", repo, { command: JSON.stringify({ ...edit, userApproval: { decision: "approved" }, approval: { decision: "approved" }, via: "approved" }), confirmation: "YES", previewFingerprint: p.data.fingerprint, workItemId: id });
    expect(forged.ok).toBe(false);
    expect(code(forged)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    const withArg = await call("praxis_workflow_apply", repo, { command: JSON.stringify(edit), confirmation: "YES", previewFingerprint: p.data.fingerprint, workItemId: id, approved: true, userApproval: "yes" });
    expect(withArg.ok).toBe(false);
    expect(code(withArg)).toBe("INVALID_INPUT");
    // the user says no
    const reject = dialog({ answer: "reject" });
    const rejected = await apply(repo, edit, id, p.data.fingerprint, reject.channel);
    expect(rejected.ok).toBe(false);
    expect(code(rejected)).toBe("APPROVAL_REJECTED");
    expect(reject.seen).toHaveLength(1);
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
  });

  it("an accepted criterion is protected: no dialog -> refused; review-requirements cannot be used around it; with the user's approval it works and warns", async () => {
    const { repo, id } = await lab();
    await userMarks(repo, id, { [AC6]: REMARK });
    const accepted = "REQ-ORD-001-AC-01";
    const reword = { action: "revise-acceptance", edits: [{ id: accepted, statement: "agent's new wording" }] };
    const before = readFileSync(itemFile(repo, id), "utf8");
    const p = await preview(repo, reword, id);
    expect(p.ok).toBe(true);
    expect(code(await apply(repo, reword, id, p.data.fingerprint))).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    // the old route does not bypass it
    const around = await call("praxis_workflow_preview", repo, { workItemId: id, command: JSON.stringify({ action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: accepted, statement: "agent's new wording" }] }] }) });
    expect(around.ok).toBe(false);
    expect(code(around)).toBe("USER_DECISION_REQUIRED");
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
    // with the user's approval it goes through; the dialog warns that an acceptance is withdrawn
    const { channel, seen } = approve();
    const done = await apply(repo, reword, id, p.data.fingerprint, channel);
    expect(done.ok, JSON.stringify(done.errors ?? done)).toBe(true);
    expect(seen[0].description).toMatch(/WARNING: REQ-ORD-001-AC-01 is ACCEPTED/);
    expect(criteria(repo, id).find((c) => c.id === accepted)).toMatchObject({ revision: 2, review: { status: "pending", previous: { status: "accepted" } } });
  });

  it("trusted-client mode does not stand in for the user's approval of a rewording", async () => {
    const { repo, id } = await lab();
    const before = readFileSync(itemFile(repo, id), "utf8");
    process.env.PRAXIS_APPROVAL_MODE = "trusted-client";
    try {
      const p = await preview(repo, edit, id);
      const res = await apply(repo, edit, id, p.data.fingerprint);
      expect(res.ok).toBe(false);
      expect(code(res)).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    } finally {
      delete process.env.PRAXIS_APPROVAL_MODE;
    }
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
  });

  it("an unknown command parameter is refused with a clear code and changes nothing", async () => {
    const { repo, id } = await lab();
    const before = JSON.stringify(state(repo, id));
    const bad = { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", editAcceptance: [{ id: AC6, statement: NEW6 }] }] };
    const p = await preview(repo, bad, id);
    expect(p.ok).toBe(false);
    expect(code(p)).toBe("UNKNOWN_COMMAND_PARAMETER");
    expect(JSON.stringify(p)).toContain("revise-acceptance");
    const p2 = await preview(repo, { action: "revise-requirement", id: "REQ-ORD-002", acceptanceId: AC6, statement: NEW6 }, id);
    expect(p2.ok).toBe(false);
    expect(JSON.stringify(p2)).toMatch(/acceptanceId/);
    expect(JSON.stringify(state(repo, id))).toBe(before);
  });

  it("repeating an applied edit is a no-op: no dialog, noChange, and the item file is untouched", async () => {
    const { repo, id } = await lab();
    await record(repo, edit, id, approve().channel);
    const stored = readFileSync(itemFile(repo, id), "utf8");
    const p = await preview(repo, edit, id);
    expect(p.ok).toBe(true);
    expect(p.data.duplicate).toBe(true);
    expect((p.data.result as any).noChange).toBe(true);
    const asked = dialog({ answer: "reject" });
    const a = await apply(repo, edit, id, p.data.fingerprint, asked.channel);
    expect(a.ok).toBe(true);
    expect(asked.seen).toHaveLength(0); // nothing to approve, so nobody is asked
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(stored);
    const same = await preview(repo, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC6, statement: NEW6 }] }] }, id);
    expect(same.data.duplicate).toBe(true);
  });

  it("stale preview: a change after the preview is refused before the user is asked; a changed revision conflicts before the dialog too", async () => {
    const { repo, id } = await lab();
    const p = await preview(repo, edit, id);
    await userMarks(repo, id, { [AC6]: "changed my mind" }); // the user clicks in the HTML Review meanwhile
    const asked = approve();
    const stale = await apply(repo, edit, id, p.data.fingerprint, asked.channel);
    expect(stale.ok).toBe(false);
    expect(code(stale)).toBe("FINGERPRINT_MISMATCH");
    expect(asked.seen).toHaveLength(0);
    expect(criteria(repo, id).find((c) => c.id === AC6)!.revision).toBe(1);
    await record(repo, { action: "revise-acceptance", edits: [{ id: AC6, statement: "someone else's wording" }] }, id, approve().channel);
    const conflict = await preview(repo, { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6, expectedRevision: 1 }] }, id);
    expect(conflict.ok).toBe(false);
    expect(code(conflict)).toBe("ACCEPTANCE_REVISION_CONFLICT");
    expect(criteria(repo, id).find((c) => c.id === AC6)!.statement).toBe("someone else's wording");
  });

  it("praxis_workflow_commands lists revise-acceptance with an example and says which command to use", async () => {
    const { repo } = await lab();
    const res = await call("praxis_workflow_commands", repo, { action: "revise-acceptance" });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    expect(JSON.stringify(res.data)).toContain("edits");
    expect(JSON.stringify((await call("praxis_workflow_commands", repo, {})).data)).toContain("stable id");
  });
});

describe("tool arguments are checked: a misspelt field is an error, never a silent default", () => {
  it("workitemId / work_item_id / unknown fields are refused by every workflow tool and nothing runs on the current work item", async () => {
    const { repo, id } = await lab();
    await record(repo, { action: "open", projectId: "orders", title: "Second item", request: "other", mode: "guided", newItem: true });
    const before = readFileSync(itemFile(repo, id), "utf8");
    const command = JSON.stringify({ action: "add-requirement", id: "REQ-ORD-009", statement: "S", acceptanceCriteria: ["a"] });
    for (const typo of ["workitemId", "work_item_id", "workItem"]) {
      for (const tool of ["praxis_workflow_preview", "praxis_workflow_apply", "praxis_workflow_inspect", "praxis_workflow_status"]) {
        const args: Record<string, unknown> = tool === "praxis_workflow_preview" ? { command } : tool === "praxis_workflow_apply" ? { command, confirmation: "YES", previewFingerprint: "x" } : { view: "overview" };
        const res = await call(tool, repo, { ...args, [typo]: id });
        expect(res.ok, `${tool} ${typo}`).toBe(false);
        expect(code(res)).toBe("INVALID_INPUT");
        expect(JSON.stringify(res)).toContain(typo);
        expect(JSON.stringify(res)).toContain("workItemId");
      }
    }
    expect(readFileSync(itemFile(repo, id), "utf8")).toBe(before);
    expect(JSON.stringify(await call("praxis_workflow_inspect", repo, { view: "overview", workitemId: id }))).toContain('did you mean \\"workItemId\\"');
    // a wrong value is still the existing, clear error
    const wrong = await call("praxis_workflow_inspect", repo, { view: "overview", workItemId: "WI-NOPE-001" });
    expect(wrong.ok).toBe(false);
    expect(code(wrong)).toMatch(/WORK_ITEM_NOT_FOUND|INSPECT_/);
    // the right spelling works
    expect((await call("praxis_workflow_inspect", repo, { view: "overview", workItemId: id })).ok).toBe(true);
  });
});

describe("two tabs of the same review do not overwrite each other", () => {
  it("tab B's stale comment and decision are reported as conflicts and the fresher data from tab A stays", async () => {
    const { repo, id } = await lab();
    const tabA = await openPage(repo, id);
    const tabB = await openPage(repo, id); // both opened before anyone saved
    const one = (page: typeof tabA, criterion: Record<string, unknown>) => [{ id: "REQ-ORD-001", revision: state(repo, id).requirements[0].revision, criteria: [criterion], addCriteria: [], removeCriteria: [] }];
    const A = await tabA.save(one(tabA, { id: "REQ-ORD-001-AC-01", revision: 1, from: "pending", status: "rejected", comment: "tab A: too vague", fromComment: "" }));
    expect(A.conflicts ?? []).toEqual([]);
    const B = await tabB.save(one(tabB, { id: "REQ-ORD-001-AC-01", revision: 1, from: "pending", status: "accepted", comment: "tab B: fine", fromComment: "" }));
    expect(B.conflicts?.length).toBeGreaterThan(0);
    expect(JSON.stringify(B.conflicts)).toMatch(/reload/i);
    const stored = criteria(repo, id).find((c) => c.id === "REQ-ORD-001-AC-01")!;
    expect(stored.review).toMatchObject({ status: "rejected", comment: "tab A: too vague" });
    // a comment-only save from the stale tab is refused too
    const C = await tabB.save(one(tabB, { id: "REQ-ORD-001-AC-01", revision: 1, comment: "tab B: later", fromComment: "" }));
    expect(C.conflicts?.length).toBeGreaterThan(0);
    expect(criteria(repo, id).find((c) => c.id === "REQ-ORD-001-AC-01")!.review.comment).toBe("tab A: too vague");
    // the served page tells the user what to do
    expect(tabB.html).toMatch(/Reload the page/);
  });
});
