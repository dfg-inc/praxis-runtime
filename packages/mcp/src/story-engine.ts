import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { rollupStoryVerdict } from "@praxis/contracts";
import { inspectionPlan, runProjectChecks, type Finding, type Scenario } from "./generic-verification.js";
import { inspectService, type ProjectProfile, type ServiceLocation } from "./project-profile.js";
import { loadWorkflow } from "./workflow-store.js";

const PROTECTED = new Set(["main", "master"]);

type ProposalFile = { path: string; after?: string; diff?: string };
type Proposal = { files: ProposalFile[] };

export type VerificationMeta = {
  strategy: "project-adapter" | "executable-checks" | "inspection-only";
  evidenceLevel: "module" | "unit" | "static" | "service-integration" | "api" | "contract";
  deployedEndToEnd: false;
  limitations: string[];
  profiles: ProjectProfile[];
  serviceVerdicts: Array<{ serviceId: string; verdict: string; reasons: string[] }>;
  plan: Array<{ scenarioId: string; level: string; serviceId: string; status: string }>;
  hostActions: string[];
};

type VerificationCommand = {
  action: "record-verification";
  independentRerun: boolean;
  testsGreen: boolean;
  scenarios: Scenario[];
  findings: Finding[];
  meta: VerificationMeta;
};

function git(repo: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", input });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return result.stdout.trim();
}

function safeFile(root: string, relative: string): string {
  if (!relative || relative.startsWith("/") || relative.includes("\0") || relative.split(/[/\\]/).includes("..")) {
    throw new Error("UNSAFE_PATH");
  }
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("UNSAFE_PATH");
  return absolute;
}

async function loadAdapter(workflowRepo: string): Promise<{
  verify?: (ctx: unknown) => Promise<{ scenarios: Scenario[]; findings: Finding[] }>;
  propose?: (serviceId: string) => Proposal | null;
} | undefined> {
  const file = join(workflowRepo, ".praxis", "quality", "adapter.mjs");
  if (!existsSync(file)) return undefined;
  return import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`) as Promise<{
    verify?: (ctx: unknown) => Promise<{ scenarios: Scenario[]; findings: Finding[] }>;
    propose?: (serviceId: string) => Proposal | null;
  }>;
}

async function loadModule(service: ServiceLocation, relative: string) {
  if (!service.localPath) {
    return { missingLocation: true, repository: service.repository, file: relative };
  }
  const file = safeFile(service.localPath, relative);
  if (!existsSync(file)) return { missingModule: true, repository: service.repository, file };
  const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`)) as Record<
    string,
    unknown
  >;
  return { mod, repository: service.repository, file };
}

function testsAreGreen(services: ServiceLocation[]): boolean {
  let saw = false;
  for (const service of services) {
    if (!service.localPath || !existsSync(service.localPath)) continue;
    const src = join(service.localPath, "src");
    if (existsSync(src)) {
      const tests = readdirSync(src).filter((name) => /\.test\.(js|mjs|cjs)$/.test(name));
      if (tests.length) {
        saw = true;
        const result = spawnSync(process.execPath, ["--test", ...tests.map((name) => join("src", name))], {
          cwd: service.localPath,
          encoding: "utf8",
        });
        if ((result.status ?? 1) !== 0) return false;
      }
    }
    const testsDir = join(service.localPath, "tests");
    const pytests = existsSync(testsDir)
      ? readdirSync(testsDir).filter((name) => name.startsWith("test_") && name.endsWith(".py"))
      : [];
    if (pytests.length) {
      saw = true;
      const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], {
        cwd: service.localPath,
        encoding: "utf8",
      });
      if ((result.status ?? 1) !== 0) return false;
    }
  }
  return saw;
}

function serviceVerdicts(scenarios: Scenario[]): VerificationMeta["serviceVerdicts"] {
  const grouped = new Map<string, Scenario[]>();
  for (const scenario of scenarios) {
    const entries = grouped.get(scenario.serviceId) ?? [];
    entries.push(scenario);
    grouped.set(scenario.serviceId, entries);
  }
  return [...grouped].map(([serviceId, entries]) => {
    const rolled = rollupStoryVerdict(entries);
    return { serviceId, verdict: rolled.verdict, reasons: rolled.reasons };
  });
}

