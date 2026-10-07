# Design

## 1. Core idea: the storyboard *is* the repo

One Artifacts repo per storyboard. All state is plain files, so you can read every change as
a diff, and agents coordinate through commits rather than a database.

```
concept.md               # the user's original pitch (never rewritten by agents)
bible.md                 # style bible: look, palette, lenses, characters, locations
bible/refs/*.webp        # reference images for characters/locations (consistency anchors)
storyboard.csv           # one row per cell: id, order, duration, shot, camera, status, ...
cells/
  03/
    beat.md              # plain-language description from the director
    prompt.md            # cinematographer's rewrite: the text actually sent to the image model
    frame.webp           # current render
    render.json          # model id, seed, steps, size, guidance, timing, cost
    notes.md             # the user's notes on this cell, appended over time
    review.json          # critic scores (Clef) for the current frame
video/                   # added at the end: per-cell clips + edit decision list
```

Why CSV? `storyboard.csv` gives a whole-board overview that diffs line by line
(`git diff --word-diff`), opens in any spreadsheet, and is easy for an LLM to read and write.
The per-cell folders hold the larger material. The CSV is the index that ties it together.

Provenance goes in **git notes** (Artifacts supports them natively): the full LLM prompt,
the model ID and the agent identity attached to each commit. These don't touch the tree, so
diffs stay clean.

## 2. Mapping Git to a film workflow (the "not GitHub" part)

| Git concept | Storyboard meaning | What the UI shows |
|---|---|---|
| `main` | The **approved board** | The storyboard grid |
| branch `cell/03/take-2` | A **take**: one agent's attempt at a cell | Thumbnails stacked behind the cell |
| merge take → main | **Print it**: pick this take | Click a thumbnail |
| PR / review | **Dailies**: the critic and the user review takes | Scores + note box per cell |
| merge conflict | **Continuity break**: two takes disagree on the bible or with neighbouring cells | A red seam between cells |
| fork | **Alternate cut**: "same story, but noir" | A second board you can compare side by side |
| `git log` on a cell | **Cell history** | A scrubber under each cell |
| tag | **Lock**: board v1 sent to video | A version badge |

The user never sees Git words. The judges see them in the event log and the repo.

## 3. Agents and concurrency

Each agent is a Worker (or Agents SDK Durable Object) with a repo-scoped token. It writes only
to its own branches, so many agents work on one board at once without stepping on each other.

```
User concept ──► Director ──► storyboard.csv + cells/*/beat.md + bible.md  (main)
                                   │
                    push event ────┤ fan-out (Queue): one job per cell
                                   ▼
        ┌──────────── Cinematographer ×N (parallel) ────────────┐
        │  beat.md + bible.md ─► prompt.md   on cell/NN/take-k   │
        └──────────────────────────┬────────────────────────────┘
                                   ▼
        ┌──────────── Renderer ×N (parallel) ───────────────────┐
        │  prompt.md (+ bible refs) ─► frame.webp, render.json   │
        └──────────────────────────┬────────────────────────────┘
                                   ▼
        Critic (Clef, image input) ─► review.json; auto-retake if score is low
                                   ▼
        Continuity (Clef + LLM) compares cell NN with NN-1 / NN+1 and the bible
                                   ▼
                  Dailies: user notes per cell ─► Notes router (Clef-flash)
```

- **Director**: a strong text model (e.g. `kimi-k2.6`, `deepseek-v4-pro`, `nemotron-3-120b`).
  Concept → shot list with durations, plus a first draft of the style bible.
- **Cinematographer**: rewrites a beat as a shot: framing (ECU/CU/MS/WS), lens, camera move,
  lighting, composition and blocking. It reads the bible so every cell shares a vocabulary.
  The user can choose this model separately from the director.
- **Renderer**: the text-to-image model the user picked (`flux-1-schnell` for fast drafts,
  `flux-2-dev`/`phoenix-1.0` for final frames). `flux-2-klein-9b`/`flux-2-dev` take **multiple
  reference images**, so `bible/refs/` keeps characters consistent from cell to cell.
- **Casting**: before any cell renders, one neutral portrait per character goes to `bible/refs/`.
  Those portraits are passed as reference images for medium shots and close-ups, and continuity checks
  identity against them. This turned out to be essential: matching text descriptions alone produced a
  different stranger in every frame (see `spike/README.md`).
