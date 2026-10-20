#!/usr/bin/env node
/**
 * Selective version control for `.praxis/`.
 *
 *   node tools/scripts/praxis-state-policy.mjs adopt --repo=<dir>   write/refresh the .gitignore block
 *   node tools/scripts/praxis-state-policy.mjs scan  --repo=<dir>   fail if anything committable holds a
 *                                                                    secret or an absolute home path
 *
 * Tracked   .praxis/workflow/items/*.json   authoritative state of each work item
 *           .praxis/quality/**              checks.json, adapter.mjs, proposals/ (not logs)
 * Ignored   index.json (per-operator selection, rebuildable), state.json (legacy / tombstone),
 *           locks, temp and stale files, approvals, ledgers, keys, local-only state, logs.
 *
 * `scan` never prints a matched value, only its kind and location.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCK_BEGIN = "# >>> praxis workflow state policy >>>";
export const BLOCK_END = "# <<< praxis workflow state policy <<<";

export const GITIGNORE_BLOCK = `${BLOCK_BEGIN}
# Track: .praxis/workflow/items/*.json and .praxis/quality/{checks.json,adapter.mjs,proposals/}.
# Everything below is private, transient, per-operator or machine-specific.
.praxis/workflow/index.json
.praxis/workflow/state.json
.praxis/workflow/.lock/
.praxis/workflow/.lock.stale-*
.praxis/workflow/**/*.tmp
.praxis/workflow/last-verification.json
.praxis/approvals/
.praxis/local/
.praxis/**/*.ledger
.praxis/**/*.pem
.praxis/**/*.key
.praxis/**/*.log
.praxis/quality/**/*.tmp
${BLOCK_END}
`;

export function adopt(repo) {
  const file = join(resolve(repo), ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const begin = current.indexOf(BLOCK_BEGIN);
  const end = current.indexOf(BLOCK_END);
  let next;
  if (begin >= 0 && end > begin) {
    next = current.slice(0, begin) + GITIGNORE_BLOCK + current.slice(end + BLOCK_END.length).replace(/^\n/, "");
  } else {
    next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${GITIGNORE_BLOCK}`;
  }
  const changed = next !== current;
  if (changed) writeFileSync(file, next);
  return { file, changed };
}

const RULES = [
  { kind: "absolute-home-path", re: /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/ },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{12,}/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "atlassian-token", re: /\bATATT[A-Za-z0-9_=-]{20,}/ },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "bearer-credential", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "praxis-approval-token", re: /"signature"\s*:\s*"[A-Za-z0-9+/=]{40,}"/ },
];

function committable(repo) {
  const out = [];
  const walk = (dir, accept) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, accept);
      else if (statSync(full).isFile() && accept(full)) out.push(full);
    }
  };
  walk(join(repo, ".praxis", "workflow", "items"), (f) => f.endsWith(".json"));
  walk(join(repo, ".praxis", "quality"), (f) => !/\.(log|tmp|pem|key|ledger)$/.test(f));
  return out;
}

export function scan(repo) {
  const root = resolve(repo);
  const hits = [];
  const files = committable(root);
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const rule of RULES) {
          if (rule.re.test(line)) {
            hits.push({ kind: rule.kind, path: relative(root, file).split(sep).join("/"), line: index + 1 });
          }
        }
      });
  }
  return { ok: hits.length === 0, files: files.length, hits };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const repoArg = rest.find((arg) => arg.startsWith("--repo="))?.slice(7);
  const repo = resolve(repoArg ?? process.cwd());
  if (command === "adopt") {
    const result = adopt(repo);
    console.log(`${result.changed ? "updated" : "unchanged"} ${result.file}`);
    return;
  }
  if (command === "scan") {
    const result = scan(repo);
    for (const hit of result.hits) console.error(`FAIL ${hit.kind.padEnd(22)} ${hit.path}:${hit.line}`);
    console.log(`praxis-state scan: ${result.files} committable file(s), ${result.hits.length} finding(s)`);
    process.exit(result.ok ? 0 : 1);
  }
  console.error("usage: praxis-state-policy.mjs adopt|scan [--repo=<dir>]");
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
void dirname;
