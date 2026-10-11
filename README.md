# Storyboard

Agents make short films on Cloudflare, and **every board is a Git repo** in
[Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/). A director agent plans
the shots, casting renders the characters, one agent chain per shot works in parallel on its own branch
(cinematographer → renderer → critic → continuity), and the approved frames become an image-to-video cut.
Every prompt, frame, note, model choice and judgment is a commit, so nothing is lost and anything can be
replayed.

On top of single boards sits an **arena**: autonomous agent teams answer the same brief with a budget and a
deadline, draft their own crew of models, direct their boards without a person in the loop, and are judged
live. A **season** runs the same teams over several rounds; between rounds each team reviews its results and
rewrites its own strategy, and the diff of its skill file is the team learning.

Built for Cloudflare's ["Build the next Git platform"](https://www.cloudflare.com/git-competition/)
challenge (deadline **Oct 14, 2026**), which asks for *multiple agents working concurrently on changes*
and not "GitHub with agents added on top".

## How Git maps to film work

| Git | Here |
|---|---|
| a repo | a board (and an arena, a season, a team) |
| a branch | a **take** of one shot (`cell/03/take-2`), a clip (`cut/v1/03`), a cut (`cut/v2`), a saved version (`alt/safe`) |
| parallel branches | **ideas**: two or three different takes of one shot, shot side by side, one printed |
| a merge | **printing** a take onto `main`; a board's first cut is one octopus merge |
| a revert-forward | **restoring** an earlier version as a new commit, so nothing is lost |
| a diff, judged | **compare**: the judges put two versions side by side before the team chooses |
| reading old branches | **"previously on"**: a teaser opens on stills from takes that didn't make it |
| a fork | a new board from the skills template; a season's boards from each team's repo |
| a commit trailer | which skill version made a frame (`Skill: cinematographer-noir@b38fe1e`), who a team learned from (`Learned-From:`) |
| a CSV on its own branch | the **jobs ledger** (`jobs.csv` on `jobs`): coordination state for every agent job |
| a rejected push | the coordinator's only lock: take numbers, budgets and "print exactly once" are all compare-and-swap commits |
| `git log` | the production itself, replayable as video |

## Where things stand (2026-10-09)

Working and deployed (Workers, Artifacts, Queues, Workers AI, AI Gateway, Images, all driven by the `cf` CLI):

- **Boards**: plan → cast → parallel takes → continuity checks → automatic retakes → print → video cut.
  Notes are routed by Clef (reseed, rewrite, match the bible, edit the bible, nothing) and acted on.
- **Skills** in each board repo (`skills/*/SKILL.md`): director, casting, three cinematographer styles,
  three showrunners, two judges. Edit them per board; promote good ones to the template.
- **Continuity**: characters stay the same person across frames (casting portraits as references, Clef
  comparing hair and outerwear against the portrait), and so do sets and staging: scouted location
  references, blocking and screen positions in the plan, and Clef checking place, sides, blocking and head
  count before a take can print.
- **Video**: printed frames animated (Wan 2.7, Hailuo 2.3, FLUX.3 Video with its own sound, and others on
  the crew menu) and assembled into `cut/vN` with an edit decision list, then mixed with the score and
  lines by ffmpeg in a pool of Containers into `teaser.mp4`.
- **Jobs**: every unit of work is a queued job coordinated through the jobs ledger; a 6-cell board with
  retakes and a print takes about 80 s, with cells shot in parallel.
- **Arenas**: three showrunner teams, $5 and 20 minutes each, crews drafted from a priced menu, live
  scoring, comparative judging (boards side by side, both ways round), replays recorded into the arena repo.
  Two arenas run so far; in the second, the premium crew won 71% of side-by-side matchups.
- **Lead models and Git as a tool**: each team's lead (open models up to Claude Opus 5.5 and GPT-6.1 Sol)
  decides every turn from a manual of tools that includes Git: save a version, restore an earlier one,
  have the judges compare two, print an earlier take, submit an earlier cut.
- **Seasons**: teams over several rounds; retrospectives rewrite each team's strategy, or return to an
  earlier version that did better. In the comparison season (same skill, different lead models), Claude
  Opus 5.5 won both rounds, and in round 2 saved, compared twice, restored its saved version and submitted
  the cut made from it.
- **Tests**: 186 unit tests (`npm test`), live model evals (`npm run eval`), an end-to-end smoke test.

### Season 2

[Season 2](docs/season-2.md) is a 30-second teaser about the show itself, with sound and dialogue, made by
three teams led by Claude Opus 5.5, GPT-6.1 Sol and Gemini 3.1 Pro. Built for it:

- **A cast**: every agent a named character with a bio and a voice; players drafted, their models hidden;
  a crew room, a commons, confessionals and judges' remarks, all committed to the repos (D28).
- **Sound**: a score and lines written by the players in their dealt voices, mixed into every cut (D30).
- **The format**: rivals' moves visible with public messages beside private reasons, twists offered as
  trades, and protect and steal before a blind finale (D31, D35).
- **The panel**: Claude, GPT and Gemini rank each round's finished teasers, every judge with frames and a
  transcript of the mix, Gemini with the film itself (D32, D33).
