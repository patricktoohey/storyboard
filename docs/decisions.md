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
| D25 | The team's lead model decides each turn from a manual of tools that includes Git (save, restore, compare, any take, any cut); code checks every decision | `arena-rules.test.ts` |
| D26 | A cut assembled before the deadline counts as the team's submission | live run (see below) |
| D27 | A job reports what it really cost: turns pay for the lead model's tokens, and nothing when they only wait | `ledger.test.ts`, `llm.test.ts` |
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

## D25: the lead decides, with Git as a tool

Until now Clef picked each showrunner action from a closed list, and the board's history was only a record:
nothing ever went back to an old version. Now each team has a **lead** model (a crew slot, from open models
to Claude Opus 5.5 and GPT-6.1 Sol through AI Gateway's unified billing) that plans the board, decides every
turn, writes notes and runs retrospectives. Each turn it reads the board, clock, budget, scores and its
history (recent commits with any judged score, saved versions, cuts, its own comparisons) and a manual of
tools; the Git ones are `save` (a branch), `restore` (old content back as a new commit), `compare` (judges on
two versions), `replan` (after saving), `print` with any earlier take, and `submit` with any cut. Code still
mandates the draft, the plan and the deadline, and checks every decision (`parseDecision`): only offered
tools, real cells and takes, existing cuts. Instructions to use history live in code, so every skill gets them.

First run (arena-2026-10-08-7d57a2, same neutral skill, 15 minutes, $2): Opus drafted from the prices ("Wan
would push a minimal film to $2.06"), saved `alt/safe-v1` as a baseline on its first free turn, wrote notes
aimed at its weakest criteria, and won 92% of side-by-side judgments against Llama 3.3, which gave the same
lighting note four times. 15 minutes left no room to compare and restore: rounds need about 30.

## D26: a finished cut counts

In the first season's round 2, safe's cut finished as the clock ran out, before its next turn could
submit it, and it was disqualified for "no video". At the close, a team without a submission is now
recorded at its newest cut whose assembly commit predates the deadline.

## D27: costs as billed

Turns were charged a fixed estimate whether they decided or waited. With frontier leads a decision costs
about 2¢ and a wait nothing, so a turn reserves a decision and then reports its real cost from the tokens
the provider returned (`llmUsage`); the reported cost replaces the reservation in the ledger.

## D28: a cast, and talk that is committed

Season 2 (docs/season-2.md) needs a show worth watching, and a show needs people talking. Every lead,
player and judge creates its own character (name, bio, voice), played by its own model; judges, which are
Clef, are voiced by Sonnet from their verdicts. Players are repos of their own (profile, memory,
contract), so a player's career and memory move with it if it changes teams. Talk is plain markdown
committed beside what it is about: the crew room on the board, the commons and the judges' remarks in the
arena, confessionals in the team repo. Restoring a board version doesn't touch talk (it isn't a board
file). Player models are hidden from every lead's view, including the masked `llm` slot of the crew;
viewers see them only after the reveal.

The cinematographer hears each note before shooting it and may push back. A pushed-back note is held, not
shot; noting that cell again settles it. Disagreement then costs a turn, which is the price of a crew that
can say no. Fabrication runs one way only: up to two strong players undersell, and the team that drafts
one gets a budget bonus to cover the stronger model. A cheap player posing as a star was rejected: fair
play would need a budget cut, and the result is worse films.

## D29: leads think hard

A lead's answer is a few hundred tokens; thinking costs little next to one frame. Lead calls (decisions,
the crew draft, the player draft, direction, notes, retrospectives) ask Claude for adaptive thinking at
high effort and OpenAI for high reasoning effort. Through the AI Gateway binding a fixed Claude thinking
budget (`budget_tokens`) is refused with 7003 on Opus and Sonnet 5.5; adaptive thinking is accepted
(checked 2026-10-08). Workers AI's reasoning models (Kimi, Nemotron, Gemma) think by default. Players
don't think hard: they talk inside someone else's turn.

## D30: sound is the crew's work, and the mix runs in a Container

A film needs sound, and a show needs the cast heard. Three pieces, each committed like everything else:

- **Score and lines are tools the lead directs** (`score`, `lines`), and in a cast season the players do
  the work in character: the sound designer writes the music prompt and casts voices, the writer writes the
  lines. Both live on main (`sound/score.mp3`, `sound/lines/*.mp3`, `sound/lines.csv`,
  `sound/voices.json`), so the next cut carries them, and `remix` puts new sound under an existing cut
  without rendering video again. Music is ElevenLabs Music v2, speech Eleven v3, each answering in about
  4 s through the AI binding (checked 2026-10-08).
