import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { OpContext } from "@praxis/cli/operations";
import {
  abortConsumption,
  approvalSummary,
  beginConsumption,
  completeConsumption,
  inspectMutation,
  readApproval,
  type ApprovalOperation,
  type WorkflowRole,
} from "@praxis/contracts";
import { mcpEnvelope, type McpEnvelope } from "./envelope.js";
import { toolsForRole, type PraxisRole } from "./catalog.js";
import { buildStoryVerification, commitServiceFix, planServiceFix } from "./story-engine.js";
import { applyResolved, applyWorkflow, capabilityRoute, previewWorkflow, workflowStatus } from "./workflow-store.js";

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

const YES_BEFORE_APPROVAL = new Set([
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

const MCP_MUTATIONS: Record<string, { operation: ApprovalOperation; provider: "jira" | "local"; workItem: "epic" | "wp" | "none" }> = {
  praxis_project_init_apply: { operation: "repository_edit", provider: "local", workItem: "none" },
  praxis_ba_apply: { operation: "external_record_update", provider: "jira", workItem: "epic" },
  praxis_architect_apply: { operation: "external_record_update", provider: "jira", workItem: "epic" },
  praxis_developer_claim: { operation: "external_state_change", provider: "jira", workItem: "wp" },
  praxis_developer_release: { operation: "external_state_change", provider: "jira", workItem: "wp" },
  praxis_developer_complete: { operation: "external_state_change", provider: "jira", workItem: "wp" },
  praxis_developer_complete_recovery_apply: { operation: "external_state_change", provider: "jira", workItem: "wp" },
  praxis_quality_apply: { operation: "external_state_change", provider: "jira", workItem: "wp" },
  praxis_developer_git_connect_apply: { operation: "repository_edit", provider: "local", workItem: "wp" },
  praxis_developer_git_identity_apply: { operation: "repository_edit", provider: "local", workItem: "wp" },
  praxis_developer_git_commit: { operation: "git_commit", provider: "local", workItem: "wp" },
  praxis_developer_git_publish: { operation: "git_push", provider: "local", workItem: "wp" },
  praxis_developer_git_merge_request: { operation: "merge_request", provider: "local", workItem: "wp" },
  praxis_developer_git_link_jira_apply: { operation: "external_record_update", provider: "jira", workItem: "wp" },
};

function openMcpGate(
  name: string,
  args: Record<string, unknown>,
  ctx: OpContext & { planId?: string; planFingerprint?: string; instanceId?: string; approvalConsumed?: boolean },
  version: string,
): { envelope?: McpEnvelope; finish?: (data: unknown) => void; abort?: () => void } {
  if (YES_BEFORE_APPROVAL.has(name) && ctx.confirmation !== "YES") {
    return {
      envelope: mcpEnvelope({
        ok: false,
        operation: name,
        version,
        code: "CONFIRMATION_REQUIRED",
        errors: [`${name} requires confirmation=YES`],
      }),
    };
  }
  const spec = MCP_MUTATIONS[name];
  if (!spec) return {};
  const repo = resolve(ctx.repo);
  const workItemId = spec.workItem === "epic"
    ? str(args.epic)
    : spec.workItem === "wp"
      ? (str(args.workPackage) ?? str(args.wp) ?? str(args.workPackageId))
      : undefined;
  try {
    const inspection = inspectMutation({
      repo,
      planId: ctx.planId,
      planFingerprint: ctx.planFingerprint,
      operation: spec.operation,
      provider: spec.provider,
      instanceId: spec.provider === "local" ? undefined : ctx.instanceId,
      workItemId,
      repository: repo,
      previewFingerprint: ctx.previewFingerprint,
      action: name,
    });
    if (inspection.kind === "replay") {
      const result = inspection.result && typeof inspection.result === "object"
        ? { ...(inspection.result as object), replayed: true }
        : { replayed: true, result: inspection.result };
      return { envelope: mcpEnvelope({ ok: true, operation: name, version, data: result }) };
    }
    if (inspection.kind === "ready") beginConsumption(repo, inspection.planId, inspection.key, name);
    ctx.approvalConsumed = true;
    return {
      finish: (data) => completeConsumption(repo, inspection.planId, inspection.key, name, data),
      abort: () => {
        try {
          abortConsumption(repo, inspection.planId, inspection.key, name);
        } catch {
          /* keep the tool error */
        }
      },
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "APPROVAL_REQUIRED";
    return {
      envelope: mcpEnvelope({
        ok: false,
        operation: name,
        version,
        code,
        errors: [error instanceof Error ? error.message : String(error)],
      }),
    };
  }
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
  const bound = ctx as OpContext & {
    planId?: string;
    planFingerprint?: string;
    instanceId?: string;
    approvalConsumed?: boolean;
  };
  bound.planId = str(args.planId);
  bound.planFingerprint = str(args.planFingerprint);
  bound.instanceId = str(args.instanceId) ?? process.env.PRAXIS_JIRA_BASE_URL;
  ops.loadPraxisDotenv(ctx.repo);
  if (name === "praxis_ba_apply" || name === "praxis_architect_apply") {
    ctx.requirePreviewFingerprint = true;
  }
  if (name === "praxis_quality_apply" || name === "praxis_developer_git_commit" || name === "praxis_developer_git_publish" || name === "praxis_developer_git_connect_apply" || name === "praxis_developer_git_merge_request") {
    ctx.requirePreviewFingerprint = true;
  }
  const gate = openMcpGate(name, args, bound, opts.version);
  if (gate.envelope) return gate.envelope;
  try {
    if (name === "praxis_approval_confirm") {
      const planId = str(args.planId);
      if (!planId) {
        return mcpEnvelope({
          ok: false,
          operation: name,
          version: opts.version,
          code: "INVALID_INPUT",
          errors: ["praxis_approval_confirm requires planId"],
        });
      }
      const record = readApproval(ctx.repo, planId);
      return mcpEnvelope({
        ok: true,
        operation: name,
        version: opts.version,
        data: {
          approved: false,
          state: record.plan.state,
          summary: approvalSummary(record.plan),
        },
      });
    }
    if (
      name === "praxis_workflow_status" ||
      name === "praxis_workflow_preview" ||
      name === "praxis_workflow_apply" ||
      name === "praxis_capabilities"
    ) {
      return mcpEnvelope({
        ok: true,
        operation: name,
        version: opts.version,
        data: await runWorkflowTool(name, args, ctx.repo),
      });
    }
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
      if (gate.abort) gate.abort();
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
    if (gate.finish) gate.finish(data);
    return mcpEnvelope({ ok: true, operation: name, version: opts.version, data });
  } catch (err) {
    if (gate.abort) gate.abort();
    const message = ops.redact(err instanceof Error ? err.message : String(err));
    const coded = err as { code?: unknown };
    const code =
      err instanceof ops.PraxisOpError
        ? err.code
        : typeof coded.code === "string" && /^(APPROVAL_|WORK_ITEM_|WORKFLOW_(LOCKED|INDEX|CONFLICT))/.test(coded.code)
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

async function runWorkflowTool(name: string, args: Record<string, unknown>, repo: string): Promise<unknown> {
  const workItemId = str(args.workItemId);
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
    const committed = commitServiceFix(repo, planned, workItemId);
    return applyResolved(repo, str(args.previewFingerprint) ?? "", planned, committed, workItemId);
  }
  if (name === "praxis_workflow_preview") return previewWorkflow(repo, parsed, workItemId);
  return applyWorkflow(repo, parsed, str(args.previewFingerprint) ?? "", workItemId);
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
