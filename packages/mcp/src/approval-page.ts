import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ApprovalError, logDecision, subjectDigest, USER_APPROVAL_TTL_MS, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";

/**
 * The Praxis approval page: the user's approval for a client that cannot show Praxis's dialog (Claude Desktop Chat, and the
 * Code tab, which answers the dialog by itself).
 *
 *   apply -> the Runtime opens a page in the user's browser -> the user reads the exact action and clicks Approve or Reject
 *         -> the same apply (called again, or still waiting) runs it, or reports the rejection
 *
 * What the agent can and cannot do:
 *  - The page's link carries a secret. It goes from the Runtime to the browser (through a short-lived file only the user can
 *    read) and never into a tool result, so the agent cannot open or click the page through Praxis's tools. Results carry
 *    only the request id.
 *  - A decision binds one action, the digest of its subject (what Praxis will act on) and the digest of the exact text the
 *    person read (the same text a dialog would show). A changed plan, or changed text, is another request: the old
 *    decision does not apply to it, and the user is asked again.
 *  - A decision is used once (the first call to take it; any other call waiting on the same click asks anew), within
 *    USER_APPROVAL_TTL_MS of the click; a request nobody decides expires.
 *  - The page is served on 127.0.0.1 on its own port (separate from the review pages), checks Host and Origin, takes JSON
 *    only, refuses framing, and needs a per-load token.
 *
 * What it is not (stated in results and docs/approval-threat-model.md): independent of a program running as the user. A
 * browser-automation tool connected to the browser that shows the page (Claude in Chrome) can click it, and a shell on the
 * same account can read the short-lived link file or Praxis's own files. Praxis cannot detect either. The page is consent for
 * an agent that uses Praxis's tools, at the same trust as a review-page Save; it is labelled "approval-page", never
 * "client-ui".
 */

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_NEW_PER_MINUTE = 6;
const MAX_TEXT = 200_000;

type PageRequest = {
  id: string;
  loadToken: string;
  saveTokens: Set<string>;
  key: string;
  repo?: string;
  action: string;
  summary: string;
  text: string;
  digest: string;
  client?: string;
  createdAt: number;
  expiresAt: number;
  openedAt?: number;
  status: "pending" | "approved" | "rejected";
  decidedAt?: number;
  reason?: string;
  consumed?: boolean;
  /** The browser could not be opened: everyone waiting on this request learns nobody could be asked. */
  failed?: string;
  waiters: Set<() => void>;
};

const requests = new Map<string, PageRequest>();
const created: number[] = [];
let server: Server | undefined;
let port = 0;

export const approvalPageEnabled = (): boolean => !/^(off|false|0|no)$/i.test(process.env.PRAXIS_APPROVAL_PAGE?.trim() ?? "");

/** How long an apply waits for the click before it answers APPROVAL_PENDING (kept under common client tool timeouts). */
export const approvalPageWaitMs = (): number => {
  const raw = Number(process.env.PRAXIS_APPROVAL_PAGE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 110_000) : 45_000;
};

/**
 * A decision binds the action, its subject and the exact text the person read: if either the subject or the shown text
 * differs (a changed plan, a changed patch, a different description), it is another request and is asked again.
 */
const keyOf = (request: ApprovalRequest, repo: string | undefined): string => `${repo ?? ""}\n${request.action}\n${subjectDigest(request.subject)}\n${subjectDigest(approvalPageText(request))}`;

