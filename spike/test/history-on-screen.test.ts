// D38: the history on screen. Two endings for the finale's last shot (the team's pick is a bet the panel
// settles), "previously on" from takes that didn't make it, and leads that work beside running jobs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardSummary, allowedActions, parseDecision } from "../src/arena-rules.ts";
import { ENDING_RUBRIC, endingsLine, endingsNote, gitMoves, processRecord } from "../src/process-rules.ts";
import { RECAP_SECONDS_EACH, mixPlan, recapClips, soundSignature } from "../src/sound-rules.ts";
import { endingsRequest, parseTeaserVerdict } from "../src/teaser-rules.ts";
import { publicMove } from "../src/format-rules.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const take = (t: number, done = true) => ({ take: t, done, ok: true, stale: false, issues: [] });
const board = (over: Partial<BoardSummary> = {}): BoardSummary => ({
	drafted: true,
	planned: true,
	planRequested: true,
	cells: [
		{ id: "01", printed: 2, takes: [take(1), take(2)] },
		{ id: "02", printed: 1, takes: [take(1), take(2)] },
	],
	cutRunning: false,
	submitted: false,
	openJobs: 0,
	spent: 0.5,
	budget: 5,
	now,
	deadline: now + 30 * 60_000,
	cutSeconds: 10,
	prices: { take: 0.03, turn: 0.005, cut: 1.0 },
	...over,
});

test("D38: a recap is offered when the format allows it and something didn't make it", () => {
	assert.ok(allowedActions(board({ recap: true })).includes("recap"));
	assert.ok(!allowedActions(board()).includes("recap"));
	const nothingDropped = board({ recap: true, cells: [{ id: "01", printed: 1, takes: [take(1)] }] });
	assert.ok(!allowedActions(nothingDropped).includes("recap"));
});

test("D38: a recap is two to four take branches, none of them printed", () => {
	const s = board({ recap: true });
	const allowed = allowedActions(s);
	const ok = parseDecision(JSON.stringify({ action: "recap", args: { shots: ["cell/01/take-1", "cell/02/take-2"] }, reason: "r" }), allowed, s);
	assert.deepEqual("args" in ok && ok.args, { shots: ["cell/01/take-1", "cell/02/take-2"] });
	const printed = parseDecision(JSON.stringify({ action: "recap", args: { shots: ["cell/01/take-2", "cell/02/take-2"] }, reason: "r" }), allowed, s);
	assert.match("error" in printed ? printed.error : "", /cell\/01\/take-2 is printed/);
	const one = parseDecision(JSON.stringify({ action: "recap", args: { shots: ["cell/01/take-1", "cell/01/take-1"] }, reason: "r" }), allowed, s);
	assert.ok("error" in one);
	assert.equal(publicMove("recap", { shots: ["a", "b", "c"] }), 'cut a "previously on" from 3 old takes');
	assert.deepEqual(gitMoves([{ detail: "turn 5: recap (opus): cell/01/take-1, cell/02/take-2", result: "acted" }]), { total: 1, recap: 1 });
});

test("D38: the recap opens the mix as washed-out stills, and changing it dates the mix", () => {
	const recap = recapClips({ shots: [{ branch: "cell/01/take-1", file: "recap/01.webp" }, { branch: "cell/02/take-2", file: "recap/02.webp" }] });
	assert.deepEqual(recap.map((c) => [c.cell, c.seconds, c.still, c.audio]), [["r1", RECAP_SECONDS_EACH, true, false], ["r2", RECAP_SECONDS_EACH, true, false]]);
	const plan = mixPlan([...recap, { cell: "01", file: "video/01.mp4", seconds: 5, audio: false }], undefined, [{ cell: "01", file: "sound/lines/01.mp3", seconds: 2, speaker: "Ana", text: "Again." }]);
	assert.equal(plan.total, 5 + 2 * RECAP_SECONDS_EACH);
	const filter = plan.args[plan.args.indexOf("-filter_complex") + 1];
	assert.match(filter, /\[0:v\][^;]*hue=s=0\.3[^;]*\[v0\]/);
	assert.doesNotMatch(filter, /\[2:v\][^;]*hue/);
	// Lines stay on their own shot, after the recap
	assert.ok(plan.cues[0].at >= 2 * RECAP_SECONDS_EACH);
	// No recap: the signature mixes made before recaps carry; a recap changes it
	assert.equal(soundSignature("s", "l", null), soundSignature("s", "l"));
	assert.notEqual(soundSignature("s", "l", '{"shots":[]}'), soundSignature("s", "l"));
});

