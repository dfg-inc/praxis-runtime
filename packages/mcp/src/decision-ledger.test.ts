import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fingerprintFor,
  repositoryKey as journalKey,
  reviewStamp,
  storyContentFingerprint,
  userChannelFor,
  workStateStamp,
  type ApprovalRequest,
  type AskAnswer,
  type UserApprovalChannel,
} from "@praxis/contracts";
import { appendDecisions, ledgerLocation, ledgerRoot, readDecisionLedger, repositoryKey } from "./decision-ledger.js";
import { callTool } from "./tools.js";
import { applyRuntimeCommand, loadWorkflow } from "./workflow-store.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

/**
 * R2 end to end in the Runtime: the decision ledger outside the repository is what makes an acceptance count. A forged,
 * copied, edited or replayed claim in the Work Item file does not open a gate; the legitimate flow (the client's dialog
 * approving in the same call) does; and a ledger that cannot be written stops the human act with the file unchanged.
 */

beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
});

const savedHome = process.env.PRAXIS_STATE_HOME;
afterEach(() => {
  process.env.PRAXIS_STATE_HOME = savedHome;
  delete process.env.PRAXIS_BUNDLE_KIND;
});

const call = async (tool: string, repo: string, args: Record<string, unknown> = {}, channel?: UserApprovalChannel): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: "test", approvalChannel: channel })) as McpEnvelope;

function dialog(answer: AskAnswer["answer"] = "approve") {
  const seen: ApprovalRequest[] = [];
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      return { answer };
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

async function project(dir?: string): Promise<{ repo: string; id: string; item: string }> {
  const repo = dir ?? mkdtempSync(join(tmpdir(), "praxis-ledger-"));
  const opened = await must(repo, { action: "open", projectId: "orders", title: "Order list", request: "Managers view orders", mode: "guided" });
  const id = opened.data.workItemId as string;
  await must(repo, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view orders", acceptanceCriteria: ["The list shows all orders", "Each row shows the order number"] }, id);
  return { repo, id, item: join(repo, ".praxis", "workflow", "items", `${id}.json`) };
}

/** The user's "accept all" in the requirements review, approved in the client's dialog. */
async function acceptAll(repo: string, id: string, channel = dialog().channel): Promise<McpEnvelope> {
  const s = loadWorkflow(repo, id)!;
  const submission = { contract: "praxis.review.submission", version: 1, reviewId: "t", view: "requirements", workItemId: id, baseFingerprint: fingerprintFor(s, "requirements"), baseStamp: reviewStamp(s, "requirements"), baseState: workStateStamp(s), requirements: { requirements: [], acceptAll: true } };
  return call("praxis_review_apply", repo, { submission: JSON.stringify(submission), confirmation: "YES", workItemId: id }, channel);
}

const status = async (repo: string, id: string) => (await call("praxis_workflow_status", repo, { workItemId: id })).data.acceptance as { integrity: Record<string, number>; independentVerification: string; subjects: Array<{ subject: string; integrity: string; reason: string }>; note: string };
const ledgerOf = (repo: string, id: string) => {
  const reading = readDecisionLedger(repo, id);
  return reading.status === "available" ? reading.entries : [];
};

/** What T-repo writes: acceptance in the item file, nothing anywhere else. */
function forge(item: string, edit: (state: any) => void): void {
  const state = JSON.parse(readFileSync(item, "utf8"));
  edit(state);
  writeFileSync(item, JSON.stringify(state, null, 2));
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=praxis-test", "-c", "user.email=praxis-test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !/^(PRAXIS_|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN)/.test(k))),
    stdio: "pipe",
  }).toString();

