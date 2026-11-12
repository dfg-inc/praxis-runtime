import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fingerprintFor, reviewStamp, storyContentFingerprint, workStateStamp, type ApprovalRequest, type UserApprovalChannel } from "@praxis/contracts";
import { readDecisionLedger } from "./decision-ledger.js";
import { sessionStart } from "./session-start.js";
import { callTool } from "./tools.js";
import { loadWorkflow } from "./workflow-store.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/**
 * Regression tests for the independent review of R2 (0.1.0-alpha.49.3), through the Runtime: what the dialog showed is what the
 * ledger records (a file switched while the dialog is open is refused, with no record), a revision on another worktree leaves
 * this one's acceptances alone, a duplicated id never counts, and status reports the mode in force. PRAXIS_STATE_HOME (set by the
 * test setup) keeps every ledger out of the account's ~/.praxis.
 */

beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
  expect(process.env.PRAXIS_STATE_HOME).toBeTruthy();
});

const call = async (tool: string, repo: string, args: Record<string, unknown> = {}, channel?: UserApprovalChannel): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", approvalChannel: channel })) as McpEnvelope;

/** A dialog that approves, after running `during` (a workspace writer acting while the dialog is open). */
function dialog(during?: () => void) {
  const seen: ApprovalRequest[] = [];
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      during?.();
      return { answer: "approve" };
    },
  };
  return { channel, seen };
}

async function record(repo: string, command: object, workItemId?: string, channel?: UserApprovalChannel): Promise<McpEnvelope> {
  const extra = workItemId ? { workItemId } : {};
  const previewed = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command), ...extra });
  if (!previewed.ok) return previewed;
  return call("praxis_workflow_apply", repo, { command: JSON.stringify(command), confirmation: "YES", previewFingerprint: previewed.data.fingerprint, ...extra }, channel);
}

async function must(repo: string, command: object, workItemId?: string, channel?: UserApprovalChannel): Promise<McpEnvelope> {
  const res = await record(repo, command, workItemId, channel);
  expect(res.ok, JSON.stringify(res.errors ?? res)).toBe(true);
  return res;
}

async function project(dir?: string, mode = "guided"): Promise<{ repo: string; id: string; item: string }> {
  const repo = dir ?? mkdtempSync(join(tmpdir(), "praxis-review-fix-"));
  const opened = await must(repo, { action: "open", projectId: "orders", title: "Order list", request: "Managers view orders", mode }, undefined, mode === "classic" ? dialog().channel : undefined);
  const id = opened.data.workItemId as string;
  await must(repo, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view orders", acceptanceCriteria: ["The list shows all orders", "Each row shows the order number"] }, id);
  return { repo, id, item: join(repo, ".praxis", "workflow", "items", `${id}.json`) };
}

async function acceptAll(repo: string, id: string, channel: UserApprovalChannel): Promise<McpEnvelope> {
  const s = loadWorkflow(repo, id)!;
  const submission = { contract: "praxis.review.submission", version: 1, reviewId: "t", view: "requirements", workItemId: id, baseFingerprint: fingerprintFor(s, "requirements"), baseStamp: reviewStamp(s, "requirements"), baseState: workStateStamp(s), requirements: { requirements: [], acceptAll: true } };
  return call("praxis_review_apply", repo, { submission: JSON.stringify(submission), confirmation: "YES", workItemId: id }, channel);
}

const ledgerOf = (repo: string, id: string) => {
  const reading = readDecisionLedger(repo, id);
  return reading.status === "available" ? reading.entries : [];
};
const status = async (repo: string, id: string) => (await call("praxis_workflow_status", repo, { workItemId: id })).data as any;

function edit(item: string, change: (state: any) => void): void {
  const state = JSON.parse(readFileSync(item, "utf8"));
  change(state);
  writeFileSync(item, JSON.stringify(state, null, 2));
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=praxis-test", "-c", "user.email=praxis-test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !/^(PRAXIS_|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN)/.test(k))),
    stdio: "pipe",
  }).toString();

