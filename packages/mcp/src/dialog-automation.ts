import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { testSource } from "./approval-settings.js";

/**
 * Whether the connected client's approval dialog can be answered, or the Runtime configured, by something other than the
 * person, as far as Praxis can see. Every check fails closed: a file that exists but cannot be read, parsed or fully
 * checked, a limit that is reached, or a command line that cannot be read is a finding, never a pass.
 *
 * What is checked:
 *   - settings (`.claude/settings.json`, `.claude/settings.local.json`) of the working folder, the repository and every
 *     folder above them, the user's settings (HOME, the account's real home, CLAUDE_CONFIG_DIR, `~/.claude.json`) and
 *     managed settings. JSON is parsed (so escapes are decoded) and every key at any depth is compared after Unicode
 *     normalisation and case folding: any key naming the Elicitation event is a configured answer to the dialog;
 *   - the repository's own Claude Code configuration: a project cannot authorize its own protected actions, and Claude
 *     Code runs a project's hooks and applies its `env` block as the person. So in project scope ANY hook (of any event,
 *     in settings or in the front matter of agents, skills and commands) and any `env` entry that configures the Runtime
 *     or the programs it runs is a finding;
 *   - installed plugins and directory marketplaces: every plugin manifest is parsed and its `hooks` field followed (a path,
 *     a list or an inline object), every hook file is parsed, every agent, skill and command front matter is read;
 *   - the client's process ancestry: a client started with flags that bring configuration Praxis does not evaluate
 *     (`--settings`, `--plugin-dir`, `--plugin-url`, `--agents`) is a finding (Claude Desktop starts its Code tab with an
 *     inline `--settings`, so the Code tab is refused before its dialog is tried);
 *   - a state home (the decision journal) inside the repository.
 *
 * This is best effort against the client's configuration surface, which Praxis does not own and which can grow: a source
 * Claude Code adds later, or a client the agent runs itself, is not seen (docs/approval-threat-model.md R1, R6).
 */

export type AutomationFinding = {
  file: string;
  why: string;
  kind: "dialog-answer" | "project-hooks" | "project-env" | "launch" | "unverifiable" | "state-home";
};

const SETTINGS_NAMES = ["settings.json", "settings.local.json"];
const MAX_JSON = 16 * 1024 * 1024;
const MAX_GLOBAL_JSON = 64 * 1024 * 1024;
const MAX_MARKDOWN = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;
// flags that bring configuration Praxis does not evaluate (--setting-sources only narrows the standard scopes, all checked)
const LAUNCH_FLAGS = /(^|[\s"'=\x00])--(settings|plugin-dir|plugin-url|agents)(?=$|[\s"'=\x00])/;
/** Environment a project's settings must not set for the Runtime: it chooses the programs Praxis runs, or where it keeps its record. */
const RUNTIME_ENV = /^(PATH|HOME|TMPDIR|TMP|TEMP|SHELL|BROWSER|NODE_.*|NPM_.*|DYLD_.*|LD_.*|GIT_.*|PRAXIS_.*|CLAUDE_.*|PLAYWRIGHT_.*|XDG_.*)$/i;

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();
const namesElicitation = (key: string): boolean => fold(key).includes("elicitation");

type Read<T> = { value: T } | { finding: AutomationFinding } | undefined;

/** A file that is absent is clean; one that exists and cannot be fully read is a finding. */
function readFile(path: string, max: number): Read<string> {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    // absent is clean; a dangling link or a path that cannot be stat'ed is present but unreadable
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !isLink(path)) return undefined;
    return { finding: { file: path, why: "exists but cannot be read, so it cannot be checked", kind: "unverifiable" } };
  }
  if (!stat.isFile()) return { finding: { file: path, why: "is not a regular file, so it cannot be checked", kind: "unverifiable" } };
  if (stat.size > max) return { finding: { file: path, why: `is larger than ${max} bytes, too large to check`, kind: "unverifiable" } };
  try {
    return { value: readFileSync(path, "utf8").replace(/^\uFEFF/, "") };
  } catch {
    return { finding: { file: path, why: "exists but cannot be read, so it cannot be checked", kind: "unverifiable" } };
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path: string, max = MAX_JSON): Read<unknown> {
  const text = readFile(path, max);
  if (!text || "finding" in text) return text;
  try {
    return { value: JSON.parse(text.value) };
  } catch {
    return { finding: { file: path, why: "is not valid JSON, so it cannot be checked", kind: "unverifiable" } };
  }
}

/** Every key at any depth (bounded; too deep is a finding for the caller). */
function keys(value: unknown, visit: (key: string, inner: unknown) => void, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((item) => keys(item, visit, depth + 1));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value as Record<string, unknown>).every(([key, inner]) => (visit(key, inner), keys(inner, visit, depth + 1)));
}

