# AGENTS.md — Aegis

Agent context for working in this repository. Prefer this file over inferring architecture from chat history.

## What this repo is

**Aegis** is a GitHub App that:

1. Tracks PR mergeability for PRs targeting the **default branch only**
2. Notifies authors when a PR becomes conflicted (especially after another PR merges)
3. Warns about **overlapping changed files** across open PRs on the same default branch

It is event-driven: webhooks only **enqueue** work to SQS; a separate **processor** consumes messages and calls the GitHub API / DynamoDB.

Repo: TypeScript (ESM, NodeNext), Probot (local webhook path), AWS Lambda handlers (prod), DynamoDB, SQS (ElasticMQ locally).

---

## Architecture

```text
GitHub webhook
      │
      ▼
┌─────────────────────┐
│  Queuing path       │  Verify (prod) / Probot (local)
│  enqueue only       │  Filter: default-branch PRs only
└──────────┬──────────┘
           │ SendMessage
           ▼
┌─────────────────────┐
│  SQS (+ DLQ)        │  ElasticMQ locally / AWS SQS in prod
│  aegis-events       │
└──────────┬──────────┘
           │ SQS trigger (prod) / worker poller (local)
           ▼
┌─────────────────────┐
│  Processor          │  Auth via APP_ID + PRIVATE_KEY + installation_id
│  lifecycle / overlap│  DynamoDB state + GitHub API comments
└─────────────────────┘
```

### Two runtimes (do not merge them)

| Role | Local | Production |
|------|--------|------------|
| **Queue** | `webhook` compose service → `probot run ./lib/index.js` | API Gateway `POST /webhook` → `handlers/webhook` Lambda |
| **Process** | `worker` compose service → `local/worker-poller.js` | SQS event source → `handlers/sqs-lambda` Lambda |

- Webhook path **never** processes mergeability/overlap work.
- Worker path **never** receives the raw webhook; it gets typed SQS jobs that include `installation_id`.
- Local worker long-polls ElasticMQ only to **simulate** SQS→Lambda batch invokes. In AWS, one Lambda invocation handles one batch and exits; it does not drain the whole queue alone.

### Auth (worker)

1. Webhook copies `payload.installation.id` onto every job.
2. Worker uses `APP_ID` + `PRIVATE_KEY` + `installation_id` via `@octokit/auth-app` (`src/github/app-octokit.ts`) to mint an installation token.
3. Follow-up jobs (`RetryMergeability`, `ReevaluateOverlap`) forward the same `installation_id`.

### Persistence

- **DynamoDB** table `pull-request-state` (keys: `repository` HASH, `pull_request_number` RANGE).
- Local: DynamoDB Local on `:8000`. Prod: provisioned by OpenTofu.
- No `DYNAMODB_ENDPOINT` / `SQS_ENDPOINT` in prod (real AWS endpoints).

---

## Features and business logic

### Scope gate

Only PRs whose `base.ref === repository.default_branch` are enqueued or processed. Feature branches targeting non-default bases are ignored.

### Merge conflict detection

- On open/reopen/sync: refresh PR mergeability (short in-handler retries in `src/mergeability.ts`).
- If still `mergeable === null`: **do not** invent state; enqueue `RetryMergeability` with backoff delay.
- On **merged** PR into default branch: list open PRs on that base; for each with prior `mergeable === true` that is now `false`, notify the author once.
- Notification flags: `conflict_notified` / `conflict_comment_id` stick while conflicted; **clear when clean again** so a later clean→conflicted transition can notify again.
- Stale conflict comments (marker `<!-- merge-conflict-bot -->`) are deleted before posting a fresh one.
- Closed PRs are **marked** `status: "closed"` in DynamoDB (not deleted) and skipped on later scans.

### File overlap warning

- Compare this PR’s changed files to other open PRs on the same base.
- Post/upsert one comment marked `<!-- aegis-file-overlap -->` with an ASCII table (🔴 ≥2 shared files, 🟠 1 file).
- Create comment only when overlaps exist; if overlaps clear and a comment exists, **update** it (do not spam new comments).
- Cache `changed_files` + `changed_files_sha` on `PullRequestState`. Refetch from GitHub only when cache missing or head SHA differs.
- Maintain `overlapping_pr_numbers` (bidirectional). On sync/open of PR A, enqueue `ReevaluateOverlap` for `union(oldPeers, newPeers)` so peers refresh efficiently without full scrapes when caches are warm.
- On close of A: clear edges and re-evaluate former peers.

### SQS job types (`src/queue/messages.ts`)

