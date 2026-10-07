#!/usr/bin/env bash
# Check, deploy, wait for the new version to serve, then make sure the skills template exists.
#
#   scripts/deploy.sh            deploy and add any newly bundled skills to storyboard-template
#   scripts/deploy.sh --reset    also overwrite the template's skills with /skills (an ordinary,
#                                revertable commit on the template; discards skills promoted from boards)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env; run scripts/setup.sh first" >&2; exit 1; }
source .env
RESET=""; [ "${1:-}" = "--reset" ] && RESET="?reset=1"

echo "== check"
cf workers types >/dev/null
npx tsc --noEmit
npm test --silent

echo "== deploy"
OUT=$(cf deploy --secrets-file .env 2>&1 | grep -v 'docker' | tee /dev/stderr)
URL=$(echo "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
VERSION=$(echo "$OUT" | sed -n 's/.*Current Version ID: //p')
[ -n "$URL" ] || { echo "could not find the workers.dev URL in the deploy output" >&2; exit 1; }

# A new version takes a few seconds to reach every location; requests right after deploy can hit the old one
echo "== waiting for $VERSION"
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" = "200" ] && \
    curl -sf "$URL/skills" -H "authorization: Bearer $SPIKE_KEY" >/dev/null && break
  sleep 2
done
sleep 5

echo "== skills template${RESET:+ (reset)}"
curl -sf -X POST "$URL/template$RESET" -H "authorization: Bearer $SPIKE_KEY"; echo
curl -sf "$URL/skills" -H "authorization: Bearer $SPIKE_KEY" | jq -r '.[] | "  \(.name) (\(.role): \(.style)) @\(.version)"'

echo
echo "UI:  $URL/"
echo "Set STORYBOARD_URL=$URL for scripts/clone-board.sh and scripts/smoke.sh"