/**
 * A parsed settings object (or, with `whole`, a hooks file): a configured answer to the dialog is a key naming the
 * Elicitation event inside any `hooks` object, at any depth; in project scope, any hook and Runtime env too.
 */
function checkSettings(path: string, value: unknown, project: boolean, whole = false): AutomationFinding[] {
  const out: AutomationFinding[] = [];
  let answer = false;
  let hooks = false;
  const complete = keys(value, (key, inner) => {
    if (whole && namesElicitation(key)) answer = true;
    if (fold(key) !== "hooks" || !inner || typeof inner !== "object") return;
    if (Object.keys(inner).length > 0) hooks = true;
    keys(inner, (k) => {
      if (namesElicitation(k)) answer = true;
    });
  });
  if (!complete) out.push({ file: path, why: "is nested too deeply to check", kind: "unverifiable" });
  if (answer) out.push({ file: path, why: "an Elicitation hook answers the approval dialog", kind: "dialog-answer" });
  if (project && hooks && !answer) out.push({ file: path, why: "the repository's settings run hooks as you: a project cannot authorize its own protected actions", kind: "project-hooks" });
  if (project && value && typeof value === "object" && !Array.isArray(value)) {
    const env = (value as Record<string, unknown>).env;
    const set = env && typeof env === "object" ? Object.keys(env as object).filter((k) => RUNTIME_ENV.test(k)) : [];
    if (set.length) out.push({ file: path, why: `the repository's settings set ${set.slice(0, 6).join(", ")} for the Runtime or the programs it runs`, kind: "project-env" });
  }
  return out;
}

/** YAML front matter, with the escapes and line joins a double-quoted YAML key may use undone. */
function frontMatter(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return undefined;
  return fold(
    match[1]!
      .replace(/\\\r?\n\s*/g, "")
      .replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\U([0-9a-f]{8})/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))),
  );
}

