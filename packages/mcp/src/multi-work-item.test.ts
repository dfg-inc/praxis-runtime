import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installHostApproval, openLocalWorkflow, WorkflowStateSchema } from "@praxis/contracts";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";
const here = dirname(fileURLToPath(import.meta.url));

function repoDir(): string {
  return mkdtempSync(join(tmpdir(), "praxis-mwi-"));
}

async function call(tool: string, repo: string, role: string, args: Record<string, unknown>): Promise<McpEnvelope> {
  return (await callTool(tool, { repo, ...args }, { role, version: VERSION })) as McpEnvelope;
}

/** Real MCP preview then apply with a scoped host approval bound to the preview fingerprint. */
async function step(repo: string, role: string, command: object, workItemId?: string): Promise<McpEnvelope> {
  const extra = workItemId ? { workItemId } : {};
  const previewed = await call("praxis_workflow_preview", repo, role, { command: JSON.stringify(command), ...extra });
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  installHostApproval(repo, {
    planId: `wf-${fingerprint.slice(-12)}-${Math.random().toString(36).slice(2, 8)}`,
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

const open = (title: string, extra: Record<string, unknown> = {}) => ({
  action: "open",
  projectId: "mwi",
  title,
  request: `Work on ${title}`,
  ...extra,
});

const requirement = (id: string, statement: string) => ({
  action: "add-requirement",
  id,
  statement,
  acceptanceCriteria: [`${id} holds`],
});

describe("several work items in one repository (through MCP tools)", () => {
  it("regression: a second work item is created, not resumed as duplicate:true", async () => {
    const repo = repoDir();
    const first = await step(repo, "ba", open("Alpha feature"));
    const second = await step(repo, "ba", open("Beta feature"));
    // Original defect: the second open returned the first item's workflowId with duplicate:true.
    expect(second.data.duplicate).toBe(false);
    expect(second.data.workItemId).not.toBe(first.data.workItemId);
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.workItems.map((item: { workItemId: string }) => item.workItemId)).toEqual([
      first.data.workItemId,
      second.data.workItemId,
    ]);
    expect(status.data.currentWorkItemId).toBe(second.data.workItemId);
  });

  it("issues the next sequence id for a colliding title and reopens an existing identity", async () => {
    const repo = repoDir();
    const a1 = await step(repo, "ba", open("Same title"));
    const a2 = await step(repo, "ba", open("Same title", { jiraIssueKey: "PRX-7" }));
    expect(a1.data.workItemId).toBe("WI-SAME-TITLE-001");
    expect(a2.data.workItemId).toBe("WI-SAME-TITLE-002");
    const reopened = await step(repo, "ba", open("Same title"));
    expect(reopened.data.duplicate).toBe(true);
    expect(reopened.data.workItemId).toBe("WI-SAME-TITLE-001");
    expect(reopened.data.currentWorkItemId).toBe("WI-SAME-TITLE-001");
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.workItems).toHaveLength(2);
  });

  it("keeps histories, handoffs and requirements of different items apart", async () => {
    const repo = repoDir();
    const a = (await step(repo, "ba", open("Item A"))).data.workItemId as string;
    const b = (await step(repo, "ba", open("Item B"))).data.workItemId as string;
    // B is current. Write to A explicitly; B must not change.
    const bBefore = JSON.stringify(readPersistedState(repo, b));
    await step(repo, "ba", requirement("REQ-MWI-901", "A only."), a);
    await step(
      repo,
      "ba",
      { action: "handoff", sourceRole: "ba", targetRole: "architect", requirementIds: ["REQ-MWI-901"], readiness: "ready", risks: ["A-RISK"] },
      a,
    );
    expect(JSON.stringify(readPersistedState(repo, b))).toBe(bBefore);
    // A command without workItemId goes to the current item (B).
    await step(repo, "ba", requirement("REQ-MWI-902", "B only."));
    const stateA = readPersistedState<{ requirements: Array<{ id: string }>; handoffs: unknown[] }>(repo, a);
    const stateB = readPersistedState<{ requirements: Array<{ id: string }>; handoffs: unknown[] }>(repo, b);
    expect(stateA.requirements.map((r) => r.id)).toEqual(["REQ-MWI-901"]);
    expect(stateA.handoffs).toHaveLength(1);
    expect(stateB.requirements.map((r) => r.id)).toEqual(["REQ-MWI-902"]);
    expect(stateB.handoffs).toHaveLength(0);
    const statusA = await call("praxis_workflow_status", repo, "ba", { workItemId: a });
    expect(statusA.data.requirementIds).toEqual(["REQ-MWI-901"]);
  });

  it("never falls back to the current item for an unknown or unsafe id", async () => {
    const repo = repoDir();
    await step(repo, "ba", open("Only item"));
    const command = JSON.stringify(requirement("REQ-MWI-903", "x"));
    const unknown = await call("praxis_workflow_preview", repo, "ba", { command, workItemId: "WI-NOPE-001" });
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("WORK_ITEM_NOT_FOUND");
    const unsafe = await call("praxis_workflow_preview", repo, "ba", { command, workItemId: "../../etc/passwd" });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.code).toBe("WORK_ITEM_INVALID");
    const status = await call("praxis_workflow_status", repo, "ba", { workItemId: "WI-NOPE-001" });
    expect(status.ok).toBe(false);
    expect(status.code).toBe("WORK_ITEM_NOT_FOUND");
  });

  it("selects the current item with an explicit approved command", async () => {
    const repo = repoDir();
    const a = (await step(repo, "ba", open("Select A"))).data.workItemId as string;
    const b = (await step(repo, "ba", open("Select B"))).data.workItemId as string;
    const selected = await step(repo, "ba", { action: "select-work-item", workItemId: a });
    expect(selected.data.result).toEqual({ workItemId: a, previousCurrent: b });
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.currentWorkItemId).toBe(a);
    expect(status.data.workItems.find((item: { current: boolean }) => item.current).workItemId).toBe(a);
    const missing = await call("praxis_workflow_preview", repo, "ba", {
      command: JSON.stringify({ action: "select-work-item", workItemId: "WI-NOPE-001" }),
    });
    expect(missing.code).toBe("WORK_ITEM_NOT_FOUND");
    // Toggling back and forth repeats identical commands; each must really run, never replay.
    await step(repo, "ba", { action: "select-work-item", workItemId: b });
    const back = await step(repo, "ba", { action: "select-work-item", workItemId: a });
    expect(back.data.replayed).toBeUndefined();
    expect(back.data.result).toEqual({ workItemId: a, previousCurrent: b });
    expect((await call("praxis_workflow_status", repo, "ba", {})).data.currentWorkItemId).toBe(a);
  });

  it("records references to work items in other repositories", async () => {
    const repo = repoDir();
    const a = (await step(repo, "ba", open("Linker"))).data.workItemId as string;
    const target = { repository: "praxis-core", workItemId: "WI-OTHER-001", relation: "depends-on" };
    await step(repo, "architect", { action: "link-work-item", target }, a);
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.links).toEqual([target]);
    expect(status.data.workItems[0].links).toEqual([target]);
    // The identical command again, with the same approval, is a replay of the completed write.
    const fingerprint = (
      await call("praxis_workflow_preview", repo, "architect", {
        command: JSON.stringify({ action: "link-work-item", target }),
        workItemId: a,
      })
    ).data.fingerprint as string;
    const again = await call("praxis_workflow_apply", repo, "architect", {
      command: JSON.stringify({ action: "link-work-item", target }),
      confirmation: "YES",
      previewFingerprint: fingerprint,
      workItemId: a,
    });
    expect(again.ok, JSON.stringify(again.errors)).toBe(true);
    expect(again.data.replayed).toBe(true);
    expect(((await call("praxis_workflow_status", repo, "ba", {})).data.links as unknown[]).length).toBe(1);
  });

  it("scopes Quality checks per work item", async () => {
    const repo = repoDir();
    const service = join(repo, "svc");
    mkdirSync(service, { recursive: true });
    writeFileSync(join(service, "mod.mjs"), "export const answer = () => 42;\n");
    const check = (expectValue: number) => ({
      checks: [
        {
          scenarioId: "S1",
          storyId: "US-MWI-001",
          requirementId: "REQ-MWI-910",
          acceptanceCriterionId: "US-MWI-001-AC-01",
          kind: "happy",
          serviceId: "svc",
          module: "mod.mjs",
          call: { function: "answer", args: [] },
          expect: expectValue,
        },
      ],
    });
    // Repository-wide check would pass (42); the scoped check for the item expects 7 and must fail.
    mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
    writeFileSync(join(repo, ".praxis", "quality", "checks.json"), JSON.stringify(check(42)));
    const id = (await step(repo, "ba", open("Scoped checks"))).data.workItemId as string;
    mkdirSync(join(repo, ".praxis", "quality", id), { recursive: true });
    writeFileSync(join(repo, ".praxis", "quality", id, "checks.json"), JSON.stringify(check(7)));
    await step(repo, "ba", requirement("REQ-MWI-910", "Answer is 42."));
    await step(repo, "ba", {
      action: "add-story",
      id: "US-MWI-001",
      requirementIds: ["REQ-MWI-910"],
      actor: "operator",
      narrative: "As a operator, I want the answer, so that checks are scoped.",
      objective: "Answer",
      userValue: "Scoped",
      happyPath: ["call"],
      acceptanceCriteria: [{ id: "US-MWI-001-AC-01", given: "g", when: "w", then: "t" }],
      expectedResults: ["42"],
      serviceIds: ["svc"],
      confirmedBehavior: false,
    });
    await step(repo, "architect", {
      action: "set-service",
      service: {
        id: "svc",
        name: "svc",
        kind: "module",
        localPath: service,
        responsibilities: ["answer"],
        requirementIds: ["REQ-MWI-910"],
        dependsOn: [],
        status: "in_progress",
      },
    });
    const verified = await step(repo, "quality", { action: "verify-stories", independentRerun: true });
    expect((verified.data.result as { verdict: string }).verdict).toBe("FAIL");
  });
});

