import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTRIBUTE_MATCH_MIN, MAX_PORTRAITS, continuityQuestions, continuityVerdict } from "../src/continuity-rules.ts";
import type { Character, ClefAnswer } from "../src/vocab.ts";

const driver: Character = { name: "Driver", age_band: "middle_aged", look: "58-year-old woman, grey hair in a bun, yellow coat" };
const passenger: Character = { name: "Passenger", age_band: "middle_aged", look: "42-year-old man, balding, black leather jacket" };

// Recorded from Clef on 2026-10-07: cell 03 of "Night Drive" against the recast driver's portrait.
// Take 1 still shows the old driver (black hair); take 2 shows the new one (grey bun).
const HAIR_TAKE1: ClefAnswer = {
	choice: "black",
	probabilities: { black: 0.7987, dark_brown: 0.1719, light_brown: 0.0068, blonde: 0.004, red: 0.002, grey_white: 0.0119, bald: 0.0047 },
};
const HAIR_TAKE2: ClefAnswer = {
	choice: "grey_white",
	probabilities: { black: 0.0037, dark_brown: 0.0097, light_brown: 0.0055, blonde: 0.0172, red: 0.0027, grey_white: 0.9586, bald: 0.0026 },
};
const HAIR_PORTRAIT: ClefAnswer = { choice: "grey_white", probabilities: { grey_white: 0.9756 } };
const yellow = (p = 0.9): ClefAnswer => ({ choice: "yellow", probabilities: { yellow: p, brown: 1 - p } });

function answers(hairFrame: ClefAnswer, extra: Record<string, ClefAnswer> = {}) {
	return {
		"age.driver": { choice: "middle_aged" },
		"look.driver": { noul: 0.9 },
		"visible.driver": { noul: 0.95 },
		"hair.frame.driver": hairFrame,
		"hair.portrait.driver": HAIR_PORTRAIT,
		"outerwear.frame.driver": yellow(),
		"outerwear.portrait.driver": yellow(),
		...extra,
	};
}

test("CU asks age, look, visibility, attributes for frame and portrait, and identity", () => {
	const { questions, identityChecked, attributesChecked } = continuityQuestions({ beat: "b", shot: "CU" }, [driver]);
	assert.ok(identityChecked && attributesChecked);
	assert.deepEqual(Object.keys(questions).sort(), [
		"age.driver",
		"hair.frame.driver",
		"hair.portrait.driver",
		"identity.driver",
		"impossible",
		"look.driver",
		"outerwear.frame.driver",
		"outerwear.portrait.driver",
		"people",
		"visible.driver",
	]);
});

test("portrait image numbers follow the character order", () => {
	const { questions } = continuityQuestions({ beat: "b", shot: "MS" }, [driver, passenger]);
	assert.match((questions["hair.portrait.driver"] as { instructions: string }).instructions, /image 2/);
	assert.match((questions["hair.portrait.passenger"] as { instructions: string }).instructions, /image 3/);
});

test("EWS skips attributes and identity: figures are too small", () => {
	const { questions } = continuityQuestions({ beat: "b", shot: "EWS" }, [driver]);
	assert.deepEqual(Object.keys(questions).sort(), ["age.driver", "impossible", "look.driver", "people"]);
});

test("at most MAX_PORTRAITS characters are checked (Clef takes 4 images)", () => {
	const many = Array.from({ length: 5 }, (_, i) => ({ ...driver, name: `C${i}` }));
	assert.equal(continuityQuestions({ beat: "b", shot: "MS" }, many).checked.length, MAX_PORTRAITS);
});

