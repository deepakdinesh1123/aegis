#!/usr/bin/env bash
# Build Lambda deployment zips consumed by OpenTofu.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist/lambda"
WEBHOOK_DIR="$DIST/webhook"
WORKER_DIR="$DIST/worker"

rm -rf "$DIST"
mkdir -p "$WEBHOOK_DIR" "$WORKER_DIR"

cd "$ROOT"

npx esbuild src/handlers/webhook.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$WEBHOOK_DIR/index.js"

npx esbuild src/handlers/sqs-lambda.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$WORKER_DIR/index.js"

(
  cd "$WEBHOOK_DIR"
  zip -q -r "$DIST/webhook.zip" index.js
)

(
  cd "$WORKER_DIR"
  zip -q -r "$DIST/worker.zip" index.js
)

echo "Wrote:"
ls -lh "$DIST"/*.zip
