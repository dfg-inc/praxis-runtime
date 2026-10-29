import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { containedPath } from "./path-guard.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ApprovalError, effectiveServices, type EvidenceSource, obtainUserApproval, rollupStoryVerdict, runApprovedMutation, type UserApproval } from "@praxis/contracts";
import { tmpdir } from "node:os";
import { runIsolated, scrubbedEnv } from "./project-code-runner.js";
import { inspectionPlan, runProjectChecks, type BrowserEvidence, type Finding, type Scenario } from "./generic-verification.js";
import { inspectService, type ProjectProfile, type ServiceLocation } from "./project-profile.js";
import { loadWorkflow } from "./workflow-store.js";

const PROTECTED = new Set(["main", "master"]);

type ProposalFile = { path: string; after?: string; diff?: string };
type Proposal = { files: ProposalFile[] };

export type VerificationMeta = {
  strategy: "project-adapter" | "executable-checks" | "inspection-only";
  evidenceLevel: "module" | "unit" | "static" | "service-integration" | "api" | "contract" | "browser";
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
  /** This run is complete for what the Runtime executes: its earlier results that were not repeated are retired, evidence from other sources stays. */
  replaceSource: "executed";
  baseCoverageRevision: number;
  meta: VerificationMeta;
  /** Per-scenario provenance for what ran in a browser. Never part of the command an agent can send. */
  evidenceSources: Record<string, EvidenceSource>;
};

function git(repo: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", input });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return result.stdout.trim();
}

function safeFile(root: string, relative: string): string {
  return containedPath(root, relative);
}

/** The project adapter runs in its own process with a scrubbed environment (see project-code-runner.ts); only JSON crosses. */
function adapterFile(workflowRepo: string): string | undefined {
  const file = join(workflowRepo, ".praxis", "quality", "adapter.mjs");
  return existsSync(file) ? file : undefined;
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
          env: scrubbedEnv(tmpdir()),
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
        env: scrubbedEnv(tmpdir()),
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serviceId) || serviceId.includes("..")) throw new Error("UNSAFE_PATH");
  let file: string;
  try {
    file = containedPath(workflowRepo, join(".praxis", "quality", "proposals", `${serviceId}.json`));
  } catch {
    return undefined; // a link that leaves the repository is not a proposal
  }
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Proposal;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error("PROPOSAL_INVALID");
  return parsed;
}