describe("legacy single-file workflow state", () => {
  function legacyRepo() {
    const repo = repoDir();
    const state = openLocalWorkflow({ projectId: "legacy", title: "Legacy item", request: "from state.json" });
    mkdirSync(join(repo, ".praxis", "workflow"), { recursive: true });
    const path = join(repo, ".praxis", "workflow", "state.json");
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return { repo, path, state, bytes: readFileSync(path, "utf8") };
  }

  it("is read unchanged, then migrated on first write, leaving a tombstone older runtimes cannot parse", async () => {
    const { repo, path, state, bytes } = legacyRepo();
    const status = await call("praxis_workflow_status", repo, "ba", {});
    expect(status.data.workItemId).toBe(state.workItem.id);
    expect(status.data.workItems).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(join(repo, ".praxis", "workflow", "index.json"))).toBe(false);

    await step(repo, "ba", requirement("REQ-MWI-920", "Written after migration."));

    const dir = join(repo, ".praxis", "workflow");
    expect(existsSync(join(dir, "items", `${state.workItem.id}.json`))).toBe(true);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(index).toMatchObject({ contract: "praxis.workflow.index", version: 1, current: state.workItem.id });
    const tombstone = JSON.parse(readFileSync(path, "utf8"));
    expect(tombstone.contract).toBe("praxis.workflow.migrated");
    // An older runtime parses state.json with this schema: it must fail loudly, not open a new workflow.
    expect(() => WorkflowStateSchema.parse(tombstone)).toThrow();
    expect(readPersistedState<{ requirements: unknown[] }>(repo).requirements).toHaveLength(1);

    const second = await step(repo, "ba", open("After migration"));
    expect(second.data.duplicate).toBe(false);
    expect((await call("praxis_workflow_status", repo, "ba", {})).data.workItems).toHaveLength(2);
  });

  it("opening a different item in a legacy repository keeps the legacy item", async () => {
    const { repo, state } = legacyRepo();
    const other = await step(repo, "ba", open("Brand new item"));
    expect(other.data.duplicate).toBe(false);
    const legacyItem = readPersistedState<{ workItem: { id: string } }>(repo, state.workItem.id);
    expect(legacyItem.workItem.id).toBe(state.workItem.id);
  });
});