describe("finding 2: the file switched from A to B while the dialog is open is refused, and nothing is recorded", () => {
  it("accept-all: a criterion added while the dialog shows the others is not accepted with them (REVIEW_CHANGED, no ledger record)", async () => {
    const { repo, id, item } = await project();
    const { channel, seen } = dialog(() =>
      edit(item, (state) => {
        state.requirements[0].acceptanceCriteria.push({ id: "REQ-ORD-001-AC-03", requirementId: "REQ-ORD-001", statement: "Admins export every customer's data", revision: 1, review: { status: "pending" } });
      }),
    );
    const applied = await acceptAll(repo, id, channel);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.description).not.toContain("AC-03");
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("REVIEW_CHANGED");
    expect(ledgerOf(repo, id)).toEqual([]);
    expect(JSON.parse(readFileSync(item, "utf8")).requirements[0].acceptanceCriteria.every((c: any) => c.review.status === "pending")).toBe(true);
  });

  it("accept-all: a criterion's text switched to B and back is still refused if B is what the write would read", async () => {
    const { repo, id, item } = await project();
    const original = readFileSync(item, "utf8");
    const { channel } = dialog(() => edit(item, (state) => (state.requirements[0].acceptanceCriteria[0].statement = "The list shows only paid orders")));
    const applied = await acceptAll(repo, id, channel);
    expect(applied.code).toBe("REVIEW_CHANGED");
    expect(ledgerOf(repo, id)).toEqual([]);
    // switched back to A: the same review is recorded for exactly A
    writeFileSync(item, original);
    const again = await acceptAll(repo, id, dialog().channel);
    expect(again.ok, JSON.stringify(again.errors)).toBe(true);
    expect(ledgerOf(repo, id).filter((e) => e.decision === "accept").map((e) => e.subject.id).sort()).toEqual(["REQ-ORD-001-AC-01", "REQ-ORD-001-AC-02", "requirements_review"]);
  });

  it("confirm-story: business rules changed while the dialog shows the story are refused, with no ledger record", async () => {
    const { repo, id, item } = await project(undefined, "classic");
    await must(repo, { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want to view orders, so that I can work.", objective: "see orders", userValue: "v", happyPath: ["open the list"], businessRules: ["only managers"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["shown"], confirmedBehavior: false }, id);
    const before = ledgerOf(repo, id).length;
    const story = loadWorkflow(repo, id)!.stories[0]!;
    const { channel, seen } = dialog(() => edit(item, (state) => (state.stories[0].businessRules = ["FORGED: admins skip the permission check"])));
    const res = await record(repo, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, id, channel);
    expect(seen[0]!.description).toContain("only managers");
    expect(res.ok).toBe(false);
    expect(["FINGERPRINT_MISMATCH", "APPROVAL_SCOPE_MISMATCH"]).toContain(res.code);
    expect(ledgerOf(repo, id).length).toBe(before);
    expect(JSON.parse(readFileSync(item, "utf8")).stories[0].confirmedBehavior).toBe(false);
  });
});

describe("finding 3: a worktree's revision leaves another worktree's accepted content accepted", () => {
  it("an agent's revise-requirement on a linked worktree does not invalidate main's acceptances (shared ledger)", async () => {
    const base = mkdtempSync(join(tmpdir(), "praxis-review-wt-"));
    const main = join(base, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    writeFileSync(join(main, "README.md"), "x\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "init");
    const { id } = await project(main);
    expect((await acceptAll(main, id, dialog().channel)).ok).toBe(true);
    git(main, "add", "-A", ".praxis/workflow");
    git(main, "commit", "-q", "-m", "accepted");
    const linked = join(base, "linked");
    git(main, "worktree", "add", "-q", "-b", "rework", linked);
    await must(linked, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "Managers can view all orders" }] }, id);
    expect(ledgerOf(main, id).at(-1)).toMatchObject({ decision: "supersede" });
    expect((await status(main, id)).acceptance.integrity).toMatchObject({ accepted: 3, unverified: 0, invalid: 0 });
    expect((await must(main, { action: "advance-phase", to: "prototype" }, id)).ok).toBe(true);
  });
});

describe("finding 1: a duplicated id in the file counts for nothing", () => {
  it("a forged copy of an accepted criterion makes both copies invalid", async () => {
    const { repo, id, item } = await project();
    expect((await acceptAll(repo, id, dialog().channel)).ok).toBe(true);
    edit(item, (state) => {
      const genuine = state.requirements[0].acceptanceCriteria[0];
      state.requirements[0].acceptanceCriteria.unshift({ ...genuine, statement: "FORGED: managers see every region" });
    });
    const subjects = (await status(repo, id)).acceptance.subjects as Array<{ subject: string; integrity: string; reason: string }>;
    expect(subjects.find((s) => s.subject === "criterion:REQ-ORD-001-AC-01")).toMatchObject({ integrity: "invalid", reason: expect.stringMatching(/duplicate id/) });
    const gate = await record(repo, { action: "advance-phase", to: "prototype" }, id);
    // the copy also changed what the requirements review covers, so the gate names both: the stale review and the invalid criterion
    expect(gate.ok).toBe(false);
    expect(gate.errors!.join(" ")).toMatch(/ACCEPTANCE_INVALID: acceptance criterion REQ-ORD-001-AC-01 is marked accepted/);
  });
});

describe("finding 7: status and session start report the mode in force", () => {
  it("a classic mode written into the file reads guided, with the claim's integrity", async () => {
    const { repo, id, item } = await project();
    edit(item, (state) => (state.mode = "classic"));
    const s = await status(repo, id);
    expect(s.mode).toBe("guided");
    expect(s.modeIntegrity).toBe("unverified");
    expect(s.modeNote).toMatch(/not backed by a Praxis decision record/);
    const started = (await sessionStart(repo, { role: "ba" }, "test")) as any;
    expect(started.resume).toMatchObject({ mode: "guided", modeIntegrity: "unverified" });
  });

  it("a classic mode the user chose in the dialog reads classic, accepted", async () => {
    const { repo, id } = await project(undefined, "classic");
    const s = await status(repo, id);
    expect([s.mode, s.modeIntegrity]).toEqual(["classic", "accepted"]);
    expect(s.workItems.find((w: any) => w.workItemId === id).mode).toBe("classic");
  });
});