export async function buildStoryVerification(
  repo: string,
  independentRerun: boolean,
  workItemId?: string,
  /** Where screenshots of a browser run are written. Omitted for a preview, which writes nothing. */
  artifactsDir?: string,
): Promise<VerificationCommand> {
  const state = loadWorkflow(repo, workItemId);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const stories = state.stories.filter((item) => item.status !== "superseded");
  const requirements = state.requirements.filter((item) => item.status !== "superseded");
  // A work item with requirements but no Story is verified from checks bound to its acceptance criteria.
  if (!stories.length && !requirements.length) throw new Error("STORY_MISSING");
  const services = effectiveServices(state) as ServiceLocation[];
  const profiles = services.map((service) => inspectService(service));
  const adapter = adapterFile(repo);
  let scenarios: Scenario[] = [];
  let findings: Finding[] = [];
  let strategy: VerificationMeta["strategy"] = "inspection-only";
  let evidenceLevel: VerificationMeta["evidenceLevel"] = "static";
  let limitations: string[] = [];
  let plan: VerificationMeta["plan"] = [];
  let browser: BrowserEvidence[] = [];
  const adapterResult = adapter ? await runIsolated<{ scenarios: Scenario[]; findings: Finding[] } | null>({ file: adapter, cwd: repo, op: "verify", state, independentRerun }) : null;
  if (adapterResult) {
    const verified = adapterResult;
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
    const executed = await runProjectChecks({ workflowRepo: repo, workItemId: state.workItem.id, stories, services, profiles, ...(artifactsDir ? { artifactsDir } : {}) });
    if (!executed && !stories.length) {
      throw new Error(
        "EVIDENCE_MISSING: this work item has requirements but no Story and no executable checks. Add " +
          `.praxis/quality/${state.workItem.id}/checks.json (or .praxis/quality/checks.json) with checks that name a requirementId and an acceptanceCriterionId, then verify again. Nothing was recorded.`,
      );
    }
    const selected = executed ?? inspectionPlan({ stories, services, profiles });
    scenarios = selected.scenarios;
    findings = selected.findings;
    strategy = executed ? "executable-checks" : "inspection-only";
    evidenceLevel = selected.evidenceLevel;
    limitations = selected.limitations;
    browser = (selected as { browser?: BrowserEvidence[] }).browser ?? [];
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
  // Previews never write: the verification summary travels in the tool result and the evidence lives in state.
  return {
    action: "record-verification",
    independentRerun,
    testsGreen: testsAreGreen(services),
    scenarios,
    findings,
    replaceSource: "executed",
    baseCoverageRevision: state.coverageRevision,
    meta,
    // a browser check that could not run (no browser, no serve root) is still browser-level evidence: BLOCKED, not "executed"
    evidenceSources: Object.fromEntries([
      ...scenarios
        .filter((sc) => sc.evidence.some((line) => line === "level:browser" || line === "level:e2e") && !browser.some((run) => run.scenarioIds.includes(sc.scenarioId)))
        .map((sc): [string, EvidenceSource] => [sc.scenarioId, { kind: "browser", runner: "praxis-runtime:browser-driver (not run)", runId: `run-${randomUUID()}`, artifacts: [] }]),
      ...browser.flatMap((run) =>
        run.scenarioIds.map((id): [string, EvidenceSource] => {
          const shot = run.artifacts[id];
          return [
            id,
            {
              kind: "browser",
              runner: `${run.runner}@${run.browserVersion}`,
              runId: `run-${randomUUID()}`,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              subjectDigest: run.subjectDigest,
              artifacts: shot ? [{ path: shot.path && artifactsDir ? relativePath(repo, join(artifactsDir, shot.path)).split(sep).join("/") : `(not stored in a preview) ${id}.png`, sha256: shot.sha256, bytes: shot.bytes }] : [],
            },
          ];
        }),
      ),
    ]),
  };
}

export async function planServiceFix(repo: string, serviceId: string, existingBranch?: string, workItemId?: string): Promise<{
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
  const state = loadWorkflow(repo, workItemId);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const service = state.services.find((item) => item.id === serviceId);
  if (!service?.localPath) throw new Error(`REPOSITORY_LOCATION_MISSING:${serviceId}`);
  const branch = existingBranch ?? `quality/${serviceId}-story-fix`;
  if (PROTECTED.has(branch)) throw new Error("PROTECTED_BRANCH");
  const hostProposal = readHostProposal(repo, serviceId);
  const adapter = hostProposal ? undefined : adapterFile(repo);
  const proposal = hostProposal ?? (adapter ? await runIsolated<Proposal | null>({ file: adapter, cwd: repo, op: "propose", serviceId }) : null);
  if (!proposal) {
    throw new Error(
      "HOST_EDIT_UNAVAILABLE: no coding-agent patch is available. Write .praxis/quality/proposals/" +
        `${serviceId}.json and authorize prepare-fix. No files were changed.`,
    );
  }
  for (const file of proposal.files) {
    safeFile(service.localPath, file.path);
    assertDiffTouchesOnly(service.localPath, file);
  }
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

/**
 * Every path `git apply` would touch for this diff, as git itself reads it (it strips the leading component, handles renames,
 * copies, creations, deletions, quoted names and hunk lines that look like headers). Our own parser would disagree with git.
 */
export function diffPaths(diff: string, root: string): string[] {
  const out = spawnSync("git", ["apply", "--numstat", "-z"], { cwd: root, input: diff, encoding: "utf8" });
  if ((out.status ?? 1) !== 0) throw new Error(`PROPOSAL_INVALID: git cannot read the diff (${(out.stderr || "").trim().slice(0, 160)})`);
  const tokens = out.stdout.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const m = tokens[i].match(/^(\S+)\t(\S+)\t(.*)$/s);
    if (!m) continue;
    if (m[3] === "") {
      // a rename or copy: the old and the new name follow
      paths.add(tokens[i + 1] ?? "");
      paths.add(tokens[i + 2] ?? "");
      i += 2;
    } else {
      paths.add(m[3]);
    }
  }
  paths.delete("");
  return [...paths];
}

/**
 * A diff may only touch the file it was proposed for (and that file must stay inside the checkout): the approval lists exactly
 * that file. `git apply --numstat` prints paths relative to the top of the git repository (the service root can be a
 * subdirectory of it, and git then prefixes header-less names), so they are resolved from there and compared, lexically, with
 * the approved file; a touched path that is itself a link, or that reaches the approved file through a link, does not count.
 */
export function assertDiffTouchesOnly(root: string, file: { path: string; diff?: string }): void {
  if (!file.diff) return;
  const allowedReal = containedPath(root, file.path);
  const realRoot = realpathSync(resolve(root));
  const allowedLexical = resolve(realRoot, file.path);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  const topLevel = (top.status ?? 1) === 0 && top.stdout.trim() ? realpathSync(top.stdout.trim()) : realRoot;
  const touched = diffPaths(file.diff, root);
  if (touched.length === 0) throw new Error(`PROPOSAL_INVALID: the diff for ${file.path} changes nothing`);
  for (const path of touched) {
    const absolute = resolve(topLevel, path);
    const relative = relativePath(realRoot, absolute);
    if (relative === "" || relative.startsWith("..") || isAbsolute(relative)) throw new Error(`PROPOSAL_INVALID: the diff for ${file.path} also changes ${path}, outside the checkout`);
    let real: string;
    try {
      real = containedPath(root, relative);
    } catch {
      throw new Error(`PROPOSAL_INVALID: the diff for ${file.path} also changes ${path}, outside the checkout`);
    }
    if (absolute !== allowedLexical || real !== allowedReal) throw new Error(`PROPOSAL_INVALID: the diff for ${file.path} also changes ${path}`);
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error(`PROPOSAL_INVALID: the diff for ${file.path} changes ${path}, which is a link`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PROPOSAL_INVALID")) throw error;
    }
  }
}

function applyProposal(root: string, proposal: Proposal): void {
  for (const file of proposal.files) {
    const absolute = safeFile(root, file.path);
    assertDiffTouchesOnly(root, file);
    if (file.diff) {
      git(root, ["apply", "--whitespace=nowarn"], file.diff);
      continue;
    }
    if (typeof file.after !== "string") throw new Error("PROPOSAL_INVALID");
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.after);
  }
}

