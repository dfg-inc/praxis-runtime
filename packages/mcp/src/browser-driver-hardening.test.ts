import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBrowserChecks, validateBrowserSteps } from "./browser-verification.js";
import { browserExecutable } from "./test-browser.js";

// The repository root: the tests load Playwright from its node_modules, as an operator would from PRAXIS_PLAYWRIGHT_DIR.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
    process.env.PRAXIS_PLAYWRIGHT_DIR = REPO_ROOT;
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
    process.env.PRAXIS_PLAYWRIGHT_DIR = REPO_ROOT;
    process.env.PRAXIS_BROWSER_EXECUTABLE = browserExecutable();
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

describe("round 8 review: egress, serve root, parent loss", () => {
  const withPlaywright = async <T>(fn: () => Promise<T>) => {
    process.env.PRAXIS_PLAYWRIGHT_DIR = REPO_ROOT;
    process.env.PRAXIS_BROWSER_EXECUTABLE = browserExecutable();
    try {
      return await fn();
    } finally {
      delete process.env.PRAXIS_PLAYWRIGHT_DIR;
    }
  };

  it("a serve root equal to the service directory is refused, so .env, .git and .praxis are never reachable", async () => {
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    writeFileSync(join(project, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(project, ".env"), "SECRET=1");
    const run = await withPlaywright(() => runBrowserChecks({ serviceRoot: project, config: { serve: { root: "." } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }] }] }));
    expect(run.available).toBe(false);
  }, 60_000);

  it("a dotfile inside the served directory is not part of the served copy", async () => {
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), "<!doctype html><title>t</title><div id=a></div><script>fetch('/.secret').then(r=>r.text()).then(t=>{document.getElementById('a').textContent='got:'+t.slice(0,6)+':'+(t.length>0)})</script>");
    writeFileSync(join(project, "dist", ".secret"), "TOPSECRET");
    const run = await withPlaywright(() => runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" }, }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectText: { selector: "#a", contains: "got::false" } }] }] }));
    expect(JSON.stringify(run)).toContain('"available":true');
    if (run.available) expect(JSON.stringify(run.results.S)).toContain("\"ok\":true");
    if (run.available) expect(JSON.stringify(run.results.S)).not.toContain("TOPSECRET");
  }, 60_000);

  it("WebRTC and preconnect cannot reach a listener outside the served origin", async () => {
    const { createSocket } = await import("node:dgram");
    const { createServer } = await import("node:net");
    const { networkInterfaces } = await import("node:os");
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lan) return; // no LAN address on this machine: nothing to probe
    let udp = 0;
    let tcp = 0;
    const sock = createSocket("udp4");
    sock.on("message", () => { udp += 1; });
    await new Promise<void>((r) => sock.bind(0, "0.0.0.0", r));
    const srv = createServer((c) => { tcp += 1; c.destroy(); });
    await new Promise<void>((r) => srv.listen(0, "0.0.0.0", r));
    const udpPort = sock.address().port;
    const tcpPort = (srv.address() as { port: number }).port;
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), `<!doctype html><title>t</title><link rel=preconnect href="http://${lan}:${tcpPort}"><div id=d></div><script>
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${lan}:${udpPort}" }] });
      pc.createDataChannel("x"); pc.createOffer().then(o => pc.setLocalDescription(o));
      setTimeout(() => { document.getElementById('d').textContent = 'done'; }, 1500);</script>`);
    try {
      const run = await withPlaywright(() => runBrowserChecks({ serviceRoot: project, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectText: { selector: "#d", contains: "done" } }] }] }));
      expect(run.available).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(udp).toBe(0);
      expect(tcp).toBe(0);
    } finally {
      sock.close();
      srv.close();
    }
  }, 60_000);

  it("a viewport outside 200-3000 is refused in the configuration", async () => {
    const { validateBrowserConfig } = await import("./browser-verification.js");
    expect(() => validateBrowserConfig({ serve: { root: "dist" }, viewport: { width: 30000, height: 30000 } })).toThrow(/CHECKS_INVALID/);
    expect(() => validateBrowserConfig({ serve: { root: "dist" }, viewport: { width: 1280, height: 800 } })).not.toThrow();
  });

  it("a driver whose parent was killed stops itself and Chromium (no leftover process, no temp directory)", async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { readdirSync, existsSync, rmSync } = await import("node:fs");
    const project = mkdtempSync(join(tmpdir(), "praxis-bdh-"));
    mkdirSync(join(project, "dist"), { recursive: true });
    writeFileSync(join(project, "dist", "index.html"), "<!doctype html><title>t</title>");
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("praxis-browser-")));
    // a throwaway parent that starts a run and is then SIGKILLed
    const script = `import { runBrowserChecks } from ${JSON.stringify(new URL("./browser-verification.js", import.meta.url).href)};
      runBrowserChecks({ serviceRoot: ${JSON.stringify(project)}, config: { serve: { root: "dist" } }, checks: [{ scenarioId: "S", steps: [{ goto: "/" }, { expectVisible: "#never" }] }], timeoutMs: 20000 });`;
    const scriptPath = join(project, "parent.mjs");
    writeFileSync(scriptPath, script);
    const parent = spawn(process.execPath, ["--import", "tsx", scriptPath], { env: { ...process.env, PRAXIS_PLAYWRIGHT_DIR: REPO_ROOT, PRAXIS_BROWSER_EXECUTABLE: browserExecutable() }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 4000));
    parent.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 6000));
    const ps = spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout;
    const mine = readdirSync(tmpdir()).filter((n) => n.startsWith("praxis-browser-") && !before.has(n));
    const alive = ps.split("\n").filter((l) => mine.some((n) => l.includes(n)));
    const leftoverDirs = mine.filter((n) => existsSync(join(tmpdir(), n)));
    for (const n of mine) spawnSync("pkill", ["-9", "-f", n]); // never leave it behind, even when the assertion fails
    for (const n of leftoverDirs) rmSync(join(tmpdir(), n), { recursive: true, force: true });
    expect(alive.length).toBe(0);
    expect(leftoverDirs).toEqual([]);
  }, 90_000);
});
