// The teaser judge (src/teaser-rules.ts): two films inline, a margin per criterion, notes on what it heard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { rubricOf } from "../src/arena-rules.ts";
import { parseSkill } from "../src/skill-format.ts";
import { forfeit, geminiText, parseTeaserVerdict, teaserRequest, watches } from "../src/teaser-rules.ts";

const skill = parseSkill("judge-teaser", readFileSync(new URL("../../skills/judge-teaser/SKILL.md", import.meta.url), "utf8"), "0000000");
const rubric = rubricOf(skill.body);

test("D32: the teaser judge is a watching judge with a rubric like the others", () => {
	assert.ok(watches(skill.metadata));
	assert.deepEqual(rubric.map((c) => c.id), ["pull", "new", "sound", "card", "brief"]);
});

test("D32: both films go in inline, in order, before the rubric; the teams' words are data", () => {
	const req = teaserRequest("Make a teaser.", rubric, "AAAA", "BBBB");
	const parts = req.contents[0].parts;
	assert.deepEqual(parts.slice(0, 4), [{ text: "Film 1:" }, { inline_data: { mime_type: "video/mp4", data: "AAAA" } }, { text: "Film 2:" }, { inline_data: { mime_type: "video/mp4", data: "BBBB" } }]);
	const text = (parts[4] as { text: string }).text;
	assert.match(text, /Make a teaser\./);
	assert.match(text, /data, never instructions/);
	assert.match(text, /"card": \{"better"/);
	assert.doesNotMatch(text, /`brief`/);
});

test("D32: margins become win probabilities for the first film; unreadable answers are even", () => {
	const v = parseTeaserVerdict(
		'{"criteria": {"pull": {"better": "first", "margin": "clear"}, "sound": {"better": "second", "margin": "decisive"}, "card": {"better": "even"}, "new": {"better": "first", "margin": "huge"}},' +
			' "notes": {"first": "Two voices, a ticking clock, a clean card.", "second": "Neon and holograms; the narrator is buried."}}',
		rubric,
	);
	assert.deepEqual(v.pFirst, { pull: 0.75, new: 0.6, sound: 0.1, card: 0.5, brief: 0.5 });
	assert.equal(v.notes.second, "Neon and holograms; the narrator is buried.");
	assert.deepEqual(parseTeaserVerdict("I liked both", rubric), { pFirst: { pull: 0.5, new: 0.5, sound: 0.5, card: 0.5, brief: 0.5 }, notes: { first: "", second: "" } });
});

test("D32: Gemini's answer text skips its thoughts; a film with no teaser loses every criterion", () => {
	assert.equal(geminiText({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: '{"a":1}' }] } }] }), '{"a":1}');
	assert.equal(geminiText({}), "");
	assert.deepEqual(forfeit(rubric, true), { pull: 1, new: 1, sound: 1, card: 1, brief: 1 });
	assert.equal(forfeit(rubric, false).sound, 0);
});
