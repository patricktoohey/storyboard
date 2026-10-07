import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_ACTIONS, routerRequest } from "../src/router.ts";

test("the router sees the note, the shot and every character's current look", () => {
	const req = routerRequest("make her older", { beat: "She drives", shot: "MS" }, undefined, [
		{ name: "Driver", look: "58-year-old woman, grey bun" },
	]);
	assert.deepEqual(req.state, {
		note: "make her older",
		shot: { beat: "She drives", size: "MS", prompt: "(not shot yet)" },
		characters: { Driver: "58-year-old woman, grey bun" },
	});
	assert.deepEqual(Object.keys((req.questions.action as { criteria: object }).criteria), Object.keys(NOTE_ACTIONS));
});

test("match_bible and edit_bible are distinguishable by what the bible already says", () => {
	assert.match(NOTE_ACTIONS.match_bible, /already/);
	assert.match(NOTE_ACTIONS.edit_bible, /does not already say/);
});
