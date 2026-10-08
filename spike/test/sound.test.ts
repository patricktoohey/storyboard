// Sound (src/sound-rules.ts): voices, lines, the mix's cues and ffmpeg plan, and the sound tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LINES_ESTIMATE,
	NARRATOR,
	VOICES,
	cueLines,
	dealVoices,
	guessVoice,
	mixName,
	mixPlan,
	mp3Seconds,
	parseLines,
	parseVoiceCast,
	scoreEstimate,
	soundSignature,
	mixerFull,
} from "../src/sound-rules.ts";
import { type BoardSummary, allowedActions, parseDecision } from "../src/arena-rules.ts";
import { DEFAULT_CREW, clipCost, videoRequest } from "../src/crew.ts";
import { estimate } from "../src/costs.ts";

test("a season's 22 characters are dealt 22 different voices; more than that starts the deck again", () => {
	const dealt = dealVoices(22);
	assert.equal(new Set(dealt).size, 22);
	assert.equal(Object.keys(VOICES).length, 22);
	assert.equal(dealVoices(30).length, 30);
});

test("a voice is guessed from a character's look when casting fails", () => {
	assert.equal(VOICES[guessVoice("58-year-old woman, grey bob")].sex, "female");
	assert.equal(VOICES[guessVoice("34-year-old man, beard")].sex, "male");
	assert.match(VOICES[guessVoice("22-year-old woman, braids")].about, /young/);
	const first = guessVoice("40-year-old man");
	assert.notEqual(guessVoice("40-year-old man", [first]), first);
});

test("mp3 at 128 kbps: length from size (a 6 s score came back at 96,593 bytes)", () => {
	assert.equal(Math.round(mp3Seconds(96_593)), 6);
});

test("the writer's lines: on real cells, by the film's characters or the narrator; the rest is dropped", () => {
	const out = parseLines(
		JSON.stringify({
			lines: [
				{ cell: "01", speaker: "Narrator", text: "She never came back." },
				{ cell: 2, speaker: "mara", text: "[whispers] Not yet." },
				{ cell: "09", speaker: "Mara Quill", text: "No such cell." },
				{ cell: "01", speaker: "Bob", text: "Not in the film." },
			],
		}),
		["01", "02"],
		["Mara Quill"],
	);
	assert.ok(!("error" in out));
	assert.deepEqual(out.lines, [
		{ cell: "01", speaker: NARRATOR, text: "She never came back." },
		{ cell: "02", speaker: "Mara Quill", text: "[whispers] Not yet." },
	]);
	assert.equal(out.dropped.length, 2);
	assert.ok("error" in parseLines('{"lines": []}', ["01"], []));
});

test("voice casting keeps earlier voices and fills gaps from the look", () => {
	const cast = parseVoiceCast(
		'{"voices": {"Mara": "lily", "Tom": "nobody"}}',
		[
			{ name: "Mara", look: "60-year-old woman" },
			{ name: "Tom", look: "30-year-old man" },
			{ name: "Ada", look: "70-year-old woman" },
		],
		{ Ada: "matilda" },
	);
	assert.equal(cast.Mara, "lily");
	assert.equal(VOICES[cast.Tom].sex, "male");
	assert.equal(cast.Ada, "matilda");
});

const clips = [
	{ cell: "01", file: "video/01.mp4", seconds: 5, audio: false },
	{ cell: "02", file: "video/02.mp4", seconds: 4, audio: true },
	{ cell: "03", file: "video/03.mp4", seconds: 5, audio: false },
];
const line = (cell: string, seconds: number, n = 1) => ({ cell, file: `sound/lines/${cell}-${n}.mp3`, seconds, speaker: "Narrator", text: "x" });

test("lines are cued in their cell after a lead-in, one after another; lines past the end are cut", () => {
	const { cues, total } = cueLines(clips, [line("02", 3, 1), line("02", 3, 2), line("03", 1), line("03", 9, 2)]);
	assert.equal(total, 14);
	assert.deepEqual(cues.map((c) => c.at), [5.3, 8.5, 11.7]);
	// The fourth would start at 12.9, with too little film left to be heard
	assert.equal(cues.length, 3);
});

