# praxis-runtime

Shared Praxis Runtime Desktop Extension (**MCPB**) and Quality HTTP worker.

Repository: [github.com/dfg-inc/praxis-runtime](https://github.com/dfg-inc/praxis-runtime)

## Install

**Claude Code, Desktop Code, Cowork:** use the marketplace: Claude → Customize → Plugins → Add marketplace → `dfg-inc/praxis-marketplace` → **Praxis** → Add. The `praxis-runtime` plugin (this server) is installed with it.

**Claude Desktop Chat** (a plugin's local server is not a Chat tool): install the MCPB.

1. Open [Releases](https://github.com/dfg-inc/praxis-runtime/releases).
2. Download `praxis-runtime.mcpb` (and `release-meta.json` for SHA-256 / compatibility).
3. Install in Claude Desktop (Settings → Extensions). Start a new Chat.
4. Optionally configure Jira, GitHub or GitLab in Runtime settings (every setting is optional; local no-Jira workflows work without them). Leave **Approval mode** empty unless you want [Trusted Client](https://github.com/dfg-inc/praxis-core/blob/master/docs/user-approval.md).
5. Role skills: use the marketplace, or upload the role ZIPs from their repositories' Releases.

## Clone / develop

```bash
git clone https://github.com/dfg-inc/praxis-runtime.git
cd praxis-runtime
npm ci
npm run verify
```

`verify` runs build, typecheck, tests, MCPB pack, Git Delivery E2E, Quality gates, and extracted-MCPB acceptance.

## Core dependencies

Pinned via tracked `vendor/*.tgz`. See `vendor/manifest.json` and [praxis-core DEPENDENCIES.md](https://github.com/dfg-inc/praxis-core/blob/master/DEPENDENCIES.md).

## Release

- Artifact: `dist/claude-extensions/<version>/praxis-runtime.mcpb`
- Tag `v$package.json.version` on GitLab first. After that tag pipeline passes, GitHub Actions uploads the MCPB + `release-meta.json`.
- This repository versions independently of Core and the role ZIPs. `ecosystem.json` records Runtime's version (`policy: independent`).
- A Core update is `node tools/scripts/set-ecosystem-version.mjs --vendor <core-version>` in this repo only, plus the new `vendor/*.tgz` files. It does not release BA, Architect, Developer, or Quality.