| Type | Purpose |
|------|---------|
| `PullRequestLifecycle` | `opened` \| `reopened` \| `synchronize` \| `closed` |
| `RetryMergeability` | Deferred mergeability after unknown API result |
| `ReevaluateOverlap` | Refresh one PR’s overlap comment (usually a peer) |

---

## Events handled

GitHub App should subscribe to **`pull_request`** with actions:

| Action | Enqueued? | Processor behavior |
|--------|-----------|--------------------|
| `opened` | Yes (default branch) | Refresh state, overlap report, peer re-eval jobs |
| `reopened` | Yes | Same as opened |
| `synchronize` | Yes | Same; drives overlap reverse re-eval |
| `closed` | Yes | Mark closed; if merged into default → conflict scan of open PRs; peer overlap cleanup |
| Other PR actions | No | Ignored at enqueue |

Non-default-branch PRs are skipped at enqueue (and again in the processor).

---

## Folder structure

```text
aegis/
├── src/
│   ├── index.ts                 # Probot webhook entry: enqueue only
│   ├── enqueue.ts               # Webhook → PullRequestLifecycle job
│   ├── types.ts                 # PullRequestState
│   ├── state.ts                 # DynamoDB get/put/delete
│   ├── github.ts                # AppContext, refresh, notify, conflict comments
│   ├── mergeability.ts          # Fetch PR + short mergeability retries
│   ├── overlap.ts               # File list cache, overlap table, upsert comment
│   ├── concurrency.ts           # mapWithConcurrency
│   ├── handlers/
│   │   ├── webhook.ts           # API Gateway Lambda (prod queue path)
│   │   ├── sqs-lambda.ts        # SQS-triggered Lambda (prod process path)
│   │   └── worker.ts            # Job dispatch (shared)
│   ├── processor/
│   │   ├── lifecycle.ts         # Lifecycle / retry / merge-conflict scan
│   │   └── overlap.ts           # Overlap index + peer re-eval enqueue
│   ├── queue/
│   │   ├── messages.ts          # Job types + retry delay helpers
│   │   ├── sqs.ts               # SQS client (endpoint-aware for ElasticMQ)
│   │   └── poller.ts            # Test/local drain helpers (processor side only)
│   ├── github/
│   │   ├── app-octokit.ts       # Installation Octokit for worker
│   │   └── context.ts           # AppContext from octokit + repo
│   └── local/
│       └── worker-poller.ts     # Local ElasticMQ → sqs-lambda adapter
├── test/                        # Jest ESM tests + helpers + fixtures
├── opentofu/                    # Prod AWS (API GW, Lambdas, SQS, DDB, secrets)
├── scripts/package-lambdas.sh   # esbuild + zip for OpenTofu
├── docker-compose.yml           # webhook + worker + dynamodb + elasticmq
├── elasticmq.conf
└── package.json
```

Compiled output: `lib/` (`tsc`). Lambda bundles: `dist/lambda/*.zip` (gitignored).

---

## Folder / module ownership (edit guidance)

| Change | Touch |
|--------|--------|
| Webhook filtering / enqueue payload | `enqueue.ts`, optionally `handlers/webhook.ts` |
| Job schema | `queue/messages.ts` + processors + tests |
| Mergeability / conflict comments | `mergeability.ts`, `github.ts`, `processor/lifecycle.ts` |
| Overlap table / cache / reverse index | `overlap.ts`, `processor/overlap.ts` |
| DynamoDB shape | `types.ts`, `state.ts`, OpenTofu `dynamodb.tf`, test helpers |
| Local dual-service wiring | `docker-compose.yml`, `local/worker-poller.ts`, `index.ts` |
| Prod deploy | `opentofu/*`, `scripts/package-lambdas.sh` |

---

## Test strategy

- **Runner:** Jest ESM (`jest.config.mjs`), `maxWorkers: 1` (shared DynamoDB Local).
- **Command:** `npm test` (sets DynamoDB + ElasticMQ env; enables localhost net for nock).
- **Infra required for full suite:** DynamoDB Local `:8000` and ElasticMQ `:9324` (`docker compose --profile test up -d dynamodb elasticmq dynamodb-init`).

### Layers

| Suite | Focus |
|-------|--------|
| `test/index.test.ts` | Probot receive → enqueue only (no processing) |
| `test/queue.e2e.test.ts` | Full queue behavior: default-branch filter, worker lifecycle, RetryMergeability, peer overlap re-eval, merge→conflict notify |
| `test/overlap.test.ts` | Table formatting, cache hits, upsert create/update |
| `test/github.test.ts` / `mergeability.test.ts` / `state.test.ts` / `concurrency.test.ts` | Unit / focused integration |

