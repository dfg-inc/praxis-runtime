/**
 * Approval settings: in a shipped Runtime nothing can make approval weaker.
 *
 * Every source of configuration a Runtime can read is reachable by someone other than the person deciding: Claude Code
 * passes a repository's `.claude/settings.json` `env` block to MCP servers (released 0.1.0-alpha.48 to alpha.49.1 took
 * PRAXIS_APPROVAL_MODE=trusted-client from it), and the account's own files, the Desktop extension settings included, are
 * writable by an agent with a shell on that account. So no setting enables a standing permission (the Trusted Client and
 * host-permission modes are removed), lowers the answer-time rule, or turns the approval page on for protected actions.
 * Settings that make approval stricter (the page off, a longer minimum answer time) are taken from anywhere.
 *
 * Tests run the source (never a shipped bundle, whose kind is fixed when it is built) and may set the test-only values.
 */

export const DEFAULT_MIN_ANSWER_MS = 1000;

/** A shipped bundle: PRAXIS_BUNDLE_KIND is replaced by a constant when the bundle is built, so no environment changes it. */
export const isShippedBundle = (): boolean => process.env.PRAXIS_BUNDLE_KIND === "production";

/** Unit and acceptance tests running the source, never a shipped bundle. */
export const testSource = (): boolean => !isShippedBundle() && process.env.PRAXIS_TEST_APPROVALS === "1";

/** Read by released 0.1.0-alpha.48 to alpha.49.1 (the Trusted Client and host-permission modes) and by nothing now. */
const RETIRED = ["PRAXIS_APPROVAL_MODE"] as const;
/** Read by the test source only; a shipped Runtime ignores them. */
const TEST_ONLY = ["PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_PAGE_MIN_MS", "PRAXIS_TEST_ANCESTRY"] as const;

export type ApprovalSettings = {
  minAnswerMs: number;
  /** The approval page is never used for protected actions in a shipped Runtime (docs/approval-threat-model.md). */
  page: boolean;
  pageMinMs: number;
  waitMs: number;
  browser: string;
  /** Weakening variables found in the environment and ignored. */
  ignoredEnvironment: string[];
};

const numberOf = (raw: unknown): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

const on = (raw: string | undefined): boolean => /^(on|true|1|yes)$/i.test(raw?.trim() ?? "");

export function approvalSettings(): ApprovalSettings {
  const env = process.env;
  const test = testSource();
  const envMin = numberOf(env.PRAXIS_APPROVAL_MIN_ANSWER_MS);
  // stricter from anywhere; lower only in the test source
  const minAnswerMs = test && envMin !== undefined ? envMin : Math.max(DEFAULT_MIN_ANSWER_MS, envMin ?? 0);
  const ignoredEnvironment = [
    ...RETIRED.filter((key) => env[key]?.trim()),
    ...(test ? [] : [...TEST_ONLY.filter((key) => env[key]?.trim()), ...(envMin !== undefined && envMin < DEFAULT_MIN_ANSWER_MS ? ["PRAXIS_APPROVAL_MIN_ANSWER_MS"] : []), ...(on(env.PRAXIS_APPROVAL_PAGE) ? ["PRAXIS_APPROVAL_PAGE"] : [])]),
  ];
  const wait = numberOf(env.PRAXIS_APPROVAL_PAGE_WAIT_MS);
  return {
    minAnswerMs,
    // the page mechanism is kept for a future approval authority and exercised by tests only
    page: test && on(env.PRAXIS_APPROVAL_PAGE),
    pageMinMs: test ? (numberOf(env.PRAXIS_APPROVAL_PAGE_MIN_MS) ?? 3000) : 3000,
    waitMs: wait !== undefined ? Math.min(wait, 110_000) : 45_000,
    browser: test ? env.PRAXIS_APPROVAL_BROWSER?.trim() ?? "" : "",
    ignoredEnvironment,
  };
}
