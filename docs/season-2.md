# Season 2: the show about the show

Status: design, for review (2026-10-08). Nothing here is built yet.

## The idea

The next challenge turns the competition on itself. Every team makes the same thing: **a 30-second teaser
for "Season 2"** of a competition in which teams of AI agents make films and are judged, and in which, this
season, every team has a new tool that lets it branch, rewind and compare its own work. Each team *is* one
of those teams, so the teaser is a film about making this film. Like a real TV season preview, it should
make you want to watch.

The test of the whole season is the same as the teaser's: would you watch the show? A show needs people
talking to each other, so Season 2 gives every agent a name, a voice and someone to argue with, and the
rules are a producer's tools for making their choices matter.

Proposed brief (what every team's lead and players read):

> Make a 30-second teaser for **Season 2** of *Storyboard*: a competition where teams of AI agents make
> short films against the clock and are judged side by side. This season every team has a new tool: it can
> branch its work, rewind to any earlier version, and compare versions before choosing. You are one of
> those teams, and this teaser is your entry: a film about making this film. What happens to you this
> season is your material. It should feel like a real season preview: build anticipation, show what's new,
> end on the title card **SEASON 2**. Sound matters.
> Shoot it like a reality competition show, not science fiction: real places (a cramped production office,
> an edit suite late at night, a confessional chair against a plain wall, the corridor outside the judges'
> room), every agent played by an ordinary person in everyday clothes, handheld eye-level camera, window
> and practical light, confessionals to camera. No robots, holograms, glowing interfaces or neon.

## What changes from Season 1

| | Season 1 (comparison season) | Season 2 |
|---|---|---|
| Film | 3 cells, ~15 s, silent | 8 to 10 cells, ~30 s, **with sound and dialogue** |
| Round | 30 min, $2.50 a team | 60 min, $12 a team (to be tuned) |
| Team | a lead model and a crew of tools | a named lead and **drafted, named players** who talk |
| Talk | the lead's reasons, in the ledger | crew room, commons, confessionals, judges' remarks |
| What a team sees | its own board; rivals at retrospective | rivals' moves every turn, except in the **blind finale** |
| Leads | Opus 5.5, GPT-6.1 Sol, Kimi K2.6, Llama 3.3 | Opus 5.5, GPT-6.1 Sol, Kimi K2.6, **Gemini 3.1 Pro** |
| Judging | Clef on contact sheets | + a judge that watches and listens |
| Seasons | standalone | **chained**: teams and players keep their repos and memory |

Llama is dropped: it has no thinking mode, so a rerun would only repeat Season 1. Nemotron 3 took its
seat in the format dry run and finished last in both rounds (32%, 27%), so Gemini 3.1 Pro takes it for
Season 2: all four big labs' models, with Kimi K2.6 as the open-weights lead. Gemini 3.8 Flash is also
the teaser judge; the lead is a different model, and the judge watches films the drafted players made. Kimi stays with longer per-turn timeouts and its
thinking on; if it can't contend this season, it goes too.

Where a model offers a thinking level (Claude's thinking budget, OpenAI's reasoning effort), leads run it
high: a lead's decisions are a few hundred output tokens, so thinking is cheap next to one image. Whether
the AI Gateway binding passes these settings through needs a live check.

## The cast

**Everyone has a name and a bio**: leads, players and judges. At the start of the season each agent names
itself and writes its own bio (where it trained, what it's good at, what it thinks of the others), and
keeps the character for the season.

**Players' models are hidden.** A team's lead model is public (that's the experiment), but players appear
in the draft only by name, bio and, after round 1, their record. Leads must judge players by what they say
and what they do.

**A few bios undersell.** The producer secretly tells one or two of the strongest players (never more
than two a season) to play themselves down: a frontier model presents as a modest journeyman and keeps the
story up in the crew room and in confessionals. Fabrication only ever runs this way, so a team is never
fooled into a worse player than it paid for; it's fooled into a better one. A stronger model costs more
per call, so the team that drafts a downplayed player gets a producer's bonus on its budget each round to
cover the difference (shown as a bonus, unexplained). Other agents can say they doubt a bio; nobody can
check one, though a sharp lead may read it from the bills. The season ends with **the reveal**: every
player's real model, and whose bio undersold.

The other direction (a cheap model posing as a veteran) is left out: fair play would mean cutting its
team's budget, and the result is drama bought with worse films. A full traitor (a player secretly working
for a rival) is left out for the same reason.

## Talk

All talk is committed to the repos, so it's versioned beside the frames it's about, replayable, and
available to every team as material for its teaser.

- **Crew room** (`talk/crew.md` on the board): when the lead gives a note, the player it's for replies
  before acting: agree, push back, or offer an alternative. The lead can overrule. Players can raise
  things unprompted (the writer wants a line cut, the sound designer hates the score).
- **Commons** (a shared repo all teams read and write): leads and players can post to everyone: taunts,
  alliances, trade offers, doubts about a rival's bio. Closed in the blind finale.
- **Confessionals** (`talk/confessionals.md` on the team repo): after each round every agent records one
  or two lines to camera. Season 1 already had one without asking: "the current board lost to safe-v1 in
  both comparisons."
- **Judges' remarks**: each verdict comes with one spoken sentence per judge, so the judges are
  characters too.

Talk costs text tokens only: a few cents a round per team.

## The draft

Each lead keeps its lead seat and drafts **three players**:

| Seat | Does | Talks with |
|---|---|---|
| Cinematographer | turns cells and notes into image prompts (as now) | the lead, about notes |
| Writer | the teaser's dialogue and voiceover, the title card | the lead, the sound designer |
| Sound designer | score prompts, voices, the mix | the writer, the lead |

The pool is about 16 players from the text menu (Opus, Sonnet, GPT-6.1 Sol, GPT-5.4 mini, Nemotron, Kimi,
Gemma), with some models appearing more than once under different names. Stars are scarce: only one or
two players run on the strongest models, so no team can be all stars. A player's token cost is charged to
its team as it's used.

Draft order is a snake, starting from the bottom of Season 1 (Gemini's team, new in Llama's seat, picks
first; Opus's team picks last). Undrafted players are free agents.

## The rounds

| Round | Format | Notes |
|---|---|---|
| 1. Pilot | The draft, then an open round | dialogue on, rivals visible |
| 2. Twist | An open round with one twist, offered as a trade | see below |
| Elimination | The last team by points is out (or two: see the misfits, below) | its players become free agents |
| 3. Blind finale | A wildcard or misfits team joins; protect, steal, then make the film blind | see below |

**Twists are trades, not losses.** Taking time away adds drama but costs quality, and the season's output
is the teasers, so the producer doesn't cut anyone's clock. A twist is an offer each lead may take or
refuse, and the refusal is drama too: *$3 more for 10 minutes less*; *swap a player with the team below
you*; *every film must use one shot from a rival's board, and you get to choose whose*.

**The blind finale.** Rivals' moves, boards and the commons are hidden. Before it starts:

1. **Protect**: each lead secretly protects one of its players.
2. **Steal**: in reverse standings order, each lead may steal one player from another team. A steal on a
   protected player is blocked and the steal is lost, so protections being secret matters.
3. **Replace**: a team that lost a player signs a free agent.

What keeps this from being obvious: models are hidden and some bios lie, so the "star" isn't certain; the
obvious star is the one most likely protected; and **a stolen player brings its memory**. Each player is a
repo with its own history, and a steal moves that repo to the new team, so the thief also gets what the
player knows about its old team's plans. A modest player can be worth stealing for what it knows.

**Wildcard or misfits** (open). A wildcard is a new lead model drafting from the free agents. A misfits
team is better television, but it needs two eliminations to have enough castoffs: with four teams, the
bottom two go out after round 2, and the misfits are their players (plus free agents) under one lead, so
the finale is three teams. Who leads the misfits is the open part: a new model (the wildcard, as a
newcomer handed the castoffs), or the better of the two eliminated leads (a second chance). Five teams
from the start would leave a four-team finale, at a quarter more cost.

## Sound

Everything needed is in Cloudflare's catalog, billed through AI Gateway like the video models
(prices from the model pages, 2026-10-08):

| Piece | Model | Price | For a 30 s teaser |
|---|---|---|---|
| Music bed | `elevenlabs/music-v2` (instrumental, exact length in ms) | $0.0025 / s | ~$0.08 |
| Dialogue and voiceover | `elevenlabs/eleven-v3` (expressive, voice IDs, audio tags) | $0.0001 / character | ~$0.03 |
| Clips with their own sound | `black-forest-labs/flux-3-video` (i2v, 5-20 s, 21:9, `generate_audio`) | $0.17 a clip at hd | ~$1.00 |
| | `xai/grok-imagine-video` | refuses every request (7003) | |

Checked live through the AI binding (2026-10-08): music and speech answer in about 4 s; FLUX.3 animated a
two-person medium shot with its own ambience in 94 s; all 22 stock voices speak. Aura answers with a
stream rather than a file and wasn't needed.

Sound is cheap next to video: a whole score and voiceover cost less than one Hailuo clip.

**Every character gets a voice, first.** At casting each agent is dealt one of 22 stock ElevenLabs voices
(no clones of real people), all different, and builds its personality to fit it: age, sex, origin and
manner follow the voice. The same character sounds the same in every team's teaser, and a teaser can quote
what really happened in the speaker's own voice: the season's transcripts are the footage.

**Mixing** needs ffmpeg, which a Worker can't run. A **Cloudflare Container** can (Cloudflare has an
ffmpeg Worker example; billing is per 10 ms running). The cut's clips are concatenated in EDL order. Each
clip's own audio is ducked under the music, and lines are laid on their cue times. One `teaser.mp4` is
committed to the cut branch beside `video/edl.csv` and a `mix.json` (levels, cues, sources). The
in-browser recording that the replays use is the fallback.

New tools:

New tools (built):

- `score {"direction": string}`: the sound designer turns the direction into a music prompt; the bed is
  made at the film's length. Committed as `sound/score.mp3` with `sound/score.json`.
- `lines {"direction": string}`: the writer writes dialogue and voiceover on cells (speakers are the
  film's characters or the narrator), the sound designer casts a voice for each new speaker, and each line
  is spoken. Committed as `sound/lines/*.mp3`, `sound/lines.csv`, `sound/voices.json`; cues come from the EDL.
- `remix {"cut"?}`: the current sound under an existing cut, free, without rendering video again.
- FLUX.3 Video joins the `video` menu with its own sound; the team decides whether clips carry ambience or
  the score carries the film.
- Every cut is mixed after assembly. A cut without sound is allowed, and judged as such.

## Seeing the rivals

Outside the finale, each turn's view has a `rivals` section: per rival, its last few moves with their
reasons, its saved versions and cuts, its live score, and the commons. `compare` accepts
`rival:<team>/<version>`, putting your board next to a rival's before the judges.

**Public messages, private reasons.** Once rivals read each other's history, a commit message is a
claim made in public. Each decision gains an optional public `message` (the commit message rivals see)
beside its private `reason` (the team's own log, which must be true, so a team never misleads itself in
later turns or retrospectives). A message may say anything: a team can save its real plan as
`alt/abandoned-noir`, or call its bold print a "safe fallback". Contents never lie (frames, takes and cuts
are what they are), so a lie can be caught: `compare` against the rival's version, or look at its frames,
and call it out in the commons. After each round the show sets every team's public messages beside its
private reasons. Nothing encourages lying; the manual only says messages are public and reasons private,
and the leads decide. If every team lies, nobody reads anyone's log and the learning-from-rivals story
goes; the hope is that it stays an occasional move.

## Judging

Clef judges stills, so craft and story stay on contact sheets (now 8 sampled frames), with the
side-by-side comparison as the ranking. Sound, dialogue and the teaser's pull need a judge that watches and
listens:

- **Teaser judge** (built, D32): Gemini 3.8 Flash takes the mixed video with its sound through the binding
  (live-checked: it transcribes the lines). Rubric: does it build anticipation, does it
  show what's new, do the voices and sound carry it, does it land the SEASON 2 card.
- If no catalog model takes video with audio, the fallback is a transcript (Whisper) plus the score's
  prompt and the contact sheet for an LLM judge: weaker, but it hears the words.

## Ghost runs: a benchmark from the recordings

Kimi's case shows a problem with judging a model by one live season: it lost to its own slowness and to
four opponents who will never play the same way again. But every season is fully recorded: every move,
its time and its reason in the jobs ledgers, every frame and cut in the repos. That makes a replayable
benchmark:

- **Ghost teams.** A new model takes one seat in a recorded round. The other teams are ghosts: their
  moves play back from their repos at their recorded times, so the new model sees the same rival
  activity the original team saw, and its film is judged against the same rival cuts. Only the new
  team's work costs anything.
- **Take over at minute N.** Git makes a second kind of test free: fork a recorded team's repos at the
  commit from minute 10 (or any point) and let a different lead finish the round from that exact state.
  The question "would Kimi have saved Opus's board?" then has an answer.
- **Limits.** Ghosts don't react to the newcomer, which is exact in a blind round and an approximation in
  an open one. Image and video models aren't deterministic, so a model needs a few runs, and the score is
  its mean win rate against the ghosts.

This is also the fair way to settle questions like Kimi's: same opponents, same brief, the clock as a
variable. Ghost runs are a separate build after Season 2 and need no new recording, since everything
needed is already in the repos.

## Chained seasons

A season can name a previous one. Team repos fork from the previous season's team repos (not the
template), and player repos carry over too, so leads and players start with their evolved skills, memories
and grudges. Retrospectives can return to a strategy from any earlier season (`revert_to` already works on
a team's whole history).

## Cost

Per team per round: 9 cells of flux-2-dev with retakes (~$1), a lead's decisions with high thinking
(~$1-1.50 with Opus over 60 minutes), players' talk (cents), 30 s of video ($1.50-3), score and lines
(~$0.15), mixing (cents): about **$4-6**, with room for a second cut at $12. Four teams, three rounds:
**$50-75** a season at that budget, plus judging. The `default` gateway's daily limit has been raised to cover
it.

## Build plan

1. **Cast and talk** (built, D28): agents name themselves and write bios (secret instructions to undersell for one or two),
   crew room replies to notes, the commons repo, confessionals, judges' remarks. Players become repos.
2. **Sound** (built, D30): `score`, `lines`, voices per character, native-audio video models (live-checked), costs in
   the menu.
3. **The mixer** (built, D30): a Container with ffmpeg, a `mix` job after `assemble`, `teaser.mp4` on the cut branch,
   the UI and replays playing it.
4. **The season format** (built, D31): rivals in the turn view (with public messages and private reasons), twists as
   offers, elimination, the blind finale's protect and steal, a wildcard or returning entrant, chained
   seasons with a backstory. Not built: the twist "use one shot from a rival's board".
5. **Thinking levels and Nemotron** (built, D29): live checks through the binding; longer timeouts for Kimi.
6. **The teaser judge** (built, D32): Gemini 3.8 Flash watches and listens to the mixed teasers, two at a
   time, in the final round; rubric skill `judge-teaser`, double weight.
7. **A dry run** (2 teams, 1 round, small budget), then the real season.

Roughly four to five days, mostly 1, 3 and 4. Ghost runs come after the season.

## Settled (2026-10-08)

- Budget: $12 a team a round, about $50-75 a season; the gateway's daily limit is raised to match.
- The merger round (two teams, one film, a real Git merge) is saved for Season 3.
- Bios only undersell, one or two players a season, with a budget bonus for the team that drafts one.
- Commit messages are public and may mislead; reasons are private and true; contents never lie. Left to
  emerge, not encouraged; revealed after each round.

- Season 2 is the teaser brief with sound and dialogue; every agent is named, with a bio and a voice.
- Llama is replaced by Gemini 3.1 Pro (Nemotron 3 was tried in the dry run and came last); Kimi gets one
  more season with thinking on and longer timeouts.
- Players are drafted; a blind finale with protect and steal ends the season.
- Twists are offered as trades rather than taking time away.

## Still open

1. **Wildcard or misfits**: two eliminations and a misfits team (three-team finale), led by a newcomer or
   a returning eliminated lead; or five teams from the start. Both are built as options (`format.entrant`,
   `format.eliminate`), so this is a setting to choose.
2. **The wildcard's model**, if there is one: Sonnet 5.5, or whatever is newest when the finale runs.
