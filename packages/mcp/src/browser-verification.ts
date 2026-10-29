import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "./project-code-runner.js";

/**
 * Browser verification. A check in checks.json of level "browser" is DATA (a list of steps and assertions), never code:
 * the Runtime does not execute anything the project wrote. A Praxis-owned driver, in its own process with a scrubbed
 * environment, serves the project's already built bundle on a loopback port, drives a real Chromium through Playwright
 * (resolved from the operator's PRAXIS_PLAYWRIGHT_DIR or from the project), allows no request outside that loopback origin,
 * and returns what it saw. The result is recorded by the Runtime as `browser` evidence bound to the exact scenario, the
 * digest of the bundle that was served, the runner and the screenshots' digests. An agent cannot produce that record:
 * record-verification from an agent is stored as agent-attested.
 */

const ACTIONS = ["goto", "click", "fill", "select", "press", "back", "forward", "reload", "viewport"] as const;
const ASSERTIONS = ["expectUrl", "expectCount", "expectVisible", "expectHidden", "expectText", "expectValue", "expectFocus"] as const;
const MAX_STEPS = 60;
const SELECTOR = /^[^\0]{1,300}$/;

export type BrowserStep = Record<string, unknown>;
export type BrowserConfig = { serve: { root: string; spa?: boolean }; viewport?: { width: number; height: number } };