- **Judged on its history**: a quarter of the ranking is how each team used its repository, with a
  mid-round note from the network to give a saved version a reason to exist (D34).
- **Ideas**: two or three takes of one shot on their own branches, compared in place, one printed (D35).
- **The history on screen**: the finale asks for two endings of the last shot, and the panel's verdict on
  the team's pick counts; a teaser may open on "previously on" from takes that didn't make it. Leads work
  beside running renders instead of waiting on them (D38).

Three dry runs and a finale re-run found and fixed a renderer outage (D36), a mixer that ran out of
containers, rate limits (D37), and ideas that lost their idea files (D38). In the last, teams made 6 to 20
Git moves a round, against 0 to 3 before. The first full run of Season 2 made 9 to 24 Git moves a round,
then ran out of AI Gateway credits in round 2, which cost that round's judging and the whole finale: a
season now checks the balance before it starts, teams pause instead of spending turns when credits run
out, and an unjudged round waits to be judged again (D39). A clip's own voice no longer talks over the
team's lines, and the remixed teasers are 30 seconds.

Rather than run the same season again, the next round carries on from where teams stopped: an arena team
can fork from an earlier board with every branch, and its submission must be a new cut. A human producer
can send notes to any board, which the team's lead must answer, and the panel reads both (D40). Teams can
now draft Veo 3.1 for video and Nano Banana Pro for frames, each chosen by a test on Season 2's own shots,
and the UI's Models page shows every option, its price and why any is off (D41). One wrong detail in a
frame can be fixed by an edit instead of a re-shoot, and the continuity check now catches the impossible,
like a second pair of glasses (D42). A job that fails for the platform's reasons is refunded to the team (D43).

## Getting started

Deploy your own copy to your own Cloudflare account. Nothing in the code is tied to ours: the account,
the access key and the gateway token all come from your `spike/.env`.

**You need**

- A Cloudflare account on the **Workers Paid** plan with access to the
  [Artifacts beta](https://blog.cloudflare.com/artifacts-git-for-agents-beta/). Without Artifacts there are
  no repos, so nothing runs.
- **Node 22.6 or newer** (the tests run TypeScript directly), and `git`, `jq`, `curl` and `openssl`.
- **Docker**, running: the deploy builds the mixer's ffmpeg container image (`spike/mixer/`) locally.
- **AI Gateway credits** on the account's `default` gateway, with a spend limit. The frontier leads and
  judges (Claude, GPT, Gemini), most video models (Veo 3.1, H3 Max) and Nano Banana Pro are paid from them.
  Workers AI models (Llama, Kimi, FLUX.2, Clef) are billed to the account as usual. A first board costs
  cents; an arena costs about three quarters of the teams' combined budget plus $2; a season is that per round.

**Steps**

```sh
git clone <this repo> storyboard && cd storyboard/spike
npm install                # includes the `cf` CLI
npx cf auth login          # opens the browser to authorize your account
npm run setup              # the `storyboard` Artifacts namespace, the jobs queue, a SPIKE_KEY in .env
npm run deploy             # types, tests, deploy (Worker + mixer container), the skills template; prints the URL
export STORYBOARD_URL=https://storyboard-spike.<your-subdomain>.workers.dev
npm run smoke              # a real 2-cell board, end to end (a few cents)
```

Open the printed URL and paste `SPIKE_KEY` from `spike/.env`. From there: a new board, a new arena or a new
season; the Models page shows every model a crew can draft and its price. Each arena has a **Replay** button.

**Optional: a balance check.** Add `CF_ACCOUNT_ID` and `AI_GATEWAY_TOKEN` (an API token with
*Account → AI & Machine Learning → AI Gateway → Read*) to `spike/.env` and deploy again. Then `GET /credits` shows the balance, and an
arena or season that the balance can't cover is refused with a 402 before it spends anything.

**What you start with.** A fresh deploy has the skills from [`skills/`](skills/) and no history: our seasons,
casts and boards live in our account, so carrying on from them (D40) isn't possible on yours. Start a season;
a team can carry on from any board it made. `.env` is gitignored; keep it that way, since `SPIKE_KEY` is the
only thing between the public workers.dev URL and your AI credits.

[`spike/README.md`](spike/README.md) has every route, the manual equivalent of each script, and `curl`
examples.

## Docs

- [docs/design.md](docs/design.md): the pipeline, repo layout, agents and where Clef fits
- [docs/arena.md](docs/arena.md): arenas, the crew draft, comparative judging, seasons, both arena runs and what they showed
- [docs/season-2.md](docs/season-2.md): the next challenge, a season preview about the show itself, with sound (design)
- [docs/decisions.md](docs/decisions.md): every design decision, the evidence behind it, and the test that pins it
- [docs/cloudflare-notes.md](docs/cloudflare-notes.md): API facts (Artifacts, Clef, model inputs, prices)
- [docs/competition-plan.md](docs/competition-plan.md): the original plan and demo video outline
- [skills/](skills/): the agent skills every board starts from
- [examples/lighthouse-keeper/](examples/lighthouse-keeper/): a hand-written example of a board's files

## License

[MIT](LICENSE), © 2026 PythonMuse LLC.
