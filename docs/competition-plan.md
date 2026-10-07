# Competition plan

**Deadline: Oct 14, 2026.** Submit a 5–10 minute video, open-source code (MIT/Apache/BSD)
and run instructions. Finalists are announced Oct 16. Read the
[terms PDF](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).
Artifacts needs the Workers Paid plan.

**Must show:** multiple agents changing the same repo at the same time, coordinated through Git
ideas that have been rethought for a new domain.

## Scope (cut ruthlessly)

Must have:
- Concept → director → board of 6–8 cells, committed to a new Artifacts repo
- Parallel cinematographer + renderer per cell on take branches, visible live
- Per-cell notes → Clef-flash router → new take
- One bible edit that fans out re-renders to the affected cells (the blast-radius demo)
- A cell history scrubber + a diff view (CSV word diff, before/after frames)

Nice to have:
- Clef image critic with auto-retake
- Continuity seam between neighbouring cells
- Fork → alternate cut
- Image-to-video for 2–3 cells at the end

Out of scope: auth, multiple users, ComfyUI.

## Days

| Day | Date | Goal |
|---|---|---|
| 1 | Oct 7 | Worker + Artifacts binding; isomorphic-git commit/push of text + a WebP; spike Clef and flux calls |
| 2 | Oct 8 | Director + cinematographer + renderer for one cell, end to end; coordinator DO |
| 3 | Oct 9 | Fan-out across cells with Queues/Workflows; take branches; merge = print |
| 4 | Oct 10 | Frontend grid with live updates, takes, notes box |
| 5 | Oct 11 | Notes router + bible blast radius; history and diff view |
| 6 | Oct 12 | Critic/continuity (Clef with images); polish; video handoff if time allows |
| 7 | Oct 13 | Record the demo, write README/run instructions, add license |
| 8 | Oct 14 | Buffer + submit |

## Demo video outline (~7 min)

1. (0:30) The problem: creative iteration with AI is lossy; one bad prompt overwrites a good frame.
2. (1:00) Type a concept. The director writes the board; show the CSV commit.
3. (1:30) Fan-out: 8 cells render at once, with the branch list growing live.
4. (1:30) Notes: "make her coat red" → the router's probabilities → bible branch → 3 cells
   re-render, the rest are untouched. Show the blast-radius probabilities.
5. (1:00) A conflict: two bible edits disagree, and Clef resolves the continuity break.
6. (0:45) Time travel: scrub a cell's history, restore take 1.
7. (0:45) Fork an alternate cut, then lock and send to video.
8. (0:30) Under the hood: it's just Git. `git clone` the board locally, then `git log --graph`.
