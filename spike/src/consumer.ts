// The storyboard-jobs queue consumer. One job per invocation: run it, reporting each stage to the jobs
// ledger, and queue whatever it leads to (a board's takes, a continuity retake, a bible edit's takes).
import { inspectPrints, printTakes, retakeOptions, runAssembleJob, runBibleJob, runBoardJob, runRemakeJob, runTakeJob, runVideoJob } from "./board";
import { queueLiveComparison, queueLiveJudging, runCompareJob, runJudgeJob } from "./arena";
import { runCastJob, runDraftPick, runSeasonEvent, runSeasonStep } from "./season";
import { limitsOf, report, submit } from "./coordinator";
import { withCrew } from "./crew-env";
import { LimitError } from "./ledger.ts";
import { runTurnJob } from "./showrunner";
import { runLinesJob, runMixJob, runScoreJob } from "./sound";
import type { Job } from "./jobs";

const FIRST_TAKES_STAGGER_S = 8;

async function run(env: Env, job: Job) {
	const progress = (detail: string) => report(env, job, "running", detail);
	switch (job.kind) {
		case "board":
		case "remake": {
			const board = job.kind === "board" ? await runBoardJob(env, job.repo, job.concept, job.cells, job.skills, progress) : await runRemakeJob(env, job.repo, progress);
			// Every cell's first take in one group; when the group closes, the ledger queues the first-cut print.
			// Staggered, from a random start: three teams' first takes at once hit the per-minute limit (D38)
			await submit(
				env,
				job.repo,
				board.cells.map((cell) => ({ kind: "take" as const, cell })),
				{ id: `cut-${job.id}`, kind: "first_cut" },
				{ delaySeconds: Math.floor(Math.random() * 15), stagger: FIRST_TAKES_STAGGER_S },
			);
			return { detail: `${board.title}: ${board.cells.length} cells queued` };
		}
		case "take": {
			const t = await runTakeJob(env, job.repo, job.cell, job.take, job.opts, progress);
			// The automatic retake joins the same group before this take is marked done, so a first cut
			// waits for it
			if (!t.ok && job.attempt === 1) {
				try {
					await submit(
						env,
						job.repo,
						[{ kind: "take", cell: job.cell, attempt: 2, opts: retakeOptions(job.opts, t.issues) }],
						job.group ? { id: job.group, kind: "first_cut" } : undefined,
					);
				} catch (err) {
					// An arena team out of budget or time: the take still stands, just without its retake
					if (!(err instanceof LimitError)) throw err;
				}
			}
			return { detail: t.ok ? `continuity ok (${t.skill})` : `continuity break: ${t.issues.join("; ")}`, result: t.ok ? "ok" : "break" };
		}
		case "bible": {
			const edit = await runBibleJob(env, job.repo, job.cell, job.note, progress);
			await submit(env, job.repo, edit.requests, { id: `bible-${job.id}`, kind: "bible" });
			return { detail: `${edit.summary} (re-shooting ${edit.affected.join(", ")})` };
		}
		case "print": {
			await progress("editor merging the takes into main");
			await printTakes(env, job.repo, job.picks, job.message);
			// In an arena, a new print is scored live
			await queueLiveJudging(env, job.repo).catch((e) => console.error("live judging", e));
			// The inspector looks at each newly printed frame (D45); a merge is free, the inspection isn't
			await progress("the inspector looking at the printed frames");
			const cost = await inspectPrints(env, job.repo, job.picks).catch((e) => (console.error("inspection", e), 0));
			return { detail: job.picks.map((p) => p.branch).join(", "), cost };
		}
		case "video": {
			const clip = await runVideoJob(env, job.repo, job.cut, job.cell, job.origin, job.seconds, progress, job.sync);
			if ("kept_from" in clip) return { detail: `${clip.seconds}s clip kept from ${clip.kept_from}`, cost: 0 };
			const flagged = clip.inspection?.wrong ? `; inspector flags ${clip.inspection.problems.join("; ")}${clip.inspection.motion === false ? " (in the frame, not the motion)" : ""}` : "";
			// The clip's own price plus the inspector's; a clip without a price keeps its estimate
			return { detail: `${clip.seconds}s clip (${clip.model}), ${(clip.bytes / 1e6).toFixed(1)} MB in ${Math.round(clip.elapsed_ms / 1000)}s${flagged}`, ...(clip.usd !== undefined ? { cost: clip.usd } : {}) };
		}
		case "assemble": {
			const cut = await runAssembleJob(env, job.repo, job.cut, job.cells, progress);
			await queueLiveJudging(env, job.repo).catch((e) => console.error("live judging", e));
			// Every cut is mixed into one teaser.mp4, with whatever sound the board has
			await submit(env, job.repo, [{ kind: "mix", cut: job.cut }]).catch((e) => console.error("mix", e));
			return { detail: `${cut.branch}: ${cut.clips} clips, ${cut.seconds}s` };
		}
		case "score":
			return runScoreJob(env, job.repo, job.direction, job.seconds, progress);
		case "lines":
			return runLinesJob(env, job.repo, job.direction, progress);
		case "mix":
			return runMixJob(env, job.repo, job.cut, progress, job.sound);
		case "turn":
			return runTurnJob(env, job, progress);
		case "compare": {
			const out = await runCompareJob(env, job.repo, job.final, progress);
			return {
				detail: out.compared
					? `${job.final ? "final: " : ""}${Object.entries(out.overall ?? {}).sort((a, b) => b[1] - a[1]).map(([t, r]) => `${t} ${(r * 100).toFixed(0)}%`).join(", ")}`
					: out.reason,
			};
		}
		case "season_step": {
			const out = await runSeasonStep(env, job.repo, job.season, job.round, progress);
			return { detail: out.detail };
		}
		case "cast":
			return runCastJob(env, job.season, job.origin, progress);
		case "draft_pick":
			return runDraftPick(env, job.season, job.pick, job.origin, progress);
		case "season_event":
			return runSeasonEvent(env, job.season, job.round, job.step, job.index ?? 0, progress);
		case "judge": {
			const judged = await runJudgeJob(env, job.repo, job.team, job.board, job.final, progress);
			// Live: with a new score in, compare the boards again
			if (!job.final && judged.judged) await queueLiveComparison(env, job.repo).catch((e) => console.error("live comparison", e));
			return {
				detail: judged.judged
					? `${job.final ? "final " : ""}${job.team}@${judged.commit.slice(0, 7)}: ${Object.entries(judged.totals ?? {}).map(([k, v]) => `${k.replace("judge-", "")} ${v.toFixed(2)}`).join(", ")}`
					: `${job.team}: ${judged.reason}`,
			};
		}
	}
}

