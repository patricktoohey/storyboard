// Work items on the storyboard-jobs queue. The coordinator (coordinator.ts) creates them, numbers takes and
// tracks status; the queue consumer (consumer.ts) runs one per invocation.

export interface TakeOptions {
	note?: string;
	// Cinematographer skill for this take; defaults to the board's choice
	skill?: string;
	// Reseed: reuse this exact prompt instead of asking the cinematographer
	prompt?: string;
}

interface JobBase {
	repo: string;
	id: string;
	// Jobs in a group finish together; the coordinator runs the group's follow-up (e.g. print the first cut)
	group?: string;
}

export type Job = JobBase &
	(
		| { kind: "board"; concept: string; cells: number; skills: Record<string, string> }
		// attempt 2 is the automatic retake after a continuity break; it doesn't retake again
		| { kind: "take"; cell: string; take: number; attempt: 1 | 2; opts: TakeOptions }
		| { kind: "bible"; cell: string; note: string }
		| { kind: "print"; picks: { cell: string; branch: string }[]; message: string }
		// Animate one cell's printed frame into cut/<cut>/<cell>; `origin` is where the frame's signed URL points
		| { kind: "video"; cell: string; cut: string; origin: string; seconds: number }
		// Merge a cut's video branches into cut/<cut> with an edit decision list
		| { kind: "assemble"; cut: string; cells: string[] }
		// Arena: one showrunner turn on a team's board (showrunner.ts)
		| { kind: "turn"; arena: string; team: string; origin: string }
		// Arena: score a team's board at its current main (or its submission, in the final round)
		| { kind: "judge"; team: string; board: string; final: boolean }
		// Arena: judges compare every pair of boards, side by side, both ways round
		| { kind: "compare"; final: boolean }
		// Season: after a round's final judging, record it, run retrospectives, start the next round
		| { kind: "season_step"; season: string; round: number; origin: string }
		// Cast season: every lead, player and judge creates its character, then the draft starts
		| { kind: "cast"; season: string; origin: string }
		// Cast season: one pick of the snake draft; the last pick starts round 1
		| { kind: "draft_pick"; season: string; pick: number; origin: string }
	);

/** A job as submitted, before the coordinator assigns an id (and, for takes, a take number). */
export type JobRequest =
	| { kind: "board"; concept: string; cells: number; skills: Record<string, string> }
	| { kind: "take"; cell: string; attempt?: 1 | 2; opts?: TakeOptions }
	| { kind: "bible"; cell: string; note: string }
	| { kind: "print"; picks: { cell: string; branch: string }[]; message: string }
	| { kind: "video"; cell: string; cut: string; origin: string; seconds: number }
	| { kind: "assemble"; cut: string; cells: string[] }
	| { kind: "turn"; arena: string; team: string; origin: string }
	| { kind: "judge"; team: string; board: string; final: boolean }
	| { kind: "compare"; final: boolean }
	| { kind: "season_step"; season: string; round: number; origin: string }
	| { kind: "cast"; season: string; origin: string }
	| { kind: "draft_pick"; season: string; pick: number; origin: string };

/** A team board's limits, from its board.json; absent on boards outside an arena. */
export interface Limits {
	budget_usd?: number;
	// The board's drafted crew (crew.ts), which prices its jobs; absent means DEFAULT_CREW
	crew?: import("./crew.ts").Crew;
	// ISO time after which the board accepts no new work
	deadline?: string;
}

/** What a finished take reports back, enough for the coordinator to pick the best take of a cell. */
export interface TakeResult {
	branch: string;
	take: number;
	ok: boolean;
	issues: string[];
	skill: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

/** One event on the board's live feed (WebSocket) and in the coordinator's job table. */
export interface JobEvent {
	id: string;
	kind: Job["kind"];
	cell?: string;
	take?: number;
	status: JobStatus;
	// What the job is doing now: "cinematographer", "renderer", "continuity break: ...", ...
	detail?: string;
	at: string;
}