test("regression: the old driver fails on hair even though same-person scored 0.53", () => {
	const v = continuityVerdict({ shot: "CU" }, [driver], answers(HAIR_TAKE1, { "identity.driver": { noul: 0.5254 } }), undefined);
	assert.equal(v.ok, false);
	assert.equal(v.issues.length, 1);
	assert.match(v.issues[0], /Driver's hair reads as black but the casting portrait shows grey white/);
	assert.ok(v.attributes.Driver.hair.p_match < ATTRIBUTE_MATCH_MIN);
});

test("regression: the recast driver passes", () => {
	const v = continuityVerdict({ shot: "CU" }, [driver], answers(HAIR_TAKE2, { "identity.driver": { noul: 0.97 } }), undefined);
	assert.deepEqual(v.issues, []);
	assert.equal(v.attributes.Driver.hair.portrait, "grey_white");
});

test("attributes are ignored when the character isn't visible", () => {
	const v = continuityVerdict({ shot: "WS" }, [driver], answers(HAIR_TAKE1, { "visible.driver": { noul: 0.2 } }), undefined);
	assert.equal(v.ok, true);
	assert.deepEqual(v.attributes, {});
});

test("a changed coat colour is a break", () => {
	const v = continuityVerdict(
		{ shot: "MS" },
		[driver],
		answers(HAIR_TAKE2, { "outerwear.frame.driver": { choice: "brown", probabilities: { brown: 0.8, yellow: 0.1 } } }),
		undefined,
	);
	assert.match(v.issues.join(), /outerwear reads as brown but the casting portrait shows yellow/);
});

test("adjacent age bands pass; two bands apart fail", () => {
	const ok = continuityVerdict({ shot: "MS" }, [driver], answers(HAIR_TAKE2, { "age.driver": { choice: "elderly" } }), undefined);
	const bad = continuityVerdict({ shot: "MS" }, [driver], answers(HAIR_TAKE2, { "age.driver": { choice: "young_adult" } }), undefined);
	const child = continuityVerdict({ shot: "MS" }, [driver], answers(HAIR_TAKE2, { "age.driver": { choice: "child" } }), undefined);
	assert.equal(ok.ok, true);
	assert.equal(bad.ok, true, "young_adult is adjacent to middle_aged");
	assert.match(child.issues.join(), /reads as young child/);
});

test("framing more than one size off the plan is a break", () => {
	const v = continuityVerdict({ shot: "ECU" }, [], {}, { choice: "MS" });
	assert.match(v.issues[0], /framing reads as MS but the shot is ECU/);
	assert.equal(continuityVerdict({ shot: "CU" }, [], {}, { choice: "MS" }).ok, true);
});

test("D7: hair colour isn't compared when either image reads as bald (balding reads both ways)", () => {
	// Night Drive eval: the balding passenger read as "bald" in one frame and "light_brown" in his portrait
	const v = continuityVerdict(
		{ shot: "CU" },
		[passenger],
		{
			"visible.passenger": { noul: 0.9 },
			"hair.frame.passenger": { choice: "bald", probabilities: { bald: 0.7, light_brown: 0.1 } },
			"hair.portrait.passenger": { choice: "light_brown", probabilities: { light_brown: 0.6 } },
			"outerwear.frame.passenger": { choice: "black", probabilities: { black: 0.95 } },
			"outerwear.portrait.passenger": { choice: "black", probabilities: { black: 0.95 } },
		},
		undefined,
	);
	assert.deepEqual(v.issues, []);
});

const cab = { name: "Cab interior", look: "night, rain on the windows, worn leather seats" };

test("with a location, image 2 is its reference and portraits move up; only setting shots compare the place", () => {
	const ms = continuityQuestions({ beat: "b", shot: "MS", positions: { Driver: "left" } }, [driver, passenger], cab);
	assert.ok(ms.placeChecked);
	assert.match((ms.questions.place as { instructions: string }).instructions, /Image 2 is the reference/);
	assert.match((ms.questions["hair.portrait.driver"] as { instructions: string }).instructions, /image 3/);
	assert.ok("position.driver" in ms.questions && !("position.passenger" in ms.questions));
	const cu = continuityQuestions({ beat: "b", shot: "CU" }, [driver], cab);
	assert.equal(cu.placeChecked, false);
	assert.match((cu.questions["hair.portrait.driver"] as { instructions: string }).instructions, /image 2/);
});

test("with a location, at most 2 portraits fit beside the frame and its reference", () => {
	const three = [driver, passenger, { ...driver, name: "Third" }];
	assert.equal(continuityQuestions({ beat: "b", shot: "WS" }, three, cab).checked.length, 2);
});

test("a frame set somewhere else is a break", () => {
	const v = continuityVerdict({ shot: "WS" }, [], { place: { noul: 0.2 } }, undefined);
	assert.match(v.issues[0], /setting doesn't match the location reference/);
	assert.equal(continuityVerdict({ shot: "WS" }, [], { place: { noul: 0.8 } }, undefined).ok, true);
});

test("a character on the wrong side of the frame breaks the blocking", () => {
	const answersFor = (pos: Record<string, number>, choice: string) =>
		answers(HAIR_TAKE2, { "position.driver": { choice, probabilities: pos } });
	const wrong = continuityVerdict({ shot: "MS", positions: { Driver: "left" } }, [driver], answersFor({ left: 0.1, center: 0.1, right: 0.8 }, "right"), undefined);
	assert.match(wrong.issues.join(), /Driver is on the right but the blocking puts them on the left/);
	const right = continuityVerdict({ shot: "MS", positions: { Driver: "left" } }, [driver], answersFor({ left: 0.7, center: 0.2, right: 0.1 }, "left"), undefined);
	assert.equal(right.ok, true);
});

test("an extra person in the frame is a break; the planned number is fine", () => {
	const extra = continuityVerdict({ shot: "MS" }, [driver, passenger], { people: { choice: "3", probabilities: { "2": 0.15, "3": 0.8 } } }, undefined);
	assert.match(extra.issues.join(), /3 people are visible but the shot plans 2/);
	const fine = continuityVerdict({ shot: "MS" }, [driver, passenger], { people: { choice: "2", probabilities: { "2": 0.9 } } }, undefined);
	assert.equal(fine.ok, true);
	// Fewer than planned isn't a head-count break (the look and identity checks cover a missing person)
	assert.equal(continuityVerdict({ shot: "MS" }, [driver, passenger], { people: { choice: "1", probabilities: { "1": 0.9 } } }, undefined).ok, true);
});

test("blocking is checked in plain words where people have room to be staged, and a mismatch is a break", () => {
	const blocking = "Driver at the wheel; passenger behind her";
	const ms = continuityQuestions({ beat: "b", shot: "MS", blocking }, [driver, passenger]);
	assert.ok(ms.blockingChecked);
	assert.equal(ms.state.blocking, "the 58-year-old woman at the wheel; the 42-year-old man behind her");
	assert.equal(continuityQuestions({ beat: "b", shot: "ECU", blocking }, [driver]).blockingChecked, false);
	assert.equal(continuityQuestions({ beat: "b", shot: "MS" }, [driver, passenger]).blockingChecked, false);
	// Both people side by side on the back seat when the plan has one at the wheel
	assert.match(continuityVerdict({ shot: "MS" }, [], { blocking: { noul: 0.1 } }, undefined).issues.join(), /staging doesn't follow the blocking/);
	assert.equal(continuityVerdict({ shot: "MS" }, [], { blocking: { noul: 0.7 } }, undefined).ok, true);
});

test("D42: something impossible in the frame is a continuity break, above Clef's 0.6", async () => {
	const { IMPOSSIBLE_MAX } = await import("../src/continuity-rules.ts");
	const verdict = (p: number) => continuityVerdict({ shot: "CU" }, [], { impossible: { noul: p } }, undefined);
	// Theo with two pairs of glasses: 0.85 (klein) and 0.76 (FLUX.2 max); one pair: 0.03 to 0.06
	assert.match(verdict(0.85).issues.join(), /impossible or duplicated.*p=0\.85/);
	assert.match(verdict(0.76).issues.join(), /impossible or duplicated/);
	assert.deepEqual(verdict(0.06).issues, []);
	assert.ok(IMPOSSIBLE_MAX > 0.06 && IMPOSSIBLE_MAX < 0.76);
});
