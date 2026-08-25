# @praxis/quality-service

Quality service for MR reviews, codebase audits, and rollback/return metrics (WBS 6.x).

## Status

**EXTERNAL ROLLOUT BLOCKED** without a legacy/deploy target and ops ownership. Local/dev use only until Epic 6 rollout criteria are met.

## Storage

Uses Node.js `node:sqlite` (`DatabaseSync`) — portable on Node 22+, no native addon build.

Tables: `reviews`, `audits`, `rollback_events`, `return_events`.

## CLI

```bash
praxis-quality review --mr <ref> [--project <id>]
praxis-quality review-path --path <repo> [--handoff <json>] [--project <id>]
praxis-quality audit --path <repo> [--project <id>]
praxis-quality report --project <id>
praxis-quality metrics [--project <id>]
```

Env: `PRAXIS_QUALITY_DB` (see root `.env.example`).

## HTTP

- `GET /health`
- `GET /metrics?project=<id>`

## Docker

See root `docker-compose.yml` service `quality-service`.
