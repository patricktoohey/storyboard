// D40: the producer's notes, and boards carried into a new round. A note is the producer's commit; the lead
// answers it on its next turn and the answer is committed beside it; the panel reads both in the team's
// process record. A carried-over board keeps its earlier cuts to watch, never to submit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardSummary, parseDecision } from "../src/arena-rules.ts";
import { processRecord } from "../src/process-rules.ts";
import { addProducerNote, answerNotes, openNotes, producerView, roundCuts } from "../src/producer-rules.ts";

const at = (m: number) => `2026-10-10T10:${String(m).padStart(2, "0")}:00Z`;

test("D40: a producer's note waits open until the lead answers it, and every open note is answered at once", () => {
	let notes = addProducerNote([], "  Shot 3: the clip says its own line under ours. Fix it.  ", at(5), "03");
	notes = addProducerNote(notes, "The ending doesn't land.", at(6));
	assert.deepEqual(notes.map((n) => [n.id, n.cell, n.note]), [
		[1, "03", "Shot 3: the clip says its own line under ours. Fix it."],
		[2, undefined, "The ending doesn't land."],
	]);
	assert.equal(openNotes(notes).length, 2);
	notes = answerNotes(notes, "Retaking 03 on Wan, which has no sound; two endings next.", 7, "retake", at(9));
	assert.equal(openNotes(notes).length, 0);
	assert.deepEqual(notes[0].answer, { at: at(9), turn: 7, action: "retake", reply: "Retaking 03 on Wan, which has no sound; two endings next." });
	// A later note is answered on its own; earlier answers stand
	notes = answerNotes(addProducerNote(notes, "Better.", at(20)), "Thanks.", 9, "cut", at(21));
	assert.equal(notes[0].answer?.turn, 7);
	assert.equal(notes[2].answer?.turn, 9);
});

test("D40: the lead sees open notes with what it must do, and its last answers", () => {
	assert.equal(producerView([]), undefined);
	const notes = addProducerNote(answerNotes(addProducerNote([], "Too dark.", at(1), "02"), "Relit.", 3, "retake", at(2)), "Louder ending.", at(4));
	const v = producerView(notes)!;
	assert.deepEqual(v.open, [{ to: "the whole board", note: "Louder ending." }]);
	assert.match(v.must!, /"to_producer"/);
	assert.deepEqual(v.answered, [{ note: "Too dark.", you_said: "Relit." }]);
});

test("D40: the lead's answer to the producer is read from its decision", () => {
	const s = { cells: [], cuts: [] } as unknown as BoardSummary;
	assert.deepEqual(parseDecision(JSON.stringify({ action: "wait", reason: "r", to_producer: "On it next turn." }), ["wait"], s), { action: "wait", args: {}, reason: "r", to_producer: "On it next turn." });
	assert.deepEqual(parseDecision(JSON.stringify({ action: "wait", reason: "r" }), ["wait"], s), { action: "wait", args: {}, reason: "r" });
});

