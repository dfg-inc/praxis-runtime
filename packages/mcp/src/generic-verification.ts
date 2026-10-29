import { tmpdir } from "node:os";
import { containedPath } from "./path-guard.js";
import { runIsolated, scrubbedEnv } from "./project-code-runner.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectProfile, ServiceLocation } from "./project-profile.js";
import { runBrowserChecks, validateBrowserConfig, validateBrowserSteps, type BrowserConfig, type BrowserRun, type BrowserStep } from "./browser-verification.js";

export type Scenario = {
  /** Absent when a requirement is verified directly, without a Story. */
  storyId?: string;
  requirementId: string;
  acceptanceCriterionId: string;
  scenarioId: string;
  kind: "happy" | "alternative" | "negative" | "edge" | "contract" | "security";
  serviceId: string;
  repository: string;
  implementationPath: string;
  testRef: string;
  evidence: string[];
  findingId?: string;
  status: "PASS" | "FAIL" | "PASS_WITH_RISKS" | "BLOCKED" | "NOT_VERIFIED";
  critical: boolean;
};

export type Finding = {
  id: string;
  requirementIds: string[];
  serviceIds: string[];
  owner: "developer";
  summary: string;
  evidence: string[];
  status: "open" | "resolved";
  severity: "critical" | "high" | "medium" | "low";
  storyIds: string[];
  acceptanceCriterionIds: string[];
  repository: string;
  file: string;
  expected: string;
  observed: string;
  reproduction: string[];
  suggestion: string;
};

type Story = {
  id: string;
  requirementIds: string[];
  serviceIds: string[];
  acceptanceCriteria: Array<{ id: string; then: string }>;
  happyPath: string[];
  status?: string;
};

type CheckStep = { function: string; args?: unknown[] };

type Check = {
  scenarioId: string;
  storyId?: string;
  requirementId?: string;
  acceptanceCriterionId?: string;
  kind?: Scenario["kind"];
  serviceId: string;
  level?: string;
  module?: string;
  steps?: CheckStep[] | BrowserStep[];
  call?: CheckStep;
  expect: unknown;
  critical?: boolean;
};

export type BrowserEvidence = {
  runner: string;
  browserVersion: string;
  subjectDigest: string;
  startedAt: string;
  finishedAt: string;
  /** scenarioId -> the screenshot recorded for it (path relative to the artifacts directory) */
  artifacts: Record<string, { path?: string; sha256: string; bytes: number }>;
  scenarioIds: string[];
};