test("D38: the two-endings note names the last shot, and the bet's line says whether the panel agreed", () => {
	assert.match(endingsNote("06"), /two endings for your last shot.*ideas on cell 06/);
	const won = endingsLine({ submitted: { branch: "cell/06/take-4", idea: "door" }, other: { branch: "cell/06/take-3", idea: "card" }, p_submitted: 0.71, judges_agreeing: 3, judges: 3 });
	assert.equal(won, 'Two endings (the network asked for them): "door" (cell/06/take-4) submitted, against "card" (cell/06/take-3). The panel preferred the submitted one 71% (3 of 3 judges): the bet was right.');
	assert.match(endingsLine({ submitted: { branch: "cell/06/take-2" } }), /only one shot/);
	assert.match(endingsLine(undefined), /none submitted/);
	const note = { text: endingsNote("06"), at: "2026-10-09T10:30:00Z", endings: true };
	const record = (n: Date) => processRecord({ turns: [], start: new Date("2026-10-09T10:00:00Z"), saved: [], comparisons: [], cuts: ["v1"], submitted: "v1", note, now: n });
	assert.match(record(new Date("2026-10-09T11:00:00Z")), /Two endings \(the network asked for them\): none submitted/);
	assert.doesNotMatch(record(new Date("2026-10-09T10:20:00Z")), /Two endings/);
});

test("D38: each judge sees the shot before and both endings as stills, in its own request shape", () => {
	const img = (d: string) => ({ mime: "image/webp", data: d });
	const before = img("BEFORE");
	const [a, b] = [{ image: img("A"), idea: "# door\n\nThey burst through" }, { image: img("B") }];
	const claude = endingsRequest("anthropic/claude-opus-5.5", "Make a teaser.", before, a, b) as { messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] };
	assert.deepEqual(claude.messages[0].content.filter((p) => p.type === "image").map((p) => [p.source!.media_type, p.source!.data]), [["image/webp", "BEFORE"], ["image/webp", "A"], ["image/webp", "B"]]);
	const gpt = JSON.stringify(endingsRequest("openai/gpt-6.1-sol", "Make a teaser.", undefined, a, b));
	assert.match(gpt, /data:image\/webp;base64,A/);
	const gemini = JSON.stringify(endingsRequest("google/gemini-3.1-pro", "Make a teaser.", before, a, b));
	assert.match(gemini, /"inline_data":\{"mime_type":"image\/webp","data":"B"\}/);
	assert.match(gemini, /the team's description: \\"# door They burst through\\"/);
	assert.equal(parseTeaserVerdict('{"criteria": {"ending": {"better": "second", "margin": "clear"}}}', ENDING_RUBRIC).pFirst.ending, 0.25);
});

test("D38: a crew pushback is shot as suggested unless the lead insists", () => {
	const s = board();
	const d = parseDecision(JSON.stringify({ action: "note", args: { cell: "01", note: "tighter", insist: true }, reason: "r" }), allowedActions(s), s);
	assert.deepEqual("args" in d && d.args, { cell: "01", note: "tighter", insist: true });
	const plain = parseDecision(JSON.stringify({ action: "note", args: { cell: "01", note: "tighter", insist: "yes" }, reason: "r" }), allowedActions(s), s);
	assert.deepEqual("args" in plain && plain.args, { cell: "01", note: "tighter" });
});
