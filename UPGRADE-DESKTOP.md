# Upgrading the Claude Desktop extension (local build)

This procedure installs `claude-extensions/praxis-runtime.mcpb` (0.1.0-alpha.48) over an older
Praxis Runtime in Claude Desktop **Chat** (Code, Cowork and the Claude CLI use the marketplace plugin instead). It has **not** been
executed through Claude Desktop yet: the sections marked *check* are how you confirm it worked.
Nothing here publishes, tags or bumps a version.

If Desktop treats the file as the same version, uninstall first rather than relying on an in-place upgrade. Always compare `build.bundleSha256` from `praxis_doctor` with the release notes.

## 0. What changes for you

| Area | Older installed build | This build |
| --- | --- | --- |
| Protected writes (Git, Jira, confirming a Story) | Accepted a bare `confirmation=YES`, or demanded a broker | You approve or reject the exact action in the client's approval dialog; `confirmation=YES` alone is only the agent's request, and a client without the dialog gets the preview and a refusal (nothing is executed) |
| Work items per repository | One; a second `open` silently resumes the first | Many; `workItemId`, `select-work-item`, `link-work-item` |
| Handoffs | Drop `risks`/notes, lose context after one hop | Context carried to every later handoff |
| Blank optional settings | Passed through as the text `${user_config.…}` | Treated as unset |
| Jira settings | Required | Optional |
| `praxis_doctor` | Flags only | `providers`, `approval`, `nextSteps` |

