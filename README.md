# praxis-runtime

Shared Praxis Runtime Desktop Extension (**MCPB**) and Quality HTTP worker.

Repository: [github.com/dfg-inc/praxis-runtime](https://github.com/dfg-inc/praxis-runtime)

## Install (Desktop)

1. Open [Releases](https://github.com/dfg-inc/praxis-runtime/releases).
2. Download `praxis-runtime.mcpb` (and `release-meta.json` for SHA-256 / compatibility).
3. Install in Claude Desktop as a desktop extension.
4. Configure Jira once in Runtime `user_config`.
5. Install role ZIPs from their own repository Releases (BA / Architect / Developer / Quality).

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
- Tag `v$package.json.version` → GitHub Actions uploads the MCPB + `release-meta.json` to a GitHub Release
- Version independently of Core / role ZIPs
