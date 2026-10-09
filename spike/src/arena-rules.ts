// The arena's decisions without I/O: what a showrunner may do next, which takes to print, how rubrics
// read, and how scores become a leaderboard. Pure, so it is unit-tested (test/arena-rules.test.ts).
import { addressee } from "./cast-rules.ts";
import { RECAP_SHOTS } from "./sound-rules.ts";

// ── Showrunner actions ──────────────────────────────────────────────────────────────────────────────

// A self-comparison: the judges' rubric questions on two contact sheets, both ways round
export const COMPARE_USD = 0.02;

// The showrunner's tools, as its lead model reads them each turn (args in braces). The board is a Git
// repo, and several tools are Git itself: every take is a branch, printing is a merge, versions can be
// saved as branches, compared, and restored, and nothing is ever lost.
export const ACTIONS = {
	draft: "Choose the crew: which model fills each slot, within the budget",
	plan: "Plan the board from the brief: director, casting and scouting, then every cell's first take",
	replan:
		'{"direction": string} Plan the whole board again, in a new direction you describe (a different idea, structure or tone). The current board is saved first as a branch, so you can compare the two and restore either',
	note: '{"cell": "02", "note": string, "insist"?: true} Give a director\'s note on one cell, so it is re-shot with the note. Any cell, not only broken ones',
	retake: '{"cell": "02"} Re-shoot one cell as it is, for a different render',
	ideas:
		'{"cell": "03", "ideas": [{"name": "mirror", "idea": "..."}, {"name": "profile", "idea": "..."}]} Two or three different ideas for one shot, shot at the same time, each on its own take branch. Use it where a shot isn\'t coming together or you want options. Rivals see that you tried ideas, not what they are. Print the one you want; compare two takes first ("a": "cell/03/take-3", "b": "cell/03/take-4") to see which plays better beside its neighbours. A take each',
	print:
		'{"takes"?: {"02": 1, ...}} Print takes onto the board (a merge). Default: the best finished take of each cell. Name a take per cell to print a specific one, including an earlier take: every take is kept on its own branch',
	cut: "Make the video: animate every printed frame and assemble a new cut (cut/v1, cut/v2, ...), mixed with whatever sound the board has",
	score:
		'{"direction": string} A score for the whole film: your sound designer (or you, without one) writes the music from your direction, at the film\'s length. A new score replaces the old; the next cut or remix carries it',
	lines:
		'{"direction": string} Dialogue and voiceover: your writer (or you) writes lines on the cells, each spoken in a stock voice its character keeps. New lines replace the old; the next cut or remix carries them',
	remix: '{"cut"?: "v1"} Mix a cut again with the board\'s sound as it is now (score, lines), without rendering its video again. Default: the latest cut. Free',
	submit: '{"cut"?: "v1"} Submit a cut; the team stops working. Default: the latest cut; any earlier cut can be submitted instead',
	save: '{"name": string} Save the board as it is now under a name (a branch), to compare against or come back to later. Free',
	restore:
		'{"version": string} Bring the board back to an earlier version: a commit from your history or a saved name. Recorded as a new commit, so nothing is lost and you can restore forward again. Free',
	compare: `{"a": string, "b": string} Have the judges compare two versions of your board side by side (commits, saved names, or "main" for now); the verdict appears in your history. About $${COMPARE_USD.toFixed(2)}`,
	talk: '{"to": "crew" | a player\'s name, "message": string} Speak to your crew in the crew room: ask for ideas, argue a choice, settle a disagreement. Whoever you address answers. Costs only their words',
	recap:
		'{"shots": ["cell/03/take-2", "cell/05/take-1", ...]} "Previously on": two to four stills from your board\'s own history (takes you didn\'t print, from any plan) open the teaser, washed out, 1.2 seconds each. Nothing is ever lost, so what didn\'t make it can be part of the story. A new recap replaces the old; the next cut or remix carries it. Free',
	post: '{"message": string} Say something in the commons, which every team reads: a challenge, an offer, a doubt about a rival. Free',
	wait: "Do nothing now: you're asked again when running work finishes",
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
	// Latest assembled cut, every assembled cut, and whether a cut is still rendering
	cut?: string;
	cuts?: string[];
	cutRunning: boolean;
	submitted: boolean;
	// Jobs still queued or running on the board, other than showrunner turns
	openJobs: number;
	// Something new since the lead last chose (a job finished, or it acted last time): with work running, the
	// lead is asked only then, and otherwise waits for free (D38)
	fresh?: boolean;
	spent: number;
	budget: number;
	now: number;
	deadline: number;
	// Video seconds a cut of the whole board would need (each cell's clip, capped)
	cutSeconds: number;
	// The crew's prices: one take, one turn, the whole cut at its video model's billing, a new plan, and sound
	prices: { take: number; turn: number; cut: number; board?: number; score?: number; lines?: number };
	// The board's sound: a score, how many lines, and which cuts are mixed with the sound as it is now
	sound?: { score: boolean; lines: number; current: string[] };
	// A cast team: its players' names (for talk), and whether the commons is open (not in a blind round)
	talk?: { names: string[]; commons: boolean };
	// The format lets teasers open on a recap from the board's history (D38)
	recap?: boolean;
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
	if (!s.planned) return ["wait"];

	const timeLeft = (s.deadline - s.now) / 1000;
	// Running work no longer holds the lead (D38): it may start more beside it, and is asked again when
	// something finishes. Until then it waits for free
	const idle = s.openJobs > 0 && !s.fresh;
	// A cut reads main as its clips render: nothing may move main under it, and a late one runs out the clock
	if (s.cutRunning && (idle || timeLeft < CUT_WALL_S + CUT_MARGIN_S)) return ["wait"];
	const videoCost = s.prices.cut;
	const allPrinted = s.cells.every((c) => c.printed !== undefined);
	const picks = printPicks(s);
	const canCut = allPrinted && s.spent + videoCost <= s.budget;
	const cutTime = CUT_WALL_S + CUT_MARGIN_S;

	if (s.cut) {
		// Video is required: with a cut in hand and no time to make another, submit (an earlier cut assembled
		// before the deadline counts anyway). Was twice the cut's time: the finale re-run lost 15 minutes (D38)
		if (timeLeft < cutTime) return ["submit"];
		if (idle) return ["wait"];
	} else {
		// Out of time: finish the board and cut now, or the team has nothing to submit. This comes before
		// waiting on running work: slow retakes must not hold up the cut (the crew arena's auteur printed with
		// 3.5 minutes left because it waited on two retakes)
		if (timeLeft < cutTime) {
			if (picks.length) return ["print"];
			return canCut && !s.cutRunning ? ["cut"] : ["wait"];
		}
		if (idle) return ["wait"];
	}

	const actions: Action[] = [];
	// Work may never eat the money the required video needs (a further cut, when one exists)
	const affordWork = s.spent + s.prices.take + s.prices.turn + videoCost <= s.budget;
	if (affordWork && s.cells.length) actions.push("note", "retake");
	// Two ideas at once cost two takes
	if (s.cells.length && s.spent + 2 * s.prices.take + s.prices.turn + videoCost <= s.budget) actions.push("ideas");
	// A new plan needs a plan, a take per cell and a cut, and the time to shoot and cut them
	const replanCost = (s.prices.board ?? 0) + s.cells.length * s.prices.take + videoCost;
	if (s.prices.board !== undefined && s.spent + replanCost <= s.budget && timeLeft > cutTime + 240) actions.push("replan");
	if (s.cells.some((c) => c.takes.some((t) => t.done && t.take !== c.printed))) actions.push("print");
	if (canCut) actions.push("cut");
	if (s.cut) actions.push("submit");
	actions.push("save", "restore");
	if (s.spent + COMPARE_USD + videoCost <= s.budget) actions.push("compare");
	// Sound may never eat the video's money either
	if (s.prices.score !== undefined && s.spent + s.prices.score + videoCost <= s.budget) actions.push("score");
	if (s.prices.lines !== undefined && s.cells.length && s.spent + s.prices.lines + videoCost <= s.budget) actions.push("lines");
	// A remix is worth it when the sound has changed since the latest cut was mixed
	if (s.cut && s.sound && (s.sound.score || s.sound.lines) && !s.sound.current.includes(s.cut)) actions.push("remix");
	if (s.talk?.names.length && s.spent + s.prices.turn + videoCost <= s.budget) actions.push("talk");
	if (s.talk?.commons) actions.push("post");
	if (s.recap && s.cells.some((c) => c.takes.some((t) => t.done && t.take !== c.printed))) actions.push("recap");
	actions.push("wait");
	// While a cut renders, only work beside main: takes and ideas on their own branches, notes, sound, saves
	return s.cutRunning ? actions.filter((a) => !MOVES_MAIN.includes(a)) : actions;
}
const TAKE_REF = /^cell\/(\d+)\/take-(\d+)$/;
const MOVES_MAIN: Action[] = ["print", "cut", "restore", "replan", "remix"];

