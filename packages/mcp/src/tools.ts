import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { OpContext } from "@praxis/cli/operations";
import {
  ApprovalError,
  ApprovalNeedsInput,
  approvalsGivenInThisCall,
  logDecision,
  subjectDigest,
  withApprovalChannel,
  type UserApprovalChannel,
  type WorkflowRole,
} from "@praxis/contracts";
import { runtimeBuildInfo, toolOrigin } from "./build-info.js";
import { hostPermissionChannel, hostPermissionMode, planOnlyChannel, planTextOf } from "./approval-channel.js";
import { mcpEnvelope, type McpEnvelope } from "./envelope.js";
import { toolsForRole, type PraxisRole } from "./catalog.js";
import { buildStoryVerification, commitServiceFix, planServiceFix } from "./story-engine.js";
import { developerWorkItemStatus, inspectWorkflow } from "./workflow-inspect.js";
import { sessionStart } from "./session-start.js";
import { applyResolved, applyWorkflow, applyWorkflowApproved, capabilityRoute, previewWorkflow, workflowStatus } from "./workflow-store.js";

export {
  TOOLS,
  toolsForRole,
  parseRole,
  parseRoleArgv,
  mcpConfig,
  PraxisMcpRoleError,
  PRAXIS_ROLES,
  type PraxisRole,
  type ToolDef,
  type JsonSchema,
} from "./catalog.js";

type Operations = typeof import("@praxis/cli/operations");

let operationsPromise: Promise<Operations> | undefined;

