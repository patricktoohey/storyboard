// Work items on the storyboard-jobs queue. The coordinator (coordinator.ts) creates them, numbers takes and
// tracks status; the queue consumer (consumer.ts) runs one per invocation.

/** The line a clip is lip-synced to (D44): its file on main and what it says, to tell if it changed. */
export interface LineSync {
	file: string;
	text: string;
}

export interface TakeOptions {
	note?: string;
	// Cinematographer skill for this take; defaults to the board's choice
	skill?: string;
	// Reseed: reuse this exact prompt instead of asking the cinematographer
	prompt?: string;
	// One of several ideas for this shot, shot side by side on their own take branches (D35)
	idea?: { name: string; text: string };
	// Fix one detail of an existing frame (D42): an image model edits the frame at `from` (main, for the
	// printed take, or a take branch) as the instruction says. No cinematographer, no new render
	edit?: { instruction: string; from: string };
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
		// Animate one cell's printed frame into cut/<cut>/<cell>; `origin` is where the frame's signed URL points.
		// With `sync`, the clip is lip-synced to that line (D44) and runs its length
		| { kind: "video"; cell: string; cut: string; origin: string; seconds: number; sync?: LineSync }
		// Merge a cut's video branches into cut/<cut> with an edit decision list
		| { kind: "assemble"; cut: string; cells: string[] }
		// Sound (sound.ts): the score at the film's length, the lines in their voices, and the mix of a cut
		| { kind: "score"; direction: string; seconds: number }
		| { kind: "lines"; direction: string }
		| { kind: "mix"; cut: string }
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
		// Cast season: one of the producer's moves between rounds (twists, elimination, protect, steal, replace)
		| { kind: "season_event"; season: string; round: number; step: import("./season").SeasonStep; index?: number; origin: string }
	);

/** A job as submitted, before the coordinator assigns an id (and, for takes, a take number). */
export type JobRequest =
	| { kind: "board"; concept: string; cells: number; skills: Record<string, string> }
	| { kind: "take"; cell: string; attempt?: 1 | 2; opts?: TakeOptions }
	| { kind: "bible"; cell: string; note: string }
	| { kind: "print"; picks: { cell: string; branch: string }[]; message: string }
	| { kind: "video"; cell: string; cut: string; origin: string; seconds: number; sync?: LineSync }
	| { kind: "assemble"; cut: string; cells: string[] }
	| { kind: "score"; direction: string; seconds: number }
	| { kind: "lines"; direction: string }
	| { kind: "mix"; cut: string }
	| { kind: "turn"; arena: string; team: string; origin: string }
	| { kind: "judge"; team: string; board: string; final: boolean }
	| { kind: "compare"; final: boolean }
	| { kind: "season_step"; season: string; round: number; origin: string }
	| { kind: "cast"; season: string; origin: string }
	| { kind: "draft_pick"; season: string; pick: number; origin: string }
	| { kind: "season_event"; season: string; round: number; step: import("./season").SeasonStep; index?: number; origin: string };

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