export type VerificationRun = {
  scenarios: Scenario[];
  findings: Finding[];
  browser?: BrowserEvidence[];
  evidenceLevel: "unit" | "static" | "service-integration" | "api" | "contract" | "browser";
  limitations: string[];
  plan: Array<{ scenarioId: string; level: string; serviceId: string; status: string }>;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeFile(root: string, relative: string): string {
  return containedPath(root, relative);
}

const PYTHON = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("praxis_target", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
result = None
for step in json.loads(sys.argv[2]):
    result = getattr(mod, step["function"])(*step.get("args", []))
print(json.dumps(result))
`;

async function runSteps(root: string, modulePath: string, steps: CheckStep[]): Promise<unknown> {
  const file = safeFile(root, modulePath);
  if (!existsSync(file)) throw new Error(`MODULE_MISSING:${modulePath}`);
  if (file.endsWith(".py")) {
    const result = spawnSync("python3", ["-c", PYTHON, file, JSON.stringify(steps)], {
      cwd: root,
      encoding: "utf8",
      env: scrubbedEnv(tmpdir()),
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error((result.stderr || result.stdout || "python check failed").trim());
    }
    return JSON.parse(result.stdout.trim());
  }
  return runIsolated({ file, cwd: root, op: "steps", steps });
}

/** Checks scoped to one work item win over the repository-wide checks. */
/** Checks scoped to one work item win over the repository-wide checks. */
function readChecks(workflowRepo: string, workItemId?: string): { checks: Check[]; browser?: BrowserConfig } | undefined {
  const scoped = workItemId ? join(workflowRepo, ".praxis", "quality", workItemId, "checks.json") : undefined;
  const file = scoped && existsSync(scoped) ? scoped : join(workflowRepo, ".praxis", "quality", "checks.json");
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { checks?: Check[]; browser?: unknown };
  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) throw new Error("CHECKS_INVALID");
  const browser = parsed.browser === undefined ? undefined : validateBrowserConfig(parsed.browser);
  // a malformed browser check is refused before anything runs, even when no browser is available
  for (const check of parsed.checks) if ((check.level === "browser" || check.level === "e2e") && check.steps !== undefined) validateBrowserSteps(check.scenarioId, check.steps);
  return { checks: parsed.checks, ...(browser ? { browser } : {}) };
}

export async function runProjectChecks(input: {
  workflowRepo: string;
  workItemId?: string;
  stories: Story[];
  services: ServiceLocation[];
  profiles: ProjectProfile[];
  /** Screenshots are written here when set (apply); a preview leaves it out and writes nothing. */
  artifactsDir?: string;
}): Promise<VerificationRun | undefined> {
  const read = readChecks(input.workflowRepo, input.workItemId);
  if (!read) return undefined;
  const checks = read.checks;
  const browserConfig = read.browser;
  const browserQueue: Array<{ check: Check; base: Omit<Scenario, "status" | "evidence">; root: string }> = [];
  const story = input.stories.find((item) => item.status !== "superseded") ?? input.stories[0];
  const services = new Map(input.services.map((service) => [service.id, service]));
  const scenarios: Scenario[] = [];
  const findings: Finding[] = [];
  const covered = new Set<string>();
  let sawIntegration = false;
  let sawApi = false;
  let sawContract = false;
  for (const check of checks) {
    const service = services.get(check.serviceId);
    const profile = input.profiles.find((item) => item.serviceId === check.serviceId);
    // a check belongs to the Story that states its criterion (or names it); only then to the first Story, as before
    const owner =
      (check.storyId ? input.stories.find((item) => item.id === check.storyId && item.status !== "superseded") : undefined) ??
      (check.acceptanceCriterionId ? input.stories.find((item) => item.status !== "superseded" && item.acceptanceCriteria.some((c) => c.id === check.acceptanceCriterionId)) : undefined) ??
      (check.requirementId ? input.stories.find((item) => item.status !== "superseded" && item.requirementIds.includes(check.requirementId as string)) : undefined) ??
      story;
    const requirementId = check.requirementId ?? owner?.requirementIds[0];
    if (!requirementId) {
      throw new Error(`CHECKS_INVALID: check ${check.scenarioId} names no requirementId and there is no Story to take one from`);
    }
    // Without a Story, a check must say which acceptance criterion it proves; guessing one would
    // claim coverage the check does not give.
    const criterionId = check.acceptanceCriterionId ?? owner?.acceptanceCriteria[0]?.id ?? owner?.id;
    if (!criterionId) {
      throw new Error(`CHECKS_INVALID: check ${check.scenarioId} must name acceptanceCriterionId when no Story exists`);
    }
    const scenarioId = check.scenarioId;
    const kind = check.kind ?? "happy";
    const level = check.level ?? "unit";
    covered.add(check.serviceId);
    const base = {
      ...((check.storyId ?? owner?.id) ? { storyId: (check.storyId ?? owner?.id) as string } : {}),
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId,
      kind,
      serviceId: check.serviceId,
      repository: service?.repository ?? profile?.repository ?? check.serviceId,
      implementationPath: check.module ?? "",
      testRef: check.module ?? "",
      critical: check.critical ?? (kind === "happy" || kind === "security" || kind === "contract"),
    };
    if (!service?.localPath) {
      scenarios.push({
        ...base,
        status: "BLOCKED",
        evidence: [`level:${level}`, "repository location is missing"],
      });
      findings.push(findingFor(base, "BLOCKED", "repository location is missing", check.expect));
      continue;
    }
    if (level === "browser" || level === "e2e") {
      const runner = profile?.testRunners.find((item) => item === "playwright" || item === "cypress");
      const blockWith = (reason: string, why: string) => {
        scenarios.push({ ...base, status: "BLOCKED", critical: true, evidence: [`level:${level}`, reason, "deployed end-to-end coverage was not claimed"] });
        findings.push(findingFor(base, "BLOCKED", why, check.expect));
      };
      if (!browserConfig || !Array.isArray(check.steps) || check.steps.length === 0) {
        blockWith(
          browserConfig ? "this browser check has no steps" : runner ? `${runner} is installed but checks.json has no "browser" section to serve the built app` : "no browser configuration: add \"browser\": {\"serve\": {\"root\": \"dist\"}} and steps to the check",
          "browser or deployed end-to-end execution is not configured",
        );
        continue;
      }
      browserQueue.push({ check, base, root: service.localPath });
      continue;
    }
    const steps = (check.steps ?? (check.call ? [check.call] : [])) as CheckStep[];
    if (level === "service-integration") sawIntegration = true;
    if (level === "api") sawApi = true;
    if (level === "contract") sawContract = true;
    try {
      const actual = await runSteps(service.localPath, check.module ?? "", steps);
      const ok = sameJson(actual, check.expect);
      scenarios.push({
        ...base,
        status: ok ? "PASS" : "FAIL",
        evidence: [`level:${level}`, `expected:${JSON.stringify(check.expect)}`, `observed:${JSON.stringify(actual)}`],
      });
      if (!ok) findings.push(findingFor(base, "FAIL", JSON.stringify(actual), check.expect));
    } catch (err) {
      const observed = err instanceof Error ? err.message : String(err);
      scenarios.push({
        ...base,
        status: "FAIL",
        evidence: [`level:${level}`, `expected:${JSON.stringify(check.expect)}`, `observed:${observed}`],
      });
      findings.push(findingFor(base, "FAIL", observed, check.expect));
    }
  }
  const browserEvidence: BrowserEvidence[] = [];
  const byRoot = new Map<string, typeof browserQueue>();
  for (const item of browserQueue) byRoot.set(item.root, [...(byRoot.get(item.root) ?? []), item]);
  for (const [root, queue] of byRoot) {
    const run: BrowserRun = await runBrowserChecks({
      serviceRoot: root,
      config: browserConfig as BrowserConfig,
      checks: queue.map((q) => ({ scenarioId: q.check.scenarioId, steps: q.check.steps as BrowserStep[] })),
      playwrightDirs: [root, input.workflowRepo],
      ...(input.artifactsDir ? { artifactsDir: input.artifactsDir } : {}),
    });
    if (!run.available) {
      for (const q of queue) {
        scenarios.push({ ...q.base, status: "BLOCKED", critical: true, evidence: [`level:${q.check.level}`, `browser run unavailable: ${run.reason}`, "deployed end-to-end coverage was not claimed"] });
        findings.push(findingFor(q.base, "BLOCKED", run.reason, q.check.expect));
      }
      continue;
    }
    const artifacts: BrowserEvidence["artifacts"] = {};
    for (const q of queue) {
      const r = run.results[q.check.scenarioId];
      if (!r) {
        scenarios.push({ ...q.base, status: "BLOCKED", critical: true, evidence: [`level:${q.check.level}`, "the browser driver returned no result for this check"] });
        continue;
      }
      if (r.screenshot) artifacts[q.check.scenarioId] = r.screenshot;
      const lines = [
        `level:${q.check.level}`,
        `runner:${run.runner}`,
        `steps:${r.steps}`,
        `final-url:${r.finalUrl}`,
        `bundle:${run.subjectDigest.slice(0, 16)}`,
        ...(r.consoleErrors ? [`console-errors:${r.consoleErrors}`] : []),
        ...(r.failed ? [`failed-step:${r.failed.index}:${r.failed.kind}`, `observed:${r.failed.message}`] : []),
        "local bundle in a real browser; deployed end-to-end coverage was not claimed",
      ];
      scenarios.push({ ...q.base, status: r.ok ? "PASS" : "FAIL", evidence: lines });
      if (!r.ok) findings.push(findingFor(q.base, "FAIL", r.failed?.message ?? "failed", q.check.steps));
    }
    browserEvidence.push({ runner: run.runner, browserVersion: run.browserVersion, subjectDigest: run.subjectDigest, startedAt: run.startedAt, finishedAt: run.finishedAt, artifacts, scenarioIds: queue.map((q) => q.check.scenarioId) });
  }
  for (const item of input.stories.filter((x) => x.status !== "superseded")) {
    for (const serviceId of item.serviceIds) {
      if (covered.has(serviceId)) continue;
      const service = services.get(serviceId);
      const blocked = !service?.localPath;
      const scenarioId = `${item.id}-${blocked ? "BLOCKED" : "UNVERIFIED"}-${serviceId.toUpperCase()}`;
      const entry: Scenario = {
        storyId: item.id,
        requirementId: item.requirementIds[0]!,
        acceptanceCriterionId: item.acceptanceCriteria[0]?.id ?? item.id,
        scenarioId,
        kind: "happy",
        serviceId,
        repository: service?.repository ?? serviceId,
        implementationPath: "",
        testRef: "",
        status: blocked ? "BLOCKED" : "NOT_VERIFIED",
        critical: true,
        evidence: [
          blocked ? "mandatory service has no repository location" : "no executable check is bound to this mandatory service",
          "deployed end-to-end coverage was not claimed",
        ],
      };
      scenarios.push(entry);
      findings.push(findingFor(entry, entry.status, blocked ? "repository location is missing" : "behavior was not executed", item.acceptanceCriteria[0]?.then ?? item.happyPath[0] ?? "the user story outcome"));
    }
  }
  return {
    scenarios,
    findings,
    ...(browserEvidence.length ? { browser: browserEvidence } : {}),
    evidenceLevel: browserEvidence.length ? "browser" : sawIntegration ? "service-integration" : sawApi ? "api" : sawContract ? "contract" : "unit",
    limitations: [
      "Executable checks ran in the local project. This is not deployed end-to-end coverage.",
      "A passing check is evidence for that check only. Green unit tests are recorded separately and are not a verdict.",
    ],
    plan: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      level: scenario.evidence.find((item) => item.startsWith("level:"))?.slice(6) ?? "unit",
      serviceId: scenario.serviceId,
      status: scenario.status,
    })),
  };
}

function findingFor(
  scenario: Omit<Scenario, "evidence" | "status" | "testRef"> & { status?: Scenario["status"] },
  status: Scenario["status"],
  observed: string,
  expected: unknown,
): Finding {
  return {
    id: `F-${scenario.scenarioId}`,
    requirementIds: [scenario.requirementId],
    serviceIds: [scenario.serviceId],
    owner: "developer",
    summary: `${scenario.scenarioId} ${status}`,
    evidence: [`observed:${observed}`],
    status: "open",
    severity: scenario.critical === false ? "medium" : "high",
    storyIds: scenario.storyId ? [scenario.storyId] : [],
    acceptanceCriterionIds: [scenario.acceptanceCriterionId],
    repository: scenario.repository,
    file: scenario.implementationPath,
    expected: typeof expected === "string" ? expected : JSON.stringify(expected),
    observed,
    reproduction: [`Execute ${scenario.implementationPath || scenario.serviceId} for ${scenario.scenarioId}.`],
    suggestion: `host-patch:${scenario.serviceId}`,
  };
}

export function inspectionPlan(input: {
  stories: Story[];
  services: ServiceLocation[];
  profiles: ProjectProfile[];
}): VerificationRun {
  const story = input.stories.find((item) => item.status !== "superseded") ?? input.stories[0];
  if (!story) throw new Error("STORY_MISSING");
  const services = new Map(input.services.map((service) => [service.id, service]));
  const scenarios: Scenario[] = [];
  const findings: Finding[] = [];
  const required = story.serviceIds.length ? story.serviceIds : input.services.map((service) => service.id);
  for (const serviceId of required) {
    const service = services.get(serviceId);
    const profile = input.profiles.find((item) => item.serviceId === serviceId);
    const blocked = !service?.localPath && !service?.remoteUrl;
    const scenario: Scenario = {
      storyId: story.id,
      requirementId: story.requirementIds[0]!,
      acceptanceCriterionId: story.acceptanceCriteria[0]?.id ?? story.id,
      scenarioId: `${story.id}-HAPPY-${serviceId.toUpperCase()}`,
      kind: "happy",
      serviceId,
      repository: service?.repository ?? serviceId,
      implementationPath: profile?.sourceFiles[0] ?? "",
      testRef: profile?.testRunners.join(",") ?? "",
      status: blocked ? "BLOCKED" : "NOT_VERIFIED",
      critical: true,
      evidence: blocked
        ? ["repository location is missing", "level:static"]
        : [
            "level:static",
            `languages:${profile?.languages.join(",") || "unknown"}`,
            `frameworks:${profile?.frameworks.join(",") || "none detected"}`,
            `tests:${profile?.testRunners.join(",") || "none detected"}`,
            "static review cannot prove the user story",
            "deployed end-to-end coverage was not claimed",
          ],
    };
    scenarios.push(scenario);
    findings.push(
      findingFor(
        scenario,
        scenario.status,
        blocked ? "repository location is missing" : "behavior was not executed",
        story.acceptanceCriteria[0]?.then ?? story.happyPath[0] ?? "the user story outcome",
      ),
    );
  }
  return {
    scenarios,
    findings,
    evidenceLevel: "static",
    limitations: [
      "HOST_EDIT_UNAVAILABLE: no project checks or coding-agent patch were provided.",
      "Quality inspected the repository and did not apply a fix.",
      "Add .praxis/quality/checks.json or a proposals/<serviceId>.json patch, then verify again.",
    ],
    plan: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      level: "static",
      serviceId: scenario.serviceId,
      status: scenario.status,
    })),
  };
}
