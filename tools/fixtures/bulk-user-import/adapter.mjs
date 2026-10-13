/**
 * Bulk User Import acceptance fixture.
 * Production Quality loads this only when the project under test supplies it.
 */
const MODULES = {
  api: "src/bulk-import-api.mjs",
  identity: "src/identity.mjs",
  worker: "src/import-rows.mjs",
  frontend: "src/import-ui.mjs",
};

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

function fn(mod, name) {
  const value = mod?.[name];
  return typeof value === "function" ? value : undefined;
}

export function propose(serviceId) {
  if (serviceId === "worker") return { files: [{ path: MODULES.worker, after: WORKER_FIX }] };
  if (serviceId === "frontend") return { files: [{ path: MODULES.frontend, after: FRONTEND_FIX }] };
  return null;
}

export async function verify({ state, independentRerun, loadModule }) {
  const story = state.stories.find((item) => item.status !== "superseded");
  if (!story) throw new Error("STORY_MISSING");
  const storyId = story.id;
  const requirementId = story.requirementIds[0] ?? "REQ-BUI-061";
  const criterionId = story.acceptanceCriteria[0]?.id ?? `${story.id}-AC-01`;
  const services = new Map(state.services.map((service) => [service.id, service]));
  const loaded = new Map();
  for (const id of story.serviceIds) {
    const service = services.get(id) ?? { id };
    const relative = MODULES[id];
    loaded.set(id, relative ? await loadModule(service, relative) : { missingModule: true, repository: service.repository });
  }
  const api = loaded.get("api");
  const identity = loaded.get("identity");
  const worker = loaded.get("worker");
  const frontend = loaded.get("frontend");
  const scenarios = [];
  const findings = [];

  function add(entry, finding) {
    const findingId = finding ? `F-${entry.scenarioId}` : undefined;
    scenarios.push({
      repository: entry.repository ?? "",
      implementationPath: entry.implementationPath ?? "",
      testRef: "",
      critical: entry.critical ?? entry.kind === "happy",
      ...entry,
      findingId,
    });
    if (!finding || entry.status === "PASS") return;
    findings.push({
      id: findingId,
      requirementIds: [requirementId],
      storyIds: [storyId],
      acceptanceCriterionIds: [criterionId],
      status: finding.status ?? "open",
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
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-HAPPY-PREVIEW`,
      kind: "happy",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: api?.missingLocation ? "BLOCKED" : "NOT_VERIFIED",
      evidence: [api?.missingLocation ? "repository location missing" : "previewCsv is not executable"],
    }, {
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
    const result = preview(csv, actor);
    const ok = result?.ok === true && (result.users?.length === 2 || result.rows?.length === 2);
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-HAPPY-PREVIEW`,
      kind: "happy",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: ok ? "PASS" : "FAIL",
      evidence: [`preview:${JSON.stringify(result)}`],
    }, ok ? undefined : {
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
      const job = start(result, actor);
      const started = job?.ok === true && job.status === "queued";
      add({
        storyId,
        requirementId,
        acceptanceCriterionId: criterionId,
        scenarioId: `${storyId}-HAPPY-START`,
        kind: "happy",
        serviceId: "api",
        repository: api?.repository,
        implementationPath: api?.file,
        status: started ? "PASS" : "FAIL",
        evidence: [`job:${JSON.stringify(job)}`],
      });
      const roles = allowedRoles ? allowedRoles() : ["org-admin", "member"];
      if (importRows && started) {
        let processed;
        let failed = false;
        try {
          processed = importRows(result.rows ?? [], { roles });
        } catch (err) {
          failed = true;
          processed = { status: err instanceof Error ? err.message : "threw" };
        }
        const created = processed?.created?.length === 2 && processed.status === "COMPLETED";
        add({
          storyId,
          requirementId,
          acceptanceCriterionId: criterionId,
          scenarioId: `${storyId}-HAPPY-PROCESS`,
          kind: "happy",
          serviceId: "worker",
          repository: worker?.repository,
          implementationPath: worker?.file,
          status: created && !failed ? "PASS" : "FAIL",
          evidence: [`process:${JSON.stringify(processed)}`],
        });
        if (audit) {
          const recorded = audit({ ...(processed ?? {}), id: job.id });
          add({
            storyId,
            requirementId,
            acceptanceCriterionId: criterionId,
            scenarioId: `${storyId}-HAPPY-AUDIT`,
            kind: "happy",
            serviceId: "api",
            repository: api?.repository,
            implementationPath: api?.file,
            status: recorded?.recorded === true ? "PASS" : "FAIL",
            evidence: [`audit:${JSON.stringify(recorded)}`],
          });
        }
      }
    }
  }

  if (preview) {
    const denied = preview(csv, { role: "member", org: "O" });
    const safe = denied?.ok === false && denied.code === "ACCESS_DENIED";
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-SECURITY-AUTH`,
      kind: "security",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: safe ? "PASS" : "FAIL",
      critical: true,
      evidence: [`denied:${JSON.stringify(denied)}`],
    }, safe ? undefined : {
      serviceIds: ["api", "identity"],
      owner: "developer",
      summary: "A member was able to start an organization import.",
      evidence: [`denied:${JSON.stringify(denied)}`],
      severity: "critical",
      repository: api?.repository ?? "api",
      file: api?.file ?? MODULES.api,
      expected: "Members receive ACCESS_DENIED.",
      observed: JSON.stringify(denied),
      reproduction: ["Call previewCsv as a member."],
      suggestion: "api.authorization",
    });
    const malformed = preview("not a csv", actor);
    const rejected = malformed?.ok === false;
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-NEGATIVE-MALFORMED`,
      kind: "negative",
      serviceId: "api",
      repository: api?.repository,
      implementationPath: api?.file,
      status: rejected ? "PASS" : "FAIL",
      critical: true,
      evidence: [`malformed:${JSON.stringify(malformed)}`],
    });
  }

  if (importRows && preview) {
    const mixedPreview = preview("email,name,role\nada@example.com,Ada,member\nbad,Nope,nope\n", actor);
    let partial;
    let threw = false;
    try {
      partial = importRows(mixedPreview.rows ?? [], { roles: ["org-admin", "member"] });
    } catch (err) {
      threw = true;
      partial = { status: err instanceof Error ? err.message : "threw" };
    }
    const ok = !threw && (partial?.created?.length ?? 0) === 1 && (partial?.rejected?.length ?? 0) === 1;
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-EDGE-PARTIAL`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: ok ? "PASS" : "FAIL",
      critical: true,
      evidence: [`partial:${JSON.stringify(partial)}`, `threw:${threw}`, "green unit tests are not evidence"],
    }, ok ? undefined : {
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
    if (ok && partial?.created) {
      const again = importRows(mixedPreview.rows ?? [], {
        roles: ["org-admin", "member"],
        existingEmails: partial.created.map((row) => row.email),
      });
      add({
        storyId,
        requirementId,
        acceptanceCriterionId: criterionId,
        scenarioId: `${storyId}-EDGE-IDEMPOTENT`,
        kind: "edge",
        serviceId: "worker",
        repository: worker?.repository,
        implementationPath: worker?.file,
        status: (again.created?.length ?? 0) === 0 ? "PASS" : "FAIL",
        critical: true,
        evidence: [`retry:${JSON.stringify(again)}`],
      });
    }
  }

  if (rowEvent && acceptEvent) {
    const event = rowEvent({ email: "ada@example.com", role: "member", invalid: false });
    let consumed;
    let incompatible = false;
    try {
      consumed = acceptEvent(event);
      incompatible = consumed?.role !== event.role;
    } catch {
      incompatible = true;
    }
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-CONTRACT-EVENT`,
      kind: "contract",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: incompatible ? "FAIL" : "PASS",
      critical: true,
      evidence: [`event:${JSON.stringify(event)}`, `consumed:${JSON.stringify(consumed ?? null)}`],
    }, incompatible ? {
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
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-EDGE-CONCURRENCY`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: "NOT_VERIFIED",
      critical: false,
      evidence: ["worker does not expose an import lock"],
    });
  } else {
    const first = tryLock() === true;
    const second = tryLock() === false;
    unlock();
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-EDGE-CONCURRENCY`,
      kind: "edge",
      serviceId: "worker",
      repository: worker?.repository,
      implementationPath: worker?.file,
      status: first && second ? "PASS" : "FAIL",
      critical: true,
      evidence: [`first:${first}`, `second:${second}`],
    });
  }

  if (frontend?.missingLocation) {
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      status: "BLOCKED",
      critical: true,
      evidence: ["frontend repository location is missing"],
    }, {
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
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      repository: frontend?.repository,
      implementationPath: frontend?.file,
      status: "NOT_VERIFIED",
      critical: true,
      evidence: ["frontend render function is missing"],
    }, {
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
    const view = render({ status: "COMPLETED", created: [{ email: "ada@example.com" }, { email: "bea@example.com" }] });
    const ok = view?.state === "completed" && view.created === 2;
    add({
      storyId,
      requirementId,
      acceptanceCriterionId: criterionId,
      scenarioId: `${storyId}-HAPPY-SUMMARY`,
      kind: "happy",
      serviceId: "frontend",
      repository: frontend?.repository,
      implementationPath: frontend?.file,
      status: ok ? "PASS" : "FAIL",
      evidence: [`view:${JSON.stringify(view)}`],
    });
  }

  void independentRerun;
  return { scenarios, findings };
}
