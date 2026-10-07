// Design decisions, pinned. Each test names a decision from docs/decisions.md and fails if it is undone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkingTree } from "../src/git.ts";
import { cellsToReshoot } from "../src/router.ts";
import { usesPortraits } from "../src/vocab.ts";

// The remote is never contacted: these tests only commit locally
const offline = { url: "https://example.invalid/repo.git", token: "unused" };
const agent = { name: "test" };

test("D3: casting portraits are references only for MS and CU", () => {
	// Head-and-shoulders references dragged EWS and ECU frames into medium shots (6-cell lighthouse run)
	assert.deepEqual(
		(["EWS", "WS", "MS", "CU", "ECU"] as const).filter(usesPortraits),
		["MS", "CU"],
	);
});

test("D6: every cell that lists a recast character is re-shot, whatever Clef says", () => {
	const cells = [
		{ id: "01", characters: [] },
		{ id: "02", characters: ["Driver"] },
		{ id: "03", characters: ["Driver", "Passenger"] },
		{ id: "04", characters: ["Passenger"] },
	];
	// Night Drive: Clef-flash gave cell 03 p=0.33, so it kept the old driver
	assert.deepEqual(cellsToReshoot("02", cells, ["Driver"], ["02", "04"]), ["02", "03", "04"]);
	// The noted cell is always included, in board order, without duplicates
	assert.deepEqual(cellsToReshoot("04", cells, [], ["04", "01"]), ["01", "04"]);
});

test("D9: a take branch drops main's copy of the cell's outputs in its first commit", async () => {
	// A take that had not rendered yet served the previous take's frame from main
	const tree = await WorkingTree.init(offline);
	await tree.commit(agent, "printed take 1", { "cells/03/frame.webp": new Uint8Array([1]), "cells/03/beat.md": "beat\n" });
	await tree.commit(agent, "take 2: prompt", { "cells/03/prompt.md": "p\n" }, ["cells/03/frame.webp", "cells/03/missing.json"]);
	assert.equal(await tree.exists("cells/03/frame.webp"), false);
	assert.equal(await tree.exists("cells/03/beat.md"), true);
});

test("D8: printing is a merge whose extra parents are the printed takes", async () => {
	const tree = await WorkingTree.init(offline);
	const base = await tree.commit(agent, "board", { "storyboard.csv": "id\n" });
	const takes = ["a".repeat(40), "b".repeat(40)];
	const merge = await tree.merge({ name: "editor" }, "Print first cut", takes, { "storyboard.csv": "id\n01\n" });
	assert.deepEqual(await tree.parents(merge), [base, ...takes]);
});