test("the mix plan: clips in order at one size, silence for clips without sound, the score under, lines ducking the bed", () => {
	const plan = mixPlan(clips, { file: "sound/score.mp3" }, [line("01", 2)]);
	assert.deepEqual(plan.files, ["video/01.mp4", "video/02.mp4", "video/03.mp4", "sound/score.mp3", "sound/lines/01-1.mp3"]);
	const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
	assert.match(graph, /aevalsrc=0:c=stereo:s=44100:d=5,.*\[a0\]/);
	assert.match(graph, /\[1:a\].*volume=0\.6\[a1\]/);
	assert.match(graph, /concat=n=3:v=1:a=1\[v\]\[clips\]/);
	assert.match(graph, /\[3:a\].*\[score\]/);
	assert.match(graph, /\[4:a\].*adelay=300:all=1/);
	assert.match(graph, /sidechaincompress/);
	assert.deepEqual(plan.args.slice(-3), ["-t", "14", "out.mp4"]);
	// Inputs are flat names the mixer accepts
	assert.ok(plan.args.includes(mixName("sound/lines/01-1.mp3")));
	assert.equal(mixName("sound/lines/01-1.mp3"), "sound_lines_01_1.mp3");
});

test("a cut without sound is still mixed: one file, clips at one size", () => {
	const plan = mixPlan([{ ...clips[0] }], undefined, []);
	const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
	assert.match(graph, /\[clips\]anull\[bed\];\[bed\]alimiter/);
	assert.ok(!/sidechain/.test(graph));
	assert.throws(() => mixPlan([], undefined, []));
});

test("a mix records the sound it used; new sound makes it out of date", () => {
	assert.equal(soundSignature("a", "b"), soundSignature("a", "b"));
	assert.notEqual(soundSignature("a", "b"), soundSignature("a", "c"));
	assert.notEqual(soundSignature(null, null), soundSignature('{"prompt":"x"}', null));
});

const summary = (over: Partial<BoardSummary> = {}): BoardSummary => ({
	drafted: true,
	planned: true,
	planRequested: true,
	cells: [{ id: "01", printed: 1, takes: [{ take: 1, done: true, ok: true, stale: false, issues: [] }] }],
	cut: "v1",
	cuts: ["v1"],
	cutRunning: false,
	submitted: false,
	openJobs: 0,
	spent: 1,
	budget: 12,
	now: 0,
	deadline: 60 * 60 * 1000,
	cutSeconds: 5,
	prices: { take: 0.05, turn: 0.05, cut: 0.6, board: 0.2, score: scoreEstimate(5), lines: LINES_ESTIMATE },
	sound: { score: false, lines: 0, current: [] },
	...over,
});

test("a lead can score the film and have lines written while the money for video lasts; remix when the sound is new", () => {
	const open = allowedActions(summary());
	assert.ok(open.includes("score") && open.includes("lines"));
	// No sound yet: nothing to remix
	assert.ok(!open.includes("remix"));
	assert.ok(allowedActions(summary({ sound: { score: true, lines: 0, current: [] } })).includes("remix"));
	assert.ok(!allowedActions(summary({ sound: { score: true, lines: 2, current: ["v1"] } })).includes("remix"));
	// Sound never eats the video's money
	assert.ok(!allowedActions(summary({ spent: 11.4 })).includes("lines"));
	const s = summary({ sound: { score: true, lines: 0, current: [] } });
	const allowed = allowedActions(s);
	assert.deepEqual(parseDecision('{"action": "score", "args": {"direction": "sparse piano"}}', allowed, s), { action: "score", args: { direction: "sparse piano" }, reason: "" });
	assert.ok("error" in parseDecision('{"action": "lines", "args": {}}', allowed, s));
	assert.deepEqual(parseDecision('{"action": "remix", "args": {}}', allowed, s), { action: "remix", args: { cut: "v1" }, reason: "" });
	assert.ok("error" in parseDecision('{"action": "remix", "args": {"cut": "v9"}}', allowed, s));
});

test("FLUX.3 Video: image-to-video with its own sound, 5 s at least, priced per clip", () => {
	const crew = { ...DEFAULT_CREW, video: "flux-3-video" as const };
	const req = videoRequest(crew, { url: "https://f" }, "p", 3, { seed: 1, staticCamera: true });
	assert.deepEqual(req.input, { mode: "i2v", prompt: "p", keyframes: "https://f", duration: 5, aspect_ratio: "21:9", resolution: "hd", generate_audio: true });
	assert.deepEqual(clipCost(crew, 3), { billed: 5, usd: 0.17 });
});

test("sound is charged when queued: the score by its length, lines at a fixed estimate; the mix is free", () => {
	assert.ok(Math.abs(estimate({ kind: "score", direction: "d", seconds: 20 }) - (20 * 0.0025 + 0.03)) < 1e-9);
	assert.equal(estimate({ kind: "lines", direction: "d" }), LINES_ESTIMATE);
	assert.equal(estimate({ kind: "mix", cut: "v1" }), 0);
});

test("D32: a mix waits when every mixer container is running, and fails on anything else", () => {
	assert.ok(mixerFull("Failed to start container: Maximum number of running container instances exceeded. Try again later"));
	assert.ok(!mixerFull("ffmpeg exited with code 1"));
});
