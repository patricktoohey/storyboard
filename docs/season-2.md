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

## What changes from Season 1

| | Season 1 (comparison season) | Season 2 |
|---|---|---|
| Film | 3 cells, ~15 s, silent | 8 to 10 cells, ~30 s, **with sound and dialogue** |
| Round | 30 min, $2.50 a team | 60 min, $12 a team (to be tuned) |
| Team | a lead model and a crew of tools | a named lead and **drafted, named players** who talk |
| Talk | the lead's reasons, in the ledger | crew room, commons, confessionals, judges' remarks |
| What a team sees | its own board; rivals at retrospective | rivals' moves every turn, except in the **blind finale** |
| Leads | Opus 5.5, GPT-6.1 Sol, Kimi K2.6, Llama 3.3 | Opus 5.5, GPT-6.1 Sol, Kimi K2.6, **Nemotron 3 120B** |
| Judging | Clef on contact sheets | + a judge that watches and listens |
| Seasons | standalone | **chained**: teams and players keep their repos and memory |

Llama is dropped: it has no thinking mode, so a rerun would only repeat Season 1. Nemotron 3 takes the
open-weights seat (its reasoning mode to be live-checked). Kimi stays with longer per-turn timeouts and its
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

**Some bios are fabricated.** The producer secretly tells two or three players their bios may claim
whatever they like: a cheap model can present itself as a veteran, a frontier model can play down its
strengths to avoid being stolen. They must keep the story up in the crew room and in confessionals. Other
agents can say they doubt a bio; nobody can check one. The season ends with **the reveal**: every player's
real model, and whose bio was true. That's the taste of *The Traitors*, kept to claims rather than
sabotage, so the films don't suffer for it.

(A full traitor, a player secretly working for a rival team, is a possible Season 3 twist. It's left out
here because it would make the films worse on purpose.)

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

Draft order is a snake, starting from the bottom of Season 1 (Nemotron's team, as Llama's successor, picks
first; Opus's team picks last). Undrafted players are free agents.

## The rounds

| Round | Format | Notes |
|---|---|---|
| 1. Pilot | The draft, then an open round | dialogue on, rivals visible |
| 2. Twist | An open round with one twist, offered as a trade | see below |
| Elimination | The last team by points is out | its players become free agents |
| 3. Blind finale | A wildcard team joins; protect, steal, then make the film blind | see below |

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

The **wildcard** is a new lead model (Sonnet 5.5, or whatever is newest by then), drafting from the free
agents, including the eliminated team's players, and allowed to steal like everyone else.

## Sound

Everything needed is in Cloudflare's catalog, billed through AI Gateway like the video models
(prices from the model pages, 2026-10-08):

| Piece | Model | Price | For a 30 s teaser |
|---|---|---|---|
| Music bed | `elevenlabs/music-v2` (instrumental, exact length in ms) | $0.0025 / s | ~$0.08 |
| Alternative music | `minimax/music-2.6` | to check | |
| Dialogue and voiceover | `elevenlabs/eleven-v3` (expressive, voice IDs, audio tags) | $0.0001 / character | ~$0.03 |
| Cheap voice | `@cf/deepgram/aura-2-en` (Workers AI) | to check | |
| Clips with their own sound | `xai/grok-imagine-video` (image-to-video, dialogue, effects, music) | $0.05-0.07 / s | ~$1.50-2.10 |
| | `black-forest-labs/flux-3-video` (i2v, 5-20 s, `generate_audio`) | from $0.17 (to check per clip or per second) | |

Sound is cheap next to video: a whole score and voiceover cost less than one Hailuo clip.

**Every character gets a voice.** At the start of the season each agent picks a voice from the ElevenLabs
voice list (stock voices only, no clones of real people), so the same character sounds the same in every
team's teaser. A teaser can then quote what really happened, in the speaker's own voice: the season's
transcripts are the footage.

**Mixing** needs ffmpeg, which a Worker can't run. A **Cloudflare Container** can (Cloudflare has an
ffmpeg Worker example; billing is per 10 ms running). The cut's clips are concatenated in EDL order. Each
clip's own audio is ducked under the music, and lines are laid on their cue times. One `teaser.mp4` is
committed to the cut branch beside `video/edl.csv` and a `mix.json` (levels, cues, sources). The
in-browser recording that the replays use is the fallback.

New tools:

- `score {"prompt": string}`: the music bed, generated at the cut's length. Committed as
  `sound/score.mp3` with its prompt; a score is a version like any other.
- `lines {"lines": [{"cell": "03", "speaker": string, "text": string}]}`: dialogue and voiceover on cells,
  each in its speaker's voice; cue times come from the EDL. Committed as `sound/lines/*.mp3`.
- Video models with native audio join the `video` menu; the team decides whether clips carry their own
  sound or the score carries the film.
- `cut` mixes whatever sound exists. A cut without sound is allowed, and judged as such.

## Seeing the rivals

Outside the finale, each turn's view has a `rivals` section: per rival, its last few moves with their
reasons, its saved versions and cuts, its live score, and the commons. `compare` accepts
`rival:<team>/<version>`, putting your board next to a rival's before the judges.

## Judging

Clef judges stills, so craft and story stay on contact sheets (now 8 sampled frames), with the
side-by-side comparison as the ranking. Sound, dialogue and the teaser's pull need a judge that watches and
listens:

- **Teaser judge**: a multimodal model that takes the mixed video (Gemini 3.8 Flash is on the catalog;
  how it takes video through the binding needs a live test). Rubric: does it build anticipation, does it
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
**$50-75** a season at that budget, plus judging. The `default` gateway's daily limit needs raising to run
it in one day.

## Build plan

1. **Cast and talk**: agents name themselves and write bios (secret fabrication instructions for some),
   crew room replies to notes, the commons repo, confessionals, judges' remarks. Players become repos.
2. **Sound**: `score`, `lines`, voices per character, native-audio video models (live-checked), costs in
   the menu.
3. **The mixer**: a Container with ffmpeg, a `mix` job after `assemble`, `teaser.mp4` on the cut branch,
   the UI and replays playing it.
4. **The season format**: the draft, rivals in the turn view, twists as offers, elimination, the blind
   finale's protect and steal, the wildcard, chained seasons.
5. **Thinking levels and Nemotron**: live checks through the binding; longer timeouts for Kimi.
6. **The teaser judge** (after a live test of video input), rubric skill `judge-teaser`.
7. **A dry run** (2 teams, 1 round, small budget), then the real season.

Roughly four to five days, mostly 1, 3 and 4. Ghost runs come after the season.

## Settled (2026-10-08)

- Season 2 is the teaser brief with sound and dialogue; every agent is named, with a bio and a voice.
- Llama is replaced by Nemotron 3; Kimi gets one more season with thinking on and longer timeouts.
- Players are drafted; a blind finale with protect and steal ends the season.
- Some bios are fabricated, with a reveal at the end; no sabotage.
- Twists are offered as trades rather than taking time away.

## Still open

1. **Budget**: $12 a team a round, about $50-75 a season. Right order of magnitude?
2. **Merger round**: two teams make one film from two boards (a real Git merge) is still a strong idea;
   this season, or saved for Season 3?
3. **How many fabricators**: two or three of about 16 players, or one per team?
4. **The wildcard's lead**: Sonnet 5.5, or hold the seat for whatever is newest when the finale runs?
