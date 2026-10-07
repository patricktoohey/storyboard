#!/usr/bin/env bash
# One-time setup for a Cloudflare account (safe to re-run). Requires the `cf` CLI, logged in
# (`cf auth login`), on a Workers Paid plan (Artifacts beta).
#
#   scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NAMESPACE=storyboard   # must match bindings.artifacts({ namespace }) in cloudflare.config.ts

echo "== dependencies"
npm install
# workerd downloads its runtime binary in a postinstall script, which npm holds back until approved
npm approve-scripts workerd >/dev/null 2>&1 || true

echo "== artifacts namespace: $NAMESPACE"
if cf artifacts namespaces get "$NAMESPACE" >/dev/null 2>&1; then
  echo "exists"
else
  cf artifacts namespaces create --namespace "$NAMESPACE"
fi

echo "== access key"
if [ -f .env ] && grep -q '^SPIKE_KEY=' .env; then
  echo ".env already has SPIKE_KEY"
else
  echo "SPIKE_KEY=$(openssl rand -hex 16)" >> .env
  echo "wrote SPIKE_KEY to .env (gitignored; uploaded as a Worker secret by deploy.sh)"
fi

echo "== binding types"
cf workers types >/dev/null
echo "done. Next: scripts/deploy.sh"
