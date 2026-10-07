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
		| { kind: "video"; cell: string; cut: string; origin: string }
		// Merge a cut's video branches into cut/<cut> with an edit decision list
		| { kind: "assemble"; cut: string; cells: string[] }
	);

/** A job as submitted, before the coordinator assigns an id (and, for takes, a take number). */
export type JobRequest =
	| { kind: "board"; concept: string; cells: number; skills: Record<string, string> }
	| { kind: "take"; cell: string; attempt?: 1 | 2; opts?: TakeOptions }
	| { kind: "bible"; cell: string; note: string }
	| { kind: "print"; picks: { cell: string; branch: string }[]; message: string }
	| { kind: "video"; cell: string; cut: string; origin: string }
	| { kind: "assemble"; cut: string; cells: string[] };

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