- **Voices come first.** Every character in a season is dealt one of 22 stock ElevenLabs voices, all
  different, and builds its personality to fit it: the bio follows the voice, not the other way round, so
  a character never sounds wrong for who it says it is. A film's own characters are cast from the same list
  by the sound designer and keep their voice in `sound/voices.json`.
- **The mix is ffmpeg in a Cloudflare Container** (`mixer/`, behind the `Mixer` Durable Object), since a
  Worker can't run it. The Worker writes ffmpeg's arguments (`mixPlan` in sound-rules.ts, unit-tested): clips
  in EDL order fitted to 1280x544, each clip's own sound or silence, the score under it, lines on cue with
  the bed ducked beneath them. Every cut is mixed after assembly; `video/teaser.mp4` and `video/mix.json`
  (cues, levels, sources and a signature of the sound used) go onto the cut branch with the sound, so a
  cut is the whole film on its own.

Video with its own sound: FLUX.3 Video (5-20 s, 21:9, an AAC track) animated a two-person medium shot
with ambience in 94 s and joins the draft at $0.17 a clip. Grok Imagine Video refuses every request with
7003, including the catalog's text-to-video example, and stays off the draft. Wan 2.7 and Hailuo have no
sound option.

## D31: the season format is the producer's, and every move is a commit

A cast season can carry a `format`, and every part of it is committed to the season repo
(`season.json` events, `talk/season.md`, `talk/claims.md`) and to the players' own repos:

- **Rivals in the open rounds.** Each turn's view lists every rival's moves, saved versions, cuts and
  live win rate. A move is public as the tool and its plain arguments (cells, cuts, versions, saved
  names), committed to the board's `talk/moves.md` with the move as the commit message; notes, directions
  and talk stay with the team. A decision may add a public `message` beside its private `reason`. After
  each open round the show puts them side by side in `talk/claims.md`. `compare` takes
  `rival:<team>/<version>`, so a claim can be checked against what the rival's board holds.
- **Twists are offers** (`twist_round`): every lead may take a quarter of its budget for a sixth of its
  clock ($3 for 10 minutes in a 60-minute, $12 round; every lead refused a flat $3 for 10 minutes when
  that was half a 20-minute round), and every
  team but the last may swap the player in one seat with the team just below it. Rounds now carry a
  per-team deadline.
- **Elimination and an entrant** (`eliminate`: 0-2; `entrant`: a `wildcard` lead model, or the best
  eliminated lead `returning` with the castoffs). The eliminated players become free agents, and the
  entrant signs one per seat. Both options stay configurable, so the open question (wildcard or misfits)
  can be settled by running both.
- **The finale's moves**, as one job each on the season ledger: every lead protects a player in secret;
  steals go worst first (the entrant first of all). A steal on a protected player is blocked and lost; a
  successful one releases the thief's own player in that seat; teams short a seat sign a free agent. The
  protections are told when the finale starts.
- **A player who changes teams brings what it heard**: the last of its old crew room goes into its own
  memory and shows in its new lead's view.
