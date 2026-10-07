import assert from "node:assert/strict";
import { test } from "node:test";
import { insertLooks } from "../src/looks.ts";

const driver = { name: "Driver", look: "58-year-old woman, grey bun" };
const passenger = { name: "Passenger", look: "42-year-old man, leather jacket" };

test("first mention gets the full look, later ones stay grammatical", () => {
	assert.equal(
		insertLooks("The {{Driver}} grips the wheel; the {{Driver}} looks back.", [driver]),
		"The 58-year-old woman, grey bun grips the wheel; the same person looks back.",
	);
});

test("possessives become 'whose' on first mention and 'the same person's' after", () => {
	assert.equal(
		insertLooks("{{Driver}}'s face fills the frame; {{Driver}}'s hands shake.", [driver]),
		"58-year-old woman, grey bun, whose face fills the frame; the same person's hands shake.",
	);
});

test("a character the model never mentioned is appended, not dropped", () => {
	assert.equal(
		insertLooks("Rain on the windshield.", [passenger]),
		"Rain on the windshield. Featuring 42-year-old man, leather jacket.",
	);
});

test("bare names are not trusted; the look is still added", () => {
	assert.match(insertLooks("Driver kneels.", [driver]), /Featuring 58-year-old woman, grey bun\.$/);
});

test("placeholders for characters not in the frame are removed", () => {
	assert.equal(insertLooks("Empty street {{Ghost}}.", []), "Empty street .");
});
