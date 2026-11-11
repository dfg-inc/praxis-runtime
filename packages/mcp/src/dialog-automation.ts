import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Whether the connected client's approval dialog can be answered by configuration instead of a person.
 *
 * Claude Code lets an `Elicitation` hook answer an MCP elicitation (the Praxis approval dialog) by itself, and it takes
 * hooks from a repository's own `.claude/settings.json` (verified with Claude Code 2.1.314 against the released
 * 0.1.0-alpha.49.1: a repository's hook approved a protected write). A dialog answer is therefore taken only when no such
 * automation is configured in any scope Praxis can read:
 *   - project settings (.claude/settings.json, .claude/settings.local.json) of the working folder and the repository, and
 *     of every folder above them;
 *   - the user's settings (the account's real home and CLAUDE_CONFIG_DIR), and installed plugins' hooks;
 *   - managed (policy) settings;
 *   - a settings file the client was started with (`--settings`, read from the client's command line);
 *   - agent and skill definitions in those scopes (they can carry hooks).
 * Over-detection fails closed (nothing protected runs); it never approves anything. What this cannot see: a client that
 * answers by other means (a host of the agent's own making, synthetic input into the person's terminal). Those are outside
 * what any local check can decide (docs/approval-threat-model.md T6).
 */

export type AutomationFinding = { file: string; why: string };

const SETTINGS_NAMES = ["settings.json", "settings.local.json"];
const HOOK_EVENT = /\bElicitation(Result)?\b/;

function readText(path: string, max = 2_000_000): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > max) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A settings or plugin JSON file that names an Elicitation hook. */
function jsonHook(path: string): AutomationFinding | undefined {
  const text = readText(path);
  if (!text || !HOOK_EVENT.test(text)) return undefined;
  try {
    const parsed = JSON.parse(text) as { hooks?: Record<string, unknown> };
    const hooks = parsed?.hooks && typeof parsed.hooks === "object" ? parsed.hooks : (parsed as Record<string, unknown>);
    if (Object.keys(hooks ?? {}).some((key) => HOOK_EVENT.test(key))) return { file: path, why: "an Elicitation hook answers the approval dialog" };
  } catch {
    // an unreadable file that names the event: fail closed
  }
  return { file: path, why: "names the Elicitation hook event" };
}

function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (let i = 0; i < 64; i += 1) {
    out.push(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** Files under `dir` (bounded) whose name matches, for plugin hook files and agent/skill definitions. */
function walk(dir: string, match: (name: string) => boolean, depth = 6, budget = { files: 4000 }): string[] {
  const found: string[] = [];
  if (depth < 0 || budget.files <= 0) return found;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (budget.files-- <= 0) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") found.push(...walk(path, match, depth - 1, budget));
    else if (entry.isFile() && match(entry.name)) found.push(path);
  }
  return found;
}

/** The settings file the client process was started with, from its command line (`--settings <path or json>`). */
function launchSettings(): AutomationFinding[] {
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 2_000 });
    const match = /--settings[= ](\S+)/.exec(args);
    if (!match) return [];
    const value = match[1]!;
    if (value.startsWith("{")) return HOOK_EVENT.test(value) ? [{ file: "--settings (inline)", why: "an Elicitation hook answers the approval dialog" }] : [];
    const finding = jsonHook(isAbsolute(value) ? value : resolve(value));
    return finding ? [finding] : [];
  } catch {
    return [];
  }
}

export function dialogAutomation(input: { repo?: string } = {}): AutomationFinding[] {
  const findings: AutomationFinding[] = [];
  const seen = new Set<string>();
  const check = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const finding = jsonHook(path);
    if (finding) findings.push(finding);
  };
  const projectRoots = new Set<string>([...ancestors(process.cwd()), ...(input.repo ? ancestors(input.repo) : [])]);
  const configDirs = new Set<string>([join(userInfo().homedir, ".claude"), ...(process.env.CLAUDE_CONFIG_DIR?.trim() ? [resolve(process.env.CLAUDE_CONFIG_DIR.trim())] : [])]);
  for (const root of projectRoots) for (const name of SETTINGS_NAMES) check(join(root, ".claude", name));
  for (const dir of configDirs) {
    for (const name of SETTINGS_NAMES) check(join(dir, name));
    // plugins: hooks/hooks.json and plugin manifests that declare hooks
    for (const file of walk(join(dir, "plugins"), (name) => name === "hooks.json" || name === "plugin.json")) check(file);
  }
  for (const managed of ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"]) {
    if (existsSync(managed)) check(managed);
  }
  // agent and skill definitions can carry hooks in their front matter
  for (const base of [...[...projectRoots].map((r) => join(r, ".claude")), ...configDirs]) {
    for (const file of walk(join(base, "agents"), (name) => name.endsWith(".md"), 3).concat(walk(join(base, "skills"), (name) => name.endsWith(".md"), 4))) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readText(file, 500_000);
      if (text && /^---[\s\S]*?\bhooks\s*:[\s\S]*?\bElicitation(Result)?\b[\s\S]*?^---/m.test(text)) findings.push({ file, why: "an agent or skill definition declares an Elicitation hook" });
    }
  }
  findings.push(...launchSettings());
  return findings;
}
