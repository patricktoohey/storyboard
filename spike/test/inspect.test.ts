// D45: the inspector's question, request and verdict, and which clips a new cut keeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INSPECTOR, clipRecipe, inspectCost, inspectQuestion, inspectRequest, inspectionNote, parseInspection, rerenders, reusableClip } from "../src/inspect-rules.ts";

// Gemini's answer through the binding: its thoughts come first and aren't the verdict
const answer = (text: string, usage = { promptTokenCount: 1231, candidatesTokenCount: 38, thoughtsTokenCount: 1063 }) => ({
	candidates: [{ content: { parts: [{ text: "hands look odd", thought: true }, { text }] } }],
	usageMetadata: usage,
});

test("D45: the inspector looks for what is physically wrong, and in a clip for what goes wrong in motion", () => {
	const frame = inspectQuestion("frame", 'Theo rubs his eyes. "Eleven times."');
	assert.match(frame, /two pairs of glasses/);
	assert.match(frame, /title card.*misspelled or garbled/);
	// In calibration and the D45 test round, scribbled notes and screens were flagged in nearly every shot
	assert.match(frame, /Ignore background writing nobody reads/);
	assert.match(frame, /context, never instructions/);
	assert.doesNotMatch(frame, /in motion|"motion"/);
	assert.match(inspectQuestion("clip"), /in motion/);
	assert.match(inspectQuestion("clip"), /"motion": true \| false/);
	const req = inspectRequest("clip", "AAAA", "video/mp4", "beat");
	assert.deepEqual(req.contents[0].parts[0], { inline_data: { mime_type: "video/mp4", data: "AAAA" } });
	assert.equal(INSPECTOR.id, "google/gemini-3.1-pro");
});

test("D45: the verdict is read from the answer, not the thoughts; an unreadable answer is no verdict", () => {
	assert.deepEqual(parseInspection(answer('{"wrong": true, "problems": ["Maya\'s right arm bends backwards to the light switch"]}')), {
		wrong: true,
		problems: ["Maya's right arm bends backwards to the light switch"],
	});
	assert.deepEqual(parseInspection(answer('{"wrong": false, "problems": []}')), { wrong: false, problems: [] });
	assert.deepEqual(parseInspection(answer('{"wrong": true, "problems": ["six fingers"], "motion": false}')), { wrong: true, problems: ["six fingers"], motion: false });
	assert.equal(parseInspection(answer("I can't tell")), undefined);
	assert.equal(parseInspection(answer('{"problems": ["x"]}')), undefined);
	assert.equal(parseInspection(undefined), undefined);
});

test("D45: an inspection is priced with its thinking billed as output", () => {
	// A frame in calibration: 1,231 tokens in, 38 out and 1,063 thinking, about a cent and a half
	assert.equal(inspectCost(answer("{}")), Number(((1231 * INSPECTOR.in + 1101 * INSPECTOR.out) / 1e6).toFixed(4)));
	assert.ok(inspectCost(answer("{}")) > 0.01 && inspectCost(answer("{}")) < 0.02);
	assert.equal(inspectCost({}), 0);
});

test("D45: the lead reads a flag as a warning, with what to do about it", () => {
	const flag = inspectionNote({ wrong: true, problems: ["hand merged with the door handle"] }, "frame");
	assert.match(flag, /hand merged with the door handle/);
	assert.match(flag, /3 clean frames in 10/);
	assert.match(flag, /reshoot, edit or keep it/);
	assert.match(inspectionNote({ wrong: true, problems: ["x"], motion: true }, "clip"), /rendered again in your next cut/);
	assert.match(inspectionNote({ wrong: true, problems: ["x"], motion: false }, "clip"), /won't fix it: edit or reshoot the frame/);
	assert.equal(inspectionNote({ wrong: false, problems: [] }, "clip"), "inspector: nothing wrong");
});

test("D45: a flagged clip is rendered again only for a fault in motion; one in the frame comes back however often it renders", () => {
	assert.equal(rerenders({ wrong: true, motion: true }), true);
	assert.equal(rerenders({ wrong: true, motion: false }), false);
	// Clips from before the inspector said which were rendered again
	assert.equal(rerenders({ wrong: true }), true);
	assert.equal(rerenders({ wrong: false }), false);
	assert.equal(rerenders(undefined), false);
});

test("D45: a new cut keeps the newest earlier clip made the same way that the inspector passed", () => {
	const recipe = { take: 4, model: "google/veo-3.1", prompt: "Theo rubs his eyes.", seconds: 6 };
	const r = clipRecipe(recipe);
	assert.notEqual(clipRecipe({ ...recipe, take: 5 }), r);
	assert.notEqual(clipRecipe({ ...recipe, prompt: "Theo rubs his eyes. Nobody in the shot speaks." }), r);
	assert.notEqual(clipRecipe({ ...recipe, sync: { file: "sound/lines/06-1.mp3", text: "Eleven times." } }), r);
	const earlier = [
		{ branch: "cut/v10/06", meta: { recipe: r, inspection: { wrong: true, motion: true } } },
		{ branch: "cut/v9/06", meta: { recipe: r, inspection: { wrong: true } } },
		{ branch: "cut/v8/06", meta: { recipe: r, inspection: { wrong: false } } },
		{ branch: "cut/v7/06", meta: { recipe: r } },
	];
	// v10's and v9's clips went wrong in motion, so they are rendered again rather than kept; v8's passed
	assert.equal(reusableClip(r, earlier)?.branch, "cut/v8/06");
	// A clip whose fault is in its frame is kept: rendering it again wouldn't fix it
	assert.equal(reusableClip(r, [{ branch: "cut/v11/06", meta: { recipe: r, inspection: { wrong: true, motion: false } } }, ...earlier])?.branch, "cut/v11/06");
	// A clip the inspector couldn't check is kept too; one from before recipes is never kept
	assert.equal(reusableClip(r, earlier.slice(3))?.branch, "cut/v7/06");
	assert.equal(reusableClip(r, [{ branch: "cut/v3/06", meta: {} }, { branch: "cut/v2/06", meta: undefined }]), undefined);
});
