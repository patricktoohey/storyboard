# Day 1 spike

The goal is to prove the risky parts end to end before building the real app:

1. A Worker creates an Artifacts repo and pushes commits (text + a JPEG) with isomorphic-git
2. Several agents push **separate branches to the same repo concurrently**
3. Workers AI calls work for the director/cinematographer (LLM), the renderer (flux) and the critic (Clef)

```
POST /boards {"concept": "...", "cells": 3}
  director        -> main: concept.md, bible.md, characters.json, storyboard.csv, cells/NN/beat.md
  casting         -> main: bible/refs/<name>.webp   (one neutral portrait per character, in parallel)
  per cell, all in parallel, each on cell/NN/take-1:
    cinematographer -> cells/NN/prompt.md       ({{Name}} placeholders replaced by the bible look, verbatim)
    renderer        -> cells/NN/frame.webp, render.json   (flux-2-klein-9b, portraits as references for MS/CU)
    critic (Clef)   -> cells/NN/review.json     (adherence score, detected shot size, defects)
    continuity      -> cells/NN/continuity.json (age, look, identity vs portrait, framing vs plan)
  any cell failing continuity -> one automatic retake on cell/NN/take-2, briefed with the issues
```

Every agent commits under its own author name, so `git log` shows who did what.

## Jobs and the ledger (Day 3, tested 2026-10-07)

Creating a board, retaking a cell and acting on a note now return in 2 to 4 s; the work runs as queued
jobs and the UI follows it in the jobs feed. The coordinator's state is `jobs.csv` on each board's `jobs`
branch; every queue, progress and outcome change is a commit. To replay a production:

```sh
scripts/clone-board.sh <repo> && cd boards/<repo>
git log --reverse --format='%s' origin/jobs     # Queue 1 job / ▶ board: director planning / ...
git log -p origin/jobs -- jobs.csv             # every status change as a diff
```

| Run | Result |
|---|---|
| 4 cells, first version | takes ran almost one at a time; 2 jobs died (shared isomorphic-git locks across invocations); no print |
| 4 cells, per-tree paths + concurrent batches | 90 s end to end; 1 take failed losing 8 ledger races on a progress report |
| 6 cells, best-effort progress | 79 s: directing, casting, 6 takes in parallel, 3 automatic retakes, first-cut print; no failures |
| Lost job on the subway board | cron sweep failed it at 17:25; the first cut printed 10 s later |

Setup adds the queue (`cf queues create --queue-name storyboard-jobs`); the cron sweep runs every 5
minutes and on `POST /sweep`.

## Video (tested 2026-10-07)