function bad(scenarioId: string, why: string): never {
  throw new Error(`CHECKS_INVALID: browser check ${scenarioId}: ${why}`);
}
const str = (v: unknown, max = 300) => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const rec = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Every step names exactly one known action or assertion with the shape it needs; nothing else is accepted. */
export function validateBrowserSteps(scenarioId: string, steps: unknown): BrowserStep[] {
  if (!Array.isArray(steps) || steps.length === 0) bad(scenarioId, "needs a non-empty steps list");
  if (steps.length > MAX_STEPS) bad(scenarioId, `has more than ${MAX_STEPS} steps`);
  steps.forEach((step, i) => {
    if (!rec(step)) bad(scenarioId, `step ${i + 1} is not an object`);
    const keys = Object.keys(step);
    if (keys.length !== 1) bad(scenarioId, `step ${i + 1} must have exactly one of ${[...ACTIONS, ...ASSERTIONS].join(", ")}`);
    const kind = keys[0]!;
    const v = step[kind];
    const sel = (x: unknown) => str(x) && SELECTOR.test(x as string);
    switch (kind) {
      case "goto":
        if (!str(v) || !/^[/?#]/.test(v as string) || /^\/\//.test(v as string)) bad(scenarioId, `step ${i + 1} goto must be a path or query on the served app (starting with / or ?), never an address`);
        break;
      case "click":
      case "expectVisible":
      case "expectHidden":
      case "expectFocus":
        if (!sel(v)) bad(scenarioId, `step ${i + 1} ${kind} needs a selector`);
        break;
      case "fill":
      case "select":
        if (!rec(v) || !sel(v.selector) || typeof v.value !== "string" || (v.value as string).length > 500) bad(scenarioId, `step ${i + 1} ${kind} needs {selector, value}`);
        break;
      case "press":
        if (!(str(v, 40) || (rec(v) && str(v.key, 40) && (v.selector === undefined || sel(v.selector))))) bad(scenarioId, `step ${i + 1} press needs a key (or {key, selector})`);
        break;
      case "back":
      case "forward":
      case "reload":
        if (v !== true) bad(scenarioId, `step ${i + 1} ${kind} must be true`);
        break;
      case "viewport":
        if (!rec(v) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || (v.width as number) < 200 || (v.width as number) > 3000 || (v.height as number) < 200 || (v.height as number) > 3000) bad(scenarioId, `step ${i + 1} viewport needs integer width and height (200-3000)`);
        break;
      case "expectUrl":
        if (!rec(v) || (v.path !== undefined && !str(v.path)) || (v.hash !== undefined && typeof v.hash !== "string") || (v.query !== undefined && !(rec(v.query) && Object.values(v.query).every((x) => typeof x === "string"))) || (v.absent !== undefined && !(Array.isArray(v.absent) && v.absent.every((x) => str(x, 80)))))
          bad(scenarioId, `step ${i + 1} expectUrl takes {path?, hash?, query?: {name: value}, absent?: [name]}`);
        break;
      case "expectCount":
        if (!rec(v) || !sel(v.selector) || !Number.isInteger(v.equals) || (v.equals as number) < 0) bad(scenarioId, `step ${i + 1} expectCount needs {selector, equals}`);
        break;
      case "expectText":
        if (!rec(v) || !sel(v.selector) || !(str(v.contains, 500) || str(v.notContains, 500))) bad(scenarioId, `step ${i + 1} expectText needs {selector, contains | notContains}`);
        break;
      case "expectValue":
        if (!rec(v) || !sel(v.selector) || typeof v.equals !== "string") bad(scenarioId, `step ${i + 1} expectValue needs {selector, equals}`);
        break;
      default:
        bad(scenarioId, `step ${i + 1} uses "${kind}", which is not an action or assertion Praxis drives`);
    }
  });
  return steps as BrowserStep[];
}

export function validateBrowserConfig(raw: unknown): BrowserConfig {
  if (!rec(raw) || !rec(raw.serve) || !str(raw.serve.root)) throw new Error('CHECKS_INVALID: "browser" needs {"serve": {"root": "<directory of the built app>"}}');
  const viewport = raw.viewport;
  if (viewport !== undefined && !(rec(viewport) && Number.isInteger(viewport.width) && Number.isInteger(viewport.height))) throw new Error("CHECKS_INVALID: browser.viewport needs integer width and height");
  return { serve: { root: raw.serve.root as string, ...(raw.serve.spa === false ? { spa: false } : { spa: true }) }, ...(viewport ? { viewport: viewport as { width: number; height: number } } : {}) };
}

export type BrowserScenarioResult = {
  ok: boolean;
  steps: number;
  failed?: { index: number; kind: string; message: string };
  finalUrl: string;
  consoleErrors: number;
  blockedRequests: string[];
  screenshot?: { path: string; sha256: string; bytes: number };
};
export type BrowserRun =
  | { available: false; reason: string }
  | { available: true; runner: string; browserVersion: string; subjectDigest: string; startedAt: string; finishedAt: string; results: Record<string, BrowserScenarioResult> };

const DRIVER = String.raw`
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
const input = JSON.parse(readFileSync(0, "utf8"));
const NONCE = input.nonce;
const out = (value) => { process.stdout.write("\n__PRAXIS_RESULT__" + NONCE + "__" + JSON.stringify(value) + "\n", () => process.exit(0)); };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".txt": "text/plain" };
function within(root, p) { return p === root || p.startsWith(root + sep); }
function containedDir(base, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) throw new Error("UNSAFE_PATH");
  const realBase = realpathSync(resolve(base));
  const real = realpathSync(resolve(realBase, rel));
  if (!within(realBase, real)) throw new Error("UNSAFE_PATH");
  return real;
}
function digestOf(root) {
  const entries = [];
  let bytes = 0;
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { visit(p); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (entries.length >= 5000 || bytes > 200 * 1024 * 1024) throw new Error("BUNDLE_TOO_LARGE");
      entries.push(relative(root, p).split(sep).join("/") + "\0" + createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  visit(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
function loadPlaywright() {
  for (const dir of input.playwrightDirs) {
    try { return createRequire(join(dir, "noop.js"))("playwright-core"); } catch { /* try the next place */ }
  }
  return null;
}
async function main() {
  const startedAt = new Date().toISOString();
  const pw = loadPlaywright();
  if (!pw) return out({ ok: true, result: { available: false, reason: "playwright-core was not found: the operator sets PRAXIS_PLAYWRIGHT_DIR to a directory whose node_modules has it (it is never taken from the project under test)" } });
  let root;
  try { root = containedDir(input.serviceRoot, input.serve.root); } catch { return out({ ok: true, result: { available: false, reason: "browser.serve.root is missing or outside the service directory: build the app first" } }); }
  if (!existsSync(join(root, "index.html"))) return out({ ok: true, result: { available: false, reason: "browser.serve.root has no index.html: build the app first" } });
  const subjectDigest = digestOf(root);
  const server = createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      const url = new URL(req.url, "http://localhost");
      let p = decodeURIComponent(url.pathname);
      let file = resolve(root, "." + (p.endsWith("/") ? p + "index.html" : p));
      if (!within(root, file)) { res.writeHead(403); return res.end(); }
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (input.serve.spa && !extname(p)) file = join(root, "index.html"); else { res.writeHead(404); return res.end(); }
      }
      if (lstatSync(file).isSymbolicLink() || !within(root, realpathSync(file))) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + server.address().port;
  let browser;
  try {
    if (typeof pw.chromium.launch !== "function") throw new Error("playwright-core without chromium");
    browser = await pw.chromium.launch({ headless: true, chromiumSandbox: !input.noSandbox, ...(input.executable ? { executablePath: input.executable } : {}) });
  } catch (error) {
    server.close();
    return out({ ok: true, result: { available: false, reason: "no browser could be started (" + String((error && error.message) || error).split("\n")[0].slice(0, 200) + "): install Chrome or set PRAXIS_BROWSER_EXECUTABLE" } });
  }
  process.on("SIGTERM", async () => { try { await browser.close(); } catch { /* going down anyway */ } process.exit(1); });
  const results = {};
  const wait = async (fn, ms = 3000) => { const end = Date.now() + ms; let last; for (;;) { try { const v = await fn(); if (v === true) return; last = v; } catch (e) { last = String((e && e.message) || e); } if (Date.now() > end) throw new Error(typeof last === "string" ? last : "condition not met"); await new Promise((r) => setTimeout(r, 50)); } };
  for (const check of input.checks) {
    const context = await browser.newContext({ viewport: input.viewport || { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false });
    const blocked = [];
    await context.route("**/*", (route) => { const u = route.request().url(); if (u.startsWith(origin + "/") || u === origin || u.startsWith("data:") || u.startsWith("blob:")) return route.continue(); blocked.push(u.slice(0, 120)); return route.abort(); });
    if (typeof context.routeWebSocket !== "function") { await context.close(); await browser.close(); server.close(); return out({ ok: true, result: { available: false, reason: "this Playwright cannot block WebSocket connections (routeWebSocket is missing): use playwright-core 1.48 or newer" } }); }
    await context.routeWebSocket(/.*/, (ws) => { blocked.push("websocket " + String(ws.url()).slice(0, 100)); ws.close(); });
    const page = await context.newPage();
    let consoleErrors = 0;
    page.on("console", (m) => { if (m.type() === "error") consoleErrors += 1; });
    page.on("pageerror", () => { consoleErrors += 1; });
    let failed;
    let index = 0;
    for (const step of check.steps) {
      index += 1;
      const kind = Object.keys(step)[0];
      const v = step[kind];
      try {
        switch (kind) {
          case "goto": await page.goto(origin + v, { timeout: 8000 }); break;
          case "click": await page.locator(v).click({ timeout: 5000 }); break;
          case "fill": await page.locator(v.selector).fill(v.value, { timeout: 5000 }); break;
          case "select": await page.locator(v.selector).selectOption(v.value, { timeout: 5000 }); break;
          case "press": if (typeof v === "string") await page.keyboard.press(v); else { if (v.selector) await page.locator(v.selector).focus({ timeout: 5000 }); await page.keyboard.press(v.key); } break;
          case "back": await page.goBack({ timeout: 5000 }); break;
          case "forward": await page.goForward({ timeout: 5000 }); break;
          case "reload": await page.reload({ timeout: 8000 }); break;
          case "viewport": await page.setViewportSize(v); break;
          case "expectUrl": await wait(() => {
            const u = new URL(page.url());
            if (v.path !== undefined && u.pathname !== v.path) return "path is " + u.pathname + ", expected " + v.path;
            if (v.hash !== undefined && u.hash !== v.hash) return "hash is " + u.hash + ", expected " + v.hash;
            for (const [k, want] of Object.entries(v.query || {})) { const got = u.searchParams.get(k); if (got !== want) return "?" + k + " is " + JSON.stringify(got) + ", expected " + JSON.stringify(want); }
            for (const k of v.absent || []) if (u.searchParams.has(k)) return "?" + k + " is still in the URL";
            return true;
          }); break;
          case "expectCount": await wait(async () => { const n = await page.locator(v.selector).count(); return n === v.equals ? true : v.selector + " matches " + n + ", expected " + v.equals; }); break;
          case "expectVisible": await wait(async () => (await page.locator(v).first().isVisible()) ? true : v + " is not visible"); break;
          case "expectHidden": await wait(async () => { const l = page.locator(v); return (await l.count()) === 0 || !(await l.first().isVisible()) ? true : v + " is visible"; }); break;
          case "expectText": await wait(async () => { const t = (await page.locator(v.selector).first().innerText({ timeout: 1000 })) || ""; if (v.contains !== undefined && !t.includes(v.contains)) return v.selector + " does not contain " + JSON.stringify(v.contains); if (v.notContains !== undefined && t.includes(v.notContains)) return v.selector + " still contains " + JSON.stringify(v.notContains); return true; }); break;
          case "expectValue": await wait(async () => { const t = await page.locator(v.selector).first().inputValue({ timeout: 1000 }); return t === v.equals ? true : v.selector + " is " + JSON.stringify(t) + ", expected " + JSON.stringify(v.equals); }); break;
          case "expectFocus": await wait(async () => (await page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), v)) ? true : "focus is not on " + v); break;
          default: throw new Error("unknown step");
        }
      } catch (error) {
        failed = { index, kind, message: String((error && error.message) || error).split("\n")[0].slice(0, 300) };
        break;
      }
    }
    if (!failed && blocked.length) failed = { index: check.steps.length, kind: "network", message: "the app tried to reach outside the served origin: " + blocked[0] };
    let screenshot;
    try {
      const png = await page.screenshot({ fullPage: false });
      const sha256 = createHash("sha256").update(png).digest("hex");
      screenshot = { sha256, bytes: png.length };
      if (input.artifactsDir) {
        mkdirSync(input.artifactsDir, { recursive: true });
        const name = createHash("sha256").update(check.scenarioId).digest("hex").slice(0, 8) + "-" + check.scenarioId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) + ".png";
        writeFileSync(join(input.artifactsDir, name), png);
        screenshot.path = name;
      }
    } catch { /* no screenshot */ }
    results[check.scenarioId] = { ok: !failed, steps: check.steps.length, ...(failed ? { failed } : {}), finalUrl: (() => { try { const u = new URL(page.url()); return u.pathname + u.search + u.hash; } catch { return ""; } })(), consoleErrors, blockedRequests: blocked, ...(screenshot ? { screenshot } : {}) };
    await context.close();
  }
  const browserVersion = browser.version();
  await browser.close();
  server.close();
  out({ ok: true, result: { available: true, runner: "playwright-chromium", browserVersion, subjectDigest, startedAt, finishedAt: new Date().toISOString(), results } });
}
main().catch((error) => out({ ok: false, error: String((error && error.message) || error) }));
`;

const DEFAULT_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export type BrowserRunInput = {
  serviceRoot: string;
  config: BrowserConfig;
  checks: Array<{ scenarioId: string; steps: BrowserStep[] }>;
  /** Kept for callers; ignored: see PRAXIS_PLAYWRIGHT_DIR. */
  playwrightDirs?: string[];
  /** When set, screenshots are written here (apply). A preview passes nothing and writes nothing. */
  artifactsDir?: string;
  timeoutMs?: number;
};

/**
 * Chromium and its helpers do not share the driver's process group. Everything the run started carries the run's private
 * HOME/TMPDIR in its command line, so whatever still lives after the run is found by that path and stopped.
 */
function sweepProcesses(home: string): void {
  try {
    const listing = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).stdout ?? "";
    for (const line of listing.split("\n")) {
      if (!line.includes(home)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone already */
        }
      }
    }
  } catch {
    /* best effort: the result is already decided */
  }
}

