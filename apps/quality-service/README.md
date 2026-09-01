# @praxis/quality-service

Quality service for MR reviews, codebase audits, and rollback/return metrics (WBS 6.x).

## Status

**EXTERNAL ROLLOUT BLOCKED** without a legacy/deploy target and ops ownership. Local/dev use only until Epic 6 rollout criteria are met.

## Storage

Uses Node.js `node:sqlite` (`DatabaseSync`) — portable on Node 22+, no native addon build.

Tables: `reviews`, `audits`, `rollback_events`, `return_events`, `task_completions`.

Env: `PRAXIS_QUALITY_DB` (default for CLI: `.praxis-quality/quality.sqlite`).

## CLI

```bash
praxis-quality review --mr <ref> [--project <id>]
praxis-quality review-path --path <repo> [--handoff <json>] [--project <id>]
praxis-quality audit --path <repo> [--project <id>]
praxis-quality report --project <id>
praxis-quality metrics [--project <id>]
```

`review-path` and HTTP `POST /reviews/path` share the same review engine and persistence.

## HTTP

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness |
| `GET` | `/metrics?project=<id>` | Aggregate metrics |
| `POST` | `/reviews/path` | Run path review from Developer handoff |
| `GET` | `/reviews/:id` | Retrieve persisted review |

### `POST /reviews/path`

Request:

```json
{
  "projectId": "<project id>",
  "path": "<repository path>",
  "handoff": { "...": "developer.quality.handoff" }
}
```

Behavior:

1. Validate request shape
2. Validate handoff with `DeveloperToQualityHandoffSchema` (`@praxis/contracts`)
3. Require verification readiness (required checks `passed`)
4. Enforce `PRAXIS_QUALITY_ALLOWED_ROOT` (path must resolve inside it)
5. Run the same `reviewPath` engine as CLI (discovery, acceptance, npm test rerun)
6. Persist review + audit in SQLite
7. Return:

```json
{
  "reviewId": 1,
  "projectId": "...",
  "workPackageId": "...",
  "verdict": "pass|fail",
  "findings": []
}
```

Contract/request errors → **4xx** JSON `{ error, message }`.  
A completed review with failing code/acceptance checks → **200** with `verdict: "fail"`.

### Path security

`PRAXIS_QUALITY_ALLOWED_ROOT` — required for HTTP path reviews. Requested `path` is canonicalized and must stay under this root (traversal / outside-root → 400).

Example (external acceptance):

```bash
export PRAXIS_QUALITY_ALLOWED_ROOT=/Users/serg/work/praxis-acceptance
export PRAXIS_QUALITY_DB=/tmp/praxis-quality.sqlite
export PORT=8787
npm run start -w @praxis/quality-service
```

## Env

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP listen port (default `8787`) |
| `PRAXIS_QUALITY_DB` | SQLite file path |
| `PRAXIS_QUALITY_ALLOWED_ROOT` | Allowed filesystem root for path reviews |

## Docker

```bash
docker compose up --build quality-service
```

Compose mounts host `${PRAXIS_QUALITY_HOST_ROOT:-.}` at `/work` and sets `PRAXIS_QUALITY_ALLOWED_ROOT=/work`. Override `PRAXIS_QUALITY_HOST_ROOT` to your acceptance tree (e.g. `/Users/serg/work/praxis-acceptance`).

Reviews persist under the `quality-data` volume (`PRAXIS_QUALITY_DB=/data/quality.sqlite`) across restarts.
