/**
 * Git fixtures shared by the Git delivery acceptance scripts: a consumer-like repository, an empty bare remote with an
 * SSH-style URL rewritten to it, and a mock GitHub API served over HTTP. Nothing here touches a real remote.
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createMockGithubFetch } from "@praxis/vcs";

export const WP = "WP-20260914-002";
export const SSH = "git@github.com:hisagedru/praxis-acceptance-test.git";

function fail(msg) {
  throw new Error(`git fixture: ${msg}`);
}

export function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function git(repo, args, extra = {}) {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "false", ...extra.env },
  });
  if ((r.status ?? 1) !== 0 && extra.allowFail !== true) {
    fail(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
}

export const BASELINE_COUNTER = `export function increment(value) {
  return value + 1;
}

export function decrement(value) {
  return value - 1;
}
`;

export const FEATURE_COUNTER = `export function increment(value) {
  return value + 1;
}

export function decrement(value) {
  return value - 1;
}

export function reset() {
  return 0;
}
`;

export const BASELINE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { increment, decrement } from './counter.js';

test('decrement(5) returns 4', () => {
  assert.strictEqual(decrement(5), 4);
});

test('decrement(0) returns -1 (no lower bound/clamp)', () => {
  assert.strictEqual(decrement(0), -1);
});

test('increment(1) returns 2 (non-regression, nominal)', () => {
  assert.strictEqual(increment(1), 2);
});

test('increment(-1) returns 0 (non-regression, boundary)', () => {
  assert.strictEqual(increment(-1), 0);
});
`;

export const FEATURE_TEST = `${BASELINE_TEST}
test('reset() returns 0', () => {
  assert.strictEqual(reset(), 0);
});
`.replace("import { increment, decrement } from './counter.js';", "import { increment, decrement, reset } from './counter.js';");

export const PACKAGE_JSON = `{
  "name": "praxis-test",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test src/*.test.js"
  }
}
`;

export function emptyBare() {
  const bare = mkdtempSync(join(tmpdir(), "praxis-e2e-bare-"));
  git(bare, ["init", "--bare"]);
  return bare;
}

export function attachSshLikeRemote(repo, bare) {
  git(repo, ["remote", "add", "origin", SSH]);
  git(repo, ["config", `url.${bare}.insteadOf`, SSH]);
  const probe = git(repo, ["ls-remote", "--heads", "origin"]);
  if (probe.status !== 0) fail(`insteadOf ls-remote failed: ${probe.stderr}`);
}

export function writeFile(repo, rel, body) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

export function buildConsumerLikeFixture() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-e2e-cons-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  writeFile(repo, "package.json", PACKAGE_JSON);
  writeFile(repo, "README.md", "# praxis-test fixture\n");
  writeFile(repo, "src/counter.js", BASELINE_COUNTER);
  writeFile(repo, "src/counter.test.js", BASELINE_TEST);
  writeFile(repo, ".gitignore", "node_modules/\n.praxis-quality/\n.praxis-git/\n");
  git(repo, ["add", "package.json", "README.md", "src/counter.js", "src/counter.test.js", ".gitignore"]);
  git(repo, ["commit", "-m", "chore: scaffold counter library"]);

  for (let i = 1; i <= 20; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: add library modules"]);

  for (let i = 21; i <= 40; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: expand library surface"]);

  for (let i = 41; i <= 51; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: complete tracked tree"]);

  const tracked = git(repo, ["ls-files"]).stdout.split("\n").filter(Boolean);
  if (tracked.length !== 56) fail(`expected 56 committed files, got ${tracked.length}`);
  const commits = Number(git(repo, ["rev-list", "--count", "HEAD"]).stdout);
  if (commits !== 4) fail(`expected 4 commits, got ${commits}`);

  writeFile(repo, "src/counter.js", FEATURE_COUNTER);
  writeFile(repo, "src/counter.test.js", FEATURE_TEST);
  writeFile(repo, "package.json", PACKAGE_JSON.replace('"version": "1.0.0"', '"version": "1.0.0-dirty"'));
  writeFile(repo, "package-lock.json", `{ "name": "praxis-test", "lockfileVersion": 3, "packages": {} }\n`);
  writeFile(repo, ".npmrc", "registry=https://registry.npmjs.org/\n");
  writeFile(repo, ".project", "stack:\n  - node\nquality:\n  test: npm test\n");
  writeFile(repo, ".praxis-jira/dummy.json", "{}\n");
  writeFile(repo, ".praxis-quality/quality.sqlite", "not-a-db\n");
  writeFile(repo, ".praxis-local-tgz/note.txt", "runtime artifact\n");
  writeFile(repo, "design/notes.md", "do not commit\n");
  writeFile(repo, "work-packages/WP-20260914-002.md", "ba artifact\n");
  mkdirSync(join(repo, "design", WP, "qa"), { recursive: true });
  writeFile(
    repo,
    `design/${WP}/qa/quality-review.json`,
    `${JSON.stringify({
      reviewId: 1,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      verdict: "PASSED",
      approvalApplied: true,
      snapshot: {
        digest: sha("qa-1"),
        files: [
          { path: "src/counter.js", sha256: sha(FEATURE_COUNTER) },
          { path: "src/counter.test.js", sha256: sha(FEATURE_TEST) },
        ],
      },
    }, null, 2)}\n`,
  );

  const baselineSha = git(repo, ["rev-parse", "HEAD"]).stdout;
  return { repo, baselineSha, trackedCount: tracked.length };
}

export function startGithubHttpMock(state) {
  const fetchImpl = createMockGithubFetch(state);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = `http://127.0.0.1${req.url}`;
    const response = await fetchImpl(url, {
      method: req.method,
      body: body || undefined,
    });
    const text = await response.text();
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
    res.end(text);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        server,
        port,
        apiUrl: `http://127.0.0.1:${port}/api/v3`,
        fetchImpl,
        close: () => server.close(),
      });
    });
  });
}

