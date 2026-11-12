/**
 * The security state a production Runtime keeps for a repository, from 0.1.0-alpha.49.3: the decision journal and the decision
 * ledger, under the OS account's home whatever HOME or PRAXIS_STATE_HOME say, keyed by repositoryKey (contracts
 * user-approval.ts). Acceptance scripts that run a production bundle read the journal there and remove exactly what their own
 * temporary repositories produced, and nothing else of the account's ~/.praxis.
 *
 * Keys are taken while the repositories exist (the key is derived from real paths), so call track() when a repository is made.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { repositoryKey } from "@praxis/contracts";

const home = () => join(userInfo().homedir, ".praxis");

export function accountState() {
  const keys = new Map();
  const track = (repo) => {
    if (!keys.has(repo)) keys.set(repo, repositoryKey(repo));
    return repo;
  };
  const journalFile = (repo) => join(home(), "decisions", `${track(repo) && keys.get(repo)}.jsonl`);
  return {
    track,
    journalFile,
    /** The journal entries of the tracked repositories, `repository` spelled as the script spelled the path. */
    journal: () =>
      [...keys.keys()].flatMap((repo) => {
        const file = journalFile(repo);
        return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => ({ ...JSON.parse(line), repository: repo })) : [];
      }),
    /** Removes the journal and ledger kept for the tracked repositories. */
    remove: () => {
      for (const key of new Set(keys.values())) {
        rmSync(join(home(), "decisions", `${key}.jsonl`), { force: true });
        rmSync(join(home(), "ledger", key), { recursive: true, force: true });
      }
    },
  };
}
