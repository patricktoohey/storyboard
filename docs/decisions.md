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
