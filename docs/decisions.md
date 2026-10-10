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

## D34: the season is for showing what a Git repository lets agents do

**The format dry run made no Git moves at all.** Across nine boards, every lead ran draft, plan, lines,
score, cut, submit; nobody saved, restored or compared, and the panel noticed in the films: "branching is
mostly asserted ... rather than demonstrated". In Season 1 (30 minutes, three silent cells) Opus ran the
whole loop, save, compare twice, restore, submit the restored cut, and GPT saved before every revision.
Adding lines, a score and a mix to a 20-minute round used up the slack that made the history worth using.
The point of the entry is Artifacts, so the format now makes room for the history and gives it a reason:

- **Three teams, one per lab** (Claude, GPT, Gemini), at 60 minutes and $16 a round: Kimi is dropped (one
  Git move and then none in Season 1, a timeout and a 16-minute late start), and its budget goes to the
  others, so a second version is affordable.
- **The network's note** (`format.network_note`): at each round's midpoint, every team's view shows a note
  from the network, one of three that suit any teaser and ask for a change worth trying beside what the
  team has. A team that saved can try it on a branch and compare; one that didn't has to gamble. Once out,
  the judges count it as part of the brief (a round where every team was in before the midpoint never
  saw it, and isn't judged on it).
- **Process is judged: 25% of the final ranking.** The panel compares each pair of teams' process records
  (`processRecord`), built from the board's ledger and repository: every move in order with its facts and
  the team's private reason (public messages dropped, since D31 lets them mislead), when the note arrived,
  saved versions, comparisons and their verdicts, cuts, and whether the submitted cut was an earlier one.
  Rubric: *effective* (did using the history make the film better; a move that changed nothing counts for
  nothing, the lesson of Llama's ten saves on one commit) and *creative* (did it use the history in a way
  that shows or that others didn't). Each judge's process verdicts weigh a third of its film verdicts, so
  process is a quarter of the ranking (`PROCESS_SHARE`), and both parts are reported.
- **The leads are told**: their rules gain "How you're judged", with the split and the process rubric.
- **Git moves are counted** (save, restore, compare) per team per round, on the season page beside the
  film and process parts.

The bar for the next dry run: every team makes at least two Git moves in some round. If the note alone
doesn't change behaviour, the next step is the history as material (a rival's or an abandoned shot in the
final cut, with its provenance in the commit).

Tests: `test/process.test.ts`.

## D35: several ideas for one shot, side by side

The original idea for Artifacts here was advancing several ideas in parallel on branches. The pieces were
there (every take is its own branch, and a print merges one per shot), but a take was only ever a retry or
a note's rewrite: nobody could say "shoot shot 3 three different ways". In Season 1, Opus got there by hand:
its second comparison differed from the saved version only in shot 1, a one-shot test of two ideas.

- **`ideas`**: a lead names two or three ideas for one shot (`{"name", "idea"}`); each becomes a take on its
  own branch (`cell/03/take-N`), shot in parallel. The idea goes to the cinematographer ("the idea wins
  where it changes the staging or framing") and onto the branch as `cells/03/idea.md`; the commit says
  `idea "mirror"`. Retakes keep the idea; a print brings `idea.md` to main, so main says which idea won.
  Branch names stay `take-N`, so printing, restoring and the board views work unchanged.
- **Comparing two ideas**: `compare` accepts take branches (`cell/03/take-3`), each judged on a sheet of the
  shot before, the take and the shot after: the idea in its place.
- **Hidden from rivals**: the public move is "shot 2 ideas for cell 03"; what they are stays with the team,
  so rivals don't know which reaches the judges until it prints.
- **Judged as process**: `ideas` counts as a Git move, and the creative criterion names it.
- **Season 2's finale**: no elimination and no wildcard. With one team per lab, a Sonnet wildcard could
  have left two Claude teams in a three-team finale; all three labs now reach it, with protect and steal.

Tests: `test/ideas.test.ts`.

## D36: the format dry run with Git in the format, and a renderer that can fail over

**Round 1** (`season-2026-10-08-d88e0c`: Opus, GPT, Gemini; 45 minutes, $10, the network note): the
behaviour D34 and D35 were for. Every team made five to seven Git moves, against none in the first dry
run. Opus ran ideas, compare, print three times (shots 3, 4, 5: 63%, 60%, 68%) and cut v2 "with the board
we chose through three side-by-side comparisons" and lines rewritten for the note; Gemini compared its cut
against Opus's board (lost, 13%); GPT saved twice, ran ideas on two shots, and replanned for the note too
late to cut it. The panel: Opus 64%, GPT 57%, Gemini 30% (film 65/61/25, process 60/47/43). The Gemini
judge gave Gemini's team its lowest film score of the three judges (19%).

- **The panel crashed the first time**: 18 film comparisons at once, Gemini's each with two teasers inline,
  took the Worker down with three final-score jobs beside it, and the round fell back to Clef's live
  comparison. Each judge now runs its matchups one at a time (round 1's panel, re-run, completed).

**Round 2, the blind finale, produced no film.** Every full-size shot failed with 3043 ("Internal server
error") from flux-2-dev, which every team had drafted, for the whole 34 minutes; the same model rendered
portraits and location plates in the same minutes, and full-size shots with references until about 22:47.
All three teams were disqualified (no video), so the season stands on round 1.

- **A renderer that keeps failing hands over** (`RENDER_FALLBACK`): after its retries, flux-2-dev's shot
  goes to flux-2-klein-9b, and klein-9b's to klein-4b. `render.json` records the model that shot it and
  `fell_back_from`.
- **No film, no panel**: a round where no team has a mixed teaser isn't ranked on process alone.

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

## D37: a pool of named mixers

The finale re-run (`season-2026-10-09-9a632a`) lost every round 1 mix to "Maximum number of running
container instances exceeded", with only three teams mixing and three minutes of waiting. Each mix had
asked for a fresh, uniquely named instance; instances didn't give their slots back as they slept, so the
cap of 10 filled across a session's mixes. With no teaser, the panel didn't judge (D36), and round 1 stood
on Clef's live comparison.

- **Mixes now go to a fixed pool of eight named mixers** (`mixer-0` … `mixer-7`), under the cap and reused
  while warm. A mix starts at a random slot and moves to the next on each busy retry.
- **Each mix works in its own directory** (`?mix=<id>`) on a shared instance, cleared after `/extract` or
  a failed run.
- Checked live after deploying: the first re-mix waited two minutes for slots held by instances from
  before the pool; the next two, run together, started at once. Round 1's three teasers are mixed now.

The season ran two rounds, not one: `POST /seasons` asks for at least two. So the re-run tested the whole
finale too: Gemini's steal hit GPT's protected player and was blocked.

**The finale (round 2), blind, judged by the panel:** GPT 65%, Opus 57%, Gemini 28% (film 66/57/28,
process 63/59/29). Every mix went through the pool on its first try. The judges agreed on the film order
except Gemini's judge, which put Opus first by a hair (64.5% to GPT's 64%). Git moves fell in the finale:
GPT 3 (save, ideas, compare), Opus 1 (ideas), Gemini 0 (eight notes on one board instead). The season ended
GPT 5, Opus 5, Gemini 2.

- **Rate limits lost ten takes** (`3021`, the per-minute request limit), with no retry. Image renders now
  retry it on the same model after 20, 40, then 60 seconds; it never triggers the fallback (D36), which is
  for a model that's failing, not busy. The fallback itself still hasn't been needed live.

## D38: the history on screen, and time to use it

The finale re-run's Git moves fell to 3, 1 and 0. Read turn by turn, the cause wasn't the scoring:

- **Running work held the lead.** Any open job forced "wait": Opus spent 34 of 45 minutes waiting and
  decided 9 times. Two ideas for one shot was the only parallel work a team could start.
- **Rate limits ate the opening.** Eighteen first takes at once hit Workers AI's per-minute limit; Opus
  spent four of its nine decisions re-shooting failures, and its one Git move was ideas "to fill the hole".
- **The clock stopped early.** With a cut in hand, submitting was forced at twice a cut's time, 15 minutes
  before the deadline; every team was in by 03:05 for a 03:14 deadline.
- **Crew pushback cost two turns a note.** Gemini noted, was pushed back, and noted again to accept the
  suggestion, eight times.

GPT, the one team with time to spare, saved its safe cut, replanned, shot two endings and compared them.

**Time to use it:**

- **The lead works beside running work.** With jobs open it's asked again when one finishes (or right
  after it acted), and waits for free otherwise (`fresh` in the summary). While a cut renders, only moves
  that leave `main` alone are offered (takes, ideas, notes, sound, saves, compares), since the cut's clips
  read `main` as they render.
- **Submission is forced only when another cut can't finish** (a cut's time, not twice it). A cut still
  rendering at the deadline doesn't count; the latest assembled before it does.
- **First takes are staggered** (8 s apart from a random start), and rate-limited renders wait 20, 40, 60,
  80, 100 seconds, jittered, on the same model.
- **A pushback with a suggestion is shot as suggested**, unless the note said `"insist": true`, which shoots
  the lead's note whatever the crew says. A pushback with no suggestion still holds the note.

**The history on screen** (both `format` options, so a season chooses them):

- **Two endings** (`format.two_endings`): the finale's network note asks for two endings of the last
  shot, as ideas on their own branches, and the cut with the one the team believes in. At judging, every
  panel judge sees the shot before and both endings as stills, both ways round; the team's pick is a bet,
  and the process record says whether the panel agreed (`endings` in `comparative.final.json`). Stills on
  both sides, since only the submitted ending was animated.
- **"Previously on"** (`format.recap`): a `recap` move copies two to four frames from take branches that
  didn't make it into `recap/` on `main`; the mix opens the teaser with them, washed out, in four seconds
  taken from the film (every shot after is trimmed by the same share, so a 30-second film stays 30), and
  commits them to the cut. (At first the recap was added on top, 1.2 seconds a still, and teasers ran to
  34.8 seconds in the dry run.) A new recap changes the mix's signature, so a free remix carries it. Only a
  team that kept its history has one, and the panel sees it in the film. It counts as a Git move.

Checked in the mixer image: two webp stills and a clip mix to 5.4 s with the stills desaturated. Tests:
`test/history-on-screen.test.ts`, and the round rules in `test/arena-rules.test.ts`.

**The dry run** (`season-2026-10-09-1c5fd1`: Opus, GPT, Gemini; two rounds of 45 minutes, $10; the note,
two endings, recap). Git moves went from 3, 1 and 0 in the finale re-run to:

| | Round 1 | Finale | Round 1 result (film, process) | Finale result (film, process) |
|---|---|---|---|---|
| Gemini | 17 | 20 | 58% (52, 76) | 63% (59, 77) |
| GPT | 11 | 12 | 47% (46, 52) | 51% (58, 30) |
| Opus | 6 | 8 | 45% (52, 22) | 36% (34, 44) |

- **Leads worked beside their renders**: twelve moves each in the first twelve minutes, with one or two
  waits a lead chose; the rest waited for free.
- **Every team made a recap**, and the judges noticed: Opus turned the black-and-white takes its
  cinematographer had got wrong into "previously on", which all three judges called the round's most
  creative move. Recaps pushed teasers past 30 seconds (31.6 to 34.8); they now take their four seconds
  from the film.
- **The judges judge effect, not count**: their notes trace whether each comparison's winner reached the
  submitted cut. Opus lost round 1's process on that: out of money for a second cut, its later work never
  reached the film.
- **Every team shot two endings when the note came**, and Opus and Gemini compared them, but no bet was
  judged: `idea.md` was missing from every idea take. `WorkingTree.commit` wrote files, then removed the
  ones the branch inherited from `main`, and `idea.md` was both, so it went. A commit now never removes a
  path it writes. A bug since D35: ideas still ran as branches, but nothing could tell them from retakes.
- **Interrupted cuts**: Gemini's first finale cut lost all six clips at once, its video jobs sharing one
  invocation beside its takes. A cut's clips are now queued three seconds apart.
- **Rate limits** still failed a few takes, in bursts after ideas and replans: Clef and the lead's calls
  now wait out the per-minute limit too.

**Season 2, round 1** (`season-2026-10-09-fe8616`): Git moves 13 (Opus), 12 (GPT), 24 (Gemini); GPT won
on film (62%), the round 55/48/47. Opus and GPT both drafted flux-2-dev and lost 5 and 7 takes to its
per-minute limit after five minutes of retries each; Gemini, on flux-2-klein-9b, lost none. A rendering
model with a lighter one to hand now gives a rate limit a minute (20 and 40 s), then hands over (D36's
fallback, which had been for failing models only); a model with none still waits five minutes.

## D39: out of credits is a pause, not a result

**Season 2, round 2 and the finale** (`season-2026-10-09-fe8616`): the AI Gateway's prepaid credits ran out
during round 2. Live scoring had GPT 75%, Opus 59%, Gemini 16%; the final panel then got `2021:
Insufficient AI Gateway credits` on every call, counted each as even, and recorded an exact three-way tie
at 50% on film and process. Protect and steal fell back to their defaults (no lead could answer). In the
finale, every lead's required plan failed the same way and was re-queued every 25 seconds: all 60 turns
per team were gone in 26 minutes, and no team planned a shot. Third-party models (the frontier leads and
judges, most video models) are all paid from those credits, so nothing degrades gracefully: everything
stops at once.

- **A team pauses**: a job that failed for want of credits, or a lead that couldn't answer for the same
  reason, makes the turn wait two minutes and try again, as often as it takes. Pauses aren't turns, and a
  plan that failed gives its turn back (`creditsFailure`, `turnsUsed`). The clock still runs: a long gap
  still costs the team its round, but not its turns.
- **The panel records nothing**: out of credits, the final judging fails instead of writing a tie, and the
  season step won't record a round whose final judging failed that way. After a top-up,
  `POST /seasons/:id/events {"round", "step": "judge"}` judges it again and records it. The panel's calls
  also wait out rate limits now, as the leads' do (D37); they used to retry once, at once.
- **A season checks the balance first**: `POST /seasons` refuses (402) when the balance is below what the
  season can cost, about three quarters of every team's budget each round plus $2 for each panel (rounds 1
  and 2 spent 75% and 53%); `"ignore_credits": true` starts it anyway. Reading the balance takes an API
  token with AI Gateway Read (`CF_ACCOUNT_ID` and `AI_GATEWAY_TOKEN` in `.env`); without one there's no
  check. `GET /credits` shows the balance.
