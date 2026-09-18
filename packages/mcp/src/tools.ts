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
  if (
    name === "praxis_developer_claim" ||
    name === "praxis_quality_review" ||
    name === "praxis_quality_report"
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
    case "praxis_quality_status":
      return ops.qualityStatusOp(ctx);
    case "praxis_quality_ensure":
      return ops.qualityEnsureOp(ctx);
    case "praxis_quality_review":
    case "praxis_quality_report":
      return ops.qualityReviewOp(ctx);
    default:
      throw new ops.PraxisOpError("INVALID_INPUT", `unknown tool ${name}`);
  }
}
