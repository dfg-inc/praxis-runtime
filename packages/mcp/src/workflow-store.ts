import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  applyWorkflowCommand,
  commandFingerprint,
  inspectMutation,
  redactPersistent,
  requireMutationLease,
  resumeWorkflow,
  routeCapabilities,
  runAuthorizedMutation,
  WorkflowCommandSchema,
  WorkflowStateSchema,
  workItemIdFor,
  type Capability,
  type WorkflowCommand,
  type WorkItemLink,
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

// ---------------------------------------------------------------------------
// Work item storage
//
//   .praxis/workflow/index.json          which work items exist, and which is current
//   .praxis/workflow/items/<id>.json     one unchanged WorkflowState per work item
//   .praxis/workflow/state.json          legacy single-item file; after migration a tombstone
//
// Every write holds the repository workflow lock and replaces files atomically.
// ---------------------------------------------------------------------------

const INDEX_CONTRACT = "praxis.workflow.index";
const MIGRATED_CONTRACT = "praxis.workflow.migrated";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const WORK_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type WorkItemSummary = {
  workItemId: string;
  workflowId: string;
  projectId: string;
  title: string;
  jiraIssueKey?: string;
  stage: string;
  revision: number;
  updatedAt: string;
  links: WorkItemLink[];
};

type WorkflowIndex = {
  contract: typeof INDEX_CONTRACT;
  version: 1;
  current: string | null;
  /**
   * Changes whenever the item set or the current item changes. open and select-work-item fold it
   * into their fingerprint so a repeat of the same command (select A, select B, select A) is a new
   * operation, not a replay of the first one, and a stale preview is rejected.
   */
  epoch?: number;
  items: WorkItemSummary[];
};

type Layout = { index: WorkflowIndex; legacy: boolean };

export class WorkItemError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkItemError";
    this.code = code;
  }
}

function workflowDir(repo: string): string {
  return join(repo, ".praxis", "workflow");
}
const legacyPath = (repo: string) => join(workflowDir(repo), "state.json");
const indexPath = (repo: string) => join(workflowDir(repo), "index.json");

function assertWorkItemId(id: string): string {
  if (!WORK_ITEM_ID_RE.test(id) || id.includes("..")) {
    throw new WorkItemError("WORK_ITEM_INVALID", "work item ids use letters, digits, '.', '_' and '-' only");
  }
  return id;
}

