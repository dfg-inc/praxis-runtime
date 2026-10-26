import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelForOpenClassic } from "./test-user-choice.js";
import { callTool } from "./tools.js";
import { readPersistedState } from "./workflow-test-helpers.js";

const VERSION = "test";

type Envelope = { ok: boolean; code?: string; errors?: string[]; data: Record<string, unknown> };

async function preview(repo: string, command: object, role: string): Promise<Envelope> {
  return (await callTool(
    "praxis_workflow_preview",
    { repo, command: JSON.stringify(command) },
    { role, version: VERSION },
  )) as Envelope;
}

/** Preview, install a scoped host approval for that exact fingerprint, then apply through MCP. */
async function step(repo: string, command: object, role: string): Promise<Envelope> {
  const previewed = await preview(repo, command, role);
  expect(previewed.ok, JSON.stringify(previewed.errors)).toBe(true);
  const fingerprint = previewed.data.fingerprint as string;
  const applied = (await callTool(
    "praxis_workflow_apply",
    { repo, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: fingerprint },
    { role, version: VERSION, approvalChannel: channelForOpenClassic("praxis_workflow_apply", { command: JSON.stringify(command) }) },
  )) as Envelope;
  expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
  return applied;
}

describe("Quality evidence through MCP workflow tools", () => {
  it("quality-check uses verify-stories coverage instead of reporting missing evidence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-qev-"));
    const service = join(repo, "svc");
    mkdirSync(service, { recursive: true });
    writeFileSync(join(service, "scrub.mjs"), "export function scrub(v) { return v.startsWith('${') ? null : v; }\n");
    mkdirSync(join(repo, ".praxis", "quality"), { recursive: true });
    writeFileSync(
      join(repo, ".praxis", "quality", "checks.json"),
      JSON.stringify({
        checks: [
          {
            scenarioId: "US-QEV-001-S1",
            storyId: "US-QEV-001",
            requirementId: "REQ-QEV-101",
            acceptanceCriterionId: "US-QEV-001-AC-01",
            kind: "happy",
            serviceId: "svc",
            module: "scrub.mjs",
            call: { function: "scrub", args: ["${user_config.token}"] },
            expect: null,
          },
        ],
      }),
    );

    await step(repo, { action: "open", mode: "classic", projectId: "qev", title: "Evidence", request: "Evidence consistency" }, "ba");
    await step(
      repo,
      {
        action: "add-requirement",
        id: "REQ-QEV-101",
        statement: "Unexpanded placeholders are treated as unset.",
        acceptanceCriteria: ["A placeholder becomes null."],
        serviceIds: ["svc"],
      },
      "ba",
    );
    await step(
      repo,
      {
        action: "add-story",
        id: "US-QEV-001",
        requirementIds: ["REQ-QEV-101"],
        actor: "operator",
        narrative: "As a operator, I want placeholders unset, so that diagnostics are accurate.",
        objective: "Placeholders are unset",
        userValue: "Accurate diagnostics",
        happyPath: ["Scrub a placeholder"],
        acceptanceCriteria: [{ id: "US-QEV-001-AC-01", given: "a placeholder", when: "scrubbed", then: "null" }],
        expectedResults: ["null"],
        serviceIds: ["svc"],
        confirmedBehavior: false,
      },
      "ba",
    );
    await step(
      repo,
      {
        action: "set-service",
        service: {
          id: "svc",
          name: "Service",
          kind: "module",
          localPath: service,
          responsibilities: ["scrub"],
          requirementIds: ["REQ-QEV-101"],
          dependsOn: [],
          status: "in_progress",
        },
      },
      "architect",
    );

    const verified = await step(repo, { action: "verify-stories", independentRerun: true }, "quality");
    expect((verified.data.result as { verdict: string }).verdict).toBe("PASS_WITH_RISKS");

    const checked = await preview(repo, { action: "quality-check", requirementId: "REQ-QEV-101", testsGreen: true }, "quality");
    const result = (checked.data as { result: { verdict: string; evidenceStatus: string; finding: unknown } }).result;
    // Before the fix: verdict came with finding F-REQ-QEV-101-evidence ("no independent behavioral evidence").
    expect(result.evidenceStatus).toBe("executed");
    expect(result.finding).toBeNull();
    expect(result.verdict).toBe("PASS_WITH_RISKS");

    const state = readPersistedState<{
      verdicts: Array<{ scope: string; scopeId: string; verdict: string; evidenceRefs: string[] }>;
      coverage: Array<{ scenarioId: string; storyRevision?: number }>;
    }>(repo);
    const requirementVerdict = state.verdicts.find((v) => v.scope === "requirement" && v.scopeId === "REQ-QEV-101");
    expect(requirementVerdict?.verdict).toBe("PASS_WITH_RISKS");
    expect(requirementVerdict?.evidenceRefs).toEqual(
      expect.arrayContaining(["story-unconfirmed:US-QEV-001@1", "story:US-QEV-001@1", "US-QEV-001-S1:PASS"]),
    );
    expect(state.coverage.find((c) => c.scenarioId === "US-QEV-001-S1")?.storyRevision).toBe(1);
  });
});
