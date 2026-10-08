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
| a branch | a **take** of one shot (`cell/03/take-2`), or a clip (`cut/v1/03`) |
| a merge | **printing** a take onto `main`; a board's first cut is one octopus merge |
| a fork | a new board from the skills template; a season's boards from each team's repo |
| a commit trailer | which skill version made a frame (`Skill: cinematographer-noir@b38fe1e`), who a team learned from (`Learned-From:`) |
| a CSV on its own branch | the **jobs ledger** (`jobs.csv` on `jobs`): coordination state for every agent job |
| a rejected push | the coordinator's only lock: take numbers, budgets and "print exactly once" are all compare-and-swap commits |
| `git log` | the production itself, replayable as video |

## Where things stand (2026-10-08)

Working and deployed (Workers, Artifacts, Queues, Workers AI, AI Gateway, Images, all driven by the `cf` CLI):

- **Boards**: plan → cast → parallel takes → continuity checks → automatic retakes → print → video cut.
  Notes are routed by Clef (reseed, rewrite, match the bible, edit the bible, nothing) and acted on.
- **Skills** in each board repo (`skills/*/SKILL.md`): director, casting, three cinematographer styles,
  three showrunners, two judges. Edit them per board; promote good ones to the template.
- **Continuity**: characters stay the same person across frames (casting portraits as references, Clef
  comparing hair and outerwear against the portrait), and so do sets and staging: scouted location
  references, blocking and screen positions in the plan, and Clef checking place, sides, blocking and head
  count before a take can print.
- **Video**: printed frames animated with Wan 2.7 or Hailuo 2.3 and assembled into `cut/vN` with an edit
  decision list. Veo, LTX and Seedance were tested and are excluded for now (docs/arena.md says why).
- **Jobs**: every unit of work is a queued job coordinated through the jobs ledger; a 6-cell board with
  retakes and a print takes about 80 s, with cells shot in parallel.
- **Arenas**: three showrunner teams, $5 and 20 minutes each, crews drafted from a priced menu, live
  scoring, comparative judging (boards side by side, both ways round), replays recorded into the arena repo.
  Two arenas run so far; in the second, the premium crew won 71% of side-by-side matchups.
- **Seasons**: built and unit-tested (retrospectives that rewrite each team's strategy, rounds that start
  themselves); a first live season is next.
- **Tests**: 89 unit tests (`npm test`), live model evals (`npm run eval`), an end-to-end smoke test.

Next: a live season, chained video, and the demo video.

## Try it

Everything lives in [`spike/`](spike/) (see its README for routes and details):

```sh
cd spike
scripts/setup.sh      # npm install, the Artifacts namespace, the jobs queue, an access key in .env
scripts/deploy.sh     # tests, cf deploy, then the skills template
scripts/smoke.sh      # a real 2-cell board, end to end (a few cents)
```

Open the Worker's URL and paste `SPIKE_KEY` from `spike/.env`. From there: new board, new arena or new
season; each arena has a **Replay** button. Third-party video is paid from AI Gateway credits, so keep a
balance and a spend limit on the `default` gateway.

## Docs

- [docs/design.md](docs/design.md): the pipeline, repo layout, agents and where Clef fits
- [docs/arena.md](docs/arena.md): arenas, the crew draft, comparative judging, seasons, both arena runs and what they showed
- [docs/decisions.md](docs/decisions.md): every design decision, the evidence behind it, and the test that pins it
- [docs/cloudflare-notes.md](docs/cloudflare-notes.md): API facts (Artifacts, Clef, model inputs, prices)
- [docs/competition-plan.md](docs/competition-plan.md): the original plan and demo video outline
- [skills/](skills/): the agent skills every board starts from
- [examples/lighthouse-keeper/](examples/lighthouse-keeper/): a hand-written example of a board's files
