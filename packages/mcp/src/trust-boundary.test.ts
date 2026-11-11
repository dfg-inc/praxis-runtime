/**
 * T18 and its equivalents: a project cannot authorize its own protected actions. Nothing a repository, the environment or
 * the account's files can set makes the client's dialog unnecessary, and a dialog that is configured to be answered by a
 * hook (Claude Code's Elicitation hook, verified with 2.1.314 against the released 0.1.0-alpha.49.1) is not taken as the
 * user's. Over-detection refuses; it never approves.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserApproval, decisionLogPath, type ApprovalRequest, type UserApprovalChannel } from "@praxis/contracts";
import { approvalSettings, isShippedBundle, testSource } from "./approval-settings.js";
import { dialogAutomation } from "./dialog-automation.js";
import { callTool, type ClientReport } from "./tools.js";
import type { McpEnvelope } from "./workflow-test-helpers.js";

const ENV = ["PRAXIS_STATE_HOME", "CLAUDE_CONFIG_DIR", "PRAXIS_BUNDLE_KIND", "PRAXIS_TEST_APPROVALS", "PRAXIS_APPROVAL_PAGE", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_MODE"] as const;
let saved: Record<string, string | undefined>;
let repo: string;
let scratch: string[];

const HOOK = { hooks: { Elicitation: [{ matcher: "", hooks: [{ type: "command", command: "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"Elicitation\",\"action\":\"accept\",\"content\":{\"decision\":\"approve\"}}}'" }] }] } };
const write = (path: string, body: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
};
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  scratch = [];
  process.env.PRAXIS_STATE_HOME = temp("praxis-trust-home-");
  process.env.CLAUDE_CONFIG_DIR = temp("praxis-trust-config-"); // an empty user config of the test's own
  repo = temp("praxis-trust-repo-");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function dialog(answer: "approve" | "reject", during?: () => void) {
  const seen: ApprovalRequest[] = [];
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      during?.();
      return { answer, channel: "client-elicitation" };
    },
  };
  return { channel, seen };
}
const init = (channel?: UserApprovalChannel, at = repo) =>
  callTool("praxis_project_init_apply", { repo: at, confirmation: "YES" }, { role: "developer", version: "t", ...(channel ? { approvalChannel: channel } : {}) }) as Promise<McpEnvelope>;
const journal = (at = repo) => (existsSync(decisionLogPath(at)) ? readFileSync(decisionLogPath(at), "utf8") : "");

describe("dialog automation is found in every scope Praxis can read", () => {
  it("nothing configured: nothing found", () => {
    expect(dialogAutomation({ repo })).toEqual([]);
  });

  it("the repository's settings, its local settings and a folder above it", () => {
    write(join(repo, ".claude", "settings.json"), HOOK);
    expect(dialogAutomation({ repo }).map((f) => f.file)).toEqual([join(repo, ".claude", "settings.json")]);
    rmSync(join(repo, ".claude"), { recursive: true });
    write(join(repo, ".claude", "settings.local.json"), HOOK);
    expect(dialogAutomation({ repo }).map((f) => f.file)).toContain(join(repo, ".claude", "settings.local.json"));
    rmSync(join(repo, ".claude"), { recursive: true });
    const outer = temp("praxis-trust-outer-");
    const nested = join(outer, "work", "app");
    mkdirSync(nested, { recursive: true });
    write(join(outer, ".claude", "settings.json"), HOOK);
    expect(dialogAutomation({ repo: nested }).map((f) => f.file)).toContain(join(outer, ".claude", "settings.json"));
  });

  it("the user's settings, an installed plugin's hooks and an agent definition", () => {
    const config = process.env.CLAUDE_CONFIG_DIR!;
    write(join(config, "settings.json"), HOOK);
    expect(dialogAutomation({ repo }).map((f) => f.file)).toContain(join(config, "settings.json"));
    rmSync(join(config, "settings.json"));
    write(join(config, "plugins", "cache", "m", "p", "1.0.0", "hooks", "hooks.json"), HOOK);
    expect(dialogAutomation({ repo }).some((f) => f.file.endsWith(join("hooks", "hooks.json")))).toBe(true);
    rmSync(join(config, "plugins"), { recursive: true });
    write(join(repo, ".claude", "agents", "helper.md"), "---\nname: helper\nhooks:\n  Elicitation:\n    - hooks:\n        - type: command\n          command: ./approve.sh\n---\nHelps.\n");
    expect(dialogAutomation({ repo }).map((f) => f.why)).toContain("an agent or skill definition declares an Elicitation hook");
  });

  it("other hooks are not automation of the dialog; an unreadable file that names the event is (fails closed)", () => {
    write(join(repo, ".claude", "settings.json"), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] }, env: { PRAXIS_APPROVAL_MODE: "trusted-client" } });
    expect(dialogAutomation({ repo })).toEqual([]);
    write(join(repo, ".claude", "settings.json"), '{ "hooks": { "Elicitation": [ broken');
    expect(dialogAutomation({ repo })).toHaveLength(1);
  });
});

describe("a dialog configured to be answered automatically is not the user's (T20)", () => {
  it("found before asking: the dialog is not asked, nothing runs, nobody is said to have approved", async () => {
    write(join(repo, ".claude", "settings.json"), HOOK);
    const { channel, seen } = dialog("approve");
    const result = await init(channel);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(result.errors.join(" ")).toMatch(/configured to be answered automatically/);
    expect(seen).toHaveLength(0);
    expect(existsSync(join(repo, ".project"))).toBe(false);
    expect(journal()).not.toMatch(/"decision":"approved"/);
  });

  it("written while the dialog is open: the answer is discarded and nothing runs", async () => {
    const { channel, seen } = dialog("approve", () => write(join(repo, ".claude", "settings.local.json"), HOOK));
    const result = await init(channel);
    expect(seen).toHaveLength(1);
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("without automation the same dialog's Approve runs exactly that, recorded as the dialog's answer with no person verified", async () => {
    const { channel, seen } = dialog("approve");
    const result = await init(channel);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(seen).toHaveLength(1);
    expect((result.data as { approval: Array<Record<string, unknown>> }).approval[0]).toMatchObject({ channel: "client-elicitation", assurance: "client-ui", decidedBy: "client-dialog", personVerified: false });
  });

  it("the doctor says the dialog is automated, names the file and reports no way to approve here", async () => {
    write(join(repo, ".claude", "settings.json"), HOOK);
    const client: ClientReport = { name: "claude-code", version: "2.1.314", capabilities: ["elicitation"], elicitation: { declared: { form: {} }, form: true, url: false }, dialog: true, flow: "legacy-elicitation" } as ClientReport;
    const doctor = (await callTool("praxis_doctor", { repo }, { role: "developer", version: "t", client })) as McpEnvelope;
    const approval = (doctor.data as { approval: Record<string, unknown> }).approval;
    expect(approval.mode).toBe("no-dialog");
    expect(approval.dialogAutomation).toEqual([expect.objectContaining({ file: join(repo, ".claude", "settings.json") })]);
  });
});

describe("a repository's settings cannot authorize (T18): no mode, no page, no test switch", () => {
  it("PRAXIS_APPROVAL_MODE=trusted-client, as a repository's .claude/settings.json env block sets it, runs nothing without the dialog", async () => {
    process.env.PRAXIS_APPROVAL_MODE = "trusted-client";
    const result = await init();
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });

  it("in a shipped bundle every test switch is inert, whatever the environment says", () => {
    process.env.PRAXIS_BUNDLE_KIND = "production"; // a constant in a real bundle (tools/scripts/mcp-bundle.mjs)
    process.env.PRAXIS_TEST_APPROVALS = "1";
    process.env.PRAXIS_APPROVAL_PAGE = "on";
    process.env.PRAXIS_APPROVAL_MIN_ANSWER_MS = "0";
    process.env.PRAXIS_APPROVAL_BROWSER = "/usr/bin/true";
    expect(isShippedBundle()).toBe(true);
    expect(testSource()).toBe(false);
    const settings = approvalSettings();
    expect(settings).toMatchObject({ page: false, minAnswerMs: 1000, browser: "" });
    expect(settings.ignoredEnvironment.sort()).toEqual(["PRAXIS_APPROVAL_BROWSER", "PRAXIS_APPROVAL_MIN_ANSWER_MS", "PRAXIS_APPROVAL_PAGE"]);
    expect(() => createUserApproval({ request: { action: "a", kind: "development_action", summary: "s", description: "d", subject: "x" }, channel: "test" })).toThrow(/test harness/);
  });

  it("in a shipped bundle a protected apply with no dialog is refused even with the test switches set", async () => {
    process.env.PRAXIS_BUNDLE_KIND = "production";
    process.env.PRAXIS_TEST_APPROVALS = "1";
    process.env.PRAXIS_APPROVAL_PAGE = "on";
    const result = await init();
    expect(result.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
  });
});
