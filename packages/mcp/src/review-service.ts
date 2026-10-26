import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  acceptanceStatus,
  fingerprintFor,
  isUserDecision,
  nextStep,
  obtainUserApproval,
  renderReview,
  REVIEW_VIEWS,
  reviewApprovalRequest,
  reviewProgress,
  ReviewSubmissionSchema,
  storyReviewProgress,
  submissionToCommands,
  type ReviewConflict,
  type ReviewView,
  type WorkflowState,
} from "@praxis/contracts";
import { applyRuntimeCommand, loadWorkflow } from "./workflow-store.js";

/**
 * The HTML reviews. The page is a view; the workflow state is the source of truth. Decisions come back in one of two ways,
 * and only these two are accepted as the user's own:
 *  1. the user clicks Save in a page this Runtime served on 127.0.0.1 (a per-review token, a Host and Origin check);
 *  2. the user pastes or hands over the decisions file and approves them in the client's own approval dialog.
 * Without either, an agent can still edit the artifact, but cannot record that the user accepted anything.
 */

const IDLE_MS = 4 * 60 * 60 * 1000;
const MAX_BODY = 1_000_000;

type Session = { id: string; token: string; repo: string; workItemId: string; view: ReviewView; lastUsed: number };
const sessions = new Map<string, Session>();
let server: Server | undefined;
let port = 0;

export const isReviewView = (value: unknown): value is ReviewView => typeof value === "string" && (REVIEW_VIEWS as readonly string[]).includes(value);

export function reviewDir(repo: string, workItemId: string): string {
  return join(repo, ".praxis", "workflow", "reviews", workItemId);
}

function requireState(repo: string, workItemId?: string): WorkflowState {
  const state = loadWorkflow(repo, workItemId);
  if (!state) throw new Error("WORKFLOW_MISSING: open a work item first");
  return state;
}

