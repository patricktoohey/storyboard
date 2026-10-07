import assert from "node:assert/strict";
import { test } from "node:test";
import { noteHistory, noteLine, notesHeader } from "../src/notes.ts";

const at = new Date("2026-10-07T03:57:12Z");

test("a note line records time, text and the route", () => {
	assert.equal(
		noteLine(at, "Shoot from the back seat", "rewrite_prompt", 0.8913),
		"- 2026-10-07 03:57: Shoot from the back seat → **rewrite_prompt** (p=0.89)\n",
	);
});

test("history returns just the notes, oldest first", () => {
	const md = notesHeader("04") + noteLine(at, "first", "rewrite_prompt", 0.9) + noteLine(at, "second", "no_op", 0.5);
	assert.deepEqual(noteHistory(md), ["first", "second"]);
});

test("multi-line notes are flattened so the log stays one line per note", () => {
	const md = notesHeader("01") + noteLine(at, "older\n  with grey hair", "edit_bible", 0.8);
	assert.deepEqual(noteHistory(md), ["older with grey hair"]);
});

test("notes containing arrows or markdown survive", () => {
	const md = notesHeader("01") + noteLine(at, "pan left → right, keep **her** centred", "rewrite_prompt", 0.7);
	assert.deepEqual(noteHistory(md), ["pan left → right, keep **her** centred"]);
});