/** The lead model's answer, checked: an allowed action with valid arguments. */
export interface Decision {
	action: Action;
	args: Record<string, unknown>;
	// Private and true: the team's own log
	reason: string;
	// Public: what rivals read beside the move (a cast season's open rounds). May say anything
	message?: string;
}

const str = (v: unknown, max = 400) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Parses and validates a decision. Anything malformed or not allowed is an error, which the caller records
 * (the turn waits): a model never gets to run a tool it wasn't offered, or on a cell that doesn't exist.
 */
/** Two or three named ideas for a shot; names become short slugs, and a repeated name gets a number. */
export function parseIdeas(v: unknown): { name: string; text: string }[] {
	const out: { name: string; text: string }[] = [];
	for (const x of Array.isArray(v) ? v.slice(0, 3) : []) {
		const text = str((x as { idea?: unknown })?.idea, 400);
		let name = (str((x as { name?: unknown })?.name, 30) ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `idea-${out.length + 1}`;
		if (out.some((o) => o.name === name)) name = `${name}-${out.length + 1}`;
		if (text) out.push({ name, text });
	}
	return out;
}

export function parseDecision(text: string, allowed: Action[], s: BoardSummary): Decision | { error: string } {
	const parsed = decisionOf(text, allowed, s);
	if ("error" in parsed) return parsed;
	let message: string | undefined;
	try {
		const raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { message?: unknown };
		message = str(raw.message, 200);
	} catch {
		// decisionOf already parsed it
	}
	return message ? { ...parsed, message } : parsed;
}

function decisionOf(text: string, allowed: Action[], s: BoardSummary): Decision | { error: string } {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	let raw: { action?: unknown; args?: unknown; reason?: unknown };
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return { error: `not JSON: ${text.slice(0, 120)}` };
	}
	const action = raw.action as Action;
	if (!allowed.includes(action)) return { error: `"${String(raw.action)}" is not one of ${allowed.join(", ")}` };
	const a = (typeof raw.args === "object" && raw.args !== null ? raw.args : {}) as Record<string, unknown>;
	const reason = str(raw.reason, 300) ?? "";
	const cellIds = s.cells.map((c) => c.id);
	const cellOf = (v: unknown) => {
		const id = typeof v === "number" ? String(v).padStart(2, "0") : str(v);
		return id && cellIds.includes(id) ? id : undefined;
	};
	switch (action) {
		case "note": {
			const cell = cellOf(a.cell);
			const note = str(a.note);
			if (!cell || !note) return { error: `note needs a cell (${cellIds.join(", ")}) and a note` };
			return { action, args: { cell, note, ...(a.insist === true ? { insist: true } : {}) }, reason };
		}
		case "retake": {
			const cell = cellOf(a.cell);
			if (!cell) return { error: `retake needs a cell (${cellIds.join(", ")})` };
			return { action, args: { cell }, reason };
		}
		case "recap": {
			const shots = Array.isArray(a.shots) ? [...new Set(a.shots.filter((x): x is string => typeof x === "string" && TAKE_REF.test(x)))] : [];
			if (shots.length < RECAP_SHOTS.min || shots.length > RECAP_SHOTS.max) return { error: `recap needs ${RECAP_SHOTS.min} to ${RECAP_SHOTS.max} take branches, like "cell/03/take-2"` };
			// What's on the board now is the film: a recap is what didn't make it
			const printed = shots.filter((b) => {
				const [, cell, take] = TAKE_REF.exec(b)!;
				return s.cells.find((c) => c.id === cell)?.printed === Number(take);
			});
			if (printed.length) return { error: `${printed.join(", ")} ${printed.length > 1 ? "are" : "is"} printed: a recap is takes that didn't make it` };
			return { action, args: { shots }, reason };
		}
		case "ideas": {
			const cell = cellOf(a.cell);
			const ideas = parseIdeas(a.ideas);
			if (!cell || ideas.length < 2) return { error: `ideas needs a cell (${cellIds.join(", ")}) and two or three ideas, each {"name", "idea"}` };
			return { action, args: { cell, ideas }, reason };
		}
		case "print": {
			const asked = typeof a.takes === "object" && a.takes !== null ? Object.entries(a.takes as Record<string, unknown>) : [];
			const takes: { cell: string; branch: string }[] = [];
			for (const [k, v] of asked) {
				const cell = cellOf(k);
				const t = Number(v);
				const found = cell && s.cells.find((c) => c.id === cell)?.takes.find((x) => x.take === t && x.done);
				if (!found) return { error: `cell ${k} has no finished take ${String(v)}` };
				takes.push({ cell: cell!, branch: `cell/${cell}/take-${t}` });
			}
			const picks = takes.length ? takes : printPicks(s);
			if (!picks.length) return { error: "nothing to print: name the takes" };
			return { action, args: { picks }, reason };
		}
		case "submit": {
			const cut = str(a.cut, 20)?.replace(/^cut\//, "") ?? s.cut;
			if (!cut || !(s.cuts ?? [s.cut]).includes(cut)) return { error: `no cut "${String(a.cut)}" (cuts: ${(s.cuts ?? []).join(", ")})` };
			return { action, args: { cut }, reason };
		}
		case "save": {
			const name = (str(a.name, 40) ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
			if (!name) return { error: "save needs a name" };
			return { action, args: { name }, reason };
		}
		case "restore": {
			const version = str(a.version, 80);
			if (!version) return { error: "restore needs a version" };
			return { action, args: { version }, reason };
		}
		case "compare": {
			const va = str(a.a, 80);
			const vb = str(a.b, 80);
			if (!va || !vb || va === vb) return { error: "compare needs two different versions" };
			return { action, args: { a: va, b: vb }, reason };
		}
		case "talk": {
			const names = s.talk?.names ?? [];
			const to = addressee(a.to, names);
			const message = str(a.message, 600);
			if (!to || !message) return { error: `talk needs "to" ("crew" or one of ${names.join(", ")}) and a message` };
			return { action, args: { to, message }, reason };
		}
		case "post": {
			const message = str(a.message, 600);
			if (!message) return { error: "post needs a message" };
			return { action, args: { message }, reason };
		}
		case "score":
		case "lines": {
			const direction = str(a.direction, 600);
			if (!direction) return { error: `${action} needs a direction` };
			return { action, args: { direction }, reason };
		}
		case "remix": {
			const cut = str(a.cut, 20)?.replace(/^cut\//, "") ?? s.cut;
			if (!cut || !(s.cuts ?? [s.cut]).includes(cut)) return { error: `no cut "${String(a.cut)}" (cuts: ${(s.cuts ?? []).join(", ")})` };
			return { action, args: { cut }, reason };
		}
		case "replan": {
			const direction = str(a.direction, 600);
			if (!direction) return { error: "replan needs a direction" };
			return { action, args: { direction }, reason };
		}
		default:
			return { action, args: {}, reason };
	}
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
	// Comparative win rate (0..1), the ranking when judges have compared the boards (D23)
	winRate?: number;
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
	rates?: Record<string, number>,
): LeaderboardRow[] {
	const rows = teams.map(({ team, hasCut }) => {
		const mine = scores[team] ?? [];
		const byJudge = Object.fromEntries(mine.map((s) => [s.judge, s.total]));
		const weight = mine.reduce((w, s) => w + (weights[s.judge] ?? 1), 0);
		const score = weight ? mine.reduce((sum, s) => sum + s.total * (weights[s.judge] ?? 1), 0) / weight : 0;
		return {
			team,
			...(rates?.[team] !== undefined ? { winRate: rates[team] } : {}),
			score: Number(score.toFixed(3)),
			byJudge,
			...(final && !hasCut ? { disqualified: "no video" } : {}),
		};
	});
	return rows.sort(
		(a, b) =>
			Number(Boolean(a.disqualified)) - Number(Boolean(b.disqualified)) ||
			(b.winRate ?? -1) - (a.winRate ?? -1) ||
			b.score - a.score,
	);
}

// ── Comparative judging ────────────────────────────────────────────────────────────────────────────

/**
 * Every pair of teams, in both orders. Judges see two contact sheets as "first" and "second"; asking each
 * pair both ways cancels a preference for either position.
 */
export function matchups(teams: string[]): [string, string][] {
	const out: [string, string][] = [];
	for (let i = 0; i < teams.length; i++) for (let j = 0; j < teams.length; j++) if (i !== j) out.push([teams[i], teams[j]]);
	return out;
}

/** One judge's verdict on one matchup: for each criterion, the probability that `first` is better. */
export interface Comparison {
	judge: string;
	first: string;
	second: string;
	pFirst: Record<string, number>;
	// A watching judge's sentence on each film (teaser-rules.ts)
	notes?: { first: string; second: string };
}

export interface WinRates {
	// team -> judge -> mean probability of winning its matchups, over criteria (0..1)
	byJudge: Record<string, Record<string, number>>;
	// team -> criterion -> mean win probability, across judges
	byCriterion: Record<string, Record<string, number>>;
	// team -> weighted mean over judges
	overall: Record<string, number>;
}

/** Turns pairwise comparisons into each team's win rate: 0.5 means even, 1 means it won every matchup. */
export function winRates(comparisons: Comparison[], weights: Record<string, number>): WinRates {
	const wins: Record<string, Record<string, number[]>> = {};
	const crit: Record<string, Record<string, number[]>> = {};
	const add = (store: Record<string, Record<string, number[]>>, team: string, key: string, p: number) => {
		((store[team] ??= {})[key] ??= []).push(p);
	};
	for (const c of comparisons) {
		for (const [criterion, p] of Object.entries(c.pFirst)) {
			add(wins, c.first, c.judge, p);
			add(wins, c.second, c.judge, 1 - p);
			add(crit, c.first, criterion, p);
			add(crit, c.second, criterion, 1 - p);
		}
	}
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const round = (x: number) => Number(x.toFixed(3));
	const byJudge = Object.fromEntries(Object.entries(wins).map(([t, js]) => [t, Object.fromEntries(Object.entries(js).map(([j, ps]) => [j, round(mean(ps))]))]));
	const byCriterion = Object.fromEntries(Object.entries(crit).map(([t, cs]) => [t, Object.fromEntries(Object.entries(cs).map(([c, ps]) => [c, round(mean(ps))]))]));
	const overall = Object.fromEntries(
		Object.entries(byJudge).map(([t, js]) => {
			const w = Object.keys(js).reduce((sum, j) => sum + (weights[j] ?? 1), 0);
			return [t, round(Object.entries(js).reduce((sum, [j, v]) => sum + v * (weights[j] ?? 1), 0) / w)];
		}),
	);
	return { byJudge, byCriterion, overall };
}

// ── Seasons ────────────────────────────────────────────────────────────────────────────────────────

/** Points per finishing place in a round; a team without video scores nothing. */
export const PLACE_POINTS = [3, 2, 1];

export interface RoundResult {
	round: number;
	// teams in finishing order, disqualified last
	ranking: { team: string; winRate: number; disqualified?: string }[];
	// When a panel ranked it (D34): the film and process parts of each team's win rate, and its Git moves
	film?: Record<string, number>;
	process?: Record<string, number>;
	git_moves?: Record<string, number>;
	// Two endings (D38): the panel's probability that each team's submitted ending was the stronger
	endings?: Record<string, number>;
}

export function seasonStandings(rounds: RoundResult[]) {
	const points: Record<string, number> = {};
	const history: Record<string, number[]> = {};
	for (const r of rounds) {
		r.ranking.forEach((row, place) => {
			const p = row.disqualified ? 0 : (PLACE_POINTS[place] ?? 0);
			points[row.team] = (points[row.team] ?? 0) + p;
			(history[row.team] ??= []).push(row.winRate);
		});
	}
	return Object.keys(points)
		.map((team) => ({ team, points: points[team], winRates: history[team] }))
		.sort((a, b) => b.points - a.points || (b.winRates.at(-1) ?? 0) - (a.winRates.at(-1) ?? 0));
}

/**
 * A retrospective may rewrite only the skill's "## Strategy" section; the rest (role, notes style, output
 * rules) stays as it was. Returns the new skill text, or the old one if the section is missing or the
 * rewrite is empty or oversized.
 */
export function replaceStrategy(skillText: string, strategy: string, maxChars = 2000) {
	const body = strategy.replace(/^#+\s*Strategy\s*\n/i, "").trim();
	if (!body || body.length > maxChars) return skillText;
	const start = skillText.search(/^## Strategy\s*$/m);
	if (start < 0) return skillText;
	const next = skillText.indexOf("\n## ", start + 1);
	const end = next < 0 ? skillText.length : next + 1;
	return `${skillText.slice(0, start)}## Strategy\n\n${body}\n\n${skillText.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

/** A showrunner skill's "## Strategy" section, for showing rivals' strategies to a retrospective. */
export function strategyOf(skillText: string) {
	const start = skillText.search(/^## Strategy\s*$/m);
	if (start < 0) return "";
	const next = skillText.indexOf("\n## ", start + 1);
	return skillText.slice(start, next < 0 ? undefined : next).replace(/^## Strategy\s*/, "").trim();
}