function progressFor(state: WorkflowState, view: ReviewView) {
  switch (view) {
    case "requirements":
      return { ...reviewProgress(state), acceptance: acceptanceStatus(state, "requirements_review") };
    case "prototype":
      return { exists: Boolean(state.prototype), revision: state.prototype?.revision, acceptance: acceptanceStatus(state, "prototype"), openFeedback: state.prototype?.feedback.filter((f) => !f.resolved).length ?? 0 };
    case "story-plan":
      return { exists: Boolean(state.storyPlan), revision: state.storyPlan?.revision, entries: state.storyPlan?.entries.length ?? 0, acceptance: acceptanceStatus(state, "story_plan") };
    default:
      return { ...storyReviewProgress(state), acceptance: acceptanceStatus(state, "stories_review") };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- applying a submission -----------------------------------------------------------------------------------------

export type SubmissionOutcome = {
  applied: number;
  conflicts: ReviewConflict[];
  stale: boolean;
  summary: string[];
  progress: unknown;
  next: { phase: string; action: string; summary: string };
};

function outcome(repo: string, workItemId: string, view: ReviewView, applied: number, conflicts: ReviewConflict[], stale: boolean, summary: string[]): SubmissionOutcome {
  const state = requireState(repo, workItemId);
  const step = nextStep(state);
  return { applied, conflicts, stale, summary, progress: progressFor(state, view), next: { phase: state.phase, action: step.action, summary: step.summary } };
}

function note(repo: string, workItemId: string, view: ReviewView, how: string, summary: string[]): void {
  try {
    applyRuntimeCommand(repo, { action: "log-session", summary: `${view} review saved (${how}): ${summary.join("; ") || "no changes"}`, role: "ba" }, workItemId);
  } catch {
    /* the note is a convenience; the decisions are already recorded */
  }
}

/** The user clicked Save in the served page. The decisions are the user's own. */
export function applyFromPage(repo: string, workItemId: string, view: ReviewView, raw: unknown): SubmissionOutcome {
  const submission = ReviewSubmissionSchema.parse(raw);
  if (submission.view !== view || submission.workItemId !== workItemId) throw new Error("REVIEW_MISMATCH: this submission belongs to another review");
  const state = requireState(repo, workItemId);
  const plan = submissionToCommands(state, submission);
  const conflicts = [...plan.conflicts];
  let applied = 0;
  for (const command of plan.commands) {
    try {
      applyRuntimeCommand(repo, command, workItemId, { via: "html-review" });
      applied += 1;
    } catch (error) {
      conflicts.push({ item: String(command.action), reason: error instanceof Error ? error.message.replace(/^[A-Z_]+: /, "") : String(error) });
    }
  }
  if (applied > 0) note(repo, workItemId, view, "html page", plan.summary);
  return outcome(repo, workItemId, view, applied, conflicts, plan.stale, plan.summary);
}

/**
 * Decisions handed over outside the page. Edits apply as the agent's records; whatever records that the user accepted or
 * rejected needs the user's approval in the client's dialog, bound to exactly those decisions.
 */
export async function applyHandedOver(repo: string, workItemId: string | undefined, raw: unknown, confirmation: string | undefined): Promise<SubmissionOutcome> {
  const submission = ReviewSubmissionSchema.parse(raw);
  const id = workItemId ?? submission.workItemId;
  const state = requireState(repo, id);
  const plan = submissionToCommands(state, submission);
  const decisions = plan.commands.filter((c) => isUserDecision(c as never));
  let approval;
  if (decisions.length > 0) {
    const request = reviewApprovalRequest(decisions, `Record your ${submission.view} review decisions (${plan.summary.join("; ")})`);
    approval = await obtainUserApproval({ ...request, description: `${plan.summary.map((s) => `- ${s}`).join("\n")}\n\n${request.description}` }, { confirmation, repo });
  }
  const conflicts = [...plan.conflicts];
  let applied = 0;
  for (const command of plan.commands) {
    try {
      applyRuntimeCommand(repo, command, id, approval && isUserDecision(command as never) ? { via: "approved", approval, batch: decisions } : undefined);
      applied += 1;
    } catch (error) {
      conflicts.push({ item: String(command.action), reason: error instanceof Error ? error.message.replace(/^[A-Z_]+: /, "") : String(error) });
    }
  }
  if (applied > 0) note(repo, id, submission.view, approval ? "approved in the client dialog" : "edits only", plan.summary);
  return outcome(repo, id, submission.view, applied, conflicts, plan.stale, plan.summary);
}

export function readSubmissionFile(repo: string, file: string): unknown {
  const root = resolve(repo);
  const path = resolve(root, file);
  if (path !== root && !path.startsWith(`${root}${sep}`) && !path.startsWith(join(homedir(), "Downloads") + sep)) throw new Error("INVALID_INPUT: the decisions file must be inside the repository or in Downloads");
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- the loopback server -------------------------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function prune(): void {
  const now = Date.now();
  for (const [id, session] of sessions) if (now - session.lastUsed > IDLE_MS) sessions.delete(id);
}

function hostOk(req: IncomingMessage): boolean {
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  prune();
  if (!hostOk(req)) return json(res, 403, { error: "bad host" });
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const match = url.pathname.match(/^\/r\/([a-f0-9]{16})(\/submit)?$/);
  const session = match ? sessions.get(match[1]) : undefined;
  if (!match || !session) return json(res, 404, { error: "unknown or expired review" });
  session.lastUsed = Date.now();
  if (req.method === "GET" && !match[2]) {
    if (!safeEqual(url.searchParams.get("t") ?? "", session.token)) return json(res, 403, { error: "bad token" });
    try {
      const state = requireState(session.repo, session.workItemId);
      const html = renderReview(state, session.view, { reviewId: session.id, saveUrl: `http://127.0.0.1:${port}/r/${session.id}/submit`, token: session.token, generatedAt: new Date().toISOString() });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      });
      res.end(html);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (req.method === "POST" && match[2]) {
    if (!safeEqual(String(req.headers["x-praxis-review-token"] ?? ""), session.token)) return json(res, 403, { error: "bad token" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "bad origin" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "json only" });
    try {
      const result = applyFromPage(session.repo, session.workItemId, session.view, JSON.parse(await body(req)));
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return json(res, 405, { error: "method not allowed" });
}

async function ensureServer(): Promise<number> {
  if (server && port) return port;
  server = createServer((req, res) => {
    handle(req, res).catch((error) => json(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((ok, fail) => {
    server!.once("error", fail);
    server!.listen(0, "127.0.0.1", () => ok());
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  server.unref();
  return port;
}

export function stopReviewServer(): void {
  sessions.clear();
  server?.close();
  server = undefined;
  port = 0;
}

export async function renderReviewTool(repo: string, input: { view: string; workItemId?: string; serve?: boolean }) {
  if (!isReviewView(input.view)) throw new Error(`INVALID_INPUT: view must be one of ${REVIEW_VIEWS.join(", ")}`);
  const view = input.view;
  const state = requireState(repo, input.workItemId);
  const dir = reviewDir(repo, state.workItem.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${view}.html`);
  writeFileSync(file, renderReview(state, view, { reviewId: `${view}-${state.workItem.id}`, generatedAt: new Date().toISOString() }));
  let url: string | undefined;
  if (input.serve !== false) {
    const p = await ensureServer();
    const id = randomBytes(8).toString("hex");
    const token = randomBytes(24).toString("hex");
    sessions.set(id, { id, token, repo, workItemId: state.workItem.id, view, lastUsed: Date.now() });
    url = `http://127.0.0.1:${p}/r/${id}?t=${token}`;
  }
  return {
    view,
    workItemId: state.workItem.id,
    file,
    ...(url ? { url } : {}),
    fingerprint: fingerprintFor(state, view),
    progress: progressFor(state, view),
    how: url
      ? "Give the user this link to open in their browser. Clicking Save there records their decisions directly. The file is an offline copy: its Copy/Download buttons produce a decisions file, which praxis_review_apply records after the user approves it in the client's dialog."
      : "Offline copy only. Its Copy/Download buttons produce a decisions file for praxis_review_apply.",
    note: "The page is a view. The workflow state stays the source of truth; an agent cannot record the user's acceptance on their behalf.",
  };
}
