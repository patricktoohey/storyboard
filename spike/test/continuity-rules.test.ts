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
		"look.driver",
		"outerwear.frame.driver",
		"outerwear.portrait.driver",
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
	assert.deepEqual(Object.keys(questions).sort(), ["age.driver", "look.driver"]);
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
