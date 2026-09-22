# praxis-runtime

Shared Praxis Runtime Desktop Extension (**MCPB**) and Quality HTTP worker.

GitLab: `engineering/ai-tooling/praxis-runtime`

## Installation (Desktop)

1. Download `praxis-runtime.mcpb` from this project's CI artifacts / release assets.
2. Install in Claude Desktop as a desktop extension.
3. Configure Jira once in Runtime `user_config`.
4. Install role ZIPs from their own repositories (BA / Architect / Developer / Quality).

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
- CI publishes checksums in `dist/mcpb-checksums.json`
- Retention: GitLab job artifacts 30 days (configure releases separately)

## GitLab CI

Jobs: `build_test`, `git_delivery`, `quality_gates`, `pack_mcpb`. Image `node:22-bookworm`. No DinD.
