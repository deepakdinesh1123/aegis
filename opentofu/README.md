# OpenTofu — production deploy for Aegis

Deploys the split Lambda architecture:

```text
GitHub ──POST /webhook──► API Gateway ──► webhook Lambda (enqueue only)
                                              │
                                              ▼
                                           SQS (+ DLQ)
                                              │
                                              ▼
                                      worker Lambda (process)
                                              │
                                              ▼
                                    DynamoDB + GitHub API
```

## Prerequisites

1. [OpenTofu](https://opentofu.org/) `>= 1.6` (`tofu` CLI)
2. AWS credentials with rights to create Lambda, API Gateway, SQS, DynamoDB, IAM, Secrets Manager, CloudWatch Logs
3. Node.js 20+ and `zip` (for Lambda packaging during apply)
4. A GitHub App (`APP_ID`, private key PEM, webhook secret)

## One-time setup

```bash
cd opentofu
cp terraform.tfvars.example secret.tfvars
# Edit secret.tfvars with real APP_ID, PRIVATE_KEY, WEBHOOK_SECRET

tofu init
tofu plan  -var-file=secret.tfvars
tofu apply -var-file=secret.tfvars
```

Apply packages both Lambdas automatically (`scripts/package-lambdas.sh`), then creates all AWS resources.

## After apply

```bash
tofu output webhook_url
```

In the GitHub App settings:

1. **Webhook URL** = `webhook_url` output (ends with `/webhook`)
2. **Webhook secret** = same value as `github_webhook_secret`
3. Subscribe to **Pull request** events
4. Install the app on the org/repos you want Aegis to watch

Remove any Smee / local proxy URL for production.

## What this stack creates

| Resource | Purpose |
|----------|---------|
| HTTP API Gateway `POST /webhook` | Public GitHub webhook endpoint |
| Lambda `…-webhook` | Verify signature, enqueue SQS job |
| SQS queue + DLQ | Event bus / poison messages |
| Lambda `…-worker` | SQS event source mapping → process jobs |
| DynamoDB `pull-request-state` | PR mergeability + overlap state |
| Secrets Manager secret | `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` |
| IAM roles/policies | Least-privilege for each Lambda |
| CloudWatch log groups | Webhook, worker, API access logs |

## Updating code

```bash
# From repo root — or just re-apply; tofu re-packages when src/ changes
npm run package:lambda
cd opentofu && tofu apply -var-file=secret.tfvars
```

## Optional: remote state

Uncomment the `backend "s3"` block in `versions.tf` and create the bucket before `tofu init`.

## Destroy

```bash
tofu destroy -var-file=secret.tfvars
```

Note: DynamoDB table is destroyed with the stack. Export data first if you need it.
