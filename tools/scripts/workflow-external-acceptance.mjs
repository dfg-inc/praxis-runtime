#!/usr/bin/env node
/**
 * External workflow acceptance.
 * Drives praxis_workflow_* through the MCP tool entry, then resumes in a
 * second process. Does not write to Jira.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { packClaudeExtension } from "./pack-claude-extension.mjs";
import { createWorkflowHarness, HARNESS_NOTICE } from "./trusted-workflow-harness.mjs";
import { extractMcpbRuntime } from "./mcpb-runtime.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  parseDoctorEnvelope,
  versionNegotiationModern,
  MCP_STARTUP_BUDGET_MS,
} from "./official-mcp-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const repo = mkdtempSync(join(tmpdir(), "praxis-workflow-accept-"));
const report = {
  repo,
  version,
  ...HARNESS_NOTICE,
  checks: [],
  blocked: [],
  notExecuted: [],
};

function record(name, ok, detail) {
  report.checks.push({ name, result: ok ? "PASS" : "FAIL", detail });
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`);
  }
}

function finish(code) {
  console.log(JSON.stringify(report, null, 2));
  rmSync(repo, { recursive: true, force: true });
  process.exit(code);
}

const { callTool } = await import(
  pathToFileURL(join(root, "packages/mcp/dist/tools.js")).href
);

const PARTIAL =
  "Invalid, duplicate or failed rows never prevent valid rows from being created. The import is not all-or-nothing; each row has its own outcome.";
const DEFECTIVE = `export async function importRows(db, rows) {
  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (row.invalid) throw new Error("invalid row aborts the import");
      await tx.insert(row);
    }
  });
}
`;
const FIXED = `export async function importRows(db, rows) {
  for (const row of rows) {
    if (row.invalid) continue;
    await db.insert(row);
  }
}
`;

function service(id, kind, dependsOn, status) {
  return {
    id,
    name: id,
    kind,
    responsibilities: [`${id} responsibility`],
    requirementIds: ["REQ-BUI-061"],
    dependsOn,
    status,
  };
}

const harness = createWorkflowHarness({ callTool, repo, version });
const { preview, applyWith, apply, state } = harness;

try {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "import-rows.js"), DEFECTIVE);

  const opened = await apply({
    action: "open",
    mode: "classic",
    projectId: "bulk-user-import",
    title: "Bulk User Import",
    request: "Import users from a CSV file. Columns are email, name, and role.",
    source: "local",
  });
  const workflowId = opened.workflowId;
  record("open-without-jira", state().workItem.jiraIssueKey == null, workflowId);
  {
    // Agent-authored records need no approval; human acts are refused without the owner's grant, not merely unapproved.
    const decision = { action: "record-decision", id: "D-PROBE", statement: "probe", confirmed: true };
    const probe = await callTool("praxis_workflow_preview", { repo, command: JSON.stringify(decision) }, { role: "runtime", version });
    record("agent-cannot-confirm-a-decision", probe.ok === false && /cannot confirm it/.test(probe.errors?.join(" ") ?? ""), String(probe.errors?.[0]).slice(0, 80));
  }


  const clarified = await apply({
    action: "clarify",
    role: "ba",
    known: ["columns are email, name, and role"],
    questions: [
      { id: "Q-COLUMNS", prompt: "Which columns does the CSV contain?", alreadyKnown: true },
      {
        id: "Q-ROLES",
        prompt: "Which product roles may appear in the role column?",
        changesBehavior: true,
      },
      {
        id: "Q-RETRY",
        prompt: "How many automatic retries should a failed row get?",
        safeAssumption: true,
        assumption: "A failed row uses the platform retry default before it is marked FAILED.",
      },
    ],
  });
  const asked = clarified.result.questions.map((item) => item.id);
  record("asks-only-blocking", asked.length === 1 && asked[0] === "Q-ROLES", asked.join(","));
  record(
    "records-assumption",
    state().assumptions.some((item) => item.id === "A-Q-RETRY"),
    state().assumptions.map((item) => item.id).join(","),
  );

  await apply({
    action: "add-requirement",
    id: "REQ-BUI-063",
    statement: "Each data row ends with exactly one final outcome.",
    acceptanceCriteria: ["AC-BUI-063: no completed row remains PENDING."],
  });
  record(
    "continues-unaffected-work",
    state().requirements.some((item) => item.id === "REQ-BUI-063"),
    state().stage,
  );

  await apply({
    action: "record-decision",
    id: "D-ROLES",
    statement: "The role column accepts organization admin and member.",
  });
  await harness.confirmDecision("D-ROLES");
  await apply({
    action: "add-requirement",
    id: "REQ-BUI-061",
    statement: PARTIAL,
    acceptanceCriteria: [
      "AC-BUI-061: 950 valid rows are created when 50 rows are invalid.",
    ],
    serviceIds: ["api", "worker", "identity", "frontend"],
  });
  const requirement = state().requirements.find((item) => item.id === "REQ-BUI-061");
  record(
    "requirement-and-criterion",
    requirement?.acceptanceCriteria?.[0]?.id === "REQ-BUI-061-AC-01",
    requirement?.acceptanceCriteria?.[0]?.id,
  );

  for (const item of [
    service("api", "api", [], "in_progress"),
    service("identity", "external", [], "in_progress"),
    service("worker", "worker", ["api", "identity"], "in_progress"),
    service("frontend", "frontend", ["api"], "in_progress"),
  ]) {
    await apply({ action: "set-service", service: item });
  }

  const baHandoff = {
    action: "handoff",
    sourceRole: "ba",
    targetRole: "architect",
    requirementIds: ["REQ-BUI-061", "REQ-BUI-063"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
    assumptions: ["CSV is UTF-8"],
  };
  await apply(baHandoff);
  const duplicate = await apply(baHandoff);
  record("duplicate-handoff", duplicate.duplicate === true && state().handoffs.length === 1, String(state().handoffs.length));

  await apply({
    action: "record-decision",
    id: "ADR-BUI-061",
    statement: "Each service records a row outcome. The worker must not wrap the file in one transaction.",
  });
  await harness.confirmDecision("ADR-BUI-061");
  await apply({
    action: "handoff",
    sourceRole: "architect",
    targetRole: "ba",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["worker"],
    readiness: "blocked",
    openQuestions: ["Should an invalid role be rejected at validation or failed during execution?"],
  });
  record(
    "architect-returns-to-ba",
    state().handoffs.at(-1)?.targetRole === "ba" && state().handoffs.at(-1)?.sourceRole === "architect",
    state().handoffs.at(-1)?.handoffId,
  );
  await apply({
    action: "record-decision",
    id: "D-INVALID-ROLE",
    statement: "An invalid role is rejected at validation and does not abort valid rows.",
  });
  await harness.confirmDecision("D-INVALID-ROLE");
  await apply({
    action: "handoff",
    sourceRole: "ba",
    targetRole: "architect",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
  });
  await apply({
    action: "handoff",
    sourceRole: "architect",
    targetRole: "developer",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
    nextActions: ["Implement per-service row outcomes"],
  });
  const developerHandoff = state().handoffs.at(-1);
  record(
    "architect-to-developer-carries-criterion",
    developerHandoff?.targetRole === "developer" &&
      developerHandoff.acceptanceCriterionIds.includes("REQ-BUI-061-AC-01") &&
      developerHandoff.decisions.includes("ADR-BUI-061"),
    developerHandoff?.acceptanceCriterionIds?.join(","),
  );

  const units = [
    ["IMPL-API", "api", "src/import-api.js", "import-request"],
    ["IMPL-IDENTITY", "identity", "src/identity-role.js", "role-catalog"],
    ["IMPL-WORKER", "worker", "src/import-rows.js", "row-outcome"],
    ["IMPL-FRONTEND", "frontend", "src/import-progress.js", "progress-view"],
  ];
  for (const [id, serviceId, path, contractRef] of units) {
    writeFileSync(join(repo, path), serviceId === "worker" ? DEFECTIVE : `export const service = ${JSON.stringify(serviceId)};\n`);
    await apply({
      action: "record-implementation",
      id,
      serviceId,
      requirementIds: ["REQ-BUI-061"],
      path,
      summary: `${serviceId} implementation`,
      contractRef,
    });
  }
  await apply({
    action: "handoff",
    sourceRole: "developer",
    targetRole: "quality",
    requirementIds: ["REQ-BUI-061"],
    serviceIds: ["api", "worker", "identity", "frontend"],
    readiness: "ready",
  });
  const qualityHandoff = state().handoffs.at(-1);
  record(
    "developer-to-quality-carries-paths",
    qualityHandoff?.artifactRefs?.some((item) => item.path === "src/import-rows.js") &&
      qualityHandoff.evidenceRefs.includes("worker:src/import-rows.js"),
    qualityHandoff?.evidenceRefs?.join(","),
  );

  const failed = await apply({
    action: "quality-check",
    requirementId: "REQ-BUI-061",
    implementationPath: "src/import-rows.js",
    observedBehavior: "partial-success",
    testsGreen: true,
    developerClaimsPass: true,
    serviceId: "worker",
  });
  record(
    "defective-implementation-fails",
    failed.result.verdict === "FAIL" &&
      failed.result.observedBehavior === "all-or-nothing" &&
      JSON.stringify(failed.result).includes("unsupported-claim:partial-success"),
    failed.result.verdict,
  );
  record(
    "quality-returns-to-developer",
    state().handoffs.at(-1)?.sourceRole === "quality" && state().handoffs.at(-1)?.targetRole === "developer",
    state().handoffs.at(-1)?.handoffId,
  );

  await apply({
    action: "revise-requirement",
    id: "REQ-BUI-061",
    statement: `${PARTIAL} Confirmed across api, worker, identity, and frontend.`,
  });
  record(
    "revision-stales-downstream",
    state().verdicts.some((item) => item.scopeId === "REQ-BUI-061" && item.stale) &&
      state().implementationUnits.every((item) => item.stale),
    `verdicts=${state().verdicts.length}`,
  );

  writeFileSync(join(repo, "src", "import-rows.js"), FIXED);
  for (const [id, serviceId, path, contractRef] of units) {
    await apply({
      action: "record-implementation",
      id,
      serviceId,
      requirementIds: ["REQ-BUI-061"],
      path,
      summary: `${serviceId} implementation`,
      contractRef,
    });
  }
  const passed = await apply({
    action: "quality-check",
    requirementId: "REQ-BUI-061",
    implementationPath: "src/import-rows.js",
    testsGreen: true,
    developerClaimsPass: true,
    serviceId: "worker",
  });
  record("corrected-implementation-passes", passed.result.verdict === "PASS", passed.result.observedBehavior);

  const sibling = await apply({
    action: "quality-check",
    requirementId: "REQ-BUI-063",
    observedBehavior: "unspecified",
  });
  record("missing-evidence-is-not-pass", sibling.result.verdict === "PASS_WITH_RISKS", sibling.result.verdict);

  const earlyFeature = await apply({ action: "feature-verdict" });
  record("feature-fails-until-complete", earlyFeature.result.verdict === "FAIL", earlyFeature.result.gaps?.join(" | "));

  await apply({
    action: "quality-check",
    requirementId: "REQ-BUI-063",
    implementationPath: "src/import-rows.js",
    serviceId: "worker",
  });
  {
    // An agent cannot approve a service: preview shows what the owner would be asked, and apply is refused.
    const candidate = { action: "set-service", service: service("api", "api", [], "approved") };
    const fingerprint = await preview(candidate);
    const shown = await callTool("praxis_workflow_preview", { repo, command: JSON.stringify(candidate) }, { role: "runtime", version });
    // no client dialog for this call: the agent's own confirmation=YES must not approve the service
    const refused = await callTool("praxis_workflow_apply", { repo, command: JSON.stringify(candidate), previewFingerprint: fingerprint, confirmation: "YES" }, { role: "runtime", version });
    record(
      "agent-cannot-approve-a-service",
      shown.ok === true && refused.ok === false && refused.code === "APPROVAL_CLIENT_UI_REQUIRED" && state().services.find((item) => item.id === "api")?.status !== "approved",
      `${shown.ok}/${refused.code}`,
    );
  }
  for (const item of [
    service("api", "api", [], "approved"),
    service("identity", "external", [], "approved"),
    service("worker", "worker", ["api", "identity"], "approved"),
    service("frontend", "frontend", ["api"], "approved"),
  ]) {
    await harness.approveService(item);
  }
  const feature = await apply({ action: "feature-verdict" });
  record("feature-pass-preserves-services", feature.result.verdict === "PASS", feature.result.gaps?.join(" | "));

  const saved = state();
  const trace = [
    saved.history[0]?.note,
    saved.requirements.map((item) => item.id).join(","),
    saved.requirements.find((item) => item.id === "REQ-BUI-061")?.acceptanceCriteria?.[0]?.id,
    saved.decisions.map((item) => item.id).join(","),
    saved.implementationUnits.map((item) => `${item.serviceId}:${item.path}`).join(","),
    saved.verdicts.map((item) => `${item.scope}:${item.scopeId}:${item.verdict}:${item.stale}`).join(","),
  ];
  record("trace-has-no-jira-key", !JSON.stringify(saved).includes("PRX-") && saved.workItem.jiraIssueKey == null, trace[0]);
  record("trace-chain", trace.every(Boolean), trace.join(" || "));

  const caps = await callTool(
    "praxis_capabilities",
    { repo, role: "architect", request: "security authorization architecture for the import" },
    { role: "runtime", version },
  );
  record(
    "capabilities-do-not-execute",
    caps.ok &&
      Array.isArray(caps.data?.executed) &&
      caps.data.executed.length === 0 &&
      caps.data.guidance.some((item) => item.id === "cap.architect.security"),
    `executed=${caps.data?.executed?.length}`,
  );
  const status = await callTool("praxis_workflow_status", { repo }, { role: "runtime", version });
  record(
    "status-attaches-guidance-without-execution",
    status.ok && Array.isArray(status.data?.executed) && status.data.executed.length === 0,
    `next=${status.data?.nextRole}`,
  );

  const handoffsBefore = state().handoffs.length;
  const statusModule = pathToFileURL(join(root, "packages/mcp/dist/workflow-store.js")).href;
  const resumed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { workflowStatus } from ${JSON.stringify(statusModule)};
       process.stdout.write(JSON.stringify(workflowStatus(process.argv[1])));`,
      repo,
    ],
    { encoding: "utf8" },
  );
  const resumedStatus = resumed.status === 0 ? JSON.parse(resumed.stdout) : null;
  record(
    "new-process-resumes",
    resumedStatus?.workflowId === workflowId &&
      resumedStatus.requirementIds.includes("REQ-BUI-061") &&
      state().handoffs.length === handoffsBefore,
    resumed.stderr || resumed.stdout,
  );

  const installedManifest = join(
    process.env.HOME ?? "",
    "Library/Application Support/Claude/Claude Extensions/local.mcpb.dfuture-co.praxis-runtime/manifest.json",
  );
  let installedVersion = "not-installed";
  try {
    installedVersion = JSON.parse(readFileSync(installedManifest, "utf8")).version ?? "unknown";
  } catch {
    installedVersion = "not-installed";
  }
  report.blocked.push({
    name: "claude-desktop-installed-host",
    result: "BLOCKED",
    detail: `Installed Desktop runtime is ${installedVersion}. Current role skill ZIPs are not installed in Claude Code. Desktop UI was not driven. Packaged MCPB invocation follows.`,
  });
  report.notExecuted.push({
    name: "jira-mutating-apply",
    result: "NOT EXECUTED",
    detail: "No Jira write was performed. Read-only status is recorded separately and is not evidence of apply.",
  });

  if (process.env.PRAXIS_JIRA_BASE_URL && process.env.PRAXIS_JIRA_TOKEN) {
    const jira = await callTool(
      "praxis_ba_status",
      { repo: "/Users/serg/work/praxis-acceptance/praxis-test", epic: "PRX-5" },
      { role: "ba", version },
    );
    const data = jira.data && typeof jira.data === "object" ? jira.data : {};
    const summary = [data.epicKey, data.key, data.summary, data.epic?.key, data.epic?.fields?.summary]
      .filter((item) => typeof item === "string")
      .join(" ");
    record(
      "jira-prx-5-readonly",
      jira.ok === true,
      jira.ok ? summary.slice(0, 180) || "ok" : (jira.code ?? "failed"),
    );
  } else {
    report.notExecuted.push({
      name: "jira-prx-5-readonly",
      result: "NOT EXECUTED",
      detail: "PRAXIS_JIRA_BASE_URL or PRAXIS_JIRA_TOKEN is not set in this process.",
    });
  }

  const packed = await packClaudeExtension(version);
  const mcpbPath = packed?.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb");
  const unpack = mkdtempSync(join(tmpdir(), "praxis-mcp-workflow-"));
  try {
    const extracted = extractMcpbRuntime(mcpbPath, unpack);
    const session = await connectOfficialMcp({
      command: process.execPath,
      args: extracted.args,
      cwd: extracted.dest,
      env: hostedCleanEnv(extracted.dest),
      versionNegotiation: versionNegotiationModern(),
      timeoutMs: MCP_STARTUP_BUDGET_MS,
      clientVersion: version,
    });
    try {
      const listed = await session.client.listTools();
      const names = (listed.tools ?? []).map((tool) => tool.name);
      const remote = await session.client.callTool({
        name: "praxis_workflow_status",
        arguments: { repo },
      });
      const envelope = parseDoctorEnvelope(remote);
      record(
        "packaged-mcpb-workflow-status",
        names.includes("praxis_workflow_status") &&
          names.includes("praxis_capabilities") &&
          envelope?.ok === true &&
          envelope.data?.workflowId === workflowId,
        `tools=${names.filter((name) => name.startsWith("praxis_workflow") || name === "praxis_capabilities").join(",")}`,
      );
      // Read-only inspection over the real MCP protocol, against the packaged runtime.
      const inspect = parseDoctorEnvelope(
        await session.client.callTool({ name: "praxis_workflow_inspect", arguments: { repo, view: "all" } }),
      );
      record(
        "packaged-mcpb-inspects-stored-workflow",
        names.includes("praxis_workflow_inspect") &&
          inspect?.ok === true &&
          inspect.data?.readOnly === true &&
          inspect.data?.requirements?.some((item) => item.id === "REQ-BUI-061" && item.statement && item.acceptanceCriteria?.length > 0) &&
          Array.isArray(inspect.data?.handoffs?.items) &&
          inspect.data.handoffs.items.length > 0 &&
          !JSON.stringify(inspect.data).includes(repo),
        `requirements=${inspect?.data?.requirements?.length} handoffs=${inspect?.data?.handoffs?.items?.length}`,
      );
      const started = parseDoctorEnvelope(
        await session.client.callTool({ name: "praxis_session_start", arguments: { repo, role: "quality" } }),
      );
      record(
        "packaged-mcpb-session-start",
        started?.ok === true && started.data?.stage === "quality" && started.data?.workflow?.present === true,
        `stage=${started?.data?.stage}`,
      );
      const doctor = parseDoctorEnvelope(await session.client.callTool({ name: "praxis_doctor", arguments: { repo } }));
      record(
        "packaged-mcpb-build-fingerprint",
        doctor?.data?.build?.origin === "bundle" &&
          /^[0-9a-f]{64}$/.test(doctor.data.build.bundleSha256 ?? "") &&
          /^[0-9a-f]{64}$/.test(doctor.data.build.sourceDigest ?? ""),
        `bundle=${doctor?.data?.build?.bundleSha256?.slice(0, 12)} tools=${names.length}`,
      );
    } finally {
      await session.close();
    }
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
} catch (err) {
  record("workflow-acceptance", false, err instanceof Error ? err.stack ?? err.message : String(err));
  finish(1);
}

const failed = report.checks.some((item) => item.result !== "PASS");
finish(failed ? 1 : 0);