function itemPath(repo: string, id: string): string {
  return join(workflowDir(repo), "items", `${assertWorkItemId(id)}.json`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarize(state: WorkflowState): WorkItemSummary {
  return {
    workItemId: state.workItem.id,
    workflowId: state.workflowId,
    projectId: state.projectId,
    title: state.workItem.title,
    ...(state.workItem.jiraIssueKey ? { jiraIssueKey: state.workItem.jiraIssueKey } : {}),
    stage: state.stage,
    revision: state.workItem.revision,
    updatedAt: new Date().toISOString(),
    links: state.workItem.links ?? [],
  };
}

function readLegacy(repo: string): WorkflowState | null {
  let raw: unknown;
  try {
    raw = readJson(legacyPath(repo));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if ((raw as { contract?: string })?.contract === MIGRATED_CONTRACT) return null;
  return WorkflowStateSchema.parse(raw);
}

function readLayout(repo: string): Layout | null {
  let raw: unknown;
  try {
    raw = readJson(indexPath(repo));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const legacy = readLegacy(repo);
    if (!legacy) {
      if (existsSync(legacyPath(repo))) {
        throw new WorkItemError("WORKFLOW_INDEX_MISSING", "state.json is migrated but index.json is missing");
      }
      return null;
    }
    return {
      legacy: true,
      index: { contract: INDEX_CONTRACT, version: 1, current: legacy.workItem.id, items: [summarize(legacy)] },
    };
  }
  const index = raw as WorkflowIndex;
  if (index?.contract !== INDEX_CONTRACT || index.version !== 1 || !Array.isArray(index.items)) {
    throw new WorkItemError("WORKFLOW_INDEX_INVALID", "index.json is not a praxis.workflow.index v1 file");
  }
  return { index, legacy: false };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * An approval authorizes a command against the state it was previewed against. The fingerprint
 * therefore carries a digest of that state (or the index epoch for open/select-work-item):
 * - the same command on unchanged state is a true replay of the completed write;
 * - the same command after the state moved on (select A, B, A; re-record an implementation after a
 *   revision) is a new operation that needs its own approval and really runs;
 * - a preview made against state that has since changed is rejected as stale.
 */
function fingerprintFor(repo: string, command: WorkflowCommand, workItemId?: string): string {
  let token: string;
  if (command.action === "open" || command.action === "select-work-item") {
    token = `epoch:${readLayout(repo)?.index.epoch ?? 0}`;
  } else {
    const state = loadWorkflow(repo, workItemId);
    token = state ? `state:${createHash("sha256").update(canonicalJson(state)).digest("hex")}` : "state:none";
  }
  return commandFingerprint({ ...command, previewedAgainst: token } as unknown as WorkflowCommand);
}

function resolveId(layout: Layout, explicit?: string): string | null {
  if (explicit !== undefined) {
    assertWorkItemId(explicit);
    if (!layout.index.items.some((item) => item.workItemId === explicit)) {
      throw new WorkItemError("WORK_ITEM_NOT_FOUND", `no work item ${explicit} in this repository`);
    }
    return explicit;
  }
  return layout.index.current;
}

function readItem(repo: string, layout: Layout, id: string): WorkflowState {
  if (layout.legacy) return readLegacy(repo) as WorkflowState;
  return WorkflowStateSchema.parse(readJson(itemPath(repo, id)));
}

export function loadWorkflow(repo: string, workItemId?: string): WorkflowState | null {
  const layout = readLayout(repo);
  if (!layout) {
    if (workItemId !== undefined) {
      throw new WorkItemError("WORK_ITEM_NOT_FOUND", `no work item ${workItemId} in this repository`);
    }
    return null;
  }
  const id = resolveId(layout, workItemId);
  return id ? readItem(repo, layout, id) : null;
}

export function listWorkItems(repo: string): { current: string | null; items: WorkItemSummary[] } {
  const layout = readLayout(repo);
  return layout ? { current: layout.index.current, items: layout.index.items } : { current: null, items: [] };
}

export function workflowStatus(repo: string, workItemId?: string): {
  present: boolean;
  workflowId?: string;
  workItemId?: string;
  currentWorkItemId?: string | null;
  workItems?: Array<WorkItemSummary & { current: boolean }>;
  stage?: string;
  requirementIds?: string[];
  nextRole?: string;
  jiraIssueKey?: string | null;
  links?: WorkItemLink[];
  guidance?: Array<{ id: string; description: string }>;
  suggested?: string[];
  executed?: [];
} {
  const state = loadWorkflow(repo, workItemId);
  if (!state) return { present: false };
  const { current, items } = listWorkItems(repo);
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
    currentWorkItemId: current,
    workItems: items.map((item) => ({ ...item, current: item.workItemId === current })),
    stage: state.stage,
    requirementIds: resume.requirementIds,
    nextRole: resume.nextRole,
    jiraIssueKey: state.workItem.jiraIssueKey ?? null,
    links: state.workItem.links ?? [],
    guidance: routed.guidance.map((item) => ({ id: item.id, description: item.description })),
    suggested: routed.suggested.map((item) => item.id),
    executed: routed.executed,
  };
}

// --- locking and atomic writes ----------------------------------------------

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(dir: string): boolean {
  if (!existsSync(dir)) return false; // released meanwhile: just retry mkdir
  try {
    const owner = readJson(join(dir, "owner")) as { pid?: number; at?: number };
    if (typeof owner.at === "number" && Date.now() - owner.at > LOCK_STALE_MS) return true;
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    return false;
  } catch {
    // An owner file that is missing or unreadable only counts as stale once the directory is old.
    try {
      return Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

/** Serializes read-modify-write cycles across processes. Stale locks (dead pid or old) are reclaimed. */
export function withWorkflowLock<T>(repo: string, fn: () => T): T {
  mkdirSync(workflowDir(repo), { recursive: true });
  const dir = join(workflowDir(repo), ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockIsStale(dir)) {
        // Claim the stale lock atomically; if someone else already did, rename fails and we retry.
        const claimed = `${dir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(dir, claimed);
          rmSync(claimed, { recursive: true, force: true });
        } catch {
          /* lost the race to another reclaimer or the owner released */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new WorkItemError("WORKFLOW_LOCKED", "another process is writing this repository's workflow");
      }
      pause(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function writeIndex(repo: string, index: WorkflowIndex): void {
  requireMutationLease();
  writeAtomic(indexPath(repo), index);
}

function writeItem(repo: string, state: WorkflowState): string {
  requireMutationLease();
  const path = itemPath(repo, state.workItem.id);
  writeAtomic(path, redactPersistent(state));
  return path;
}

/**
 * Moves a legacy single-item repository to the index layout. state.json becomes a tombstone so an
 * older runtime fails to parse it instead of silently opening a second, diverging workflow.
 */
function ensureMigrated(repo: string): Layout | null {
  const layout = readLayout(repo);
  if (!layout || !layout.legacy) return layout;
  requireMutationLease();
  const legacy = readLegacy(repo) as WorkflowState;
  writeItem(repo, legacy);
  writeIndex(repo, layout.index);
  writeAtomic(legacyPath(repo), {
    contract: MIGRATED_CONTRACT,
    migratedAt: new Date().toISOString(),
    index: "index.json",
    note: "Workflow state moved to .praxis/workflow/items/. Use a Praxis Runtime that supports multiple work items.",
  });
  return { index: layout.index, legacy: false };
}

export function saveWorkflow(repo: string, state: WorkflowState): string {
  requireMutationLease();
  return withWorkflowLock(repo, () => {
    const layout = ensureMigrated(repo) ?? {
      legacy: false,
      index: { contract: INDEX_CONTRACT, version: 1 as const, current: null, items: [] },
    };
    const path = writeItem(repo, state);
    const entry = summarize(state);
    const items = layout.index.items.some((item) => item.workItemId === entry.workItemId)
      ? layout.index.items.map((item) => (item.workItemId === entry.workItemId ? entry : item))
      : [...layout.index.items, entry];
    const isNew = !layout.index.items.some((item) => item.workItemId === entry.workItemId);
    writeIndex(repo, {
      ...layout.index,
      current: layout.index.current ?? entry.workItemId,
      items,
      ...(isNew ? { epoch: (layout.index.epoch ?? 0) + 1 } : {}),
    });
    return path;
  });
}

// --- resolving a command against the work item index ------------------------

type Resolved = {
  /** Command to hand to the contract. `open` gains the sequence the store issued. */
  command: WorkflowCommand;
  state: WorkflowState | null;
  /** open of an identity that already exists selects it instead of creating it. */
  reopen?: WorkflowState;
  select?: string;
};

function resolveCommand(repo: string, command: WorkflowCommand, workItemId?: string): Resolved {
  const layout = readLayout(repo);
  if (command.action === "select-work-item") {
    if (!layout) throw new WorkItemError("WORK_ITEM_NOT_FOUND", `no work item ${command.workItemId} in this repository`);
    const id = resolveId(layout, command.workItemId) as string;
    return { command, state: readItem(repo, layout, id), select: id };
  }
  if (command.action === "open") {
    const items = layout?.index.items ?? [];
    const same = items.find(
      (item) =>
        item.projectId === command.projectId &&
        item.title === command.title &&
        (item.jiraIssueKey ?? null) === (command.jiraIssueKey ?? null),
    );
    if (same && layout) return { command, state: null, reopen: readItem(repo, layout, same.workItemId) };
    let sequence = 1;
    while (items.some((item) => item.workItemId === workItemIdFor(command.title, sequence))) sequence += 1;
    return { command: { ...command, sequence }, state: null };
  }
  return { command, state: loadWorkflow(repo, workItemId) };
}

export function previewWorkflow(repo: string, raw: unknown, workItemId?: string): {
  fingerprint: string;
  duplicate: boolean;
  result: unknown;
  resume: ReturnType<typeof resumeWorkflow> | null;
  currentWorkItemId?: string | null;
} {
  const command = WorkflowCommandSchema.parse(raw);
  const resolved = resolveCommand(repo, command, workItemId);
  const fingerprint = fingerprintFor(repo, command, workItemId);
  const current = listWorkItems(repo).current;
  if (resolved.select) {
    return {
      fingerprint,
      duplicate: resolved.select === current,
      result: { workItemId: resolved.select, previousCurrent: current },
      resume: resolved.state ? resumeWorkflow(resolved.state) : null,
      currentWorkItemId: resolved.select,
    };
  }
  if (resolved.reopen) {
    return {
      fingerprint,
      duplicate: true,
      result: { workflowId: resolved.reopen.workflowId, workItemId: resolved.reopen.workItem.id, previousCurrent: current },
      resume: resumeWorkflow(resolved.reopen),
      currentWorkItemId: resolved.reopen.workItem.id,
    };
  }
  const applied = applyWorkflowCommand(resolved.state, resolved.command);
  return {
    fingerprint,
    duplicate: applied.duplicate,
    result: applied.result,
    resume: applied.state ? resumeWorkflow(applied.state) : null,
    currentWorkItemId: command.action === "open" ? applied.state.workItem.id : (workItemId ?? current),
  };
}

function localWriteRequest(repo: string, fingerprint: string) {
  const root = resolve(repo);
  return {
    repo: root,
    operation: "repository_edit" as const,
    provider: "local" as const,
    repository: root,
    previewFingerprint: fingerprint,
    action: "praxis_workflow_apply",
  };
}

export type WorkflowApplyResult = {
  path: string;
  duplicate: boolean;
  result: unknown;
  workflowId: string;
  workItemId: string;
  currentWorkItemId?: string | null;
  replayed?: boolean;
};

/** One locked read-modify-write of a single work item (or the index, for select/reopen). */
function writeCommand(repo: string, planned: WorkflowCommand, final: unknown, workItemId?: string): WorkflowApplyResult {
  return withWorkflowLock(repo, () => {
    ensureMigrated(repo);
    const finalCommand = WorkflowCommandSchema.parse(final);
    const resolved = resolveCommand(repo, finalCommand, workItemId);
    const layout = readLayout(repo);
    const previousCurrent = layout?.index.current ?? null;
    const select = (id: string) => {
      const index = (readLayout(repo) as Layout).index;
      if (index.current !== id) writeIndex(repo, { ...index, current: id, epoch: (index.epoch ?? 0) + 1 });
    };
    if (resolved.select) {
      select(resolved.select);
      const state = resolved.state as WorkflowState;
      return {
        path: itemPath(repo, state.workItem.id),
        duplicate: resolved.select === previousCurrent,
        result: { workItemId: resolved.select, previousCurrent },
        workflowId: state.workflowId,
        workItemId: state.workItem.id,
        currentWorkItemId: resolved.select,
      };
    }
    if (resolved.reopen) {
      select(resolved.reopen.workItem.id);
      return {
        path: itemPath(repo, resolved.reopen.workItem.id),
        duplicate: true,
        result: { workflowId: resolved.reopen.workflowId, workItemId: resolved.reopen.workItem.id, previousCurrent },
        workflowId: resolved.reopen.workflowId,
        workItemId: resolved.reopen.workItem.id,
        currentWorkItemId: resolved.reopen.workItem.id,
      };
    }
    const applied = applyWorkflowCommand(resolved.state, resolved.command);
    const path = writeItem(repo, applied.state);
    const index = readLayout(repo)?.index ?? { contract: INDEX_CONTRACT, version: 1 as const, current: null, items: [] };
    const entry = summarize(applied.state);
    const exists = index.items.some((item) => item.workItemId === entry.workItemId);
    const items = exists
      ? index.items.map((item) => (item.workItemId === entry.workItemId ? entry : item))
      : [...index.items, entry];
    const current = planned.action === "open" ? entry.workItemId : (index.current ?? entry.workItemId);
    const selectionChanged = !exists || current !== index.current;
    writeIndex(repo, { ...index, current, items, ...(selectionChanged ? { epoch: (index.epoch ?? 0) + 1 } : {}) });
    return {
      path,
      duplicate: applied.duplicate,
      result:
        planned.action === "open" && previousCurrent && previousCurrent !== entry.workItemId
          ? { ...(applied.result as object), previousCurrent }
          : applied.result,
      workflowId: applied.state.workflowId,
      workItemId: applied.state.workItem.id,
      currentWorkItemId: current,
    };
  });
}

function guarded(repo: string, fingerprint: string, planned: unknown, final: unknown, workItemId?: string): WorkflowApplyResult {
  const command = WorkflowCommandSchema.parse(planned);
  const expected = fingerprintFor(repo, command, workItemId);
  if (fingerprint !== expected) {
    throw new Error(`FINGERPRINT_MISMATCH: expected ${expected}`);
  }
  const request = localWriteRequest(repo, fingerprint);
  const inspection = inspectMutation(request);
  if (inspection.kind === "replay") {
    return { ...(inspection.result as WorkflowApplyResult), replayed: true };
  }
  return runAuthorizedMutation(request, () => writeCommand(repo, command, final, workItemId));
}

export function applyResolved(
  repo: string,
  fingerprint: string,
  planned: unknown,
  final: unknown,
  workItemId?: string,
): WorkflowApplyResult {
  return guarded(repo, fingerprint, planned, final, workItemId);
}

export function applyWorkflow(repo: string, raw: unknown, fingerprint: string, workItemId?: string): WorkflowApplyResult {
  return guarded(repo, fingerprint, raw, raw, workItemId);
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
