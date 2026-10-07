# Day 1 spike

The goal is to prove the risky parts end to end before building the real app:

1. A Worker creates an Artifacts repo and pushes commits (text + a JPEG) with isomorphic-git
2. Several agents push **separate branches to the same repo concurrently**
3. Workers AI calls work for the director/cinematographer (LLM), the renderer (flux) and the critic (Clef)

```
POST /boards {"concept": "...", "cells": 3}
  director        -> main:              concept.md, bible.md, storyboard.csv, cells/NN/beat.md
  per cell, all in parallel, each on cell/NN/take-1:
    cinematographer -> cells/NN/prompt.md
    renderer        -> cells/NN/frame.webp, render.json
    critic (Clef)   -> cells/NN/review.json   (adherence score, detected shot size, defects)
```

Every agent commits under its own author name, so `git log` shows who did what.

## Setup (uses the `cf` CLI, no wrangler)

Needs the Workers Paid plan (Artifacts beta).

```sh
cd spike
npm install
npm approve-scripts workerd      # lets workerd download its runtime binary (needed for `cf dev`)
cf artifacts namespaces create --namespace storyboard
echo "SPIKE_KEY=$(openssl rand -hex 16)" > .env   # gitignored
cf deploy --secrets-file .env   # live at https://storyboard-spike.<subdomain>.workers.dev
```

## Try it

```sh
source .env
URL=https://storyboard-spike.<your-subdomain>.workers.dev
AUTH="authorization: Bearer $SPIKE_KEY"

curl -s -X POST $URL/boards -H "$AUTH" \
  -d '{"concept":"A lonely lighthouse keeper finds a message in a bottle written in her own handwriting.","cells":3}' | tee board.json | jq .

REPO=$(jq -r .repo board.json)
curl -s "$URL/boards/$REPO/log?ref=cell/01/take-1" -H "$AUTH" | jq '.[] | {author, message}'
curl -s "$URL/boards/$REPO/file?ref=cell/01/take-1&path=cells/01/frame.webp" -H "$AUTH" -o frame.webp && open frame.webp

# The board is an ordinary Git remote
TOKEN=$(curl -s -X POST $URL/boards/$REPO/token -H "$AUTH" | jq -r .plaintext | sed 's/?expires=.*//')
REMOTE=$(jq -r .remote board.json)
git clone "https://x:$TOKEN@${REMOTE#https://}" /tmp/board && cd /tmp/board
git fetch origin '+refs/heads/*:refs/remotes/origin/*' && git log --graph --all --oneline
```

To swap models, edit the `bindings.text(...)` values in `cloudflare.config.ts`
(e.g. `@cf/moonshotai/kimi-k2.6` for the director).

## What to watch for

- **Concurrent pushes**: every take branch starts from the same main commit. If a push fails,
  the per-cell `error` in the response shows it.
- **CPU and memory**: isomorphic-git hashes and deflates in JS. The CPU limit is raised to
  300 s; watch how many cells one request can handle before you need Queues/Workflows (Day 3).
- **Model output shape**: the director's JSON is parsed leniently. If it fails, try a
  stronger model or switch to `response_format` JSON schema.

## First run (2026-10-07)

A 3-cell board took **13 s** end to end, with all three take branches pushed concurrently and no conflicts.
`git clone` + `git log --graph --all` shows the director's commit on main and three
cinematographer → renderer → critic chains fanning out from it.

- flux-1-schnell: ~1.6 s per frame; its JPEGs are ~750 KB, so the renderer re-encodes them with the Images binding
  (`frame.webp` ~140 KB in Git, a 384px preview of ~18 KB for Clef).
- Clef (27B) with one image: **0.4–0.6 s**, far faster than the launch-day reports. Its `framing`
  answer matched the intended shot size on all 3 cells.
- Lessons: flux-1-schnell has no `seed` input. A full-size image overflows Clef's 64k context
  (~200k estimated tokens), so always send a small preview.
- **Continuity gap, found right away:** cell 03's prompt said only "Emilia's face" and dropped the bible's
  description, so flux drew a child. Clef still rated adherence "Good" because it only saw that cell's
  prompt. That motivates (a) forcing the cinematographer to repeat character descriptions and
  (b) a continuity critic that sees the bible and the neighbouring frames.
