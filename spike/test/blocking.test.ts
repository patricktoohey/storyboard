// Staging continuity (docs/arena.md, "Next: continuity across frames"): positions, the staging brief.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingInWords, blockingWithPlaceholders, decodePositions, encodePositions, normalizePositions, stagingBrief, withBlocking, withStaged } from "../src/blocking.ts";
import type { Cell } from "../src/vocab.ts";

const cab = { name: "Cab interior", look: "night, rain on the windows, worn leather seats, dashboard glow" };
const cell = (id: string, over: Partial<Cell> = {}): Cell => ({ id, beat: "b", shot: "MS", camera: "static", duration_s: 4, characters: ["Driver", "Passenger"], ...over });

test("positions keep only characters in the shot and valid sides, and round-trip through the CSV", () => {
	const p = normalizePositions({ Driver: "left", Passenger: "right", Ghost: "left", Extra: "behind" }, ["Driver", "Passenger"]);
	assert.deepEqual(p, { Driver: "left", Passenger: "right" });
	assert.equal(encodePositions(p), "Driver=left;Passenger=right");
	assert.deepEqual(decodePositions("Driver=left;Passenger=right;Bad=up"), p);
	assert.deepEqual(decodePositions(undefined), {});
});

test("the staging brief carries the location verbatim, the blocking, and the positions to state", () => {
	const brief = stagingBrief(cell("02", { location: "Cab interior", blocking: "Driver at the wheel, passenger behind her.", positions: { Driver: "left", Passenger: "right" } }), [cab]);
	assert.match(brief, /^Location: Cab interior: night, rain on the windows/);
	// Placeholders, so each position arrives attached to a description, not a bare name
	assert.match(brief, /Blocking: \{\{Driver\}\} at the wheel/);
	assert.match(brief, /\{\{Driver\}\} on the left, \{\{Passenger\}\} on the right/);
});

test("neighbours in the same place pass on their screen direction; elsewhere they don't", () => {
	const prev = cell("01", { location: "Cab interior", positions: { Driver: "left" } });
	const next = cell("03", { location: "Street", positions: { Passenger: "center" } });
	const brief = stagingBrief(cell("02", { location: "Cab interior", positions: { Driver: "left" } }), [cab], prev, next);
	assert.match(brief, /The previous shot, in the same place, has Driver on the left: keep the camera on the same side/);
	assert.ok(!/previous shot.*\{\{/.test(brief), "neighbours aren't placeholders: they aren't in this frame");
	assert.ok(!brief.includes("next shot"));
});

test("a cell planned before locations existed gets no brief", () => {
	assert.equal(stagingBrief(cell("01"), [cab]), "");
});

test("blocking names become placeholders, whole words only, without doubling existing ones", () => {
	assert.equal(
		blockingWithPlaceholders("Driver at the wheel; Passenger behind {{Driver}}, Drivers' union sign", ["Driver", "Passenger"]),
		"{{Driver}} at the wheel; {{Passenger}} behind {{Driver}}, Drivers' union sign",
	);
});

const driver = { name: "Driver", look: "42-year-old woman, short brown hair, yellow oilskin coat", age_band: "middle_aged" as const };
const passenger = { name: "Passenger", look: "25-year-old man, messy black hair, black leather jacket", age_band: "young_adult" as const };

test("blocking goes into the prompt in plain words, so depth survives a cinematographer that drops it", () => {
	// Night Drive cell 03 (board-2026-10-08-35cd8c): the brief said "at the wheel... behind her", the LLM
	// kept only left and right, and both people were rendered side by side on the back seat
	const shot = cell("03", { blocking: "Driver at the wheel facing forward, tense; passenger behind her, leaning in." });
	const prompt = withBlocking("Medium shot, 35mm, rain-streaked cab interior", shot, [driver, passenger]);
	assert.equal(
		prompt,
		"Medium shot, 35mm, rain-streaked cab interior. Staging: the 42-year-old woman at the wheel facing forward, tense; the 25-year-old man behind her, leaning in.",
	);
	assert.equal(blockingInWords("The Driver turns to the Passenger", [driver, passenger]), "the 42-year-old woman turns to the 25-year-old man");
	assert.equal(withBlocking("A street.", cell("01", { characters: [] }), []), "A street.");
});

test("anyone the blocking stages joins the shot's characters", () => {
	// board-2026-10-08-806f74 cell 02: characters [Driver], blocking "...passenger behind her, leaning in"
	assert.deepEqual(withStaged(["Driver"], "Driver at the wheel facing forward; passenger behind her", ["Driver", "Passenger"]), ["Driver", "Passenger"]);
	assert.deepEqual(withStaged([], "Passenger leaning in", ["Driver", "Passenger"]), ["Passenger"]);
	assert.deepEqual(withStaged(["Driver"], undefined, ["Driver", "Passenger"]), ["Driver"]);
	// Whole words only
	assert.deepEqual(withStaged(["Ann"], "Ann waves at the Annex", ["Ann", "Annex Guard"]), ["Ann"]);
});
