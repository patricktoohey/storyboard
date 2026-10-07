// What each job costs a team, in USD. Workers AI responses don't report billed cost, so these estimates
// are the bill: a job is charged its estimate when it is queued (reserved) and keeps it whether it
// succeeds or fails, which errs toward spending less than the budget, never more. Prices as of 2026-10:
// video is per second of clip; the rest are rounded up from per-token and per-image prices.
import type { JobRequest } from "./jobs.ts";

export const PRICES = {
	// Director (LLM) + casting portraits (one image per character, typically 2)
	board: 0.06,
	// Cinematographer (LLM), one render, critic + continuity (two Clef calls with images)
	take: 0.03,
	// Director revision (LLM), recasts and blast radius; the takes it leads to are charged separately
	bible: 0.03,
	// Showrunner turn: one or two Clef decisions and sometimes an LLM note
	turn: 0.005,
	// wan-2.7-i2v at 720P
	videoPerSecond: 0.1,
} as const;

export function estimate(req: JobRequest): number {
	switch (req.kind) {
		case "board":
			return PRICES.board;
		case "take":
			return PRICES.take;
		case "bible":
			return PRICES.bible;
		case "turn":
			return PRICES.turn;
		case "video":
			return req.seconds * PRICES.videoPerSecond;
		// Merges, and judging (the arena pays for judges, not the teams)
		case "print":
		case "assemble":
		case "judge":
			return 0;
	}
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