describe("the legitimate flow: accepted through the dialog, recorded outside the repository", () => {
  it("one ledger entry per criterion with one batch id, actionIds in the file, status accepted, the gate opens", async () => {
    const { repo, id, item } = await project();
    const { channel, seen } = dialog();
    const applied = await acceptAll(repo, id, channel);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    // the dialog showed every criterion in full
    expect(seen[0]!.description).toContain("REQ-ORD-001-AC-01 (REQ-ORD-001, revision 1): 'The list shows all orders'");
    expect(seen[0]!.description).toContain("REQ-ORD-001-AC-02 (REQ-ORD-001, revision 1): 'Each row shows the order number'");
    const entries = ledgerOf(repo, id);
    const accepts = entries.filter((e) => e.decision === "accept");
    expect(accepts.map((e) => `${e.subject.kind}:${e.subject.id}`).sort()).toEqual(["criterion:REQ-ORD-001-AC-01", "criterion:REQ-ORD-001-AC-02", "phase:requirements_review"]);
    expect(new Set(accepts.map((e) => e.batchId)).size).toBe(1);
    expect(accepts.every((e) => e.assurance === "client-response" && e.approval?.decidedBy === "client-dialog" && e.approval.personVerified === false && e.approval.independentlyVerified === false)).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/"independent"/);
    const stored = JSON.parse(readFileSync(item, "utf8"));
    for (const e of accepts) expect(stored.acceptanceActions[`${e.subject.kind}:${e.subject.id}`]).toBe(e.actionId);
    expect(stored.acceptanceIntegrity).toBeUndefined(); // the annotation is never written
    const integrity = await status(repo, id);
    expect(integrity).toMatchObject({ integrity: { accepted: 3, unverified: 0, invalid: 0, stale: 0 }, independentVerification: "unavailable" });
    expect(integrity.note).toMatch(/not proof that a person decided/);
    expect((await must(repo, { action: "advance-phase", to: "prototype" }, id)).ok).toBe(true);
  });

  it("the ledger is outside the repository, private, hash-chained, and keyed by the repository it reads", async () => {
    const { repo, id } = await project();
    await acceptAll(repo, id);
    const where = ledgerLocation(repo, id);
    if ("error" in where) throw new Error(where.error);
    expect(where.file.startsWith(join(ledgerRoot(), where.repositoryKey.key))).toBe(true);
    expect(where.file.startsWith(realpathSync(repo))).toBe(false);
    expect(where.repositoryKey.source).toBe("project-root");
    const { statSync } = await import("node:fs");
    expect(statSync(where.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(where.file)).mode & 0o777).toBe(0o700);
    const lines = readFileSync(where.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines[0].prev).toBe("0".repeat(64));
  });
});

