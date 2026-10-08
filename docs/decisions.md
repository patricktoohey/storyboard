# Decisions

Each decision records what was chosen, the evidence that led to it, and the test that keeps it from
being undone. Unit tests run offline on every deploy (`npm test` in `spike/`); live evals ask the real
models the exact requests production builds (`npm run eval`, about a cent; results in
`spike/test/evals/results/`).

| # | Decision | Pinned by |
|---|---|---|
| D1 | A board is an Artifacts repo; each take is a branch; every agent commits under its own name | `smoke.sh` |
| D2 | Characters are `{{Name}}` placeholders that code replaces with the bible's look, word for word | `looks.test.ts` |
| D3 | Casting portraits are identity references for MS and CU only | `decisions.test.ts` D3 |
| D4 | Role instructions are skills in the board repo; code keeps output contracts and guardrails | `skill-format.test.ts` |
| D5 | The notes router has a `match_bible` route, separate from `edit_bible` | `router.test.ts`, router eval |
| D6 | Every cell that lists a recast character is re-shot, whatever Clef says | `decisions.test.ts` D6 |
| D7 | Continuity compares closed attributes (hair, outerwear) between frame and portrait | `continuity-rules.test.ts`, continuity eval |
| D8 | Printing a take is a merge commit whose extra parents are the printed takes | `decisions.test.ts` D8 |
| D9 | A take branch deletes main's copy of its cell's outputs in its first commit | `decisions.test.ts` D9 |
| D10 | Notes are routed with `clef`, not `clef-flash` | router eval results |
| D11 | Every take is briefed with all of its cell's notes | `notes.test.ts` |
| D12 | A take is stale when a character in its cell has changed since it was shot | live check (see below) |
| D13 | Coordination state is a CSV ledger on the board's `jobs` branch; Git's push compare-and-swap is the lock | `ledger.test.ts` |
| D14 | Every working tree gets its own path, and a queue batch runs its jobs concurrently | live runs (see below) |
| D15 | Progress reports are best-effort; outcomes retry until they land | live runs (see below) |
| D16 | A cron sweep fails jobs with no progress for 10 minutes, so groups always close | live check (see below) |
| D17 | Frames reach the video provider through signed, expiring URLs that grant one frame | `video.test.ts` |
| D18 | Clips live on cut branches (`cut/vN/NN`, merged into `cut/vN` with an EDL), never on main | live run (see below) |
| D19 | Arena budgets are reserved in the ledger: estimates are charged when a job is queued | `arena-rules.test.ts` |
| D20 | One file per score (`scores/<team>/<judge>.json`); the leaderboard is computed on read | `arena-rules.test.ts` |
| D21 | Judges are skills with public rubrics, and score a commit, never a branch | `arena-rules.test.ts` |
| D22 | Showrunner actions are a closed set; code mandates when there's no choice, Clef chooses the rest | `arena-rules.test.ts` |
| D24 | Staging is planned per cell and anchored like casting: scouted location references, positions and blocking stated by code, and checked by Clef | `blocking.test.ts`, `continuity-rules.test.ts` |

## D2: placeholders, not descriptions

The first board drew a child in cell 03: the cinematographer wrote "Emilia's face" and dropped the
bible's description. Asking the LLM to "repeat the description verbatim" wasn't reliable, so it writes
`{{Emilia}}` and code pastes the look. The first mention gets the full look, later ones "the same person";
a character the model forgot is appended.

## D3: portraits only for MS and CU

Text alone produced a different stranger in every frame (same-person p=0.2–0.45, unfixable by retakes),
so casting renders a portrait per character and flux-2-klein uses it as a reference. But on a 6-cell
board the head-and-shoulders references pulled EWS and ECU shots into medium shots. Restricting them to
MS/CU (and spelling out the shot size in the prompt) gave 6/6 cells passing.

## D5 and D10: routing notes

In the browser review, "she should match the current bible: 58, grey hair in a bun" was routed to
`edit_bible` (p=0.62). The director rewrote a look that was already right, casting recast the driver,
and three cells were re-shot. Fixes:

- A `match_bible` route ("the frame is wrong, the bible is right; fix this shot only").
- The director can answer `changed: false`, which falls back to `match_bible` (a backstop).
- Route with `clef` instead of `clef-flash`. On the 7 router cases, `clef-flash` scored 6/7 (the brown
  jacket note split 0.50/0.38) and `clef` 7/7 with p≥0.83, identically on two runs. A note is not on a
  latency-critical path, so the bigger model wins.

