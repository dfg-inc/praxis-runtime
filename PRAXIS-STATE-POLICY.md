# Version control for `.praxis/` workflow state

Praxis keeps its working state in each product repository under `.praxis/`. Some of it is the team's
durable record of what was asked, decided, built and verified; some of it is private, transient or
specific to one person's machine. This is the split, and how to adopt it.

## Tracked (commit these)

| Path | Why |
| --- | --- |
| `.praxis/workflow/items/<workItemId>.json` | The authoritative state of one work item: requirements and acceptance criteria, User Stories (with revision), architecture decisions with rationale, handoffs, findings, verdicts, verification coverage, implementation and change records, history. One file per work item, so work items merge independently. |
| `.praxis/quality/checks.json`, `.praxis/quality/<workItemId>/checks.json` | Executable checks that Quality runs against the requirements. |
| `.praxis/quality/adapter.mjs`, `.praxis/quality/proposals/` | Project-supplied verification adapter and reviewed fix proposals. |

## Not tracked

| Path | Why |
| --- | --- |
| `.praxis/workflow/index.json` | A cache. It holds the current selection (per operator) and timestamps, and is rebuilt from `items/` when missing. Tracking it only produces merge conflicts. |
| `.praxis/workflow/state.json` | The pre-multi-item file. Before migration it is the single authoritative copy; after migration it is a tombstone. Either way it must not sit next to `items/` as a second copy. |
| `.praxis/workflow/.lock/`, `*.tmp`, `.lock.stale-*` | Transient. |
| `.praxis/workflow/last-verification.json` | Written by older Runtimes at preview time; nothing reads it. |
| `.praxis/approvals/`, `*.ledger` | Left over from the removed stored-approval flow; ignored. The decision journal is no longer in the repository (`~/.praxis/decisions/`). |
| `*.pem`, `*.key` | Signing keys. They must never be inside a repository at all. |
| `.praxis/local/`, `*.log` | Local-only state and logs. |
| `.project` | Already ignored by the repositories in this workspace. |

## What is guaranteed about tracked files

- **No machine paths.** `services[].localPath` is stored relative to the repository (for example
  `../praxis-runtime`) and resolved to an absolute path on load. Paths more than two directories away
  cannot be made portable and stay absolute; the scanner flags those.
- **No secrets.** Runtime state is passed through the Runtime's persistent redaction before it is written.
  `praxis-state-policy.mjs scan` additionally checks every committable file for credentials and home
  paths, and reports the kind and location of a finding, never the value.
- **One authoritative copy.** If `state.json` (a real legacy state, not a tombstone) and `items/` both
  exist, the Runtime refuses with `WORKFLOW_CONFLICT` instead of choosing.

## Selection after a fresh clone

`index.json` is not committed, so a fresh clone has `items/` and no index. The Runtime rebuilds it:
with exactly one work item that item is current; with several, **none is** and any command without a
`workItemId` fails with `WORK_ITEM_SELECTION_REQUIRED` listing the ids. Pass `workItemId`, or run
`select-work-item`. It never guesses which one you meant.

## Adopting it

```bash
node tools/scripts/praxis-state-policy.mjs adopt --repo=/path/to/product-repo   # writes the .gitignore block
node tools/scripts/praxis-state-policy.mjs scan  --repo=/path/to/product-repo   # must report 0 findings
git -C /path/to/product-repo add .gitignore .praxis
git -C /path/to/product-repo status                                              # review before committing
```

`adopt` is idempotent and refreshes its own block in place; it never touches other `.gitignore` lines.

A repository that still has the old single `state.json` is migrated the first time the Runtime writes to
it. After that, an older Praxis Runtime cannot read it and fails with a parse error on the tombstone,
on purpose, rather than silently opening a second workflow. Upgrade the Runtime first (see
`UPGRADE-DESKTOP.md`).

## What this does not do

It does not decide whether *you* want a work item's history in your repository history: some teams
prefer to keep the whole `.praxis/workflow/` directory ignored. If so, drop the `items/` line from your
adoption and keep the rest; nothing in the Runtime depends on the items being committed.
