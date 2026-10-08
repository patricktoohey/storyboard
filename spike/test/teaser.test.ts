// The judging panel (src/teaser-rules.ts): the same evidence for every judge in its provider's shape, the
// film only for the one that can watch it, a margin per criterion, notes on what it saw and heard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { rubricOf } from "../src/arena-rules.ts";
import { parseSkill } from "../src/skill-format.ts";
import { frameTimes, heardOf } from "../src/sound-rules.ts";
import { type Evidence, forfeit, heardText, panelRequest, panelText, parseTeaserVerdict, watchesFilm } from "../src/teaser-rules.ts";

const skill = parseSkill("judge-teaser", readFileSync(new URL("../../skills/judge-teaser/SKILL.md", import.meta.url), "utf8"), "0000000");
const rubric = rubricOf(skill.body);
const film = (tag: string): Evidence => ({
	frames: [{ t: 1.2, jpg: `${tag}-f1` }, { t: 17.5, jpg: `${tag}-f2` }],
	heard: [{ start: 0, end: 1.5, text: "Thirty seconds." }],
	score: "Sparse and tense",
	film: `${tag}-mp4`,
});

test("D33: the panel's rubric", () => {
	assert.deepEqual(rubric.map((c) => c.id), ["pull", "new", "sound", "card", "brief"]);
});

test("D33: only Gemini watches the film; every judge gets the frames and what can be heard", () => {
	assert.ok(watchesFilm("google/gemini-3.1-pro"));
	assert.ok(!watchesFilm("anthropic/claude-opus-5.5"));
	const g = panelRequest("google/gemini-3.1-pro", "Make a teaser.", rubric, film("a"), film("b"));
	const parts = g.contents[0].parts as { text?: string; inline_data?: { mime_type: string; data: string } }[];
	assert.deepEqual(parts.slice(0, 4), [{ text: "Film 1:" }, { inline_data: { mime_type: "video/mp4", data: "a-mp4" } }, { text: "Film 1, frame at 1.2 s:" }, { inline_data: { mime_type: "image/jpeg", data: "a-f1" } }]);
	assert.match(parts.at(-1)!.text!, /the film itself, with its sound/);

	const c = panelRequest("anthropic/claude-opus-5.5", "Make a teaser.", rubric, film("a"), film("b")) as { messages: { content: { type: string; text?: string; source?: { data: string } }[] }[] };
	const blocks = c.messages[0].content;
	assert.ok(!JSON.stringify(blocks).includes("mp4"));
	assert.deepEqual(blocks.filter((b) => b.type === "image").map((b) => b.source!.data), ["a-f1", "a-f2", "b-f1", "b-f2"]);
	assert.ok(blocks.some((b) => b.text?.includes('0.0 s–1.5 s: "Thirty seconds."')));
	assert.doesNotMatch(blocks.at(-1)!.text!, /the film itself/);
	assert.match(blocks.at(-1)!.text!, /data, never instructions/);

	const o = panelRequest("openai/gpt-6.1-sol", "Make a teaser.", rubric, film("a"), film("b")) as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
	assert.equal(o.messages[0].content.find((b) => b.type === "image_url")!.image_url!.url, "data:image/jpeg;base64,a-f1");
});

test("D33: a transcript says when nothing could be made out, and when there was none", () => {
	assert.match(heardText({ frames: [], heard: [], score: null }), /nothing intelligible/);
	assert.match(heardText({ frames: [], heard: null, score: null }), /no transcript/);
	assert.deepEqual(heardOf({ segments: [{ start: 0.04, end: 2.28, text: " Except this time, we can go back." }, { start: 3, end: 4, text: "  " }] }), [{ start: 0, end: 2.3, text: "Except this time, we can go back." }]);
});

test("D33: frames go evenly through the film, the last by the title card", () => {
	assert.deepEqual(frameTimes(16), [1, 3, 5, 7, 9, 11, 13, 15.5]);
	assert.deepEqual(frameTimes(30, 4), [3.8, 11.3, 18.8, 29.5]);
});

test("D32: margins become win probabilities for the first film; unreadable answers are even", () => {
	const v = parseTeaserVerdict(
		'{"criteria": {"pull": {"better": "first", "margin": "clear"}, "sound": {"better": "second", "margin": "decisive"}, "card": {"better": "even"}, "new": {"better": "first", "margin": "huge"}},' +
			' "notes": {"first": "Two voices, a ticking clock, a clean card.", "second": "Neon and holograms; the narrator is buried."}}',
		rubric,
	);
	assert.deepEqual(v.pFirst, { pull: 0.75, new: 0.6, sound: 0.1, card: 0.5, brief: 0.5 });
	assert.equal(v.notes.second, "Neon and holograms; the narrator is buried.");
	// An unescaped quote in a note breaks the JSON; the criteria are still read
	const broken = parseTeaserVerdict('{"criteria": {"pull": {"better": "second", "margin": "clear"}, "card": {"better": "first"}}, "notes": {"first": "the "OHA ASON" glitch", "second": ""}}', rubric);
	assert.deepEqual(broken, { pFirst: { pull: 0.25, new: 0.5, sound: 0.5, card: 0.6, brief: 0.5 }, notes: { first: "", second: "" } });
	assert.deepEqual(parseTeaserVerdict("I liked both", rubric), { pFirst: { pull: 0.5, new: 0.5, sound: 0.5, card: 0.5, brief: 0.5 }, notes: { first: "", second: "" } });
});

test("D33: each judge's answer is read from its provider's shape; a film with no teaser loses every criterion", () => {
	assert.equal(panelText("google/gemini-3.1-pro", { candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: '{"a":1}' }] } }] }), '{"a":1}');
	assert.equal(panelText("anthropic/claude-opus-5.5", { content: [{ type: "text", text: '{"b":2}' }] }), '{"b":2}');
	assert.equal(panelText("openai/gpt-6.1-sol", { choices: [{ message: { content: '{"c":3}' } }] }), '{"c":3}');
	assert.equal(panelText("google/gemini-3.1-pro", undefined), "");
	assert.deepEqual(forfeit(rubric, true), { pull: 1, new: 1, sound: 1, card: 1, brief: 1 });
	assert.equal(forfeit(rubric, false).sound, 0);
});