describe("forged acceptance (T-repo writes the repository, not the ledger)", () => {
  it("criteria and the review acceptance written into the file read unverified; the gate refuses with ACCEPTANCE_UNVERIFIED", async () => {
    const { repo, id, item } = await project();
    const s = loadWorkflow(repo, id)!;
    forge(item, (state) => {
      for (const c of state.requirements[0].acceptanceCriteria) c.review = { status: "accepted", via: "approved", at: "2026-11-12T00:00:00.000Z" };
      state.phaseAcceptance = { requirements_review: { revision: state.workItem.revision, at: "2026-11-12T00:00:00.000Z", via: "approved", fingerprint: fingerprintFor(s, "requirements") } };
    });
    const integrity = await status(repo, id);
    expect(integrity.integrity).toMatchObject({ accepted: 0, unverified: 3 });
    const gate = await record(repo, { action: "advance-phase", to: "prototype" }, id);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe("ACCEPTANCE_UNVERIFIED");
    expect(gate.errors!.join(" ")).toMatch(/acceptance criterion REQ-ORD-001-AC-01 is marked accepted in the work item file/);
    const inspected = (await call("praxis_workflow_inspect", repo, { view: "requirements", workItemId: id })).data as any;
    expect(inspected.requirements[0].acceptanceCriteria.map((c: any) => c.integrity)).toEqual(["unverified", "unverified"]);
    expect(inspected.requirementReview.progress).toMatchObject({ accepted: 0, complete: false });
    // the file's own claims are never erased by a later write
    await must(repo, { action: "log-session", summary: "worked on it" }, id);
    expect(JSON.parse(readFileSync(item, "utf8")).requirements[0].acceptanceCriteria[0].review.status).toBe("accepted");
  });

  it("a forged actionId (copied from another criterion) reads invalid; an edited accepted text reads invalid", async () => {
    const { repo, id, item } = await project();
    const { channel } = dialog();
    const first = await call("praxis_review_apply", repo, { submission: JSON.stringify(submissionFor(repo, id, [{ id: "REQ-ORD-001-AC-01", revision: 1, from: "pending", status: "accepted" }])), confirmation: "YES", workItemId: id }, channel);
    expect(first.ok, JSON.stringify(first.errors)).toBe(true);
    forge(item, (state) => {
      state.requirements[0].acceptanceCriteria[1].review = { status: "accepted" };
      state.acceptanceActions["criterion:REQ-ORD-001-AC-02"] = state.acceptanceActions["criterion:REQ-ORD-001-AC-01"];
    });
    let subjects = (await status(repo, id)).subjects;
    expect(subjects.find((s) => s.subject === "criterion:REQ-ORD-001-AC-02")).toMatchObject({ integrity: "invalid" });
    expect(subjects.find((s) => s.subject === "criterion:REQ-ORD-001-AC-01")).toMatchObject({ integrity: "accepted" });
    forge(item, (state) => {
      state.requirements[0].acceptanceCriteria[0].statement = "The list shows only paid orders";
    });
    subjects = (await status(repo, id)).subjects;
    expect(subjects.find((s) => s.subject === "criterion:REQ-ORD-001-AC-01")).toMatchObject({ integrity: "invalid", reason: expect.stringMatching(/content changed/) });
  });

  it("a copy of the repository (another git common dir) reads every acceptance unverified; a linked worktree of the same repository reads them accepted", async () => {
    const base = mkdtempSync(join(tmpdir(), "praxis-ledger-git-"));
    const main = join(base, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    writeFileSync(join(main, "README.md"), "x\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "init");
    const { id } = await project(main);
    expect((await acceptAll(main, id)).ok).toBe(true);
    git(main, "add", "-A", ".praxis/workflow/items");
    git(main, "commit", "-q", "-m", "accepted");
    expect(repositoryKey(main).source).toBe("git-common-dir");
    // a linked worktree: same common dir, same ledger
    const linked = join(base, "linked");
    git(main, "worktree", "add", "-q", linked);
    expect(repositoryKey(linked).key).toBe(repositoryKey(main).key);
    expect((await status(linked, id)).integrity).toMatchObject({ accepted: 3, unverified: 0 });
    // a copy: its own .git, its own key, nothing backs its claims
    const copy = join(base, "copy");
    cpSync(main, copy, { recursive: true });
    expect(repositoryKey(copy).key).not.toBe(repositoryKey(main).key);
    expect((await status(copy, id)).integrity).toMatchObject({ accepted: 0, unverified: 3 });
    // a .git file planted to point at the original's worktree is not confirmed by git's back-pointer: keyed by its own root
    const planted = join(base, "planted");
    mkdirSync(planted);
    cpSync(join(main, ".praxis"), join(planted, ".praxis"), { recursive: true });
    writeFileSync(join(planted, ".git"), `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`);
    expect(repositoryKey(planted)).toMatchObject({ source: "project-root" });
    expect((await status(planted, id)).integrity).toMatchObject({ accepted: 0 });
    // the review's case: the planted .git names a git directory the planter wrote, with a commondir naming the original's
    // .git and a back-pointer naming the planted file itself. Not under the original's worktrees/: keyed by its own root
    const forged = join(base, "forged");
    mkdirSync(join(forged, "fakegit"), { recursive: true });
    cpSync(join(main, ".praxis"), join(forged, ".praxis"), { recursive: true });
    writeFileSync(join(forged, ".git"), "gitdir: fakegit\n");
    writeFileSync(join(forged, "fakegit", "commondir"), "../../main/.git\n");
    writeFileSync(join(forged, "fakegit", "gitdir"), `${join(forged, ".git")}\n`);
    expect(repositoryKey(forged)).toMatchObject({ source: "project-root" });
    expect(repositoryKey(forged).key).not.toBe(repositoryKey(main).key);
    expect((await status(forged, id)).integrity).toMatchObject({ accepted: 0, unverified: 3 });
    // and the journal names every one of these repositories exactly as the ledger does
    for (const dir of [main, linked, copy, planted, forged]) expect(repositoryKey(dir).key).toBe(journalKey(dir));
  });
});

describe("the ledger cannot be written or would be inside the repository: the human act fails closed, the file is unchanged", () => {
  it("a ledger that resolves inside the repository (here through a link) is refused (DECISION_LEDGER_UNAVAILABLE) and nothing reads as accepted", async () => {
    const { repo, id, item } = await project();
    // a state home whose ledger folder is a link into the repository: only the resolved path shows it
    const home = mkdtempSync(join(tmpdir(), "praxis-ledger-home-"));
    mkdirSync(join(repo, "planted-ledger"));
    symlinkSync(join(repo, "planted-ledger"), join(home, "ledger"));
    process.env.PRAXIS_STATE_HOME = home;
    const before = readFileSync(item);
    const applied = await acceptAll(repo, id);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("DECISION_LEDGER_UNAVAILABLE");
    expect(readFileSync(item).equals(before)).toBe(true);
    expect(readdirSync(join(repo, "planted-ledger"))).toEqual([]);
    expect(readDecisionLedger(repo, id)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/inside the repository/) });
  });

  it("an unwritable ledger directory (EACCES) stops the write with the item file byte-identical", async () => {
    const { repo, id, item } = await project();
    const where = ledgerLocation(repo, id);
    if ("error" in where) throw new Error(where.error);
    mkdirSync(dirname(where.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(where.file), 0o500);
    try {
      const before = readFileSync(item);
      const applied = await acceptAll(repo, id);
      expect(applied.ok).toBe(false);
      expect(applied.code).toBe("DECISION_LEDGER_UNAVAILABLE");
      expect(readFileSync(item).equals(before)).toBe(true);
    } finally {
      chmodSync(dirname(where.file), 0o700);
    }
  });

  it("a ledger edited by hand breaks the chain: every claim reads invalid and no new decision is appended to it", async () => {
    const { repo, id } = await project();
    await acceptAll(repo, id);
    const where = ledgerLocation(repo, id);
    if ("error" in where) throw new Error(where.error);
    const text = readFileSync(where.file, "utf8");
    writeFileSync(where.file, text.replace('"decision":"accept"', '"decision":"accept" '), { mode: 0o600 });
    expect((await status(repo, id)).integrity).toMatchObject({ accepted: 0, invalid: 3 });
    expect(() => appendDecisions(repo, id, [{ key: "mode:mode", subject: { kind: "mode", id: "mode" }, contentDigest: "sha256:x", decision: "revoke" }], null)).toThrow(/DECISION_LEDGER_UNAVAILABLE|corrupt/);
  });

  it("an append that never finished (no newline) is not part of the ledger", async () => {
    const { repo, id } = await project();
    await acceptAll(repo, id);
    const where = ledgerLocation(repo, id);
    if ("error" in where) throw new Error(where.error);
    writeFileSync(where.file, `${readFileSync(where.file, "utf8")}{"v":1,"seq":99`, { mode: 0o600 });
    expect((await status(repo, id)).integrity).toMatchObject({ accepted: 3 });
    appendDecisions(repo, id, [{ key: "mode:mode", subject: { kind: "mode", id: "mode" }, contentDigest: "sha256:x", decision: "revoke" }], null);
    expect(readDecisionLedger(repo, id)).toMatchObject({ status: "available" });
  });
});

describe("only an approval given in this call records an acceptance", () => {
  it("an approval made outside the call (a test helper, an object kept from elsewhere) writes the claim but the ledger never backs it", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-ledger-outside-"));
    const opened = applyRuntimeCommand(repo, { action: "open", projectId: "p", title: "Outside", request: "r", mode: "guided" });
    applyRuntimeCommand(repo, { action: "add-requirement", id: "REQ-OUT-001", statement: "Users can view things", acceptanceCriteria: ["A list is shown"] }, opened.workItemId);
    const command = { action: "accept-requirements", via: "approved" };
    applyRuntimeCommand(repo, command, opened.workItemId, userChannelFor(command));
    const s = loadWorkflow(repo, opened.workItemId)!;
    expect(s.requirements[0]!.acceptanceCriteria[0]!.review.status).toBe("accepted");
    expect(readDecisionLedger(repo, opened.workItemId)).toEqual({ status: "available", entries: [] });
    expect((s as any).acceptanceIntegrity.subjects["criterion:REQ-OUT-001-AC-01"].status).toBe("unverified");
  });

  it("a human act approved in the dialog is recorded for exactly its subject", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-ledger-act-"));
    await must(repo, { action: "open", projectId: "p", title: "Act", request: "r", mode: "classic" }, undefined, dialog().channel);
    const id = loadWorkflow(repo)!.workItem.id;
    await must(repo, { action: "add-requirement", id: "REQ-ACT-001", statement: "Users can view things", acceptanceCriteria: ["A list is shown"] }, id);
    await must(repo, { action: "add-story", id: "US-ACT-001", requirementIds: ["REQ-ACT-001"], actor: "user", narrative: "As a user, I want things, so that I see them.", objective: "o", userValue: "v", happyPath: ["look"], acceptanceCriteria: [{ id: "US-ACT-001-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["seen"], confirmedBehavior: false }, id);
    const story = loadWorkflow(repo, id)!.stories[0]!;
    await must(repo, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, id, dialog().channel);
    const accepts = ledgerOf(repo, id).filter((e) => e.decision === "accept").map((e) => `${e.subject.kind}:${e.subject.id}`);
    expect(accepts).toEqual(["mode:mode", "story:US-ACT-001"]);
    expect((await status(repo, id)).integrity).toMatchObject({ accepted: 2, unverified: 0 });
  });
});

describe("a 0.1.0-alpha.49.2 work item", () => {
  it("its acceptances read unverified, and accepting again through the review restores them", async () => {
    const { repo, id, item } = await project();
    expect((await acceptAll(repo, id)).ok).toBe(true);
    // what 49.2 wrote: the same claims, no acceptanceActions, and no ledger on this computer
    forge(item, (state) => {
      delete state.acceptanceActions;
    });
    expect((await status(repo, id)).integrity).toMatchObject({ accepted: 0, unverified: 3 });
    const rendered = (await call("praxis_review_render", repo, { view: "requirements", serve: false, workItemId: id })).data as { file: string };
    expect(readFileSync(rendered.file, "utf8")).toMatch(/not backed by a Praxis decision record on this computer/);
    const { channel, seen } = dialog();
    expect((await acceptAll(repo, id, channel)).ok).toBe(true);
    expect(seen[0]!.description).toContain("'The list shows all orders'");
    expect((await status(repo, id)).integrity).toMatchObject({ accepted: 3, unverified: 0 });
    expect((await must(repo, { action: "advance-phase", to: "prototype" }, id)).ok).toBe(true);
  });
});

describe("where the ledger is", () => {
  it("a production bundle takes the home directory from the account database, never from the environment", () => {
    process.env.PRAXIS_STATE_HOME = "/tmp/praxis-elsewhere";
    expect(ledgerRoot()).toBe("/tmp/praxis-elsewhere/ledger");
    process.env.PRAXIS_BUNDLE_KIND = "production";
    const saved = process.env.HOME;
    process.env.HOME = "/tmp/praxis-fake-home";
    try {
      expect(ledgerRoot()).toBe(join(userInfo().homedir, ".praxis", "ledger"));
    } finally {
      process.env.HOME = saved;
    }
  });
});

function submissionFor(repo: string, id: string, criteria: Array<Record<string, unknown>>) {
  const s = loadWorkflow(repo, id)!;
  return { contract: "praxis.review.submission", version: 1, reviewId: "t", view: "requirements", workItemId: id, baseFingerprint: fingerprintFor(s, "requirements"), baseStamp: reviewStamp(s, "requirements"), baseState: workStateStamp(s), requirements: { requirements: [{ id: "REQ-ORD-001", revision: s.requirements[0]!.revision, criteria }] } };
}