describe("concurrent writers", () => {
  it("lose no updates when several processes hold the workflow lock in turn", () => {
    const repo = repoDir();
    const counter = join(repo, "counter.txt");
    writeFileSync(counter, "0");
    const script = join(repo, "worker.mts");
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
import { withWorkflowLock } from ${JSON.stringify(join(here, "workflow-store.ts"))};
const [repo, counter, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i += 1) {
  withWorkflowLock(repo, () => {
    const value = Number(readFileSync(counter, "utf8"));
    writeFileSync(counter, String(value + 1));
  });
}
`,
    );
    const viteNode = resolve(here, "../../../node_modules/.bin/vite-node");
    const workers = [1, 2, 3, 4].map(() =>
      import("node:child_process").then(({ spawn }) =>
        new Promise<number>((done) => {
          const child = spawn(viteNode, [script, repo, counter, "15"], { stdio: "inherit" });
          child.on("exit", (code) => done(code ?? 1));
        }),
      ),
    );
    return Promise.all(workers).then((codes) => {
      expect(codes).toEqual([0, 0, 0, 0]);
      expect(Number(readFileSync(counter, "utf8"))).toBe(60);
      expect(existsSync(join(repo, ".praxis", "workflow", ".lock"))).toBe(false);
    });
  }, 120_000);

  it("reclaims a lock left behind by a dead process", async () => {
    const repo = repoDir();
    const lock = join(repo, ".praxis", "workflow", ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 2_147_483_000, at: Date.now() }));
    await step(repo, "ba", open("After crash"));
    expect(existsSync(lock)).toBe(false);
  });
});

void spawnSync;
