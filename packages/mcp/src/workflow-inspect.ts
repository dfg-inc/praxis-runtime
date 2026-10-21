import { basename, resolve } from "node:path";
import {
  decisionContentFingerprint,
  evaluateFeature,
  featureReadiness,
  redactPersistent,
  requirementEvidence,
  resumeWorkflow,
  storyContentFingerprint,
  type WorkflowState,
} from "@praxis/contracts";
import { listWorkItems, loadWorkflow, WorkItemError } from "./workflow-store.js";

/**
 * Read-only inspection of the stored workflow. One tool, one view per question, so a Chat session can show
 * requirements, Stories, decisions, work, handoffs, open items and Quality evidence without opening files.
 *
 * Rules this module keeps:
 *  - It only reads. Nothing here creates, repairs or migrates workflow state.
 *  - It is scoped to one repository and one Work Item. Links to other repositories are reported, not followed.
 *  - Responses are built from the persisted state, not from a parallel store, so what is shown is what is stored.
 *  - Machine paths are shown repository-relative; secret-shaped keys and values are redacted.
 */

export const INSPECT_SCHEMA = "praxis.workflow.inspect.v1";
export const INSPECT_VIEWS = [
  "overview",
  "requirements",
  "stories",
  "decisions",
  "work",
  "handoffs",
  "open-items",
  "quality",
  "links",
  "all",
] as const;
export type InspectView = (typeof INSPECT_VIEWS)[number];

const SECRET_VALUE = /\b(?:bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+)/gi;

function scrub<T>(repo: string, value: T): T {
  const root = resolve(repo);
  const clean = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input
        .split(`${root}/`)
        .join("")
        .split(root)
        .join(".")
        .replace(SECRET_VALUE, "[redacted]");
    }
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, clean(v)]));
    }
    return input;
  };
  return clean(redactPersistent(value)) as T;
}

function storyConfirmation(story: WorkflowState["stories"][number]): "confirmed" | "unconfirmed" | "superseded" {
  if (story.status === "superseded") return "superseded";
  return story.status === "confirmed" && story.confirmedBehavior ? "confirmed" : "unconfirmed";
}

function overview(state: WorkflowState, repo: string) {
  const { current, items } = listWorkItems(repo);
  const resume = resumeWorkflow(state);
  const live = state.stories.filter((story) => story.status !== "superseded");
  const feature = evaluateFeature(state);
  return {
    workItem: {
      id: state.workItem.id,
      title: state.workItem.title,
      projectId: state.workItem.projectId,
      workflowId: state.workflowId,
      source: state.workItem.source,
      provider: state.workItem.provider ?? "local",
      jiraIssueKey: state.workItem.jiraIssueKey ?? null,
      externalNumber: state.workItem.externalNumber ?? null,
      stage: state.stage,
      revision: state.workItem.revision,
    },
    nextRole: resume.nextRole,
    counts: {
      requirements: state.requirements.filter((item) => item.status !== "superseded").length,
      stories: {
        total: live.length,
        confirmed: live.filter((story) => storyConfirmation(story) === "confirmed").length,
        unconfirmed: live.filter((story) => storyConfirmation(story) === "unconfirmed").length,
        stale: live.filter((story) => story.stale).length,
      },
      decisions: { total: state.decisions.length, confirmed: state.decisions.filter((item) => item.confirmed).length },
      services: state.services.length,
      implementationUnits: state.implementationUnits.length,
      handoffs: state.handoffs.length,
      risks: state.risks.length,
      blockers: state.blockers.length,
      openQuestions: state.openQuestions.length,
      findings: {
        open: state.findings.filter((item) => item.status === "open").length,
        resolved: state.findings.filter((item) => item.status === "resolved").length,
      },
      verdicts: state.verdicts.length,
      coverageEntries: state.coverage.length,
    },
    feature: { verdict: feature.verdict, gaps: feature.gaps, readiness: featureReadiness(state) },
    history: state.history,
    workItems: items.map((item) => ({
      workItemId: item.workItemId,
      title: item.title,
      stage: item.stage,
      revision: item.revision,
      jiraIssueKey: item.jiraIssueKey ?? null,
      current: item.workItemId === current,
    })),
  };
}

function requirements(state: WorkflowState) {
  return state.requirements.map((req) => {
    const evidence = requirementEvidence(state, req.id);
    return {
      id: req.id,
      statement: req.statement,
      revision: req.revision,
      status: req.status,
      acceptanceCriteria: req.acceptanceCriteria.map((c) => ({ id: c.id, statement: c.statement, revision: c.revision })),
      serviceIds: req.serviceIds,
      assumptions: state.assumptions.filter((a) => req.assumptionIds.includes(a.id) || a.requirementIds.includes(req.id)),
      storyIds: state.stories.filter((s) => s.requirementIds.includes(req.id)).map((s) => s.id),
      evidence:
        evidence.status === "missing"
          ? { status: "missing" as const, reasons: evidence.reasons }
          : { status: "executed" as const, verdict: evidence.verdict, reasons: evidence.reasons, provenance: evidence.provenance },
    };
  });
}

