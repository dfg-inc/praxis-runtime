import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Project-supplied code (a Quality adapter, a module named in checks.json) is repository content: an agent can write it. It
 * must never run inside the Runtime process, which holds the operator's credentials, the review-page tokens and the
 * approval machinery. It runs in its own Node process with a scrubbed environment (no PRAXIS_*, no tokens, a throw-away
 * HOME), a time limit and a size limit, and returns JSON. It is still the user's own project code running as the user: it can
 * touch files and the network like any test run; what it cannot do any more is read the Runtime's secrets or tamper with the
 * Runtime's memory.
 */
const RUNNER = String.raw`
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
const input = JSON.parse(readFileSync(0, "utf8"));
const out = (value) => { process.stdout.write("\n__PRAXIS_RESULT__" + JSON.stringify(value) + "\n", () => process.exit(0)); };
function safeFile(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || isAbsolute(relative) || relative.split(/[/\\]/).includes("..")) throw new Error("UNSAFE_PATH");
  const realRoot = realpathSync(resolve(root));
  const within = (p) => p === realRoot || p.startsWith(realRoot + sep);
  const lexical = resolve(realRoot, relative);
  if (!within(lexical)) throw new Error("UNSAFE_PATH");
  let existing = lexical;
  const rest = [];
  for (;;) {
    try { lstatSync(existing); break; } catch { const parent = dirname(existing); if (parent === existing) throw new Error("UNSAFE_PATH"); rest.unshift(basename(existing)); existing = parent; }
  }
  let realExisting;
  try { realExisting = realpathSync(existing); } catch { throw new Error("UNSAFE_PATH"); }
  const real = resolve(realExisting, ...rest);
  if (!within(real)) throw new Error("UNSAFE_PATH");
  return real;
}
async function loadModule(service, relative) {
  if (!service.localPath) return { missingLocation: true, repository: service.repository, file: relative };
  const file = safeFile(service.localPath, relative);
  if (!existsSync(file)) return { missingModule: true, repository: service.repository, file };
  const mod = await import(pathToFileURL(file).href + "?v=" + Date.now() + "-" + Math.random());
  return { mod, repository: service.repository, file };
}
try {
  const mod = await import(pathToFileURL(input.file).href + "?v=" + Date.now() + "-" + Math.random());
  if (input.op === "steps") {
    let value;
    for (const step of input.steps) {
      const fn = mod[step.function];
      if (typeof fn !== "function") throw new Error("EXPORT_MISSING:" + step.function);
      value = await fn(...(step.args ?? []));
    }
    out({ ok: true, result: value ?? null });
  } else if (input.op === "verify") {
    out({ ok: true, result: typeof mod.verify === "function" ? await mod.verify({ state: input.state, independentRerun: input.independentRerun, loadModule }) : null });
  } else if (input.op === "propose") {
    out({ ok: true, result: typeof mod.propose === "function" ? (mod.propose(input.serviceId) ?? null) : null });
  } else throw new Error("UNKNOWN_OP");
} catch (error) {
  out({ ok: false, error: String((error && error.message) || error) });
}
`;

export type IsolatedInput = { file: string; cwd: string; op: "steps" | "verify" | "propose"; steps?: unknown; state?: unknown; independentRerun?: boolean; serviceId?: string; timeoutMs?: number };

export function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: process.env.LANG ?? "C", NODE_ENV: "test", CI: "1" };
}

export async function runIsolated<T = unknown>(input: IsolatedInput): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "praxis-project-code-"));
  try {
    return await new Promise<T>((done, fail) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", RUNNER], { cwd: input.cwd, env: scrubbedEnv(home), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const limit = 20 * 1024 * 1024;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`PROJECT_CODE_TIMEOUT: ${input.file} did not finish in ${Math.round((input.timeoutMs ?? 300_000) / 1000)} s`));
      }, input.timeoutMs ?? 300_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > limit) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const marker = stdout.lastIndexOf("__PRAXIS_RESULT__");
        if (marker < 0) return fail(new Error(`PROJECT_CODE_FAILED: ${(stderr || stdout).trim().slice(-600) || "no result"}`));
        try {
          const parsed = JSON.parse(stdout.slice(marker + "__PRAXIS_RESULT__".length).trim()) as { ok: boolean; result?: T; error?: string };
          if (!parsed.ok) return fail(new Error(parsed.error ?? "PROJECT_CODE_FAILED"));
          done(parsed.result as T);
        } catch {
          fail(new Error("PROJECT_CODE_FAILED: unreadable result"));
        }
      });
      child.stdin.end(JSON.stringify({ ...input, timeoutMs: undefined }));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
