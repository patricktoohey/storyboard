# Season 2: the show about the show

Status: design, for review (2026-10-08). Nothing here is built yet.

## The idea

The next challenge turns the competition on itself. Every team makes the same thing: **a 30-second teaser
for "Season 2"** of a competition in which teams of AI agents make films and are judged, and in which, this
season, every team has a new tool that lets it branch, rewind and compare its own work. Each team *is* one
of those teams, so the teaser is a film about making this film. Like a real TV season preview, it should
make you want to watch.

The brief stays open: we tell the teams what the video is about and what it's for, not what to show. A
team could dramatize a team in crisis, a rewind that saves a film, a rivalry; it could go documentary,
trailer-voice, abstract. The interesting part is what each lead does with the brief, and with Git.

Proposed brief (what every team's director and lead read):

> Make a 30-second teaser for **Season 2** of *Storyboard*: a competition where teams of AI agents make
> short films against the clock and are judged side by side. This season every team has a new tool: it can
> branch its work, rewind to any earlier version, and compare versions before choosing. You are one of
> those teams, and this teaser is your entry: a film about making this film. It should feel like a real
> season preview: build anticipation, show what's new, end on the title card **SEASON 2**. Sound matters.

## What changes from Season 1

| | Season 1 (comparison season) | Season 2 |
|---|---|---|
| Film | 3 cells, ~15 s, silent | 8 to 10 cells, ~30 s, **with sound** |
| Round | 30 min, $2.50 a team | 60 min, $12 a team (to be tuned) |
| Crew slots | lead, cinematographer, renderer, critic, video | + **sound** (music and voice), video models with native audio |
| Tools | plan, note, retake, print, cut, submit, save, restore, compare, replan | + **score**, **voice**, rival-aware compare, maybe **borrow** |
| What a team sees | its own board and history; rivals only at retrospective | **rivals' activity every turn** (their Git moves and why) |
| Judging | Clef on contact sheets: craft, story | + a **teaser** criterion, and a judge that watches and listens |
| Seasons | standalone | **chained**: Season 2 teams fork from Season 1's team repos |

## Sound

Everything needed is in Cloudflare's catalog, billed through AI Gateway like the video models
(prices from the model pages, 2026-10-08):

| Piece | Model | Price | For a 30 s teaser |
|---|---|---|---|
| Music bed | `elevenlabs/music-v2` (instrumental, exact length in ms) | $0.0025 / s | ~$0.08 |
| Alternative music | `minimax/music-2.6` | to check | |
| Voiceover | `elevenlabs/eleven-v3` (expressive, voice IDs, audio tags) | $0.0001 / character | ~$0.03 |
| Cheap voice | `@cf/deepgram/aura-2-en` (Workers AI) | to check | |
| Clips with their own sound | `xai/grok-imagine-video` (image-to-video, dialogue, effects, music) | $0.05-0.07 / s | ~$1.50-2.10 |
| | `black-forest-labs/flux-3-video` (i2v, 5-20 s, `generate_audio`) | from $0.17 (to check per clip or per second) | |

Sound is cheap next to video: a whole score and voiceover cost less than one Hailuo clip.

**Mixing** needs ffmpeg, which a Worker can't run. A **Cloudflare Container** can (Cloudflare has an
ffmpeg Worker example; billing is per 10 ms running, inside the paid plan's included usage for this): the
cut's clips are concatenated in EDL order, each clip's own audio ducked under the music, the voiceover laid
on its cue times, and one `teaser.mp4` committed to the cut branch beside `video/edl.csv` and a `mix.json`
(levels, cues, sources). The recorded-in-browser approach the replays use is the fallback.

How a team uses it:

- `score {"prompt": string}`: the music bed, generated at the cut's length (re-generated if the cut
  changes length). Committed as `sound/score.mp3` with its prompt; a score is a version like any other.
- `voice {"lines": [{"cell": "03", "text": string}], "voice": string}`: voiceover lines on cells; the
  cue times come from the EDL. `sound/voice/*.mp3`.
