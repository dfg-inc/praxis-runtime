/**
 * The approval UX through the real MCP tool entry point:
 *   Action -> Preview -> the user approves or rejects -> Execute -> Result.
 *
 * The user's answer is played by a fake client dialog (the same UserApprovalChannel the MCP server builds from the
 * client's elicitation). Real workflow store, real Jira fixture provider, real files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decisionContentFingerprint, storyContentFingerprint, withApprovalChannel, type ApprovalRequest, type AskAnswer, type UserApprovalChannel } from "@praxis/contracts";
import { createFixtureJiraProvider, createMockFetch, createMockJiraState, type JiraConfig } from "@praxis/jira";
import { elicitationChannel } from "./approval-channel.js";
import { callTool } from "./tools.js";
import { readPersistedState, type McpEnvelope } from "./workflow-test-helpers.js";

const VERSION = "test";
const ENV = ["PRAXIS_APPROVAL_STRICT", "PRAXIS_JIRA_BASE_URL"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env.PRAXIS_APPROVAL_STRICT;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A client dialog that answers as scripted and remembers what it was shown. */
function dialog(answers: AskAnswer[] | AskAnswer) {
  const seen: ApprovalRequest[] = [];
  const queue = Array.isArray(answers) ? [...answers] : undefined;
  const channel: UserApprovalChannel = {
    kind: "client-elicitation",
    async ask(request) {
      seen.push(request);
      return queue ? (queue.shift() ?? { answer: "reject" }) : (answers as AskAnswer);
    },
  };
  return { channel, seen };
}

const call = async (tool: string, repo: string, args: Record<string, unknown>, role = "ba", channel?: UserApprovalChannel, extra?: object): Promise<McpEnvelope> =>
  (await callTool(tool, { repo, ...args }, { role: role as "ba", version: VERSION, approvalChannel: channel, ...(extra ? { extra } : {}) })) as McpEnvelope;

async function preview(repo: string, command: object, role = "ba") {
  const previewed = await call("praxis_workflow_preview", repo, { command: JSON.stringify(command) }, role);
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  return previewed;
}

async function apply(repo: string, command: object, opts: { channel?: UserApprovalChannel; confirmation?: string; fingerprint?: string; role?: string } = {}) {
  const fingerprint = opts.fingerprint ?? ((await preview(repo, command, opts.role)).data.fingerprint as string);
  return call(
    "praxis_workflow_apply",
    repo,
    { command: JSON.stringify(command), ...(opts.confirmation === undefined ? { confirmation: "YES" } : { confirmation: opts.confirmation }), previewFingerprint: fingerprint },
    opts.role ?? "ba",
    opts.channel,
  );
}

const must = async (repo: string, command: object) => {
  const result = await apply(repo, command);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  return result;
};

type Persisted = {
  stories: Array<{ id: string; revision: number; confirmedBehavior: boolean; narrative: string }>;
  decisions: Array<{ id: string; confirmed: boolean; revision: number; statement: string }>;
  services: Array<{ id: string; status: string }>;
  requirements: Array<{ id: string }>;
};
const state = (repo: string) => readPersistedState<Persisted>(repo);

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-flow-"));
  await must(repo, { action: "open", projectId: "flow", title: "User approval", request: "r" });
  await must(repo, { action: "add-requirement", id: "REQ-FLW-101", statement: "The user approves.", acceptanceCriteria: ["Done."] });
  for (const n of [1, 2]) {
    await must(repo, {
      action: "add-story",
      id: `US-FLW-00${n}`,
      requirementIds: ["REQ-FLW-101"],
      actor: "user",
      narrative: `As a user, I want story ${n} confirmed, so that it counts.`,
      objective: `Obj ${n}`,
      userValue: "Value",
      happyPath: ["review it"],
      acceptanceCriteria: [{ id: `US-FLW-00${n}-AC-01`, given: "g", when: "w", then: "t" }],
      expectedResults: ["confirmed"],
      serviceIds: ["svc"],
      confirmedBehavior: false,
    });
  }
  await must(repo, { action: "record-decision", id: "DEC-FLW-001", statement: "Ask the user", rationale: "exact" });
  await must(repo, {
    action: "set-service",
    service: { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-FLW-101"], dependsOn: [], status: "in_progress" },
  });
  return repo;
}