Live check afterwards: "His jacket here looks brown, it should be the black leather one" routed to
`match_bible` p=0.91 and produced one retake, with no recast and no other cells re-shot (11 s).

## D6: recast characters force a re-shoot

After the driver was recast, Clef-flash judged cell 03 unaffected (p=0.33) even though she's in it, so
cell 03 kept the old driver. Which cells contain a character is known exactly; Clef only decides the
less obvious cases.

## D7: attribute checks for continuity

"Is this the same person as the portrait?" is too lenient: the old driver scored 0.53 against the recast
driver's portrait, a pass. Asking the same closed question of the frame and the portrait ("what colour is
their hair?") and comparing scored the same frame p=0.07 (a clear break) and the correct frame p=0.94.
Hair isn't compared when either image reads as bald, because a balding passenger read as "bald" in one
image and "light brown" in the other. EWS frames skip attributes (figures too small). Adjacent age bands
pass ("late fifties" reading as elderly isn't a break).

## D8: printing is a merge

`git log --graph` on main shows exactly which take was printed for each cell; a new board's first cut is
one octopus merge. The cell's files come from the take; `notes.md` stays main's.

## D9: take branches drop inherited outputs

A take branch starts from main, which holds the printed take's frame. Until the renderer committed, the
new take served the old frame, and the browser cached it: the UI showed take 1's image labelled "take 2",
which I first misread as a continuity false pass. The first commit on a take now deletes `frame.webp`,
`render.json`, `review.json` and `continuity.json`, and file responses are `no-store`.

## D11: notes accumulate

A bible-driven retake of cell 04 forgot the earlier "shoot from the back seat" note and would have reverted
the framing. Every take's brief now includes all of the cell's notes from `notes.md`.

## D12: stale takes

Takes shot before a recast kept a green "continuity ok" judged against the old portrait. The UI now shows
"before bible change" for a take whose cell's characters looked different on its branch than on main.
Verified on Night Drive: stale takes were exactly those showing the old driver; cell 01 (no characters)
was not flagged.

## D13: the coordinator's state lives in Artifacts

Jobs (a board, a take, a bible edit, a print) run on a Cloudflare Queue, one invocation each. Instead of
a Durable Object with SQLite, the coordinator is stateless: `jobs.csv` on the board repo's orphan `jobs`
branch has one row per job, and every change (queue, progress, outcome) is a commit made by clone, edit,
push. A push that loses a race is rejected and the edit is redone on the new rows. That compare-and-swap is
the only lock, and it makes take numbering atomic (two retakes can't both become take 3) and group
completion atomic (the commit that finishes a first-cut group's last take is the one that queues the print,
so it happens exactly once). `git log -p jobs.csv` on the `jobs` branch replays the whole production.

Cost: a status update is a commit (~1 s), not a row write (~ms), so progress is reported per stage.

## D14: per-tree paths and concurrent batches

The first queued run lost two jobs ("A promise was resolved or rejected from a different request
context") and ran takes nearly one at a time (cells started at 37, 51, 57 and 67 s). isomorphic-git keeps
module-level locks keyed by the repo path, every working tree used `/board`, and queue invocations share
isolates, so concurrent jobs waited on, and then broke, each other's locks. With a unique path per tree and
batches of up to 8 run concurrently, a 6-cell board's takes all started within ~10 s and the board
(directing, casting, 6 takes, 3 retakes, print) finished in 79 s with no failed jobs.

## D15: best-effort progress, durable outcomes

With 4 jobs each committing progress every ~2 s, one take lost 8 ledger races in a row ("refs/heads/jobs:
stale ref") on a progress report, and that failed the take. Progress ("renderer rendering the frame") now
gets one attempt and is skipped if it loses; queueing and outcomes retry up to 20 times with growing,
jittered backoff. In the 6-cell run, about 20 progress reports were skipped and every outcome landed.

## D16: stalled jobs fail, so groups close

A job whose message is lost would hold its group open forever: the subway board never printed its first
cut. A cron trigger (every 5 minutes, also `POST /sweep`) marks jobs with no progress for 10 minutes as
failed. That is an ordinary ledger commit, so it closes the group like any other outcome: on the subway
board the sweep failed the lost retake at 17:25 and the first cut printed 10 s later with the cell's take 1.

## D17: signed frame URLs

The image-to-video models (Cloudflare's unified catalog, called with `env.AI.run`) take the first frame as
an HTTPS URL, and every board route needs the access key. The Worker signs a URL for one frame: an
HMAC-SHA256 over repo, commit, path and expiry, valid for 15 minutes, served as JPEG at `/public/frame.jpg`
without the key. It is signed at the commit the frame was printed in, so the clip is of exactly that frame
even if main moves. Changing any parameter voids the signature, and even a validly signed URL is refused
for anything but `cells/NN/frame.webp`.

## D18: videos on cut branches

A clip is several MB, and every agent clones main, so clips never go there. Each video job commits
`video/NN.mp4` and `video/NN.json` (model, prompt, seed, the frame's take and commit) to `cut/vN/NN`; when
the cut's last clip lands, the ledger queues an assemble job that merges those branches into `cut/vN` with
`video/edl.csv` (order, cell, shot, camera, seconds, file, frame take, beat). Like printing, the merge's
extra parents are the clip branches.

First run (Silent Hive, 2 cells, `alibaba/wan-2.7-i2v` at 720P): the request returned in 2 s; Wan took
300 s and 321 s per clip (run in parallel); assembly took 11 s; the cut was ready at 344 s. Clips came back at
1466×628, matching the frames' aspect, 2.5 MB for 3 s and 4.8 MB for 5 s. Same character and coat across
both clips, with motion that followed the beat. About $0.80. The provider's fetch of the signed URL was not
blocked by Cloudflare's bot protection (which did block Python's default user agent).

## D24: staging continuity

Cells render in parallel from text, so before this only characters (casting portraits) carried from frame
to frame: the cab interior changed from shot to shot, the driver swapped sides, and both people sat in the
back seat. Each fix below came from a frame that broke on the Night Drive concept (noir, 4 cells):

- **Locations are cast like characters.** The director plans up to 3 locations (name and a look), each
  cell names one, and a scouting step renders an empty establishing image per location in parallel with
  casting (`bible/locations/`). WS, MS and EWS frames get it as image 0 ("the setting is the place in image
  0"); Clef compares the frame against it (`place`, a break below 0.4).
- **Blocking and screen positions are in the plan** (`location`, `positions`, `blocking` columns in
  storyboard.csv). The cinematographer's brief carries them with `{{Name}}` placeholders, because "Driver on
  the left" left the image model guessing who the driver was; neighbouring shots in the same location pass
  on their sides (the 180° rule). Clef asks where each person is (`position.*`, a break when the planned
  side scores under 0.3).
- **Code states the blocking, not just the LLM.** The brief said "at the wheel... passenger behind her";
  the cinematographer kept only left and right and both people were drawn on the back seat. Code now ends
  every prompt with `Staging: the 42-year-old woman at the wheel facing forward; the 25-year-old man behind
  her`, and Clef checks it (`blocking`, a break under 0.3).
- **Whoever the blocking names is in the shot.** The director listed only the Driver on a shot blocked
  "passenger behind her"; the renderer drew an undescribed passenger and the new head count (`people`)
  read three people against one planned. Names in the blocking now join the cell's characters.

Result (board-2026-10-08-a1360d): every cab frame in the same cab, driver at the wheel on the left,
passenger on the right in both shots that show them, head counts as planned; the two breaks were coat
colour, fixed by one retake each. The blocking check is lenient: it passed (0.85) a passenger who sits
more beside the driver than behind her.

## Backlog: staging continuity and non-human characters

Observed on the boards so far, not yet addressed:

- **Chained clips**: frames are anchored, but each clip still animates on its own; where a model takes a
  last frame, the next cell's frame could end the previous clip.
- **Skill examples leaking into frames**: the noir skill's example "a single bare bulb above frame right"
  put a ceiling bulb inside a car. Fixed in the noir skill; the general lesson is that skill examples
  must be illustrations the model won't copy literally.
- **Non-human characters**: a seal pup got the human age prefix ("young child small grey fur…"), was cast
  as a child, and continuity asked about its hair. Characters need a `kind` (person, animal, creature) that
  gates age prefixes and the hair and outerwear checks.
