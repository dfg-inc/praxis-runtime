import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  kind: "dialog-answer" | "project-hooks" | "project-env" | "project-config" | "launch" | "unverifiable" | "state-home";
};

const SETTINGS_NAMES = ["settings.json", "settings.local.json"];
const MAX_JSON = 16 * 1024 * 1024;
const MAX_GLOBAL_JSON = 64 * 1024 * 1024;
const MAX_MARKDOWN = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;
// any flag of the families that bring configuration Praxis does not evaluate, present or future (--plugin-dir,
// --plugin-dir-no-mcp, --plugin-url, --settings, --setting-sources, --managed-settings ...), --agents, and an SDK host's
// --await-initialize (it can hand the client plugins and hooks over stdin)
// (--setting-sources is the one exception: it only narrows which of the standard scopes load, and all of them are checked)
const LAUNCH_FLAGS = /(^|[\s"'=\x00])--((?:plugin|managed)[a-z0-9-]*|setting(?!-sources(?=$|[\s"'=\x00]))[a-z0-9-]*|agents|await-initialize)(?=$|[\s"'=\x00])/i;
/**
 * What a repository's own Claude Code settings may contain: keys that neither run anything nor configure the client or the
 * Runtime. Anything else (hooks, env, a status line command, plugins and marketplaces, helper commands, keys Praxis does not
 * know) refuses protected actions: a project does not configure its own approval.
 */
// (the keys that start the repository's own MCP servers without asking, enableAllProjectMcpServers and
// enabledMcpjsonServers, are not on it; disableAllHooks only switches hooks off; sandbox only narrows the agent's shell)
const PROJECT_KEYS = new Set(["$schema", "permissions", "model", "outputstyle", "includecoauthoredby", "cleanupperioddays", "disabledmcpjsonservers", "spinnertipsenabled", "alwaysthinkingenabled", "language", "respectgitignore", "sandbox", "disableallhooks"]);
/**
 * Client environment that points it at configuration Praxis does not read (the environment form of --plugin-dir and the
 * like): a CLAUDE* name of those families whose name says it holds a location, or whose value looks like one.
 */
