import { diagnosticsPath } from "./diagnostics-log.js";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { OpContext } from "@praxis/cli/operations";
import {
  ApprovalError,
  ApprovalNeedsInput,
  obtainUserApproval,
  approvalsGivenInThisCall,
  logDecision,
  subjectDigest,
  withApprovalChannel,
  WorkflowError,
  commandCatalog,
  explainCommandError,
  type UserApprovalChannel,
  type WorkflowRole,
  parseWorkflowCommand,
} from "@praxis/contracts";
import { runtimeBuildInfo, toolOrigin } from "./build-info.js";
import { containedPath } from "./path-guard.js";
import { PERSONAL_ACTS, hostPermissionChannel, hostPermissionMode, planOnlyChannel, planTextOf, trustedClientChannelWith, trustedClientMode } from "./approval-channel.js";
import { mcpEnvelope, type McpEnvelope } from "./envelope.js";
import { TOOLS as CATALOG_TOOLS, toolsForRole, type PraxisRole } from "./catalog.js";
import { buildStoryVerification, commitServiceFix, planServiceFix } from "./story-engine.js";
import { developerWorkItemStatus, inspectWorkflow } from "./workflow-inspect.js";
import { sessionStart } from "./session-start.js";
import { applyCanonInit, planCanonInit } from "./canon-init.js";
import { diagnoseContextTool } from "./context-tool.js";
import { discoverFrontend } from "./frontend-discover.js";
import { inspectRepository, repositoryBrief } from "./repository-tools.js";
import { applyHandedOver, readSubmissionFile, renderReviewTool } from "./review-service.js";
import { applyResolved, applyWorkflow, applyWorkflowApproved, capabilityRoute, loadWorkflow, previewWorkflow, workflowStatus } from "./workflow-store.js";

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
  "praxis_canon_init_apply",
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
/** An argument the tool does not declare, named with its accepted neighbours; null when every argument is declared. */
function strayArguments(name: string, def: { inputSchema: { properties: Record<string, unknown> } }, args: Record<string, unknown>): string | null {
  const accepted = Object.keys(def.inputSchema.properties);
  const stray = Object.keys(args).filter((key) => !accepted.includes(key) && args[key] !== undefined);
  if (stray.length === 0) return null;
  const suggest = (key: string) => accepted.find((a) => a.toLowerCase() === key.toLowerCase()) ?? accepted.find((a) => key.length > 3 && (a.toLowerCase().startsWith(key.toLowerCase().slice(0, 4)) || key.toLowerCase().startsWith(a.toLowerCase().slice(0, 4))));
  return `${name} does not take ${stray.map((key) => `"${key}"${suggest(key) ? ` (did you mean "${suggest(key)}"?)` : ""}`).join(", ")}. Accepted arguments: ${accepted.join(", ")}. Nothing was changed.`;
}

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
    // an act only a person may perform has no plan text to hand to the host's prompt: that prompt cannot stand for the person
    ...(hostPermissionMode() && PERSONAL_ACTS.has(request.action) ? { planText: null, available: false, reason: "this act needs a client with an approval dialog; host-permission mode does not cover it" } : { planText: planTextOf(request as never) }),
    ...(request.subject ? { subjectDigest: subjectDigest(request.subject) } : {}),
    note: "This is what the user is asked to approve. It runs nothing.",
  });
  // the arguments the plan is for are held to the target tool's own list: a misspelt workItemId must not plan the current item
  const targetDef = CATALOG_TOOLS.find((t) => t.name === target);
  const strayTarget = targetDef ? strayArguments(target, targetDef, targetArgs) : null;
  if (strayTarget) throw new Error(`INVALID_INPUT: ${strayTarget}`);
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
    target.approval = {
      ...target.approval,
      client,
      diagnosticsLog: diagnosticsPath(),
      ...(!client.dialog
        ? {
            hostGate:
              "Some hosts (Claude Desktop) hold an apply call at their own tool-permission prompt BEFORE it reaches Praxis. If you see no result and no prompt, look for that prompt in the host window; diagnosticsLog lists the calls that did reach Praxis (tool_enter). Praxis itself answers a protected call without a dialog immediately with APPROVAL_CLIENT_UI_REQUIRED.",
          }
        : {}),
    };
    if (trustedClientMode()) {
      target.approval = {
        ...target.approval,
        mode: "trusted-client",
        note: "TRUSTED CLIENT (you enabled it in the extension settings): protected actions run on the agent's confirmation=YES for a current preview, with no separate confirmation of each action. That is your standing permission for this client, not proof you confirmed each action; results and the journal say trusted-client. Previews, stale-plan checks and the journal still apply.",
      };
    } else if (hostPermissionMode() && !client.dialog) {
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
  // Trusted Client (explicit opt-in) replaces any dialog for protected tools: the owner chose not to be asked per action.
  const channel = trustedClientMode() && PROTECTED_TOOLS.has(name) ? trustedClientChannelWith(opts.approvalChannel) : opts.approvalChannel ?? (hostPermissionMode() && PROTECTED_TOOLS.has(name) ? hostPermissionChannel(str(args.planText)) : undefined);
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
  // An argument the tool does not declare is refused, never dropped: a misspelt workItemId must not run the action on the current work item.
  const strayMessage = strayArguments(name, def, args);
  if (strayMessage) {
    return mcpEnvelope({ ok: false, operation: name, version: opts.version, code: "INVALID_INPUT", errors: [strayMessage] });
  }
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
    if (name === "praxis_canon_init_preview" || name === "praxis_canon_init_apply" || name === "praxis_workflow_commands" || name === "praxis_review_render" || name === "praxis_review_apply" || name === "praxis_frontend_discover" || name === "praxis_repository_inspect" || name === "praxis_repository_brief" || name === "praxis_context_diagnose") {
      return mcpEnvelope({ ok: true, operation: name, version: opts.version, data: await runPlanningTool(name, args, ctx.repo, opts.role) });
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
    const message = ops.redact(explainCommandError(err) ?? (err instanceof Error ? err.message : String(err)));
    const coded = err as { code?: unknown };
    const prefixed = explainCommandError(err) ? "INVALID_INPUT" : message.match(/^(INVALID_INPUT|WORKFLOW_MISSING|INSPECT_PATH_INVALID|REVIEW_MISMATCH|REVIEW_CHANGED):/)?.[1];
    const code =
      err instanceof WorkflowError
        ? err.code
        : typeof prefixed === "string" && prefixed
          ? prefixed
          : err instanceof ops.PraxisOpError
        ? err.code
        : typeof coded.code === "string" && /^(APPROVAL_|WORK_ITEM_|INSPECT_|SESSION_|IDENTITY_|WORKFLOW_(LOCKED|INDEX|CONFLICT))/.test(coded.code)
          ? coded.code
          : message.startsWith("FINGERPRINT_MISMATCH")
            ? "FINGERPRINT_MISMATCH"
            : name.startsWith("praxis_workflow")
              ? "INVALID_INPUT"
              : "EXTERNAL_SERVICE_ERROR";
    const details =
      err instanceof WorkflowError
        ? { ...(err.details ?? {}) }
        : err instanceof ops.PraxisOpError
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

const MAX_IMPLEMENTATION_BYTES = 2 * 1024 * 1024;

function hydrateWorkflowCommand(repo: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const command = { ...(raw as Record<string, unknown>) };
  const relative = command.implementationPath;
  if (typeof relative !== "string" || relative.length === 0) return command;
  let real: string;
  try {
    real = containedPath(repo, relative);
    const info = statSync(real);
    if (!info.isFile()) throw new Error("UNSAFE_PATH");
    if (info.size > MAX_IMPLEMENTATION_BYTES) throw new Error("INVALID_INPUT: the implementation file is too large to read");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INVALID_INPUT")) throw error;
    throw new Error("INVALID_INPUT: implementation path escapes the repository or is not a regular file inside it");
  }
  command.implementationSource = readFileSync(real, "utf8");
  delete command.implementationPath;
  return command;
}

async function runPlanningTool(name: string, args: Record<string, unknown>, repo: string, role: PraxisRole): Promise<unknown> {
  const workItemId = str(args.workItemId);
  switch (name) {
    case "praxis_canon_init_preview": {
      const plan = planCanonInit(repo, { product: str(args.product) });
      return { dryRun: true, repo: plan.repo, willCreate: plan.create.map((c) => c.path), alreadyThere: plan.skipped, next: plan.next, note: "Nothing was written. praxis_canon_init_apply creates these paths after the user approves them." };
    }
    case "praxis_canon_init_apply": {
      const plan = planCanonInit(repo, { product: str(args.product) });
      if (plan.create.length === 0) return { created: [], alreadyThere: plan.skipped, note: "The canon root is already complete: nothing to create." };
      await obtainUserApproval(
        {
          action: "praxis_canon_init_apply",
          kind: "development_action",
          summary: `Create the BA canon root in ${plan.repo} (${plan.create.length} path(s))`,
          description: `Creates, and never overwrites:\n${plan.create.map((c) => `- ${c.path}`).join("\n")}\n\nLeft untouched (already there): ${plan.skipped.join(", ") || "nothing"}.`,
          subject: JSON.stringify(plan.create.map((c) => [c.path, c.content ?? ""])),
        },
        { confirmation: str(args.confirmation), repo },
      );
      const created = applyCanonInit(plan);
      return { created, alreadyThere: plan.skipped, next: plan.next };
    }
    case "praxis_workflow_commands": {
      const only = str(args.action);
      const all = commandCatalog();
      return { count: all.length, commands: only ? all.filter((c) => c.action === only) : all.map(({ example: _e, ...c }) => c), note: "Pass the command to praxis_workflow_preview and praxis_workflow_apply as JSON text. Ask for one action to get an example. userOnly commands record the user's decisions and are refused when an agent sends them; use praxis_review_render / praxis_review_apply." };
    }
    case "praxis_review_render":
      return renderReviewTool(repo, { view: str(args.view) ?? "", workItemId, serve: args.serve === false ? false : true, reopen: args.reopen === true });
    case "praxis_review_apply": {
      const text = str(args.submission);
      const file = str(args.file);
      if ((text === undefined) === (file === undefined)) throw new Error("INVALID_INPUT: pass exactly one of submission or file");
      let raw: unknown;
      try {
        raw = text !== undefined ? JSON.parse(text) : readSubmissionFile(repo, file as string);
      } catch (error) {
        throw new Error(`INVALID_INPUT: the decisions could not be read: ${error instanceof SyntaxError ? "not valid JSON" : error instanceof Error && /^INVALID_INPUT/.test(error.message) ? error.message.replace(/^INVALID_INPUT: /, "") : "the file could not be opened"}`);
      }
      return applyHandedOver(repo, workItemId, raw, str(args.confirmation));
    }
    case "praxis_frontend_discover": {
      const registered = str(args.repositoryId);
      let target = str(args.path) ?? repo;
      if (registered) {
        const state = loadWorkflow(repo, workItemId);
        const entry = state?.repositories.find((r) => r.id === registered);
        if (!entry?.localPath) throw new Error(`INVALID_INPUT: repository ${registered} is not registered with a local path`);
        target = resolve(repo, entry.localPath);
      }
      return discoverFrontend(target);
    }
    case "praxis_repository_inspect":
      return inspectRepository(repo, { repositoryId: str(args.repositoryId) ?? "", workItemId });
    case "praxis_repository_brief":
      return repositoryBrief(repo, { repositoryId: str(args.repositoryId), workItemId });
    default:
      return diagnoseContextTool(repo, { workItemId, role: (["ba", "architect", "developer", "quality"] as const).find((r) => r === str(args.role)) ?? (role === "runtime" ? undefined : role) });
  }
}

/**
 * In a guided work item an implementation record must point at something real: a file that exists inside the service's
 * checkout (its path, its registered repository's path, or this repository). Records for work that does not exist are what
 * made "entered" and "implemented" fakeable.
 */
function assertImplementationPath(repo: string, command: Record<string, unknown>, workItemId: string | undefined): void {
  const state = loadWorkflow(repo, workItemId);
  if (!state || state.mode !== "guided") return;
  const service = state.services.find((s) => s.id === command.serviceId);
  if (!service) return; // the reducer reports the unknown service
  const registered = state.repositories.find((r) => r.id === service.repositoryId);
  const root = realpathSync(resolve(repo, service.localPath ?? registered?.localPath ?? "."));
  let target: string;
  try {
    target = realpathSync(resolve(root, String(command.path ?? "")));
    if (!statSync(target).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`INVALID_INPUT: implementation path ${String(command.path)} is not an existing file in ${service.id}'s checkout (${root}); record real work only`);
  }
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`INVALID_INPUT: implementation path ${String(command.path)} is outside ${service.id}'s checkout`);
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
  if (parsed.action === "record-implementation") assertImplementationPath(repo, parsed, workItemId);
  if (parsed.action === "record-repository-inspection") {
    throw new Error("INVALID_INPUT: a repository inspection is read by the Runtime, not written by an agent: call praxis_repository_inspect");
  }
  if (parsed.action === "verify-stories" || parsed.action === "prepare-fix") {
    // these two are built by the Runtime from its own plan, but what the agent sent is still held to the schema: a misspelt key is an error
    parseWorkflowCommand(JSON.parse(str(args.command) ?? ""));
  }
  if (parsed.action === "verify-stories") {
    const recorded = await buildStoryVerification(repo, parsed.independentRerun === true, workItemId);
    const { meta, ...command } = recorded;
    if (name === "praxis_workflow_preview") {
      const preview = previewWorkflow(repo, command, workItemId);
      return { ...preview, result: { ...(preview.result as object), ...meta } };
    }
    const applied = applyWorkflow(repo, command, str(args.previewFingerprint) ?? "", workItemId);
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
    // the patch travels with the Runtime's own plan; the workflow command is only the change record
    const asCommand = ({ proposal: _proposal, ...command }: typeof planned) => command;
    if (name === "praxis_workflow_preview") return previewWorkflow(repo, asCommand(planned), workItemId);
    const committed = await commitServiceFix(repo, planned, workItemId, str(args.confirmation));
    return applyResolved(repo, str(args.previewFingerprint) ?? "", asCommand(planned), asCommand(committed), workItemId);
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
