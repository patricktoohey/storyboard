// The storyboard-jobs queue consumer. One job per invocation: run it, reporting each stage to the jobs
// ledger, and queue whatever it leads to (a board's takes, a continuity retake, a bible edit's takes).
import { printTakes, retakeOptions, runAssembleJob, runBibleJob, runBoardJob, runTakeJob, runVideoJob } from "./board";
import { report, submit } from "./coordinator";
import type { Job } from "./jobs";

async function run(env: Env, job: Job) {
	const progress = (detail: string) => report(env, job, "running", detail);
	switch (job.kind) {
		case "board": {
			const board = await runBoardJob(env, job.repo, job.concept, job.cells, job.skills, progress);
			// Every cell's first take in one group; when the group closes, the ledger queues the first-cut print
			await submit(
				env,
				job.repo,
				board.cells.map((cell) => ({ kind: "take" as const, cell })),
				{ id: `cut-${job.id}`, kind: "first_cut" },
			);
			return { detail: `${board.title}: ${board.cells.length} cells queued` };
		}
		case "take": {
			const t = await runTakeJob(env, job.repo, job.cell, job.take, job.opts, progress);
			// The automatic retake joins the same group before this take is marked done, so a first cut
			// waits for it
			if (!t.ok && job.attempt === 1) {
				await submit(
					env,
					job.repo,
					[{ kind: "take", cell: job.cell, attempt: 2, opts: retakeOptions(job.opts, t.issues) }],
					job.group ? { id: job.group, kind: "first_cut" } : undefined,
				);
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
			return { detail: job.picks.map((p) => p.branch).join(", ") };
		}
		case "video": {
			const clip = await runVideoJob(env, job.repo, job.cut, job.cell, job.origin, progress);
			return { detail: `${clip.seconds}s clip, ${(clip.bytes / 1e6).toFixed(1)} MB in ${Math.round(clip.elapsed_ms / 1000)}s` };
		}
		case "assemble": {
			const cut = await runAssembleJob(env, job.repo, job.cut, job.cells, progress);
			return { detail: `${cut.branch}: ${cut.clips} clips, ${cut.seconds}s` };
		}
	}
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
		} else {
			// No separate "started" report: every job reports its first stage straight away, and each report is a commit
			const out = await run(env, job);
			await report(env, job, "done", out.detail, "result" in out ? out.result : undefined);
		}
	} catch (err) {
		console.error(job.kind, job.id, err);
		await report(env, job, "failed", String(err).slice(0, 300)).catch((e) => console.error("could not record failure", e));
	}
	msg.ack();
}