const CLIENT_CONFIG_ENV = /PLUGIN|SETTING|MARKETPLACE|HOOK|SKILL|AGENTS|CONFIG/i;
const LOCATION_NAME = /(DIRS?|PATHS?|FILES?|URLS?|SOURCES?|ROOTS?|HOME|JSON|LOCATION)$/i;
const looksLikeLocation = (value: string): boolean => /^\s*([\\/~.{[]|[a-z]:[\\/]|[a-z]+:\/\/)/i.test(value) || /[\\/]/.test(value);
const CLIENT_ENV_KNOWN = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR"]);
/**
 * Environment that loads code into the client process itself (the Claude Code binary is a Bun executable; an npm install
 * runs on Node), so whatever it loads can answer the client's dialog from inside: the client is no longer the client.
 */
const CODE_INTO_CLIENT = /^(BUN_OPTIONS|BUN_INSPECT\w*|BUN_CONFIG_PRELOAD|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|LD_PRELOAD|LD_AUDIT|ELECTRON_RUN_AS_NODE)$/;
const NODE_LOADS_CODE = /(^|\s)(-r|--require|--import|--loader|--experimental-loader|--inspect[\w-]*|--experimental-vm-modules)(=|\s|$)/;

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

/** Comments and trailing commas removed (outside strings), as a lenient settings reader would accept them. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJson(path: string, max = MAX_JSON): Read<unknown> {
  const text = readFile(path, max);
  if (!text || "finding" in text) return text;
  try {
    return { value: JSON.parse(stripJsonc(text.value)) };
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
    const settings = value as Record<string, unknown>;
    const env = settings.env && typeof settings.env === "object" ? Object.keys(settings.env as object) : [];
    if (env.length) out.push({ file: path, why: `the repository's settings set ${env.slice(0, 6).join(", ")} for the client and the Runtime it starts`, kind: "project-env" });
    const other = Object.keys(settings).filter((k) => (!PROJECT_KEYS.has(fold(k)) || (fold(k) === "disableallhooks" && settings[k] !== true)) && fold(k) !== "hooks" && fold(k) !== "env");
    if (other.length) out.push({ file: path, why: `the repository's settings configure ${other.slice(0, 6).join(", ")}, which a project may not set while it asks for protected actions`, kind: "project-config" });
  } else if (project && value !== undefined) {
    out.push({ file: path, why: "is not a settings object, so it cannot be checked", kind: "unverifiable" });
  }
  if (!project && value && typeof value === "object" && !Array.isArray(value)) {
    const env = (value as Record<string, unknown>).env;
    const pointing = env && typeof env === "object" ? Object.entries(env as Record<string, unknown>).filter(([name, v]) => pointsClientAtConfig(name, String(v ?? ""))).map(([name]) => name) : [];
    if (pointing.length) out.push({ file: path, why: `its env sets ${pointing.slice(0, 4).join(", ")}, which points the client at configuration Praxis cannot check`, kind: "launch" });
  }
  return out;
}

/** YAML front matter, with the escapes and line joins a double-quoted YAML key may use undone. */
function frontMatter(text: string): string | undefined {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
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
  // a top-level hooks key (plain or quoted), or a front matter that is one flow mapping holding one, after escapes are undone;
  // the word inside a description is not a key
  const key = /(^|\n)[ \t]*(![^\s]*[ \t]+)?["']?hooks["']?[ \t]*:/.test(fm) || /^\s*\{[\s\S]*["']?hooks["']?\s*:/.test(fm) || /(^|\n)[ \t]*<<[ \t]*:[\s\S]*hooks/.test(fm);
  if (!key) return [];
  if (fm.includes("elicitation")) return [{ file: path, why: "an agent, skill or command definition declares an Elicitation hook", kind: "dialog-answer" }];
  if (project) return [{ file: path, why: "a repository agent, skill or command definition declares hooks: a project cannot authorize its own protected actions", kind: "project-hooks" }];
  return [];
}

/** All files under `dir`, or a finding when the tree is larger than Praxis can check. */
type Budget = { left: number; limit: number; finding?: AutomationFinding };
function walk(dir: string, budget: Budget): string[] {
  const found: string[] = [];
  const stack = [dir];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    // a linked folder is followed (once: a link loop ends there)
    let real = current;
    try {
      real = realpathSync(current);
    } catch {
      /* listed below as unreadable */
    }
    if (visited.has(real)) continue;
    visited.add(real);
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
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          folder = statSync(path).isDirectory();
        } catch {
          folder = false; // a dangling link: kept as a file, refused only where a hook file is expected
        }
      }
      if (folder) {
        if (entry.name !== ".git" && entry.name !== "node_modules") stack.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  }
  return found;
}

/** Files Claude Code reads hooks from by their name: a hook file, a plugin manifest, a marketplace manifest. */
const isHookJson = (path: string): boolean => /(^|[\\/])(hooks\.json|plugin\.json|marketplace\.json)$/.test(path);
const isDefinition = (path: string): boolean => path.endsWith(".md") && /[\\/](agents|skills|commands|output-styles)[\\/]/.test(path);

/** Every string a `hooks` key holds (a path, or a list of paths), at any depth: hook files a manifest names. */
function hookRefs(value: unknown): string[] {
  const refs: string[] = [];
  keys(value, (key, inner) => {
    if (fold(key) !== "hooks") return;
    if (typeof inner === "string") refs.push(inner);
    else if (Array.isArray(inner)) for (const item of inner) if (typeof item === "string") refs.push(item);
  });
  return refs;
}

/** The folders a manifest's relative paths can be relative to: its own root, and a marketplace entry's `source` folder. */
function manifestBases(file: string, value: unknown): string[] {
  const root = /[\\/]\.claude-plugin[\\/][^\\/]+\.json$/.test(file) ? dirname(dirname(file)) : dirname(file);
  const bases = [root];
  keys(value, (key, inner) => {
    if (fold(key) === "source" && typeof inner === "string" && !/^[a-z]+:\/\//i.test(inner)) bases.push(resolve(root, inner));
    if (fold(key) === "source" && inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).path === "string") bases.push(resolve(root, (inner as Record<string, string>).path));
  });
  return [...new Set(bases)];
}

/**
 * A plugin tree: hook files, plugin and marketplace manifests (and every hook file they name, under any name), and agent,
 * skill and command definitions, all of which fail closed; every other JSON file is also read for a hook, best effort (a
 * broken fixture in a plugin's tests does not refuse anything, because Claude Code does not read it as a hook).
 */
function checkPluginTree(root: string, budget: Budget, seen: Set<string>): AutomationFinding[] {
  const out: AutomationFinding[] = [];
  for (const file of walk(root, budget)) {
    if (seen.has(file)) continue;
    if (isDefinition(file)) {
      seen.add(file);
      out.push(...checkMarkdown(file, false));
      continue;
    }
    if (!file.endsWith(".json")) continue;
    seen.add(file);
    const strict = isHookJson(file);
    const parsed = readJson(file);
    if (!parsed) continue;
    if ("finding" in parsed) {
      if (strict) out.push(parsed.finding);
      continue;
    }
    const whole = /(^|[\\/])hooks\.json$/.test(file) || /[\\/]hooks[\\/][^\\/]+\.json$/.test(file);
    out.push(...checkSettings(file, parsed.value, false, whole).filter((f) => strict || f.kind === "dialog-answer"));
    if (!strict) continue;
    const bases = manifestBases(file, parsed.value);
    for (const ref of hookRefs(parsed.value)) {
      const clean = ref.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, "");
      const targets = isAbsolute(clean) ? [clean] : bases.map((base) => resolve(base, clean));
      const found = targets.filter((t) => existsSync(t) || isLink(t));
      if (!found.length) {
        out.push({ file, why: `names a hook file (${ref}) Praxis cannot find, so it cannot be checked`, kind: "unverifiable" });
        continue;
      }
      for (const target of found) {
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
    // a fixed path: an environment the repository may set must not choose the program that reads the client's command line
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
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
 * The processes above the Runtime, nearest first, all the way up: a wrapper with any name can stand between the Runtime and
 * the client, so no process is taken for the client by its name.
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
    if (proc.ppid === pid) break;
    pid = proc.ppid;
  }
  return chain;
}


function pointsClientAtConfig(name: string, value: string): boolean {
  if (!value.trim()) return false;
  if (CODE_INTO_CLIENT.test(name) || (name === "NODE_OPTIONS" && NODE_LOADS_CODE.test(value))) return true;
  // the switch to Cowork's settings and plugins (cowork_settings.json, cowork_plugins/): another configuration set
  if (/^CLAUDE/i.test(name) && /COWORK/i.test(name) && !/^(0|false|no|off)$/i.test(value.trim())) return true;
  if (!/^CLAUDE/i.test(name) || CLIENT_ENV_KNOWN.has(name.toUpperCase()) || !CLIENT_CONFIG_ENV.test(name)) return false;
  return LOCATION_NAME.test(name) || looksLikeLocation(value);
}

/** The client's environment, as the Runtime inherited it: the environment form of the configuration flags, and code loaded into the client. */
function checkClientEnvironment(): AutomationFinding[] {
  return Object.keys(process.env)
    .filter((name) => pointsClientAtConfig(name, process.env[name] ?? ""))
    .map((name) => ({ file: `environment ${name}`, why: CODE_INTO_CLIENT.test(name) || name === "NODE_OPTIONS" ? "loads code into the client process, which can answer its dialog from inside" : "points the client at configuration Praxis cannot check", kind: "launch" as const }));
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
    for (const name of [...SETTINGS_NAMES, "cowork_settings.json"]) settingsAt(join(dir, name), false);
    for (const sub of ["agents", "skills", "commands", "output-styles"]) {
      const defs = join(dir, sub);
      if (!existsSync(defs)) continue;
      for (const file of walk(defs, pluginBudget)) if (file.endsWith(".md") && !seen.has(file)) (seen.add(file), findings.push(...checkMarkdown(file, false)));
    }
    for (const plugins of [join(dir, "plugins"), join(dir, "cowork_plugins")]) {
      if (!existsSync(plugins)) continue;
      const { roots, findings: recordFindings } = pluginRoots(plugins);
      findings.push(...recordFindings);
      findings.push(...checkPluginTree(plugins, pluginBudget, seen));
      for (const root of roots) if (!within(resolve(root), plugins) && existsSync(root)) findings.push(...checkPluginTree(resolve(root), pluginBudget, seen));
    }
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

  findings.push(...checkClientEnvironment());
  findings.push(...checkLaunch(input.ancestry ?? ancestry));
  return findings;
}