/** The full text the user approves: the same words a client dialog would show, never shortened. */
export function approvalPageText(request: ApprovalRequest): string {
  return [request.summary, "", request.description, ...(request.risks?.length ? ["", "Risks:", ...request.risks.map((risk) => `- ${risk}`)] : [])].join("\n");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

const pageHeaders = (nonce: string) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

const STYLE = `body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:46em;margin:2em auto;padding:0 16px;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#161618}pre{background:#232326!important;border-color:#3a3a3e!important}.meta{color:#aaa!important}}
h1{font-size:1.35em;margin:.2em 0 .6em}pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f7;border:1px solid #d2d2d7;border-radius:8px;padding:14px;font:14px/1.45 ui-monospace,Menlo,monospace;max-height:60vh;overflow:auto}
.meta{color:#555;font-size:14px}.row{display:flex;gap:12px;flex-wrap:wrap;margin:1.2em 0}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #888;cursor:pointer}
#approve{background:#0a7d32;color:#fff;border-color:#0a7d32}#reject{background:#b3261e;color:#fff;border-color:#b3261e}button:disabled{opacity:.5;cursor:default}
input{font:inherit;width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #999}#result{font-weight:600;margin-top:1em}`;

function notOpenable(res: ServerResponse, id: string): void {
  const nonce = randomBytes(12).toString("base64");
  res.writeHead(403, pageHeaders(nonce));
  // a reload of the tab Praxis opened has dropped the secret from the address; that tab kept it, so it can open the page again
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Praxis approval</title><style>${STYLE}</style><body><h1>This approval link does not open here</h1><p>An approval page opens only in the browser tab Praxis opened for you, for ten minutes. If you closed that tab or the time ran out, ask Claude to apply the action again: Praxis opens a new page. Nothing was approved or rejected.</p><script nonce="${nonce}">try{var t=sessionStorage.getItem("praxis-approval-${id}");if(t&&!location.search)location.replace(location.pathname+"?t="+encodeURIComponent(t))}catch(e){}</script></body>`);
}

function renderPage(request: PageRequest, saveToken: string): { html: string; nonce: string } {
  const nonce = randomBytes(12).toString("base64");
  const decided = request.status !== "pending";
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Praxis approval</title><style>${STYLE}</style>
<body><p class="meta">Praxis approval request ${escapeHtml(request.id)}${request.client ? ` &middot; asked through ${escapeHtml(request.client)}` : ""}</p>
<h1>${escapeHtml(request.summary)}</h1>
<p>Praxis will run exactly the action below only if you approve it here. Nothing has run yet.</p>
<pre id="text">${escapeHtml(request.text)}</pre>
<p class="meta">Digest of exactly the text above ${escapeHtml(subjectDigest(request.text))}${request.repo ? `<br>Repository ${escapeHtml(request.repo)}` : ""}<br>This page stops accepting a decision at <span id="until"></span>.</p>
<p>Only you should press these buttons. If you did not ask Claude for this, choose Reject.</p>
<label for="reason">Reason (optional)</label><input id="reason" maxlength="300" autocomplete="off">
<div class="row"><button id="approve" type="button">Approve and run exactly this</button><button id="reject" type="button">Reject</button></div>
<p id="result" role="status">${decided ? `Already decided: ${escapeHtml(request.status)}. You can close this tab.` : ""}</p>
<script nonce="${nonce}">(function(){
var id=${JSON.stringify(request.id)},token=${JSON.stringify(saveToken)},until=${request.expiresAt},decided=${decided};
try{var q=new URLSearchParams(location.search).get("t");if(q)sessionStorage.setItem("praxis-approval-"+id,q);history.replaceState(null,"",location.pathname)}catch(e){}
document.getElementById("until").textContent=new Date(until).toLocaleTimeString();
var a=document.getElementById("approve"),r=document.getElementById("reject"),out=document.getElementById("result");
function done(text){a.disabled=r.disabled=true;out.textContent=text}
if(decided||Date.now()>until)done(out.textContent||"This request has expired. Ask Claude to apply the action again.");
function send(decision){a.disabled=r.disabled=true;out.textContent="Recording...";
fetch(location.pathname+"/decision",{method:"POST",headers:{"content-type":"application/json","x-praxis-approval-token":token},body:JSON.stringify({decision:decision,reason:document.getElementById("reason").value})})
.then(function(res){return res.json().then(function(b){return{ok:res.ok,b:b}})})
.then(function(x){if(x.ok)done(decision==="approve"?"Approved. Praxis runs exactly this action; you can close this tab and return to Claude.":"Rejected. Nothing runs; you can close this tab and return to Claude.");else done("Not recorded: "+(x.b&&x.b.error||"unknown error"))})
.catch(function(){done("Not recorded: Praxis is no longer running. Ask Claude to apply the action again.")})}
a.addEventListener("click",function(){send("approve")});r.addEventListener("click",function(){send("reject")});
})();</script></body></html>`;
  return { html: body, nonce };
}

function hostOk(req: IncomingMessage): boolean {
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function settle(request: PageRequest): void {
  for (const wake of request.waiters) wake();
  request.waiters.clear();
}

function expire(now = Date.now()): void {
  for (const [id, request] of requests) {
    const stale = request.status === "pending" ? now > request.expiresAt : request.consumed || now > (request.decidedAt ?? 0) + USER_APPROVAL_TTL_MS;
    if (!stale) continue;
    if (request.status === "pending") {
      logDecision(request.repo, { at: new Date(now).toISOString(), action: request.action, summary: request.summary, subjectDigest: request.digest, decision: "expired", decidedBy: "nobody", channel: "approval-page", evidence: { requestId: id }, reason: "the approval page was not answered in time" });
    }
    settle(request);
    requests.delete(id);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostOk(req)) return json(res, 403, { error: "bad host" });
  expire();
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const match = url.pathname.match(/^\/a\/([a-f0-9]{24})(\/decision)?$/);
  const request = match ? requests.get(match[1]) : undefined;
  if (!match || !request) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("This approval request is unknown or has expired. Ask Claude to apply the action again.");
    return;
  }
  if (req.method === "GET" && !match[2]) {
    if (!safeEqual(url.searchParams.get("t") ?? "", request.loadToken)) return notOpenable(res, request.id);
    const saveToken = randomBytes(24).toString("hex");
    request.saveTokens.add(saveToken);
    if (request.saveTokens.size > 10) request.saveTokens.delete(request.saveTokens.values().next().value as string);
    const { html, nonce } = renderPage(request, saveToken);
    res.writeHead(200, pageHeaders(nonce));
    res.end(html);
    return;
  }
  if (req.method === "POST" && match[2]) {
    const presented = String(req.headers["x-praxis-approval-token"] ?? "");
    if (![...request.saveTokens].some((token) => safeEqual(presented, token))) return json(res, 403, { error: "bad token" });
    // a browser always sends Origin on a fetch POST; one without it, or from another page, did not come from this page
    const origin = req.headers.origin;
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "bad origin" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "json only" });
    let parsed: { decision?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
      return json(res, 400, { error: "invalid body" });
    }
    if (parsed.decision !== "approve" && parsed.decision !== "reject") return json(res, 400, { error: "decision must be approve or reject" });
    // checked and set with no await in between: two tabs posting at once record one decision, never both
    if (request.status !== "pending" || !requests.has(request.id)) return json(res, 409, { error: `already ${request.status}` });
    if (Date.now() > request.expiresAt) return json(res, 410, { error: "this request has expired; ask Claude to apply the action again" });
    if (![...request.saveTokens].some((token) => safeEqual(presented, token))) return json(res, 403, { error: "bad token" });
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 300) : undefined;
    request.status = parsed.decision === "approve" ? "approved" : "rejected";
    request.decidedAt = Date.now();
    if (reason) request.reason = reason;
    request.saveTokens.clear();
    logDecision(request.repo, {
      at: new Date(request.decidedAt).toISOString(),
      action: request.action,
      summary: request.summary,
      subjectDigest: request.digest,
      decision: request.status,
      decidedBy: "user",
      channel: "approval-page",
      evidence: { requestId: request.id, via: "approval-page click", latencyMs: request.decidedAt - (request.openedAt ?? request.createdAt), ...(request.client ? { client: request.client } : {}) },
      ...(reason ? { reason } : {}),
    });
    settle(request);
    return json(res, 200, { recorded: request.status });
  }
  return json(res, 405, { error: "method not allowed" });
}

