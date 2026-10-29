#!/usr/bin/env node
/**
 * One-time operator setup for Quality browser checks.
 *
 *   node tools/scripts/setup-quality-browser.mjs [--dir <dir>] [--check-only]
 *
 * Installs a pinned playwright-core into an operator-owned directory (default ~/.praxis/quality-browser), finds a
 * Chrome/Chromium, proves a headless launch works, and prints the two environment variables the Runtime needs.
 * The directory is never inside a project under test: Praxis refuses to load Playwright from the project.
 * Prints no environment dump and no secrets.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const PINNED = "1.64.1";
const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const dir = resolve(di >= 0 ? args[di + 1] : join(homedir(), ".praxis", "quality-browser"));
const checkOnly = args.includes("--check-only");

const CANDIDATES = [
  process.env.PRAXIS_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const fail = (m) => { console.error("setup-quality-browser: FAIL — " + m); process.exit(1); };

const pkgPath = join(dir, "package.json");
const installed = () => { try { return JSON.parse(readFileSync(join(dir, "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch { return null; } };

if (!checkOnly && installed() !== PINNED) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pkgPath, JSON.stringify({ name: "praxis-quality-browser", private: true, type: "module", dependencies: { "playwright-core": PINNED } }, null, 2) + "\n");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", dir], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) fail("npm install failed");
}
const have = installed();
if (!have) fail(`playwright-core is not installed in ${dir} (run without --check-only)`);
const major = Number(have.split(".")[0]), minor = Number(have.split(".")[1]);
if (major < 1 || (major === 1 && minor < 48)) fail(`playwright-core ${have} is older than 1.48`);

const executable = CANDIDATES.find((p) => existsSync(p));
if (!executable) fail("no Chrome/Chromium found: install Chrome or set PRAXIS_BROWSER_EXECUTABLE");

const require = createRequire(join(dir, "package.json"));
const { chromium } = require("playwright-core");
let title;
try {
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const page = await browser.newPage();
  await page.setContent("<title>praxis-ok</title>");
  title = await page.title();
  await browser.close();
} catch (e) {
  fail("the browser did not start: " + String((e && e.message) || e).split("\n")[0].slice(0, 200));
}
if (title !== "praxis-ok") fail("the browser started but did not render");

console.log(`playwright-core ${have} in ${dir}`);
console.log(`browser ${executable}: headless launch OK`);
console.log("\nGive the Praxis Runtime MCP process these two variables (Claude Code: `env` of the praxis-runtime server in your own .mcp.json / settings, not in the project under test):\n");
console.log(`  PRAXIS_PLAYWRIGHT_DIR=${dir}`);
console.log(`  PRAXIS_BROWSER_EXECUTABLE=${executable}`);
console.log("\nWithout them a `level: browser` check is reported BLOCKED with the reason, never PASS.");
