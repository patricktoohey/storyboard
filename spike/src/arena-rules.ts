// The arena's decisions without I/O: what a showrunner may do next, which takes to print, how rubrics
// read, and how scores become a leaderboard. Pure, so it is unit-tested (test/arena-rules.test.ts).

// ── Showrunner actions ──────────────────────────────────────────────────────────────────────────────

export const ACTIONS = {
	draft: "Choose the crew: which model fills each slot, within the budget",
	plan: "Plan the board from the brief: director and casting, then every cell's first take",
	note: "Give a director's note on the weakest cell, so it is re-shot",
	retake: "Re-shoot the weakest cell as it is, hoping for a better render",
	print: "Print the best finished take of each cell that has a better take than its printed one",
	cut: "Make the video: animate every printed frame and assemble the cut",
	submit: "Submit the finished cut; the team stops working",
	wait: "Do nothing now; let running work finish or think again shortly",
} as const;
export type Action = keyof typeof ACTIONS;

/** What a showrunner sees of its board each turn. */
export interface BoardSummary {
	// The crew has been chosen (board.json has a crew)
	drafted: boolean;
	planned: boolean;
	// The plan has been requested (a board job exists), even if it hasn't finished
	planRequested: boolean;
	cells: {
		id: string;
		printed?: number;
		takes: { take: number; done: boolean; ok: boolean; stale: boolean; issues: string[] }[];
	}[];
	// Latest assembled cut, and whether a cut is still rendering
	cut?: string;
	cutRunning: boolean;
	submitted: boolean;
	// Jobs still queued or running on the board, other than showrunner turns
	openJobs: number;
	spent: number;
	budget: number;
	now: number;
	deadline: number;
	// Video seconds a cut of the whole board would need (each cell's clip, capped)
	cutSeconds: number;
	// The crew's prices: one take, one turn, and the whole cut at its video model's billing
	prices: { take: number; turn: number; cut: number };
}

// A cut takes ~5 minutes to render (clips run in parallel) plus assembly; leave a margin on top
export const CUT_WALL_S = 6 * 60;
export const CUT_MARGIN_S = 90;

const usable = (t: BoardSummary["cells"][number]["takes"][number]) => t.done && t.ok && !t.stale;

/** For each cell, the latest finished take that passes continuity and isn't stale, if it isn't printed. */
export function printPicks(s: BoardSummary) {
	return s.cells.flatMap((c) => {
		const best = [...c.takes].filter(usable).sort((a, b) => b.take - a.take)[0];
		if (best && best.take !== c.printed) return [{ cell: c.id, branch: `cell/${c.id}/take-${best.take}` }];
		// Nothing passes: still print the latest finished take if the cell has nothing printed, so the board is complete
		if (!best && c.printed === undefined) {
			const latest = [...c.takes].filter((t) => t.done).sort((a, b) => b.take - a.take)[0];
			if (latest) return [{ cell: c.id, branch: `cell/${c.id}/take-${latest.take}` }];
		}
		return [];
	});
}

/** Cells worth more work: the printed take (or the latest) breaks continuity or predates a bible change. */
export function weakCells(s: BoardSummary) {
	return s.cells.filter((c) => {
		const shown = c.takes.find((t) => t.take === c.printed) ?? [...c.takes].filter((t) => t.done).sort((a, b) => b.take - a.take)[0];
		return !shown || !shown.ok || shown.stale;
	});
}

/**
 * The actions a showrunner may choose from now, most urgent first. A single action is a mandate: the clock,
 * the budget or the board's state leaves no choice. Code enforces these; the skill only chooses among the rest.
 */
export function allowedActions(s: BoardSummary): Action[] {
	if (s.submitted) return [];
	if (!s.drafted) return ["draft"];
	if (!s.planRequested) return ["plan"];
	if (!s.planned || s.openJobs > 0 || s.cutRunning) return ["wait"];
	// Video is required: a finished cut is submitted at once
	if (s.cut) return ["submit"];

	const timeLeft = (s.deadline - s.now) / 1000;
	const videoCost = s.prices.cut;
	const allPrinted = s.cells.every((c) => c.printed !== undefined);
	const picks = printPicks(s);
	const canCut = allPrinted && s.spent + videoCost <= s.budget;

	// Out of time: finish the board and cut now, or the team has nothing to submit
	if (timeLeft < CUT_WALL_S + CUT_MARGIN_S) {
		if (picks.length) return ["print"];
		return canCut ? ["cut"] : ["wait"];
	}

	const actions: Action[] = [];
	// Notes and retakes may never eat the money the required video needs
	const affordWork = s.spent + s.prices.take + s.prices.turn + videoCost <= s.budget;
	if (affordWork && weakCells(s).length) actions.push("note", "retake");
	if (picks.length) actions.push("print");
	if (canCut) actions.push("cut");
	actions.push("wait");
	return actions;
}

// ── Judges ─────────────────────────────────────────────────────────────────────────────────────────

export interface Criterion {
	id: string;
	question: string;
	levels: string[];
}

/** A judge skill's rubric: the JSON in its ```rubric block. */
export function rubricOf(body: string): Criterion[] {
	const block = /```rubric\n([\s\S]*?)```/.exec(body);
	if (!block) throw new Error("judge skill has no ```rubric block");
	const rubric = JSON.parse(block[1]) as Criterion[];
	if (!rubric.length || rubric.some((c) => !c.id || !c.question || c.levels?.length < 2)) throw new Error("malformed rubric");
	return rubric;
}

/** Up to `n` frames, evenly spread across the board in shot order. */
export function sampleCells<T>(cells: T[], n: number): T[] {
	if (cells.length <= n) return cells;
	return Array.from({ length: n }, (_, i) => cells[Math.round((i * (cells.length - 1)) / (n - 1))]);
}

/** One judge's scores for one team at one commit: criterion -> 0..(levels-1) */
export interface JudgeScore {
	judge: string;
	commit: string;
	scores: Record<string, number>;
	// Mean of the criteria, on a 0..4 scale
	total: number;
}

export interface LeaderboardRow {
	team: string;
	score: number;
	byJudge: Record<string, number>;
	disqualified?: string;
}

/**
 * Weighted mean of each judge's total. In the final round video is required: a team whose submission has
 * no cut is listed last and marked, with its score still shown.
 */
export function leaderboard(
	teams: { team: string; hasCut: boolean }[],
	scores: Record<string, JudgeScore[]>,
	weights: Record<string, number>,
	final: boolean,
): LeaderboardRow[] {
	const rows = teams.map(({ team, hasCut }) => {
		const mine = scores[team] ?? [];
		const byJudge = Object.fromEntries(mine.map((s) => [s.judge, s.total]));
		const weight = mine.reduce((w, s) => w + (weights[s.judge] ?? 1), 0);
		const score = weight ? mine.reduce((sum, s) => sum + s.total * (weights[s.judge] ?? 1), 0) / weight : 0;
		return { team, score: Number(score.toFixed(3)), byJudge, ...(final && !hasCut ? { disqualified: "no video" } : {}) };
	});
	return rows.sort((a, b) => Number(Boolean(a.disqualified)) - Number(Boolean(b.disqualified)) || b.score - a.score);
}