function loadOperations(): Promise<Operations> {
  operationsPromise ??= import("@praxis/cli/operations");
  return operationsPromise;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

function ctxFromArgs(args: Record<string, unknown>, extra?: Partial<OpContext>): OpContext {
  return {
    repo: str(args.repo) ?? process.cwd(),
    epic: str(args.epic),
    wp: str(args.workPackage) ?? str(args.wp) ?? str(args.workPackageId),
    confirmation: str(args.confirmation),
    previewFingerprint: str(args.previewFingerprint),
    actor: str(args.actor),
    reviewId: typeof args.reviewId === "number"
      ? args.reviewId
      : typeof args.reviewId === "string" && /^\d+$/.test(args.reviewId)
        ? Number(args.reviewId)
        : undefined,
    remoteName: str(args.remoteName),
    remoteUrl: str(args.remoteUrl),
    branch: str(args.branch),
    targetBranch: str(args.targetBranch),
    files: Array.isArray(args.files) ? args.files.filter((x): x is string => typeof x === "string") : undefined,
    commitMessage: str(args.commitMessage),
    gitUserName: str(args.gitUserName),
    gitUserEmail: str(args.gitUserEmail),
    gitPublishMode: args.mode === "baseline" ? "baseline" : args.mode === "branch" ? "branch" : undefined,
    providerKind: args.provider === "gitlab" ? "gitlab" : args.provider === "github" ? "github" : undefined,
    requirePreviewFingerprint: extra?.requirePreviewFingerprint,
    provider: extra?.provider,
    signal: extra?.signal,
    deadlineMs: extra?.deadlineMs,
  };
}

/**
 * Tools that change something outside the agent's own notes. Each one needs confirmation=YES (the agent's intent to
 * apply what it previewed) and then the user's approval, asked in the client's dialog when the client has one. The
 * approval is obtained where the change is made (core guardWrite, the workflow store, the fix committer), never here.
 * confirmation=NO is the user's refusal reported by the agent: it is recorded and nothing runs.
 */
const PROTECTED_TOOLS = new Set([
  "praxis_project_init_apply",
  "praxis_ba_apply",
  "praxis_architect_apply",
  "praxis_developer_claim",
  "praxis_developer_release",
  "praxis_developer_complete",
  "praxis_developer_complete_recovery_apply",
  "praxis_quality_apply",
  "praxis_developer_git_connect_apply",
  "praxis_developer_git_identity_apply",
  "praxis_developer_git_commit",
  "praxis_developer_git_publish",
  "praxis_developer_git_merge_request",
  "praxis_developer_git_link_jira_apply",
  "praxis_workflow_apply",
]);

/** What the connected MCP client declared at initialize, as far as approvals are concerned. */
export type ClientReport = {
  name?: string;
  version?: string;
  protocolVersion?: string;
  capabilities: string[];
  elicitation: { declared: object | null; form: boolean; url: boolean };
  /** True when Praxis can show the user an approval dialog on this connection. */
  dialog: boolean;
  /** server-initiated-request (up to 2025-11-25) or input-required-round-trip (2026-07-28). */
  flow: "server-initiated-request" | "input-required-round-trip";
  reason?: string;
};

/** The doctor shows the evidence for its approval mode: what this client declared and why a dialog is or is not offered. */
/**
 * What the user would be asked for a protected apply tool, computed from the live state, running nothing: the apply tool
 * runs against a channel that never answers, and everything that changes something asks before it changes anything.
 */
async function approvalPlan(args: Record<string, unknown>, ctx: OpContext, opts: { role: PraxisRole; version: string; extra?: Partial<OpContext>; client?: ClientReport }): Promise<unknown> {
  const target = str(args.tool);
  if (!target || !PROTECTED_TOOLS.has(target)) throw new Error(`INVALID_INPUT: tool must be one of ${[...PROTECTED_TOOLS].join(", ")}`);
  let targetArgs: Record<string, unknown>;
  try {
    targetArgs = JSON.parse(str(args.toolArguments) ?? "{}") as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_INPUT: toolArguments must be a JSON object");
  }
  const result = (request: { action: string; kind: string; summary: string; description: string; risks?: string[]; subject?: string }) => ({
    required: true,
    action: request.action,
    kind: request.kind,
    summary: request.summary,
    planText: planTextOf(request as never),
    ...(request.subject ? { subjectDigest: subjectDigest(request.subject) } : {}),
    note: "This is what the user is asked to approve. It runs nothing.",
  });
  if (target === "praxis_workflow_apply") {
    // an agent-authored record needs no approval; only a human act does
    const command = JSON.parse(String(targetArgs.command ?? "{}")) as Record<string, unknown>;
    const view = previewWorkflow(ctx.repo, command, str(targetArgs.workItemId)).humanApproval;
    return view ? result({ action: view.action, kind: view.kind, summary: view.summary, description: view.description, risks: view.risks }) : { required: false, note: "No approval is needed for this record; apply it directly." };
  }
  try {
    const envelope = await withApprovalChannel(planOnlyChannel, () => callToolInner(target, { ...targetArgs, repo: ctx.repo, confirmation: "YES" }, { role: opts.role, version: opts.version, extra: opts.extra }));
    return envelope.ok ? { required: false, note: "This call needs no approval." } : { required: false, code: envelope.code, errors: envelope.errors, note: "The apply tool refuses these arguments; fix them and ask again." };
  } catch (error) {
    if (error instanceof ApprovalNeedsInput) return result({ ...error.request, subject: error.request.subject });
    throw error;
  }
}

function withClientReport(data: unknown, client: ClientReport | undefined): unknown {
  if (!client || !data || typeof data !== "object") return data;
  const record = data as { approval?: Record<string, unknown>; data?: { approval?: Record<string, unknown> } };
  const target = record.data && typeof record.data === "object" ? record.data : record;
  if (target.approval) {
    target.approval = { ...target.approval, client };
    if (hostPermissionMode() && !client.dialog) {
      target.approval = {
        ...target.approval,
        mode: "host-permission",
        note: "OPT-IN host-permission mode: this client has no approval dialog, so protected actions rely on the host's own tool-permission prompt, which shows the exact plan (planText from praxis_approval_plan). Praxis cannot verify the prompt was shown: an always-allow setting for the tool removes it and then the agent approves itself. Quality fixes (commit and push) still need a dialog.",
      };
    }
  }
  return data;
}

export const isProtectedTool = (name: string): boolean => PROTECTED_TOOLS.has(name);

/** Says in the result how the user's approval was obtained: always in the client's own dialog (the agent cannot write that answer). */
function withApprovalNote(name: string, data: unknown): { data: unknown } {
  if (!PROTECTED_TOOLS.has(name)) return { data };
  const given = approvalsGivenInThisCall();
  if (given.length === 0) return { data };
  const approval = given.map((item) => ({ action: item.action, channel: item.channel, assurance: item.assurance, decidedAt: item.decidedAt }));
  return { data: data && typeof data === "object" && !Array.isArray(data) ? { ...(data as object), approval } : { result: data, approval } };
}

function preflight(name: string, args: Record<string, unknown>, ctx: OpContext, version: string): McpEnvelope | undefined {
  if (!PROTECTED_TOOLS.has(name)) return undefined;
  if (ctx.confirmation === "NO") {
    logDecision(ctx.repo, {
      at: new Date().toISOString(),
      action: name,
      summary: `${name} declined`,
      subjectDigest: subjectDigest(JSON.stringify({ name, previewFingerprint: str(args.previewFingerprint) ?? "" })),
      decision: "rejected",
      channel: "none",
      reason: "the user declined (reported by the agent)",
    });
    return mcpEnvelope({
      ok: false,
      operation: name,
      version,
      code: "APPROVAL_REJECTED",
      errors: [`${name} was rejected by the user. Nothing was changed.`],
    });
  }
  if (ctx.confirmation !== "YES") {
    return mcpEnvelope({
      ok: false,
      operation: name,
      version,
      code: "CONFIRMATION_REQUIRED",
      errors: [`${name} requires confirmation=YES after the preview was shown to the user`],
    });
  }
  return undefined;
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  opts: {
    role: PraxisRole;
    version: string;
    extra?: Partial<OpContext>;
    /** How to ask the user in the MCP client's own dialog. Absent when the client cannot: protected actions are then refused with the preview. */
    approvalChannel?: UserApprovalChannel;
    /** What the connected client declared (see describeClient in server.ts); shown by praxis_doctor. */
    client?: ClientReport;
  },
): Promise<McpEnvelope> {
  // OPT-IN (PRAXIS_APPROVAL_MODE=host-permission): a client with no dialog, the host's own tool-permission prompt, and the
  // exact plan in the arguments (see approval-channel.ts). Never chosen when the client has a dialog.
  const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const channel = opts.approvalChannel ?? (hostPermissionMode() && PROTECTED_TOOLS.has(name) ? hostPermissionChannel(str(args.planText)) : undefined);
  return withApprovalChannel(channel, () => callToolInner(name, rawArgs, opts));
}

async function callToolInner(
  name: string,
  rawArgs: unknown,
  opts: { role: PraxisRole; version: string; extra?: Partial<OpContext>; client?: ClientReport },
): Promise<McpEnvelope> {
  const ops = await loadOperations();
  const allowed = toolsForRole(opts.role);
  const def = allowed.find((t) => t.name === name);
  if (!def) {
    return mcpEnvelope({
      ok: false,
      operation: name,
      version: opts.version,
      code: "INVALID_INPUT",
      errors: [`tool not available for role ${opts.role}: ${name}`],
    });
  }
  const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const ctx = ctxFromArgs(args, {
    ...opts.extra,
  });
  ctx.instanceId = str(args.instanceId) ?? process.env.PRAXIS_JIRA_BASE_URL;
  ops.loadPraxisDotenv(ctx.repo);
  if (name === "praxis_ba_apply" || name === "praxis_architect_apply") {
    ctx.requirePreviewFingerprint = true;
  }
  if (name === "praxis_quality_apply" || name === "praxis_developer_git_commit" || name === "praxis_developer_git_publish" || name === "praxis_developer_git_connect_apply" || name === "praxis_developer_git_merge_request") {
    ctx.requirePreviewFingerprint = true;
  }
  const refused = preflight(name, args, ctx, opts.version);
  if (refused) return refused;
  try {
    if (name === "praxis_approval_plan") {
      return mcpEnvelope({ ok: true, operation: name, version: opts.version, data: await approvalPlan(args, ctx, opts) });
    }
    if (
      name === "praxis_workflow_status" ||
      name === "praxis_workflow_inspect" ||
      name === "praxis_session_start" ||
      name === "praxis_workflow_preview" ||
      name === "praxis_workflow_apply" ||
      name === "praxis_capabilities"
    ) {
      return mcpEnvelope({
        ok: true,
        operation: name,
        version: opts.version,
        ...withApprovalNote(name, await runWorkflowTool(name, args, ctx.repo, opts.version)),
      });
    }
    if (name === "praxis_developer_status" && str(args.workItemId)) {
      if (str(args.workPackage) ?? str(args.wp) ?? str(args.workPackageId)) {
        return mcpEnvelope({
          ok: false,
          operation: name,
          version: opts.version,
          code: "IDENTITY_AMBIGUOUS",
          errors: ["pass either workItemId (a Work Item) or workPackage (a Work Package or Jira key), not both"],
        });
      }
      return mcpEnvelope({
        ok: true,
        operation: name,
        version: opts.version,
        data: developerWorkItemStatus(ctx.repo, str(args.workItemId) as string),
      });
    }
    const dispatched = await dispatchTool(ops, name, ctx, opts.version, opts.role);
    const data = name === "praxis_doctor" ? withClientReport(dispatched, opts.client) : dispatched;
    if (
      (
        name === "praxis_quality_apply" ||
        name === "praxis_developer_git_connect_apply" ||
        name === "praxis_developer_git_commit" ||
        name === "praxis_developer_git_publish" ||
        name === "praxis_developer_git_merge_request" ||
        name === "praxis_developer_git_identity_apply"
      ) &&
      data &&
      typeof data === "object" &&
      "ok" in data &&
      (data as { ok?: unknown }).ok === false
    ) {
      const rec = data as { ok: false; errors?: string[]; code?: string; warnings?: string[]; recoveryInstructions?: string };
      return mcpEnvelope({
        ok: false,
        operation: name,
        version: opts.version,
        data,
        warnings: rec.warnings,
        errors: rec.errors?.length
          ? rec.errors
          : rec.recoveryInstructions
            ? [rec.recoveryInstructions]
            : [`${name} did not complete`],
        code: rec.code ?? (name === "praxis_quality_apply" ? "QUALITY_APPLY_INCOMPLETE" : "GIT_TRANSPORT_FAILED"),
      });
    }
    return mcpEnvelope({ ok: true, operation: name, version: opts.version, ...withApprovalNote(name, data) });
  } catch (err) {
    // not an error: the protocol layer must ask the user (2026-07-28 round trip) and re-run the call
    if (err instanceof ApprovalNeedsInput) throw err;
    const message = ops.redact(err instanceof Error ? err.message : String(err));
    const coded = err as { code?: unknown };
    const code =
      err instanceof ops.PraxisOpError
        ? err.code
        : typeof coded.code === "string" && /^(APPROVAL_|WORK_ITEM_|INSPECT_|SESSION_|IDENTITY_|WORKFLOW_(LOCKED|INDEX|CONFLICT))/.test(coded.code)
          ? coded.code
          : message.startsWith("FINGERPRINT_MISMATCH")
            ? "FINGERPRINT_MISMATCH"
            : name.startsWith("praxis_workflow")
              ? "INVALID_INPUT"
              : "EXTERNAL_SERVICE_ERROR";
    const details =
      err instanceof ops.PraxisOpError
        ? {
            ...(err.stage ? { stage: err.stage } : {}),
            ...(typeof err.durationMs === "number" ? { durationMs: err.durationMs } : {}),
            ...(err.details ? err.details : {}),
          }
        : err instanceof ApprovalError
          ? err.details
          : {};
    return mcpEnvelope({
      ok: false,
      operation: name,
      version: opts.version,
      code,
      errors: [message],
      data: details,
    });
  }
}

function hydrateWorkflowCommand(repo: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const command = { ...(raw as Record<string, unknown>) };
  const relative = command.implementationPath;
  if (typeof relative !== "string" || relative.length === 0) return command;
  const root = resolve(repo);
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error("implementation path escapes the repository");
  }
  command.implementationSource = readFileSync(absolute, "utf8");
  delete command.implementationPath;
  return command;
}

