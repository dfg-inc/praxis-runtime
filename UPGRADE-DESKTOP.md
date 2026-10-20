# Upgrading the Claude Desktop extension (local build)

This procedure installs the locally built `claude-extensions/praxis-runtime.mcpb` over an older
Praxis Runtime. It was written for the build packed from praxis-core `83d2953` and has **not** been
executed through Claude Desktop yet: the sections marked *check* are how you confirm it worked.
Nothing here publishes, tags or bumps a version.

The version string is still `0.1.0-alpha.47`, so Desktop may treat the new file as the same version.
Uninstall first rather than relying on an in-place upgrade.

## 0. What changes for you

| Area | Older installed build | This build |
| --- | --- | --- |
| Local workflow write (`praxis_workflow_apply`) | Accepts a bare `confirmation=YES` | Refused with `APPROVAL_REQUIRED` in the default `secure` mode |
| Work items per repository | One; a second `open` silently resumes the first | Many; `workItemId`, `select-work-item`, `link-work-item` |
| Handoffs | Drop `risks`/notes, lose context after one hop | Context carried to every later handoff |
| Blank optional settings | Passed through as the text `${user_config.…}` | Treated as unset |
| Jira settings | Required | Optional |
| `praxis_doctor` | Flags only | `providers`, `security`, `nextSteps` |

Secure mode means a write needs a stored, fingerprint-bound approval. A Desktop extension runs as the
same user as the agent, so it cannot provide the broker's isolation by itself. Until you set up the
operator approval path (see `praxis-core/tools/broker/README.md`), local workflow writes will be
refused. Setting `security_mode` to `compatibility` allows single-user local work without a signed
approval; it is **not** a security boundary, and `praxis_doctor` will say so.

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
3. Re-enter any settings you use. All are optional. Leave **Security mode** blank for `secure`.
4. Quit and reopen Claude Desktop.

## 5. Check (this is what proves the new code is the code running)

```bash
INST="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.dfuture-co.praxis-runtime/server"
shasum -a 256 "$INST/praxis-mcp.cjs"        # expect 8af00e41cdea45887394f1291ffc75d504b498efec31412ba63c7e8315651f32
grep -c "select-work-item" "$INST/praxis-mcp.cjs"   # expect a number greater than 0
```

In a new chat run **praxis_doctor** for a repository and confirm:

- `providers.jira.state` is `unconfigured` (or your real state), never `configured` for blank settings;
- `hostPlaceholdersIgnored` lists the settings you left blank;
- `security.mode` is what you chose (`secure` when blank);
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
(sha256 `8af00e41cdea45887394f1291ffc75d504b498efec31412ba63c7e8315651f32`, byte-identical to the file inside the `.mcpb`). Its `.mcp.json` already defaults
`PRAXIS_SECURITY_MODE` to `secure`.

## Verify the loaded build, not the version string

`0.1.0-alpha.47` names several different runtimes. After installing, call `praxis_doctor` in Desktop and read `build`:

| field | expect |
| --- | --- |
| `origin` | `bundle` |
| `bundleSha256` | `8af00e41cdea45887394f1291ffc75d504b498efec31412ba63c7e8315651f32` (the file Desktop is running) |
| `coreBaseline` | `b19fb012a69b73ee5d2456159f72ad575e8fdea2` |
| `sourceDigest` | `5c28693964872892e072b8632793a89e20991df8a5d902cdb94fe54a216d5c34` |

Mismatching `bundleSha256` means an older extension is still loaded: fully quit Claude Desktop and reopen.

## Human approvals (secure mode)

Optional extension settings: *Approval broker shared folder*, *Approval trust anchor*, *Approval ledger path*, *Operator approval page URL*. They are only meaningful when a broker runs under a **different OS identity** than the one running Claude Desktop. `praxis_doctor` → `security` reports whether that holds. On a same-user host, or one where the agent can drive Docker, it reports the approval path as not isolated and Praxis writes stay refused. That is the intended outcome, not a fault to work around.

## This build: 52 tools, inspection, role initialisation

Expected after install (Desktop → ask Praxis Doctor, then list tools):

- **52 MCP tools** (50 before): new read-only `praxis_workflow_inspect` (requirements, Stories, decisions, work, handoffs, open items, Quality evidence, links) and `praxis_session_start` (role initialisation without a local script).
- `praxis_developer_status` takes `workItemId` for a local Work Item; `workPackage` accepts only a Work Package id or a Jira key and refuses a Work Item id.
- Role plugins: install the four `praxis-<role>.zip` files from `desktop-install/` (skills: BA 23, Architect 25, Developer 30, Quality 7). Their `session-start` skills call `praxis_session_start`.
- `.mcpb` sha256 `653b27c456932713782629fc49831f05fc122eab67cdf91b75eaa201733ba52a`.

Desktop acceptance is **not** claimed for this build until it has been installed and re-tested on the real Desktop host.