async function ensureServer(): Promise<number> {
  if (server && port) return port;
  server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: "internal error" }));
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

export function stopApprovalPages(): void {
  for (const request of requests.values()) settle(request);
  requests.clear();
  created.length = 0;
  server?.close();
  server = undefined;
  port = 0;
}

/**
 * Opens the secret link in the user's browser, never through a shell and never in the process list: the link goes into a
 * short-lived file only the user can read, which the browser opens. PRAXIS_APPROVAL_BROWSER (an extension setting, never
 * read from a repository) names another browser app on macOS (open -a), or an executable that is handed that file.
 */
export type PageOpener = (secretUrl: string) => Promise<boolean>;

export const openApprovalPage: PageOpener = async (secretUrl) => {
  const browser = process.env.PRAXIS_APPROVAL_BROWSER?.trim() ?? "";
  // a test run never opens a tab in the developer's own browser; a test that wants the page names its own opener
  if ((process.env.PRAXIS_TEST_REVIEW_NO_BROWSER === "1" || process.env.PRAXIS_TEST_APPROVALS === "1") && !browser) return false;
  const dir = mkdtempSync(join(tmpdir(), "praxis-approve-"));
  chmodSync(dir, 0o700);
  const page = join(dir, "open-approval.html");
  const safe = secretUrl.replace(/"/g, "&quot;");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening Praxis approval</title><meta http-equiv="refresh" content="0;url=${safe}"><p>Opening the approval page... <a href="${safe}">continue</a></p>`, { mode: 0o600 });
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 15_000).unref();
  let command: string;
  let args: string[];
  if (browser && isAbsolute(browser)) {
    if (!existsSync(browser) || !statSync(browser).isFile()) return false;
    [command, args] = [browser, [page]];
  } else if (process.platform === "darwin") {
    [command, args] = ["open", browser ? ["-a", browser, page] : [page]];
  } else if (process.platform === "win32") {
    [command, args] = ["explorer.exe", [page]];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    [command, args] = ["xdg-open", [page]];
  }
  return new Promise((done) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      // an opener that fails (no display, no such app) exits non-zero quickly; one still running after a moment has handed it on
      const timer = setTimeout(() => {
        child.unref();
        done(true);
      }, 1_500);
      child.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
};

let testOpener: PageOpener | undefined;
/** Tests only (PRAXIS_TEST_APPROVALS=1): receive the secret link instead of a browser. Not reachable from a tool call. */
export function setApprovalPageOpenerForTest(opener: PageOpener | undefined): void {
  if (process.env.PRAXIS_TEST_APPROVALS !== "1") throw new Error("setApprovalPageOpenerForTest is for tests only");
  testOpener = opener;
}

/** What a result may say about a page request: never its link or tokens. */
export function pageRequestView(id: string): { requestId: string; status: string; expiresAt: string; openedInBrowser: boolean } | undefined {
  const request = requests.get(id);
  return request ? { requestId: request.id, status: request.status, expiresAt: new Date(request.expiresAt).toISOString(), openedInBrowser: request.openedAt !== undefined } : undefined;
}

function waitForDecision(request: PageRequest, ms: number, signal?: AbortSignal): Promise<void> {
  if (request.status !== "pending" || ms <= 0) return Promise.resolve();
  return new Promise((resolveWait) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      request.waiters.delete(finish);
      resolveWait();
    };
    const timer = setTimeout(finish, Math.min(ms, Math.max(0, request.expiresAt - Date.now())));
    request.waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Takes the decision, once: the first caller gets it; anyone else waiting on the same click gets nothing (null). */
function takeDecision(request: PageRequest): AskAnswer | null {
  if (request.consumed || request.status === "pending") return null;
  request.consumed = true;
  const evidence = {
    requestId: request.id,
    via: "approval-page click",
    latencyMs: (request.decidedAt ?? 0) - (request.openedAt ?? request.createdAt),
    decidedAt: new Date(request.decidedAt ?? Date.now()).toISOString(),
    ...(request.client ? { client: request.client } : {}),
  };
  return { answer: request.status === "approved" ? "approve" : "reject", channel: "approval-page", evidence, journaled: true, ...(request.reason ? { reason: request.reason } : {}) };
}

/**
 * The approval-page channel for one tool call. `repo` is where the decision is journaled; `client` names the MCP client that
 * asked, for the page and the journal.
 */
export function approvalPageChannel(input: { repo?: string; client?: string; signal?: AbortSignal; waitMs?: number; open?: PageOpener }): UserApprovalChannel {
  return {
    kind: "approval-page",
    async ask(request: ApprovalRequest): Promise<AskAnswer> {
      // at most two rounds: a click that another waiting call took first is not this call's, and it asks anew
      for (let round = 0; round < 2; round += 1) {
        expire();
        const key = keyOf(request, input.repo);
        let live = [...requests.values()].find((r) => r.key === key && !r.consumed && !r.failed);
        if (live && live.status !== "pending") {
          const taken = takeDecision(live);
          if (taken) return taken;
          continue;
        }
        if (!live) {
          const now = Date.now();
          while (created.length && now - created[0]! > 60_000) created.shift();
          if (created.length >= MAX_NEW_PER_MINUTE) {
            throw new ApprovalError("APPROVAL_REQUIRED", `${request.summary} was NOT executed: ${MAX_NEW_PER_MINUTE} approval pages were opened in the last minute, which is more than a person asks for. Wait, then apply once; do not retry in a loop.`, { executed: false, channel: "approval-page" });
          }
          const text = approvalPageText(request);
          if (text.length > MAX_TEXT) {
            throw new ApprovalError("APPROVAL_TOO_LARGE", `${request.summary} was NOT executed: what you would approve is ${text.length} characters, more than one approval page shows in full (${MAX_TEXT}). Split it into smaller steps.`, { executed: false, channel: "approval-page" });
          }
          // registered before anything is awaited: a second call for the same action finds this request and waits on it
          const fresh: PageRequest = {
            id: randomBytes(12).toString("hex"),
            loadToken: randomBytes(24).toString("hex"),
            saveTokens: new Set(),
            key,
            ...(input.repo ? { repo: input.repo } : {}),
            action: request.action,
            summary: request.summary,
            text,
            digest: subjectDigest(request.subject),
            ...(input.client ? { client: input.client } : {}),
            createdAt: now,
            expiresAt: now + REQUEST_TTL_MS,
            status: "pending",
            waiters: new Set(),
          };
          live = fresh;
          requests.set(fresh.id, fresh);
          created.push(now);
          let opened = false;
          try {
            const p = await ensureServer();
            // the secret link goes to the browser only; the result names the request id
            opened = await (testOpener ?? input.open ?? openApprovalPage)(`http://127.0.0.1:${p}/a/${fresh.id}?t=${fresh.loadToken}`);
          } catch {
            opened = false;
          }
          if (!opened) {
            fresh.failed = "the Runtime could not open the approval page in a browser on this computer (no browser, no display, or it runs in a sandbox the user's browser cannot reach)";
            requests.delete(fresh.id);
            settle(fresh);
            return { answer: "unavailable", channel: "approval-page", reason: fresh.failed };
          }
          fresh.openedAt = Date.now();
          logDecision(input.repo, { at: new Date(fresh.openedAt).toISOString(), action: request.action, summary: request.summary, subjectDigest: fresh.digest, decision: "pending", decidedBy: "nobody", channel: "approval-page", evidence: { requestId: fresh.id, ...(input.client ? { client: input.client } : {}) }, reason: "the approval page was opened in the user's browser" });
        }
        await waitForDecision(live, input.waitMs ?? approvalPageWaitMs(), input.signal);
        if (live.failed) return { answer: "unavailable", channel: "approval-page", reason: live.failed };
        if (live.status !== "pending") {
          const taken = takeDecision(live);
          if (taken) return taken;
          continue;
        }
        throw new ApprovalError(
          "APPROVAL_PENDING",
          `${request.summary} is waiting for the user's decision in the Praxis approval page (request ${live.id}), which Praxis opened in their browser. Nothing has run and nobody has decided. Tell the user to read the action there and choose Approve or Reject, then call this tool again with the same arguments: it runs the action only if they approved. Do not open, search for or click that page yourself.`,
          { executed: false, journaled: true, channel: "approval-page", approvalPage: pageRequestView(live.id) },
        );
      }
      // two clicks in a row were taken by other waiting calls: this call asks nobody again in a loop
      throw new ApprovalError("APPROVAL_REQUIRED", `${request.summary} was NOT executed: the user's decision in the approval page was used by another call for the same action. Apply once more to get a new page.`, { executed: false, channel: "approval-page" });
    },
  };
}
