// The arena's rules (docs/arena.md): what a showrunner may do, what it prints, and how judges add up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type BoardSummary,
	CUT_WALL_S,
	allowedActions,
	parseDecision,
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

test("video is required: with a cut and no time for a better one, submit; a submitted team stops", () => {
	const late = minutes((2 * (CUT_WALL_S + 90) - 60) / 60);
	assert.deepEqual(allowedActions(board({ cut: "v1", cuts: ["v1"], deadline: late })), ["submit"]);
	assert.deepEqual(allowedActions(board({ cut: "v1", submitted: true })), []);
});

test("with a cut in hand and time left, the team may keep working toward a better one, or submit", () => {
	const s = board({ cut: "v1", cuts: ["v1"], deadline: minutes(30) });
	const allowed = allowedActions(s);
	for (const a of ["note", "retake", "submit", "save", "restore", "compare", "wait"]) assert.ok(allowed.includes(a as never), a);
	// Running work after a cut: wait for it, without asking the lead (the clock still forces the submit)
	assert.deepEqual(allowedActions({ ...s, openJobs: 2 }), ["wait"]);
});

test("with time and money, the lead chooses among working, Git tools, cutting and waiting", () => {
	assert.deepEqual(allowedActions(board()), ["note", "retake", "cut", "save", "restore", "compare", "wait"]);
	// Replanning needs its price known, the money for a plan, takes and a cut, and the time to shoot them
	assert.ok(allowedActions(board({ prices: { take: 0.03, turn: 0.005, cut: 1.0, board: 0.1 } })).includes("replan"));
	assert.ok(!allowedActions(board({ prices: { take: 0.03, turn: 0.005, cut: 1.0, board: 0.1 }, deadline: minutes(9) })).includes("replan"));
});

test("an earlier take can be printed: any finished take other than the printed one", () => {
	const s = board({ cells: [{ id: "01", printed: 2, takes: [take(1), take(2)] }] });
	assert.ok(allowedActions(s).includes("print"));
});

test("notes and retakes never eat the budget the required video needs", () => {
	// 10 s of video costs $1.00; $4.00 spent leaves exactly enough for the cut, not for more work or a comparison
	assert.deepEqual(allowedActions(board({ spent: 4.0 })), ["cut", "save", "restore", "wait"]);
});

test("the lead's decision is checked: allowed tools only, real cells and takes, sane arguments", () => {
	const s = board({ cut: "v2", cuts: ["v2", "v1"], cells: [{ id: "01", printed: 2, takes: [take(1), take(2)] }, { id: "02", printed: 1, takes: [take(1, false)] }] });
	const allowed = ["note", "print", "submit", "restore", "compare", "save", "wait"] as const;
	const d = (o: unknown) => parseDecision(JSON.stringify(o), [...allowed], s);
	assert.deepEqual(d({ action: "note", args: { cell: "02", note: "Her coat is yellow." }, reason: "r" }), { action: "note", args: { cell: "02", note: "Her coat is yellow." }, reason: "r" });
	assert.ok("error" in d({ action: "note", args: { cell: "09", note: "x" } }));
	assert.ok("error" in d({ action: "retake", args: { cell: "01" } }), "not offered this turn");
	// An earlier take, named
	assert.deepEqual((d({ action: "print", args: { takes: { "01": 1 } } }) as { args: unknown }).args, { picks: [{ cell: "01", branch: "cell/01/take-1" }] });
	assert.ok("error" in d({ action: "print", args: { takes: { "01": 7 } } }));
	// The earlier cut, or the latest by default
	assert.deepEqual((d({ action: "submit", args: { cut: "cut/v1" } }) as { args: unknown }).args, { cut: "v1" });
	assert.deepEqual((d({ action: "submit" }) as { args: unknown }).args, { cut: "v2" });
	assert.ok("error" in d({ action: "submit", args: { cut: "v9" } }));
	assert.deepEqual((d({ action: "save", args: { name: "Safe Version #1" } }) as { args: unknown }).args, { name: "safe-version-1" });
	assert.ok("error" in d({ action: "compare", args: { a: "main", b: "main" } }));
	// Prose around the JSON is tolerated; no JSON at all is an error
	assert.equal((parseDecision(`I'll wait. {"action": "wait"}`, [...allowed], s) as { action: string }).action, "wait");
	assert.ok("error" in parseDecision("wait", [...allowed], s));
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