- **Critic and continuity**: see §4.
- **Coordinator**: one Durable Object per storyboard. It holds the work queue, takes a short
  lease on each cell so two renderers don't render the same take, and decides when to merge.
  Workflows give each cell's pipeline retries and durable steps.

### Concurrency moments worth showing in the demo
1. **Fan-out**: 8 cells rendering at once, with branches appearing live.
2. **Conflicting bible edits**: the user's note on cell 2 ("make her coat red") and on cell 6
   ("night, sodium-vapour light") each produce a bible change on separate branches at the same
   time. The coordinator merges both (a text merge, no conflict), and the router finds which
   *other* cells must re-render. Those re-renders run concurrently.
3. **A real semantic conflict**: two takes edit the same bible line ("coat: red" vs "coat:
   yellow"). Clef picks a resolution or asks the user, showing the probabilities.
4. **Alternate cut**: fork the board; a second set of agents re-renders it in a new style,
   in parallel with the first.

## 3b. Skills: roles that evolve with the board

Each role's craft lives in the board as `skills/<role>/SKILL.md` ([Agent Skills](https://agentskills.io) format:
YAML frontmatter + markdown, so the same files work in other agent tools). Markdown suits *behaviour*:
prose the model follows, that a person can edit and review as a diff. JSON/CSV stay for *data* that
code and Clef consume (`characters.json`, `review.json`, `continuity.json`).

- **What a skill controls**: the role's instructions and its model (`metadata.model`), so choosing a model
  and tuning a role are the same act, versioned together.
- **What stays in code**: each role's output contract (JSON shape, `{{Name}}` placeholders), the look
  insertion, and the continuity checks. A bad skill edit gives worse frames, never a broken pipeline.
- **Provenance**: every agent commit carries a `Skill: cinematographer@<blob id>` trailer.
- **Sharing**: `storyboard-template` is the skills library; every board is an Artifacts **fork** of it.
  A skill edited on a board (`PUT /boards/:repo/skills/:role`) affects later takes on that board only;
  `POST .../promote` copies it back to the template so new boards inherit it.
- **Styles**: several skills can fill one role (`metadata.role: cinematographer`, `style: Film noir`).
  `board.json` picks each role's skill for the board; a single take can use another, so "this cell, but
  noir" is just another take branch to compare and print.
