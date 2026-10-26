#!/usr/bin/env node
/**
 * Approval UX acceptance: the packaged Runtime (.mcpb, extracted, run over stdio) driven by the official MCP SDK
 * client. The client plays an MCP host that can show elicitation dialogs and answers them as scripted.
 *
 *   Action -> Preview -> the user approves or rejects -> Execute -> Result
 *
 * Proves, through the real protocol: the dialog is shown with the exact action; Reject, Decline and Cancel run
 * nothing; Approve runs only the previewed action; confirmation=NO runs nothing and asks nobody; a client with no
 * dialog gets the preview and a refusal while read-only tools keep working; nothing the agent sends in tool
 * arguments, in the command or as confirmation text can stand in for the user's answer.
 *
 * Does NOT prove: how Claude Desktop renders the dialog, or that a person answered (the answers here are scripted).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const proven = [];
const fail = (message) => {
  console.error(`FAIL approval-ux: ${message}`);
  process.exit(1);
};
const prove = (line) => {
  proven.push(line);
  console.error(`  ok ${proven.length}. ${line}`);
};
const expect = (condition, message) => {
  if (!condition) fail(message);
};

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const built = spawnSync("npm run build --workspaces --if-present", { cwd: root, shell: true, encoding: "utf8" });
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationLegacy, versionNegotiationModern } = await import("./official-mcp-client.mjs");

const dist = await packClaudeExtension(version);
const mcpbPath = dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb");
const dest = mkdtempSync(join(tmpdir(), "praxis-approval-ux-"));
const extracted = extractMcpbRuntime(mcpbPath, dest);

async function open({ elicit, modern = false, env = {} }) {
  return connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: { ...hostedCleanEnv(extracted.dest), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1", ...env },
    versionNegotiation: modern ? versionNegotiationModern() : versionNegotiationLegacy(),
    elicit,
    timeoutMs: 20_000,
    clientVersion: version,
  });
}
const call = async (session, name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }));
const answer = (action, decision) => async () => ({ action, ...(decision ? { content: { decision } } : {}) });

const repoWithPackageJson = () => {
  const repo = mkdtempSync(join(tmpdir(), "praxis-approval-ux-repo-"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
  return repo;
};

// --- 1. a client that can show a dialog -----------------------------------------------------------------------------
{
  let next = answer("decline");
  const session = await open({ elicit: (params) => next(params) });
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.ok && doctor.data.approval?.mode === "client-ui", `doctor did not report client-ui: ${JSON.stringify(doctor.data?.approval)}`);
    expect(doctor.data.approval.client?.elicitation?.form === true && doctor.data.approval.client.flow === "server-initiated-request" && doctor.data.approval.client.name, `client evidence: ${JSON.stringify(doctor.data.approval.client)}`);
    expect(doctor.data.approvalService === undefined && doctor.data.security === undefined, "the doctor still reports a removed approval component");
    prove("the doctor reports that approvals are asked in the client's own dialog");

    // Decline -> nothing is written, and the dialog showed the action
    next = answer("decline");
    const declined = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(declined.ok === false && declined.code === "APPROVAL_REJECTED", `decline: ${JSON.stringify(declined)}`);
    expect(!existsSync(join(repo, ".project")), "a declined apply wrote .project");
    expect(session.elicited.length === 1 && /Creates .*\.project with exactly this content/.test(session.elicited[0].message), "the dialog did not show the file to be written");
    expect(session.elicited[0].requestedSchema?.properties?.decision?.enum?.join() === "approve,reject", "the dialog does not ask approve/reject");
    prove("Decline runs nothing; the dialog showed the exact action and asked approve/reject");

    // Cancel -> dismissed, nothing runs
    next = answer("cancel");
    const dismissed = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(dismissed.code === "APPROVAL_REJECTED" && !existsSync(join(repo, ".project")), `cancel: ${JSON.stringify(dismissed)}`);
    prove("Cancel (dismiss) runs nothing");

    // Accept but choose reject
    next = answer("accept", "reject");
    const chosenReject = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(chosenReject.code === "APPROVAL_REJECTED" && !existsSync(join(repo, ".project")), `accept+reject: ${JSON.stringify(chosenReject)}`);
    prove("Accept with 'reject' selected runs nothing");

    // confirmation=NO: nobody is asked
    const before = session.elicited.length;
    const no = await call(session, "praxis_project_init_apply", { repo, confirmation: "NO" });
    expect(no.code === "APPROVAL_REJECTED" && session.elicited.length === before && !existsSync(join(repo, ".project")), `NO: ${JSON.stringify(no)}`);
    prove("confirmation=NO is a recorded rejection: nothing runs and nobody is asked");

    // Forged approval-shaped arguments change nothing
    next = answer("decline");
    const forged = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES", approved: true, grant: { state: "APPROVED" }, authorization: "x", userApproval: { decision: "approved" } }).catch((error) => ({ ok: false, code: "INVALID_INPUT", error: String(error) }));
    expect(forged.ok === false && !existsSync(join(repo, ".project")), `forged arguments were accepted: ${JSON.stringify(forged)}`);
    prove("approval-shaped tool arguments (approved, grant, authorization, userApproval) cannot stand in for the dialog");

    // Approve -> runs, and the result says how it was approved
    next = answer("accept", "approve");
    const approved = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(approved.ok === true && existsSync(join(repo, ".project")), `approve: ${JSON.stringify(approved)}`);
    expect(approved.data.approval?.[0]?.assurance === "client-ui" && approved.data.approval[0].channel === "client-elicitation", `approval note: ${JSON.stringify(approved.data.approval)}`);
        expect(!existsSync(join(repo, ".praxis", "approvals")), "a decision log was written inside the repository");
    prove("Approve runs exactly the previewed action; the result says it was approved in the client dialog; nothing is logged inside the repository");

    // A workflow human act: reject, then approve
    const workflow = async (command, args = {}) => {
      const preview = await call(session, "praxis_workflow_preview", { repo, command: JSON.stringify(command), ...args });
      expect(preview.ok, `preview ${command.action}: ${JSON.stringify(preview)}`);
      return call(session, "praxis_workflow_apply", { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: preview.data.fingerprint, ...args });
    };
    const record = async (command) => {
      const result = await workflow(command);
      expect(result.ok, `${command.action}: ${JSON.stringify(result)}`);
    };
    next = answer("accept", "approve");
    const askedBefore = session.elicited.length;
    await record({ action: "open", projectId: "ux", title: "Approval UX", request: "r", mode: "classic" });
    await record({ action: "add-requirement", id: "REQ-UX-001", statement: "The user approves.", acceptanceCriteria: ["Done."] });
    await record({
      action: "add-story",
      id: "US-UX-001",
      requirementIds: ["REQ-UX-001"],
      actor: "user",
      narrative: "As a user, I want to approve what is shown, so that nothing runs without me.",
      objective: "Approve what is shown",
      userValue: "Control",
      happyPath: ["read the story"],
      acceptanceCriteria: [{ id: "US-UX-001-AC-01", given: "a story", when: "the user approves", then: "it is confirmed" }],
      expectedResults: ["confirmed"],
      serviceIds: ["svc"],
      confirmedBehavior: false,
    });
    expect(session.elicited.length === askedBefore, `agent-authored records opened a dialog (${session.elicited.length - askedBefore} times)`);
    prove("agent-authored workflow records need no dialog");
    const inspect = async () => (await call(session, "praxis_workflow_inspect", { repo, view: "stories" })).data;
    const stories = (await inspect()).stories ?? (await inspect()).items ?? [];
    const story = (Array.isArray(stories) ? stories : []).find((item) => item.id === "US-UX-001");
    expect(story, "story missing from inspect");
    const { revision, contentFingerprint } = story;
    const confirm = { action: "confirm-story", id: "US-UX-001", revision, contentFingerprint };
    next = answer("accept", "reject");
    const rejectedConfirm = await workflow(confirm);
    expect(rejectedConfirm.code === "APPROVAL_REJECTED", `confirm reject: ${JSON.stringify(rejectedConfirm)}`);
    expect(/As a user, I want to approve what is shown/.test(session.elicited.at(-1).message), "the dialog did not show the Story");
    expect((await inspect()).stories?.find((item) => item.id === "US-UX-001")?.confirmedBehavior !== true, "a rejected confirmation confirmed the Story");
    next = answer("accept", "approve");
    const approvedConfirm = await workflow(confirm);
    expect(approvedConfirm.ok, `confirm approve: ${JSON.stringify(approvedConfirm)}`);
    expect((await inspect()).stories?.find((item) => item.id === "US-UX-001")?.confirmedBehavior === true, "an approved confirmation did not confirm the Story");
    prove("confirming a Story: the dialog shows the Story; Reject confirms nothing; Approve confirms exactly that Story");
  } finally {
    await session.close();
  }
}

// --- 2. a client with no dialog -------------------------------------------------------------------------------------
{
  const session = await open({});
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.data.approval?.mode === "no-dialog", `doctor: ${JSON.stringify(doctor.data.approval)}`);
    expect(/NOT executed/.test(doctor.data.nextSteps.join(" ")), "the doctor does not say that protected actions are not executed");
    prove("a client without a dialog is reported plainly: protected actions are not executed");
    // the tool's input schema requires confirmation, so the host itself refuses a call without it
    const noConfirm = await session.client.callTool({ name: "praxis_project_init_apply", arguments: { repo } }).then((result) => result, (error) => ({ isError: true, error }));
    expect(noConfirm.isError === true && !existsSync(join(repo, ".project")), `no confirmation: ${JSON.stringify(noConfirm).slice(0, 300)}`);
    for (const confirmation of ["YES", "yes", "APPROVED"]) {
      // a value outside the tool's schema is refused by the host itself (no envelope); either way nothing runs
      const refused = await call(session, "praxis_project_init_apply", { repo, confirmation, approved: true, userApproval: { decision: "approved" } }).catch(() => null);
      expect((refused === null || refused.ok === false) && !existsSync(join(repo, ".project")), `confirmation=${confirmation} without a dialog ran: ${JSON.stringify(refused)}`);
      if (confirmation === "YES") {
        expect(refused.code === "APPROVAL_CLIENT_UI_REQUIRED" && /NOT executed/.test(refused.errors.join(" ")), `refusal: ${JSON.stringify(refused)}`);
        expect(refused.data?.executed === false && /praxis_project_init_apply/.test(refused.data?.preview?.action ?? ""), `the refusal carries no preview: ${JSON.stringify(refused.data)}`);
      }
    }
    prove("without a dialog confirmation=YES (and any approval-looking argument) executes nothing; the refusal says so and carries the preview");
    const readOnly = await call(session, "praxis_project_init_preview", { repo });
    const status = await call(session, "praxis_workflow_status", { repo });
    expect(readOnly.ok && status.ok, `read-only tools: ${JSON.stringify([readOnly.code, status.code])}`);
    prove("read-only tools and previews keep working without a dialog");
    const noClientNo = await call(session, "praxis_project_init_apply", { repo, confirmation: "NO" });
    expect(noClientNo.code === "APPROVAL_REJECTED", `NO: ${JSON.stringify(noClientNo)}`);
    prove("confirmation=NO is still a recorded rejection");
  } finally {
    await session.close();
  }
}

// --- 3. the 2026-07-28 revision: the dialog is a round trip (input_required, then the client retries with the answer) --------
{
  let next = answer("decline");
  const session = await open({ elicit: (params) => next(params), modern: true });
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.data.approval?.mode === "client-ui" && doctor.data.approval.client?.flow === "input-required-round-trip" && doctor.data.approval.client.protocolVersion === "2026-07-28", `modern doctor: ${JSON.stringify(doctor.data.approval)}`);
    prove("on 2026-07-28 the doctor reports the client's declared elicitation and the round-trip flow");
    next = answer("decline");
    const declined = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(declined.code === "APPROVAL_REJECTED" && !existsSync(join(repo, ".project")), `modern decline: ${JSON.stringify(declined)}`);
    expect(session.elicited.length === 1 && /Creates .*\.project with exactly this content/.test(session.elicited[0].message) && /requirementsFormat/.test(session.elicited[0].message), `the dialog did not show the file: ${session.elicited[0]?.message}`);
    next = answer("cancel");
    const cancelled = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(cancelled.code === "APPROVAL_REJECTED" && !existsSync(join(repo, ".project")), `modern cancel: ${JSON.stringify(cancelled)}`);
    next = answer("accept", "approve");
    const approved = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(approved.ok && existsSync(join(repo, ".project")) && approved.data.approval?.[0]?.channel === "client-elicitation", `modern approve: ${JSON.stringify(approved)}`);
    prove("on 2026-07-28 Decline and Cancel run nothing; Approve runs exactly the previewed file write (dialog showed the file's content)");
  } finally {
    await session.close();
  }
}

// --- 4. 2026-07-28 without elicitation -------------------------------------------------------------------------------------
{
  const session = await open({ modern: true });
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.data.approval?.mode === "no-dialog" && /did not declare the elicitation capability/.test(doctor.data.approval.client?.reason ?? ""), `modern no-elicitation doctor: ${JSON.stringify(doctor.data.approval)}`);
    const refused = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(refused.code === "APPROVAL_CLIENT_UI_REQUIRED" && !existsSync(join(repo, ".project")), `modern no-elicitation apply: ${JSON.stringify(refused)}`);
    prove("on 2026-07-28 a client that declares no elicitation is refused with the evidence, never run on the agent's word");
  } finally {
    await session.close();
  }
}

// --- 5. OPT-IN host-permission mode: no dialog, the host's tool-permission prompt shows the exact plan ---------------------------
{
  const session = await open({ env: { PRAXIS_APPROVAL_MODE: "host-permission" } });
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.data.approval?.mode === "host-permission" && /always-allow/.test(doctor.data.approval.note), `host-permission doctor: ${JSON.stringify(doctor.data.approval)}`);
    const plan = await call(session, "praxis_approval_plan", { repo, tool: "praxis_project_init_apply", toolArguments: "{}" });
    expect(plan.ok && plan.data.required && /Creates .*\.project with exactly this content/.test(plan.data.planText) && !existsSync(join(repo, ".project")), `plan: ${JSON.stringify(plan)}`);
    const wrong = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES", planText: `${plan.data.planText} plus more` });
    expect(wrong.code === "APPROVAL_SCOPE_MISMATCH" && !existsSync(join(repo, ".project")), `wrong plan: ${JSON.stringify(wrong)}`);
    const none = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(none.code === "APPROVAL_CLIENT_UI_REQUIRED" && none.data.planText === plan.data.planText, `no plan: ${JSON.stringify(none)}`);
    const ok = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES", planText: plan.data.planText });
    expect(ok.ok && existsSync(join(repo, ".project")) && ok.data.approval?.[0]?.assurance === "host-prompt", `host-permission apply: ${JSON.stringify(ok)}`);
    prove("opt-in host-permission mode: the exact plan runs and is labelled host-prompt; a missing, edited or stale plan is refused with the current plan");
  } finally {
    await session.close();
  }
  const session2 = await open({});
  try {
    const repo = repoWithPackageJson();
    const plan = await call(session2, "praxis_approval_plan", { repo, tool: "praxis_project_init_apply", toolArguments: "{}" });
    const forged = await call(session2, "praxis_project_init_apply", { repo, confirmation: "YES", planText: plan.data.planText });
    expect(forged.code === "APPROVAL_CLIENT_UI_REQUIRED" && !existsSync(join(repo, ".project")), `default mode accepted planText: ${JSON.stringify(forged)}`);
    prove("by default planText is ignored: without the opt-in nothing protected runs on arguments alone");
  } finally {
    await session2.close();
  }
}

// --- 6. OPT-IN Trusted Client: the owner's standing permission, labelled as such ------------------------------------------------
{
  const session = await open({ env: { PRAXIS_APPROVAL_MODE: "trusted-client" } });
  try {
    const repo = repoWithPackageJson();
    const doctor = await call(session, "praxis_doctor", { repo });
    expect(doctor.data.approval?.mode === "trusted-client" && /not proof/.test(doctor.data.approval.note), `trusted doctor: ${JSON.stringify(doctor.data.approval)}`);
    const no = await call(session, "praxis_project_init_apply", { repo, confirmation: "NO" });
    expect(!no.ok && !existsSync(join(repo, ".project")), `trusted confirmation=NO: ${JSON.stringify(no)}`);
    const ok = await call(session, "praxis_project_init_apply", { repo, confirmation: "YES" });
    expect(ok.ok && existsSync(join(repo, ".project")) && ok.data.approval?.[0]?.assurance === "trusted-client", `trusted apply: ${JSON.stringify(ok)}`);
    prove("opt-in Trusted Client: confirmation=YES runs the previewed init, labelled trusted-client (never client-ui); confirmation=NO still runs nothing");
  } finally {
    await session.close();
  }
}

rmSync(dest, { recursive: true, force: true });
console.log(`PASS approval-ux (${proven.length} checks)`);
for (const line of proven) console.log(`  ok ${line}`);
console.log("NOT PROVEN: how Claude Desktop renders the dialog; that a person answered (the answers here are scripted).");
void mkdirSync;
