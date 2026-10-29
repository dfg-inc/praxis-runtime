import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBrowserChecks, validateBrowserSteps } from "./browser-verification.js";

describe("browser driver hardening (round 7 review)", () => {
  it("a playwright-core planted in the project under test is never loaded, and a printed result line cannot pose as the driver's", async () => {
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    mkdirSync(join(project, "node_modules", "playwright-core"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), "<!doctype html><title>x</title>");
    // a forged module that prints a perfect result
    writeFileSync(join(project, "node_modules", "playwright-core", "index.js"), `console.log('__PRAXIS_RESULT__{"ok":true,"result":{"available":true,"runner":"fake","browserVersion":"FAKE","subjectDigest":"x","startedAt":"a","finishedAt":"b","results":{"S":{"ok":true,"steps":1,"finalUrl":"/","consoleErrors":0,"blockedRequests":[]}}}}'); module.exports = { chromium: {} };`);
    delete process.env.PRAXIS_PLAYWRIGHT_DIR;
    const run = await runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectVisible: "#nothing-here" }] }] });
    expect(run.available).toBe(false);
    expect(JSON.stringify(run)).toContain("PRAXIS_PLAYWRIGHT_DIR");
    // and with the operator's directory set to the forged one, the unnonced line is still not a result
    process.env.PRAXIS_PLAYWRIGHT_DIR = project;
    try {
      const forged = await runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectVisible: "#nothing-here" }] }] });
      expect(forged.available === true && forged.runner === "fake").toBe(false);
    } finally {
      delete process.env.PRAXIS_PLAYWRIGHT_DIR;
    }
  }, 60_000);

  it("a timeout returns an unavailable run instead of throwing, and leaves no process group behind", async () => {
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), "<!doctype html>");
    process.env.PRAXIS_PLAYWRIGHT_DIR = "/Users/serg/work/praxis-split/praxis-runtime";
    try {
      const run = await runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }] }], timeoutMs: 300 });
      expect(run.available).toBe(false);
    } finally {
      delete process.env.PRAXIS_PLAYWRIGHT_DIR;
    }
  }, 60_000);

  it("step validation refuses what a check could use to leave the page's origin", () => {
    for (const bad of ["//x.test/", "http://x.test/", "x.test", "javascript:alert(1)", ""]) expect(() => validateBrowserSteps("S", [{ goto: bad }]), bad).toThrow(/CHECKS_INVALID/);
    expect(() => validateBrowserSteps("S", [{ goto: "/\\x.test" }])).not.toThrow(); // stays on the served origin (the browser reads it as a path)
  });
});

describe("a timeout takes Chromium down with it", () => {
  it("no browser process with the run's profile survives a timeout", async () => {
    const { spawnSync } = await import("node:child_process");
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), "<!doctype html><title>t</title>");
    process.env.PRAXIS_PLAYWRIGHT_DIR = "/Users/serg/work/praxis-split/praxis-runtime";
    process.env.PRAXIS_BROWSER_EXECUTABLE = process.env.PRAXIS_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      // long enough for the browser to start, short enough to hit the timeout in the middle of the run
      const run = await runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectVisible: "#never" }] }], timeoutMs: 2500 });
      expect(run.available).toBe(false);
      await new Promise((r) => setTimeout(r, 3000));
      const ps = spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout;
      expect(ps.split("\n").filter((l) => l.includes("praxis-browser-") && l.includes("--user-data-dir")).length).toBe(0);
    } finally {
      delete process.env.PRAXIS_PLAYWRIGHT_DIR;
    }
  }, 60_000);
});