- **Next**: a coach agent that proposes skill edits from recurring notes ("third note asking for more
  headroom"), reviewed like a pull request; critic and continuity thresholds as skills too.

## 3c. Jobs, the queue and the ledger

Routes do the quick part (fork a board, commit and route a note) and queue the rest on `storyboard-jobs`:
a board job (director and casting), take jobs (cinematographer, renderer, critic, continuity), bible jobs
(director revision, recasting, blast radius) and print jobs. A batch's jobs run concurrently in one
invocation. The coordinator keeps no state: `jobs.csv` on the board's `jobs` branch is the ledger, and
every queue, progress and outcome change is a commit (see docs/decisions.md D13 to D16). The UI polls the
ledger and refreshes when a job changes status.

```
POST /boards ──► fork template ──► ledger: queue board job ──► 202 {repo}
board job ──► director, casting ──► ledger: queue N take jobs (group "first cut")
take job ──► prompt, render, review, continuity ──► ledger: done (or queue retake into the group)
last take in group ──► ledger: group done + queue print job (same commit: exactly once)
print job ──► octopus merge of the best takes into main
cron */5 ──► ledger: jobs with no progress for 10 min → failed (closes their groups)
POST /cut ──► ledger: one video job per printed cell (group "cut:vN")
video job ──► signed frame URL ──► wan-2.7-i2v ──► video/NN.mp4 on cut/vN/NN
last clip in group ──► ledger: queue assemble ──► merge clips into cut/vN with video/edl.csv
```

## 4. Where Clef / Clef-flash fit

Clef doesn't generate anything. It returns **calibrated probabilities for typed questions**
(yes/no `noul`, `choice`, `score`) about a state (text/JSON plus up to 4 images). That makes it
the **control plane** of the pipeline: every branch point that would otherwise be an LLM call
parsed with a regex, or a human click.

| Decision | Model | Question type | State | Effect |
|---|---|---|---|---|
| **Route a note**: what does "too dark, and he looks older than in shot 2" require? | clef-flash | `choice`: `reseed` / `rewrite_prompt` / `edit_bible` / `restructure_board` / `no_op` | note + cell prompt + bible | Picks which agent runs next |
| **Blast radius**: which cells does a bible edit affect? | clef-flash | one `noul` per cell (all cells in a single call) | bible diff + each cell's prompt | Queues re-renders only where p > 0.5 |
| **Prompt adherence**: does the frame match the prompt? | clef | `score` 0–4, image input | prompt + frame | Auto-retake below a threshold (max 2) |
| **Continuity**: same character, wardrobe, time of day as the previous cell? | clef | several `noul`, 2–3 images | neighbouring frames + bible | Red seam / continuity flag |
| **Merge choice**: two takes, which fits the board better? | clef | `choice`, 2 images | both takes + neighbours | Pre-selects a take; the user can override |
| **Safety gate** | clef-flash (or llama-guard) | `noul` | prompt | Matches the reference architecture's classifier step |
| **Ready for video?** | clef | `score` | whole board + review scores | Gates the expensive video step |

Why this is a strong story for judges: Clef replaces the brittle "LLM, please answer
JSON" step in multi-agent coordination. The probabilities are shown in the UI and written to
`review.json`, so the reason behind each automatic decision is versioned too. Note: image
requests were slow at launch (13–30 s), so run image checks off the hot path, and use
clef-flash for text-only routing (~40 ms).

## 5. The feedback loop

1. The user writes a note on cell 05. It is committed to `cells/05/notes.md` on `main`. *The
   note itself is versioned.*
2. A push event lands on the queue, and the router (Clef-flash) classifies the note.
3. `rewrite_prompt` → the cinematographer opens `cell/05/take-3` with a new `prompt.md` →
   the renderer → the critic. `edit_bible` → a bible branch, plus a blast-radius check, plus
   fan-out re-renders.
4. The new take appears behind the cell. The user prints it (merge) or writes another note.
5. Undo = point main back at an earlier commit. Nothing is ever deleted, so trying an idea
   costs nothing.

## 6. Handoff to video

The Workers AI catalog itself has no video models. The **unified model catalog** (through
AI Gateway / `env.AI`) has image-to-video models such as `alibaba/wan-2.7-i2v`,
`google/veo-3.1`, `bytedance/seedance-2.0`, `runwayml/gen-4.5`, `lightricks/ltx-2-5-fast` and
`black-forest-labs/flux-3-video`. Image-to-video is a better fit than text-to-video: **each
approved frame becomes the keyframe for its clip**, and `prompt.md` (plus the camera move from
the CSV) becomes the motion prompt. Clips go in `video/NN.mp4` (or R2 if too big). The edit
decision list is `video/edl.csv`. Tag the commit `cut-v1`.

You can keep ComfyUI in the picture without breaking the "all on Cloudflare" rule for the
competition: the board is a normal Git remote, so a local ComfyUI workflow can `git clone`
it later and render high-quality frames as just another agent pushing takes.

## 7. Implementation notes and risks

- **Writes**: the Artifacts binding and REST API are **read-only for content**. Writes go
  over the Git smart-HTTP protocol: `isomorphic-git` in a Worker with an in-memory FS, or the
  Sandbox SDK. Keep each commit small (one cell's files) and shallow-fetch only the branch you
  need. Workers have a 128 MB memory limit, so store frames as ~200–400 KB WebP. That also keeps
  them under Clef's ~190 KB-per-image guidance once downscaled.
- **Reads** for the UI: `repo.readFile({ref, path})` and `repo.log()` through the binding;
  `GET .../raw/:ref/:path` for images.
- **Events**: event subscriptions (push/fork/…) → Queues. If they aren't enabled on the
  account yet, the coordinator DO can trigger the next step itself after each push.
- **Frontend**: a Workers static-assets SPA (or Agents SDK `useAgent` over WebSocket) for live
  branch and take updates. Model pickers for the director, cinematographer and renderer.
- **Cost**: Artifacts billing starts Oct 15. Use flux-1-schnell during development.
- **Open questions**: exact event subscription API; whether git-notes can be written with
  isomorphic-git (it can write notes refs manually, which is fiddly); access/approval for the
  unified catalog video models.