function checkMarkdown(path: string, project: boolean): AutomationFinding[] {
  const text = readFile(path, MAX_MARKDOWN);
  if (!text) return [];
  if ("finding" in text) return [text.finding];
  const fm = frontMatter(text.value);
  if (!fm) return [];
  // a hooks key in any YAML form (plain, quoted, flow mapping), after the escapes are undone
  if (!/(^|[\s{,"'])hooks["']?\s*:/.test(fm)) return [];
  if (fm.includes("elicitation")) return [{ file: path, why: "an agent, skill or command definition declares an Elicitation hook", kind: "dialog-answer" }];
  if (project) return [{ file: path, why: "a repository agent, skill or command definition declares hooks: a project cannot authorize its own protected actions", kind: "project-hooks" }];
  return [];
}

/** All files under `dir`, or a finding when the tree is larger than Praxis can check. */
type Budget = { left: number; limit: number; finding?: AutomationFinding };
function walk(dir: string, budget: Budget): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      if (current !== dir && existsSync(current)) budget.finding ??= { file: current, why: "a folder Praxis cannot list", kind: "unverifiable" };
      continue;
    }
    for (const entry of entries) {
      if ((budget.left -= 1) < 0) {
        budget.finding ??= { file: dir, why: `holds more than ${budget.limit} entries, too many to check`, kind: "unverifiable" };
        return found;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") stack.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  }
  return found;
}

const isHookJson = (path: string): boolean => /(^|[\\/])(hooks\.json|plugin\.json)$/.test(path) || /[\\/]hooks[\\/][^\\/]+\.json$/.test(path);
const isDefinition = (path: string): boolean => path.endsWith(".md") && /[\\/](agents|skills|commands|output-styles)[\\/]/.test(path);

/** A plugin tree: manifests (and the hook files they name), hook files, and agent, skill and command definitions. */
function checkPluginTree(root: string, budget: Budget, seen: Set<string>): AutomationFinding[] {
  const out: AutomationFinding[] = [];
  for (const file of walk(root, budget)) {
    if (seen.has(file) || (!isDefinition(file) && !isHookJson(file))) continue;
    seen.add(file);
    if (isDefinition(file)) {
      out.push(...checkMarkdown(file, false));
      continue;
    }
    const parsed = readJson(file);
    if (!parsed) continue;
    if ("finding" in parsed) {
      out.push(parsed.finding);
      continue;
    }
    out.push(...checkSettings(file, parsed.value, false, !file.endsWith("plugin.json")));
    // a manifest's `hooks` field may name files under any name: follow them
    if (file.endsWith("plugin.json") && parsed.value && typeof parsed.value === "object") {
      const pluginRoot = /[\\/]\.claude-plugin[\\/]plugin\.json$/.test(file) ? dirname(dirname(file)) : dirname(file);
      const field = (parsed.value as Record<string, unknown>).hooks;
      for (const ref of typeof field === "string" ? [field] : Array.isArray(field) ? field.filter((f): f is string => typeof f === "string") : []) {
        const target = resolve(pluginRoot, ref.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, ""));
        if (seen.has(target)) continue;
        seen.add(target);
        const hooked = readJson(target);
        if (hooked && "finding" in hooked) out.push(hooked.finding);
        else if (hooked) out.push(...checkSettings(target, hooked.value, false, true));
      }
    }
  }
  return out;
}

/** Folders the client's plugin records point at (install paths, directory marketplaces), outside the plugins folder too. */
function pluginRoots(pluginsDir: string): { roots: string[]; findings: AutomationFinding[] } {
  const roots: string[] = [];
  const findings: AutomationFinding[] = [];
  for (const name of ["installed_plugins.json", "known_marketplaces.json"]) {
    const parsed = readJson(join(pluginsDir, name));
    if (!parsed) continue;
    if ("finding" in parsed) {
      findings.push(parsed.finding);
      continue;
    }
    keys(parsed.value, (key, inner) => {
      if (typeof inner === "string" && /^(installpath|installlocation|path|directory)$/i.test(key) && isAbsolute(inner)) roots.push(inner);
    });
  }
  return { roots, findings };
}

type Process = { pid: number; ppid: number; args: string };

function processOf(pid: number): Process | undefined {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return { pid, ppid, args: readFileSync(`/proc/${pid}/cmdline`, "utf8") };
  }
  if (process.platform === "win32") {
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const out = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId)\`n$($p.CommandLine)"`], { encoding: "utf8", timeout: 5_000 });
    const [ppid, ...rest] = out.split(/\r?\n/);
    return { pid, ppid: Number(ppid), args: rest.join(" ") };
  }
  // absolute: a PATH from the repository's settings must not choose the program that reads the client's command line
  const out = execFileSync("/bin/ps", ["-o", "ppid=", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
  const match = /^(\d+)\s+([\s\S]*)$/.exec(out);
  return match ? { pid, ppid: Number(match[1]), args: match[2]! } : undefined;
}

/**
 * The processes above the Runtime, nearest first, up to and including the nearest one that looks like a Claude Code client
 * (its flags configure its hooks; what started it does not). A client that does not look like one is walked past, so
 * everything above it is checked too.
 */
export function ancestry(): Process[] {
  // the test source only (inert in a shipped bundle): the command lines of the processes above, nearest first
  if (testSource() && process.env.PRAXIS_TEST_ANCESTRY) return (JSON.parse(process.env.PRAXIS_TEST_ANCESTRY) as string[]).map((args, i) => ({ pid: 1000 + i, ppid: 1001 + i, args }));
  const chain: Process[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i += 1) {
    const proc = processOf(pid);
    if (!proc) break;
    chain.push(proc);
    if (/claude/i.test(proc.args) || proc.ppid === pid) break;
    pid = proc.ppid;
  }
  return chain;
}


function checkLaunch(read: () => Process[]): AutomationFinding[] {
  let chain: Process[];
  try {
    chain = read();
  } catch {
    return [{ file: "the client's command line", why: "cannot be read, so the flags the client was started with cannot be checked", kind: "unverifiable" }];
  }
  if (!chain.length) return [{ file: "the client's command line", why: "cannot be read, so the flags the client was started with cannot be checked", kind: "unverifiable" }];
  const out: AutomationFinding[] = [];
  for (const proc of chain) {
    const flag = LAUNCH_FLAGS.exec(proc.args);
    if (flag) out.push({ file: `process ${proc.pid}`, why: `was started with --${flag[2]}, configuration Praxis cannot check`, kind: "launch" });
  }
  return out;
}

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${sep}`);

export function dialogAutomation(input: { repo?: string; ancestry?: () => Process[]; /** tests: a smaller walk limit */ maxWalkEntries?: number } = {}): AutomationFinding[] {
  const limit = input.maxWalkEntries ?? MAX_WALK_ENTRIES;
  const findings: AutomationFinding[] = [];
  const seen = new Set<string>();
  const homes = [...new Set([homedir(), userInfo().homedir].filter(Boolean).map((h) => resolve(h)))];
  const configDirs = [...new Set([...homes.map((h) => join(h, ".claude")), ...(process.env.CLAUDE_CONFIG_DIR?.trim() ? [resolve(process.env.CLAUDE_CONFIG_DIR.trim())] : [])])];
  const settingsAt = (path: string, project: boolean, max = MAX_JSON) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = readJson(path, max);
    if (parsed && "finding" in parsed) findings.push(parsed.finding);
    else if (parsed) findings.push(...checkSettings(path, parsed.value, project));
  };

  // project scope: the working folder, the repository and every folder above them (a user config folder there is user scope)
  const projectRoots = new Set<string>();
  for (const start of [process.cwd(), ...(input.repo ? [input.repo] : [])]) {
    let dir = resolve(start);
    for (let i = 0; i < 64; i += 1) {
      projectRoots.add(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const root of projectRoots) {
    const claude = join(root, ".claude");
    const project = !configDirs.includes(claude);
    for (const name of SETTINGS_NAMES) settingsAt(join(claude, name), project);
    if (!project) continue;
    for (const sub of ["agents", "skills", "commands", "output-styles"]) {
      const dir = join(claude, sub);
      if (!existsSync(dir)) continue;
      const budget = { left: limit, limit } as Budget;
      for (const file of walk(dir, budget)) if (file.endsWith(".md") && !seen.has(file)) (seen.add(file), findings.push(...checkMarkdown(file, true)));
      if (budget.finding) findings.push(budget.finding);
    }
  }

  // user scope and plugins
  for (const home of homes) settingsAt(join(home, ".claude.json"), false, MAX_GLOBAL_JSON);
  const pluginBudget = { left: limit, limit } as Budget;
  for (const dir of configDirs) {
    for (const name of SETTINGS_NAMES) settingsAt(join(dir, name), false);
    for (const sub of ["agents", "skills", "commands", "output-styles"]) {
      const defs = join(dir, sub);
      if (!existsSync(defs)) continue;
      for (const file of walk(defs, pluginBudget)) if (file.endsWith(".md") && !seen.has(file)) (seen.add(file), findings.push(...checkMarkdown(file, false)));
    }
    const plugins = join(dir, "plugins");
    if (!existsSync(plugins)) continue;
    const { roots, findings: recordFindings } = pluginRoots(plugins);
    findings.push(...recordFindings);
    findings.push(...checkPluginTree(plugins, pluginBudget, seen));
    for (const root of roots) if (!within(resolve(root), plugins) && existsSync(root)) findings.push(...checkPluginTree(resolve(root), pluginBudget, seen));
  }
  if (pluginBudget.finding) findings.push(pluginBudget.finding);

  // managed settings
  const managed =
    process.platform === "win32" ? ["C:\\ProgramData\\ClaudeCode"] : process.platform === "darwin" ? ["/Library/Application Support/ClaudeCode"] : ["/etc/claude-code"];
  for (const dir of managed) {
    settingsAt(join(dir, "managed-settings.json"), false);
    const dropIns = join(dir, "managed-settings.d");
    if (existsSync(dropIns)) for (const file of walk(dropIns, pluginBudget)) if (file.endsWith(".json")) settingsAt(file, false);
  }

  // the journal kept inside the repository
  const stateHome = process.env.PRAXIS_STATE_HOME?.trim();
  if (stateHome && input.repo && within(resolve(stateHome), resolve(input.repo))) {
    findings.push({ file: resolve(stateHome), why: "the Praxis state home (the decision journal) is inside the repository", kind: "state-home" });
  }

  findings.push(...checkLaunch(input.ancestry ?? ancestry));
  return findings;
}