test("D40: the panel reads each note where it arrived, with the answer, and not twice", () => {
	const notes = answerNotes(addProducerNote([], "Shot 3 talks over the line.", at(10), "03"), "Retaking 03.", 4, "retake", at(12));
	const r = processRecord({
		turns: [
			{ detail: "turn 2: plan (opus)", result: "acted", updated: at(5) },
			{ detail: 'turn 4: retake (opus) on cell 03 [to the producer: "Retaking 03."] — the producer is right', result: "acted", updated: at(12) },
		],
		start: new Date(at(0)),
		saved: [],
		comparisons: [],
		cuts: [],
		submitted: null,
		producer: [...notes, ...addProducerNote([], "Ignored note.", at(30)).map((n) => ({ ...n, id: 2 }))],
	});
	assert.match(r, /- at 5 min: plan[^\n]*\n- at 10 min: THE PRODUCER'S NOTE on cell 03: "Shot 3 talks over the line\." → answered on turn 4 \(retake\): "Retaking 03\."\n- at 12 min: retake \(opus\) on cell 03 \(their reason: the producer is right\)/);
	assert.match(r, /- at 30 min: THE PRODUCER'S NOTE: "Ignored note\." → never answered/);
	assert.doesNotMatch(r, /\[to the producer/);
});

test("D40: a carried-over board's earlier cuts are there to watch, not to submit, and the panel is told", () => {
	const from = { board: "board-gpt-2026-10-09-fe8616-r2", commit: "abc1234def", cuts: ["v1", "v2"], saved: ["safe"], comparisons: 2 };
	assert.deepEqual(roundCuts(["v3", "v2", "v1"], from), ["v3"]);
	assert.deepEqual(roundCuts(["v2", "v1"], from), []);
	assert.deepEqual(roundCuts(["v2", "v1"]), ["v2", "v1"]);
	const r = processRecord({ turns: [], start: new Date(at(0)), saved: [], comparisons: [], cuts: ["v3"], submitted: "v3", from });
	assert.match(r, /^Carried on from board-gpt-2026-10-09-fe8616-r2 at abc1234, every branch with it: its cuts \(v1, v2\)/);
});

test("D42: an edit fixes one detail of the printed frame or a finished take, priced without a cinematographer or a render", async () => {
	const { estimate } = await import("../src/costs.ts");
	const { DEFAULT_CREW, EDIT_USD, MENU } = await import("../src/crew.ts");
	const { publicMove } = await import("../src/format-rules.ts");
	const take = (n: number, done = true) => ({ take: n, done, ok: true, stale: false, issues: [] });
	const s = { cells: [{ id: "06", printed: 3, takes: [take(2), take(3), take(4, false)] }, { id: "07", takes: [take(1)] }], cuts: [] } as unknown as BoardSummary;
	const d = (args: unknown) => parseDecision(JSON.stringify({ action: "edit", args, reason: "the producer's note" }), ["edit"], s);
	assert.deepEqual(d({ cell: "06", instruction: "One pair of glasses, pushed up; his eyes bare." }), {
		action: "edit",
		args: { cell: "06", instruction: "One pair of glasses, pushed up; his eyes bare.", from: "main" },
		reason: "the producer's note",
	});
	assert.deepEqual((d({ cell: "06", instruction: "x", take: 2 }) as { args: unknown }).args, { cell: "06", instruction: "x", from: "cell/06/take-2" });
	assert.ok("error" in d({ cell: "06", instruction: "x", take: 4 }), "still shooting");
	assert.ok("error" in d({ cell: "07", instruction: "x" }), "nothing printed to edit");
	assert.deepEqual((d({ cell: "07", instruction: "x", take: 1 }) as { args: unknown }).args, { cell: "07", instruction: "x", from: "cell/07/take-1" });
	assert.ok("error" in d({ cell: "06" }));
	assert.equal(publicMove("edit", { cell: "06", instruction: "secret" }), "edited a frame on cell 06");
	const edit = estimate({ kind: "take", cell: "06", opts: { edit: { instruction: "x", from: "main" } } });
	assert.equal(edit, EDIT_USD + MENU.critic[DEFAULT_CREW.critic].perTake);
	assert.ok(edit < estimate({ kind: "take", cell: "06" }) + EDIT_USD);
});

test("D40: a new cut is numbered above every cut started, finished or not", async () => {
	const { nextCut } = await import("../src/producer-rules.ts");
	// GPT's round 2 board: v1 finished, v2's clips rendered but never assembled
	assert.equal(nextCut(["cut/v1", "cut/v1/01", "cut/v1/08", "cut/v2/01", "cut/v2/08"]), "v3");
	assert.equal(nextCut(["cut/v1", "cut/v2"]), "v3");
	assert.equal(nextCut([]), "v1");
	assert.equal(nextCut(["cut/v10/03", "cut/v9"]), "v11");
});