export async function runBrowserChecks(input: BrowserRunInput): Promise<BrowserRun> {
  const home = mkdtempSync(join(tmpdir(), "praxis-browser-"));
  const { existsSync } = await import("node:fs");
  const executable = process.env.PRAXIS_BROWSER_EXECUTABLE || DEFAULT_EXECUTABLES.find((p) => existsSync(p));
  // Playwright runs inside the driver process: it comes from a directory the OPERATOR names, never from the project under test (that code is agent-writable)
  const playwrightDirs = process.env.PRAXIS_PLAYWRIGHT_DIR ? [process.env.PRAXIS_PLAYWRIGHT_DIR] : [];
  try {
    return await new Promise<BrowserRun>((done) => {
      const env = { ...scrubbedEnv(home), ...(executable ? {} : {}) };
      const nonce = randomBytes(16).toString("hex");
      // its own process group: a timeout or the end of the run stops Chromium and its helpers too, not only the driver
      const child = spawn(process.execPath, ["--input-type=module", "-e", DRIVER], { cwd: input.serviceRoot, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      const killGroup = (signal: NodeJS.Signals = "SIGKILL") => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          /* already gone */
        }
      };
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        // Chromium sits in a group of its own: ask the driver to stop (Playwright closes the browser on SIGTERM), then make sure
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 1500).unref();
        done({ available: false, reason: "the browser run did not finish in time and was stopped" });
      }, input.timeoutMs ?? 240_000);
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
        if (stdout.length > 5_000_000) killGroup("SIGKILL");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString()).slice(-2000);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ available: false, reason: `the browser driver could not start: ${e.message}` });
      });
      child.on("close", () => {
        clearTimeout(timer);
        killGroup();
        // only a line carrying this run's nonce is a result: anything the app or a module printed cannot pose as one
        const tag = `__PRAXIS_RESULT__${nonce}__`;
        const marker = stdout.lastIndexOf(tag);
        if (marker < 0) return done({ available: false, reason: `the browser driver gave no result: ${(stderr || stdout).trim().slice(-200)}` });
        try {
          const parsed = JSON.parse(stdout.slice(marker + tag.length).trim()) as { ok: boolean; result?: BrowserRun; error?: string };
          if (!parsed.ok || !parsed.result) return done({ available: false, reason: `the browser driver failed: ${parsed.error ?? "unknown"}` });
          done(parsed.result);
        } catch {
          done({ available: false, reason: "the browser driver result was unreadable" });
        }
      });
      child.stdin.end(
        JSON.stringify({
          serviceRoot: input.serviceRoot,
          serve: input.config.serve,
          viewport: input.config.viewport,
          checks: input.checks,
          playwrightDirs,
          executable,
          artifactsDir: input.artifactsDir,
          nonce,
          noSandbox: process.env.PRAXIS_BROWSER_NO_SANDBOX === "1",
        }),
      );
    });
  } finally {
    sweepProcesses(home);
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a helper still holding the directory must not turn a result into a crash */
    }
  }
}
