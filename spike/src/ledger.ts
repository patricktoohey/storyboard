// The jobs ledger: jobs.csv on the board repo's `jobs` branch, one row per job. Every change is a commit
// (`git log -p jobs.csv` replays the production), and every change is made by clone, edit, push: a push
// that loses a race is rejected and redone on the new state. That compare-and-swap is the coordinator's
// only lock, and it is enough to make take numbering and group completion atomic.
//
// This file is the pure part: what a ledger edit does to the rows. coordinator.ts does the I/O.
import { estimate, usd } from "./costs.ts";
import { parseCsv, toCsv } from "./csv.ts";
import type { Job, JobRequest, JobStatus, Limits } from "./jobs.ts";

export const LEDGER_BRANCH = "jobs";
export const LEDGER_FILE = "jobs.csv";
// cost_est: what the job is charged (costs.ts), reserved when it is queued
export const LEDGER_HEADER = ["id", "kind", "cell", "take", "attempt", "group", "status", "detail", "result", "updated", "cost_est"] as const;
export type LedgerRow = Record<(typeof LEDGER_HEADER)[number], string>;

// A group is a row too (kind "group"); its detail says what to do when its jobs are all finished.
// "cut:<name>" groups a cut's video jobs; when they finish, the videos are assembled into cut/<name>.
export type GroupKind = "first_cut" | "bible" | `cut:${string}`;

export const parseLedger = (text: string) => parseCsv<LedgerRow>(text);
export const ledgerCsv = (rows: LedgerRow[]) => toCsv(rows, LEDGER_HEADER);

const open = (r: LedgerRow) => r.status === "queued" || r.status === "running";

/** Everything charged so far: finished jobs and the reservations of open ones (D19). */
export const spent = (rows: LedgerRow[]) => rows.reduce((sum, r) => sum + (Number(r.cost_est) || 0), 0);

/** A request the board's budget or deadline doesn't allow; nothing is queued. */
export class LimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LimitError";
	}
}

// After the deadline only judging continues (the arena's own jobs, which have no limits anyway)
const AFTER_DEADLINE: JobRequest["kind"][] = ["judge"];

/**
 * Appends jobs for `requests`, numbering takes after the highest take of that cell in the ledger or in
 * `existing` (take numbers from branches made before the ledger existed). Mutates `rows`.
 */
export function appendJobs(
	rows: LedgerRow[],
	repo: string,
	requests: JobRequest[],
	opts: { group?: { id: string; kind: GroupKind }; existing?: Record<string, number>; now: string; newId: () => string; limits?: Limits },
): Job[] {
	const { group, existing = {}, now, newId, limits = {} } = opts;
	// Checked inside the ledger commit that queues the jobs, so racing submits can't both spend the last
	// dollar or slip in after the deadline: the loser re-runs this check on the winner's rows
	if (limits.deadline && Date.parse(now) > Date.parse(limits.deadline)) {
		const late = requests.filter((r) => !AFTER_DEADLINE.includes(r.kind));
		if (late.length) throw new LimitError(`deadline passed at ${limits.deadline}`);
	}
	if (limits.budget_usd !== undefined) {
		const cost = requests.reduce((sum, r) => sum + estimate(r, limits.crew), 0);
		const used = spent(rows);
		if (used + cost > limits.budget_usd + 1e-9) {
			throw new LimitError(`over budget: ${usd(used)} spent or reserved + ${usd(cost)} > ${usd(limits.budget_usd)}`);
		}
	}
	if (group && !rows.some((r) => r.kind === "group" && r.id === group.id)) {
		rows.push(row({ id: group.id, kind: "group", detail: group.kind, status: "running", updated: now }));
	}
	const highest = (cell: string) =>
		Math.max(existing[cell] ?? 0, ...rows.filter((r) => r.kind === "take" && r.cell === cell).map((r) => Number(r.take) || 0));
	return requests.map((req) => {
		const base = { repo, id: newId(), group: group?.id };
		const job: Job =
			req.kind === "take"
				? { ...base, kind: "take", cell: req.cell, take: highest(req.cell) + 1, attempt: req.attempt ?? 1, opts: req.opts ?? {} }
				: ({ ...base, ...req } as Job);
		rows.push(
			row({
				id: job.id,
				kind: job.kind,
				// Arena jobs (turns, judging) record their team where a cell would go
				cell: "cell" in job ? job.cell : "team" in job ? job.team : "",
				take: job.kind === "take" ? String(job.take) : "",
				attempt: job.kind === "take" ? String(job.attempt) : "",
				group: job.group ?? "",
				status: "queued",
				updated: now,
				cost_est: estimate(req, limits.crew).toFixed(4),
			}),
		);
		return job;
	});
}

/**
 * Records a job's progress. When this finishes the last open job of a group, closes the group and returns
 * its follow-up (for a first cut: print the best take of every cell). Because the whole edit is one
 * commit, exactly one job's report can be the one that closes a group. Mutates `rows`.
 */
export function recordProgress(
	rows: LedgerRow[],
	id: string,
	update: { status: JobStatus; detail?: string; result?: string; now: string },
): { followUps: JobRequest[] } {
	const job = rows.find((r) => r.id === id && r.kind !== "group");
	if (!job) return { followUps: [] };
	// A late progress report must not reopen a finished job
	if (!open(job) && open({ ...job, status: update.status })) return { followUps: [] };
	job.status = update.status;
	if (update.detail !== undefined) job.detail = update.detail;
	if (update.result !== undefined) job.result = update.result;
	job.updated = update.now;

	const group = job.group && rows.find((r) => r.kind === "group" && r.id === job.group);
	if (!group || open(job) || group.status === "done") return { followUps: [] };
	if (rows.some((r) => r.group === group.id && r.kind !== "group" && open(r))) return { followUps: [] };
	group.status = "done";
	group.updated = update.now;
	const members = rows.filter((r) => r.group === group.id);
	if (group.detail === "first_cut") return { followUps: firstCut(members) };
	if (group.detail.startsWith("cut:")) return { followUps: assembleCut(group.detail.slice(4), members) };
	return { followUps: [] };
}

/** Print the first take of each cell that passed continuity, else its latest finished take. */
export function firstCut(groupRows: LedgerRow[]): JobRequest[] {
	const takes = groupRows.filter((r) => r.kind === "take" && r.status === "done").sort((a, b) => Number(a.take) - Number(b.take));
	const cells = [...new Set(takes.map((t) => t.cell))].sort();
	if (!cells.length) return [];
	const picks = cells.map((cell) => {
		const mine = takes.filter((t) => t.cell === cell);
		const best = mine.find((t) => t.result === "ok") ?? mine[mine.length - 1];
		return { cell, branch: `cell/${cell}/take-${best.take}` };
	});
	return [{ kind: "print", picks, message: "Print first cut" }];
}

/** Assemble the cells whose videos rendered, in board order; a failed cell is left out of the cut. */
export function assembleCut(cut: string, groupRows: LedgerRow[]): JobRequest[] {
	const cells = groupRows.filter((r) => r.kind === "video" && r.status === "done").map((r) => r.cell).sort();
	return cells.length ? [{ kind: "assemble", cut, cells }] : [];
}

const row = (r: Partial<LedgerRow>): LedgerRow =>
	Object.fromEntries(LEDGER_HEADER.map((h) => [h, r[h] ?? ""])) as LedgerRow;
