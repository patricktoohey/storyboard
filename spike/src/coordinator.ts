// The coordinator, with no state of its own: the jobs ledger (ledger.ts) on the board's `jobs` branch is
// the state, Git's push compare-and-swap is the lock, and the storyboard-jobs queue is the transport.
// submit() and report() each make one ledger commit, retried on a lost race, then queue whatever that
// commit created.
import { WorkingTree, type Remote } from "./git";
import type { Job, JobRequest, JobStatus, Limits } from "./jobs";
import {
	type GroupKind,
	type LedgerRow,
	LEDGER_BRANCH,
	LEDGER_FILE,
	appendJobs,
	ledgerCsv,
	parseLedger,
	recordProgress,
} from "./ledger.ts";
import { repoRemote } from "./template";
import { crewFrom } from "./crew.ts";

const newId = () => crypto.randomUUID().slice(0, 8);

// Queueing jobs and recording a job's outcome must land, however busy the ledger is. In a 4-cell run with
// 8 attempts, one take lost 8 races in a row on a progress report, and that failed the take.
const DURABLE_ATTEMPTS = 20;
const now = () => new Date().toISOString();

/**
 * One ledger edit as one commit. Clones the jobs branch (creating it on first use), applies `edit` to the
 * rows, commits and pushes; a rejected push means another job updated the ledger first, so start again
 * from the new state. `edit` must be safe to re-run.
 */
async function onLedger<T>(remote: Remote, message: string, edit: (rows: LedgerRow[]) => T, attempts = DURABLE_ATTEMPTS): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		let tree: WorkingTree;
		let rows: LedgerRow[];
		try {
			tree = await WorkingTree.clone(remote, LEDGER_BRANCH);
			rows = parseLedger(await tree.read(LEDGER_FILE));
		} catch (err) {
			if (!/not find|NotFound|could not find/i.test(String(err))) throw err;
			// First use: an orphan branch holding just the ledger
			tree = await WorkingTree.init(remote, LEDGER_BRANCH);
			rows = [];
		}
		const result = edit(rows);
		await tree.commit({ name: "coordinator" }, message, { [LEDGER_FILE]: ledgerCsv(rows) });
		try {
			await tree.push(LEDGER_BRANCH);
			return result;
		} catch (err) {
			if (attempt >= attempts) throw err;
			// Growing, jittered backoff, so racing jobs spread out instead of colliding again
			await new Promise((r) => setTimeout(r, Math.min(3000, 150 * attempt) + Math.random() * 400));
		}
	}
}

const describe = (j: Job) =>
	j.kind === "take" ? `take ${j.take} of cell ${j.cell}` : j.kind === "bible" ? `bible edit from cell ${j.cell}` : j.kind;

/** A board's budget and deadline (board.json); none outside an arena. */
export async function limitsOf(env: Env, repo: string): Promise<Limits> {
	using handle = await env.ARTIFACTS.get(repo);
	const text = await (await handle.readFile({ ref: "main", path: "board.json" }).catch(() => null))?.text();
	const board = text ? (JSON.parse(text) as Limits) : {};
	return { budget_usd: board.budget_usd, deadline: board.deadline, crew: crewFrom(board.crew) };
}

/**
 * Records new jobs in the ledger (numbering takes, checking the board's budget and deadline), then queues
 * them. Throws LimitError, queueing nothing, if the board can't afford them or its deadline has passed.
 */
export async function submit(
	env: Env,
	repo: string,
	requests: JobRequest[],
	group?: { id: string; kind: GroupKind },
	// stagger: seconds between consecutive jobs, so a burst of renders doesn't hit the per-minute limit at once
	opts: { delaySeconds?: number; stagger?: number } = {},
) {
	if (!requests.length) return [];
	const remote = await repoRemote(env, repo);
	const limits = await limitsOf(env, repo);
	// Takes shot before the ledger existed still count when numbering
	const existing: Record<string, number> = {};
	if (requests.some((r) => r.kind === "take")) {
		for (const b of await WorkingTree.listBranches(remote, "cell/")) {
			const [, cell, take] = /^cell\/([^/]+)\/take-(\d+)$/.exec(b) ?? [];
			if (cell) existing[cell] = Math.max(existing[cell] ?? 0, Number(take));
		}
	}
	let jobs: Job[] = [];
	await onLedger(remote, `Queue ${requests.length} job${requests.length > 1 ? "s" : ""}`, (rows) => {
		jobs = appendJobs(rows, repo, requests, { group, existing, now: now(), newId, limits });
		return jobs;
	});
	await env.JOBS.sendBatch(jobs.map((body, i) => ({ body, delaySeconds: (opts.delaySeconds ?? 0) + i * (opts.stagger ?? 0) || undefined })));
	return jobs;
}

/**
 * Records a job's progress; if that closes a group, queues the group's follow-up (the first-cut print).
 * "running" reports are best-effort (one attempt, and a lost race is just skipped): they're for watching,
 * and with every take reporting each stage they are most of the ledger's write traffic. Outcomes retry.
 */
export async function report(env: Env, job: Job, status: JobStatus, detail?: string, result?: string, cost?: number) {
	const remote = await repoRemote(env, job.repo);
	let queued: Job[] = [];
	const message = `${status === "running" ? "▶" : status === "done" ? "✓" : status === "failed" ? "✗" : "·"} ${describe(job)}${detail ? `: ${detail}` : ""}`;
	const edit = (rows: LedgerRow[]) => {
		const { followUps } = recordProgress(rows, job.id, { status, detail, result, now: now(), cost });
		queued = followUps.length ? appendJobs(rows, job.repo, followUps, { now: now(), newId }) : [];
	};
	if (status === "running") {
		try {
			await onLedger(remote, message, edit, 1);
		} catch (err) {
			console.warn(`progress for ${job.id} skipped: ${err}`);
		}
		return;
	}
	await onLedger(remote, message, edit);
	if (queued.length) await env.JOBS.sendBatch(queued.map((body) => ({ body })));
}

/** The ledger as the UI sees it, newest first. One file read; empty before the first job. */
export async function ledger(env: Env, repo: string) {
	using handle = await env.ARTIFACTS.get(repo);
	const blob = await handle.readFile({ ref: LEDGER_BRANCH, path: LEDGER_FILE }).catch(() => null);
	const rows = blob ? parseLedger(await blob.text()) : [];
	return rows.filter((r) => r.kind !== "group").reverse();
}

/** No progress for this long and a job is presumed lost (its message dropped, its invocation killed). */
export const STALL_MS = 10 * 60 * 1000;

/**
 * Cron: marks stalled jobs failed on every board, so their groups can close (and a first cut still prints
 * the cells that did finish). A failure is an ordinary ledger commit, like any other report.
 */
export async function sweep(env: Env, boards: string[]) {
	const cutoff = Date.now() - STALL_MS;
	const swept: { repo: string; id: string; kind: string; cell: string; take: string; updated: string }[] = [];
	for (const repo of boards) {
		const stalled = (await ledger(env, repo)).filter(
			(r) => (r.status === "queued" || r.status === "running") && Date.parse(r.updated) < cutoff,
		);
		for (const r of stalled) {
			const job = { repo, id: r.id, kind: r.kind, cell: r.cell, take: Number(r.take) } as Job;
			await report(env, job, "failed", `stalled: no progress for ${STALL_MS / 60000} minutes`);
			swept.push({ repo, id: r.id, kind: r.kind, cell: r.cell, take: r.take, updated: r.updated });
		}
	}
	return swept;
}
