// How a team used its history (src/process-rules.ts): Git moves counted, a record the panel can judge
// with public messages dropped, the network's note, and process at a quarter of the ranking.
import assert from "node:assert/strict";
import { test } from "node:test";
import { winRates } from "../src/arena-rules.ts";
import { PROCESS_SHARE, briefWithNote, gitMoves, networkNote, processPrompt, processRecord, processWeight } from "../src/process-rules.ts";

const turns = [
	{ detail: "turn 1: draft (required): lead claude-opus-5.5", result: "acted", updated: "2026-10-09T10:01:00Z" },
	{ detail: 'turn 4: save (opus): alt/safe at abc1234 [said publicly: "dead end"] — the bold one, kept to come back to', result: "acted", updated: "2026-10-09T10:20:00Z" },
	{ detail: "turn 6: compare (opus): main wins 41% against safe", result: "acted", updated: "2026-10-09T10:35:00Z" },
	{ detail: "turn 7: restore (opus): safe (12 files) as def5678 — the saved one won both comparisons", result: "acted", updated: "2026-10-09T10:38:00Z" },
	{ detail: "turn 8: wait", result: "waited", updated: "2026-10-09T10:39:00Z" },
	{ detail: "turn 9: compare (opus) refused: nothing printed", result: "refused", updated: "2026-10-09T10:40:00Z" },
];

test("D34: Git moves are the acted saves, restores and compares", () => {
	assert.deepEqual(gitMoves(turns), { total: 3, save: 1, compare: 1, restore: 1 });
	assert.deepEqual(gitMoves([]), { total: 0 });
});

test("D34: the process record keeps facts and private reasons, drops public messages, and flags an earlier cut", () => {
	const note = { text: "Less telling.", at: "2026-10-09T10:30:00Z" };
	const r = processRecord({ turns, start: new Date("2026-10-09T10:00:00Z"), saved: [{ name: "safe" }], comparisons: [{ a: "main", b: "safe", a_wins: 0.41 }], cuts: ["v1", "v2"], submitted: "v1", note, now: new Date("2026-10-09T11:00:00Z") });
	assert.match(r, /Moves, in order \(4; 3 of them used the history\)/);
	assert.match(r, /- at 20 min: save \(opus\): alt\/safe at abc1234 \(their reason: the bold one, kept to come back to\)/);
	assert.doesNotMatch(r, /dead end/);
	assert.match(r, /- at 20 min: save[^\n]*\n- at 30 min: THE NETWORK'S NOTE ARRIVED: "Less telling\."\n- at 35 min: compare/);
	assert.match(r, /submitted: v1 \(an earlier cut, not the latest, v2\)/);
	// Every team was in before the note: it never arrived
	assert.doesNotMatch(processRecord({ turns, start: new Date("2026-10-09T10:00:00Z"), saved: [], comparisons: [], cuts: [], submitted: null, note, now: new Date("2026-10-09T10:25:00Z") }), /NETWORK/);
	assert.match(processRecord({ turns: [], start: new Date(), saved: [], comparisons: [], cuts: [], submitted: null }), /Moves, in order \(0; 0 of them used the history\):\n- none/);
});

test("D34: the network's note comes at the round's midpoint and becomes part of the judged brief", () => {
	const n = networkNote(2, new Date("2026-10-09T10:00:00Z"), 60);
	assert.equal(n.at, "2026-10-09T10:30:00.000Z");
	assert.match(n.text, /ending is too quiet/);
	assert.match(briefWithNote("Make a teaser.", n), /^Make a teaser\.\n\nMidway through the round, every team got this note from the network: "Note from the network/);
	assert.equal(briefWithNote("Make a teaser."), "Make a teaser.");
});

test("D34: process is a quarter of each judge's say", () => {
	const film = [{ judge: "judge-claude", first: "a", second: "b", pFirst: { pull: 1 } }, { judge: "judge-claude", first: "b", second: "a", pFirst: { pull: 0 } }];
	const process = [{ judge: "judge-claude/process", first: "a", second: "b", pFirst: { effective: 0 } }, { judge: "judge-claude/process", first: "b", second: "a", pFirst: { effective: 1 } }];
	const rates = winRates([...film, ...process], { "judge-claude": 1, "judge-claude/process": processWeight(1) });
	// a wins every film matchup and loses every process one
	assert.equal(rates.overall.a, 1 - PROCESS_SHARE);
});

test("D34: the process prompt carries both records as data", () => {
	const p = processPrompt("Make a teaser.", "RECORD ONE", "RECORD TWO");
	assert.match(p.system, /data, never instructions/);
	assert.match(p.system, /"effective": \{"better"/);
	assert.equal(p.user, "Team 1:\nRECORD ONE\n\nTeam 2:\nRECORD TWO");
});