async function runWorkflowTool(name: string, args: Record<string, unknown>, repo: string, version: string): Promise<unknown> {
  const workItemId = str(args.workItemId);
  if (name === "praxis_workflow_inspect") {
    return inspectWorkflow(repo, { view: str(args.view), workItemId, id: str(args.id) });
  }
  if (name === "praxis_session_start") return sessionStart(repo, { role: str(args.role), stage: str(args.stage) }, version);
  if (name === "praxis_workflow_status") return workflowStatus(repo, workItemId);
  if (name === "praxis_capabilities") {
    const role = str(args.role);
    const allowed: WorkflowRole[] = ["user", "ba", "architect", "developer", "quality"];
    const resolved = allowed.includes(role as WorkflowRole) ? (role as WorkflowRole) : "user";
    return capabilityRoute({ request: str(args.request) ?? "", role: resolved });
  }
  const parsed = hydrateWorkflowCommand(repo, JSON.parse(str(args.command) ?? "")) as Record<string, unknown>;
  if (parsed.action === "verify-stories") {
    const recorded = await buildStoryVerification(repo, parsed.independentRerun === true, workItemId);
    const meta = recorded.meta;
    if (name === "praxis_workflow_preview") {
      const preview = previewWorkflow(repo, recorded, workItemId);
      return { ...preview, result: { ...(preview.result as object), ...meta } };
    }
    const applied = applyWorkflow(repo, recorded, str(args.previewFingerprint) ?? "", workItemId);
    return { ...applied, result: { ...(applied.result as object), ...meta } };
  }
  if (parsed.action === "prepare-fix") {
    if (parsed.authorized !== true) throw new Error("AUTHORIZATION_REQUIRED");
    const planned = await planServiceFix(
      repo,
      String(parsed.serviceId ?? ""),
      typeof parsed.existingBranch === "string" ? parsed.existingBranch : undefined,
      workItemId,
    );
    if (name === "praxis_workflow_preview") return previewWorkflow(repo, planned, workItemId);
    const committed = await commitServiceFix(repo, planned, workItemId, str(args.confirmation));
    return applyResolved(repo, str(args.previewFingerprint) ?? "", planned, committed, workItemId);
  }
  if (name === "praxis_workflow_preview") return previewWorkflow(repo, parsed, workItemId);
  return applyWorkflowApproved(repo, parsed, str(args.previewFingerprint) ?? "", workItemId, str(args.confirmation));
}

