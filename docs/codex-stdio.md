# Experimental Codex stdio setup

The release MCPB contains a Node.js stdio server. A local MCP client can launch that
payload without installing the MCPB in Claude. This is a setup recipe, not a claim
that the complete Praxis workflow has passed acceptance in Codex.

Codex configuration is described in the [official MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Use a temporary project for initial acceptance before connecting a working repository.

## Prepare the release payload

1. Install Node.js >=20, as required by the Runtime manifest.
2. Download `praxis-runtime.mcpb` and `release-meta.json` from the same
   [release](https://github.com/dfg-inc/praxis-runtime/releases). Verify the artifact's
   SHA-256 against its release metadata before running it. Record the version and digest.
3. Extract the MCPB as a ZIP into a stable directory. For example, on macOS or Linux
   with `unzip` installed:

   ```sh
   unzip praxis-runtime.mcpb -d /absolute/path/to/praxis-runtime
   ```

   Keep the complete extracted directory, including:

   ```text
   manifest.json
   LICENSE
   NOTICE
   THIRD-PARTY-NOTICES.md
   server/praxis-mcp.cjs
   server/praxis-quality.cjs
   server/sql-wasm.wasm
   ```

   The Quality worker and its WASM dependency must remain next to the MCP server.
   Copying only `praxis-mcp.cjs` is insufficient for the complete Runtime.

## Configure Codex

In a trusted test project, add the following to `.codex/config.toml`. Replace all
three absolute paths with the actual Node executable, extracted payload and test
repository. This avoids relying on a desktop application's shell PATH.

```toml
[mcp_servers.praxis]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/praxis-runtime/server/praxis-mcp.cjs", "--role", "runtime"]
cwd = "/absolute/path/to/test-repository"

[mcp_servers.praxis.env]
PRAXIS_SKIP_DOTENV = "1"
```

`PRAXIS_SKIP_DOTENV=1` prevents automatic dotenv loading. No Jira or VCS credentials
are needed for local status checks. Claude's `${__dirname}` and `${user_config.*}`
manifest placeholders are resolved by Claude's installer; do not copy those strings
into Codex configuration. Add optional integrations separately using the environment
variables documented in [`.env.praxis.example`](../.env.praxis.example).

Start a new Codex session in that project. `codex mcp get praxis --json` checks the
registered configuration; it does not establish a server connection or call a tool.

### Existing sessions without a refreshed MCP catalog

`tools/scripts/codex-mcp-call.mjs` is a direct stdio fallback using the official MCP
SDK, for a session started before registration. Install this repository's locked
dependencies with `npm ci --ignore-scripts` first. Supply the absolute path to the
complete extracted Runtime payload and an explicit repository on stdin:

```sh
node tools/scripts/codex-mcp-call.mjs --runtime /absolute/runtime/server/praxis-mcp.cjs <<'JSON'
{"repo":"/absolute/repository","tool":"praxis_session_start","arguments":{"role":"developer"}}
JSON
```

The bridge returns the Runtime envelope and a nonzero exit status for refusal or
tool failure. It rejects conflicting repository arguments and does not inherit
tokens, dotenv settings, test approvals or approval-mode overrides. It declares
no approval dialog: protected writes fail with `APPROVAL_CLIENT_UI_REQUIRED`.
It does not substitute for native tool discovery or prove native Codex approval
support. It can inspect the actual project while a host refresh is pending.

Regression coverage launches the shipped MCPB with the official SDK and checks
doctor, preview, refusal without writes, inherited bypass rejection and conflicting
repository rejection:

```sh
npx vitest run tools/scripts/codex-mcp-call.test.mjs
```

## Verify the host before relying on the workflow

Record actual outcomes separately for each step:

1. Discover the server's tools from the Codex session.
2. Call `praxis_doctor` with the explicit test `repo`. Inspect the reported Runtime
   version/build identity, configuration state and `approval.client` capabilities.
3. Call `praxis_session_start` with the same `repo` and `role: "developer"`. Confirm
   the selected repository, `.project` state and loaded rule IDs. A missing
   `knowledge.path` means project knowledge rules have not been applied.
4. In a disposable fixture, verify preview, refusal/cancellation and approval of a
   small protected action. Check that a refused action leaves its target unchanged.
   Record the client/protocol version and the approval channel actually used.

Do not set `PRAXIS_APPROVAL_MODE` to work around a missing host capability. Start
with it unset, including in the environment inherited by Codex. An agent-provided
`confirmation=YES` alone does not establish human approval in the default mode.
If the client lacks the required approval channel, report the Runtime's refusal;
read-only success is not evidence that protected actions work.

## Role skills are a separate integration

An MCP connection exposes tools; it does not install the BA, Architect, Developer
or Quality skills. Their published packages target Claude. Installing or adapting
them for Codex must preserve their supporting files, resolve host-specific paths
and replace host-specific hooks/dialog instructions with validated equivalents.
The [Codex skills guide](https://learn.chatgpt.com/docs/build-skills) describes local
skill discovery, including repository-scoped `.agents/skills`.

Before calling the integration complete, validate a role workflow from requirements
through implementation and Quality evidence in the actual host. Keep untested
steps marked pending, including project initialization and rule loading.
