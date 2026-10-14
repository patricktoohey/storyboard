// D48: a remake keeps another board's plan and clears everything its renderer made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { remakeClears, remakeRows } from "../src/remake-rules.ts";
import type { CsvRow } from "../src/csv.ts";

test("D48: a remake clears every frame, take output, portrait and set, and keeps the plan, beats, bible and notes", () => {
	const made = ["cells/01/frame.webp", "cells/01/render.json", "cells/01/review.json", "cells/01/continuity.json", "cells/01/inspection.json", "cells/02/prompt.md", "cells/02/idea.md", "cells/02/edit.md", "bible/refs/maya.webp", "bible/locations/the-diner.webp"];
	const kept = ["cells/01/beat.md", "cells/01/notes.md", "bible.md", "characters.json", "locations.json", "storyboard.csv", "concept.md", "board.json", "skills/director/SKILL.md", "sound/score.mp3"];
	assert.deepEqual(remakeClears([...made, ...kept]), made);
});

test("D48: every cell of a remake is a draft again, with no printed take", () => {
	const rows = [{ id: "01", status: "printed", take: "3", beat: "A diner at night" }, { id: "02", status: "draft", take: "" }] as unknown as CsvRow[];
	const out = remakeRows(rows);
	assert.deepEqual(out.map((r) => [r.id, r.status, r.take, r.beat]), [["01", "draft", "", "A diner at night"], ["02", "draft", "", undefined]]);
	assert.equal(rows[0].status, "printed", "the source's rows are not changed");
});
