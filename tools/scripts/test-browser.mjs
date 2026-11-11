/**
 * Stands in for the user's browser in acceptance runs. A shipped Runtime opens a review page in the default browser through
 * the platform opener (`open`, `xdg-open`) and no environment switch changes that (a repository's Claude Code settings could
 * set one), so every scripted client puts these openers first on the Runtime's PATH. They keep the short-lived page file the
 * Runtime hands over, from which a test reads the link: a test action, never the developer's browser.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "praxis-test-browser-"));
const bin = join(base, "bin");
const capture = join(base, "opened");
mkdirSync(bin);
mkdirSync(capture);
for (const name of ["open", "xdg-open"]) {
  const script = join(bin, name);
  writeFileSync(script, `#!/bin/sh\nn=$(ls "${capture}" | wc -l | tr -d ' ')\ncp "$1" "${capture}/$(printf '%06d' "$n")-$$.html"\n`);
  chmodSync(script, 0o755);
  // the first run of a new executable can take longer than the Runtime waits for its opener (macOS checks it): run it once now
  spawnSync(script, [join(base, "none")], { stdio: "ignore" });
}

/** The folder to put first on a Runtime's PATH. */
export const testBrowserBin = bin;

/** A PATH whose openers are the stand-ins, followed by the given directories. */
export const withTestBrowser = (path) => `${bin}:${(path ?? "").split(":").filter((dir) => dir && dir !== bin).join(":")}`;

/** Every link the Runtime handed to "the browser", oldest first. */
export function openedLinks() {
  return readdirSync(capture)
    .sort()
    .map((file) => /url=([^"]+)"/.exec(readFileSync(join(capture, file), "utf8"))?.[1]?.replace(/&quot;/g, '"'))
    .filter(Boolean);
}

/** The newest link handed over; throws when none was (the Runtime did not open the page). */
export function lastOpenedLink() {
  for (let i = 0; i < 60; i += 1) {
    const links = openedLinks();
    if (links.length) return links[links.length - 1];
    spawnSync("sleep", ["0.05"]);
  }
  throw new Error("the Runtime opened no page");
}
