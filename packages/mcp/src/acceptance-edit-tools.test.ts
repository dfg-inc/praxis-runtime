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

const call = async (tool: string, repo: string, args: Record<string, unknown> = {}): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test" })) as McpEnvelope;
const preview = (repo: string, command: object, id: string) => call("praxis_workflow_preview", repo, { command: JSON.stringify(command), workItemId: id });
const apply = (repo: string, command: object, id: string, previewFingerprint: string) =>
  call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint, workItemId: id });
async function record(repo: string, command: object, id?: string) {
  const p = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command), ...(id ? { workItemId: id } : {}) });
  expect(p.ok, JSON.stringify(p.errors ?? p)).toBe(true);
  const a = await call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint: p.data.fingerprint, ...(id ? { workItemId: id } : {}) });
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

/** The user's own click path: render the page, read its token, post the marks. */
async function userMarks(repo: string, id: string, rejected: Record<string, string>) {
  const res = await call("praxis_review_render", repo, { view: "requirements", workItemId: id });
  expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  const data = res.data as { url: string; file: string };
  const secret = readFileSync(join(dirname(data.file), "requirements.url"), "utf8");
  const html = await (await fetch(secret)).text();
  const page = JSON.parse(html.match(/<script type="application\/json" id="praxis-data">([\s\S]*?)<\/script>/)![1]);
  const requirements = state(repo, id).requirements.map((r) => ({
    id: r.id,
    revision: r.revision,
    criteria: r.acceptanceCriteria.map((c) => (rejected[c.id] !== undefined ? { id: c.id, revision: c.revision, status: "rejected", comment: rejected[c.id] } : { id: c.id, revision: c.revision, status: "accepted" })),
    addCriteria: [],
    removeCriteria: [],
  }));
  const body = { contract: "praxis.review.submission", version: 1, reviewId: page.reviewId, view: "requirements", workItemId: id, baseFingerprint: page.baseFingerprint, requirements: { requirements, acceptAll: false } };
  const sent = await fetch(`${data.url.split("?")[0]}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(secret).origin, "x-praxis-review-token": page.token }, body: JSON.stringify(body) });
  expect(sent.status).toBe(200);
}
async function pageHtml(repo: string, id: string) {
  const res = await call("praxis_review_render", repo, { view: "requirements", workItemId: id });
  const data = res.data as { file: string };
  return (await fetch(readFileSync(join(dirname(data.file), "requirements.url"), "utf8"))).text();
}

const edit = { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }, { id: AC5, statement: NEW5 }] };
const REMARK = "Не нравится решение";

describe("one acceptance criterion changes by its id: preview, confirm, apply", () => {
  it("E2E: two rejected criteria get r2 and pending, the rejections stay as previous, the other 29 are untouched, the page shows it", async () => {
    const { repo, id } = await lab();
    expect(criteria(repo, id)).toHaveLength(31);
    await userMarks(repo, id, { [AC6]: REMARK, [AC5]: "Историю статусов не показываем" });
    const before = criteria(repo, id);
    // the BA reads the reasons through inspect, then proposes the two edits
    const seen = (await call("praxis_workflow_inspect", repo, { workItemId: id, view: "requirements" })).data as any;
    expect(seen.requirementReview.rejected.map((r: any) => r.criterionId).sort()).toEqual([AC6, AC5].sort());

    const p = await preview(repo, edit, id);
    expect(p.ok, JSON.stringify(p.errors ?? p)).toBe(true);
    const changes = (p.data.result as any).acceptanceChanges;
    expect(changes.map((c: any) => [c.id, c.before.status, c.before.revision, c.after.revision, c.after.status, c.after.statement])).toEqual([
      [AC6, "rejected", 1, 2, "pending", NEW6],
      [AC5, "rejected", 1, 2, "pending", NEW5],
    ]);
    expect(changes[0].before.comment).toBe(REMARK);
    // a preview writes nothing
    expect(criteria(repo, id)).toEqual(before);

    const applied = await apply(repo, edit, id, p.data.fingerprint);
    expect(applied.ok, JSON.stringify(applied.errors ?? applied)).toBe(true);
    const after = criteria(repo, id);
    for (const [cid, text] of [[AC6, NEW6], [AC5, NEW5]]) {
      const c = after.find((x) => x.id === cid)!;
      expect(c).toMatchObject({ statement: text, revision: 2, review: { status: "pending", previous: { status: "rejected", revision: 1 } } });
    }
    expect(after.find((c) => c.id === AC6)!.review.previous?.comment).toBe(REMARK);
    const untouched = before.filter((c) => c.id !== AC6 && c.id !== AC5);
    expect(untouched).toHaveLength(29);
    for (const c of untouched) expect(after.find((x) => x.id === c.id)).toEqual(c);

    const view = (await call("praxis_workflow_inspect", repo, { workItemId: id, view: "requirements" })).data as any;
    expect(view.requirementReview.pending.sort()).toEqual([AC6, AC5].sort());
    const shown = view.requirements.flatMap((r: any) => r.acceptanceCriteria).find((c: any) => c.id === AC6);
    expect(shown).toMatchObject({ statement: NEW6, revision: 2, review: { status: "pending", previous: { status: "rejected", comment: REMARK } } });

    const html = await pageHtml(repo, id);
    expect(html).toContain("История изменений статуса в панели не выводится");
    expect(html).toContain("Данные истории смены статусов для этой функциональности не требуются");
    expect(html).toContain("Before this revision");
    expect(html).toContain(REMARK);
  });

  it("an unknown parameter is refused with a clear code and changes nothing", async () => {
    const { repo, id } = await lab();
    const before = JSON.stringify(state(repo, id));
    const bad = { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", editAcceptance: [{ id: AC6, statement: NEW6 }] }] };
    const p = await preview(repo, bad, id);
    expect(p.ok).toBe(false);
    expect(p.code ?? p.errors?.[0]?.code ?? JSON.stringify(p)).toMatch(/UNKNOWN_COMMAND_PARAMETER/);
    expect(JSON.stringify(p)).toContain("revise-acceptance");
    const p2 = await preview(repo, { action: "revise-requirement", id: "REQ-ORD-002", acceptanceId: AC6, statement: NEW6 }, id);
    expect(p2.ok).toBe(false);
    expect(JSON.stringify(p2)).toMatch(/acceptanceId/);
    expect(JSON.stringify(state(repo, id))).toBe(before);
  });

  it("repeating an applied edit is a no-op: preview says noChange and apply leaves the item file and history as they were", async () => {
    const { repo, id } = await lab();
    await record(repo, edit, id);
    const file = join(repo, ".praxis", "workflow", "items", `${id}.json`);
    const stored = readFileSync(file, "utf8");
    const p = await preview(repo, edit, id);
    expect(p.ok).toBe(true);
    expect(p.data.duplicate).toBe(true);
    expect((p.data.result as any).noChange).toBe(true);
    expect((p.data.result as any).changedRequirementIds).toEqual([]);
    const a = await apply(repo, edit, id, p.data.fingerprint);
    expect(a.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(stored);
    // the same through the older route
    const same = await preview(repo, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC6, statement: NEW6 }] }] }, id);
    expect(same.data.duplicate).toBe(true);
    const req = await preview(repo, { action: "revise-requirement", id: "REQ-ORD-002", statement: state(repo, id).requirements.find((r) => r.id === "REQ-ORD-002")!.statement }, id);
    expect(req.data.duplicate).toBe(true);
  });

  it("a preview made before the user changed that criterion is refused; a re-read edit with expectedRevision conflicts", async () => {
    const { repo, id } = await lab();
    const p = await preview(repo, edit, id);
    // meanwhile the user marks the criteria in the HTML Review
    await userMarks(repo, id, { [AC6]: "changed my mind" });
    const stale = await apply(repo, edit, id, p.data.fingerprint);
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale)).toContain("FINGERPRINT_MISMATCH");
    expect(criteria(repo, id).find((c) => c.id === AC6)!.revision).toBe(1);
    // someone else edits AC-06 first; an edit that expected revision 1 is refused with the reason
    await record(repo, { action: "revise-acceptance", edits: [{ id: AC6, statement: "someone else's wording" }] }, id);
    const conflict = await preview(repo, { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6, expectedRevision: 1 }] }, id);
    expect(conflict.ok).toBe(false);
    expect(JSON.stringify(conflict)).toContain("ACCEPTANCE_REVISION_CONFLICT");
    expect(criteria(repo, id).find((c) => c.id === AC6)!.statement).toBe("someone else's wording");
  });

  it("praxis_workflow_commands lists revise-acceptance with an example and says which command to use", async () => {
    const { repo } = await lab();
    const res = await call("praxis_workflow_commands", repo, { action: "revise-acceptance" });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    const text = JSON.stringify(res.data);
    expect(text).toContain("revise-acceptance");
    expect(text).toContain("edits");
    const all = JSON.stringify((await call("praxis_workflow_commands", repo, {})).data);
    expect(all).toContain("stable id");
  });
});
