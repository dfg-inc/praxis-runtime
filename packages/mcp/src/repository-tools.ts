import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { buildRepositoryBrief, implementationOrder, repositoryProgress, type WorkflowState } from "@praxis/contracts";
import { discoverFrontend } from "./frontend-discover.js";
import { applyRuntimeCommand, loadWorkflow } from "./workflow-store.js";

/**
 * Repositories of a work item. Registration is the agent's record (any number of repositories, any roles). What the
 * Runtime knows about one, it reads itself: the head commit, the manifests, the frontend. An agent cannot type an
 * inspection in: record-repository-inspection is refused through the generic workflow tools.
 */

function requireState(repo: string, workItemId?: string): WorkflowState {
  const state = loadWorkflow(repo, workItemId);
  if (!state) throw new Error("WORKFLOW_MISSING: open a work item first");
  return state;
}

function git(path: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const MANIFESTS: Array<[RegExp, string]> = [
  [/^package\.json$/, "node"],
  [/^pom\.xml$/, "java-maven"],
  [/^build\.gradle(\.kts)?$/, "gradle"],
  [/^go\.mod$/, "go"],
  [/^pyproject\.toml$|^requirements\.txt$/, "python"],
  [/^Cargo\.toml$/, "rust"],
  [/\.csproj$|\.sln$/, "dotnet"],
  [/^Gemfile$/, "ruby"],
  [/^composer\.json$/, "php"],
  [/^pubspec\.yaml$/, "flutter"],
  [/^Package\.swift$/, "swift"],
  [/^Dockerfile$/, "docker"],
  [/^openapi\.(ya?ml|json)$|^swagger\.(ya?ml|json)$/, "openapi"],
];

export function inspectRepository(repo: string, input: { repositoryId: string; workItemId?: string }) {
  const state = requireState(repo, input.workItemId);
  const entry = state.repositories.find((r) => r.id === input.repositoryId);
  if (!entry) throw new Error(`INVALID_INPUT: repository ${input.repositoryId} is not registered; record it first with the register-repository command`);
  if (!entry.localPath) throw new Error(`INSPECT_PATH_INVALID: repository ${entry.id} has no localPath; register it with a local checkout to inspect it`);
  const path = isAbsolute(entry.localPath) ? entry.localPath : resolve(repo, entry.localPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`INSPECT_PATH_INVALID: ${path} is not a directory`);
  const top = readdirSync(path).filter((n) => n !== ".git").sort();
  const frameworks = new Set<string>();
  const entries: Array<{ path: string; note?: string }> = [];
  for (const name of top.slice(0, 60)) {
    const manifest = MANIFESTS.find(([re]) => re.test(name));
    if (manifest) frameworks.add(manifest[1]);
    const isDir = (() => {
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    })();
    entries.push({ path: isDir ? `${name}/` : name, ...(manifest ? { note: manifest[1] } : {}) });
  }
  const frontend = discoverFrontend(path);
  for (const f of frontend.frameworks) frameworks.add(f);
  const headSha = git(path, ["rev-parse", "HEAD"]);
  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(path, ["status", "--porcelain"]);
  const inspection = {
    at: new Date().toISOString(),
    ...(headSha ? { headSha } : {}),
    ...(branch ? { branch } : {}),
    summary: `${entry.name}: ${[...frameworks].join(", ") || "no recognised manifest"}; ${frontend.isFrontend ? `${frontend.kind} frontend` : "no frontend"}${dirty ? "; working tree has uncommitted changes" : ""}.`,
    frameworks: [...frameworks].sort(),
    instructionFiles: frontend.instructionFiles,
    entries,
    ...(frontend.isFrontend ? { frontend: { hasStyles: frontend.hasStyles, styleFiles: frontend.styleFiles.slice(0, 20), componentDirs: frontend.componentDirs } } : {}),
  };
  const applied = applyRuntimeCommand(repo, { action: "record-repository-inspection", repositoryId: entry.id, inspection }, input.workItemId);
  return { repositoryId: entry.id, path, inspection, recorded: applied.result, workItemId: applied.workItemId, dirty: Boolean(dirty) };
}

export function repositoryBrief(repo: string, input: { repositoryId?: string; workItemId?: string }) {
  const state = requireState(repo, input.workItemId);
  const sequence = implementationOrder(state);
  const progress = repositoryProgress(state);
  if (input.repositoryId) {
    return { workItemId: state.workItem.id, brief: buildRepositoryBrief(state, input.repositoryId), progress: progress.find((p) => p.repositoryId === input.repositoryId), order: sequence };
  }
  return {
    workItemId: state.workItem.id,
    order: sequence,
    progress,
    briefs: state.repositories.map((r) => {
      const b = buildRepositoryBrief(state, r.id);
      return { repositoryId: r.id, readyToStart: b.readyToStart, blockers: b.blockers, services: b.services.map((s) => s.id), position: b.order.position };
    }),
    contracts: state.contracts.map((c) => ({ id: c.id, name: c.name, provider: c.providerServiceId, consumers: c.consumerServiceIds, status: c.status })),
  };
}