const confirmStory = (repo: string, id: string) => {
  const story = state(repo).stories.find((item) => item.id === id)!;
  return { action: "confirm-story", id, revision: story.revision, contentFingerprint: storyContentFingerprint(story as never) };
};
const confirmDecision = (repo: string, id: string) => {
  const decision = state(repo).decisions.find((item) => item.id === id)!;
  return { action: "confirm-decision", id, revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision as never) };
};

describe("confirming a Story: only the user can do it, and only the Story they were shown", () => {
  it("preview shows what the user will be asked and writes nothing", async () => {
    const repo = await setup();
    const before = JSON.stringify(state(repo));
    const previewed = await preview(repo, confirmStory(repo, "US-FLW-001"));
    const view = previewed.data.humanApproval as { required: boolean; kind: string; description: string; explanation: string };
    expect(view).toMatchObject({ required: true, kind: "story_behavior" });
    expect(view.description).toContain("story 1 confirmed");
    expect(view.explanation).toMatch(/approve or reject exactly this/);
    expect(JSON.stringify(state(repo))).toBe(before);
  });

  it("Approve in the dialog confirms exactly that Story, says it was asked in the client, and shows the user the Story", async () => {
    const repo = await setup();
    const { channel, seen } = dialog({ answer: "approve" });
    const applied = await apply(repo, confirmStory(repo, "US-FLW-001"), { channel });
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "confirm-story", kind: "story_behavior" });
    expect(seen[0]!.description).toContain("story 1 confirmed");
    expect(seen[0]!.description).not.toContain("story 2 confirmed");
    expect(state(repo).stories.map((s) => [s.id, s.confirmedBehavior])).toEqual([["US-FLW-001", true], ["US-FLW-002", false]]);
    expect(applied.data.approval).toEqual([expect.objectContaining({ action: "confirm-story", channel: "client-elicitation", assurance: "client-ui" })]);
    expect(applied.warnings).toEqual([]);
  });

  it("Reject and Dismiss confirm nothing and say so", async () => {
    for (const answer of ["reject", "dismiss"] as const) {
      const repo = await setup();
      const { channel } = dialog({ answer });
      const applied = await apply(repo, confirmStory(repo, "US-FLW-001"), { channel });
      expect(applied.ok).toBe(false);
      expect(applied.code).toBe("APPROVAL_REJECTED");
      expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
    }
  });

  it("confirmation=NO is the user's refusal reported by the agent: recorded, nothing runs, nobody is asked", async () => {
    const repo = await setup();
    const { channel, seen } = dialog({ answer: "approve" });
    const applied = await apply(repo, confirmStory(repo, "US-FLW-001"), { channel, confirmation: "NO" });
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REJECTED");
    expect(seen).toHaveLength(0);
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
    const log = readFileSync(join(repo, ".praxis", "approvals", "decisions.jsonl"), "utf8");
    expect(log).toMatch(/"decision":"rejected"/);
  });

  it("confirmation=NO also stops an ordinary record: a refused apply writes nothing", async () => {
    const repo = await setup();
    const command = { action: "add-requirement", id: "REQ-FLW-102", statement: "Not wanted.", acceptanceCriteria: ["x"] };
    const applied = await apply(repo, command, { confirmation: "NO" });
    expect(applied.code).toBe("APPROVAL_REJECTED");
    expect(state(repo).requirements.map((r) => r.id)).not.toContain("REQ-FLW-102");
  });

  it("an agent cannot supply the approval: approval-shaped fields in the command or the arguments are ignored", async () => {
    const repo = await setup();
    const command = confirmStory(repo, "US-FLW-001");
    const forged = { ...command, authorization: "x", userApproval: { decision: "approved" }, approval: { decision: "approved" } };
    const { channel, seen } = dialog({ answer: "reject" });
    const fingerprint = (await preview(repo, command)).data.fingerprint as string;
    const applied = await call("praxis_workflow_apply", repo, { command: JSON.stringify(forged), confirmation: "YES", previewFingerprint: fingerprint, grant: { state: "APPROVED" }, approved: true }, "ba", channel);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REJECTED");
    expect(seen).toHaveLength(1); // the dialog was still shown: nothing the agent sent replaced it
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
  });

  it("a stale preview is refused before the user is asked", async () => {
    const repo = await setup();
    const command = confirmStory(repo, "US-FLW-001");
    const fingerprint = (await preview(repo, command)).data.fingerprint as string;
    await must(repo, { action: "record-context", notes: "the state moved on" });
    const { channel, seen } = dialog({ answer: "approve" });
    const applied = await apply(repo, command, { channel, fingerprint });
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("FINGERPRINT_MISMATCH");
    expect(seen).toHaveLength(0);
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
  });

  it("approving one act never approves another: a decision and a service each ask for their own kind", async () => {
    const repo = await setup();
    const { channel, seen } = dialog([{ answer: "approve" }, { answer: "approve" }]);
    const decision = await apply(repo, confirmDecision(repo, "DEC-FLW-001"), { channel, role: "architect" });
    expect(decision.ok, JSON.stringify(decision.errors)).toBe(true);
    const service = await apply(
      repo,
      { action: "set-service", service: { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-FLW-101"], dependsOn: [], status: "approved" } },
      { channel, role: "quality" },
    );
    expect(service.ok, JSON.stringify(service.errors)).toBe(true);
    expect(seen.map((r) => [r.action, r.kind])).toEqual([["confirm-decision", "architecture_decision"], ["approve-service", "quality_verdict"]]);
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
  });

  it("agent-authored records need no approval and never open a dialog", async () => {
    const repo = await setup();
    const { channel, seen } = dialog({ answer: "reject" });
    const applied = await apply(repo, { action: "add-requirement", id: "REQ-FLW-103", statement: "Agent notes.", acceptanceCriteria: ["x"] }, { channel });
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("a client that cannot show an approval dialog: an explicit, unverified fallback", () => {
  it("confirmation=YES confirms, and the result says plainly that nobody could verify a person was asked", async () => {
    const repo = await setup();
    const applied = await apply(repo, confirmStory(repo, "US-FLW-001"));
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(applied.data.approval).toEqual([expect.objectContaining({ channel: "confirmation-flag", assurance: "unverified" })]);
    expect(applied.warnings.join(" ")).toMatch(/approval unverified.*cannot verify that a person was asked/);
    expect(readFileSync(join(repo, ".praxis", "approvals", "decisions.jsonl"), "utf8")).toMatch(/"assurance":"unverified"/);
  });

  it("without confirmation=YES nothing is confirmed", async () => {
    const repo = await setup();
    const fingerprint = (await preview(repo, confirmStory(repo, "US-FLW-001"))).data.fingerprint as string;
    const applied = await call("praxis_workflow_apply", repo, { command: JSON.stringify(confirmStory(repo, "US-FLW-001")), previewFingerprint: fingerprint });
    expect(applied.code).toBe("CONFIRMATION_REQUIRED");
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
  });

  it("PRAXIS_APPROVAL_STRICT=1 refuses the fallback; the dialog still works", async () => {
    process.env.PRAXIS_APPROVAL_STRICT = "1";
    const repo = await setup();
    const refused = await apply(repo, confirmStory(repo, "US-FLW-001"));
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("APPROVAL_CLIENT_UI_REQUIRED");
    expect(state(repo).stories.every((s) => s.confirmedBehavior === false)).toBe(true);
    const { channel } = dialog({ answer: "approve" });
    const approved = await apply(repo, confirmStory(repo, "US-FLW-001"), { channel });
    expect(approved.ok, JSON.stringify(approved.errors)).toBe(true);
  });

  it("the doctor says which mode this session is in", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-flow-doc-"));
    const fallback = await call("praxis_doctor", repo, {});
    expect(fallback.data.approval).toMatchObject({ mode: "unverified-fallback", strict: false });
    expect(fallback.data.nextSteps.join(" ")).toMatch(/cannot show an approval dialog/);
    const { channel } = dialog({ answer: "approve" });
    // the doctor reads the mode of the call it is served in
    const viaDialog = await call("praxis_doctor", repo, {}, "ba", channel);
    expect(viaDialog.data.approval).toMatchObject({ mode: "client-ui" });
  });
});

describe("the MCP elicitation dialog", () => {
  const fake = (result: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } | Error, sink: unknown[] = []) =>
    elicitationChannel({
      supported: true,
      elicitInput: async (params) => {
        sink.push(params);
        if (result instanceof Error) throw result;
        return result;
      },
    })!;
  const request: ApprovalRequest = { action: "praxis_developer_git_commit", kind: "git_operation", summary: "Commit README.md", description: "One file", subject: "s", risks: ["adds a commit"] };

  it("a client without the capability gets no channel", () => {
    expect(elicitationChannel({ supported: false, elicitInput: async () => ({ action: "accept" }) })).toBeUndefined();
  });

  it("shows the whole preview and asks for approve or reject", async () => {
    const sink: Array<{ message: string; requestedSchema: { properties: { decision: { enum: string[] } }; required: string[] } }> = [];
    await fake({ action: "accept", content: { decision: "approve" } }, sink).ask(request);
    expect(sink[0]!.message).toContain("Commit README.md");
    expect(sink[0]!.message).toContain("One file");
    expect(sink[0]!.message).toContain("adds a commit");
    expect(sink[0]!.requestedSchema.properties.decision.enum).toEqual(["approve", "reject"]);
    expect(sink[0]!.requestedSchema.required).toEqual(["decision"]);
  });

  it("maps Accept+approve, Accept+reject, Decline and Cancel; an unavailable dialog is not a yes", async () => {
    expect((await fake({ action: "accept", content: { decision: "approve", reason: " fine " } }).ask(request))).toEqual({ answer: "approve", reason: "fine" });
    expect((await fake({ action: "accept", content: { decision: "reject" } }).ask(request)).answer).toBe("reject");
    expect((await fake({ action: "accept", content: {} }).ask(request)).answer).toBe("reject");
    expect((await fake({ action: "decline" }).ask(request)).answer).toBe("reject");
    expect((await fake({ action: "cancel" }).ask(request)).answer).toBe("dismiss");
    expect((await fake(new Error("elicitation is not supported on this protocol era")).ask(request)).answer).toBe("unavailable");
    await expect(fake(new Error("socket closed")).ask(request)).rejects.toThrow(/socket closed/);
  });

  it("works end to end: the channel built from a client's elicitation drives a real apply", async () => {
    const repo = await setup();
    const channel = fake({ action: "accept", content: { decision: "approve" } });
    const applied = await apply(repo, confirmStory(repo, "US-FLW-001"), { channel });
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    const declined = await apply(repo, confirmStory(repo, "US-FLW-002"), { channel: fake({ action: "decline" }) });
    expect(declined.code).toBe("APPROVAL_REJECTED");
    expect(state(repo).stories.map((s) => [s.id, s.confirmedBehavior])).toEqual([["US-FLW-001", true], ["US-FLW-002", false]]);
  });
});

describe("Jira, Git and the project file: Reject runs nothing, Approve runs only the previewed action", () => {
  const cfg = (): JiraConfig => ({
    mode: "cloud",
    baseUrl: "https://acme.atlassian.net",
    token: "secret-jira-token-value",
    projectKey: "PRX",
    email: "dev@example.com",
    authMode: "cloud-basic",
    epicType: "Epic",
    storyType: "Story",
    taskType: "Task",
    bugType: "Bug",
    workPackageType: "",
    transitions: {},
    workPackageMaxHours: 16,
  });
  const mock = () => {
    const jiraState = createMockJiraState();
    const provider = createFixtureJiraProvider({ config: cfg(), fetchImpl: createMockFetch(jiraState, { flavor: "cloud", projectKey: "PRX" }) });
    return { jiraState, provider };
  };
  function seedProposal(repo: string, epicKey: string) {
    const dir = join(repo, ".praxis-jira", "proposals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${epicKey}.json`),
      `${JSON.stringify({
        contract: "jira.ba.proposal",
        version: "1.0.0",
        epicKey,
        stories: [
          {
            logicalId: "E2-FR1",
            artifactId: `ba:${epicKey}:E2-FR1`,
            summary: "Counter library: add reset()",
            userStory: { asA: "developer", iWant: "reset", soThat: "I can zero the counter" },
            businessContext: "Counter library",
            acceptanceCriteria: [{ given: "a counter", when: "reset", then: "value is 0" }],
            outOfScope: [],
            dependencies: [],
            requirementIds: ["E2-FR1"],
          },
        ],
        nfrs: [],
        businessRules: [],
        openQuestions: [],
      }, null, 2)}\n`,
    );
  }
  async function baSetup() {
    process.env.PRAXIS_JIRA_BASE_URL = "https://acme.atlassian.net";
    const { jiraState, provider } = mock();
    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-flow-jira-"));
    seedProposal(repo, epic.key);
    const extra = { provider };
    const previewed = await call("praxis_ba_preview", repo, { epic: epic.key }, "ba", undefined, extra);
    expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
    return { jiraState, extra, repo, epic: epic.key, fingerprint: (previewed.data as { previewFingerprint: string }).previewFingerprint };
  }

  it("Reject: nothing is written to Jira; the user was shown the plan", async () => {
    const { jiraState, extra, repo, epic, fingerprint } = await baSetup();
    const before = jiraState.createIssueCount;
    const { channel, seen } = dialog({ answer: "reject" });
    const applied = await call("praxis_ba_apply", repo, { epic, confirmation: "YES", previewFingerprint: fingerprint }, "ba", channel, extra);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_REJECTED");
    expect(jiraState.createIssueCount).toBe(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "praxis_ba_apply", kind: "issue_tracker_mutation" });
    expect(seen[0]!.description).toMatch(/CREATE|Counter library/);
  });

  it("Approve: the previewed plan is written, and the result says it was approved in the client", async () => {
    const { jiraState, extra, repo, epic, fingerprint } = await baSetup();
    const before = jiraState.createIssueCount;
    const { channel } = dialog({ answer: "approve" });
    const applied = await call("praxis_ba_apply", repo, { epic, confirmation: "YES", previewFingerprint: fingerprint }, "ba", channel, extra);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(jiraState.createIssueCount).toBeGreaterThan(before);
    expect(applied.data.approval).toEqual([expect.objectContaining({ action: "praxis_ba_apply", assurance: "client-ui" })]);
  });

  it("a stale preview fingerprint is refused before the user is asked, and nothing is written", async () => {
    const { jiraState, extra, repo, epic } = await baSetup();
    const before = jiraState.createIssueCount;
    const { channel, seen } = dialog({ answer: "approve" });
    const applied = await call("praxis_ba_apply", repo, { epic, confirmation: "YES", previewFingerprint: `sha256:${"0".repeat(64)}` }, "ba", channel, extra);
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("APPROVAL_FINGERPRINT_MISMATCH");
    expect(seen).toHaveLength(0);
    expect(jiraState.createIssueCount).toBe(before);
  });

  it("confirmation=NO on a Jira write: rejected, nobody asked, nothing written", async () => {
    const { jiraState, extra, repo, epic, fingerprint } = await baSetup();
    const before = jiraState.createIssueCount;
    const { channel, seen } = dialog({ answer: "approve" });
    const applied = await call("praxis_ba_apply", repo, { epic, confirmation: "NO", previewFingerprint: fingerprint }, "ba", channel, extra);
    expect(applied.code).toBe("APPROVAL_REJECTED");
    expect(seen).toHaveLength(0);
    expect(jiraState.createIssueCount).toBe(before);
  });

  it("the project file: Reject writes nothing, Approve writes it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-flow-init-"));
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
    const rejected = await call("praxis_project_init_apply", repo, { confirmation: "YES" }, "ba", dialog({ answer: "reject" }).channel);
    expect(rejected.code).toBe("APPROVAL_REJECTED");
    expect(existsSync(join(repo, ".project"))).toBe(false);
    const approved = await call("praxis_project_init_apply", repo, { confirmation: "YES" }, "ba", dialog({ answer: "approve" }).channel);
    expect(approved.ok, JSON.stringify(approved.errors)).toBe(true);
    expect(existsSync(join(repo, ".project"))).toBe(true);
  });
});

describe("running under the MCP server", () => {
  it("the channel is per call: a call served without a dialog never sees another call's dialog", async () => {
    const [repoA, repoB] = [await setup(), await setup()];
    const { channel, seen } = dialog({ answer: "approve" });
    const [withDialog, without] = await Promise.all([
      apply(repoA, confirmStory(repoA, "US-FLW-001"), { channel }),
      apply(repoB, confirmStory(repoB, "US-FLW-001")),
    ]);
    expect((withDialog.data.approval as Array<{ assurance: string }>)[0]!.assurance).toBe("client-ui");
    expect((without.data.approval as Array<{ assurance: string }>)[0]!.assurance).toBe("unverified");
    expect(seen).toHaveLength(1);
  });
});
