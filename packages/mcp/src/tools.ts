import type { OpContext } from "@praxis/cli/operations";
import { mcpEnvelope, type McpEnvelope } from "./envelope.js";
import { toolsForRole, type PraxisRole } from "./catalog.js";

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

export async function callTool(
  name: string,
  rawArgs: unknown,
  opts: { role: PraxisRole; version: string; extra?: Partial<OpContext> },
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
  ops.loadPraxisDotenv(ctx.repo);
  if (name === "praxis_ba_apply" || name === "praxis_architect_apply") {
    ctx.requirePreviewFingerprint = true;
  }
  if (name === "praxis_quality_apply" || name === "praxis_developer_git_commit" || name === "praxis_developer_git_publish" || name === "praxis_developer_git_connect_apply" || name === "praxis_developer_git_merge_request") {
    ctx.requirePreviewFingerprint = true;
  }
  if (
    name === "praxis_developer_claim" ||
    name === "praxis_developer_complete" ||
    name === "praxis_developer_complete_recovery_apply" ||
    name === "praxis_quality_apply" ||
    name === "praxis_developer_git_connect_apply" ||
    name === "praxis_developer_git_identity_apply" ||
    name === "praxis_developer_git_commit" ||
    name === "praxis_developer_git_publish" ||
    name === "praxis_developer_git_merge_request" ||
    name === "praxis_developer_git_link_jira_apply"
  ) {
    if (ctx.confirmation !== "YES") {
      return mcpEnvelope({
        ok: false,
        operation: name,
        version: opts.version,
        code: "CONFIRMATION_REQUIRED",
        errors: [`${name} requires confirmation=YES`],
      });
    }
  }
  try {
    const data = await dispatchTool(ops, name, ctx, opts.version);
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
    return mcpEnvelope({ ok: true, operation: name, version: opts.version, data });
  } catch (err) {
    const message = ops.redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof ops.PraxisOpError ? err.code : "EXTERNAL_SERVICE_ERROR";
    const details =
      err instanceof ops.PraxisOpError
        ? {
            ...(err.stage ? { stage: err.stage } : {}),
            ...(typeof err.durationMs === "number" ? { durationMs: err.durationMs } : {}),
            ...(err.details ? err.details : {}),
          }
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

async function dispatchTool(
  ops: Operations,
  name: string,
  ctx: OpContext,
  version: string,
): Promise<unknown> {
  switch (name) {
    case "praxis_doctor":
      return ops.doctorOp(ctx, version);
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
