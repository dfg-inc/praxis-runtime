import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionPlanSchema,
  approvedContentDigest,
  encodeAuthorization,
  generateApprovalKeyPair,
  signAuthorization,
  type AuthorizationBody,
} from "@praxis/contracts";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";
const keys = generateApprovalKeyPair();
const attacker = generateApprovalKeyPair();
const ENV = ["PRAXIS_BROKER_SHARED_DIR", "PRAXIS_APPROVAL_PUBLIC_KEY", "PRAXIS_SECURITY_MODE", "PRAXIS_TEST_ALLOW_SAME_IDENTITY", "PRAXIS_OPERATOR_URL", "PRAXIS_WORKFLOW_RECORDS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
  process.env.PRAXIS_SECURITY_MODE = "compatibility"; // grants are trusted; the isolation case sets secure itself
  delete process.env.PRAXIS_WORKFLOW_RECORDS;
  delete process.env.PRAXIS_BROKER_SHARED_DIR;
  process.env.PRAXIS_OPERATOR_URL = "http://localhost:8780";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const call = async (tool: string, repo: string, args: Record<string, unknown>): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: "ba", version: VERSION })) as McpEnvelope;

/** Preview then apply, exactly as an agent does. No approval fixtures: agent-authored records need none. */
async function run(repo: string, command: object): Promise<McpEnvelope> {
  const previewed = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command) });
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  return call("praxis_workflow_apply", repo, {
    command: JSON.stringify(command),
    confirmation: "YES",
    previewFingerprint: previewed.data.fingerprint,
  });
}
const mustRun = async (repo: string, command: object) => {
  const result = await run(repo, command);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  return result;
};

type Persisted = {
  stories: Array<{ id: string; revision: number; confirmedBehavior: boolean; narrative: string }>;
  decisions: Array<{ id: string; confirmed: boolean; revision: number }>;
  services: Array<{ id: string; status: string }>;
};
const state = (repo: string) => readPersistedState<Persisted>(repo);

async function setup(withBroker = true) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-hap-"));
  const shared = mkdtempSync(join(tmpdir(), "praxis-shared-"));
  if (withBroker) process.env.PRAXIS_BROKER_SHARED_DIR = shared;
  await mustRun(repo, { action: "open", projectId: "hap", title: "Human approval", request: "r" });
  await mustRun(repo, { action: "add-requirement", id: "REQ-HAP-101", statement: "Owner approves.", acceptanceCriteria: ["Done."] });
  for (const n of [1, 2]) {
    await mustRun(repo, {
      action: "add-story",
      id: `US-HAP-00${n}`,
      requirementIds: ["REQ-HAP-101"],
      actor: "owner",
      narrative: `As a owner, I want story ${n} confirmed, so that it counts.`,
      objective: `Obj ${n}`,
      userValue: "Value",
      happyPath: ["review it"],
      acceptanceCriteria: [{ id: `US-HAP-00${n}-AC-01`, given: "g", when: "w", then: "t" }],
      expectedResults: ["confirmed"],
      serviceIds: ["svc"],
      confirmedBehavior: false,
    });
  }
  await mustRun(repo, { action: "record-decision", id: "DEC-HAP-001", statement: "Use grants", rationale: "exact" });
  await mustRun(repo, {
    action: "set-service",
    service: { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-HAP-101"], dependsOn: [], status: "in_progress" },
  });
  return { repo, shared };
}