- **Thirty seconds**: Gemini's round 1 teaser ran 40 s (eight 5 s shots). The mix now fits any film to
  `FILM_SECONDS`, trimming every shot by the same share, as the recap already did.

- **Voices over voices**: the mixes' Whisper transcripts show where the overlap comes from. GPT's round 2
  teaser (Wan, no sound of its own) transcribes as exactly its eight lines. Opus's (FLUX.3 Video) says "This
  season, we don't have to pick", then the clip itself says "You don't need to choose only one option": the
  model is asked for ambience only and voices its shot's beat anyway. A clip's own sound now drops out
  wherever a line is spoken over it (`quietUnderLines`), the score carrying those seconds, and a voiced
  model's prompt loses the beat's quoted lines (`unspoken`).

Tests: `test/credits.test.ts`, `test/sound.test.ts`.

## D40: carrying on from a board, and the producer's notes

**After Season 2** the teasers were watchable but flat, and a full re-run would have made more of the
same. Two things were missing. First, a team couldn't pick up where it had stopped: every arena forked its
boards from the template (or a team's repo), so a finale that lost its credits mid-round, or a strong round
2 cut worth taking further, meant starting again. Second, nobody outside a team could direct it. The one
way in was a cell note, which became work at once: the lead never learned that the producer had spoken,
and the record didn't say who had.

- **Carrying on from a board**: an arena team can name a board, `{"team": "gpt", "from": "board-gpt-…-r2"}`.
  Its new board forks from that one with every branch (takes, cuts, saved versions), the ledger starts
  empty (the old rows stay in the `jobs` branch's history), and board.json records where it stopped:
  the commit, and the cuts, saved versions and comparisons that came with it. The team keeps its
  showrunner, cinematographer, cast and pinned lead unless given others, drafts a crew for the new budget, and skips
  the plan: its plan and printed shots are its own to keep or change. Its earlier cuts are there to
  watch; the submission must be a new cut (`roundCuts`). The process record says what was carried over
  and counts only this round's moves; the replay shows only this arena's events. This is Git doing what
  it's for: the history is real, and the new round's commits sit on top of it.
- **The producer's notes**: `POST /boards/:repo/producer {"note", "cell"?}` commits a note to
  `notes/producer.json` under the producer's name (`producer@people.storyboard`, not an agent's address).
  It queues no work. On its next turn the lead sees it, is asked even if it was waiting on renders, and
  must answer in `"to_producer"`: what it's doing about it, or why not. The answer is committed beside the
  note under the lead's name. The panel reads each note at the minute it arrived with the answer, and
  "effective" use of the history now includes a note acted on, or argued against for a reason the film
  bears out.
- **Arenas check credits too**: `POST /arenas` refuses (402) like `POST /seasons` when the balance is short
  of one round's estimate.

Who wrote what stays plain: the producer's commits are the producer's, the team's are the team's.

**The rehearsal** (`arena-2026-10-10-9bdc60`: GPT alone, carrying on from its round 2 board, $3, 20
minutes): the fork kept every branch (shot 04's eleven takes), the ledger started empty, the team kept its
lead, cast and cinematographer, and its earlier cut, saves and comparisons were recorded as carried. A
producer's note on shot 03 ("both sheets read SECEND PLACE") was answered on the lead's first chosen
turn ("correcting both sheets with a detail edit now, then printing the repaired take before we cut"),
and the edit came back with "SECOND PLACE" on both sheets, continuity ok. The lead followed its own
lessons from the season: it cut early (turn 5), then spent on continuity fixes and saved before each.
Then the cut failed: the round 2 board had an unfinished cut v2 (clip branches, never assembled, when
the credits ran out), the new cut was numbered v2 again, and all eight clips were rendered, charged, and
refused on the old branches. A cut is now numbered above every cut started (`nextCut`). Short of $0.38
for another, the lead asked the producer in public for "a $0.38 render allowance now", which nothing yet
lets a producer grant.

Tests: `test/producer.test.ts`.

## D41: premium models, by test, and a page that shows them

**After Season 2** the teams' crews were capped by the menu: the best video model a team could draft was
Wan 2.7 or FLUX.3 Video, and the best renderer FLUX.2 dev, which falls back to klein when it's rate
limited. Opus's round 2 confessional of Theo shows the cost: his character's look says "black-rimmed
glasses" and the shot says "glasses pushed up on his forehead", and klein drew both pairs. Every premium
model was tried on that board before joining the menu (`POST /debug/run`, `POST /debug/render`):

- **Video**, on the close-up of Maya (shot 03): **Veo 3.1** (the full model; the Fast tier refuses people)
  animated it in 74 s, ~$0.20/s. **MiniMax H3 Max** did in 22 s, $0.08/s. **Seedance 2.5** refused it and
  rendered the empty corridor (shot 08) in 144 s: like Seedance 2.0 Fast, it won't animate a realistic
  person. **Runway Gen-4.5** refused every one of our frames, people or not, and rendered a 16:9 crop in
  92 s: it takes nothing wider than about 2:1, and ours are 21:9. Veo 3.1 and H3 Max are in the draft;
  Seedance 2.5 and Runway are on the menu as off, with why.
- **Images**, on Theo (shot 06), the same prompt and portrait: **FLUX.2 max** drew both pairs too, tinted
  like sunglasses. **Nano Banana Pro** put one pair on his forehead and left his eyes bare, the only one of
  three, and is the most cinematic. It joins as a renderer (~$0.14 a frame, 3 references, falling back to
  FLUX.2 dev). A **FLUX.2 max edit** of the existing frame ("one pair, pushed up") fixed it and changed
  nothing else, which is what a producer's note about one detail wants; that's next.
- **The shot wins**: every frame with references is now told that where the shot changes how someone wears
  or holds something, the description wins over the reference image.
- **A crew whose model left the menu** downgraded wrongly when it didn't fit its budget (`indexOf` of a
  missing option is -1, so "cheaper" was everything but the dearest); it now goes by price.

**The UI shows it**: a **Models** page (`GET /menu`) lists every option per slot with its price and, for
an option that's off, the check it failed. An arena board shows its team (the lead and the drafted crew,
the budget, where it carried on from) and the producer's notes with the lead's answers, with a box to send
one. The arena page labels each crew's slots. The new-arena form takes teams (a showrunner, a pinned lead,
a board to carry on from) and shows what the arena can cost against the balance
(`GET /credits?rounds=&teams=&budget=`). Links between views work, and a board opened in a background tab
loads.