/**
 * Applies a Quality fix patch on its own branch and, when the service has a remote, pushes that branch. The user
 * approves the commit and, separately, the push (a commit approval is not a push approval); the first Reject stops
 * everything after it. Throws APPROVAL_REJECTED / APPROVAL_REQUIRED before anything is changed.
 */
export async function commitServiceFix(
  workflowRepo: string,
  planned: Awaited<ReturnType<typeof planServiceFix>>,
  workflowItemId?: string,
  confirmation?: string,
): Promise<Awaited<ReturnType<typeof planServiceFix>>> {
  const change = planned.change;
  if (change.commitSha !== "PLANNED") return planned;
  const state = loadWorkflow(workflowRepo, workflowItemId);
  const service = state?.services.find((item) => item.id === change.serviceId);
  const root = service?.localPath;
  if (!root) throw new Error("REPOSITORY_LOCATION_MISSING");
  const repository = resolve(root);
  const workItemId = change.storyIds[0] ?? change.serviceId;
  const subject = JSON.stringify({ serviceId: change.serviceId, findingId: change.findingId, branch: change.branch, baseSha: change.baseSha, files: change.files, remote: change.remote ?? null });
  const commitApproval = await obtainUserApproval(
    {
      action: "praxis_quality_service_fix",
      kind: "git_operation",
      summary: `Commit a Quality fix for ${change.findingId} on branch ${change.branch}`,
      description: [
        `Repository: ${repository}`,
        `Work item: ${workItemId}`,
        `Branch: ${change.branch} (from ${change.baseSha})`,
        `Files: ${change.files.join(", ")}`,
        change.remote ? `The branch is pushed to ${change.remote} afterwards, with its own approval.` : "No push.",
      ].join("\n"),
      subject,
    },
    { confirmation, repo: workflowRepo },
  );
  // Both approvals are obtained BEFORE anything runs (a round-trip client asks, then re-runs the whole call).
  let pushApproval: UserApproval | undefined;
  if (change.remote) {
    try {
      pushApproval = await obtainUserApproval(
        {
          action: "praxis_developer_git_publish",
          kind: "git_operation",
          summary: `Push branch ${change.branch} to ${change.remote}`,
          description: [`Repository: ${repository}`, `Branch: ${change.branch}`, `Remote: ${change.remote}`, "The commit made by the Quality fix above is what is pushed."].join("\n"),
          subject: JSON.stringify({ branch: change.branch, remote: change.remote, baseSha: change.baseSha, files: change.files, findingId: change.findingId }),
        },
        { confirmation, repo: workflowRepo },
      );
    } catch (error) {
      // a refused push leaves the approved commit local: the record says the push did not happen instead of pretending it did
      if (!(error instanceof ApprovalError)) throw error;
    }
  }
  const committed = runApprovedMutation(commitApproval, () => commitServiceFixBody(root, planned));
  if (!change.remote) return committed;
  if (!pushApproval) return { ...committed, change: { ...committed.change, mrStatus: "blocked" } };
  return runApprovedMutation(pushApproval, () => pushServiceFix(root, committed));
}

function commitServiceFixBody(
  root: string,
  planned: Awaited<ReturnType<typeof planServiceFix>>,
): Awaited<ReturnType<typeof planServiceFix>> {
  const change = planned.change;
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
  const mrStatus: "opened" | "blocked" | "not_requested" = change.remote ? "blocked" : "not_requested";
  return {
    ...planned,
    change: {
      ...change,
      commitSha,
      mrStatus,
    },
  };
}

/** Pushes the fix branch to the service's remote; only after the user's approval of this push. */
function pushServiceFix(
  root: string,
  committed: Awaited<ReturnType<typeof planServiceFix>>,
): Awaited<ReturnType<typeof planServiceFix>> {
  const change = committed.change;
  let mrStatus: "opened" | "blocked" | "not_requested" = "opened";
  let changeRequest: string | undefined;
  const remotes = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8" }).stdout ?? "";
  if (!remotes.split(/\s+/).includes("origin")) git(root, ["remote", "add", "origin", change.remote as string]);
  const pushed = spawnSync("git", ["push", "origin", `HEAD:refs/heads/${change.branch}`], {
    cwd: root,
    encoding: "utf8",
  });
  if ((pushed.status ?? 1) !== 0) mrStatus = "blocked";
  else changeRequest = `mr:${change.branch}`;
  return {
    ...committed,
    change: {
      ...change,
      mrStatus,
      ...(changeRequest ? { changeRequest } : {}),
    },
  };
}
