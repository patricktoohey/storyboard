#!/usr/bin/env bash
# End-to-end check against a deployed Worker: creates a real 2-cell board (a few cents of Workers AI),
# waits for its queued jobs to print the first cut, then prints the jobs ledger and main's history.
#
#   STORYBOARD_URL=https://storyboard-spike.<subdomain>.workers.dev scripts/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
: "${STORYBOARD_URL:?set STORYBOARD_URL to the deployed worker URL}"
AUTH="authorization: Bearer $SPIKE_KEY"

echo "== unauthenticated request is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$STORYBOARD_URL/boards")
[ "$code" = "401" ] || { echo "expected 401, got $code" >&2; exit 1; }

echo "== creating a 2-cell board (returns at once; the work runs as queued jobs)"
BOARD=$(curl -sf -X POST "$STORYBOARD_URL/boards" -H "$AUTH" -H "user-agent: storyboard-smoke" \
  -d '{"concept":"A beekeeper at dawn discovers one hive has gone completely silent. Quiet, curious.","cells":2}')
echo "$BOARD" | jq -e '.repo' >/dev/null || { echo "$BOARD" >&2; exit 1; }
REPO=$(echo "$BOARD" | jq -r .repo)
echo "   $REPO"

echo "== waiting for the first-cut print (up to 4 minutes)"
for _ in $(seq 1 80); do
  sleep 3
  JOBS=$(curl -sf "$STORYBOARD_URL/boards/$REPO/jobs" -H "$AUTH" -H "user-agent: storyboard-smoke" || echo '[]')
  printf '%s' "$JOBS" | jq -e '[.[] | select(.kind == "print" and .status == "done")] | length > 0' >/dev/null && break
  printf '%s' "$JOBS" | jq -e '[.[] | select(.kind == "board" and .status == "failed")] | length > 0' >/dev/null && break
done
printf '%s' "$JOBS" | jq -r 'reverse | .[] | "  \(.kind) \(.cell) \(.take) \(.status): \(.detail)"'
printf '%s' "$JOBS" | jq -e '[.[] | select(.kind == "print" and .status == "done")] | length > 0' >/dev/null || { echo "no first cut printed" >&2; exit 1; }

echo "== main"
curl -sf "$STORYBOARD_URL/boards/$REPO/log?limit=10" -H "$AUTH" | jq -r '.[] | "  \(.hash[0:7]) \(.author.name): \(.message | split("\n")[0])"'
echo "UI: $STORYBOARD_URL/#$REPO"
