#!/usr/bin/env bash
# End-to-end check against a deployed Worker: creates a real 2-cell board (a few cents of Workers AI),
# then prints each cell's takes and the board's main history.
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

echo "== creating a 2-cell board (about 20 s)"
BOARD=$(curl -sf -X POST "$STORYBOARD_URL/boards" -H "$AUTH" \
  -d '{"concept":"A beekeeper at dawn discovers one hive has gone completely silent. Quiet, curious.","cells":2}')
echo "$BOARD" | jq -e '.repo' >/dev/null || { echo "$BOARD" >&2; exit 1; }
echo "$BOARD" | jq -c '{repo, title, skills}'
echo "$BOARD" | jq -c '.cells[] | {cell, printed, error, takes: [.takes[]? | {branch, skill, ok: .continuity.ok, issues: .continuity.issues}]}'

REPO=$(echo "$BOARD" | jq -r .repo)
echo "== main"
curl -sf "$STORYBOARD_URL/boards/$REPO/log?limit=10" -H "$AUTH" | jq -r '.[] | "  \(.hash[0:7]) \(.author.name): \(.message | split("\n")[0])"'
echo "UI: $STORYBOARD_URL/#$REPO"