### Conventions

- Nock GitHub (`api.github.com`); `enableNetConnect` for `localhost` / `127.0.0.1` only.
- Import `jest` from `@jest/globals` in ESM tests.
- Queue helpers: `test/helpers/sqs.ts` (`resetQueue`, `processUntilEmpty`, `staticAuth`).
- Prefer injecting fast `sleep` / `maxAttempts` for mergeability deferral tests (default delay is 2s × retries).
- Do **not** process work inside webhook handlers in tests that assert enqueue-only behavior; invoke the processor explicitly for end-to-end cases.

---

## Coding standards

- **TypeScript ESM:** `module`/`moduleResolution` `NodeNext`; import with `.js` extensions in source.
- **Strict:** `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`.
- **AppContext:** Use narrow `AppContext` from `github.ts` — avoid exploding Probot `Context<>` unions (TS2590).
- **PR number:** Use `context.pullRequest().pull_number` / job fields — **not** `context.issue().number` (that is `issue_number`).
- **Repo helpers:** Prefer `context.repo()` for `{ owner, repo }`.
- **Secrets:** Never commit `.env`, PEMs, or `opentofu/secret.tfvars`. `.env` is gitignored.
- **Comments:** Markers distinguish bot comments — conflict `<!-- merge-conflict-bot -->`, overlap `<!-- aegis-file-overlap -->`. Upsert/update; do not spam duplicates on sync.
- **Preserve state fields:** When rewriting `PullRequestState`, keep `overlap_comment_id`, `changed_files*`, `overlapping_pr_numbers`, conflict notification fields unless intentionally clearing.
- **Concurrency:** Use `mapWithConcurrency` for fan-out GitHub calls; do not unbounded `Promise.all` on large PR lists.
- **Prod vs local env:** Local sets `DYNAMODB_ENDPOINT` / `SQS_ENDPOINT` + dummy AWS keys. Prod Lambdas omit those endpoints.
- **Commits:** Prefer author `deepakdinesh1123` / `d.deepakdinesh13@gmail.com`; no Cursor co-author trailers unless the user asks.

---

## Local run

```bash
docker compose --profile app up --build
# webhook :3000 (Probot + smee via WEBHOOK_PROXY_URL)
# worker long-polls ElasticMQ
# dynamodb :8000, elasticmq :9324
```

Env template: `.env.example`. Required: `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, DynamoDB/SQS URLs as in compose.

---

## Production (OpenTofu)

See `opentofu/README.md`.

```bash
cd opentofu
cp terraform.tfvars.example secret.tfvars  # fill secrets
tofu init && tofu apply -var-file=secret.tfvars
tofu output webhook_url   # set as GitHub App webhook URL
```

Stack: API Gateway → webhook Lambda → SQS+DLQ → worker Lambda; DynamoDB; Secrets Manager; IAM.

Lambda zips built by `npm run package:lambda` (also triggered on apply via `terraform_data`).

---

## Implementation hazards (common mistakes)

- Do not process GitHub work inside the webhook/Probot handlers — enqueue only.
- Do not put an SQS poller inside the webhook process.
- Do not track non-default-branch PRs “for completeness” without an explicit product change.
- Do not leave `mergeable: null` written as if known; use `RetryMergeability`.
- Do not forget to reset `conflict_notified` when a PR becomes mergeable again.
- Do not refetch every open PR’s files on every sync when `changed_files_sha` matches.
- Do not create a new overlap comment on every synchronize — update `overlap_comment_id`.
- Worker auth needs `installation_id` on the job; omitting it breaks Octokit installation auth.
- Do not leave a closed PR listed in peer overlap comments — on close, detach overlap edges and refresh peer comments inline.
- SQS visibility timeout must be ≥ worker Lambda timeout (enforced in OpenTofu variables).
- Stop local `worker` / Compose app profile when running `npm test`, or ElasticMQ messages will be consumed outside Jest.

---

## Key commands

| Command | Purpose |
|---------|---------|
| `npm run build` | `tsc` → `lib/` |
| `npm start` / `start:webhook` | Local queuing service (Probot) |
| `npm run start:worker` | Local processor (ElasticMQ adapter) |
| `npm test` | Jest suite |
| `npm run package:lambda` | Bundle webhook/worker zips for AWS |
| `docker compose --profile app up --build` | Full local stack |
| `docker compose --profile test up -d dynamodb elasticmq dynamodb-init` | Test deps only |
