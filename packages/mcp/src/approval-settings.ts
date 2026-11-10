import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the approval settings come from, so that a repository cannot weaken them.
 *
 * Claude Code applies the `env` block of a repository's own `.claude/settings.json` to the MCP servers it starts (verified
 * with Claude Code 2.1.314: a repository set PRAXIS_APPROVAL_MODE=trusted-client for the Praxis plugin). The environment of
 * a Runtime started by Claude Code (the Desktop Code tab, Cowork, the CLI) is therefore partly the repository's. Settings
 * that make approval weaker are read from the environment only when no repository can reach it:
 *   - the Claude Desktop extension: Desktop starts it from its extension folder with the extension settings the person
 *     chose; a repository's settings do not reach it;
 *   - otherwise only from ~/.praxis/approval-settings.json in the account's real home (from the OS account, not $HOME),
 *     a file the person owns that is not group- or world-writable. Environment values of the same names are ignored, and
 *     the doctor says so.
 * Settings that make approval stricter (the page off, a longer minimum answer time) are taken from anywhere.
 *
 * What this does not stop: anything that can write files as the person (an agent with a shell, repository code Praxis runs)
 * can write that file too (docs/approval-threat-model.md T6).
 */

export const DEFAULT_MIN_ANSWER_MS = 1000;
export const DEFAULT_PAGE_MIN_MS = 3000;
const WEAKENING = ["PRAXIS_APPROVAL_MODE", "PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_PAGE_MIN_MS"] as const;

type FileSettings = { mode?: string; browser?: string; minAnswerMs?: number; pageMinMs?: number; page?: boolean };

export const approvalSettingsPath = (): string => join(userInfo().homedir, ".praxis", "approval-settings.json");

/** The bundle runs from <extension>/server/praxis-mcp.cjs and the extension's manifest.json names praxis-runtime. */
export function launchedAsExtension(): boolean {
  const entry = process.argv[1];
  if (!entry || !/\.cjs$/.test(entry)) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "manifest.json"), "utf8")) as { name?: string; server?: unknown };
    return manifest.name === "praxis-runtime" && manifest.server !== undefined;
  } catch {
    return false;
  }
}

/** Unit tests run the source with PRAXIS_TEST_APPROVALS=1; a shipped bundle (kind fixed at build time) never trusts that. */
const testSource = (): boolean => process.env.PRAXIS_TEST_APPROVALS === "1" && process.env.PRAXIS_BUNDLE_KIND !== "production";

function readFileSettings(): { settings: FileSettings; refused?: string } {
  const path = approvalSettingsPath();
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { settings: {}, refused: "not a regular file" };
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return { settings: {}, refused: "not owned by this account" };
    if ((stat.mode & 0o022) !== 0) return { settings: {}, refused: "writable by group or others" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileSettings;
    return { settings: parsed && typeof parsed === "object" ? parsed : {} };
  } catch (error) {
    return { settings: {}, ...((error as { code?: string }).code === "ENOENT" ? {} : { refused: "unreadable" }) };
  }
}

export type ApprovalSettings = {
  mode: "trusted-client" | "host-permission" | "";
  browser: string;
  minAnswerMs: number;
  /** No page decision is taken sooner than this after the page's first load. */
  pageMinMs: number;
  page: boolean;
  waitMs: number;
  source: "extension settings" | "approval-settings.json" | "defaults";
  /** Weakening variables found in the environment and ignored because a repository could have set them. */
  ignoredEnvironment: string[];
  file: { path: string; refused?: string };
};

const modeOf = (raw: unknown): ApprovalSettings["mode"] => (raw === "trusted-client" || raw === "host-permission" ? raw : "");
const numberOf = (raw: unknown): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function approvalSettings(): ApprovalSettings {
  const env = process.env;
  const trustedEnv = launchedAsExtension() || testSource();
  const { settings: file, refused } = trustedEnv ? { settings: {} as FileSettings } : readFileSettings();
  const stricter: Partial<Record<(typeof WEAKENING)[number], number>> = { PRAXIS_APPROVAL_MIN_ANSWER_MS: DEFAULT_MIN_ANSWER_MS, PRAXIS_APPROVAL_PAGE_MIN_MS: DEFAULT_PAGE_MIN_MS };
  const ignoredEnvironment = trustedEnv ? [] : WEAKENING.filter((key) => env[key]?.trim() && !(stricter[key] !== undefined && (numberOf(env[key]) ?? 0) >= stricter[key]!));
  // a time limit: stricter wins from any source; a lower value only from a trusted source
  const limit = (key: "PRAXIS_APPROVAL_MIN_ANSWER_MS" | "PRAXIS_APPROVAL_PAGE_MIN_MS", fromFile: unknown, fallback: number) => {
    const fromEnv = numberOf(env[key]);
    if (trustedEnv) return fromEnv ?? fallback;
    return Math.max(numberOf(fromFile) ?? fallback, fromEnv !== undefined && fromEnv >= fallback ? fromEnv : 0);
  };
  const minAnswerMs = limit("PRAXIS_APPROVAL_MIN_ANSWER_MS", file.minAnswerMs, DEFAULT_MIN_ANSWER_MS);
  const pageMinMs = limit("PRAXIS_APPROVAL_PAGE_MIN_MS", file.pageMinMs, DEFAULT_PAGE_MIN_MS);
  const pageOff = (value: unknown) => /^(off|false|0|no)$/i.test(String(value ?? "").trim());
  const wait = numberOf(env.PRAXIS_APPROVAL_PAGE_WAIT_MS);
  const value: ApprovalSettings = {
    mode: modeOf(trustedEnv ? env.PRAXIS_APPROVAL_MODE?.trim() : file.mode),
    browser: (trustedEnv ? env.PRAXIS_APPROVAL_BROWSER : file.browser)?.trim() ?? "",
    minAnswerMs,
    pageMinMs,
    page: !(pageOff(env.PRAXIS_APPROVAL_PAGE) || file.page === false),
    waitMs: wait !== undefined ? Math.min(wait, 110_000) : 45_000,
    source: launchedAsExtension() ? "extension settings" : Object.keys(file).length ? "approval-settings.json" : "defaults",
    ignoredEnvironment,
    file: { path: approvalSettingsPath(), ...(refused ? { refused } : {}) },
  };
  return value;
}
