// The arena's rules (docs/arena.md): what a showrunner may do, what it prints, and how judges add up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type BoardSummary,
	CUT_WALL_S,
	allowedActions,
	leaderboard,
	printPicks,
	rubricOf,
	sampleCells,
	weakCells,
} from "../src/arena-rules.ts";
import { appendJobs, LimitError, spent, type LedgerRow } from "../src/ledger.ts";

const now = Date.parse("2026-10-07T12:00:00Z");
const minutes = (m: number) => now + m * 60_000;
const take = (t: number, ok = true, done = true, stale = false) => ({ take: t, done, ok, stale, issues: ok ? [] : ["hair"] });

function board(over: Partial<BoardSummary> = {}): BoardSummary {
	return {
		drafted: true,
		planned: true,
		planRequested: true,
		cells: [
			{ id: "01", printed: 1, takes: [take(1)] },
			{ id: "02", printed: 1, takes: [take(1, false)] },
		],
		cutRunning: false,
		submitted: false,
		openJobs: 0,
		spent: 0.5,
		budget: 5,
		now,
		deadline: minutes(20),
		cutSeconds: 10,
		prices: { take: 0.03, turn: 0.005, cut: 1.0 },
		...over,
	};
}

test("the first turn drafts the crew, the next plans; a planned board waits while work is running", () => {
	assert.deepEqual(allowedActions(board({ drafted: false, planRequested: false, planned: false })), ["draft"]);
	assert.deepEqual(allowedActions(board({ planRequested: false, planned: false })), ["plan"]);
	assert.deepEqual(allowedActions(board({ openJobs: 3 })), ["wait"]);
	assert.deepEqual(allowedActions(board({ cutRunning: true })), ["wait"]);
});

test("video is required: a finished cut is submitted at once, and a submitted team stops", () => {
	assert.deepEqual(allowedActions(board({ cut: "v1" })), ["submit"]);
	assert.deepEqual(allowedActions(board({ cut: "v1", submitted: true })), []);
});

test("with time and money, the showrunner chooses among working, cutting and waiting", () => {
	assert.deepEqual(allowedActions(board()), ["note", "retake", "cut", "wait"]);
});

test("notes and retakes never eat the budget the required video needs", () => {
	// 10 s of video costs $1.00; $4.00 spent leaves exactly enough for the cut, not for more work
	assert.deepEqual(allowedActions(board({ spent: 4.0 })), ["cut", "wait"]);
});

test("near the deadline the clock decides: print what's finished, then cut", () => {
	const late = minutes((CUT_WALL_S + 30) / 60);
	const unprinted = board({ deadline: late, cells: [{ id: "01", takes: [take(1)] }, { id: "02", printed: 1, takes: [take(1)] }] });
	assert.deepEqual(allowedActions(unprinted), ["print"]);
	assert.deepEqual(allowedActions(board({ deadline: late })), ["cut"]);
	// Running retakes don't hold up the clock's mandate
	assert.deepEqual(allowedActions(board({ deadline: late, openJobs: 2 })), ["cut"]);
	assert.deepEqual(allowedActions(unprinted.openJobs === 0 ? { ...unprinted, openJobs: 2 } : unprinted), ["print"]);
});

test("print picks the latest passing, current take, and fills unprinted cells even without one", () => {
	const s = board({
		cells: [
			{ id: "01", printed: 1, takes: [take(1), take(2), take(3, false)] },
			{ id: "02", printed: 2, takes: [take(1), take(2)] },
			{ id: "03", takes: [take(1, false), take(2, false)] },
			{ id: "04", printed: 1, takes: [take(1), take(2, true, true, true)] },
		],
	});
	assert.deepEqual(printPicks(s), [
		{ cell: "01", branch: "cell/01/take-2" },
		{ cell: "03", branch: "cell/03/take-2" },
	]);
});

test("weak cells: the shown take breaks continuity, is stale, or there is no take", () => {
	const s = board({
		cells: [
			{ id: "01", printed: 1, takes: [take(1)] },
			{ id: "02", printed: 1, takes: [take(1, true, true, true)] },
			{ id: "03", takes: [] },
			{ id: "04", takes: [take(1, false)] },
		],
	});
	assert.deepEqual(weakCells(s).map((c) => c.id), ["02", "03", "04"]);
});

test("D19: a board's budget and deadline are enforced when jobs are queued", () => {
	const rows: LedgerRow[] = [];
	let n = 0;
	const opts = { now: "2026-10-07T12:00:00Z", newId: () => `j${++n}`, limits: { budget_usd: 1, deadline: "2026-10-07T12:20:00Z" } };
	appendJobs(rows, "b", [{ kind: "video", cell: "01", cut: "v1", origin: "o", seconds: 5 }], opts);
	assert.equal(spent(rows), 0.5, "5 s of Wan at $0.10/s (the default crew)");
	assert.throws(() => appendJobs(rows, "b", [{ kind: "video", cell: "02", cut: "v1", origin: "o", seconds: 6 }], opts), LimitError);
	assert.equal(rows.length, 1, "a refused request queues nothing");
	assert.throws(() => appendJobs(rows, "b", [{ kind: "take", cell: "01" }], { ...opts, now: "2026-10-07T12:21:00Z" }), /deadline/);
	// Judging continues after the deadline
	appendJobs(rows, "b", [{ kind: "judge", team: "t", board: "b", final: true }], { ...opts, now: "2026-10-07T12:21:00Z" });
});

test("every judge skill has a rubric of at least two levels per criterion", () => {
	for (const name of ["judge-craft", "judge-story"]) {
		const rubric = rubricOf(readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8"));
		assert.equal(rubric.length, 3, name);
	}
	assert.throws(() => rubricOf("no rubric here"), /no ```rubric/);
});

test("judges see up to 4 frames spread across the board, first and last included", () => {
	assert.deepEqual(sampleCells(["01", "02", "03", "04", "05", "06"], 4), ["01", "03", "04", "06"]);
	assert.deepEqual(sampleCells(["01", "02"], 4), ["01", "02"]);
});

test("the leaderboard weights judges; in the final round a team without video is listed last", () => {
	const scores = {
		auteur: [{ judge: "judge-craft", commit: "a", scores: {}, total: 3.5 }, { judge: "judge-story", commit: "a", scores: {}, total: 2.5 }],
		safe: [{ judge: "judge-craft", commit: "b", scores: {}, total: 2.0 }, { judge: "judge-story", commit: "b", scores: {}, total: 2.0 }],
		docs: [{ judge: "judge-craft", commit: "c", scores: {}, total: 4.0 }, { judge: "judge-story", commit: "c", scores: {}, total: 4.0 }],
	};
	const teams = [{ team: "auteur", hasCut: true }, { team: "safe", hasCut: true }, { team: "docs", hasCut: false }];
	const weights = { "judge-craft": 1, "judge-story": 3 };
	const live = leaderboard(teams, scores, weights, false);
	assert.deepEqual(live.map((r) => [r.team, r.score]), [["docs", 4], ["auteur", 2.75], ["safe", 2]]);
	const final = leaderboard(teams, scores, weights, true);
	assert.deepEqual(final.map((r) => r.team), ["auteur", "safe", "docs"]);
	assert.equal(final[2].disqualified, "no video");
});
