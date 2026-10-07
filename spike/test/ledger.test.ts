// The jobs ledger's guarantees (D13 in docs/decisions.md). Each ledger edit is one commit, and a push that
// loses a race is redone on the new rows, so these functions see edits strictly one after another.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobRequest } from "../src/jobs.ts";
import { type LedgerRow, appendJobs, firstCut, ledgerCsv, parseLedger, recordProgress } from "../src/ledger.ts";

let n = 0;
const ctx = { now: "2026-10-07T12:00:00Z", newId: () => `j${++n}` };
const take = (cell: string): JobRequest => ({ kind: "take", cell });

test("D13: take numbers continue after the ledger's and the branches' highest take", () => {
	const rows: LedgerRow[] = [];
	const [a, b] = appendJobs(rows, "board-x", [take("03"), take("03")], { ...ctx, existing: { "03": 2 } });
	const [c] = appendJobs(rows, "board-x", [take("03")], ctx);
	assert.deepEqual([a, b, c].map((j) => j.kind === "take" && j.take), [3, 4, 5]);
});

test("D13: two racing submits can't claim the same take", () => {
	// Both read the same ledger; the second push is rejected and its edit re-runs on the first's rows
	const base: LedgerRow[] = [];
	appendJobs(base, "board-x", [take("01")], ctx);
	const winner = parseLedger(ledgerCsv(base));
	const [w] = appendJobs(winner, "board-x", [take("01")], ctx);
	const retried = parseLedger(ledgerCsv(winner));
	const [r] = appendJobs(retried, "board-x", [take("01")], ctx);
	assert.equal(w.kind === "take" && w.take, 2);
	assert.equal(r.kind === "take" && r.take, 3);
});

test("D13: the report that finishes a first-cut group queues exactly one print, picking the best take", () => {
	const rows: LedgerRow[] = [];
	const group = { id: "cut-1", kind: "first_cut" as const };
	const [t1, t2] = appendJobs(rows, "board-x", [take("01"), take("02")], { ...ctx, group });
	// Cell 02 breaks continuity; its automatic retake joins the group before the break is recorded
	const [retake] = appendJobs(rows, "board-x", [{ kind: "take", cell: "02", attempt: 2 }], { ...ctx, group });
	assert.deepEqual(recordProgress(rows, t1.id, { status: "done", result: "ok", now: ctx.now }).followUps, []);
	assert.deepEqual(recordProgress(rows, t2.id, { status: "done", result: "break", now: ctx.now }).followUps, []);
	const last = recordProgress(rows, retake.id, { status: "done", result: "ok", now: ctx.now });
	assert.deepEqual(last.followUps, [
		{ kind: "print", message: "Print first cut", picks: [{ cell: "01", branch: "cell/01/take-1" }, { cell: "02", branch: "cell/02/take-2" }] },
	]);
	// The group is closed: a late duplicate report can't print again
	assert.deepEqual(recordProgress(rows, retake.id, { status: "done", result: "ok", now: ctx.now }).followUps, []);
});

test("D13: a failed take still lets the group close; the cell is just left out of the print", () => {
	const rows: LedgerRow[] = [];
	const group = { id: "cut-2", kind: "first_cut" as const };
	const [a, b] = appendJobs(rows, "board-x", [take("01"), take("02")], { ...ctx, group });
	recordProgress(rows, a.id, { status: "failed", detail: "AiError 3043", now: ctx.now });
	const { followUps } = recordProgress(rows, b.id, { status: "done", result: "break", now: ctx.now });
	assert.deepEqual(followUps, [{ kind: "print", message: "Print first cut", picks: [{ cell: "02", branch: "cell/02/take-1" }] }]);
});

test("a late progress report doesn't reopen a finished job", () => {
	const rows: LedgerRow[] = [];
	const [a] = appendJobs(rows, "board-x", [take("01")], ctx);
	recordProgress(rows, a.id, { status: "done", result: "ok", now: ctx.now });
	recordProgress(rows, a.id, { status: "running", detail: "renderer", now: ctx.now });
	assert.equal(rows.find((r) => r.id === a.id)?.status, "done");
});

test("a bible group closes without a follow-up", () => {
	const rows: LedgerRow[] = [];
	const [a] = appendJobs(rows, "board-x", [take("01")], { ...ctx, group: { id: "bible-1", kind: "bible" } });
	assert.deepEqual(recordProgress(rows, a.id, { status: "done", result: "ok", now: ctx.now }).followUps, []);
	assert.equal(rows.find((r) => r.id === "bible-1")?.status, "done");
});

test("the ledger round-trips through CSV, details with commas and quotes included", () => {
	const rows: LedgerRow[] = [];
	const [a] = appendJobs(rows, "board-x", [take("01")], ctx);
	recordProgress(rows, a.id, { status: "failed", detail: 'continuity break: hair reads as "black", not grey', now: ctx.now });
	assert.deepEqual(parseLedger(ledgerCsv(rows)), rows);
});

test("firstCut with nothing finished prints nothing", () => {
	assert.deepEqual(firstCut([]), []);
});