function withBuild(result: unknown, version: string, role: PraxisRole): unknown {
  const build = { ...runtimeBuildInfo(version), tools: toolOrigin(role) };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.data && typeof record.data === "object") return { ...record, data: { ...(record.data as object), build } };
    return { ...record, build };
  }
  return result;
}

async function dispatchTool(
  ops: Operations,
  name: string,
  ctx: OpContext,
  version: string,
  role: PraxisRole,
): Promise<unknown> {
  switch (name) {
    case "praxis_doctor":
      return withBuild(await ops.doctorOp(ctx, version), version, role);
    case "praxis_project_status":
      return ops.projectStatusOp(ctx);
    case "praxis_project_init_preview":
      return ops.projectInitPreviewOp(ctx);
    case "praxis_project_init_apply":
      return ops.projectInitApplyOp(ctx);
    case "praxis_jira_smoke":
      return ops.jiraSmokeOp(ctx);
    case "praxis_jira_discover":
      return ops.jiraDiscoverOp(ctx);
    case "praxis_jira_epic":
      return ops.jiraEpicOp(ctx);
    case "praxis_jira_status":
      return ops.jiraStatusOp(ctx);
    case "praxis_ba_status":
      return ops.baStatusOp(ctx);
    case "praxis_ba_preview":
      return ops.baPreviewOp(ctx);
    case "praxis_ba_apply":
      return ops.baApplyOp(ctx);
    case "praxis_architect_status":
      return ops.architectStatusOp(ctx);
    case "praxis_architect_preview":
      return ops.architectPreviewOp(ctx);
    case "praxis_architect_apply":
      return ops.architectApplyOp(ctx);
    case "praxis_work_package_list":
      return ops.workPackageListOp(ctx);
    case "praxis_work_package_show":
    case "praxis_work_package_status":
      return ops.workPackageShowOp(ctx);
    case "praxis_developer_status":
      return ops.developerStatusOp(ctx);
    case "praxis_developer_claim":
      return ops.developerClaimOp(ctx);
    case "praxis_developer_release":
      return ops.developerReleaseOp(ctx);
    case "praxis_developer_complete":
      return ops.developerCompleteOp(ctx);
    case "praxis_developer_complete_recovery_preview":
      return ops.developerCompleteRecoveryPreviewOp(ctx);
    case "praxis_developer_complete_recovery_apply":
      return ops.developerCompleteRecoveryApplyOp(ctx);
    case "praxis_quality_status":
      return ops.qualityStatusOp(ctx);
    case "praxis_quality_ensure":
      return ops.qualityEnsureOp(ctx);
    case "praxis_quality_review":
    case "praxis_quality_report":
      return ops.qualityReviewOp(ctx);
    case "praxis_quality_apply_preview":
      return ops.qualityApplyPreviewOp(ctx);
    case "praxis_quality_apply":
      return ops.qualityApplyOp(ctx);
    case "praxis_quality_apply_status":
      return ops.qualityApplyStatusOp(ctx);
    case "praxis_quality_review_show":
      return ops.qualityReviewShowOp(ctx);
    case "praxis_developer_git_status":
      return ops.developerGitStatusOp(ctx);
    case "praxis_developer_git_connect_preview":
      return ops.developerGitConnectPreviewOp(ctx);
    case "praxis_developer_git_connect_apply":
      return ops.developerGitConnectApplyOp(ctx);
    case "praxis_developer_git_identity_preview":
      return ops.developerGitIdentityPreviewOp(ctx);
    case "praxis_developer_git_identity_apply":
      return ops.developerGitIdentityApplyOp(ctx);
    case "praxis_developer_git_preview":
      return ops.developerGitPreviewOp(ctx);
    case "praxis_developer_git_commit":
      return ops.developerGitCommitOp(ctx);
    case "praxis_developer_git_publish_preview":
      return ops.developerGitPublishPreviewOp(ctx);
    case "praxis_developer_git_publish":
      return ops.developerGitPublishOp(ctx);
    case "praxis_developer_git_merge_request_preview":
      return ops.developerGitMergeRequestPreviewOp(ctx);
    case "praxis_developer_git_merge_request":
      return ops.developerGitMergeRequestOp(ctx);
    case "praxis_developer_git_delivery_status":
      return ops.developerGitDeliveryStatusOp(ctx);
    case "praxis_developer_git_link_jira_preview":
      return ops.developerGitLinkJiraPreviewOp(ctx);
    case "praxis_developer_git_link_jira_apply":
      return ops.developerGitLinkJiraApplyOp(ctx);
    default:
      throw new ops.PraxisOpError("INVALID_INPUT", `unknown tool ${name}`);
  }
}
