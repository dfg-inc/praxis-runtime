#!/usr/bin/env node
/**
 * 0.1.0-alpha.49.3, Agent A: bundle-level acceptance of the privileged-input and credential-hygiene fixes.
 *
 *   node tools/scripts/credential-hygiene-acceptance.mjs [--bundle <praxis-mcp.cjs>] [--out <dir>]
 *
 * Builds a PRODUCTION-kind bundle (PRAXIS_BUNDLE_KIND is a compile-time constant there) unless --bundle names one, starts it
 * over stdio with the official MCP client (no elicitation: nothing here expects a dialog), and checks:
 *   - privileged inputs a repository's settings could deliver (PRAXIS_TEST_APPROVALS, PRAXIS_APPROVAL_PAGE,
 *     PRAXIS_APPROVAL_MIN_ANSWER_MS, PRAXIS_APPROVAL_MODE, PRAXIS_TEST_ANCESTRY, PRAXIS_STATE_HOME, HOME, a repository .env)
 *     change nothing: the decision journal is in the account home from the OS account database, protected actions are
 *     refused without a dialog and write nothing;
 *   - fake tokens planted under every credential variable never appear in any tool result, error, doctor report, stderr line
 *     or diagnostics line, while a Jira capture server that echoes the token and a work item title that holds one make sure
 *     the values do reach Praxis's output path and come back as [REDACTED:<NAME>];
 *   - a repository's Claude Code settings that set the Jira base URL get CREDENTIAL_SOURCE_UNTRUSTED, and the capture server
 *     receives nothing.
 * Fake tokens only. The journal file a production bundle writes for the temporary repository is removed afterwards.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePraxisMcp } from "./mcp-bundle.mjs";
import { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope } from "./official-mcp-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const out = resolve(arg("--out") ?? mkdtempSync(join(tmpdir(), "praxis-a-accept-")));
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const bundle = arg("--bundle") ? resolve(arg("--bundle")) : await bundlePraxisMcp(join(out, "bundle", "praxis-mcp.cjs"), version, "production");

const FAKE = {
  PRAXIS_JIRA_TOKEN: "praxis-fake-token-jira-accept-71c2",
  PRAXIS_GITHUB_TOKEN: "praxis-fake-token-github-accept-8d1e",
  PRAXIS_GITLAB_TOKEN: "praxis-fake-token-gitlab-accept-0f3a",
  PRAXIS_GIT_TOKEN: "praxis-fake-token-git-accept-5b5b",
  GITHUB_TOKEN: "praxis-fake-token-ghenv-accept-2c2c",
  GH_TOKEN: "praxis-fake-token-ghcli-accept-9a9a",
  GITLAB_TOKEN: "praxis-fake-token-glenv-accept-4e4e",
};
const forms = (v) => [v, Buffer.from(v).toString("base64").replace(/=+$/, ""), encodeURIComponent(v)];
const leaks = (text) => Object.entries(FAKE).filter(([, v]) => forms(v).some((f) => text.includes(f))).map(([k]) => k);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
};

const seen = [];
const jira = createServer((req, res) => {
  const auth = String(req.headers.authorization ?? "");
  seen.push({ url: req.url, auth: auth ? "present" : "absent" });
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ errorMessages: [`token rejected: ${auth.replace(/^Bearer\s+/i, "")}`] }));
});
await new Promise((done) => jira.listen(0, "127.0.0.1", done));
const jiraUrl = `http://127.0.0.1:${jira.address().port}`;

const work = realpathSync(mkdtempSync(join(tmpdir(), "praxis-a-accept-work-")));
const home = join(work, "home");
const repo = join(work, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
writeFileSync(join(repo, ".env"), "PRAXIS_STATE_HOME=./state\nPRAXIS_TEST_APPROVALS=1\nPRAXIS_APPROVAL_MODE=trusted-client\nPRAXIS_JIRA_BASE_URL=http://127.0.0.1:9\n");
const accountJournalDir = join(userInfo().homedir, ".praxis", "decisions");
const journalsBefore = new Set(existsSync(accountJournalDir) ? readdirSync(accountJournalDir) : []);
const stateHome = join(repo, ".state");

const env = {
  ...hostedCleanEnv(home),
  PRAXIS_SKIP_DOTENV: "", // the repository .env is read, and must change nothing
  ...FAKE,
  PRAXIS_JIRA_BASE_URL: jiraUrl,
  PRAXIS_JIRA_PROJECT_KEY: "PRX",
  PRAXIS_JIRA_MODE: "datacenter",
  PRAXIS_JIRA_RETRY_BACKOFF_MS: "0",
  PRAXIS_QUALITY_URL: "http://127.0.0.1:9/health",
  // privileged inputs a repository's .claude/settings.json env block could deliver
  PRAXIS_TEST_APPROVALS: "1",
  PRAXIS_APPROVAL_PAGE: "on",
  PRAXIS_APPROVAL_MIN_ANSWER_MS: "0",
  PRAXIS_APPROVAL_MODE: "trusted-client",
  PRAXIS_TEST_ANCESTRY: JSON.stringify(["plain-client"]),
  PRAXIS_STATE_HOME: stateHome,
};

const results = [];
let session;
try {
  session = await connectOfficialMcp({ command: process.execPath, args: [bundle, "--role", "runtime"], cwd: repo, env, timeoutMs: 10_000 });
  const call = async (name, args = {}) => {
    const result = await session.client.callTool({ name, arguments: { repo, ...args } });
    const text = JSON.stringify(result);
    results.push({ name, text });
    return { envelope: parseDoctorEnvelope(result), text };
  };

  // privileged inputs
  const doctor = await call("praxis_doctor");
  const approval = doctor.envelope?.data?.approval ?? {};
  check("production bundle reports kind production", doctor.envelope?.data?.build?.kind === "production", JSON.stringify(doctor.envelope?.data?.build));
  check("decision journal is in the account home from the OS account database", String(approval.decisionLog).startsWith(accountJournalDir + "/"), approval.decisionLog);
  check("PRAXIS_STATE_HOME, HOME and the repository .env do not move it", !String(approval.decisionLog).startsWith(repo) && !String(approval.decisionLog).startsWith(home), approval.decisionLog);
  check("doctor states personVerified and independentlyVerified false", approval.personVerified === false && approval.independentlyVerified === false);
  check("no approval mode is enabled by the environment", approval.mode === "no-dialog");
  check("the repository .env keys were refused", ["PRAXIS_APPROVAL_MODE", "PRAXIS_STATE_HOME", "PRAXIS_TEST_APPROVALS", "PRAXIS_JIRA_BASE_URL"].every((k) => (doctor.envelope?.data?.dotenvRefused ?? []).some((r) => r.key === k)));
  const exposure = doctor.envelope?.data?.credentialExposure ?? {};
  check("credentialExposure names the inherited credential variables", JSON.stringify(exposure.inheritedCredentialVariables) === JSON.stringify(Object.keys(FAKE).sort()), JSON.stringify(exposure.inheritedCredentialVariables));
  const init = await call("praxis_project_init_apply", { confirmation: "YES" });
  check("a protected action is refused without a dialog, test switches notwithstanding", init.envelope?.code === "APPROVAL_CLIENT_UI_REQUIRED", init.envelope?.code);
  check("nothing was written", !existsSync(join(repo, ".project")));
  check("the refusal says how it was decided", init.envelope?.data?.authorization?.personVerified === false && init.envelope?.data?.authorization?.independentlyVerified === false, JSON.stringify(init.envelope?.data?.authorization));

  // redaction: values reach the output path on purpose
  const smoke = await call("praxis_jira_smoke");
  check("the Jira capture server was asked (operator configuration is honoured)", seen.length > 0);
  check("the echoed token comes back redacted", smoke.text.includes("[REDACTED:PRAXIS_JIRA_TOKEN]") && leaks(smoke.text).length === 0, smoke.text.slice(0, 300));
  const preview = await call("praxis_workflow_preview", { command: JSON.stringify({ action: "open", mode: "classic", projectId: "p", title: `T ${FAKE.GH_TOKEN}`, request: "r" }) });
  check("a token in a work item title comes back redacted", preview.text.includes("[REDACTED:GH_TOKEN]") && leaks(preview.text).length === 0);
  const listed = await session.client.listTools();
  for (const tool of listed.tools ?? []) {
    if (tool.name === "praxis_quality_ensure") continue; // would start a real Quality service
    const args = {};
    for (const key of tool.inputSchema?.required ?? []) args[key] = key === "confirmation" ? "NO" : key === "reviewId" ? 1 : `WP-${FAKE.PRAXIS_GIT_TOKEN}`;
    if (tool.inputSchema?.properties?.serve) args.serve = false;
    try {
      await call(tool.name, args);
    } catch (error) {
      results.push({ name: tool.name, text: String(error?.message ?? error) });
    }
  }
  const leaked = results.filter((r) => leaks(r.text).length);
  check(`no result or error of ${results.length} calls carries a token`, leaked.length === 0, leaked.map((r) => `${r.name}:${leaks(r.text)}`).join(", "));
} finally {
  await session?.close().catch(() => undefined);
}
const stderr = session?.stderr() ?? "";
check("stderr carries no token", leaks(stderr).length === 0);
const diag = join(stateHome, "diagnostics", "mcp.jsonl");
check("the diagnostics log carries no token", existsSync(diag) && leaks(readFileSync(diag, "utf8")).length === 0, existsSync(diag) ? "" : "no diagnostics file");

// a repository's Claude Code settings that set the destination: the token is not used, nothing reaches the server
const before = seen.length;
mkdirSync(join(repo, ".claude"), { recursive: true });
writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ env: { PRAXIS_JIRA_BASE_URL: jiraUrl } }));
let second;
try {
  second = await connectOfficialMcp({ command: process.execPath, args: [bundle, "--role", "runtime"], cwd: repo, env, timeoutMs: 10_000 });
  const result = await second.client.callTool({ name: "praxis_jira_smoke", arguments: { repo } });
  const envelope = parseDoctorEnvelope(result);
  check("a repository-set Jira base URL refuses the token", envelope?.code === "CREDENTIAL_SOURCE_UNTRUSTED", envelope?.code);
  check("the capture server received nothing", seen.length === before, `${seen.length - before} request(s)`);
} finally {
  await second?.close().catch(() => undefined);
}

await new Promise((done) => jira.close(() => done()));
// a production bundle journals in the account home: remove exactly the files this run created there
const created = (existsSync(accountJournalDir) ? readdirSync(accountJournalDir) : []).filter((f) => !journalsBefore.has(f));
for (const file of created) {
  const first = readFileSync(join(accountJournalDir, file), "utf8").split("\n")[0] ?? "";
  if (first.includes(JSON.stringify(work).slice(1, -1))) rmSync(join(accountJournalDir, file), { force: true });
}
rmSync(work, { recursive: true, force: true });
const failed = checks.filter((c) => !c.ok);
writeFileSync(join(out, "credential-hygiene-acceptance.json"), `${JSON.stringify({ bundle, checks }, null, 2)}\n`);
console.log(`credential-hygiene-acceptance: ${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