function stories(state: WorkflowState) {
  return state.stories.map((story) => ({
    ...story,
    /** What confirm-story must carry: the digest of exactly this revision. The user is shown this content before approving. */
    contentFingerprint: storyContentFingerprint(story),
    confirmation: storyConfirmation(story),
    coverage: state.coverage
      .filter((entry) => entry.storyId === story.id)
      .map((entry) => ({
        scenarioId: entry.scenarioId,
        storyRevision: entry.storyRevision ?? null,
        kind: entry.kind,
        status: entry.status,
        critical: entry.critical,
        serviceId: entry.serviceId,
        evidence: entry.evidence,
      })),
  }));
}

function decisions(state: WorkflowState) {
  return {
    decisions: state.decisions.map((decision) => ({ ...decision, contentFingerprint: decisionContentFingerprint(decision) })),
    assumptions: state.assumptions,
    openQuestions: state.openQuestions,
    unresolvedByStory: state.stories
      .filter((story) => story.status !== "superseded" && story.unresolvedDecisionIds.length > 0)
      .map((story) => ({ storyId: story.id, decisionIds: story.unresolvedDecisionIds })),
  };
}

async function workPackages(repo: string) {
  try {
    const ops = await import("@praxis/cli/operations");
    const listed = await ops.workPackageListOp({ repo });
    return {
      available: true as const,
      items: listed.workPackages.map((wp) => ({
        id: wp.id,
        jiraIssueKey: wp.jiraIssueKey ?? null,
        hasChangeSpec: Boolean(wp.changeSpecPath),
      })),
    };
  } catch (err) {
    return { available: false as const, items: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

async function work(state: WorkflowState, repo: string) {
  return {
    services: state.services,
    implementationUnits: state.implementationUnits,
    changes: state.changes,
    readiness: featureReadiness(state),
    workPackages: await workPackages(repo),
  };
}

function handoffs(state: WorkflowState) {
  return {
    chain: state.handoffs.map((h) => `${h.sourceRole}→${h.targetRole}`),
    items: state.handoffs,
  };
}

function openItems(state: WorkflowState) {
  const latest = state.handoffs[state.handoffs.length - 1];
  // Context lives in two places in the stored state: the work item's own lists and each handoff, which
  // carries forward whatever was not resolved. What is open now is both, once.
  const union = (own: string[], carried: string[] = []) => [...new Set([...own, ...carried])];
  return {
    risks: union(state.risks, latest?.risks),
    blockers: union(state.blockers, latest?.blockers),
    openQuestions: union(state.openQuestions, latest?.openQuestions),
    notes: latest?.notes ?? state.notes ?? null,
    resolved: state.handoffs.flatMap((h) => h.resolved.map((text) => ({ handoffId: h.handoffId, text }))),
    openFindings: state.findings.filter((item) => item.status === "open"),
    latestHandoff: latest
      ? {
          handoffId: latest.handoffId,
          route: `${latest.sourceRole}→${latest.targetRole}`,
          risks: latest.risks,
          blockers: latest.blockers,
          openQuestions: latest.openQuestions,
          notes: latest.notes ?? null,
          decisionRecords: latest.decisionRecords,
        }
      : null,
  };
}

function quality(state: WorkflowState) {
  const feature = evaluateFeature(state);
  return {
    featureVerdict: { verdict: feature.verdict, gaps: feature.gaps },
    verdicts: state.verdicts,
    findings: state.findings,
    coverage: state.coverage,
    requirementEvidence: state.requirements
      .filter((req) => req.status !== "superseded")
      .map((req) => ({ requirementId: req.id, ...requirementEvidence(state, req.id) })),
  };
}

function isLocalRepository(repo: string, name: string): boolean {
  return name === "." || name === basename(resolve(repo)) || resolve(name) === resolve(repo);
}

function links(state: WorkflowState, repo: string) {
  const { items } = listWorkItems(repo);
  const outgoing = (state.workItem.links ?? []).map((link) => {
    const local = isLocalRepository(repo, link.repository);
    const target = local ? items.find((item) => item.workItemId === link.workItemId) : undefined;
    return {
      repository: link.repository,
      workItemId: link.workItemId,
      relation: link.relation,
      scope: local ? ("this-repository" as const) : ("other-repository" as const),
      resolved: target !== undefined,
      target: target ? { title: target.title, stage: target.stage, revision: target.revision } : null,
      note: local ? (target ? null : "no such Work Item in this repository") : "other repository: not read by a repository-scoped call",
    };
  });
  const incoming = items
    .filter((item) => item.workItemId !== state.workItem.id)
    .flatMap((item) =>
      item.links
        .filter((link) => link.workItemId === state.workItem.id && isLocalRepository(repo, link.repository))
        .map((link) => ({ fromWorkItemId: item.workItemId, title: item.title, relation: link.relation })),
    );
  return { outgoing, incoming };
}

const filterById = <T extends { id: string }>(rows: T[], id?: string): T[] => (id ? rows.filter((row) => row.id === id) : rows);

export async function inspectWorkflow(
  repo: string,
  args: { view?: string; workItemId?: string; id?: string },
): Promise<Record<string, unknown>> {
  const view = (args.view ?? "overview") as InspectView;
  if (!(INSPECT_VIEWS as readonly string[]).includes(view)) {
    throw new WorkItemError("INSPECT_VIEW_INVALID", `view must be one of: ${INSPECT_VIEWS.join(", ")}`);
  }
  const state = loadWorkflow(repo, args.workItemId);
  if (!state) {
    if (view === "overview") return { schema: INSPECT_SCHEMA, view, present: false, workItems: [] };
    throw new WorkItemError("INSPECT_NOT_FOUND", "this repository has no Praxis workflow to inspect");
  }
  const id = args.id;
  const section = async (name: Exclude<InspectView, "all">): Promise<unknown> => {
    switch (name) {
      case "overview":
        return overview(state, repo);
      case "requirements":
        return filterById(requirements(state), id);
      case "stories":
        return filterById(stories(state), id);
      case "decisions": {
        const all = decisions(state);
        return id ? { ...all, decisions: filterById(all.decisions, id) } : all;
      }
      case "work": {
        const all = await work(state, repo);
        return id ? { ...all, services: filterById(all.services, id) } : all;
      }
      case "handoffs": {
        const all = handoffs(state);
        return id ? { ...all, items: all.items.filter((h) => h.handoffId === id) } : all;
      }
      case "open-items":
        return openItems(state);
      case "quality":
        return quality(state);
      case "links":
        return links(state, repo);
    }
  };
  const body: Record<string, unknown> = {};
  if (view === "all") {
    for (const name of INSPECT_VIEWS.filter((v) => v !== "all")) body[name] = await section(name);
  } else {
    const value = await section(view);
    if (id && Array.isArray(value) && value.length === 0) {
      throw new WorkItemError("INSPECT_NOT_FOUND", `no ${view} record ${id} in work item ${state.workItem.id}`);
    }
    if (id && view === "handoffs" && (value as { items: unknown[] }).items.length === 0) {
      throw new WorkItemError("INSPECT_NOT_FOUND", `no handoff ${id} in work item ${state.workItem.id}`);
    }
    body[view] = value;
  }
  return scrub(repo, {
    schema: INSPECT_SCHEMA,
    view,
    present: true,
    workItemId: state.workItem.id,
    readOnly: true,
    ...body,
  });
}

/** Developer status for a local Work Item: stage, services and implementation, with no Jira identity invented. */
export function developerWorkItemStatus(repo: string, workItemId: string): Record<string, unknown> {
  const state = loadWorkflow(repo, workItemId);
  if (!state) throw new WorkItemError("WORK_ITEM_NOT_FOUND", `no work item ${workItemId} in this repository`);
  const resume = resumeWorkflow(state);
  const toDeveloper = [...state.handoffs].reverse().find((h) => h.targetRole === "developer");
  return scrub(repo, {
    schema: "praxis.developer.status.v1",
    readOnly: true,
    identity: { kind: "work-item-id", input: workItemId },
    workItemId: state.workItem.id,
    jiraIssueKey: state.workItem.jiraIssueKey ?? null,
    title: state.workItem.title,
    stage: state.stage,
    revision: state.workItem.revision,
    nextRole: resume.nextRole,
    requirementIds: resume.requirementIds,
    services: state.services.map((s) => ({ id: s.id, name: s.name, status: s.status, requirementIds: s.requirementIds, dependsOn: s.dependsOn })),
    implementationUnits: state.implementationUnits.map((u) => ({
      id: u.id,
      serviceId: u.serviceId,
      requirementIds: u.requirementIds,
      path: u.path,
      stale: u.stale,
    })),
    openFindings: state.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, summary: f.summary, owner: f.owner, severity: f.severity ?? null })),
    latestHandoffToDeveloper: toDeveloper
      ? { handoffId: toDeveloper.handoffId, from: toDeveloper.sourceRole, readiness: toDeveloper.readiness, nextActions: toDeveloper.nextActions }
      : null,
  });
}
