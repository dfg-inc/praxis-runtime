import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export class GitContextError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitContextError";
    this.code = code;
  }
}

export function git(repo: string, args: string[]): string {
  if (!existsSync(repo)) {
    throw new GitContextError("repo_missing", `git repo missing: ${repo}`);
  }
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new GitContextError(
      "git_failed",
      `git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return (r.stdout ?? "").trim();
}

export function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, ["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function resolveSha(repo: string, ref: string): string {
  return git(repo, ["rev-parse", ref]);
}

export function changedFilesBetween(repo: string, base: string, head: string): string[] {
  const out = git(repo, ["diff", "--name-only", `${base}...${head}`]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}
