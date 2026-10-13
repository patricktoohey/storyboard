#!/usr/bin/env bash
# Clone a board (or storyboard-template) from Artifacts with every take branch checked out as a local
# branch, then print a per-take summary: skill version, adherence, continuity verdict.
#
#   STORYBOARD_URL=https://storyboard-spike.<subdomain>.workers.dev scripts/clone-board.sh <repo> [dir]
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
: "${STORYBOARD_URL:?set STORYBOARD_URL to the deployed worker URL}"
REPO=${1:?usage: clone-board.sh <repo> [dir]}
DIR=${2:-boards/$REPO}
AUTH="authorization: Bearer $SPIKE_KEY"

CREDS=$(curl -sf -X POST "$STORYBOARD_URL/boards/$REPO/token" -H "$AUTH")
TOKEN=$(echo "$CREDS" | jq -r .plaintext | sed 's/?expires=.*//')
URL=$(echo "$CREDS" | jq -r .remote)

rm -rf "$DIR"
git clone -q "https://x:$TOKEN@${URL#https://}" "$DIR"
cd "$DIR"
# Don't leave the (short-lived) token in .git/config
git remote set-url origin "$URL"
git -c "http.extraHeader=Authorization: Basic $(printf 'x:%s' "$TOKEN" | base64)" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
for b in $(git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin | grep -v '^HEAD$\|^main$'); do
  git branch -q --track "$b" "origin/$b" 2>/dev/null || true
done

echo "== $REPO ($(pwd))"
# Every branch but the jobs ledger, which the coordinator commits to on each step of each job
git log --graph --exclude=jobs --branches --format='%h %an: %s' -n 40
[ -n "$(git for-each-ref --count=1 'refs/heads/cell/')" ] || exit 0
echo
printf '%-18s %-26s %-9s %s\n' TAKE SKILL ADHERENCE CONTINUITY
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/cell/'); do
  cell=$(echo "$b" | cut -d/ -f2)
  skill=$(git log -1 --format=%B "$b" -- "cells/$cell/prompt.md" | sed -n 's/^Skill: //p')
  adherence=$(git show "$b:cells/$cell/review.json" 2>/dev/null | jq -r '.adherence.score // empty | . * 100 | round / 100')
  continuity=$(git show "$b:cells/$cell/continuity.json" 2>/dev/null | jq -r 'if .ok then "ok" else "BREAK: " + (.issues | join("; ")) end')
  printf '%-18s %-26s %-9s %s\n' "$b" "$skill" "$adherence" "$continuity"
done