/**
 * A showrunner's turns form a chain: each turn queues the next. A turn that fails or is interrupted must
 * still queue the next one, or its team goes silent (in the first arena, the auteur stopped with a finished
 * cut it never submitted). Refused after the deadline, which ends the chain.
 */
async function keepTurnsGoing(env: Env, job: Job) {
	if (job.kind !== "turn") return;
	await submit(env, job.repo, [{ kind: "turn", arena: job.arena, team: job.team, origin: job.origin }], undefined, { delaySeconds: 20 }).catch(
		(e) => console.warn(`next turn for ${job.team} not queued: ${e}`),
	);
}

export async function consume(batch: MessageBatch<Job>, env: Env) {
	// Concurrently: a batch is usually one board's takes, which should shoot side by side
	await Promise.all(batch.messages.map((msg) => consumeOne(msg, env)));
}

async function consumeOne(msg: Message<Job>, env: Env) {
	const job = msg.body;
	try {
		// A redelivery means the first attempt died mid-job (e.g. hit a limit); its branch may be half
		// pushed, so record the failure instead of running it twice
		if (msg.attempts > 1) {
			await report(env, job, "failed", "interrupted; retake from the board");
			await keepTurnsGoing(env, job);
		} else {
			// A board's jobs run with its crew's models; the arena's judges always use the Worker's own
			const jobEnv = job.kind === "judge" ? env : withCrew(env, (await limitsOf(env, job.repo)).crew);
			// No separate "started" report: every job reports its first stage straight away, and each report is a commit
			const out = await run(jobEnv, job);
			await report(env, job, "done", out.detail, "result" in out ? out.result : undefined, "cost" in out ? (out.cost as number | undefined) : undefined);
		}
	} catch (err) {
		console.error(job.kind, job.id, err);
		await report(env, job, "failed", String(err).slice(0, 300)).catch((e) => console.error("could not record failure", e));
		await keepTurnsGoing(env, job);
	}
	msg.ack();
}
