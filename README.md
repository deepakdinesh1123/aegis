# Aegis

GitHub App that keeps default-branch pull requests honest:

- **Merge conflicts** — notifies authors when a PR becomes conflicted (including after another PR merges)
- **File overlap** — warns when open PRs touch the same files, and keeps one updatable comment per PR

Work is **event-driven**: the webhook path only enqueues to SQS; a separate processor consumes jobs and talks to GitHub / DynamoDB.

## Architecture

```text
GitHub ──► webhook (enqueue only) ──► SQS (+ DLQ) ──► worker (process)
                                              │
                                    DynamoDB + GitHub API
```

| Path | Responsibility |
|------|----------------|
| **Webhook** | Verify event, ignore non-default-branch PRs, push a job to SQS |
| **Worker** | Mergeability, conflict comments, file-overlap reports, deferred retries |

Locally this is two Compose services (`webhook` + `worker`) plus DynamoDB Local and ElasticMQ.  
In AWS, OpenTofu deploys API Gateway + two Lambdas + SQS + DynamoDB (see [opentofu/README.md](opentofu/README.md)).

Agent-oriented detail: [AGENTS.md](AGENTS.md).

## Features

- Tracks only PRs targeting the repository **default branch**
- Short mergeability retries; if GitHub still returns `unknown`, enqueues `RetryMergeability`
- Conflict notify once per clean→conflicted transition (`<!-- merge-conflict-bot -->`)
- Overlap ASCII table comment (`<!-- aegis-file-overlap -->`), upserted on sync
- Caches changed files and peer overlap edges so a push does not re-fetch every open PR’s files

## Prerequisites

- Node.js 20+
- Docker / Docker Compose
- A [GitHub App](https://docs.github.com/en/apps) with **Pull requests** read/write (and permission to comment)
- [Smee](https://smee.io) (or similar) for local webhook delivery

## Local setup

```bash
cp .env.example .env
# Fill APP_ID, PRIVATE_KEY, WEBHOOK_SECRET, WEBHOOK_PROXY_URL (smee URL → webhook :3000)

npm install
docker compose --profile app up --build
```

Compose starts:

| Service | Port / role |
|---------|-------------|
| `webhook` | `:3000` — Probot, enqueue only |
| `worker` | ElasticMQ → processor |
| `dynamodb` | `:8000` |
| `elasticmq` | `:9324` (API), `:9325` (UI) |

Point the GitHub App webhook (via Smee) at the **webhook** service, not the worker.

Without Docker for the app itself (infra still needed):

```bash
npm run build
npm run start:webhook   # terminal 1
npm run start:worker    # terminal 2
```

## Tests

```bash
docker compose --profile test up -d dynamodb dynamodb-init elasticmq
npm test
```

Tests use Jest (ESM), nock for GitHub, DynamoDB Local, and ElasticMQ for queue e2e.

## Production

```bash
cd opentofu
cp terraform.tfvars.example secret.tfvars   # APP_ID, PEM, webhook secret
tofu init
tofu apply -var-file=secret.tfvars
tofu output webhook_url                    # set as GitHub App Webhook URL
```

Use `environment = "staging"` (and a distinct DynamoDB table name) for a staging stack with the same files. Full checklist: [opentofu/README.md](opentofu/README.md).

## Useful commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript → `lib/` |
| `npm run start:webhook` | Local queuing service |
| `npm run start:worker` | Local SQS processor |
| `npm test` | Full test suite |
| `npm run package:lambda` | Bundle Lambda zips for AWS |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 deepakdinesh1123
