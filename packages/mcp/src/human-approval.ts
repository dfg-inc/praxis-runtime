import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildActionPlan,
  HUMAN_GRANT_KIND,
  humanGrantRequest,
  type HumanGrantRequest,
  type WorkflowCommand,
  type WorkflowState,
} from "@praxis/contracts";

/**
 * How a human act gets asked for. The Runtime never approves anything. For a confirmation or an approval it
 * builds the exact plan from its own state, puts it in the broker's inbox, and the owner decides in the
 * broker's operator page with an authenticator. The signed token that comes back is the only thing that makes
 * the command succeed, and the contract verifies it against the plan's content again.
 */

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAN_LIFETIME_MS = 24 * 3_600_000;

/**
 * Agent-authored workflow records (requirements, handoffs, verdicts, implementation records) are the agent's
 * own work product and are written without an approval. `approval` restores the strict policy: every record
 * write needs an approved mutation, which in secure mode needs a broker. Confirmations and approvals always
 * need a human grant regardless of this setting.
 */
export function recordPolicy(): "unsigned" | "approval" {
  return process.env.PRAXIS_WORKFLOW_RECORDS?.trim() === "approval" ? "approval" : "unsigned";
}

export const sharedDir = (): string | undefined => {
  const dir = process.env.PRAXIS_BROKER_SHARED_DIR?.trim();
  return dir ? resolve(dir) : undefined;
};

export const operatorUrl = (): string => process.env.PRAXIS_OPERATOR_URL?.trim() || "http://localhost:8780";

export type GrantStatus = "approved" | "awaiting-operator" | "rejected" | "broker-not-configured";

export class HumanApprovalRequired extends Error {
  readonly code = "APPROVAL_REQUIRED";
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(`APPROVAL_REQUIRED: ${message}`);
    this.name = "HumanApprovalRequired";
    this.details = details;
  }
}

function pathFor(kind: "pending" | "approved" | "rejected" | "authorizations", planId: string, ext = "json"): string | undefined {
  const dir = sharedDir();
  if (!dir || !PLAN_ID.test(planId)) return undefined;
  return join(dir, kind, `${planId}.${ext}`);
}

export function readGrantToken(planId: string): string | undefined {
  const path = pathFor("authorizations", planId, "token");
  if (!path || !existsSync(path)) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return token || undefined;
}

export function grantStatus(planId: string): GrantStatus {
  if (!sharedDir()) return "broker-not-configured";
  if (readGrantToken(planId)) return "approved";
  const rejected = pathFor("rejected", planId);
  if (rejected && existsSync(rejected)) return "rejected";
  return "awaiting-operator";
}

export function buildGrantPlan(repo: string, state: WorkflowState, request: HumanGrantRequest, now = new Date()) {
  return buildActionPlan({
    planId: request.planId,
    role: request.role,
    decisionKind: HUMAN_GRANT_KIND[request.action],
    summary: request.summary,
    provider: "local",
    instanceId: "local",
    operations: ["repository_edit"],
    workItemIds: [state.workItem.id],
    storyIds: request.action === "confirm-story" ? [request.targetId] : [],
    decisionIds: request.action === "confirm-decision" ? [request.targetId] : [],
    repositories: [resolve(repo)],
    actions: [
      {
        action: request.action,
        description: request.description,
        targets: [request.targetId],
        content: request.content,
      },
    ],
    risks: request.risks,
    sideEffects: [`Records the outcome in .praxis/workflow/items/${state.workItem.id}.json of ${resolve(repo)}.`],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_LIFETIME_MS).toISOString(),
  });
}

/** What preview shows for a human act: no writes. */
export function humanApprovalView(repo: string, state: WorkflowState | null, command: WorkflowCommand) {
  if (!state) return null;
  const request = humanGrantRequest(state, command);
  if (!request) return null;
  const plan = buildGrantPlan(repo, state, request);
  const status = grantStatus(request.planId);
  return {
    required: true,
    kind: HUMAN_GRANT_KIND[request.action],
    action: request.action,
    summary: request.summary,
    planId: request.planId,
    status,
    operatorUrl: status === "broker-not-configured" ? undefined : `${operatorUrl()}/plan/${encodeURIComponent(request.planId)}`,
    contentFingerprint: plan.fingerprint,
    explanation:
      status === "approved"
        ? "The owner has approved exactly this. Apply will record it."
        : status === "rejected"
          ? "The owner rejected this plan. A changed subject proposes a new plan."
          : status === "broker-not-configured"
            ? "No approval broker is configured (PRAXIS_BROKER_SHARED_DIR), so this cannot be confirmed from here. Apply will be refused."
            : "Apply will put this plan in the owner's approval inbox. The owner approves it with an authenticator; then apply again.",
  };
}

/**
 * The token for this human act, or a refusal that says exactly what to do next. Proposing the plan is the one
 * side effect: it puts the exact plan in the broker's inbox and nothing else.
 */
export function requireGrantToken(repo: string, state: WorkflowState, command: WorkflowCommand): string | undefined {
  const request = humanGrantRequest(state, command);
  if (!request) return undefined;
  const planId = request.planId;
  const token = readGrantToken(planId);
  if (token) return token;
  if (!sharedDir()) {
    throw new HumanApprovalRequired(
      `${request.summary} needs the owner's approval, and no approval broker is configured for this Runtime (PRAXIS_BROKER_SHARED_DIR). Nothing was recorded.`,
      { planId, status: "broker-not-configured" },
    );
  }
  const rejected = pathFor("rejected", planId);
  if (rejected && existsSync(rejected)) {
    throw new HumanApprovalRequired(`the owner rejected ${request.summary}. Nothing was recorded; change the subject to propose a new plan.`, { planId, status: "rejected" });
  }
  const pending = pathFor("pending", planId) as string;
  if (!existsSync(pending)) {
    const plan = buildGrantPlan(repo, state, request);
    mkdirSync(join(sharedDir() as string, "pending"), { recursive: true });
    const tmp = `${pending}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(tmp, pending);
  }
  const url = `${operatorUrl()}/plan/${encodeURIComponent(planId)}`;
  throw new HumanApprovalRequired(
    `${request.summary} is waiting for the owner. Plan ${planId} is in the approval inbox; the owner reviews it and approves with an authenticator at ${url}. Then apply this same command again. Nothing was recorded.`,
    { planId, status: "awaiting-operator", operatorUrl: url },
  );
}