**Make video** on a board (`POST /boards/:repo/cut`) animates each printed frame with
`alibaba/wan-2.7-i2v` (720P, the cell's duration capped by `VIDEO_MAX_SECONDS`, ~$0.10 per second) and
assembles the clips into the `cut/vN` branch with `video/edl.csv`; the UI plays the cut in EDL order.
Clips take about 5 minutes each to render (in parallel), so a cut is ready in roughly 6 minutes.
See docs/decisions.md D17 and D18.

## Review UI

Open the Worker URL (`https://storyboard-spike.<subdomain>.workers.dev/`) and paste `SPIKE_KEY` from
`.env` when asked; it's kept in that browser's localStorage. The UI lists boards, creates new ones
(with a cinematographer style), and for each cell shows the printed frame, every take as a thumbnail
(green/red dot = continuity ok/break, ★ = printed), the prompt, continuity issues, and the cell's notes.
Per cell you can **print** a take, **retake** in any style, or **send a note**. The sidebar is `main`'s
git log, so you can watch the agents commit.

## Notes, printing, styles (Day 2/3, tested 2026-10-07)

- **Notes** (`POST /boards/:repo/cells/:id/notes`): the note is committed to `cells/NN/notes.md` on main,
  then Clef-flash routes it: `reseed` (same prompt, new render), `rewrite_prompt` (cinematographer
  redoes this cell), `edit_bible` (director revises bible/characters, casting recasts changed characters,
  Clef-flash picks the affected cells, which re-shoot in parallel), or `no_op`. Every later take of a cell
  is briefed with all of that cell's notes, so a bible change doesn't undo "shoot from the back seat".
- **Printing** (`POST .../print {"take": 2}`) merges the take branch into main (cell files + the
  `storyboard.csv` status). A new board ends with one octopus merge, "Print first cut".
- **Styles**: several skills can fill a role (`metadata.role`); `cinematographer-noir` and
  `cinematographer-documentary` ship alongside the classic one. `board.json` holds each board's choice
  (`POST .../roles/:role`), and any take can use another style (`{"skill": "cinematographer-noir"}`).

Run on the noir test board ("Night Drive"):

| Action | Result |
|---|---|
| Two notes sent at once, on cells 04 and 02 | Both landed on main; no lost commits |
| "Shoot this from the back seat, over the passenger's shoulder…" | `rewrite_prompt` p=0.89, new take in 8 s |
| "The driver should be older, late fifties, grey hair in a bun" | `edit_bible` p=0.80; bible + characters revised; Driver recast; blast radius 02 (0.88), 04 (0.90); 04's first retake broke continuity, auto-retake passed |
| Retake cell 04 in documentary style | Kept the back-seat framing from notes; new driver look |
| "Love this one, the reflections are perfect" | `no_op` p=0.92, recorded, nothing re-shot |

Found and fixed during the run: Clef-flash gave cell 03 only 0.33 even though the recast driver is in it,
so any cell listing a changed character is now always re-shot (Clef decides the less obvious ones).

## Testing

Three layers, each tied to the decisions in [docs/decisions.md](../docs/decisions.md):

| Layer | Command | What it covers | Cost |
|---|---|---|---|
| Unit | `npm test` | Pure modules: look insertion, CSV, notes log, skill parsing, router request, continuity rules (including recorded Clef answers), and Git behaviour of takes and prints on an in-memory repo | free, offline; runs in `deploy.sh` |
| Eval | `npm run eval` | The router and continuity decisions in `test/evals/cases.json`, asked of the real models with the requests production builds; fixtures are real frames from the Night Drive board | about a cent; `--record` saves results as evidence |
| End to end | `scripts/smoke.sh` | A real board through the deployed Worker | a few cents |

The logic the evals exercise lives in dependency-free modules (`src/router.ts`, `src/continuity-rules.ts`,
`src/vocab.ts`) so production and the evals share one implementation. `npm run eval -- router clef-flash`
compares a different model on the same cases.

## Skills

Agents take their instructions (and model) from `skills/<role>/SKILL.md` in the board repo; the seeds are
in [`/skills`](../skills). Boards fork `storyboard-template`, which is created from the seeds on first use.

```sh
# Edit a role on one board; later takes on that board use it
curl -X PUT $URL/boards/$REPO/skills/cinematographer -H "$AUTH" -H "x-message: Low camera, headroom for titles" \
  --data-binary @my-cinematographer.md
# Retake a cell with the board's current skills (optionally with a note for the cinematographer)
curl -X POST $URL/boards/$REPO/cells/02/takes -H "$AUTH" -d '{"note": "she should be in the doorway"}'
# Share it: new boards will start with this version
curl -X POST $URL/boards/$REPO/skills/cinematographer/promote -H "$AUTH"
```

Tested 2026-10-07: after adding "camera low, leave the upper third as empty sky" to the cinematographer
skill on one board, the retake of cell 02 recorded `cinematographer@844da01` (take 1: `@892fc29`), its prompt
ended "the upper third of the frame empty sky", and the frame matched. Promote created a commit on the
template with a `From: <board>@<commit>` trailer; promoting again was a no-op.

## Review a board locally

Critic and continuity output lives on the **take branches** of the board repo (`cell/NN/take-K`), not
on main. This clones a board with every take as a local branch and prints a per-take summary:

```sh
STORYBOARD_URL=https://storyboard-spike.<subdomain>.workers.dev scripts/clone-board.sh <repo>
#   TAKE               SKILL                      ADHERENCE CONTINUITY
#   cell/02/take-1     cinematographer@892fc29    2.79      ok
#   cell/02/take-2     cinematographer@844da01    2.81      ok
cd boards/<repo> && git show cell/02/take-2:cells/02/continuity.json
```

## Setup and deploy (uses the `cf` CLI, no wrangler)

Needs a Cloudflare account on the Workers Paid plan (Artifacts beta) and `cf auth login`.

```sh
cd spike
scripts/setup.sh     # npm install, approve workerd, create the `storyboard` Artifacts namespace, write SPIKE_KEY to .env
scripts/deploy.sh    # types + tsc + unit tests, cf deploy --secrets-file .env, wait for the new version,
                     # create/extend the storyboard-template skills repo; prints the UI URL
export STORYBOARD_URL=https://storyboard-spike.<subdomain>.workers.dev
scripts/smoke.sh     # creates a real 2-cell board (a few cents of Workers AI) and prints its takes and history
```

All three are safe to re-run (`npm run setup|deploy|smoke` work too). `scripts/deploy.sh --reset` also
overwrites the template's skills with `/skills`; that's an ordinary commit on the template, but it discards
skills promoted from boards. What they run, for doing it by hand:

| Step | Command |
|---|---|
| Namespace | `cf artifacts namespaces get storyboard \|\| cf artifacts namespaces create --namespace storyboard` |
| Binding types | `cf workers types` (writes `.cloudflare/types/index.d.ts` from `cloudflare.config.ts`) |
| Build only | `cf build` (delegates to Vite via `@cloudflare/vite-plugin`) |
| Deploy | `cf deploy --secrets-file .env` (uploads `SPIKE_KEY` as a secret) |
| Template | `curl -X POST $STORYBOARD_URL/template -H "authorization: Bearer $SPIKE_KEY"` |

`npm audit` reports high-severity advisories in `sharp`, which comes in through local dev tooling
(`cf` and the Vite plugin → miniflare); the deployed Worker's dependencies have none (`npm audit --omit=dev`).

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

## Continuity fix (2026-10-07)

The first run's cell 03 drew a child because the prompt said only "Emilia's face". What it took to get
six cells of one consistent character:

| Problem | Fix |
|---|---|
| Cinematographer drops the character description | It writes `{{Name}}` placeholders; code pastes the bible `look` verbatim (`insertLooks`) |
| Director's look omitted age ("worn face" renders as ~30) | Prompted for "58-year-old woman, ..." first; code prefixes the age band if missing |
| Same description, a different stranger every frame | **Casting agent** renders a portrait per character; flux-2-klein-9b takes it as a reference image |
| Retakes can't fix identity with text alone (Clef same-person p stayed at 0.2–0.45) | The references above; identity is checked against the portrait, not the neighbouring cell |
| Portrait references pulled EWS/ECU shots into medium shots | References only for MS/CU; render prompt starts with the spelled-out shot size ("EWS" means nothing to flux) |
| Framing far from plan went unnoticed | Continuity fails when Clef's detected shot size is more than one step from the plan |

Result on the 6-cell lighthouse board: all cells pass; one framing miss (ECU rendered as MS) was caught
and fixed automatically on take-2; mean adherence rose from ~2.6 to ~3.0. Visually, the same
grey-haired woman in the same olive coat appears in every frame, including the EWS rendered without a reference.

Reliability lessons from the same runs:
- The image safety filter sometimes flags harmless outputs (AiError **3030**); Workers AI also returns
  transient **3043** (internal) errors. Image calls retry with a fresh seed; all AI calls retry 3040/3043.
- **Concurrent pushes**: with 6+ agents pushing to one repo at once, Artifacts sometimes answered a push
  with an empty body (isomorphic-git: `Expected "unpack ok"`). Each agent owns its branch, so pushes retry.
- A freshly deployed version can take a few seconds to take effect; the first request after
  `cf deploy` may hit the old one.

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