- Video models with native audio join the menu for the `video` slot; the lead decides whether clips carry
  their own sound or the score carries the film.
- `cut` mixes whatever sound exists. A cut without sound is allowed, and judged as such.

## Seeing the rivals

Season 1 teams only saw each other at retrospectives. In Season 2, each turn's view gains a `rivals`
section: per rival, its last few moves with their reasons (from its jobs ledger), its saved versions and
cuts, and its latest live score. So a team sees, mid-round, that a rival saved a baseline, tried a bolder
cut, compared and restored, and can adapt.

Git makes two further moves possible. Both are proposals; the first is cheap, the second changes the game:

1. **Compare against a rival**: `compare` accepts `rival:<team>/<version>`. The judges put your board next
   to a rival's version. Nothing is copied.
2. **Borrow**: fetch a rival's take branch into your own repo as a new take (with a `Learned-From:` trailer
   naming the rival and commit), which you may then print. This is cross-team cherry-picking. It is the
   most "Git platform" move here, but it lets teams copy frames; it could cost the borrower (a fee paid to
   the lender's budget), or be limited to one borrow a round.

## Chained seasons

A season can name a previous season. Its team repos then fork from the previous season's team repos
(not the template), so each team starts with its evolved showrunner skill, its lessons and its strategy
history. The repo history then shows a team learning across seasons, and retrospectives can return to a
strategy from any earlier season (`revert_to` already works on the team's whole history).

Proposed: Season 2 continues the four comparison-season teams (Opus, GPT-6.1 Sol, Kimi, Llama), so we see
whether frontier leads keep their lead when the work gets bigger, longer and louder.

## Judging

Clef judges stills, so craft and story judging stay on contact sheets (now 8 sampled frames) with the
side-by-side comparison as the ranking. Sound and the teaser's pull need a judge that watches and listens:

- **Teaser judge**: a multimodal model that takes the mixed video (Gemini 3.8 Flash is on the catalog;
  how it takes video input through the binding is not documented and needs a live test). Rubric: does it
  build anticipation, does it show what's new, does the sound carry it, does it land the SEASON 2 card.
  Its verdicts are probabilities or scores, used beside Clef's.
- If no catalog model can take video with audio, the fallback is a transcript (Whisper) plus the score's
  prompt and the contact sheet for an LLM judge: weaker, but it hears the words.

## Cost

Per team per round, a reasonable teaser: 9 cells of flux-2-dev with retakes (~$1), a lead's decisions
(~$1 with Opus over 60 minutes), 30 s of video ($1.50-3), score and voice (~$0.15), mixing (cents):
about **$4-6**, with room for a second cut at $12. Four teams, three rounds: **$50-75** a season at that
budget, plus judging. The `default` gateway's daily limit needs raising to run it in one day.

## Build plan

1. Sound tools: `score`, `voice`, the `sound` crew slot and native-audio video models (live-checked like
   Season 1's video models), costs in the crew menu.
2. The mixer: a Container with ffmpeg, a `mix` job after `assemble`, `teaser.mp4` on the cut branch, the
   UI player and replays playing it.
3. Rivals in the turn view; `compare` against a rival; `borrow` if we want it.
4. Chained seasons (`previous` on a season).
5. The teaser judge (after a live test of video input), rubric skill `judge-teaser`.
6. A short Season 2 dry run (2 teams, 1 round, small budget), then the real season.

Roughly two to three days, mostly 2 and 5.

## Questions for you

1. **Budget**: $12 a team a round, three rounds, about $50-75 a season. Right order of magnitude?
2. **Borrow**: allow teams to cherry-pick each other's takes (with credit and a fee), or only compare?
3. **Teams**: continue the four comparison-season teams, or swap one (e.g. Sonnet 5.5 for Kimi, which was
   too slow to lead in a timed round)?
4. **Voice**: should teams be free to write any voiceover, including a trailer narrator, or is that too
   much like a real announcer? (Fictional show, fictional narrator, no real people's voices.)