function readHostProposal(workflowRepo: string, serviceId: string): Proposal | undefined {
  const file = join(workflowRepo, ".praxis", "quality", "proposals", `${serviceId}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Proposal;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error("PROPOSAL_INVALID");
  return parsed;
}

export async function buildStoryVerification(repo: string, independentRerun: boolean): Promise<VerificationCommand> {
  const state = loadWorkflow(repo);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const stories = state.stories.filter((item) => item.status !== "superseded");
  if (!stories.length) throw new Error("STORY_MISSING");
  const services = state.services as ServiceLocation[];
  const profiles = services.map((service) => inspectService(service));
  const adapter = await loadAdapter(repo);
  let scenarios: Scenario[] = [];
  let findings: Finding[] = [];
  let strategy: VerificationMeta["strategy"] = "inspection-only";
  let evidenceLevel: VerificationMeta["evidenceLevel"] = "static";
  let limitations: string[] = [];
  let plan: VerificationMeta["plan"] = [];
  if (adapter?.verify) {
    const verified = await adapter.verify({ state, independentRerun, loadModule });
    scenarios = verified.scenarios;
    findings = verified.findings;
    strategy = "project-adapter";
    evidenceLevel = "module";
    limitations = [
      "A project adapter executed local modules. This is not deployed end-to-end coverage.",
      "The adapter is project-supplied. Praxis Runtime does not contain a product-specific fix.",
    ];
    plan = scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      level: "module",
      serviceId: scenario.serviceId,
      status: scenario.status,
    }));
  } else {
    const executed = await runProjectChecks({ workflowRepo: repo, stories, services, profiles });
    const selected = executed ?? inspectionPlan({ stories, services, profiles });
    scenarios = selected.scenarios;
    findings = selected.findings;
    strategy = executed ? "executable-checks" : "inspection-only";
    evidenceLevel = selected.evidenceLevel;
    limitations = selected.limitations;
    plan = selected.plan;
  }
  if (independentRerun) {
    const failing = new Set(findings.filter((item) => item.status === "open").map((item) => item.id));
    for (const previous of state.findings) {
      if (!failing.has(previous.id) && previous.status === "open") {
        findings.push({ ...(previous as Finding), status: "resolved" });
      }
    }
  }
  const open = findings.filter((item) => item.status === "open");
  const meta: VerificationMeta = {
    strategy,
    evidenceLevel,
    deployedEndToEnd: false,
    limitations,
    profiles,
    serviceVerdicts: serviceVerdicts(scenarios),
    plan,
    hostActions: open.length
      ? [
          "Review the finding expected and observed values.",
          "Use the coding agent to write .praxis/quality/proposals/<serviceId>.json with files[].after or files[].diff.",
          "Call prepare-fix only after authorization. Do not merge and do not push to main or master.",
          "Run verify-stories again with independentRerun true. The patch itself is not a verdict.",
        ]
      : [],
  };
  mkdirSync(join(repo, ".praxis", "workflow"), { recursive: true });
  writeFileSync(
    join(repo, ".praxis", "workflow", "last-verification.json"),
    JSON.stringify({ ...meta, testsGreen: testsAreGreen(services) }, null, 2),
  );
  return {
    action: "record-verification",
    independentRerun,
    testsGreen: testsAreGreen(services),
    scenarios,
    findings,
    meta,
  };
}

export async function planServiceFix(repo: string, serviceId: string, existingBranch?: string): Promise<{
  action: "record-change";
  proposal: Proposal;
  change: {
    id: string;
    findingId: string;
    storyIds: string[];
    requirementIds: string[];
    serviceId: string;
    repository: string;
    branch: string;
    baseSha: string;
    commitSha: string;
    files: string[];
    remote?: string;
    changeRequest?: string;
    mrStatus: "opened" | "blocked" | "not_requested";
    authorRole: "quality";
  };
}> {
  const state = loadWorkflow(repo);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const service = state.services.find((item) => item.id === serviceId);
  if (!service?.localPath) throw new Error(`REPOSITORY_LOCATION_MISSING:${serviceId}`);
  const branch = existingBranch ?? `quality/${serviceId}-story-fix`;
  if (PROTECTED.has(branch)) throw new Error("PROTECTED_BRANCH");
  const hostProposal = readHostProposal(repo, serviceId);
  const adapter = hostProposal ? undefined : await loadAdapter(repo);
  const proposal = hostProposal ?? adapter?.propose?.(serviceId) ?? null;
  if (!proposal) {
    throw new Error(
      "HOST_EDIT_UNAVAILABLE: no coding-agent patch is available. Write .praxis/quality/proposals/" +
        `${serviceId}.json and authorize prepare-fix. No files were changed.`,
    );
  }
  for (const file of proposal.files) safeFile(service.localPath, file.path);
  const findings = state.findings.filter((item) => item.status === "open" && item.serviceIds.includes(serviceId));
  const branchRef = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: service.localPath, encoding: "utf8" });
  const baseSha = (branchRef.status ?? 1) === 0 ? branchRef.stdout.trim() : git(service.localPath, ["rev-parse", "HEAD"]);
  return {
    action: "record-change",
    proposal,
    change: {
      id: `CHG-${serviceId}`,
      findingId: findings[0]?.id ?? `F-${serviceId}`,
      storyIds: [...new Set(findings.flatMap((item) => item.storyIds ?? []))],
      requirementIds: [...new Set(findings.flatMap((item) => item.requirementIds))],
      serviceId,
      repository: service.repository ?? serviceId,
      branch,
      baseSha,
      commitSha: "PLANNED",
      files: proposal.files.map((file) => file.path),
      ...(service.remoteUrl ? { remote: service.remoteUrl } : {}),
      mrStatus: service.remoteUrl ? "opened" : "not_requested",
      authorRole: "quality",
    },
  };
}

function applyProposal(root: string, proposal: Proposal): void {
  for (const file of proposal.files) {
    const absolute = safeFile(root, file.path);
    if (file.diff) {
      git(root, ["apply", "--whitespace=nowarn"], file.diff);
      continue;
    }
    if (typeof file.after !== "string") throw new Error("PROPOSAL_INVALID");
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.after);
  }
}

export function commitServiceFix(
  workflowRepo: string,
  planned: Awaited<ReturnType<typeof planServiceFix>>,
): Awaited<ReturnType<typeof planServiceFix>> {
  const change = planned.change;
  if (change.commitSha !== "PLANNED") return planned;
  const state = loadWorkflow(workflowRepo);
  const service = state?.services.find((item) => item.id === change.serviceId);
  const root = service?.localPath;
  if (!root) throw new Error("REPOSITORY_LOCATION_MISSING");
  applyProposal(root, planned.proposal);
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== change.branch) {
    const exists = spawnSync("git", ["rev-parse", "--verify", change.branch], { cwd: root, encoding: "utf8" });
    if ((exists.status ?? 1) === 0) git(root, ["checkout", change.branch]);
    else git(root, ["checkout", "-b", change.branch]);
  }
  git(root, ["add", "--", ...change.files]);
  git(root, [
    "-c",
    "user.name=Praxis Quality",
    "-c",
    "user.email=quality@praxis.local",
    "commit",
    "-m",
    `Fix ${change.findingId} for ${change.storyIds.join(", ") || "the user story"}`,
  ]);
  const commitSha = git(root, ["rev-parse", "HEAD"]);
  const ancestor = git(root, ["merge-base", change.baseSha, commitSha]);
  if (ancestor !== change.baseSha) throw new Error("HISTORY_REWRITTEN");
  let mrStatus: "opened" | "blocked" | "not_requested" = change.remote ? "opened" : "not_requested";
  let changeRequest: string | undefined;
  if (change.remote) {
    const remotes = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8" }).stdout ?? "";
    if (!remotes.split(/\s+/).includes("origin")) git(root, ["remote", "add", "origin", change.remote]);
    const pushed = spawnSync("git", ["push", "origin", `HEAD:refs/heads/${change.branch}`], {
      cwd: root,
      encoding: "utf8",
    });
    if ((pushed.status ?? 1) !== 0) mrStatus = "blocked";
    else changeRequest = `mr:${change.branch}`;
  }
  return {
    ...planned,
    change: {
      ...change,
      commitSha,
      mrStatus,
      ...(changeRequest ? { changeRequest } : {}),
    },
  };
}
