import { existsSync } from "node:fs";

/** Where Chrome/Chromium usually lives: macOS, then the Linux package names (the same places the driver itself tries). */
const KNOWN_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/**
 * The browser the driver tests start. `PRAXIS_BROWSER_EXECUTABLE` wins (CI sets it to the Playwright-managed Chromium); otherwise a
 * known install is used. There is no fallback to a path that does not exist: a missing browser fails the test with the reason,
 * it never turns a test into a skip or lets a browserless run pass vacuously.
 */
export function browserExecutable(): string {
  const fromEnv = process.env.PRAXIS_BROWSER_EXECUTABLE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`PRAXIS_BROWSER_EXECUTABLE points at a file that does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const found = KNOWN_BROWSERS.find((p) => existsSync(p));
  if (!found) {
    throw new Error("No Chrome/Chromium for the browser driver tests: install Chrome, or set PRAXIS_BROWSER_EXECUTABLE (node tools/scripts/setup-quality-browser.mjs prints the value; CI uses `playwright-core install chromium`).");
  }
  return found;
}
