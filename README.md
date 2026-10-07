# Storyboard

A multi-agent storyboard studio that runs entirely on Cloudflare. **Each storyboard is a
[Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) repo.**

You give it a video concept. A director agent breaks the concept into shots. Cinematographer
agents rewrite each shot in cinema language, and a render agent fills in each cell with a
text-to-image model. Then you give notes on each cell. Every prompt, image, note and model
choice is a commit, so revising is cheap and nothing is lost. When the board is approved, each
cell's image becomes a keyframe for an image-to-video model.

This repo is being written for the Cloudflare
["Build the next Git platform"](https://www.cloudflare.com/git-competition/) challenge
(deadline **Oct 14, 2026**). The minimum requirement is *multiple agents working concurrently
on changes*, and the brief says not to build "GitHub with agents added on top". The pitch:

> Git for creative work isn't about diffs of code. It's a director's notes, alternate takes,
> and continuity. A storyboard maps onto Git's ideas, but each idea gets a new meaning:
> branch = **take**, pull request = **dailies**, merge conflict = **continuity break**,
> fork = **alternate cut**.

## Docs

- [docs/design.md](docs/design.md): architecture, repo layout, agents, where Clef fits, video handoff
- [docs/competition-plan.md](docs/competition-plan.md): scope and a day-by-day plan to Oct 14, plus the demo video script
- [docs/cloudflare-notes.md](docs/cloudflare-notes.md): API facts gathered so far (Artifacts binding, Clef schema, model IDs)
- [examples/lighthouse-keeper/](examples/lighthouse-keeper/): a hand-written sample storyboard repo showing the file layout
- [docs/arena.md](docs/arena.md): design for autonomous agent teams with budgets, deadlines, judges and a live leaderboard (not built yet)
- [docs/decisions.md](docs/decisions.md): design decisions, the evidence behind each, and the test that pins it
- [skills/](skills/): the agent skills (director, cinematographer, casting) that seed every board
- [spike/](spike/): the working Worker; see its README for routes, findings, and `scripts/clone-board.sh`
