import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadWorkflow } from "./workflow-store.js";

const MODULES: Record<string, string> = {
  api: "src/bulk-import-api.mjs",
  identity: "src/identity.mjs",
  worker: "src/import-rows.mjs",
  frontend: "src/import-ui.mjs",
};

const PROTECTED = new Set(["main", "master"]);

type ServiceRef = {
  id: string;
  name?: string;
  localPath?: string;
  remoteUrl?: string;
  repository?: string;
  branch?: string;
};

type Loaded = ServiceRef & {
  mod?: Record<string, unknown>;
  file?: string;
  missingLocation?: boolean;
  missingModule?: boolean;
};

type Scenario = {
  storyId: string;
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

type Finding = {
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

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return result.stdout.trim();
}

async function loadService(service: ServiceRef): Promise<Loaded> {
  const relative = MODULES[service.id];
  if (!relative) return { ...service, missingModule: true };
  if (!service.localPath) return { ...service, missingLocation: true };
  const file = join(service.localPath, relative);
  if (!existsSync(file)) return { ...service, missingModule: true, file };
  const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`)) as Record<
    string,
    unknown
  >;
  return { ...service, mod, file };
}

function fn(mod: Record<string, unknown> | undefined, name: string): ((...args: unknown[]) => unknown) | undefined {
  const value = mod?.[name];
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
}

function scenario(partial: Omit<Scenario, "repository" | "implementationPath" | "testRef" | "evidence" | "critical"> & {
  repository?: string;
  implementationPath?: string;
  evidence: string[];
  critical?: boolean;
}): Scenario {
  return {
    repository: partial.repository ?? "",
    implementationPath: partial.implementationPath ?? "",
    testRef: "",
    critical: partial.critical ?? partial.kind === "happy",
    ...partial,
  };
}

function testsAreGreen(services: ServiceRef[]): boolean {
  let saw = false;
  for (const service of services) {
    if (!service.localPath || !existsSync(join(service.localPath, "src"))) continue;
    const tests = readdirSync(join(service.localPath, "src")).filter((name) => /\.test\.(js|mjs|cjs)$/.test(name));
    if (!tests.length) continue;
    saw = true;
    const result = spawnSync(process.execPath, ["--test", ...tests.map((name) => join("src", name))], {
      cwd: service.localPath,
      encoding: "utf8",
    });
    if ((result.status ?? 1) !== 0) return false;
  }
  return saw;
}

export async function buildStoryVerification(repo: string, independentRerun: boolean): Promise<{
  action: "record-verification";
  independentRerun: boolean;
  testsGreen: boolean;
  scenarios: Scenario[];
  findings: Finding[];
}> {
  const state = loadWorkflow(repo);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const story = state.stories.find((item) => item.status !== "superseded");
  if (!story) throw new Error("STORY_MISSING");
  const storyId = story.id;
  const requirementId = story.requirementIds[0] ?? "REQ-BUI-061";
  const criterionId = story.acceptanceCriteria[0]?.id ?? `${story.id}-AC-01`;
  const services = new Map(state.services.map((service) => [service.id, service as ServiceRef]));
  const loaded = new Map<string, Loaded>();
  for (const id of story.serviceIds) {
    const service = services.get(id) ?? { id };
    loaded.set(id, await loadService(service));
  }
  const api = loaded.get("api");
  const identity = loaded.get("identity");
  const worker = loaded.get("worker");
  const frontend = loaded.get("frontend");
  const scenarios: Scenario[] = [];
  const findings: Finding[] = [];

  function add(entry: Scenario, finding?: Omit<Finding, "id" | "status" | "storyIds" | "requirementIds" | "acceptanceCriterionIds"> & { status?: Finding["status"] }) {
    const findingId = finding ? `F-${entry.scenarioId}` : undefined;
    scenarios.push({ ...entry, findingId });
    if (!finding || entry.status === "PASS") return;
    findings.push({
      id: findingId!,
      requirementIds: [requirementId],
      storyIds: [storyId],
      acceptanceCriterionIds: [criterionId],
      status: finding.status ?? (entry.status === "FAIL" ? "open" : "open"),
      ...finding,
    });
  }

  const actor = { role: "org-admin", org: "O" };
  const csv = "email,name,role\nada@example.com,Ada,member\nbea@example.com,Bea,org-admin\n";
  const preview = fn(api?.mod, "previewCsv");
  const start = fn(api?.mod, "startImport");
  const audit = fn(api?.mod, "audit");
  const rowEvent = fn(api?.mod, "rowEvent");
  const importRows = fn(worker?.mod, "importRows");
  const acceptEvent = fn(worker?.mod, "acceptEvent");
  const render = fn(frontend?.mod, "render");
  const allowedRoles = fn(identity?.mod, "allowedRoles");

  if (!preview || api?.missingLocation || api?.missingModule) {
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-HAPPY-PREVIEW`,
      kind: "happy",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: api?.missingLocation ? "BLOCKED" : "NOT_VERIFIED",
      evidence: [api?.missingLocation ? "repository location missing" : "previewCsv is not executable"],
    }), {
      serviceIds: ["api"],
      owner: "developer",
      summary: "Happy path preview cannot be executed.",
      evidence: ["missing api preview"],
      severity: "critical",
      repository: api?.repository ?? "api",
      file: api?.file ?? MODULES.api,
      expected: "An organization admin can preview a valid CSV.",
      observed: "The API module or repository location is missing.",
      reproduction: ["Call previewCsv as an organization admin with a valid CSV."],
      suggestion: "api.preview",
    });
  } else {
    const result = preview(csv, actor) as { ok?: boolean; users?: unknown[]; rows?: unknown[] };
    const ok = result?.ok === true && (result.users?.length === 2 || result.rows?.length === 2);
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-HAPPY-PREVIEW`,
      kind: "happy",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: ok ? "PASS" : "FAIL",
      evidence: [`preview:${JSON.stringify(result)}`],
    }), ok ? undefined : {
      serviceIds: ["api"],
      owner: "developer",
      summary: "Valid CSV preview did not return the uploaded users.",
      evidence: [`preview:${JSON.stringify(result)}`],
      severity: "high",
      repository: api?.repository ?? "api",
      file: api?.file ?? "",
      expected: "Preview lists Ada and Bea.",
      observed: JSON.stringify(result),
      reproduction: ["Upload email,name,role with two valid rows as an organization admin."],
      suggestion: "api.preview",
    });
    if (start && ok) {
      const job = start(result, actor) as { ok?: boolean; status?: string; rows?: unknown[]; id?: string };
      const started = job?.ok === true && job.status === "queued";
      add(scenario({
        storyId: story.id,
        requirementId,
        acceptanceCriterionId: criterionId,
        scenarioId: `${story.id}-HAPPY-START`,
        kind: "happy",
        serviceId: "api",
        repository: api?.repository,
        implementationPath: api?.file,
        status: started ? "PASS" : "FAIL",
        evidence: [`job:${JSON.stringify(job)}`],
      }));
      const roles = allowedRoles ? allowedRoles() : ["org-admin", "member"];
      if (importRows && started) {
        let processed: { created?: unknown[]; rejected?: unknown[]; status?: string } | undefined;
        let failed = false;
        try {
          processed = importRows((result as { rows?: unknown[] }).rows ?? [], { roles }) as typeof processed;
        } catch (err) {
          failed = true;
          processed = { status: err instanceof Error ? err.message : "threw" };
        }
        const created = processed?.created?.length === 2 && processed.status === "COMPLETED";
        add(scenario({
          storyId: story.id,
          requirementId,
          acceptanceCriterionId: criterionId,
          scenarioId: `${story.id}-HAPPY-PROCESS`,
          kind: "happy",
          serviceId: "worker",
          repository: worker?.repository,
          implementationPath: worker?.file,
          status: created && !failed ? "PASS" : "FAIL",
          evidence: [`process:${JSON.stringify(processed)}`],
        }));
        if (audit) {
          const recorded = audit({ ...(processed ?? {}), id: job.id }) as { recorded?: boolean };
          add(scenario({
            storyId: story.id,
            requirementId,
            acceptanceCriterionId: criterionId,
            scenarioId: `${story.id}-HAPPY-AUDIT`,
            kind: "happy",
            serviceId: "api",
            repository: api?.repository,
            implementationPath: api?.file,
            status: recorded?.recorded === true ? "PASS" : "FAIL",
            evidence: [`audit:${JSON.stringify(recorded)}`],
          }));
        }
      }
    }
  }

  const member = fn(api?.mod, "previewCsv");
  if (member) {
    const denied = member(csv, { role: "member", org: "O" }) as { ok?: boolean; code?: string };
    const safe = denied?.ok === false && denied.code === "ACCESS_DENIED";
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-SECURITY-AUTH`,
      kind: "security",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: safe ? "PASS" : "FAIL",
      critical: true,
      evidence: [`auth:${JSON.stringify(denied)}`],
    }), safe ? undefined : {
      serviceIds: ["api"],
      owner: "developer",
      summary: "A non-admin can start or preview an import.",
      evidence: [`auth:${JSON.stringify(denied)}`],
      severity: "critical",
      repository: api?.repository ?? "api",
      file: api?.file ?? "",
      expected: "Members receive ACCESS_DENIED and no import starts.",
      observed: JSON.stringify(denied),
      reproduction: ["Call previewCsv as a member."],
      suggestion: "api.auth",
    });
  }

  if (preview) {
    const malformed = preview("not a csv", actor) as { ok?: boolean; code?: string };
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-NEGATIVE-MALFORMED`,
      kind: "negative",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: malformed?.ok === false ? "PASS" : "FAIL",
      critical: true,
      evidence: [`malformed:${JSON.stringify(malformed)}`],
    }));
  }

  if (importRows && preview) {
    const mixedPreview = preview(
      "email,name,role\nada@example.com,Ada,member\nbad,Nope,nope\n",
      actor,
    ) as { ok?: boolean; rows?: Array<{ email?: string; role?: string; invalid?: boolean }> };
    let partial: { created?: unknown[]; rejected?: unknown[]; status?: string } | undefined;
    let threw = false;
    try {
      partial = importRows(mixedPreview.rows ?? [], { roles: ["org-admin", "member"] }) as typeof partial;
    } catch (err) {
      threw = true;
      partial = { status: err instanceof Error ? err.message : "threw" };
    }
    const ok = !threw && (partial?.created?.length ?? 0) === 1 && (partial?.rejected?.length ?? 0) === 1;
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-EDGE-PARTIAL`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: ok ? "PASS" : "FAIL",
      critical: true,
      evidence: [`partial:${JSON.stringify(partial)}`, `threw:${threw}`, "green unit tests are not evidence"],
    }), ok ? undefined : {
      serviceIds: ["worker"],
      owner: "developer",
      summary: "Invalid rows prevent valid users from being imported.",
      evidence: [`partial:${JSON.stringify(partial)}`, "developer unit tests were not used as proof"],
      severity: "critical",
      repository: worker?.repository ?? "worker",
      file: worker?.file ?? MODULES.worker,
      expected: "Ada is created and the invalid row is rejected.",
      observed: threw ? `threw ${partial?.status}` : JSON.stringify(partial),
      reproduction: ["Import one valid row and one invalid role.", "Observe whether the valid user is created."],
      suggestion: "worker.partial-success",
    });
    const first = ok ? partial : undefined;
    if (first?.created) {
      const again = importRows(mixedPreview.rows ?? [], {
        roles: ["org-admin", "member"],
        existingEmails: (first.created as Array<{ email?: string }>).map((row) => row.email),
      }) as { created?: unknown[] };
      add(scenario({
        storyId: story.id,
        requirementId,
        acceptanceCriterionId: criterionId,
        scenarioId: `${story.id}-EDGE-IDEMPOTENT`,
        kind: "edge",
        serviceId: "worker",
        repository: worker?.repository,
        implementationPath: worker?.file,
        status: (again.created?.length ?? 0) === 0 ? "PASS" : "FAIL",
        critical: true,
        evidence: [`retry:${JSON.stringify(again)}`],
      }));
    }
  }

  if (rowEvent && acceptEvent) {
    const event = rowEvent({ email: "ada@example.com", role: "member", invalid: false }) as {
      role?: string;
      email?: string;
    };
    let consumed: { role?: string } | undefined;
    let incompatible = false;
    try {
      consumed = acceptEvent(event) as { role?: string };
      incompatible = consumed?.role !== event.role;
    } catch {
      incompatible = true;
    }
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-CONTRACT-EVENT`,
      kind: "contract",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: incompatible ? "FAIL" : "PASS",
      critical: true,
      evidence: [`event:${JSON.stringify(event)}`, `consumed:${JSON.stringify(consumed ?? null)}`],
    }), incompatible ? {
      serviceIds: ["api", "worker"],
      owner: "developer",
      summary: "The worker does not accept the API row-completed event, including role.",
      evidence: [`event:${JSON.stringify(event)}`, `consumed:${JSON.stringify(consumed ?? null)}`],
      severity: "high",
      repository: worker?.repository ?? "worker",
      file: worker?.file ?? MODULES.worker,
      expected: "Consumer keeps email, role, and outcome from import.row.completed.",
      observed: JSON.stringify(consumed ?? null),
      reproduction: ["Emit the API event for Ada.", "Pass it to the worker acceptEvent function."],
      suggestion: "worker.event-contract",
    } : undefined);
  }

  const tryLock = fn(worker?.mod, "tryLock");
  const unlock = fn(worker?.mod, "unlock");
  if (!tryLock || !unlock) {
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-EDGE-CONCURRENCY`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: "NOT_VERIFIED",
      critical: false,
      evidence: ["worker does not expose an import lock"],
    }));
  } else {
    const first = tryLock() === true;
    const second = tryLock() === false;
    unlock();
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-EDGE-CONCURRENCY`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: first && second ? "PASS" : "FAIL",
      critical: true,
      evidence: [`first:${first}`, `second:${second}`],
    }));
  }

  if (frontend?.missingLocation) {
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      status: "BLOCKED",
      critical: true,
      evidence: ["frontend repository location is missing"],
    }), {
      serviceIds: ["frontend"],
      owner: "developer",
      summary: "Frontend repository was not available for happy-path summary verification.",
      evidence: ["missing repository location"],
      severity: "critical",
      repository: "frontend",
      file: MODULES.frontend,
      expected: "The completed import shows a result summary.",
      observed: "No frontend checkout was provided.",
      reproduction: ["Open the import result screen after a successful import."],
      suggestion: "frontend.summary",
    });
  } else if (!render) {
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      repository: frontend?.repository,
      implementationPath: frontend?.file,
      status: "NOT_VERIFIED",
      critical: true,
      evidence: ["frontend render function is missing"],
    }), {
      serviceIds: ["frontend"],
      owner: "developer",
      summary: "The import result summary is not implemented.",
      evidence: ["missing src/import-ui.mjs render"],
      severity: "high",
      repository: frontend?.repository ?? "frontend",
      file: MODULES.frontend,
      expected: "A completed import renders state completed and the created count.",
      observed: "No frontend render function is present.",
      reproduction: ["Finish a valid import and open the result summary."],
      suggestion: "frontend.summary",
    });
  } else {
    const view = render({ status: "COMPLETED", created: [{ email: "ada@example.com" }, { email: "bea@example.com" }] }) as {
      state?: string;
      created?: number;
    };
    const ok = view?.state === "completed" && view.created === 2;
    add(scenario({
      storyId: story.id,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${story.id}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      repository: frontend?.repository,
      implementationPath: frontend?.file,
      status: ok ? "PASS" : "FAIL",
      evidence: [`view:${JSON.stringify(view)}`],
    }));
  }

  if (independentRerun) {
    for (const finding of findings) {
      if (finding.status === "open") continue;
    }
    const failing = new Set(findings.filter((item) => item.status === "open").map((item) => item.id));
    for (const previous of state.findings) {
      if (!failing.has(previous.id) && previous.status === "open") {
        findings.push({ ...(previous as Finding), status: "resolved" });
      }
    }
  }

  return {
    action: "record-verification",
    independentRerun,
    testsGreen: testsAreGreen([...services.values()]),
    scenarios,
    findings,
  };
}

const WORKER_FIX = `let held = false;
export function tryLock() {
  if (held) return false;
  held = true;
  return true;
}
export function unlock() {
  held = false;
}
export function importRows(rows, ctx = {}) {
  const roles = ctx.roles ?? ["org-admin", "member"];
  const existing = new Set(ctx.existingEmails ?? []);
  const created = [];
  const rejected = [];
  for (const row of rows) {
    const emailOk = typeof row?.email === "string" && row.email.includes("@");
    const roleOk = roles.includes(row?.role);
    if (!emailOk || !roleOk || row?.invalid || existing.has(row.email)) {
      rejected.push(row);
      continue;
    }
    existing.add(row.email);
    created.push(row);
  }
  const status = created.length && rejected.length
    ? "COMPLETED_WITH_ISSUES"
    : created.length
      ? "COMPLETED"
      : "FAILED";
  return { created, rejected, status };
}
export function acceptEvent(event) {
  if (!event?.email || !event.role || !event.outcome) {
    throw new Error("incompatible import.row.completed event");
  }
  return { email: event.email, role: event.role, outcome: event.outcome };
}
`;

const FRONTEND_FIX = `export function render(result) {
  const created = Array.isArray(result?.created) ? result.created.length : result?.created ?? 0;
  const state = result?.status === "COMPLETED"
    ? "completed"
    : result?.status === "COMPLETED_WITH_ISSUES"
      ? "completed-with-issues"
      : "failed";
  return { state, created, summary: created + " users" };
}
`;

export function planServiceFix(repo: string, serviceId: string, existingBranch?: string): {
  action: "record-change";
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
} {
  const state = loadWorkflow(repo);
  if (!state) throw new Error("WORKFLOW_MISSING");
  const service = state.services.find((item) => item.id === serviceId);
  if (!service?.localPath) throw new Error(`REPOSITORY_LOCATION_MISSING:${serviceId}`);
  const branch = existingBranch ?? `quality/${serviceId}-story-fix`;
  if (PROTECTED.has(branch)) throw new Error("PROTECTED_BRANCH");
  const findings = state.findings.filter((item) => item.status === "open" && item.serviceIds.includes(serviceId));
  const files = new Set<string>();
  if (serviceId === "worker") files.add(MODULES.worker);
  if (serviceId === "frontend") files.add(MODULES.frontend);
  if (files.size === 0) throw new Error(`NO_FIX_FOR:${serviceId}`);
  const branchRef = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: service.localPath, encoding: "utf8" });
  const baseSha = (branchRef.status ?? 1) === 0
    ? branchRef.stdout.trim()
    : git(service.localPath, ["rev-parse", "HEAD"]);
  return {
    action: "record-change",
    change: {
      id: `CHG-${serviceId}`,
      findingId: findings[0]?.id ?? `F-${serviceId}`,
      storyIds: findings.flatMap((item) => item.storyIds ?? []),
      requirementIds: findings.flatMap((item) => item.requirementIds),
      serviceId,
      repository: service.repository ?? serviceId,
      branch,
      baseSha,
      commitSha: "PLANNED",
      files: [...files],
      ...(service.remoteUrl ? { remote: service.remoteUrl } : {}),
      mrStatus: service.remoteUrl ? "opened" : "not_requested",
      authorRole: "quality",
    },
  };
}

function writeFix(repo: string, serviceId: string): void {
  if (serviceId === "worker") writeFileSync(join(repo, MODULES.worker), WORKER_FIX);
  if (serviceId === "frontend") writeFileSync(join(repo, MODULES.frontend), FRONTEND_FIX);
}

export function commitServiceFix(
  workflowRepo: string,
  planned: ReturnType<typeof planServiceFix>,
): ReturnType<typeof planServiceFix> {
  const change = planned.change;
  if (change.commitSha !== "PLANNED") return planned;
  const state = loadWorkflow(workflowRepo);
  const service = state?.services.find((item) => item.id === change.serviceId);
  const root = service?.localPath;
  if (!root) throw new Error("REPOSITORY_LOCATION_MISSING");
  writeFix(root, change.serviceId);
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
    if (!remotes.split(/\s+/).includes("origin")) {
      git(root, ["remote", "add", "origin", change.remote]);
    }
    const pushed = spawnSync("git", ["push", "origin", `HEAD:refs/heads/${change.branch}`], {
      cwd: root,
      encoding: "utf8",
    });
    if ((pushed.status ?? 1) !== 0) mrStatus = "blocked";
    else changeRequest = `mr:${change.branch}`;
  }
  return {
    action: "record-change",
    change: {
      ...change,
      commitSha,
      mrStatus,
      ...(changeRequest ? { changeRequest } : {}),
    },
  };
}

export function readFixSource(repo: string, relative: string): string {
  return readFileSync(join(repo, relative), "utf8");
}
