import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  DECISION_LEDGER_UNAVAILABLE,
  LEDGER_DECISIONS,
  LEDGER_GENESIS,
  SUBJECT_KINDS,
  WorkflowError,
  type LedgerApproval,
  type LedgerEntry,
  type LedgerReading,
  type PlannedLedgerEntry,
  type UserApproval,
  securityStateHome,
} from "@praxis/contracts";

/**
 * The decision ledger: where an acceptance becomes something Praxis can stand behind (acceptance-integrity.ts in core).
 *
 *   <home from the OS account database>/.praxis/ledger/<repository key>/<work item id>.jsonl
 *
 * One JSON line per decision about one subject (accept / reject / revoke / supersede), hash-chained (`prev` = sha256 of the
 * previous line), appended only by the Runtime's workflow store, under the workflow lock and before the work item file is
 * written, and only for an approval the client's dialog gave in that same call. The Work Item file in the repository keeps
 * the record's actionId next to the acceptance it claims; the file alone proves nothing.
 *
 * Location. The home directory comes from os.userInfo() (the account database), never HOME or PRAXIS_STATE_HOME: a
 * repository's .mcp.json or .claude/settings.json can set the server's environment (T-repo). The test override
 * (PRAXIS_STATE_HOME/ledger) is honoured only outside a production bundle, where PRAXIS_BUNDLE_KIND is a constant. A ledger
 * that would resolve inside the repository is refused (DECISION_LEDGER_UNAVAILABLE): the repository can never hold its
 * own evidence.
 *
 * Repository key. sha256 of the realpath of the git common directory (shared by every worktree of one repository), or of
 * the project root when it is not a git repository. Derived from the directory the store actually reads, never from a
 * separate argument. A linked worktree counts only when git's own back-pointer confirms it; anything else is keyed by its
 * project root, so a copy or a planted .git file never reads another repository's decisions.
 *
 * What this stops, by tier (BRIEF): T-repo and T-sandboxed-agent cannot write here (outside the repository and the
 * workspace), so they cannot make an acceptance "accepted". T-same-user can: it writes this directory like any other file
 * of the account (the hash chain only detects careless edits) and can answer the client's dialog (R1). Nothing local stops
 * T-same-user; "accepted" never means more than "recorded by Praxis on this computer after the client's dialog answered".
 */

const WORK_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

const unavailable = (why: string) => new WorkflowError(DECISION_LEDGER_UNAVAILABLE, `the decision ledger cannot be used (${why}); nothing was recorded and the work item is unchanged. Acceptances are recorded only where the repository and the agent's workspace cannot write.`, { executed: false, reason: why });

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Where every repository's ledgers live: beside the decision journal, in the security state home (user-approval.ts). */
export function ledgerRoot(): string {
  // securityStateHome honours PRAXIS_STATE_HOME only outside a production bundle, where PRAXIS_BUNDLE_KIND is a constant
  return join(securityStateHome(), "ledger");
}