Approval modes: the default is **Approval Required**; the extension setting *Approval mode* can be set to `trusted-client` (explicit opt-in: runs protected actions on the agent's `confirmation=YES` for a current preview, labelled `trusted-client`, never your per-action confirmation). Desktop Chat declared no approval dialog in a real test, so by default protected actions are refused there with the preview. Approvals are yours, in the client: before a commit, push, merge request, Jira write or Story confirmation runs,
Praxis shows you the exact action in the client's own approval dialog (MCP elicitation) and runs it only if you
approve. If your client cannot show that dialog, `praxis_doctor` says so (`approval.mode: no-dialog`) and the
protected action is **not executed**: Praxis returns the preview and a clear message, and nothing the agent says
counts as your approval. Read-only tools keep working. Nothing else needs installing: no service, no system account, no
administrator rights. See `praxis-core/docs/user-approval.md`. If you ever started installing the removed native
Approval Service, see `praxis-core/docs/cleanup-native-approval-service.md`.

## 1. Verify the artifact

```bash
cd /path/to/praxis-runtime
shasum -a 256 claude-extensions/praxis-runtime.mcpb   # must equal "sha256" in claude-extensions/manifest.json
# (the .mcpb is a zip with timestamps, so it is not reproducible byte-for-byte; the runtime inside is, see step 5)
```

## 2. Back up what is installed (do not skip)

```bash
BK=$HOME/praxis-extension-backup-$(date +%Y%m%d-%H%M%S); mkdir -m 700 "$BK"
EXT="$HOME/Library/Application Support/Claude/Claude Extensions"
cp -R "$EXT/local.mcpb.dfuture-co.praxis-runtime" "$BK/extension"
cp "$EXT/../Claude Extensions Settings/local.mcpb.dfuture-co.praxis-runtime.json" "$BK/settings.json"
chmod 600 "$BK/settings.json"   # may contain tokens; keep private
echo "$BK"
```

## 3. Stop old processes

Quit Claude Desktop completely (Cmd-Q). Then confirm nothing from the old build is still running; an
old Quality service can keep port 8792 and answer for the new runtime.

```bash
pgrep -fl "praxis-quality.cjs|praxis-mcp.cjs"   # expect nothing from "Claude Extensions" or an mcpb-unpack temp dir
```

If something is listed, stop it with `kill <pid>` after confirming it is the old Praxis service.

## 4. Remove and install

1. Reopen Claude Desktop → Settings → Extensions → **Praxis Runtime** → Uninstall.
2. Settings → Extensions → Install Extension… → choose `claude-extensions/praxis-runtime.mcpb`.
3. Re-enter any settings you use. All are optional. The old *Security mode*, *Approval broker*, *trust anchor*, *ledger* and *operator page* settings no longer exist.
4. Quit and reopen Claude Desktop.

## 5. Check (this is what proves the new code is the code running)

```bash
INST="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.dfuture-co.praxis-runtime/server"
shasum -a 256 "$INST/praxis-mcp.cjs"        # expect cb31297b43051c49b9dd8ea62e1b0e2684c9d55158e50678dc06861e1e45d82a
grep -c "select-work-item" "$INST/praxis-mcp.cjs"   # expect a number greater than 0
```

In a new chat run **praxis_doctor** for a repository and confirm:

- `providers.jira.state` is `unconfigured` (or your real state), never `configured` for blank settings;
- `hostPlaceholdersIgnored` lists the settings you left blank;
- `approval.mode` is `client-ui` when your client can show the approval dialog, otherwise `no-dialog` (protected actions are then refused);
- `nextSteps` names concrete actions, if any.

Then call **praxis_workflow_status** and confirm the result contains `workItems`. If it does not, the
old runtime is still active; repeat step 3.

## 6. Roll back

Quit Claude Desktop, uninstall the extension, then restore the backup from step 2:

```bash
EXT="$HOME/Library/Application Support/Claude/Claude Extensions"
rm -rf "$EXT/local.mcpb.dfuture-co.praxis-runtime"
cp -R "$BK/extension" "$EXT/local.mcpb.dfuture-co.praxis-runtime"
cp "$BK/settings.json" "$EXT/../Claude Extensions Settings/local.mcpb.dfuture-co.praxis-runtime.json"
```

Restart Claude Desktop. Repositories already written by this build keep a new workflow layout
(`.praxis/workflow/index.json` and `items/`); the old runtime will fail loudly on the tombstone in
`state.json` instead of reading it. Your data is in `items/<id>.json`.

## Claude Code (CLI)

The Claude Code plugin ships the same runtime as `plugins/runtime/server/praxis-mcp.cjs`
(sha256 `cb31297b43051c49b9dd8ea62e1b0e2684c9d55158e50678dc06861e1e45d82a`, byte-identical to the file inside the `.mcpb`). Claude Code shows its own permission prompt per tool call; Praxis marks previews read-only and applies destructive so that prompt can appear.

## Verify the loaded build, not the version string

One version string can name several different runtimes (alpha.47 did). After installing, call `praxis_doctor` in Desktop and read `build`:

| field | expect |
| --- | --- |
| `origin` | `bundle` |
| `bundleSha256` | `cb31297b43051c49b9dd8ea62e1b0e2684c9d55158e50678dc06861e1e45d82a` (the file Desktop is running) |
| `coreBaseline` | `b2edcf3d833b6f082c1371aef067dd65b10e9596` |

Mismatching `bundleSha256` means an older extension is still loaded: fully quit Claude Desktop and reopen.

## Approvals

With a client that supports elicitation, `praxis_doctor` → `approval.mode` is `client-ui` and every protected action is approved or rejected by you in the dialog; the result of the call says so (`data.approval`). `approval.client` shows what your client declared (name, version, protocol, elicitation) and, if there is no dialog, why. With a client that has none, the mode is `no-dialog`: protected actions return `APPROVAL_CLIENT_UI_REQUIRED` with the preview and are not executed. Decisions are journaled outside the repository (`~/.praxis/decisions/`). `npm run accept:approval-ux` (scripted MCP client, both protocol eras) and `npm run accept:claude-code-approval` (the real Claude Code CLI as the client) prove the protocol; neither shows how Claude Desktop renders the dialog (see the Desktop Chat check in `desktop-install/INSTALL.md`).

An optional, weaker mode exists for a host with no dialog (extension setting *Approval without a client dialog*, `host-permission`): see `praxis-core/docs/user-approval.md`. Leave it blank if your client has the dialog.

## This build: 51 tools, inspection, role initialisation

Expected after install (Desktop → ask Praxis Doctor, then list tools):

- **52 MCP tools** (the installed previous build also has 52, but includes `praxis_approval_confirm`; this build removes it and adds the read-only `praxis_approval_plan`): new read-only `praxis_workflow_inspect` (requirements, Stories, decisions, work, handoffs, open items, Quality evidence, links) and `praxis_session_start` (role initialisation without a local script).
- `praxis_developer_status` takes `workItemId` for a local Work Item; `workPackage` accepts only a Work Package id or a Jira key and refuses a Work Item id.
- Role plugins: install the four `praxis-<role>.zip` files from `desktop-install/` (skills: BA 23, Architect 25, Developer 30, Quality 7). Their `session-start` skills call `praxis_session_start`.
- `.mcpb` sha256 `892085e8e125e3608d14e432e886b628f14dc5cca52386fce7ff4ebb2e81a1e4`.

Desktop acceptance is **not** claimed for this build until it has been installed and re-tested on the real Desktop host.

## Chat and Code showed different tools: a stale session registry, not a different server

A Claude session takes its tool list when it starts. After the extension is updated, a session opened earlier keeps
the old list (50 tools) while its calls already reach the new server (the doctor reports the new bundle). Claude
Desktop has one Praxis Runtime server (the MCPB extension); Chat and Code use the same one. `npm run report:tool-origins`
starts every local build and prints bundle sha, build kind, tool count and a digest of the tool names; all of them
offer the same tool set (52 tools in this build; the tool-name digest differs from the installed build). `praxis_doctor` now reports `build.tools` (count, digest, names) and
`build.kind` (`production` for shipped bundles). If a session shows fewer tools than `build.tools.count`, start a
new session; do not reinstall.

## Git writes

Commit, push, merge request, remote connect and identity writes are approved per request in the client dialog (see Approvals). A commit approval is not a push approval, and each approval names one action and the exact content previewed.