- **Chained seasons and a backstory.** `previous` forks each returning team's repo from the earlier
  season (its evolved strategy and lessons), the draft starts from the bottom of that season (new teams
  first), and `backstoryOf` turns its results into the story every character is told ("the reigning
  champions of Season 1"), followed by the producer's own notes.

## D32: a judge that watches and listens, and a mixer that waits its turn

(The single Gemini judge at double weight became the three-lab panel in D33.)

**The format dry run** (`season-2026-10-08-2345e6`: three teams chained from Season 1, a twist round, one
elimination, a Sonnet 5.5 wildcard, protect and steal, a blind final) ran every move once fixes were in:

- **Closing raced.** The last submission and the deadline sweep both closed round 1's arena, so it was
  judged twice and the twists ran twice. Closing is now checked inside the commit that closes it, and
  every format step skips work already done, so a retried step is safe (`POST /seasons/:id/events`
  re-queues one).
- **A team without its own skill** (a new team, the wildcard) starts from the generic `showrunner`; the
  wildcard's first finale attempt failed looking for `showrunner-wildcard`.
- **Seven of nine teasers were never mixed.** Every mix named its own Container instance, each stayed awake
  2 minutes, and with 4 instances allowed, teams finishing together hit "Maximum number of running
  container instances exceeded". Now 10 instances, asleep 20 s after a mix, and a mix that finds them all
  busy waits and retries (`mixerFull`). The three finale teasers, re-mixed together, all went through.

**The teaser judge** (`skills/judge-teaser`, `src/teaser-rules.ts`). Clef judges contact sheets, so no
judge heard the lines or the score. Gemini 3.8 Flash takes `teaser.mp4` inline through the binding
(Gemini's own `contents`/`parts` format, `inline_data` of `video/mp4`) and counts video and audio
separately (1,080 and 450 tokens for 18 s): it transcribed a teaser's five lines word for word and told
the voices apart, so it hears. About a tenth of a cent a film.

- It compares two submitted teasers at a time, both ways round, like the other judges, so its verdicts go
  into the same win rates. It names a margin per criterion (even, slight, clear, decisive → 0.5 to 0.9),
  which a model does more reliably than invent a probability. Rubric: pull, what's new, sound, the card,
  the brief (including how it should look).
- It counts double: it's the only judge that sees the film itself. It judges only the final round (only
  submitted cuts are mixed); a team without a mixed teaser loses its matchups; in a silent arena it sits
  out. A failed call is retried once, then counts as even.
- It writes one sentence on each film naming something it saw or heard ("the crisp delivery of 'Far
  enough to be brave'"); those sentences go into every judge's remarks on camera, and it is a third judge
  character in cast seasons.
- **On the dry run's finale**, judged on stills the wildcard won (67%, Opus 50%, GPT 33%). Watching and
  listening, the teaser judge put it last (Opus 60%, GPT 57%, wildcard 34%: "the vocal mix feels flat";
  "obscures the branching interface inside a stylized cinema shot"), consistently both ways round. At
  double weight, Opus would have won the final.
- **The look**: it also noticed what the producer did, the sci-fi look ("holographic data strings… blue
  laser-like light"). The Season 2 brief now asks for reality TV (real rooms, ordinary people, handheld,
  no holograms or neon), and the teaser judge's `brief` criterion includes how it should look.

Tests: `test/teaser.test.ts` (the request, margins, notes, forfeits), `mixerFull` in `test/sound.test.ts`.

## D33: the final round is ranked by a panel from the three labs

Gemini 3.1 Pro leads a team in Season 2 (Nemotron came last in both dry-run rounds), so the teams are led
by Anthropic, OpenAI and Google models, and a Gemini judge alone would rank its own lab's team. The final
round is now ranked by **a panel**: Claude Opus 5.5, GPT-6.1 Sol and Gemini 3.1 Pro, at equal weight, each
comparing every pair of finished teasers both ways round on one rubric (`skills/judge-teaser`).

- **They can't all watch.** Through the binding, Claude and GPT take images but not video or audio (GPT
  refused `input_audio`: "text or image_url" only); Gemini 3.1 Pro takes the mp4 with its sound. So every
  judge gets the same evidence, and Gemini also gets the film:
  - eight frames from the finished teaser (the last half a second from the end, where the title card is),
    taken by the mixer Container right after the mix (`POST /extract`);
  - a transcript of what can be heard in the mix: Whisper (`whisper-large-v3-turbo` on Workers AI, from none
    of the three labs) on the mixed soundtrack, so a line buried under the score isn't heard;
  - the team's direction for its score, marked as the team's own words.
  All three go on the cut beside `teaser.mp4` (`video/frames/`, `video/frames.json`, `video/transcript.json`).
- **Clef** keeps the live scores during a round and the teams' own comparisons; a new arena's
  `rules.panel` replaces it only for the final ranking (older arenas are judged as before).
- **Final judging waits for mixes** still running (up to 8 minutes) instead of forfeiting a team that
  submitted a cut a moment before the close.
- **The judges on camera are the panel**, each created and played by its own lab's model, and each speaks
  from its own notes on what it saw and heard.
- **A verdict survives a broken answer**: when a note's unescaped quote breaks the JSON, each criterion is
  read on its own (one of 18 live verdicts came back that way and had counted as even).

**Live check on the dry run's finale** (the three teasers re-mixed with frames and transcripts; Whisper
caught every line with its timing): all three judges put the Opus team first (Claude 56%, GPT 57%,
Gemini 59%; overall Opus 57%, wildcard 47%, GPT 45%), where the stills had put the wildcard first. They
disagree where their evidence differs: Gemini, which heard the films, gave the wildcard 64% for its score
("a clock tick that splits into echoes") and GPT's team 24% ("the absence of a musical score leaves the
teaser feeling flat"); GPT's judge, reading frames, gave the wildcard 34% ("branching is mostly asserted
by 'Three versions' rather than demonstrated"). The Claude judge didn't favour the Opus team (56%, the
lowest of the three); the GPT judge rated GPT's team highest of the three (59%, against 51% and 24%),
which the panel exists to dilute. A Claude call costs about 5,300 tokens in for two films, so a
three-team final is about $0.50 for the panel.

Tests: `test/teaser.test.ts` (the three request shapes, the film only for Gemini, transcripts, frame
times, margins, broken answers, forfeits).

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
