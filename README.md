# praxis-runtime

Shared Praxis Runtime Desktop Extension (**MCPB**) and Quality HTTP worker.

GitLab: `engineering/ai-tooling/praxis-runtime`

## Installation (Desktop)

1. Open [praxis-runtime Releases](https://gl.jetru.by/engineering/ai-tooling/praxis-runtime/-/releases) while signed into GitLab.
2. Download `praxis-runtime.mcpb` for the version you need (plus `release-meta.json` for SHA-256 / compatibility).
3. Install in Claude Desktop as a desktop extension.
4. Configure Jira once in Runtime `user_config`.
5. Install role ZIPs from their own repository Releases (BA / Architect / Developer / Quality).

Do not use ephemeral CI job artifacts for ordinary installation.


## Development

```bash
npm ci
npm run verify
```

`verify` runs build, typecheck, tests, MCPB pack, Git Delivery E2E, Quality gates, and extracted-MCPB acceptance.

## Core dependencies

Pinned via tracked `vendor/*.tgz` (`@praxis/contracts`, `project-config`, `knowledge`, `jira`, `vcs`, `cli`). See `vendor/manifest.json` and [praxis-core DEPENDENCIES.md](https://gl.jetru.by/engineering/ai-tooling/praxis-core/-/blob/master/DEPENDENCIES.md).

## Testing

- `accept:git-delivery` / `accept:git-delivery-e2e`
- Quality: `accept:quality-*`
- `accept:mcpb-runtime` (extracted MCPB)

## Release

- Artifact: `dist/claude-extensions/<version>/praxis-runtime.mcpb`
- Version independently of Core / role ZIPs
- Tag `v$package.json.version` → CI uploads Generic Package Registry + creates GitLab Release
- Metadata: `release-meta.json` (version, source SHA, SHA-256, Core vendor pins)
- Job artifacts remain for CI handoff only (30 days); install from **Releases**


## GitLab CI

Jobs: `build_test`, `git_delivery`, `quality_gates`, `pack_mcpb`, and on tags `publish_release`. Image `node:22-bookworm`. No DinD.

