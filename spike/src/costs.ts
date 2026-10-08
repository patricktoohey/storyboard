// What each job costs a team, in USD, given its crew (crew.ts; Cloudflare's prices). Workers AI responses
// don't report billed cost, so these estimates are the bill: a job is charged its estimate when it is
// queued (reserved) and keeps it whether it succeeds or fails, which errs toward spending less than the
// budget, never more (D19).
import { type Crew, DEFAULT_CREW, clipCost, crewCosts } from "./crew.ts";
import type { JobRequest } from "./jobs.ts";

export function estimate(req: JobRequest, crew: Crew = DEFAULT_CREW): number {
	const c = crewCosts(crew);
	switch (req.kind) {
		case "board":
			return c.board;
		case "take":
			return c.take;
		case "bible":
			return c.bible;
		case "turn":
			return c.turn;
		case "video":
			// Billed at the provider's clip length, which can exceed the plan (Hailuo bills at least 6 s)
			return clipCost(crew, req.seconds).usd;
		// Merges, and judging (the arena pays for judges, not the teams)
		case "print":
		case "assemble":
		case "judge":
		case "compare":
		case "season_step":
		case "cast":
		case "draft_pick":
			return 0;
	}
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