/** Play the broker: read what the Runtime proposed, sign that plan's own fields, drop the token in the inbox. */
function brokerSigns(shared: string, planId: string, over: Partial<AuthorizationBody> = {}, key = keys.privateKeyPem) {
  const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")));
  const action = plan.actions[0]!;
  const body: AuthorizationBody = {
    contract: "praxis.approval.authorization",
    version: 1,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    provider: plan.provider,
    instanceId: plan.instanceId,
    operations: plan.operations,
    workItemIds: plan.workItemIds,
    repositories: plan.repositories,
    action: action.action,
    targets: action.targets,
    decisionKind: plan.decisionKind,
    content: action.content ?? "",
    contentDigest: approvedContentDigest(action.content ?? ""),
    approver: "operator:owner",
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    consumptionId: `c-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
  mkdirSync(join(shared, "authorizations"), { recursive: true });
  writeFileSync(join(shared, "authorizations", `${planId}.token`), encodeAuthorization(signAuthorization(body, key)));
}

const planIdOf = (response: McpEnvelope) => /Plan (hg-[A-Za-z0-9-]+)/.exec(response.errors?.[0] ?? "")?.[1] ?? "";

describe("agent-authored records need no approval", () => {
  it("regression: a secure-mode Desktop can record requirements, stories, handoffs and verdict inputs", async () => {
    // Original defect: every workflow write returned APPROVAL_REQUIRED, so no role could work in secure mode.
    process.env.PRAXIS_SECURITY_MODE = "secure";
    const { repo } = await setup(false);
    await mustRun(repo, { action: "handoff", sourceRole: "ba", targetRole: "architect", requirementIds: ["REQ-HAP-101"], readiness: "ready" });
    expect(state(repo).stories).toHaveLength(2);
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
    expect(state(repo).decisions[0]?.confirmed).toBe(false);
  });

  it("the strict policy still demands an approved mutation for everything", async () => {
    process.env.PRAXIS_WORKFLOW_RECORDS = "approval";
    const repo = mkdtempSync(join(tmpdir(), "praxis-strict-"));
    const result = await run(repo, { action: "open", projectId: "x", title: "Strict", request: "r" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_REQUIRED");
  });
});

describe("a human act cannot be performed by the agent", () => {
  it("regression: confirmed:true on a decision is refused, so the agent cannot approve its own decision", async () => {
    const { repo } = await setup();
    const command = JSON.stringify({ action: "record-decision", id: "DEC-X", statement: "x", confirmed: true });
    // Refused at preview already, because preview simulates the apply; so there is no fingerprint to apply with.
    const previewed = await call("praxis_workflow_preview", repo, { command });
    expect(previewed.ok).toBe(false);
    expect(previewed.errors?.join(" ")).toMatch(/cannot confirm it/);
    const forced = await call("praxis_workflow_apply", repo, { command, confirmation: "YES", previewFingerprint: "sha256:" + "0".repeat(64) });
    expect(forced.ok).toBe(false);
    expect(state(repo).decisions.map((d) => d.id)).toEqual(["DEC-HAP-001"]);
  });

  it("without a broker configured, confirming a story is refused and says why; nothing is recorded", async () => {
    const { repo } = await setup(false);
    const command = { action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` };
    const previewed = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command) });
    expect(previewed.data.humanApproval).toMatchObject({ required: true, status: "broker-not-configured", kind: "story_behavior" });
    const applied = await run(repo, command);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REQUIRED");
    expect(applied.errors?.join(" ")).toMatch(/no approval broker is configured/);
    expect(state(repo).stories.every((s) => !s.confirmedBehavior)).toBe(true);
  });

  it("preview shows what the owner will be asked and writes nothing", async () => {
    const { repo, shared } = await setup();
    const previewed = await call("praxis_workflow_preview", repo, {
      command: JSON.stringify({ action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` }),
    });
    expect(previewed.ok).toBe(true);
    expect(previewed.data.humanApproval).toMatchObject({ required: true, kind: "story_behavior", status: "awaiting-operator" });
    expect(previewed.data.humanApproval.operatorUrl).toMatch(/^http:\/\/localhost:8780\/plan\/hg-confirm-story-/);
    expect(existsSync(join(shared, "pending"))).toBe(false);
  });

  it("applying without a grant proposes the exact plan to the inbox, refuses, and records nothing", async () => {
    const { repo, shared } = await setup();
    const fp = (await call("praxis_workflow_preview", repo, { command: JSON.stringify({ action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` }) })).data;
    expect(fp.humanApproval.status).toBe("awaiting-operator");
    const command = { action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` };
    const applied = await run(repo, command);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REQUIRED");
    const planId = planIdOf(applied);
    expect(planId).toMatch(/^hg-confirm-story-/);
    // The plan is exactly what the owner must decide, and it is a valid, one-action, content-verified plan.
    const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")));
    expect(plan).toMatchObject({ decisionKind: "story_behavior", operations: ["repository_edit"], role: "ba" });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.targets).toEqual(["US-HAP-001"]);
    expect(plan.actions[0]?.description).toContain("As owner: As a owner, I want story 1 confirmed");
    expect(plan.actions[0]?.description).toContain("US-HAP-001-AC-01");
    // Asking again does not create another plan or change the one the owner may be looking at.
    const before = readFileSync(join(shared, "pending", `${planId}.json`), "utf8");
    await run(repo, command);
    expect(readdirSync(join(shared, "pending"))).toEqual([`${planId}.json`]);
    expect(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")).toBe(before);
    expect(state(repo).stories[0]?.confirmedBehavior).toBe(false);
  });

  it("with the owner's approval, the same command confirms exactly that story and no other", async () => {
    const { repo, shared } = await setup();
    const command = { action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` };
    const planId = planIdOf(await run(repo, command));
    brokerSigns(shared, planId);
    const preview = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command) });
    expect(preview.data.humanApproval.status).toBe("approved");
    // The command's own revision/fingerprint must match the reviewed story; the Runtime fills them in from state.
    const story = state(repo).stories[0]!;
    expect(story.confirmedBehavior).toBe(false);
    const pending = JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8"));
    const fingerprint = /Content fingerprint: (sha256:[a-f0-9]{64})/.exec(pending.actions[0].description)![1];
    const confirmed = await run(repo, { ...command, contentFingerprint: fingerprint });
    expect(confirmed.ok, JSON.stringify(confirmed.errors)).toBe(true);
    expect(state(repo).stories.map((s) => s.confirmedBehavior)).toEqual([true, false]);
  });

  it("refuses a token that is for another story, another kind, expired, or signed by another key", async () => {
    const { repo, shared } = await setup();
    const fpOf = async (id: string) => {
      const planId = planIdOf(await run(repo, { action: "confirm-story", id, revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` }));
      const pending = JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8"));
      return { planId, fingerprint: /Content fingerprint: (sha256:[a-f0-9]{64})/.exec(pending.actions[0].description)![1] };
    };
    const one = await fpOf("US-HAP-001");
    const two = await fpOf("US-HAP-002");
    const attempt = (id: string, fp: string) => run(repo, { action: "confirm-story", id, revision: 1, contentFingerprint: fp });
    // 1. story 2's approval dropped under story 1's plan id
    brokerSigns(shared, two.planId);
    writeFileSync(join(shared, "authorizations", `${one.planId}.token`), readFileSync(join(shared, "authorizations", `${two.planId}.token`), "utf8"));
    expect((await attempt("US-HAP-001", one.fingerprint)).errors?.join(" ")).toMatch(/not for US-HAP-001|APPROVAL_SCOPE/);
    // 2. right story, wrong kind of decision
    brokerSigns(shared, one.planId, { decisionKind: "git_operation" });
    expect((await attempt("US-HAP-001", one.fingerprint)).errors?.join(" ")).toMatch(/one kind of approval never authorizes another/);
    // 3. expired
    brokerSigns(shared, one.planId, { issuedAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await attempt("US-HAP-001", one.fingerprint)).errors?.join(" ")).toMatch(/expired/);
    // 4. the agent signs with its own key
    brokerSigns(shared, one.planId, {}, attacker.privateKeyPem);
    expect((await attempt("US-HAP-001", one.fingerprint)).errors?.join(" ")).toMatch(/signature is not valid/);
    expect(state(repo).stories.every((s) => !s.confirmedBehavior)).toBe(true);
  });

  it("regression: in secure mode on a host that cannot isolate the broker, even a valid approval is refused", async () => {
    // The assessment is what stops a same-user agent that controls the verifying key from forging approvals.
    const { repo, shared } = await setup();
    const command = { action: "confirm-story", id: "US-HAP-001", revision: 1, contentFingerprint: `sha256:${"0".repeat(64)}` };
    const planId = planIdOf(await run(repo, command));
    const pending = JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8"));
    brokerSigns(shared, planId);
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
    const fingerprint = /Content fingerprint: (sha256:[a-f0-9]{64})/.exec(pending.actions[0].description)![1];
    const blocked = await run(repo, { ...command, contentFingerprint: fingerprint });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
    expect(state(repo).stories[0]?.confirmedBehavior).toBe(false);
  });
});

describe("decisions and services", () => {
  it("confirm-decision confirms the reviewed revision once the owner approves it", async () => {
    const { repo, shared } = await setup();
    const base = { action: "confirm-decision", id: "DEC-HAP-001", revision: 1 };
    const first = await run(repo, { ...base, contentFingerprint: `sha256:${"0".repeat(64)}` });
    expect(first.code).toBe("APPROVAL_REQUIRED");
    const planId = planIdOf(first);
    const pending = ActionPlanSchema.parse(JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")));
    expect(pending.decisionKind).toBe("architecture_decision");
    brokerSigns(shared, planId);
    const fingerprint = /Content fingerprint: (sha256:[a-f0-9]{64})/.exec(pending.actions[0]!.description)![1]!;
    const revision = state(repo).decisions[0]!.revision;
    const done = await run(repo, { ...base, revision, contentFingerprint: fingerprint });
    expect(done.ok, JSON.stringify(done.errors)).toBe(true);
    expect(state(repo).decisions[0]?.confirmed).toBe(true);
  });

  it("an agent cannot approve a service; the owner's grant for exactly that service can", async () => {
    const { repo, shared } = await setup();
    const service = { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-HAP-101"], dependsOn: [], status: "approved" };
    const first = await run(repo, { action: "set-service", service });
    expect(first.ok).toBe(false);
    expect(first.code).toBe("APPROVAL_REQUIRED");
    expect(state(repo).services[0]?.status).toBe("in_progress");
    const planId = planIdOf(first);
    const plan = ActionPlanSchema.parse(JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")));
    expect(plan.decisionKind).toBe("quality_verdict");
    expect(plan.role).toBe("quality");
    brokerSigns(shared, planId);
    const done = await run(repo, { action: "set-service", service });
    expect(done.ok, JSON.stringify(done.errors)).toBe(true);
    expect(state(repo).services[0]?.status).toBe("approved");
    // The service grant is not a story grant: the story is still unconfirmed.
    expect(state(repo).stories.every((s) => !s.confirmedBehavior)).toBe(true);
  });

  it("changing the service after it was shown to the owner invalidates the approval", async () => {
    const { repo, shared } = await setup();
    const approved = { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-HAP-101"], dependsOn: [], status: "approved" };
    brokerSigns(shared, planIdOf(await run(repo, { action: "set-service", service: approved })));
    const changed = await run(repo, { action: "set-service", service: { ...approved, responsibilities: ["x", "and something the owner never saw"] } });
    expect(changed.ok).toBe(false);
    // A different subject is a different plan: it is proposed afresh instead of riding on the old approval.
    expect(readdirSync(join(shared, "pending")).length).toBe(2);
    expect(state(repo).services[0]?.status).toBe("in_progress");
  });
});