Tests: `test/crew.test.ts`.

## D42: fixing a detail without shooting again, and catching the impossible

**Theo's two pairs of glasses** (Opus, round 2, shot 06) needed one detail fixed, and the only tools were a
note, which re-shoots the whole frame through the cinematographer and renderer, or a retake, which rolls
the dice again. Nothing flagged it either: the continuity check compares each character with the bible
and the casting portrait, and a second pair of the right glasses matches both.

- **An edit is a take**: `{"edit": {"instruction", "from"}}` on a take job starts from the printed frame
  (`from: "main"`) or a named take, sends it to FLUX.2 max with the instruction and "change nothing
  else", and commits the result as a new take branch: `edit.md` says what and from where, `prompt.md`
  keeps the source take's prompt, which the critic and the continuity check still judge it by. It costs
  the edit (~$0.10) and the critic, with no cinematographer and no render. Print it like any take; the
  source stays on its branch.
- **Three ways in**: `POST /boards/:repo/cells/:id/edits {"instruction", "take"?}`; the lead's new `edit`
  tool (a printed frame, or a finished take named), which the producer's notes point to for "one wrong
  detail in a frame"; and an "Edit take N's frame" button on every shot in the UI.
- **Tried live** on the beekeeper's close-up (`board-2026-10-08-8cff5c`, shot 02): "a single honeybee
  rests on his right cheek" took 23 s, and the bee is there with nothing else changed (though on his left
  cheek: the model read "right" as the viewer's right). Its continuity check flagged his hair as light
  brown (p=0.12) where the same pixels had passed before: the colour checks are noisy near their bar.
- **The impossible, caught**: every continuity check now asks whether anything in the frame is impossible
  or duplicated (two of the same item worn at once, extra hands, an object through another) and calls it a
  break above 0.6. Clef said 0.85 and 0.76 to the two frames with both pairs of glasses, and 0.01-0.06 to
  five correct frames of Theo and four ordinary frames from the same season.

Tests: `test/producer.test.ts`, `test/continuity-rules.test.ts`.
