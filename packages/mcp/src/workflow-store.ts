import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyWorkflowCommand,
  commandFingerprint,
  redactPersistent,
  resumeWorkflow,
  routeCapabilities,
  WorkflowCommandSchema,
  WorkflowStateSchema,
  type Capability,
  type WorkflowRole,
  type WorkflowState,
} from "@praxis/contracts";

export const PRAXIS_CAPABILITIES: Capability[] = [
  {
    id: "cap.ba.clarify",
    plugin: "praxis-ba",
    description: "Clarify business requirements and acceptance criteria without inventing policy.",
    intents: ["requirement", "acceptance", "business", "clarify", "stakeholder"],
    stages: ["draft", "clarification_required", "ready", "in_progress", "changes_requested"],
    roles: ["ba", "architect", "developer", "quality", "user"],
    inputs: ["request", "approved artifacts"],
    outputs: ["questions", "assumptions"],
    dependencies: [],
    sideEffect: "read",
    activation: "guidance",
    version: "1.0.0",
    installed: true,
  },
  {
    id: "cap.architect.security",
    plugin: "praxis-architect",
    description: "Security, authentication, and service-boundary guidance.",
    intents: ["security", "authentication", "authorization", "architecture"],
    stages: ["ready", "in_progress", "review_required", "changes_requested"],
    roles: ["architect", "developer", "quality", "ba"],
    inputs: ["requirements"],
    outputs: ["guidance"],
    dependencies: ["cap.ba.clarify"],
    sideEffect: "read",
    activation: "guidance",
    version: "1.0.0",
    installed: true,
  },
  {
    id: "cap.quality.consistency",
    plugin: "praxis-quality",
    description: "Retry, idempotency, and consistency checks. Guidance only until an explicit Quality command.",
    intents: ["idempotency", "retry", "consistency", "concurrency", "quality"],
    stages: ["in_progress", "review_required", "changes_requested"],
    roles: ["developer", "quality", "architect"],
    inputs: ["requirements", "implementation evidence"],
    outputs: ["guidance"],
    dependencies: [],
    sideEffect: "read",
    activation: "guidance",
    version: "1.0.0",
    installed: true,
  },
  {
    id: "cap.jira.mutate",
    plugin: "praxis-runtime",
    description: "Create or update Jira issues. Never runs from contextual guidance.",
    intents: ["jira", "epic"],
    stages: ["ready", "in_progress"],
    roles: ["ba", "architect", "developer", "quality"],
    inputs: ["preview fingerprint", "confirmation"],
    outputs: ["jira issue"],
    dependencies: [],
    sideEffect: "external_mutate",
    activation: "explicit",
    version: "1.0.0",
    installed: true,
  },
];

function statePath(repo: string): string {
  return join(repo, ".praxis", "workflow", "state.json");
}

export function loadWorkflow(repo: string): WorkflowState | null {
  let raw: string;
  try {
    raw = readFileSync(statePath(repo), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return WorkflowStateSchema.parse(JSON.parse(raw));
}

export function workflowStatus(repo: string): {
  present: boolean;
  workflowId?: string;
  workItemId?: string;
  stage?: string;
  requirementIds?: string[];
  nextRole?: string;
  jiraIssueKey?: string | null;
  guidance?: Array<{ id: string; description: string }>;
  suggested?: string[];
  executed?: [];
} {
  const state = loadWorkflow(repo);
  if (!state) return { present: false };
  const resume = resumeWorkflow(state);
  const role = (resume.nextRole ?? "ba") as WorkflowRole;
  const routed = capabilityRoute({
    request: [state.workItem.title, ...state.requirements.map((item) => item.statement)].join(" "),
    role,
    stage: state.stage,
  });
  return {
    present: true,
    workflowId: state.workflowId,
    workItemId: state.workItem.id,
    stage: state.stage,
    requirementIds: resume.requirementIds,
    nextRole: resume.nextRole,
    jiraIssueKey: state.workItem.jiraIssueKey ?? null,
    guidance: routed.guidance.map((item) => ({ id: item.id, description: item.description })),
    suggested: routed.suggested.map((item) => item.id),
    executed: routed.executed,
  };
}

export function saveWorkflow(repo: string, state: WorkflowState): string {
  const path = statePath(repo);
  mkdirSync(join(repo, ".praxis", "workflow"), { recursive: true });
  const body = `${JSON.stringify(redactPersistent(state), null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return path;
}

export function previewWorkflow(repo: string, raw: unknown): {
  fingerprint: string;
  duplicate: boolean;
  result: unknown;
  resume: ReturnType<typeof resumeWorkflow> | null;
} {
  const command = WorkflowCommandSchema.parse(raw);
  const current = loadWorkflow(repo);
  const applied = applyWorkflowCommand(current, command);
  return {
    fingerprint: commandFingerprint(command),
    duplicate: applied.duplicate,
    result: applied.result,
    resume: applied.state ? resumeWorkflow(applied.state) : null,
  };
}

export function applyResolved(
  repo: string,
  fingerprint: string,
  planned: unknown,
  final: unknown,
): {
  path: string;
  duplicate: boolean;
  result: unknown;
  workflowId: string;
  workItemId: string;
} {
  const command = WorkflowCommandSchema.parse(planned);
  const expected = commandFingerprint(command);
  if (fingerprint !== expected) {
    throw new Error(`FINGERPRINT_MISMATCH: expected ${expected}`);
  }
  const applied = applyWorkflowCommand(loadWorkflow(repo), final);
  const path = saveWorkflow(repo, applied.state);
  return {
    path,
    duplicate: applied.duplicate,
    result: applied.result,
    workflowId: applied.state.workflowId,
    workItemId: applied.state.workItem.id,
  };
}

export function applyWorkflow(repo: string, raw: unknown, fingerprint: string): {
  path: string;
  duplicate: boolean;
  result: unknown;
  workflowId: string;
  workItemId: string;
} {
  const command = WorkflowCommandSchema.parse(raw);
  const expected = commandFingerprint(command);
  if (fingerprint !== expected) {
    throw new Error(`FINGERPRINT_MISMATCH: expected ${expected}`);
  }
  const current = loadWorkflow(repo);
  const applied = applyWorkflowCommand(current, command);
  const path = saveWorkflow(repo, applied.state);
  return {
    path,
    duplicate: applied.duplicate,
    result: applied.result,
    workflowId: applied.state.workflowId,
    workItemId: applied.state.workItem.id,
  };
}

export function capabilityRoute(input: {
  request: string;
  role: WorkflowRole;
  stage?: WorkflowState["stage"];
}): ReturnType<typeof routeCapabilities> {
  return routeCapabilities({
    request: input.request,
    role: input.role,
    stage: input.stage ?? "in_progress",
    capabilities: PRAXIS_CAPABILITIES,
  });
}
