import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installHostApproval, openLocalWorkflow, applyWorkflowCommand } from "@praxis/contracts";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";

async function call(tool: string, repo: string, role: string, args: Record<string, unknown>): Promise<McpEnvelope> {
  return (await callTool(tool, { repo, ...args }, { role, version: VERSION })) as McpEnvelope;
}

async function step(repo: string, role: string, command: object, workItemId?: string): Promise<McpEnvelope> {
  const extra = workItemId ? { workItemId } : {};
  const previewed = await call("praxis_workflow_preview", repo, role, { command: JSON.stringify(command), ...extra });
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  installHostApproval(repo, {
    planId: `wf-${fingerprint.slice(-12)}-${Math.random().toString(36).slice(2, 7)}`,
    role: role as "ba",
    provider: "local",
    workItemIds: ["local-workflow"],
    repositories: [resolve(repo)],
    operations: ["repository_edit"],
    inScope: ["praxis_workflow_apply"],
    outOfScope: [],
    assumptions: [],
    risks: ["writes the local workflow file"],
    previewFingerprint: fingerprint,
  });
  const applied = await call("praxis_workflow_apply", repo, role, {
    command: JSON.stringify(command),
    confirmation: "YES",
    previewFingerprint: fingerprint,
    ...extra,
  });
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

const open = (title: string) => ({ action: "open", projectId: "vcp", title, request: title });
const service = (localPath: string) => ({
  action: "set-service",
  service: {
    id: "svc",
    name: "svc",
    kind: "module",
    localPath,
    responsibilities: ["x"],
    requirementIds: [],
    dependsOn: [],
    status: "in_progress",
  },
});

function dirs() {
  // parent/{workflow,sibling}: the workflow repository and a sibling checkout, like the real workspace.
  const parent = mkdtempSync(join(tmpdir(), "praxis-vcp-"));
  const repo = join(parent, "workflow");
  const sibling = join(parent, "sibling");
  mkdirSync(repo, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  return { parent, repo, sibling };
}

describe("portable persisted state", () => {
  it("regression: service paths are persisted relative so no machine path is committed", async () => {
    // Original defect: services[].localPath was written as an absolute /Users/... path.
    const { repo, sibling } = dirs();
    mkdirSync(join(repo, "inside"));
    await step(repo, "ba", open("Portable"));
    await step(repo, "architect", service(sibling));
    const persisted = readPersistedState<{ services: Array<{ localPath: string }> }>(repo);
    expect(persisted.services[0]?.localPath).toBe("../sibling");
    await step(repo, "architect", { ...service(join(repo, "inside")), service: { ...service("x").service, id: "svc2", localPath: join(repo, "inside") } });
    const both = readPersistedState<{ services: Array<{ id: string; localPath: string }> }>(repo);
    expect(both.services.find((s) => s.id === "svc2")?.localPath).toBe("inside");
    const raw = readFileSync(join(repo, ".praxis", "workflow", "items", `${(readPersistedState<{ workItem: { id: string } }>(repo)).workItem.id}.json`), "utf8");
    expect(raw).not.toContain(repo);
    expect(raw).not.toContain(sibling);
  });

  it("is resolved back to an absolute path for every consumer", async () => {
    const { repo, sibling } = dirs();
    await step(repo, "ba", open("Resolved"));
    await step(repo, "architect", service(sibling));
    const { loadWorkflow } = await import("./workflow-store.js");
    expect(loadWorkflow(repo)?.services[0]?.localPath).toBe(sibling);
  });

  it("keeps a far-away absolute path absolute and reads legacy absolute paths unchanged", async () => {
    const { repo } = dirs();
    await step(repo, "ba", open("Far"));
    await step(repo, "architect", service("/opt/praxis/far/away/checkout"));
    expect(readPersistedState<{ services: Array<{ localPath: string }> }>(repo).services[0]?.localPath).toBe("/opt/praxis/far/away/checkout");

    // Legacy single-file state with an absolute sibling path is read unchanged and made relative on write.
    const legacy = dirs();
    let state = openLocalWorkflow({ projectId: "vcp", title: "Legacy abs", request: "r" });
    state = applyWorkflowCommand(state, service(legacy.sibling) as never).state;
    mkdirSync(join(legacy.repo, ".praxis", "workflow"), { recursive: true });
    writeFileSync(join(legacy.repo, ".praxis", "workflow", "state.json"), JSON.stringify(state));
    const { loadWorkflow } = await import("./workflow-store.js");
    expect(loadWorkflow(legacy.repo)?.services[0]?.localPath).toBe(legacy.sibling);
    await step(legacy.repo, "ba", { action: "record-context", notes: "write triggers migration" });
    expect(readPersistedState<{ services: Array<{ localPath: string }> }>(legacy.repo).services[0]?.localPath).toBe("../sibling");
  });
});

describe("index.json is a rebuildable cache", () => {
  it("rebuilds from items/ after a fresh clone and makes a single item current", async () => {
    const { repo } = dirs();
    const id = (await step(repo, "ba", open("Only one"))).data.workItemId as string;
    rmSync(join(repo, ".praxis", "workflow", "index.json"));
    rmSync(join(repo, ".praxis", "workflow", "state.json"), { force: true });
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.currentWorkItemId).toBe(id);
    expect(status.data.workItems).toHaveLength(1);
    await step(repo, "ba", { action: "record-context", notes: "after rebuild" });
    expect(existsSync(join(repo, ".praxis", "workflow", "index.json"))).toBe(true);
  });

  it("never guesses between several items: selection is required, listing the ids", async () => {
    const { repo } = dirs();
    const a = (await step(repo, "ba", open("Item A"))).data.workItemId as string;
    const b = (await step(repo, "ba", open("Item B"))).data.workItemId as string;
    rmSync(join(repo, ".praxis", "workflow", "index.json"));
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ selectionRequired: true, currentWorkItemId: null });
    expect(status.data.workItems.map((i: { workItemId: string }) => i.workItemId).sort()).toEqual([a, b].sort());
    const blocked = await call("praxis_workflow_preview", repo, "ba", {
      command: JSON.stringify({ action: "add-requirement", id: "REQ-VCP-901", statement: "x", acceptanceCriteria: ["y"] }),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("WORK_ITEM_SELECTION_REQUIRED");
    expect(blocked.errors?.join(" ")).toContain(a);
    // An explicit id works, and so does selecting.
    const explicit = await call("praxis_workflow_status", repo, "ba", { workItemId: b });
    expect(explicit.data.workItemId).toBe(b);
    await step(repo, "ba", { action: "select-work-item", workItemId: a });
    expect((await call("praxis_workflow_status", repo, "ba", {})).data.currentWorkItemId).toBe(a);
  });

  it("refuses a repository that has both a legacy state.json and items/: one authoritative copy only", async () => {
    const { repo } = dirs();
    await step(repo, "ba", open("Conflict"));
    rmSync(join(repo, ".praxis", "workflow", "index.json"));
    const state = openLocalWorkflow({ projectId: "vcp", title: "Other", request: "r" });
    writeFileSync(join(repo, ".praxis", "workflow", "state.json"), JSON.stringify(state));
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.ok).toBe(false);
    expect(status.code).toBe("WORKFLOW_CONFLICT");
  });

  it("migration and rebuild leave exactly one authoritative copy of each item", async () => {
    const { repo } = dirs();
    const id = (await step(repo, "ba", open("One copy"))).data.workItemId as string;
    rmSync(join(repo, ".praxis", "workflow", "index.json"));
    await call("praxis_workflow_status", repo, "ba", {});
    await step(repo, "ba", { action: "record-context", notes: "write" });
    const files = readdirSync(join(repo, ".praxis", "workflow"), { recursive: true }).map(String).sort();
    expect(files.filter((f) => f.startsWith("items/") && f.endsWith(".json"))).toEqual([`items/${id}.json`]);
    expect(files.filter((f) => /state/.test(f))).toEqual([]);
  });
});