/** The git common directory that git itself would use for `root`, or null (not a git repository, or a .git we cannot confirm). */
function gitCommonDir(root: string): string | null {
  let home: string | null = null;
  try {
    home = realpathSync(userInfo().homedir);
  } catch {
    /* no home: walk to the filesystem root */
  }
  for (let dir = root; ; ) {
    // the user's home is not a project: a dotfiles repository there must not join unrelated directories under one key
    if (dir === home) return null;
    const dotgit = join(dir, ".git");
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(dotgit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return realpathSync(dotgit);
    if (st?.isFile()) return linkedCommonDir(dotgit);
    if (st) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A linked worktree: `.git` names its git dir, which names the common dir and points back at this very `.git` file. */
function linkedCommonDir(dotgit: string): string | null {
  try {
    const line = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"))?.[1]?.trim();
    if (!line) return null;
    const gitdir = realpathSync(resolve(dirname(dotgit), line));
    const commondir = join(gitdir, "commondir");
    if (!existsSync(commondir)) return null; // a submodule or something else: keyed by its own project root
    const back = realpathSync(resolve(gitdir, readFileSync(join(gitdir, "gitdir"), "utf8").trim()));
    if (back !== realpathSync(dotgit)) return null;
    return realpathSync(resolve(gitdir, readFileSync(commondir, "utf8").trim()));
  } catch {
    return null;
  }
}

export type RepositoryKey = { key: string; source: "git-common-dir" | "project-root"; basis: string; root: string };

export function repositoryKey(repo: string): RepositoryKey {
  const root = realpathSync(resolve(repo));
  const common = gitCommonDir(root);
  const basis = common ?? root;
  // the same key format as the decision journal's repositoryKey (user-approval.ts), so both name one repository alike
  return { key: sha256(common ? `git:${basis}` : `dir:${basis}`), source: common ? "git-common-dir" : "project-root", basis, root };
}

/** The realpath of `target`, or of its nearest existing ancestor joined with the rest: where it would be created. */
function realTarget(target: string): string {
  const rest: string[] = [];
  let dir = resolve(target);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    rest.unshift(basename(dir));
    dir = parent;
  }
  return join(realpathSync(dir), ...rest);
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

type Located = { dir: string; file: string; key: RepositoryKey };

function locate(repo: string, workItemId: string): Located {
  if (!WORK_ITEM_ID_RE.test(workItemId) || workItemId.includes("..")) throw unavailable("the work item id is not a plain name");
  let key: RepositoryKey;
  try {
    key = repositoryKey(repo);
  } catch (error) {
    throw unavailable(`the repository could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  let root: string;
  try {
    root = ledgerRoot();
  } catch (error) {
    throw unavailable(`the account's home directory could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dir = join(root, key.key);
  const real = realTarget(dir);
  // the repository (its root, its git directory and the main worktree around it) can never hold its own evidence
  const guarded = [key.root, ...(key.source === "git-common-dir" ? [key.basis, ...(key.basis.endsWith(`${sep}.git`) ? [dirname(key.basis)] : [])] : [])];
  if (guarded.some((g) => inside(real, g))) throw unavailable(`it would be inside the repository (${real})`);
  return { dir, file: join(dir, `${workItemId}.jsonl`), key };
}

/** Owned by this account and not writable by group or others; anything else is not a ledger Praxis wrote. */
function assertPrivate(path: string): void {
  const st = statSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw unavailable(`${path} is owned by another account`);
  if (process.platform !== "win32" && (st.mode & 0o022) !== 0) throw unavailable(`${path} is writable by other accounts`);
}

function checkEntry(raw: unknown, workItemId: string, seq: number, prev: string): string | null {
  const e = raw as Partial<LedgerEntry> | null;
  if (!e || typeof e !== "object") return "not an object";
  if (e.v !== 1) return "unknown format";
  if (e.seq !== seq) return `sequence ${String(e.seq)}, expected ${seq}`;
  if (e.prev !== prev) return "the hash chain is broken (a line was changed, removed or inserted)";
  if (e.workItemId !== workItemId) return `it belongs to work item ${String(e.workItemId)}`;
  if (!e.subject || !(SUBJECT_KINDS as readonly string[]).includes(String(e.subject.kind)) || typeof e.subject.id !== "string") return "no valid subject";
  if (!(LEDGER_DECISIONS as readonly string[]).includes(String(e.decision))) return "no valid decision";
  if (typeof e.actionId !== "string" || typeof e.contentDigest !== "string" || typeof e.batchId !== "string") return "missing ids";
  return null;
}

/** Complete lines only: a last line without its newline is an append that never finished and is ignored. */
function parse(text: string, workItemId: string): LedgerReading {
  const lines = text.split("\n");
  lines.pop(); // what follows the last newline: empty, or an unfinished append
  const entries: LedgerEntry[] = [];
  let prev = LEDGER_GENESIS;
  for (let i = 0; i < lines.length; i += 1) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch {
      return { status: "corrupt", reason: `line ${i + 1} is not JSON` };
    }
    const problem = checkEntry(raw, workItemId, i + 1, prev);
    if (problem) return { status: "corrupt", reason: `line ${i + 1}: ${problem}` };
    entries.push(raw as LedgerEntry);
    prev = sha256(lines[i]!);
  }
  return { status: "available", entries };
}

/**
 * The ledger of one work item as it is on disk, for the read path. Never throws: a ledger that cannot be read leaves every
 * claim unverified, a corrupt one leaves them invalid (acceptance-integrity.ts), and reading never creates anything.
 */
export function readDecisionLedger(repo: string, workItemId: string): LedgerReading {
  try {
    const { file } = locate(repo, workItemId);
    if (!existsSync(file)) return { status: "available", entries: [] };
    assertPrivate(dirname(file));
    assertPrivate(file);
    return parse(readFileSync(file, "utf8"), workItemId);
  } catch (error) {
    const reason = error instanceof WorkflowError && typeof error.details?.reason === "string" ? error.details.reason : error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: reason.slice(0, 300) };
  }
}

/** Serializes appends to one ledger across processes and worktrees (each worktree has its own workflow lock). */
function withLedgerLock<T>(dir: string, workItemId: string, fn: () => T): T {
  const lock = join(dir, `${workItemId}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: number; at?: number };
        if (typeof owner.at === "number" && Date.now() - owner.at > LOCK_STALE_MS) stale = true;
        else if (typeof owner.pid === "number") {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            stale = (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        try {
          stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw unavailable("another process is writing this ledger");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const decidedByOf = (channel: string): string =>
  channel === "client-elicitation" ? "client-dialog" : channel === "terminal-prompt" ? "terminal-prompt" : channel === "test" ? "test-harness" : channel;

export function ledgerApproval(approval: UserApproval): LedgerApproval {
  return { action: approval.action, subjectDigest: approval.subjectDigest, channel: approval.channel, decidedBy: decidedByOf(approval.channel), decidedAt: approval.decidedAt, personVerified: false, independentlyVerified: false };
}

/** One batch id per approval: every subject a single dialog answer decided shares it. */
const batches = new WeakMap<object, string>();
export function batchIdFor(approval: UserApproval | null): string {
  if (!approval) return randomUUID();
  let id = batches.get(approval);
  if (!id) {
    id = randomUUID();
    batches.set(approval, id);
  }
  return id;
}

/**
 * Appends the planned entries and returns them with their new actionIds. Throws DECISION_LEDGER_UNAVAILABLE (nothing written)
 * when the ledger cannot be written: unwritable, inside the repository, not this account's, or its chain is broken.
 */
export function appendDecisions(repo: string, workItemId: string, planned: readonly PlannedLedgerEntry[], approval: UserApproval | null): LedgerEntry[] {
  if (planned.length === 0) return [];
  const { dir, file } = locate(repo, workItemId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivate(dirname(dir));
    assertPrivate(dir);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw unavailable(`${(error as NodeJS.ErrnoException).code ?? "error"} creating ${dir}`);
  }
  try {
    return withLedgerLock(dir, workItemId, () => {
      let text = "";
      if (existsSync(file)) {
        assertPrivate(file);
        text = readFileSync(file, "utf8");
      }
      // an append that never finished leaves a line without its newline: it was never part of the ledger
      const complete = text.lastIndexOf("\n") + 1;
      if (complete < text.length) {
        truncateSync(file, Buffer.byteLength(text.slice(0, complete), "utf8"));
        text = text.slice(0, complete);
      }
      const current = parse(text, workItemId);
      if (current.status !== "available") throw unavailable(`it is corrupt (${current.reason}); move it aside to start a new one (every acceptance then has to be given again)`);
      const lines = text.split("\n").slice(0, -1);
      let prev = lines.length ? sha256(lines[lines.length - 1]!) : LEDGER_GENESIS;
      let seq = current.entries.length;
      const at = new Date().toISOString();
      const batchId = batchIdFor(approval);
      const written: LedgerEntry[] = [];
      let out = "";
      for (const item of planned) {
        seq += 1;
        const entry: LedgerEntry = {
          v: 1,
          seq,
          prev,
          at,
          workItemId,
          subject: item.subject,
          contentDigest: item.contentDigest,
          decision: item.decision,
          actionId: randomUUID(),
          batchId,
          approval: approval ? ledgerApproval(approval) : null,
          assurance: approval ? "client-response" : "none",
        };
        const line = JSON.stringify(entry);
        prev = sha256(line);
        out += `${line}\n`;
        written.push(entry);
      }
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, out);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return written;
    });
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw unavailable(`${(error as NodeJS.ErrnoException).code ?? "error"} writing ${file}`);
  }
}

/** Where this repository's ledger for a work item is, for status output and tests. */
export function ledgerLocation(repo: string, workItemId: string): { file: string; repositoryKey: RepositoryKey } | { error: string } {
  try {
    const { file, key } = locate(repo, workItemId);
    return { file, repositoryKey: key };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
